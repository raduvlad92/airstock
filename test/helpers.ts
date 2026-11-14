import type { AnyOperation } from '@airstock/core';
import {
  type AuditEvent,
  type AuditSink,
  type Caller,
  ensureUser,
  execute,
  ingestAuditEvents,
  ops,
  sessionCaller,
  uuidv7,
} from '@airstock/core';
import { type Database, type DatabaseHooks, PgDatabase, poolSource } from '@airstock/db';
import pg from 'pg';
import { inject } from 'vitest';

export function appDatabase(hooks: DatabaseHooks = {}): Database {
  return new PgDatabase(poolSource(inject('databases').appUrl, 60), hooks);
}

/** Owner connection for test assertions that must see every shop. Never used by the app. */
export async function ownerQuery<R = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<R[]> {
  const client = new pg.Client({ connectionString: inject('databases').ownerUrl });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as R[];
  } finally {
    await client.end();
  }
}

/** In-memory stand-in for the audit queue, with failure injection. */
export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  failing = false;

  async send(events: AuditEvent[]): Promise<void> {
    if (this.failing) throw new Error('simulated queue outage');
    this.events.push(...structuredClone(events));
  }

  /** Delivers accepted events to PostgreSQL, as the queue consumer would. */
  async drain(db: Database): Promise<number> {
    return ingestAuditEvents(db, this.events);
  }

  forAttempt(attemptId: string | null) {
    return this.events.filter((e) => e.attempt_id === attemptId);
  }
}

export interface Harness {
  db: Database;
  sink: MemoryAuditSink;
  run(
    op: AnyOperation,
    input: unknown,
    opts?: { caller?: Caller; shopId?: string; key?: string | null },
  ): Promise<AnyResult>;
}

// biome-ignore lint/suspicious/noExplicitAny: tests read many different result shapes
type AnyResult = any;

export interface SeededShop {
  userId: string;
  shopId: string;
  warehouseId: string;
  locationId: string;
  caller: Caller;
}

export async function seedShop(
  db: Database,
  sink: AuditSink,
  name = 'Test shop',
): Promise<SeededShop> {
  const userId = await ensureUser(db, {
    providerUserId: `test_${uuidv7()}`,
    email: `${uuidv7()}@example.test`,
  });
  const caller = sessionCaller(userId);
  const created = await execute({ db, audit: sink }, ops.createShop, {
    caller,
    shopId: null,
    input: { name, currency: 'EUR', timezone: 'Europe/Berlin' },
  });
  const result = created.result as {
    shopId: string;
    defaultWarehouseId: string;
    defaultLocationId: string;
  };
  return {
    userId,
    shopId: result.shopId,
    warehouseId: result.defaultWarehouseId,
    locationId: result.defaultLocationId,
    caller,
  };
}

/**
 * The shop owner as a shop-bound caller (like an API credential): the pipeline then runs a
 * single transaction, which keeps fault-injection hooks aimed at the command itself.
 */
export async function boundCaller(shop: SeededShop): Promise<Caller> {
  const [m] = await ownerQuery<{ id: string }>(
    'select id from memberships where shop_id = $1 and user_id = $2',
    [shop.shopId, shop.userId],
  );
  return {
    ...shop.caller,
    boundShopId: shop.shopId,
    membership: { id: m!.id, role: 'owner', allLocations: true, locationScopeIds: [] },
  };
}

export function harness(db: Database, sink: MemoryAuditSink, shop: SeededShop): Harness {
  return {
    db,
    sink,
    async run(op, input, opts = {}) {
      const res = await execute({ db, audit: sink }, op, {
        caller: opts.caller ?? shop.caller,
        shopId: opts.shopId ?? shop.shopId,
        input,
        idempotencyKey:
          opts.key === undefined ? (op.idempotency === 'required' ? uuidv7() : null) : opts.key,
      });
      return res.result;
    },
  };
}

export async function createVariant(
  h: Harness,
  sku = `SKU-${uuidv7().slice(-8)}`,
  quantityScale = 0,
): Promise<string> {
  const res = await h.run(ops.createItem, { name: `Item ${sku}`, sku, quantityScale });
  return res.variantId as string;
}

export async function createLeafLocation(
  h: Harness,
  warehouseId: string,
  name: string,
): Promise<string> {
  const res = await h.run(ops.createLocation, { warehouseId, name });
  return res.locationId as string;
}

/** Member of an existing shop with a given role and optional location limits. */
export async function addMember(
  shopId: string,
  role: string,
  scopeIds: string[] | null = null,
): Promise<{ userId: string; membershipId: string; caller: Caller }> {
  const userId = uuidv7();
  const membershipId = uuidv7();
  await ownerQuery('insert into users (id, workos_user_id, email) values ($1, $2, $3)', [
    userId,
    `test_${userId}`,
    `${userId}@example.test`,
  ]);
  await ownerQuery(
    'insert into memberships (shop_id, id, user_id, role, all_locations) values ($1, $2, $3, $4, $5)',
    [shopId, membershipId, userId, role, scopeIds === null],
  );
  for (const scopeId of scopeIds ?? []) {
    await ownerQuery(
      'insert into membership_location_scopes (shop_id, membership_id, scope_id) values ($1, $2, $3)',
      [shopId, membershipId, scopeId],
    );
  }
  return { userId, membershipId, caller: sessionCaller(userId) };
}

/** Ledger and balances agree, and allocations never exceed stock (A21). */
export async function reconcile(shopId: string): Promise<string[]> {
  const problems = await ownerQuery<{ problem: string }>(
    `select 'on_hand mismatch at ' || p.id as problem
       from inventory_positions p
       left join (select position_id, sum(delta) as total from inventory_entries where shop_id = $1 group by position_id) e
         on e.position_id = p.id
      where p.shop_id = $1 and p.on_hand <> coalesce(e.total, 0)
     union all
     select 'allocated mismatch at ' || p.id
       from inventory_positions p
       left join (select position_id, sum(quantity - released - fulfilled) as total
                  from reservation_allocations where shop_id = $1 group by position_id) a
         on a.position_id = p.id
      where p.shop_id = $1 and p.allocated <> coalesce(a.total, 0)
     union all
     select 'over-allocated at ' || id from inventory_positions where shop_id = $1 and allocated > on_hand
     union all
     select 'reservation total mismatch ' || r.id
       from reservations r
       join (select reservation_id, sum(quantity) as total from reservation_allocations where shop_id = $1 group by reservation_id) a
         on a.reservation_id = r.id
      where r.shop_id = $1 and r.quantity <> a.total`,
    [shopId],
  );
  return problems.map((p) => p.problem);
}
