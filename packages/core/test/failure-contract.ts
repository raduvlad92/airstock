import { type AnyOperation, type Caller, execute, ops, uuidv7 } from '@airstock/core';
import type { Database } from '@airstock/db';
import { describe, expect, it } from 'vitest';
import {
  appDatabase,
  failingAuditDatabase,
  type MemoryAuditSink,
  ownerQuery,
} from '../../../test/helpers.ts';
import { reconcileAll } from './documents-helpers.ts';

// The failure contract (PRD 7.3, G17) as one reusable suite, for the purchasing, picking, alert,
// and stock-check commands: a rollback leaves no stock, document, or outbox effect and the attempt
// is recorded (A11); a failed audit write never returns success (A12); a lost acknowledgement
// leaves a durable attempt and no duplicate (A26); and 50 replays of one key have one effect and
// the original result (A05).

export interface ContractCase {
  label: string;
  /**
   * Builds a fresh situation for the command and returns it with its input, and optionally a
   * check of the committed effect (run after the lost acknowledgement and after the replays).
   */
  setup: () => Promise<{
    op: AnyOperation;
    input: Record<string, unknown>;
    verify?: () => Promise<void>;
  }>;
}

export interface ContractShop {
  db: Database;
  sink: MemoryAuditSink;
  shopId: string;
  /** A session caller (two transactions: membership, then the command). */
  caller: Caller;
  /** The owner bound to the shop, so fault hooks hit the command's own transaction. */
  owner: Caller;
}

/**
 * Everything these commands can change in one shop: stock, the documents, alerts and rules,
 * outbox rows (webhooks, emails, availability), and idempotency records. Read as the owner, so it
 * sees only this shop's rows and never touches the outbox other test files share.
 */
export async function shopFingerprint(shopId: string): Promise<string> {
  const rows = await ownerQuery<{ f: string }>(
    `select concat_ws('|',
       (select string_agg(id || ':' || on_hand || ':' || allocated || ':' || version, ',' order by id) from inventory_positions where shop_id = $1),
       (select string_agg(id || ':' || outstanding || ':' || fulfilled || ':' || released || ':' || moved, ',' order by id) from reservation_allocations where shop_id = $1),
       (select string_agg(id || ':' || status || ':' || shortage_quantity, ',' order by id) from reservations where shop_id = $1),
       (select count(*) from inventory_entries where shop_id = $1),
       (select count(*) from inventory_operations where shop_id = $1),
       (select string_agg(variant_id || ':' || quantity || ':' || coalesce(average_cost::text, '-'), ',' order by variant_id) from variant_costs where shop_id = $1),
       (select string_agg(id || ':' || status, ',' order by id) from serial_units where shop_id = $1),
       (select count(*) from lots where shop_id = $1),
       (select string_agg(id || ':' || status || ':' || version, ',' order by id) from purchase_orders where shop_id = $1),
       (select string_agg(id || ':' || received || ':' || cancelled, ',' order by id) from purchase_order_lines where shop_id = $1),
       (select count(*) from purchase_order_receipts where shop_id = $1),
       (select count(*) from po_sends where shop_id = $1),
       (select string_agg(id || ':' || status || ':' || version, ',' order by id) from pick_lists where shop_id = $1),
       (select string_agg(id || ':' || status || ':' || picked || ':' || short || ':' || moved, ',' order by id) from pick_lines where shop_id = $1),
       (select count(*) from picks where shop_id = $1),
       (select string_agg(id || ':' || status || ':' || version, ',' order by id) from alerts where shop_id = $1),
       (select count(*) from notifications where shop_id = $1),
       (select string_agg(id || ':' || status || ':' || version, ',' order by id) from reorder_rules where shop_id = $1),
       (select string_agg(membership_id || ':' || kind || ':' || in_app || ':' || email, ',' order by membership_id, kind) from alert_subscriptions where shop_id = $1),
       (select lot_expiry_alert_days::text from shops where id = $1),
       (select string_agg(topic, ',' order by id) from outbox_events where shop_id = $1),
       (select count(*) from idempotency_records where shop_id = $1)) as f`,
    [shopId],
  );
  return rows[0]!.f;
}

/** Subscribes the shop to every webhook type these commands emit, so they become outbox rows. */
export async function subscribeAll(shopId: string): Promise<void> {
  await ownerQuery(
    `insert into webhook_subscriptions (shop_id, id, name, url, event_types, secret_key_id,
       secret_ciphertext, secret_hint)
     values ($1, $2, 'n8n', 'https://hooks.example.test/contract',
       array['stock.changed', 'alert.opened', 'alert.resolved', 'reservation.shortage',
         'purchase_order.status_changed'], 'k1', 'x', 'abcd')`,
    [shopId, uuidv7()],
  );
}

/**
 * Runs the four checks for each case. `context()` gives the shop, read after the case's setup (so
 * a setup may switch to a fresh shop); `clean` says whether the stock check should find nothing
 * after a committed command (false for shops whose stock was corrupted on purpose).
 */
export function describeFailureContract(
  cases: ContractCase[],
  context: () => ContractShop,
  options: { clean?: boolean } = {},
): void {
  const clean = options.clean ?? true;
  const expectClean = async (shopId: string) => {
    if (clean) expect(await reconcileAll(shopId)).toEqual([]);
  };

  describe.each(cases)('$label', ({ setup }) => {
    it('rolls back completely when the transaction fails, and records the attempt (A11)', async () => {
      const { op, input } = await setup();
      const { sink, shopId, owner } = context();
      const before = await shopFingerprint(shopId);
      const faulty = appDatabase({
        beforeCommit: () => {
          throw new Error('simulated crash after the command wrote everything');
        },
      });
      const key = uuidv7();
      try {
        await expect(
          execute({ db: faulty, audit: sink }, op, {
            caller: owner,
            shopId,
            input,
            idempotencyKey: key,
          }),
        ).rejects.toMatchObject({ code: 'internal_error' });
      } finally {
        await faulty.close();
      }
      expect(await shopFingerprint(shopId)).toBe(before);
      expect(sink.events.filter((e) => e.idempotency_key === key).map((e) => e.outcome)).toEqual([
        'received',
        'failed',
      ]);
    });

    it('never returns success when the audit write fails (A12)', async () => {
      const { op, input } = await setup();
      const { db, sink, shopId, owner } = context();
      const before = await shopFingerprint(shopId);
      const key = uuidv7();
      await expect(
        execute({ db: failingAuditDatabase(db), audit: sink }, op, {
          caller: owner,
          shopId,
          input,
          idempotencyKey: key,
        }),
      ).rejects.toMatchObject({ status: 500 });
      expect(await shopFingerprint(shopId)).toBe(before);
      expect(sink.events.filter((e) => e.idempotency_key === key).map((e) => e.outcome)).toEqual([
        'received',
        'failed',
      ]);
    });

    it('keeps a durable attempt when the acknowledgement is lost, and a retry has no second effect (A26)', async () => {
      const { op, input, verify } = await setup();
      const { db, sink, shopId, owner } = context();
      const before = await shopFingerprint(shopId);
      const lossy = appDatabase({
        afterCommit: () => {
          throw new Error('connection reset after COMMIT');
        },
      });
      const key = uuidv7();
      const req = { caller: owner, shopId, input, idempotencyKey: key };
      try {
        await expect(execute({ db: lossy, audit: sink }, op, req)).rejects.toMatchObject({
          code: 'outcome_unknown',
        });
      } finally {
        await lossy.close();
      }
      const committed = await shopFingerprint(shopId);
      expect(committed).not.toBe(before);
      const outcome = await execute({ db, audit: sink }, ops.getOperationOutcome, {
        caller: owner,
        shopId,
        input: { operation: op.id, idempotencyKey: key },
      });
      expect(outcome.result).toMatchObject({ status: 'completed' });
      const retry = await execute({ db, audit: sink }, op, req);
      expect(retry.replayed).toBe(true);
      expect(await shopFingerprint(shopId)).toBe(committed);
      await verify?.();
      await expectClean(shopId);
    });

    it('applies one effect and returns the original result for fifty replays of one key (A05)', async () => {
      const { op, input, verify } = await setup();
      const { db, sink, shopId, caller } = context();
      const key = uuidv7();
      const req = { caller, shopId, input, idempotencyKey: key };
      const first = await execute({ db, audit: sink }, op, req);
      expect(first.replayed).toBe(false);
      const after = await shopFingerprint(shopId);
      for (let i = 0; i < 49; i++) {
        const r = await execute({ db, audit: sink }, op, req);
        expect(r.replayed).toBe(true);
        expect(r.result).toEqual(first.result);
      }
      expect(await shopFingerprint(shopId)).toBe(after);
      await verify?.();
      await expectClean(shopId);
    });
  });
}
