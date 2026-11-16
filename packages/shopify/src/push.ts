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
import { MAX_READ_ITEMS, MAX_SET_QUANTITIES, type SetQuantity } from './admin.ts';
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

export type PushOutcome = 'pushed' | 'unchanged' | 'conflict' | 'not_stocked' | 'unmapped';

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
  variantId: string;
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
 * Sets Shopify's available quantity for up to MAX_SET_QUANTITIES levels of one connection in one
 * compare-and-set call, holding the level rows' locks during the call so order lines for the same
 * levels apply one at a time.
 *
 * Shopify lowers its own quantity when it accepts an order, so a refused quantity usually means an
 * order Airstock has not processed yet, not an edit. Before calling it a conflict, the push
 * processes any such orders and tries again; only a difference that remains unexplained is
 * recorded as a conflict, and Shopify is left untouched (ADR 0008, P1). A level with an open
 * conflict is not pushed until the conflict is resolved (ADR 0036).
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
        conflict_at: Date | null;
      }>(
        `select shopify_inventory_item_id as item, shopify_location_id as location,
           expected_available, expected_as_of, conflict_at
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
      for (const level of pending) {
        const k = levelKey(level);
        const target = targets.get(k);
        const row = byKey.get(k);
        if (!target || !row) done.set(k, 'unmapped');
        else if (row.conflict_at !== null) done.set(k, 'conflict');
        else if (row.expected_available === null) init.push(level);
        else if (row.expected_available === target.target) done.set(k, 'unchanged');
        else {
          writes.push({
            level,
            from: row.expected_available,
            to: target.target,
            asOf: row.expected_as_of,
            variantId: target.variantId,
          });
        }
      }
      if (writes.length === 0) return { done, init, stale: [] as Write[] };
      const quantities: SetQuantity[] = writes.map((w) => ({
        inventoryItemId: w.level.inventoryItemId,
        locationId: w.level.shopifyLocationId,
        quantity: w.to,
        from: w.from,
      }));
      const set = await store.admin.setAvailable({
        quantities,
        idempotencyKey: uuidv7(),
        reference: `airstock://shops/${shopId}/shopify-connections/${connectionId}`,
      });
      if (set.kind === 'stale') {
        // Nothing was applied: the stale levels are explained (or not) below, the rest retried.
        return { done, init, stale: set.stale.map((i) => writes[i]!) };
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
      return { done, init, stale: [] as Write[] };
    });

    for (const [k, outcome] of step.done) outcomes.set(k, outcome);

    if (step.init.length > 0) {
      // First push for these levels: process orders Shopify already counted, then read Shopify's
      // quantities as the starting point.
      ordersCaughtUp += await catchUpOrders(deps, store, store.createdAt);
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

    if (step.stale.length > 0) {
      // Explain the differences with orders Airstock has not processed yet (P1).
      for (const w of step.stale) {
        refused.set(levelKey(w.level), (refused.get(levelKey(w.level)) ?? 0) + 1);
      }
      const asOf = Math.min(...step.stale.map((w) => (w.asOf ? new Date(w.asOf).getTime() : 0)));
      const since = new Date(Math.max(store.createdAt.getTime(), asOf - 60_000));
      const processed = await catchUpOrders(deps, store, since);
      ordersCaughtUp += processed;
      if (processed === 0) {
        const actual = await readShopify(
          store,
          step.stale.map((w) => w.level),
        );
        for (const w of step.stale) {
          await recordConflict(deps, store, w.level, w.variantId, {
            expected: w.from,
            airstock: w.to,
            actual: actual.get(levelKey(w.level)) ?? null,
          });
          outcomes.set(levelKey(w.level), 'conflict');
        }
      }
    }
    pending = pending.filter((l) => !outcomes.has(levelKey(l)));
  }
  // Still refused after three rounds of new orders: left for the reconciler.
  for (const l of pending) outcomes.set(levelKey(l), 'conflict');
  return outcomes;
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
