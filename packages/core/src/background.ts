import type { Database } from '@airstock/db';
import { systemCaller } from './accounts.ts';
import { type AuditEvent, auditEvent, INSERT_AUDIT_EVENTS_SQL } from './audit.ts';
import { uuidv7 } from './ids.ts';
import { expireAllocationsAt } from './operations/inventory.ts';
import type { HandlerContext } from './registry.ts';

/** Writes one queue batch of audit events. Duplicates from redelivery are ignored (A27). */
export async function ingestAuditEvents(db: Database, events: AuditEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const [row] = await db.transaction({ shopId: null, userId: null }, (tx) =>
    tx.query<{ inserted: number }>('select ingest_audit_events($1::jsonb) as inserted', [
      JSON.stringify(events),
    ]),
  );
  return row?.inserted ?? 0;
}

export interface OutboxMessage {
  shopId: string;
  id: string;
  topic: string;
  payload: unknown;
  createdAt: string;
}

/**
 * Hands committed outbox rows to the delivery queue, then marks them dispatched. A crash
 * between the two re-sends them on the next sweep, so consumers must be idempotent.
 */
export async function dispatchOutbox(
  db: Database,
  publish: (messages: OutboxMessage[]) => Promise<void>,
  limit = 100,
): Promise<number> {
  const rows = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query<{ shop_id: string; id: string; topic: string; payload: unknown; created_at: Date }>(
      'select * from pending_outbox_events($1)',
      [limit],
    ),
  );
  if (rows.length === 0) return 0;
  await publish(
    rows.map((r) => ({
      shopId: r.shop_id,
      id: r.id,
      topic: r.topic,
      payload: r.payload,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  );
  await db.transaction({ shopId: null, userId: null }, (tx) =>
    tx.query('select mark_outbox_dispatched($1::uuid[])', [rows.map((r) => r.id)]),
  );
  return rows.length;
}

/**
 * Dispatches in batches until the outbox is empty or the time budget is spent, so a burst (an
 * import's events, a backlog after an outage) does not hold later events until the next sweep.
 * It stops on an empty batch, not a short one: delivering a job (an import chunk) can write new
 * events, and the next round picks them up.
 */
export async function drainOutbox(
  db: Database,
  publish: (messages: OutboxMessage[]) => Promise<void>,
  { budgetMs = 20_000, batch = 100, now = () => Date.now() } = {},
): Promise<number> {
  const started = now();
  let total = 0;
  for (;;) {
    const sent = await dispatchOutbox(db, publish, batch);
    total += sent;
    if (sent === 0 || now() - started >= budgetMs) return total;
  }
}

/**
 * Releases expired reservations shop by shop. Commands already ignore expired claims, so
 * this sweeper only tidies state; running late never keeps stock unavailable (PRD 6.3).
 */
export async function sweepExpiredReservations(db: Database, maxShops = 50): Promise<number> {
  const shops = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query<{ shop_id: string }>(
      'select s as shop_id from shops_with_expired_reservations($1) s',
      [maxShops],
    ),
  );
  let expired = 0;
  for (const { shop_id: shopId } of shops) {
    const caller = systemCaller('reservation-expiry', shopId);
    const requestId = uuidv7();
    expired += await db.transaction({ shopId, userId: null }, async (tx) => {
      const positions = await tx.query<{ id: string }>(
        `select distinct p.id from reservations r
         join reservation_allocations a on a.shop_id = r.shop_id and a.reservation_id = r.id
         join inventory_positions p on p.shop_id = a.shop_id and p.id = a.position_id
         where r.status in ('active', 'partially_fulfilled') and r.expires_at <= now()
           and a.released + a.fulfilled < a.quantity
         limit 200`,
      );
      const ids = positions.map((p) => p.id).sort();
      await tx.query(
        'select id from inventory_positions where id = any($1::uuid[]) order by id for update',
        [ids],
      );
      const base = { shopId, caller, requestId, attemptId: null, idempotencyKey: null };
      const ctx: HandlerContext = {
        tx,
        shopId,
        caller,
        membership: null,
        requestId,
        attemptId: null,
        locationScope: null,
        newId: () => uuidv7(),
        event: (fields) => auditEvent(base, { phase: 'outcome', ...fields }),
      };
      const events = (await expireAllocationsAt(ctx, ids)).map((e) => ({
        ...e,
        context: { trigger: 'sweeper' },
      }));
      if (events.length > 0) {
        await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify(events)]);
        await tx.query(
          `insert into outbox_events (shop_id, id, topic, payload)
           select app_shop_id(), $1, 'inventory.availability_changed',
             jsonb_build_object('reason', 'expiry', 'positionIds', $2::uuid[])`,
          [uuidv7(), ids],
        );
      }
      return events.length;
    });
  }
  return expired;
}

/**
 * Records unbound connection grants past the bind window as expired, shop by shop (report P15).
 * Such a grant comes from a consent abandoned on the WorkOS screen. Resolving and binding
 * already refuse it, so this sweep only tidies state and records the change.
 */
export async function sweepUnboundConnectionGrants(db: Database, maxShops = 50): Promise<number> {
  const shops = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query<{ shop_id: string }>(
      'select s as shop_id from shops_with_unbound_connection_grants($1) s',
      [maxShops],
    ),
  );
  let expired = 0;
  for (const { shop_id: shopId } of shops) {
    const base = {
      shopId,
      caller: systemCaller('connection-expiry', shopId),
      requestId: uuidv7(),
      attemptId: null,
      idempotencyKey: null,
    };
    expired += await db.transaction({ shopId, userId: null }, async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `update connection_grants set status = 'expired', expired_at = now()
         where status = 'active' and bound_at is null
           and created_at <= now() - connection_bind_window()
         returning id`,
      );
      const events = rows.map((r) =>
        auditEvent(base, {
          action: 'connection.expired',
          phase: 'outcome',
          outcome: 'succeeded',
          target_type: 'connection_grant',
          target_id: r.id,
          reason: 'No client used the connection within the bind window.',
          changes: { status: 'expired' },
          context: { trigger: 'sweeper' },
        }),
      );
      if (events.length > 0) await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify(events)]);
      return events.length;
    });
  }
  return expired;
}

/** Keeps future monthly audit partitions in place so the default partition stays empty. */
export async function ensureAuditPartitions(db: Database, monthsAhead = 3): Promise<number> {
  const [row] = await db.transaction({ shopId: null, userId: null }, (tx) =>
    tx.query<{ created: number }>('select ensure_audit_partitions($1) as created', [monthsAhead]),
  );
  return row?.created ?? 0;
}
