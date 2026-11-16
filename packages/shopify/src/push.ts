import {
  type AuditEvent,
  affectedLevels,
  applyAlertChanges,
  auditEvent,
  INSERT_AUDIT_EVENTS_SQL,
  insertWebhookEvents,
  levelTargets,
  SHOPIFY_PUSH_TOPIC,
  type ShopifyPushPayload,
  uuidv7,
  webhookEvent,
} from '@airstock/core';
import type { Tx } from '@airstock/db';
import {
  IDEMPOTENCY_KEY_ERRORS,
  MAX_READ_ITEMS,
  MAX_SET_QUANTITIES,
  type SetQuantity,
  type SetResult,
  ShopifyApiError,
} from './admin.ts';
import { type ConnectedStore, catchUpOrders, connectedStore, type SyncDeps } from './sync.ts';

// The availability push (plan Section 5.14, ADR 0008, ADR 0036): for each mapped Shopify item at
// each mapped Shopify location, Airstock's whole sellable units (a variant, a pack, or a bundle;
// see core's shopify/targets.ts). Levels from any number of outbox events are pushed together, up
// to MAX_SET_QUANTITIES per `inventorySetQuantities` call, each with compare-and-set: a quantity
// Shopify changed since Airstock last knew it is detected, explained by orders Airstock has not
// processed yet, or recorded as a conflict and left alone.

export interface PushLevel {
  connectionId: string;
  inventoryItemId: string;
  shopifyLocationId: string;
}

/**
 * `failed`: Shopify refused the level for a reason other than its quantity (its item deleted in
 * Shopify, say); `deferred`: refused as stale and not explained yet (more orders to apply than
 * one push reads), left for the reconciler.
 */
export type PushOutcome =
  | 'pushed'
  | 'unchanged'
  | 'conflict'
  | 'not_stocked'
  | 'unmapped'
  | 'failed'
  | 'deferred';

export type PushResult = PushLevel & { outcome: PushOutcome };

/** Payloads of `inventory.availability_changed` outbox events. */
export interface AvailabilityChanged {
  variantId?: string;
  locationIds?: string[];
  positionIds?: string[];
}

/** An outbox event the push reads. */
export interface PushChange {
  topic: string;
  payload: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUMERIC = /^[0-9]{1,20}$/;
const levelKey = (l: { inventoryItemId: string; shopifyLocationId: string }) =>
  `${l.inventoryItemId}@${l.shopifyLocationId}`;

/** Pushes every mapped level one outbox event touches. */
export async function pushAvailability(
  deps: SyncDeps,
  shopId: string,
  payload: AvailabilityChanged,
): Promise<PushResult[]> {
  return pushChanges(deps, shopId, [{ topic: 'inventory.availability_changed', payload }]);
}

/** Pushes the levels a mapping change names (`shopify.levels.push`), or all of a connection's. */
export async function pushConnection(
  deps: SyncDeps,
  shopId: string,
  payload: ShopifyPushPayload,
): Promise<PushResult[]> {
  return pushChanges(deps, shopId, [{ topic: SHOPIFY_PUSH_TOPIC, payload }]);
}

/**
 * The levels outbox events touch: a stock change touches the items mapped to its variant, its
 * packs, and every bundle that uses it (`inventory.availability_changed`); a map change or an
 * order names its levels (`shopify.levels.push`). Each level once.
 */
export async function changedLevels(tx: Tx, changes: PushChange[]): Promise<PushLevel[]> {
  const levels = new Map<string, PushLevel>();
  const add = (l: PushLevel) => levels.set(`${l.connectionId}:${levelKey(l)}`, l);
  for (const change of changes) {
    if (change.topic === SHOPIFY_PUSH_TOPIC) {
      const p = change.payload as ShopifyPushPayload;
      if (!p || !UUID.test(p.connectionId)) continue;
      const items = p.inventoryItemIds?.filter((id) => NUMERIC.test(id)) ?? null;
      const locations = p.shopifyLocationIds?.filter((id) => NUMERIC.test(id)) ?? null;
      for (const t of await levelTargets(tx, p.connectionId, items, locations)) {
        add({
          connectionId: p.connectionId,
          inventoryItemId: t.inventoryItemId,
          shopifyLocationId: t.shopifyLocationId,
        });
      }
    } else if (change.topic === 'inventory.availability_changed') {
      const p = (change.payload ?? {}) as AvailabilityChanged;
      for (const l of await affectedLevels(tx, {
        variantId: p.variantId && UUID.test(p.variantId) ? p.variantId : null,
        locationIds: (p.locationIds ?? []).filter((id) => UUID.test(id)),
        positionIds: (p.positionIds ?? []).filter((id) => UUID.test(id)),
      })) {
        add(l);
      }
    }
  }
  return [...levels.values()];
}

/** Pushes the levels any number of outbox events touch, together. */
export async function pushChanges(
  deps: SyncDeps,
  shopId: string,
  changes: PushChange[],
): Promise<PushResult[]> {
  const levels = await deps.db.transaction({ shopId, userId: null, readOnly: true }, (tx) =>
    changedLevels(tx, changes),
  );
  return pushLevels(deps, shopId, levels);
}

/** Pushes levels, per connection, in batches of MAX_SET_QUANTITIES. Results keep the input order. */
export async function pushLevels(
  deps: SyncDeps,
  shopId: string,
  levels: PushLevel[],
  stores = new Map<string, ConnectedStore>(),
): Promise<PushResult[]> {
  const outcomes = new Map<string, PushOutcome>();
  const byConnection = new Map<string, PushLevel[]>();
  for (const l of levels) {
    const list = byConnection.get(l.connectionId) ?? [];
    list.push(l);
    byConnection.set(l.connectionId, list);
  }
  for (const [connectionId, list] of [...byConnection].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let store = stores.get(connectionId);
    if (!store) {
      store = await connectedStore(deps, shopId, connectionId);
      stores.set(connectionId, store);
    }
    // A stable order: batches lock their level rows in this order, so two pushes never deadlock.
    const sorted = [...list].sort((a, b) => (levelKey(a) < levelKey(b) ? -1 : 1));
    for (let i = 0; i < sorted.length; i += MAX_SET_QUANTITIES) {
      const batch = sorted.slice(i, i + MAX_SET_QUANTITIES);
      const done = await pushBatch(deps, store, batch);
      for (const [k, outcome] of done) outcomes.set(`${connectionId}:${k}`, outcome);
    }
  }
  return levels.map((l) => ({
    ...l,
    outcome: outcomes.get(`${l.connectionId}:${levelKey(l)}`) ?? 'unchanged',
  }));
}

const LEVEL_KEY = `connection_id = $1 and shopify_inventory_item_id = $2 and shopify_location_id = $3`;

function syncEvent(
  store: ConnectedStore,
  level: PushLevel,
  variantId: string | null,
  fields: Pick<AuditEvent, 'action' | 'outcome'> & Partial<AuditEvent>,
): AuditEvent {
  return auditEvent(
    {
      shopId: store.shopId,
      caller: store.caller,
      requestId: uuidv7(),
      attemptId: null,
      idempotencyKey: null,
    },
    {
      phase: 'outcome',
      target_type: variantId ? 'variant' : 'shopify_connection',
      target_id: variantId ?? level.connectionId,
      external_ref: `shopify:inventory_item/${level.inventoryItemId}/location/${level.shopifyLocationId}`,
      ...fields,
    },
  );
}

interface Write {
  level: PushLevel;
  from: number;
  to: number;
  asOf: Date | null;
  checkedAt: Date | null;
  variantId: string;
}

/** A level Shopify refused for a reason other than a stale quantity. */
interface Failure {
  write: Write;
  code: string | null;
  message: string;
}

/** Shopify's available for these levels, read MAX_READ_ITEMS items at a time. */
export async function readShopify(
  store: ConnectedStore,
  levels: PushLevel[],
): Promise<Map<string, number>> {
  const items = [...new Set(levels.map((l) => l.inventoryItemId))];
  const out = new Map<string, number>();
  for (let i = 0; i < items.length; i += MAX_READ_ITEMS) {
    const read = await store.admin.getAvailable(items.slice(i, i + MAX_READ_ITEMS));
    for (const [k, v] of read) out.set(k, v);
  }
  return out;
}

/**
 * User errors that refuse one quantity of `inventorySetQuantities` (Shopify's
 * InventorySetQuantitiesUserErrorCode, less the stale and idempotency codes). When Shopify does
 * not say which quantity, the batch is split to find it.
 */
const QUANTITY_ERRORS = new Set([
  'INVALID_INVENTORY_ITEM',
  'INVALID_LOCATION',
  'NON_MUTABLE_INVENTORY_ITEM',
  'INVALID_QUANTITY_NEGATIVE',
  'INVALID_QUANTITY_TOO_HIGH',
  'INVALID_QUANTITY_TOO_LOW',
  'NO_DUPLICATE_INVENTORY_ITEM_ID_GROUP_ID_PAIR',
  'ITEM_NOT_STOCKED_AT_LOCATION',
]);

/**
 * The idempotency key of one write: the same quantities from the same record give the same key,
 * so a retry after a lost response is the same request to Shopify, which returns the first
 * result instead of refusing it as stale (Shopify's guidance: a deterministic key from the
 * request's parameters). A record that changed (a push, an order, a check) gives a new key.
 */
async function writeKey(connectionId: string, attempt: number, writes: Write[]): Promise<string> {
  const text = [
    connectionId,
    attempt,
    ...writes.map(
      (w) =>
        `${levelKey(w.level)}:${w.from}:${w.to}:${w.asOf ? new Date(w.asOf).getTime() : ''}:${
          w.checkedAt ? new Date(w.checkedAt).getTime() : ''
        }`,
    ),
  ].join('|');
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  ).slice(0, 16);
  // A UUID (version 8, custom) from the hash.
  hash[6] = (hash[6]! & 0x0f) | 0x80;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type SetOutcome = SetResult | { kind: 'unplaced'; code: string | null; message: string };

/**
 * One `inventorySetQuantities` call. A refusal Shopify did not tie to one quantity comes back as
 * `unplaced` (nothing was applied); an idempotency key Shopify will not take again is replaced
 * once.
 */
async function setQuantities(
  store: ConnectedStore,
  input: { quantities: SetQuantity[]; idempotencyKey: string; reference: string },
  fresh = false,
): Promise<SetOutcome> {
  try {
    return await store.admin.setAvailable(input);
  } catch (error) {
    if (!(error instanceof ShopifyApiError) || error.retryable || !error.code) throw error;
    if (IDEMPOTENCY_KEY_ERRORS.includes(error.code) && !fresh) {
      return setQuantities(store, { ...input, idempotencyKey: uuidv7() }, true);
    }
    if (!QUANTITY_ERRORS.has(error.code)) throw error;
    return { kind: 'unplaced', code: error.code, message: error.message };
  }
}

/**
 * Sets Shopify's available quantity for up to MAX_SET_QUANTITIES levels of one connection in one
 * compare-and-set call, holding the level rows' locks during the call so order lines for the same
 * levels apply one at a time.
 *
 * Shopify lowers its own quantity when it accepts an order, so a refused quantity usually means an
 * order Airstock has not processed yet, not an edit. Before calling it a conflict, the push
 * applies orders Shopify created or changed since the record and tries again. A level whose record
 * and target are unchanged after that would be refused again: Shopify is read, and if it already
 * shows Airstock's number (a write whose response was lost), the write is recorded; otherwise the
 * difference is a conflict, and Shopify is left untouched (ADR 0008, P1). A level with an open
 * conflict is not pushed until the conflict is resolved (ADR 0036).
 *
 * A level Shopify refuses for another reason (its item deleted in Shopify, say) is recorded as
 * failed (sync health shows it as a pending push and the connection's last error), and the other
 * levels of the batch are written without it.
 */
async function pushBatch(
  deps: SyncDeps,
  store: ConnectedStore,
  batch: PushLevel[],
): Promise<Map<string, PushOutcome>> {
  const { shopId } = store;
  const connectionId = batch[0]!.connectionId;
  const outcomes = new Map<string, PushOutcome>();
  const refused = new Map<string, number>();
  // The quantities each level was last refused with: sent unchanged, they would be refused again.
  const refusedWith = new Map<string, { from: number; to: number }>();
  // Levels refused again after new orders were applied: orders Shopify changed are read next.
  let changedRead = false;
  let ordersCaughtUp = 0;
  let pending = batch;
  for (let attempt = 0; attempt < 4 && pending.length > 0; attempt++) {
    const items = [...new Set(pending.map((l) => l.inventoryItemId))];
    const locations = [...new Set(pending.map((l) => l.shopifyLocationId))];
    const wanted = new Set(pending.map(levelKey));
    const step = await deps.db.transaction({ shopId, userId: null }, async (tx) => {
      const mapped = (await levelTargets(tx, connectionId, items, locations)).filter((t) =>
        wanted.has(levelKey(t)),
      );
      if (mapped.length > 0) {
        await tx.query(
          `insert into shopify_inventory_levels (shop_id, connection_id, shopify_inventory_item_id,
             shopify_location_id)
           select app_shop_id(), $1, x.item, x.location
           from unnest($2::text[], $3::text[]) as x(item, location)
           on conflict do nothing`,
          [
            connectionId,
            mapped.map((t) => t.inventoryItemId),
            mapped.map((t) => t.shopifyLocationId),
          ],
        );
      }
      const rows = await tx.query<{
        item: string;
        location: string;
        expected_available: number | null;
        expected_as_of: Date | null;
        checked_at: Date | null;
        conflict_at: Date | null;
      }>(
        `select shopify_inventory_item_id as item, shopify_location_id as location,
           expected_available, expected_as_of, checked_at, conflict_at
         from shopify_inventory_levels
         where connection_id = $1 and (shopify_inventory_item_id, shopify_location_id) in
           (select * from unnest($2::text[], $3::text[]))
         order by shopify_inventory_item_id, shopify_location_id
         for update`,
        [
          connectionId,
          pending.map((l) => l.inventoryItemId),
          pending.map((l) => l.shopifyLocationId),
        ],
      );
      // Read again under the locks: an order line may have changed availability meanwhile.
      const targets = new Map(
        (await levelTargets(tx, connectionId, items, locations)).map((t) => [levelKey(t), t]),
      );
      const byKey = new Map(rows.map((r) => [`${r.item}@${r.location}`, r]));
      const done = new Map<string, PushOutcome>();
      const init: PushLevel[] = [];
      const writes: Write[] = [];
      const unexplained: Write[] = [];
      const none = { done, init, unexplained, stale: [] as Write[], failed: [] as Failure[] };
      for (const level of pending) {
        const k = levelKey(level);
        const target = targets.get(k);
        const row = byKey.get(k);
        if (!target || !row) done.set(k, 'unmapped');
        else if (row.conflict_at !== null) done.set(k, 'conflict');
        else if (row.expected_available === null) init.push(level);
        else if (row.expected_available === target.target) done.set(k, 'unchanged');
        else {
          const write = {
            level,
            from: row.expected_available,
            to: target.target,
            asOf: row.expected_as_of,
            checkedAt: row.checked_at,
            variantId: target.variantId,
          };
          const last = refusedWith.get(k);
          // Refused before with these same quantities: the orders applied since did not explain
          // the difference, so the same write would be refused again.
          if (last && last.from === write.from && last.to === write.to) unexplained.push(write);
          else writes.push(write);
        }
      }
      if (writes.length === 0) return { ...none, split: [] as Write[] };
      const quantities: SetQuantity[] = writes.map((w) => ({
        inventoryItemId: w.level.inventoryItemId,
        locationId: w.level.shopifyLocationId,
        quantity: w.to,
        from: w.from,
      }));
      const set = await setQuantities(store, {
        quantities,
        idempotencyKey: await writeKey(connectionId, attempt, writes),
        reference: `airstock://shops/${shopId}/shopify-connections/${connectionId}`,
      });
      if (set.kind === 'unplaced') {
        // Shopify refused one of these quantities without saying which: nothing was applied.
        // One level alone is the one; several are split to find it.
        return writes.length === 1
          ? {
              ...none,
              split: [],
              failed: [{ write: writes[0]!, code: set.code, message: set.message }],
            }
          : { ...none, split: writes };
      }
      if (set.kind === 'refused') {
        // Nothing was applied: the failed levels are recorded, the stale ones are explained (or
        // not) below, and the rest are retried.
        const failed = new Set(set.failed.map((f) => f.index));
        return {
          ...none,
          split: [],
          stale: set.stale.filter((i) => !failed.has(i)).map((i) => writes[i]!),
          failed: set.failed.map((f) => ({
            write: writes[f.index]!,
            code: f.code,
            message: f.message,
          })),
        };
      }
      // now() is when this transaction began, before Shopify accepted the write: an order that
      // Shopify created after it is not in `to` and still lowers the record.
      await tx.query(
        `update shopify_inventory_levels l set expected_available = x.qty, expected_as_of = now(),
           last_pushed_available = x.qty, last_pushed_at = now(), updated_at = now()
         from unnest($2::text[], $3::text[], $4::integer[]) as x(item, location, qty)
         where l.connection_id = $1 and l.shopify_inventory_item_id = x.item
           and l.shopify_location_id = x.location`,
        [
          connectionId,
          writes.map((w) => w.level.inventoryItemId),
          writes.map((w) => w.level.shopifyLocationId),
          writes.map((w) => w.to),
        ],
      );
      await tx.query('update shopify_connections set last_pushed_at = now() where id = $1', [
        connectionId,
      ]);
      await tx.query(INSERT_AUDIT_EVENTS_SQL, [
        JSON.stringify(
          writes.map((w) => {
            const times = refused.get(levelKey(w.level)) ?? 0;
            return syncEvent(store, w.level, w.variantId, {
              action: 'shopify.inventory.pushed',
              outcome: 'succeeded',
              changes: {
                available: { from: w.from, to: w.to },
                ...(times > 0 ? { refusedWrites: times, ordersCaughtUp } : {}),
              },
            });
          }),
        ),
      ]);
      for (const w of writes) done.set(levelKey(w.level), 'pushed');
      return { ...none, split: [] as Write[] };
    });

    for (const [k, outcome] of step.done) outcomes.set(k, outcome);

    if (step.failed.length > 0) {
      await recordFailures(deps, store, step.failed);
      for (const f of step.failed) outcomes.set(levelKey(f.write.level), 'failed');
    }

    if (step.split.length > 0) {
      const half = Math.ceil(step.split.length / 2);
      for (const part of [step.split.slice(0, half), step.split.slice(half)]) {
        const sub = await pushBatch(
          deps,
          store,
          part.map((w) => w.level),
        );
        for (const [k, outcome] of sub) outcomes.set(k, outcome);
      }
    }

    if (step.init.length > 0) {
      // First push for these levels: process orders Shopify already counted, then read Shopify's
      // quantities as the starting point.
      ordersCaughtUp += (await catchUpOrders(deps, store, store.createdAt)).applied;
      const readAt = new Date();
      const actual = await readShopify(store, step.init);
      const known = step.init.filter((l) => actual.has(levelKey(l)));
      for (const l of step.init) {
        if (!actual.has(levelKey(l))) {
          deps.logger?.error('shopify_item_not_stocked', { ...l });
          outcomes.set(levelKey(l), 'not_stocked');
        }
      }
      if (known.length > 0) {
        await deps.db.transaction({ shopId, userId: null }, (tx) =>
          tx.query(
            `update shopify_inventory_levels l set expected_available = x.qty,
               expected_as_of = $5, updated_at = now()
             from unnest($2::text[], $3::text[], $4::integer[]) as x(item, location, qty)
             where l.connection_id = $1 and l.shopify_inventory_item_id = x.item
               and l.shopify_location_id = x.location and l.expected_available is null`,
            [
              connectionId,
              known.map((l) => l.inventoryItemId),
              known.map((l) => l.shopifyLocationId),
              known.map((l) => actual.get(levelKey(l))!),
              readAt.toISOString(),
            ],
          ),
        );
      }
    }

    let decide = step.unexplained;
    if (decide.length > 0 && !changedRead) {
      // New orders did not explain these levels: the orders Shopify changed since the record
      // (a cancellation, an edit, a refund with restock) are applied, and if that changed
      // anything they are tried again.
      changedRead = true;
      const caught = await catchUpOrders(deps, store, sinceRecord(store, decide), {
        changed: true,
      });
      ordersCaughtUp += caught.applied;
      if (!caught.complete || caught.applied > 0) {
        for (const w of decide) {
          // More orders changed than one catch-up reads: decided later, by the reconciler.
          if (!caught.complete) outcomes.set(levelKey(w.level), 'deferred');
          else refusedWith.delete(levelKey(w.level));
        }
        decide = [];
      }
    }
    if (decide.length > 0) {
      // Shopify is read: a level that already shows Airstock's number is recorded as pushed (the
      // write whose response was lost, F7); one that shows the record is tried again; the rest
      // are conflicts.
      const readAt = new Date();
      const actual = await readShopify(
        store,
        decide.map((w) => w.level),
      );
      const confirmed: Write[] = [];
      for (const w of decide) {
        const k = levelKey(w.level);
        const shopify = actual.get(k);
        if (shopify === w.to) confirmed.push(w);
        else if (shopify === w.from) refusedWith.delete(k);
        else {
          await recordConflict(deps, store, w.level, w.variantId, {
            expected: w.from,
            airstock: w.to,
            actual: shopify ?? null,
          });
          outcomes.set(k, 'conflict');
        }
      }
      if (confirmed.length > 0) {
        for (const k of await confirmWrites(deps, store, confirmed, readAt)) {
          outcomes.set(k, 'pushed');
        }
      }
    }

    if (step.stale.length > 0) {
      // Apply the orders Shopify created since the record (P1); the next attempt sends what
      // changed, and finds the rest unexplained.
      for (const w of step.stale) {
        const k = levelKey(w.level);
        refused.set(k, (refused.get(k) ?? 0) + 1);
        refusedWith.set(k, { from: w.from, to: w.to });
      }
      ordersCaughtUp += (await catchUpOrders(deps, store, sinceRecord(store, step.stale))).applied;
    }
    pending = pending.filter((l) => !outcomes.has(levelKey(l)));
  }
  // Still refused after the rounds above: left for the reconciler.
  for (const l of pending) outcomes.set(levelKey(l), 'deferred');
  return outcomes;
}

/** Orders that may explain these writes: Shopify's, from a minute before the oldest record. */
function sinceRecord(store: ConnectedStore, writes: Write[]): Date {
  const asOf = Math.min(...writes.map((w) => (w.asOf ? new Date(w.asOf).getTime() : 0)));
  return new Date(Math.max(store.createdAt.getTime(), asOf - 60_000));
}

/**
 * Records writes Shopify had already applied: Shopify shows Airstock's number, as of `readAt`.
 * Only levels whose record is still the one the write was made from; returns their keys.
 */
async function confirmWrites(
  deps: SyncDeps,
  store: ConnectedStore,
  writes: Write[],
  readAt: Date,
): Promise<string[]> {
  return deps.db.transaction({ shopId: store.shopId, userId: null }, async (tx) => {
    const rows = await tx.query<{ item: string; location: string }>(
      `update shopify_inventory_levels l set expected_available = x.qty, expected_as_of = $6,
         last_pushed_available = x.qty, last_pushed_at = now(), updated_at = now()
       from unnest($2::text[], $3::text[], $4::integer[], $5::integer[])
         as x(item, location, qty, was)
       where l.connection_id = $1 and l.shopify_inventory_item_id = x.item
         and l.shopify_location_id = x.location and l.expected_available = x.was
         and l.conflict_at is null
       returning l.shopify_inventory_item_id as item, l.shopify_location_id as location`,
      [
        store.connectionId,
        writes.map((w) => w.level.inventoryItemId),
        writes.map((w) => w.level.shopifyLocationId),
        writes.map((w) => w.to),
        writes.map((w) => w.from),
        readAt.toISOString(),
      ],
    );
    const keys = new Set(rows.map((r) => `${r.item}@${r.location}`));
    const done = writes.filter((w) => keys.has(levelKey(w.level)));
    if (done.length > 0) {
      await tx.query('update shopify_connections set last_pushed_at = now() where id = $1', [
        store.connectionId,
      ]);
      await tx.query(INSERT_AUDIT_EVENTS_SQL, [
        JSON.stringify(
          done.map((w) =>
            syncEvent(store, w.level, w.variantId, {
              action: 'shopify.inventory.pushed',
              outcome: 'succeeded',
              changes: { available: { from: w.from, to: w.to }, alreadyInShopify: true },
              reason: 'Shopify already showed Airstock’s quantity (an earlier write was applied).',
            }),
          ),
        ),
      ]);
    }
    return [...keys];
  });
}

/**
 * Records levels Shopify refused for a reason other than a stale quantity: an audit event per
 * level, and the connection's last error, which sync health shows with the level's pending push.
 * The level is tried again with the next push.
 */
async function recordFailures(
  deps: SyncDeps,
  store: ConnectedStore,
  failures: Failure[],
): Promise<void> {
  for (const f of failures) {
    deps.logger?.error('shopify_push_refused', {
      ...f.write.level,
      code: f.code,
      error: f.message,
    });
  }
  const first = failures[0]!;
  const message =
    `Shopify refused the quantity of inventory item ${first.write.level.inventoryItemId} at ` +
    `location ${first.write.level.shopifyLocationId}: ${first.message}` +
    (failures.length > 1 ? ` (and ${failures.length - 1} more)` : '');
  await deps.db.transaction({ shopId: store.shopId, userId: null }, async (tx) => {
    await tx.query(INSERT_AUDIT_EVENTS_SQL, [
      JSON.stringify(
        failures.map((f) =>
          syncEvent(store, f.write.level, f.write.variantId, {
            action: 'shopify.inventory.push_failed',
            outcome: 'failed',
            changes: { available: { from: f.write.from, to: f.write.to }, code: f.code },
            reason: f.message.slice(0, 1000),
          }),
        ),
      ),
    ]);
    await tx.query(
      'update shopify_connections set last_error = $2, last_error_at = now() where id = $1',
      [store.connectionId, message.slice(0, 1000)],
    );
  });
}

/** The alert key of a level's conflict: one open alert per level. */
export const conflictKey = (level: PushLevel) =>
  `shopify_conflict:${level.connectionId}:${levelKey(level)}`;

/**
 * Records an unexplained difference between Shopify's quantity and Airstock's record of it (ADR
 * 0036): the level stops being pushed, an alert (kind `shopify_sync`) opens, and the
 * `shopify.sync_conflict` webhook event is sent. Nothing is written to Shopify. One event per new
 * difference, not one per retry.
 */
export async function recordConflict(
  deps: SyncDeps,
  store: ConnectedStore,
  level: PushLevel,
  variantId: string | null,
  values: { expected: number; airstock: number; actual: number | null },
): Promise<void> {
  const key = [level.connectionId, level.inventoryItemId, level.shopifyLocationId];
  await deps.db.transaction({ shopId: store.shopId, userId: null }, async (tx) => {
    const changed = await tx.query<{ conflict_alert_id: string | null }>(
      `update shopify_inventory_levels set conflict_shopify_available = $4,
         conflict_airstock_available = $5, conflict_at = coalesce(conflict_at, now()),
         checked_available = $4, checked_at = now(), updated_at = now()
       where ${LEVEL_KEY} and (conflict_at is null or conflict_shopify_available is distinct from $4)
       returning conflict_alert_id`,
      [...key, values.actual, values.airstock],
    );
    if (changed.length === 0) return;
    const [info] = await tx.query<{ sku: string | null; scope_id: string | null }>(
      `select v.sku, m.scope_id from shopify_location_maps m
       left join variants v on v.id = $3
       where m.connection_id = $1 and m.shopify_location_id = $2`,
      [level.connectionId, level.shopifyLocationId, variantId],
    );
    const scopeIds = info?.scope_id ? [info.scope_id] : [];
    const conflict = {
      kind: 'quantity',
      connectionId: level.connectionId,
      shopDomain: store.shopDomain,
      inventoryItemId: level.inventoryItemId,
      shopifyLocationId: level.shopifyLocationId,
      variantId,
      sku: info?.sku ?? null,
      locationId: info?.scope_id ?? null,
      expected: values.expected,
      airstock: values.airstock,
      shopify: values.actual,
    };
    const event = (fields: Pick<AuditEvent, 'action' | 'outcome'> & Partial<AuditEvent>) =>
      syncEvent(store, level, variantId, fields);
    const events: AuditEvent[] = [
      event({
        action: 'shopify.inventory.conflict',
        outcome: 'conflict',
        location_ids: scopeIds.length > 0 ? scopeIds : null,
        changes: values,
        reason: 'Shopify’s quantity differs from Airstock’s record and no order explains it.',
      }),
    ];
    const alerts = await applyAlertChanges(
      tx,
      event,
      changed[0]!.conflict_alert_id
        ? []
        : [
            {
              id: uuidv7(),
              kind: 'shopify_sync',
              dedupeKey: conflictKey(level),
              targetType: 'variant',
              targetId: variantId ?? level.connectionId,
              variantId,
              scopeIds: scopeIds.length > 0 ? scopeIds : null,
              webhookLocationIds: scopeIds,
              details: conflict,
            },
          ],
      [],
      'shopify_push',
    );
    await tx.query(
      `update shopify_inventory_levels set conflict_alert_id = coalesce(conflict_alert_id,
         (select id from alerts where dedupe_key = $4 and status <> 'resolved'))
       where ${LEVEL_KEY}`,
      [...key, conflictKey(level)],
    );
    await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify([...events, ...alerts.events])]);
    if (alerts.outbox.length > 0) {
      await tx.query(
        `insert into outbox_events (shop_id, id, topic, payload)
         select app_shop_id(), x.id, x.topic, x.payload
         from jsonb_to_recordset($1::jsonb) as x(id uuid, topic text, payload jsonb)`,
        [JSON.stringify(alerts.outbox.map((o) => ({ id: uuidv7(), ...o })))],
      );
    }
    await insertWebhookEvents(
      tx,
      [
        ...alerts.webhooks,
        webhookEvent('shopify.sync_conflict', { data: { conflict }, locationIds: scopeIds }),
      ],
      uuidv7,
    );
  });
}

/**
 * Clears a level's conflict and resolves its alert: the difference was explained (Shopify and
 * Airstock's record agree again), or a person chose a side (sync health). Returns whether there
 * was one.
 */
export async function clearConflict(
  tx: Tx,
  store: Pick<ConnectedStore, 'shopId' | 'caller'>,
  level: PushLevel,
  resolution: string,
  details: Record<string, unknown> = {},
): Promise<boolean> {
  const key = [level.connectionId, level.inventoryItemId, level.shopifyLocationId];
  const [row] = await tx.query<{ conflict_alert_id: string | null }>(
    `select conflict_alert_id from shopify_inventory_levels
     where ${LEVEL_KEY} and conflict_at is not null for update`,
    key,
  );
  if (row) {
    await tx.query(
      `update shopify_inventory_levels set conflict_at = null, conflict_shopify_available = null,
         conflict_airstock_available = null, conflict_alert_id = null, updated_at = now()
       where ${LEVEL_KEY}`,
      key,
    );
  }
  if (!row) return false;
  await resolveConflictAlert(tx, store, level, resolution, details);
  return true;
}

/** Resolves the open conflict alert of a level, if there is one. */
export async function resolveConflictAlert(
  tx: Tx,
  store: Pick<ConnectedStore, 'shopId' | 'caller'>,
  level: PushLevel,
  resolution: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const [alert] = await tx.query<{ id: string }>(
    `select id from alerts where dedupe_key = $1 and status <> 'resolved' for update`,
    [conflictKey(level)],
  );
  if (alert) {
    const base = {
      shopId: store.shopId,
      caller: store.caller,
      requestId: uuidv7(),
      attemptId: null,
      idempotencyKey: null,
    };
    const effects = await applyAlertChanges(
      tx,
      (fields) => auditEvent(base, { phase: 'outcome', ...fields }),
      [],
      [{ id: alert.id, kind: 'shopify_sync', resolution, webhookLocationIds: [], details }],
      'shopify_sync',
    );
    if (effects.events.length > 0) {
      await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify(effects.events)]);
    }
    if (effects.outbox.length > 0) {
      await tx.query(
        `insert into outbox_events (shop_id, id, topic, payload)
         select app_shop_id(), x.id, x.topic, x.payload
         from jsonb_to_recordset($1::jsonb) as x(id uuid, topic text, payload jsonb)`,
        [JSON.stringify(effects.outbox.map((o) => ({ id: uuidv7(), ...o })))],
      );
    }
    await insertWebhookEvents(tx, effects.webhooks, uuidv7);
  }
}
