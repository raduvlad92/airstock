import { levelTargets } from '@airstock/core';
import { listingsDue, publishListing } from './listings.ts';
import {
  clearConflict,
  type PushLevel,
  pushLevels,
  readShopify,
  recordConflict,
  resolveConflictAlert,
} from './push.ts';
import {
  type ConnectedStore,
  catchUpOrders,
  connectedStore,
  NotConnectedError,
  processOrder,
  type SyncDeps,
} from './sync.ts';

// The Shopify reconciler (plan Section 5.14, D18, ADR 0036). It runs with the existing crons, so
// Neon can still scale to zero between them:
//
//   every 30 minutes  orders Shopify changed since the connection's cursor (orders, edits,
//                     cancellations, fulfillments, refunds, and returns whose webhook was missed
//                     or late), then the levels that may differ: pending pushes, open conflicts,
//                     levels without a record yet, and levels changed since the last run
//   daily             the same, comparing every mapped level with Shopify
//
// A level where Shopify's quantity is not Airstock's record of it, after orders created since the
// record were applied, is a conflict: an alert, a webhook event, and Shopify left untouched. A
// conflict whose difference has gone (a late order explained it) is resolved here.

export interface ShopifyReconcileOptions {
  daily?: boolean;
  /** Connections per run; the rest go first next time (least recently reconciled first). */
  maxConnections?: number;
  /** Stops starting new work after this long, so the cron stays short. */
  budgetMs?: number;
  /** Orders read per connection and run; the cursor continues from there next time. */
  maxOrders?: number;
  now?: () => number;
}

export interface ShopifyReconcileResult {
  connections: number;
  /** Orders read, and those where something was applied (a missed or late webhook). */
  orders: number;
  ordersApplied: number;
  levelsCompared: number;
  pushed: number;
  conflicts: number;
  explained: number;
  listingsPublished: number;
  failed: number;
}

/** Overlap with the previous run: Shopify's search index can trail an order's updated_at. */
const ORDER_OVERLAP_MS = 5 * 60 * 1000;

const key = (l: { inventoryItemId: string; shopifyLocationId: string }) =>
  `${l.inventoryItemId}@${l.shopifyLocationId}`;

const empty = (): ShopifyReconcileResult => ({
  connections: 0,
  orders: 0,
  ordersApplied: 0,
  levelsCompared: 0,
  pushed: 0,
  conflicts: 0,
  explained: 0,
  listingsPublished: 0,
  failed: 0,
});

function add(a: ShopifyReconcileResult, b: ShopifyReconcileResult): void {
  for (const k of Object.keys(a) as Array<keyof ShopifyReconcileResult>) a[k] += b[k];
}

/** Reconciles due connections across shops, within the run's budget. */
export async function reconcileShopify(
  deps: SyncDeps,
  {
    daily = false,
    maxConnections = daily ? 100 : 25,
    budgetMs = 20_000,
    maxOrders = 250,
    now = () => Date.now(),
  }: ShopifyReconcileOptions = {},
): Promise<ShopifyReconcileResult> {
  const started = now();
  const deadline = started + budgetMs;
  const due = await deps.db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query<{ shop_id: string; connection_id: string }>(
      'select shop_id, connection_id from shopify_connections_due($1, $2)',
      [daily, maxConnections],
    ),
  );
  const result = empty();
  for (const c of due) {
    if (now() >= deadline) break;
    try {
      add(
        result,
        await reconcileConnection(deps, c.shop_id, c.connection_id, {
          daily,
          deadline,
          maxOrders,
          now,
        }),
      );
    } catch (error) {
      result.failed += 1;
      deps.logger?.error('shopify_reconcile_failed', {
        shopId: c.shop_id,
        connectionId: c.connection_id,
        error: String(error),
      });
      if (!(error instanceof NotConnectedError)) {
        await deps.db
          .transaction({ shopId: c.shop_id, userId: null }, (tx) =>
            tx.query(
              `update shopify_connections set last_error = $2, last_error_at = now() where id = $1`,
              [c.connection_id, String(error).slice(0, 1000)],
            ),
          )
          .catch(() => {});
      }
    }
  }
  return result;
}

/** One connection: orders since the cursor, then levels; returns what it found and did. */
export async function reconcileConnection(
  deps: SyncDeps,
  shopId: string,
  connectionId: string,
  opts: { daily: boolean; deadline?: number; maxOrders?: number; now?: () => number },
): Promise<ShopifyReconcileResult> {
  const now = opts.now ?? (() => Date.now());
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const maxOrders = opts.maxOrders ?? 250;
  const result = empty();
  result.connections = 1;
  const store = await connectedStore(deps, shopId, connectionId);
  const [conn] = await deps.db.transaction({ shopId, userId: null, readOnly: true }, (tx) =>
    tx.query<{ orders_synced_through: Date | null; reconciled_at: Date | null }>(
      'select orders_synced_through, reconciled_at from shopify_connections where id = $1',
      [connectionId],
    ),
  );
  const startedAt = new Date(now());

  // 1. Orders Shopify changed since the cursor, oldest change first.
  const cursor = conn?.orders_synced_through
    ? new Date(conn.orders_synced_through).getTime()
    : store.createdAt.getTime();
  const since = new Date(
    Math.max(store.createdAt.getTime() - ORDER_OVERLAP_MS, cursor - ORDER_OVERLAP_MS),
  );
  let through = cursor;
  let after: string | null = null;
  do {
    const page = await store.admin.ordersUpdatedSince(since.toISOString(), after);
    for (const order of page.orders) {
      if (Date.parse(order.createdAt) >= store.createdAt.getTime()) {
        const applied = await processOrder(deps, shopId, connectionId, order);
        result.orders += 1;
        const changes =
          applied.reserved +
          applied.shortage +
          (applied.released ?? 0) +
          (applied.fulfilled ?? 0) +
          (applied.fulfillmentsReversed ?? 0) +
          (applied.returns?.length ?? 0);
        if (changes > 0) result.ordersApplied += 1;
      }
      through = Math.max(through, Date.parse(order.updatedAt ?? order.createdAt));
    }
    after = page.next;
  } while (after && now() < deadline && result.orders < maxOrders);
  // Without more pages, everything Shopify changed before this run started is applied.
  if (!after) through = Math.max(through, startedAt.getTime() - ORDER_OVERLAP_MS);
  await deps.db.transaction({ shopId, userId: null }, (tx) =>
    tx.query(
      `update shopify_connections set orders_synced_through = greatest(coalesce(orders_synced_through, $2), $2)
       where id = $1`,
      [connectionId, new Date(through).toISOString()],
    ),
  );

  // 2. Levels that may differ (all of them daily).
  const { candidates, pending } = await deps.db.transaction(
    { shopId, userId: null, readOnly: true },
    async (tx) => {
      const targets = await levelTargets(tx, connectionId);
      const rows = await tx.query<{
        item: string;
        location: string;
        expected_available: number | null;
        conflict_at: Date | null;
        updated_at: Date;
      }>(
        `select shopify_inventory_item_id as item, shopify_location_id as location,
           expected_available, conflict_at, updated_at
         from shopify_inventory_levels where connection_id = $1`,
        [connectionId],
      );
      const byKey = new Map(rows.map((r) => [`${r.item}@${r.location}`, r]));
      const lastRun = conn?.reconciled_at ? new Date(conn.reconciled_at).getTime() : 0;
      const candidates: PushLevel[] = [];
      const pending: PushLevel[] = [];
      for (const t of targets) {
        const level = {
          connectionId,
          inventoryItemId: t.inventoryItemId,
          shopifyLocationId: t.shopifyLocationId,
        };
        const row = byKey.get(key(t));
        const differs =
          !row || row.expected_available === null || row.expected_available !== t.target;
        if (differs && !row?.conflict_at) pending.push(level);
        if (
          opts.daily ||
          differs ||
          row?.conflict_at ||
          (row && new Date(row.updated_at).getTime() > lastRun)
        ) {
          candidates.push(level);
        }
      }
      return { candidates, pending };
    },
  );

  const compared = await compareLevels(deps, store, candidates);
  result.levelsCompared = compared.compared;
  result.conflicts = compared.conflicts;
  result.explained = compared.explained;

  // 3. Push what Shopify should show and does not yet (failed or lost pushes, explained
  // conflicts); the push itself is compare-and-set.
  const toPush = [...pending, ...compared.explainedLevels].filter(
    (l, i, all) =>
      all.findIndex((x) => key(x) === key(l)) === i && !compared.conflicted.has(key(l)),
  );
  let pushFailed = false;
  if (toPush.length > 0) {
    const pushed = await pushLevels(deps, shopId, toPush, new Map([[connectionId, store]]));
    pushFailed = pushed.some((p) => p.outcome === 'failed');
    result.pushed = pushed.filter((p) => p.outcome === 'pushed').length;
    result.conflicts += pushed.filter(
      (p) => p.outcome === 'conflict' && !compared.conflicted.has(key(p)),
    ).length;
  }

  // 4. Listings (D21): pending or failed ones, and products changed since their last sync.
  for (const productId of await listingsDue(deps, shopId, connectionId)) {
    if (now() >= deadline) break;
    const outcome = await publishListing(deps, shopId, connectionId, productId);
    if (outcome === 'created' || outcome === 'adopted' || outcome === 'updated') {
      result.listingsPublished += 1;
    }
  }

  // Conflict alerts whose level no longer has a conflict (a remap cleared it): resolved.
  await deps.db.transaction({ shopId, userId: null }, async (tx) => {
    const orphans = await tx.query<{ item: string; location: string }>(
      `select split_part(split_part(a.dedupe_key, ':', 3), '@', 1) as item,
         split_part(split_part(a.dedupe_key, ':', 3), '@', 2) as location
       from alerts a
       where a.kind = 'shopify_sync' and a.status <> 'resolved' and a.dedupe_key like $1
         and not exists (select 1 from shopify_inventory_levels l where l.connection_id = $2
           and l.conflict_at is not null and l.conflict_alert_id = a.id)`,
      [`shopify_conflict:${connectionId}:%`, connectionId],
    );
    for (const o of orphans) {
      await resolveConflictAlert(
        tx,
        store,
        { connectionId, inventoryItemId: o.item, shopifyLocationId: o.location },
        'cleared',
      );
    }
  });
  await deps.db.transaction({ shopId, userId: null }, (tx) =>
    tx.query(
      `update shopify_connections set reconciled_at = now(),
         levels_compared_at = case when $2 then now() else levels_compared_at end,
         last_error = case when $3 then last_error end,
         last_error_at = case when $3 then last_error_at end
       where id = $1`,
      [connectionId, opts.daily, pushFailed],
    ),
  );
  return result;
}

interface LevelRecord {
  item: string;
  location: string;
  expected_available: number | null;
  expected_as_of: Date | null;
  conflict_at: Date | null;
}

/**
 * Airstock's records and Shopify's quantities for these levels, read together: Shopify is read
 * while the records are locked (as the push holds them), so a push cannot land between the two
 * reads. 100 levels per transaction.
 */
async function readLocked(
  deps: SyncDeps,
  store: ConnectedStore,
  levels: PushLevel[],
): Promise<{ records: Map<string, LevelRecord>; actual: Map<string, number> }> {
  const records = new Map<string, LevelRecord>();
  const actual = new Map<string, number>();
  const sorted = [...levels].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  for (let i = 0; i < sorted.length; i += 100) {
    const chunk = sorted.slice(i, i + 100);
    await deps.db.transaction({ shopId: store.shopId, userId: null }, async (tx) => {
      const rows = await tx.query<LevelRecord>(
        `select shopify_inventory_item_id as item, shopify_location_id as location,
           expected_available, expected_as_of, conflict_at
         from shopify_inventory_levels
         where connection_id = $1 and (shopify_inventory_item_id, shopify_location_id) in
           (select * from unnest($2::text[], $3::text[]))
         order by shopify_inventory_item_id, shopify_location_id
         for update`,
        [
          store.connectionId,
          chunk.map((l) => l.inventoryItemId),
          chunk.map((l) => l.shopifyLocationId),
        ],
      );
      const read = await readShopify(store, chunk);
      await tx.query(
        `update shopify_inventory_levels l set checked_available = x.qty, checked_at = now()
         from unnest($2::text[], $3::text[], $4::integer[]) as x(item, location, qty)
         where l.connection_id = $1 and l.shopify_inventory_item_id = x.item
           and l.shopify_location_id = x.location`,
        [
          store.connectionId,
          chunk.map((l) => l.inventoryItemId),
          chunk.map((l) => l.shopifyLocationId),
          chunk.map((l) => read.get(key(l)) ?? null),
        ],
      );
      for (const r of rows) records.set(`${r.item}@${r.location}`, r);
      for (const l of chunk) {
        const v = read.get(key(l));
        if (v !== undefined) actual.set(key(l), v);
      }
    });
  }
  return { records, actual };
}

/**
 * Compares Shopify's quantities with Airstock's record for these levels. A difference is first
 * explained with orders created since the record (P1); one that remains is a conflict. An open
 * conflict whose difference is gone is resolved.
 */
async function compareLevels(
  deps: SyncDeps,
  store: ConnectedStore,
  levels: PushLevel[],
): Promise<{
  compared: number;
  conflicts: number;
  explained: number;
  explainedLevels: PushLevel[];
  conflicted: Set<string>;
}> {
  const out = {
    compared: 0,
    conflicts: 0,
    explained: 0,
    explainedLevels: [] as PushLevel[],
    conflicted: new Set<string>(),
  };
  if (levels.length === 0) return out;
  const { shopId } = store;
  let suspects = levels;
  for (let round = 0; round < 2 && suspects.length > 0; round++) {
    const readAt = new Date();
    const { records, actual } = await readLocked(deps, store, suspects);
    if (round === 0) out.compared = suspects.length;
    const differing: Array<{ level: PushLevel; expected: number; asOf: Date | null }> = [];
    for (const level of suspects) {
      const row = records.get(key(level));
      const shopify = actual.get(key(level));
      // No record yet (the first push reads Shopify), or not stocked there: nothing to compare.
      if (!row || row.expected_available === null || shopify === undefined) continue;
      if (shopify === row.expected_available) {
        if (row.conflict_at) {
          const cleared = await deps.db.transaction({ shopId, userId: null }, (tx) =>
            clearConflict(tx, store, level, 'explained', { shopify }),
          );
          if (cleared) {
            out.explained += 1;
            out.explainedLevels.push(level);
          }
        }
        continue;
      }
      if (row.conflict_at) {
        // Still differs: the open conflict stays (its record is updated if Shopify moved again).
        out.conflicted.add(key(level));
        differing.push({ level, expected: row.expected_available, asOf: row.expected_as_of });
        continue;
      }
      differing.push({ level, expected: row.expected_available, asOf: row.expected_as_of });
    }
    if (differing.length === 0) break;
    if (round === 0) {
      // Orders Shopify created or changed after the record and not applied yet explain the
      // difference (a sale lowers Shopify's quantity, a cancellation or restock raises it).
      const asOf = Math.min(...differing.map((d) => (d.asOf ? new Date(d.asOf).getTime() : 0)));
      const since = new Date(Math.max(store.createdAt.getTime(), asOf - 60_000));
      const caught = await catchUpOrders(deps, store, since);
      if (caught.applied > 0) {
        suspects = differing.map((d) => d.level);
        continue;
      }
      if (!caught.complete) {
        // More orders changed than one catch-up reads: compared again on the next run.
        for (const d of differing) out.conflicted.add(key(d.level));
        break;
      }
    }
    const targets = await deps.db.transaction({ shopId, userId: null, readOnly: true }, (tx) =>
      levelTargets(
        tx,
        store.connectionId,
        [...new Set(differing.map((d) => d.level.inventoryItemId))],
        [...new Set(differing.map((d) => d.level.shopifyLocationId))],
      ),
    );
    const targetOf = new Map(targets.map((t) => [key(t), t]));
    for (const d of differing) {
      const t = targetOf.get(key(d.level));
      const shopify = actual.get(key(d.level));
      if (t && shopify === t.target) {
        // Shopify already shows Airstock's number (a push whose response was lost, or the same
        // number set by hand): nothing to resolve. The record becomes Shopify's, as of the read.
        if (await agree(deps, store, d.level, d.expected, shopify, readAt)) {
          out.explained += 1;
          out.conflicted.delete(key(d.level));
        }
        continue;
      }
      const wasOpen = out.conflicted.has(key(d.level));
      await recordConflict(deps, store, d.level, t?.variantId ?? null, {
        expected: d.expected,
        airstock: t?.target ?? 0,
        actual: actual.get(key(d.level)) ?? null,
      });
      out.conflicted.add(key(d.level));
      if (!wasOpen) out.conflicts += 1;
    }
    break;
  }
  return out;
}

/**
 * Shopify shows Airstock's number while the record says otherwise: the record becomes Shopify's
 * (as of the read), and an open conflict is resolved (`explained`). Only when the record is still
 * the one compared. Returns whether it changed.
 */
async function agree(
  deps: SyncDeps,
  store: ConnectedStore,
  level: PushLevel,
  expected: number,
  shopify: number,
  readAt: Date,
): Promise<boolean> {
  return deps.db.transaction({ shopId: store.shopId, userId: null }, async (tx) => {
    const changed = await tx.query(
      `update shopify_inventory_levels set expected_available = $4, expected_as_of = $6,
         updated_at = now()
       where connection_id = $1 and shopify_inventory_item_id = $2 and shopify_location_id = $3
         and expected_available = $5
       returning 1`,
      [
        level.connectionId,
        level.inventoryItemId,
        level.shopifyLocationId,
        shopify,
        expected,
        readAt.toISOString(),
      ],
    );
    if (changed.length === 0) return false;
    await clearConflict(tx, store, level, 'explained', { shopify });
    return true;
  });
}
