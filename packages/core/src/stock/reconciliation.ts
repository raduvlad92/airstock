import type { Database, Tx } from '@airstock/db';
import { systemCaller } from '../accounts.ts';
import { type AuditEvent, auditEvent, INSERT_AUDIT_EVENTS_SQL } from '../audit.ts';
import { uuidv7 } from '../ids.ts';
import { insertWebhookEvents, webhookEvent } from '../webhooks/events.ts';

// The scheduled stock reconciliation (D18, PRD 6.1 rules 2 and 10, A21). For each shop it runs the
// SQL checks `stock_reconciliation_problems()` (migration 0017), `transfer_reconciliation_problems()`
// (0030: transfer holds and in-transit stock), and `return_reconciliation_problems()` (0031:
// received and inspected return units), records the result, and opens or resolves one alert. It never changes stock: a mismatch is repaired only by a person, through
// the reviewed repair operation (operations/inventory-reconciliation.ts).

/** The open-alert key: at most one open reconciliation alert per shop (D12). */
export const RECONCILIATION_ALERT_KEY = 'reconciliation';
/** The alert kind, as webhook subscriptions filter on it (WEBHOOK_ALERT_KINDS). */
export const RECONCILIATION_ALERT_KIND = 'reconciliation_mismatch';
/** Outbox topics the alert's notifications (I3) pick up; webhooks get their own rows. */
export const ALERT_OPENED_TOPIC = 'alert.opened';
export const ALERT_RESOLVED_TOPIC = 'alert.resolved';
/** Problems stored per check and per alert; the count is always complete. */
export const MAX_STORED_PROBLEMS = 100;
/** Problems listed in an alert's webhook event. */
const MAX_ANNOUNCED_PROBLEMS = 20;

export type ReconciliationTrigger = 'scheduled' | 'daily';

export interface StockProblem {
  problem: string;
  targetType: string;
  targetId: string;
  expected: string;
  actual: string;
}

/**
 * The stock invariants that fail right now in the transaction's shop (row-level security limits
 * the check to it), in a stable order. Optionally for one problem and target only.
 */
export async function readStockProblems(
  tx: Tx,
  only?: { problem: string; targetId: string },
): Promise<StockProblem[]> {
  const rows = await tx.query<{
    problem: string;
    target_type: string;
    target_id: string;
    expected: string;
    actual: string;
  }>(
    `select problem, target_type, target_id, expected, actual
     from (select * from stock_reconciliation_problems()
           union all select * from transfer_reconciliation_problems()
           union all select * from return_reconciliation_problems()) p
     where ($1::text is null or (problem = $1 and target_id = $2::uuid))
     order by problem, target_id`,
    [only?.problem ?? null, only?.targetId ?? null],
  );
  return rows.map((r) => ({
    problem: r.problem,
    targetType: r.target_type,
    targetId: r.target_id,
    expected: r.expected,
    actual: r.actual,
  }));
}

/** Two checks found the same problems with the same figures. */
function sameProblems(a: StockProblem[], b: StockProblem[]): boolean {
  const key = (p: StockProblem) => `${p.problem}|${p.targetId}|${p.expected}|${p.actual}`;
  if (a.length !== b.length) return false;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((k, i) => k === right[i]);
}

export interface ShopReconciliation {
  shopId: string;
  reconciliationId: string;
  problems: number;
  /** What happened to the shop's reconciliation alert. */
  alert: 'opened' | 'updated' | 'unchanged' | 'resolved' | null;
  alertId: string | null;
}

/**
 * Checks one shop and records the result: one `stock_reconciliations` row per check. A mismatch
 * opens the shop's reconciliation alert (once; a check that finds the same problems again only
 * counts it), with an audit event that lists each problem and an announcement in the outbox. A
 * clean check resolves an open alert the same way. Nothing here changes stock.
 */
export async function reconcileShop(
  db: Database,
  shopId: string,
  trigger: ReconciliationTrigger,
): Promise<ShopReconciliation> {
  const caller = systemCaller('reconciliation', shopId);
  const base = { shopId, caller, requestId: uuidv7(), attemptId: null, idempotencyKey: null };
  const event = (fields: Pick<AuditEvent, 'action' | 'outcome'> & Partial<AuditEvent>) =>
    auditEvent(base, { phase: 'outcome', ...fields });
  return db.transaction({ shopId, userId: null }, async (tx) => {
    const problems = await readStockProblems(tx);
    const stored = problems.slice(0, MAX_STORED_PROBLEMS);
    const reconciliationId = uuidv7();
    const [check] = await tx.query<{ checked_at: Date }>(
      `insert into stock_reconciliations (shop_id, id, trigger, problems, details)
       values (app_shop_id(), $1, $2, $3, $4::jsonb) returning checked_at`,
      [reconciliationId, trigger, problems.length, JSON.stringify(stored)],
    );
    const checkedAt = new Date(check!.checked_at).toISOString();
    const context = { trigger, reconciliationId };

    // The alerts table is last in the lock order; this transaction locks nothing else.
    const [open] = await tx.query<{
      id: string;
      details: { problems?: StockProblem[] };
      opened_at: Date;
    }>(
      `select id, details, opened_at from alerts
       where dedupe_key = $1 and status <> 'resolved' for update`,
      [RECONCILIATION_ALERT_KEY],
    );

    const events: AuditEvent[] = [];
    const outbox: Array<{ topic: string; payload: unknown }> = [];
    let outcome: ShopReconciliation['alert'] = null;
    let alertId: string | null = open?.id ?? null;

    if (problems.length > 0) {
      const details = {
        reconciliationId,
        checkedAt,
        count: problems.length,
        truncated: problems.length > stored.length,
        problems: stored,
      };
      if (!open) {
        const id = uuidv7();
        // A concurrent check of the same shop (the 30-minute and daily crons can meet) may have
        // opened it first: the open-key index makes this insert wait, then do nothing.
        const [inserted] = await tx.query<{ id: string; opened_at: Date }>(
          `insert into alerts (shop_id, id, kind, dedupe_key, target_type, details)
           values (app_shop_id(), $1, $2, $3, 'shop', $4::jsonb)
           on conflict (shop_id, dedupe_key) where status <> 'resolved' do nothing
           returning id, opened_at`,
          [id, RECONCILIATION_ALERT_KIND, RECONCILIATION_ALERT_KEY, JSON.stringify(details)],
        );
        if (inserted) {
          alertId = inserted.id;
          outcome = 'opened';
          events.push(
            event({
              action: 'inventory.reconciliation.alert_opened',
              outcome: 'succeeded',
              target_type: 'alert',
              target_id: inserted.id,
              reason: `The stock check found ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}. Nothing was changed; review each one and repair it.`,
              changes: { status: 'open', count: problems.length, problems: stored },
              context,
            }),
          );
          const alert = {
            id: inserted.id,
            kind: RECONCILIATION_ALERT_KIND,
            status: 'open',
            openedAt: new Date(inserted.opened_at).toISOString(),
            problemCount: problems.length,
            problems: problems.slice(0, MAX_ANNOUNCED_PROBLEMS),
          };
          outbox.push({
            topic: ALERT_OPENED_TOPIC,
            payload: { alertId: inserted.id, kind: RECONCILIATION_ALERT_KIND },
          });
          await insertWebhookEvents(
            tx,
            [
              webhookEvent('alert.opened', {
                data: { alert },
                alertKind: RECONCILIATION_ALERT_KIND,
              }),
            ],
            uuidv7,
          );
        } else {
          outcome = 'unchanged';
        }
      } else {
        const changed = !sameProblems(open.details.problems ?? [], stored);
        await tx.query(
          `update alerts set last_seen_at = now(), occurrences = occurrences + 1,
             details = $2::jsonb, version = version + 1
           where id = $1`,
          [open.id, JSON.stringify(details)],
        );
        outcome = changed ? 'updated' : 'unchanged';
        if (changed) {
          events.push(
            event({
              action: 'inventory.reconciliation.alert_updated',
              outcome: 'succeeded',
              target_type: 'alert',
              target_id: open.id,
              reason: `The stock check now finds ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}.`,
              changes: { count: problems.length, problems: stored },
              context,
            }),
          );
        }
      }
    } else if (open) {
      const [resolved] = await tx.query<{ resolved_at: Date }>(
        `update alerts set status = 'resolved', resolved_at = now(), last_seen_at = now(),
           version = version + 1
         where id = $1 returning resolved_at`,
        [open.id],
      );
      outcome = 'resolved';
      events.push(
        event({
          action: 'inventory.reconciliation.alert_resolved',
          outcome: 'succeeded',
          target_type: 'alert',
          target_id: open.id,
          reason: 'The stock check found no problems.',
          changes: { status: { from: 'open', to: 'resolved' } },
          context,
        }),
      );
      outbox.push({
        topic: ALERT_RESOLVED_TOPIC,
        payload: { alertId: open.id, kind: RECONCILIATION_ALERT_KIND },
      });
      await insertWebhookEvents(
        tx,
        [
          webhookEvent('alert.resolved', {
            data: {
              alert: {
                id: open.id,
                kind: RECONCILIATION_ALERT_KIND,
                openedAt: new Date(open.opened_at).toISOString(),
                resolvedAt: new Date(resolved!.resolved_at).toISOString(),
                resolution: 'reconciled',
              },
            },
            alertKind: RECONCILIATION_ALERT_KIND,
          }),
        ],
        uuidv7,
      );
    }

    if (events.length > 0) await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify(events)]);
    if (outbox.length > 0) {
      await tx.query(
        `insert into outbox_events (shop_id, id, topic, payload)
         select app_shop_id(), x.id, x.topic, x.payload
         from jsonb_to_recordset($1::jsonb) as x(id uuid, topic text, payload jsonb)`,
        [JSON.stringify(outbox.map((o) => ({ id: uuidv7(), ...o })))],
      );
    }
    return { shopId, reconciliationId, problems: problems.length, alert: outcome, alertId };
  });
}

export interface ReconcileStockOptions {
  /** Daily: every shop with stock not checked for a day. Otherwise shops with stock activity since their last check. */
  daily?: boolean;
  /** Shops per run; the rest are first in line next time (oldest check first). */
  maxShops?: number;
  /** Stops starting new shops after this long, so the cron stays short. */
  budgetMs?: number;
  now?: () => number;
  logger?: { error(message: string, data?: Record<string, unknown>): void };
}

export interface ReconcileStockResult {
  checked: number;
  /** Shops where the check found at least one problem. */
  mismatched: number;
  failed: number;
}

/**
 * The scheduled reconciliation (D18): runs from the existing 30-minute and daily crons, so Neon
 * still scales to zero between them. Each run takes a bounded number of due shops, oldest check
 * first; a failing shop is logged and skipped, not retried in the same run.
 */
export async function reconcileStock(
  db: Database,
  {
    daily = false,
    maxShops = daily ? 200 : 25,
    budgetMs = 20_000,
    now = () => Date.now(),
    logger,
  }: ReconcileStockOptions = {},
): Promise<ReconcileStockResult> {
  const started = now();
  const shops = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query<{ shop_id: string }>(
      'select s as shop_id from shops_due_stock_reconciliation($1, $2) s',
      [daily, maxShops],
    ),
  );
  const result: ReconcileStockResult = { checked: 0, mismatched: 0, failed: 0 };
  for (const { shop_id: shopId } of shops) {
    if (now() - started >= budgetMs) break;
    try {
      const checked = await reconcileShop(db, shopId, daily ? 'daily' : 'scheduled');
      result.checked += 1;
      if (checked.problems > 0) result.mismatched += 1;
    } catch (error) {
      result.failed += 1;
      logger?.error('stock_reconciliation_failed', { shopId, error: String(error) });
    }
  }
  return result;
}
