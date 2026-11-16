import {
  type AuditEvent,
  affectedLevels,
  auditEvent,
  INSERT_AUDIT_EVENTS_SQL,
  levelTargets,
  type ShopifyPushPayload,
  uuidv7,
} from '@airstock/core';
import { type ConnectedStore, catchUpOrders, connectedStore, type SyncDeps } from './sync.ts';

// The availability push (plan Section 5.14, ADR 0008): for each mapped Shopify item at each
// mapped Shopify location, Airstock's whole sellable units (a variant, a pack, or a bundle; see
// core's shopify/targets.ts), written with compare-and-set so a quantity Shopify changed since the
// last push is detected, explained by orders Airstock has not processed yet, or recorded as a
// conflict and left alone.

export interface PushLevel {
  connectionId: string;
  inventoryItemId: string;
  shopifyLocationId: string;
}

export type PushOutcome = 'pushed' | 'unchanged' | 'conflict' | 'not_stocked' | 'unmapped';

/** Payloads of `inventory.availability_changed` outbox events. */
export interface AvailabilityChanged {
  variantId?: string;
  locationIds?: string[];
  positionIds?: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUMERIC = /^[0-9]{1,20}$/;

/**
 * Pushes every mapped level an outbox event touches: the variant's own items, its packs, and the
 * bundles that use it. Shops without a Shopify connection cost one query.
 */
export async function pushAvailability(
  deps: SyncDeps,
  shopId: string,
  payload: AvailabilityChanged,
): Promise<Array<PushLevel & { outcome: PushOutcome }>> {
  const variantId = payload.variantId && UUID.test(payload.variantId) ? payload.variantId : null;
  const levels = await deps.db.transaction({ shopId, userId: null, readOnly: true }, (tx) =>
    affectedLevels(tx, {
      variantId,
      locationIds: (payload.locationIds ?? []).filter((id) => UUID.test(id)),
      positionIds: (payload.positionIds ?? []).filter((id) => UUID.test(id)),
    }),
  );
  return pushLevels(deps, shopId, levels);
}

/** Pushes the levels a mapping change names (`shopify.levels.push`), or all of a connection's. */
export async function pushConnection(
  deps: SyncDeps,
  shopId: string,
  payload: ShopifyPushPayload,
): Promise<Array<PushLevel & { outcome: PushOutcome }>> {
  if (!UUID.test(payload.connectionId)) return [];
  const items = payload.inventoryItemIds?.filter((id) => NUMERIC.test(id)) ?? null;
  const locations = payload.shopifyLocationIds?.filter((id) => NUMERIC.test(id)) ?? null;
  const targets = await deps.db.transaction({ shopId, userId: null, readOnly: true }, (tx) =>
    levelTargets(tx, payload.connectionId, items, locations),
  );
  return pushLevels(
    deps,
    shopId,
    targets.map((t) => ({
      connectionId: payload.connectionId,
      inventoryItemId: t.inventoryItemId,
      shopifyLocationId: t.shopifyLocationId,
    })),
  );
}

export async function pushLevels(
  deps: SyncDeps,
  shopId: string,
  levels: PushLevel[],
): Promise<Array<PushLevel & { outcome: PushOutcome }>> {
  const out: Array<PushLevel & { outcome: PushOutcome }> = [];
  const stores = new Map<string, ConnectedStore>();
  for (const level of levels) {
    let store = stores.get(level.connectionId);
    if (!store) {
      store = await connectedStore(deps, shopId, level.connectionId);
      stores.set(level.connectionId, store);
    }
    out.push({ ...level, outcome: await pushLevel(deps, store, level) });
  }
  return out;
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

/**
 * Sets Shopify's available quantity for one item at one location with compare-and-set.
 *
 * Shopify lowers its own quantity when it accepts an order, so a refused write usually means an
 * order Airstock has not processed yet, not an edit. Before calling it a conflict, the push
 * processes any such orders and tries again; only a difference that remains unexplained is
 * recorded as a conflict, and Shopify is left untouched (ADR 0008, P1).
 */
export async function pushLevel(
  deps: SyncDeps,
  store: ConnectedStore,
  level: PushLevel,
): Promise<PushOutcome> {
  const key = [level.connectionId, level.inventoryItemId, level.shopifyLocationId];
  const { shopId } = store;
  // Recorded on the push event, so the P1 path is visible in the activity history.
  let refusedWrites = 0;
  let ordersCaughtUp = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    // The level row stays locked while Shopify is called, so pushes and order lines for the
    // same level apply one at a time.
    const step = await deps.db.transaction({ shopId, userId: null }, async (tx) => {
      const [target] = await levelTargets(
        tx,
        level.connectionId,
        [level.inventoryItemId],
        [level.shopifyLocationId],
      );
      if (!target) return { kind: 'unmapped' as const };
      await tx.query(
        `insert into shopify_inventory_levels (shop_id, connection_id, shopify_inventory_item_id,
           shopify_location_id) values (app_shop_id(), $1, $2, $3) on conflict do nothing`,
        key,
      );
      const [row] = await tx.query<{
        expected_available: number | null;
        expected_as_of: Date | null;
      }>(
        `select expected_available, expected_as_of from shopify_inventory_levels where ${LEVEL_KEY} for update`,
        key,
      );
      if (!row || row.expected_available === null) {
        return { kind: 'init' as const, variantId: target.variantId };
      }
      const from = row.expected_available;
      // Read again under the lock: an order line may have changed it while this waited.
      const [now] = await levelTargets(
        tx,
        level.connectionId,
        [level.inventoryItemId],
        [level.shopifyLocationId],
      );
      const to = now?.target ?? 0;
      if (to === from) return { kind: 'unchanged' as const };
      const set = await store.admin.setAvailable({
        inventoryItemId: level.inventoryItemId,
        locationId: level.shopifyLocationId,
        quantity: to,
        from,
        idempotencyKey: uuidv7(),
        reference: `airstock://shops/${shopId}/shopify-connections/${level.connectionId}`,
      });
      if (set.kind === 'stale') {
        return {
          kind: 'stale' as const,
          from,
          target: to,
          asOf: row.expected_as_of,
          variantId: target.variantId,
        };
      }
      // now() is when this transaction began, before Shopify accepted the write: an order that
      // Shopify created after it is not in `to` and still lowers the record.
      await tx.query(
        `update shopify_inventory_levels set expected_available = $4, expected_as_of = now(),
           last_pushed_available = $4, last_pushed_at = now(), conflict_at = null,
           conflict_shopify_available = null, updated_at = now()
         where ${LEVEL_KEY}`,
        [...key, to],
      );
      await tx.query(INSERT_AUDIT_EVENTS_SQL, [
        JSON.stringify([
          syncEvent(store, level, target.variantId, {
            action: 'shopify.inventory.pushed',
            outcome: 'succeeded',
            changes: {
              available: { from, to },
              ...(refusedWrites > 0 ? { refusedWrites, ordersCaughtUp } : {}),
            },
          }),
        ]),
      ]);
      return { kind: 'pushed' as const };
    });

    if (step.kind === 'pushed' || step.kind === 'unchanged' || step.kind === 'unmapped') {
      return step.kind;
    }

    if (step.kind === 'init') {
      // First push for this level: process orders Shopify already counted, then read Shopify's
      // quantity as the starting point.
      ordersCaughtUp += await catchUpOrders(deps, store, store.createdAt);
      const readAt = new Date();
      const actual = await store.admin.getAvailable(level.inventoryItemId, level.shopifyLocationId);
      if (actual === null) {
        deps.logger?.error('shopify_item_not_stocked', { ...level });
        return 'not_stocked';
      }
      await deps.db.transaction({ shopId, userId: null }, (tx) =>
        tx.query(
          `update shopify_inventory_levels set expected_available = $4, expected_as_of = $5,
             updated_at = now()
           where ${LEVEL_KEY} and expected_available is null`,
          [...key, actual, readAt.toISOString()],
        ),
      );
      continue;
    }

    // Stale: explain the difference with orders Airstock has not processed yet (P1).
    const since = new Date(
      Math.max(store.createdAt.getTime(), (step.asOf ? new Date(step.asOf).getTime() : 0) - 60_000),
    );
    refusedWrites++;
    const processed = await catchUpOrders(deps, store, since);
    ordersCaughtUp += processed;
    if (processed > 0) continue;
    const actual = await store.admin.getAvailable(level.inventoryItemId, level.shopifyLocationId);
    await recordConflict(deps, store, level, step.variantId, {
      expected: step.from,
      airstock: step.target,
      actual,
    });
    return 'conflict';
  }
  return 'conflict';
}

export async function recordConflict(
  deps: SyncDeps,
  store: ConnectedStore,
  level: PushLevel,
  variantId: string | null,
  values: { expected: number; airstock: number; actual: number | null },
): Promise<void> {
  const key = [level.connectionId, level.inventoryItemId, level.shopifyLocationId];
  await deps.db.transaction({ shopId: store.shopId, userId: null }, async (tx) => {
    const changed = await tx.query(
      `update shopify_inventory_levels set conflict_shopify_available = $4,
         conflict_at = now(), updated_at = now()
       where ${LEVEL_KEY} and (conflict_at is null or conflict_shopify_available is distinct from $4)
       returning 1`,
      [...key, values.actual],
    );
    // One event per new difference, not one per retry.
    if (changed.length === 0) return;
    await tx.query(INSERT_AUDIT_EVENTS_SQL, [
      JSON.stringify([
        syncEvent(store, level, variantId, {
          action: 'shopify.inventory.conflict',
          outcome: 'conflict',
          changes: values,
          reason: 'Shopify’s quantity differs from Airstock’s record and no order explains it.',
        }),
      ]),
    ]);
  });
}
