import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { applyAlertChanges } from '../alerts/check.ts';
import { compare, normalize, subtract } from '../catalog/decimal.ts';
import { errors } from '../errors.ts';
import { effectivePermissions } from '../permissions.ts';
import type { HandlerContext } from '../registry.ts';
import { defineOperation } from '../registry.ts';
import { Id, iso } from '../schemas.ts';
import { ShopifyId, shopifyNumericId } from '../shopify/ids.ts';
import { levelTargets, SHOPIFY_PUSH_TOPIC } from '../shopify/targets.ts';
import { adjustStock } from './inventory-adjustments.ts';
import { type Acc, inner } from './shopify-orders.ts';

// Sync health (plan Section 5.14, ADR 0037): one read that answers "is Shopify in step?" for the
// dashboard and the `shopify_sync` MCP tool, and the two ways to resolve a quantity conflict.

export const SYNC_TOOL = 'shopify_sync';

/** Whether a member may see a location map's scope (a warehouse or a location). */
const visibleScope = (scope: string, member: string) =>
  `(${member}::uuid[] is null or ${scope} = any(${member}::uuid[])
    or exists (select 1 from locations vl where vl.id = ${scope} and vl.path_ids && ${member}::uuid[])
    or exists (select 1 from locations vl where ${scope} = any(vl.path_ids) and vl.path_ids && ${member}::uuid[]))`;

const LevelOut = z.object({
  inventoryItemId: z.string(),
  shopifyLocationId: z.string(),
  shopifyLocationName: z.string().nullable(),
  scopeName: z.string().nullable(),
  variantId: Id.nullable(),
  sku: z.string().nullable(),
  sells: z.string().describe('What the Shopify variant sells: "unit", the pack name, or "bundle".'),
  shopifyVariantId: z.string().nullable(),
});

const Health = z.object({
  connectionId: Id,
  shopDomain: z.string(),
  status: z.enum(['active', 'uninstalled']),
  lastSyncAt: z.string().nullable().describe('The last reconciler run that finished.'),
  lastPushedAt: z.string().nullable(),
  lastWebhookAt: z.string().nullable(),
  ordersSyncedThrough: z
    .string()
    .nullable()
    .describe('Orders Shopify changed up to this time are applied here.'),
  levelsComparedAt: z.string().nullable().describe('The last full comparison of every level.'),
  lastError: z.object({ message: z.string(), at: z.string().nullable() }).nullable(),
  pendingPushes: z.object({
    count: z.number().int(),
    levels: z.array(
      LevelOut.extend({
        airstock: z.number().int(),
        shopify: z.number().int().nullable().describe('What Airstock last knew of Shopify.'),
      }),
    ),
  }),
  conflicts: z.array(
    LevelOut.extend({
      expected: z.number().int().nullable().describe('What Airstock believed Shopify held.'),
      airstock: z.number().int().nullable(),
      shopify: z.number().int().nullable(),
      since: z.string().nullable(),
      alertId: Id.nullable(),
    }),
  ),
  shortages: z.array(
    z.object({
      reservationId: Id,
      variantId: Id,
      sku: z.string(),
      externalRef: z.string().nullable(),
      quantity: z.string(),
      shortage: z.string(),
      since: z.string(),
    }),
  ),
  unmappedVariants: z.object({
    count: z.number().int(),
    sample: z.array(
      z.object({
        shopifyVariantId: z.string(),
        inventoryItemId: z.string().nullable(),
        sku: z.string().nullable(),
        title: z.string(),
      }),
    ),
  }),
  unmappedLocations: z.array(z.object({ id: z.string(), name: z.string() })),
  listings: z.object({
    count: z.number().int(),
    pending: z.number().int(),
    failed: z.array(z.object({ productId: Id, name: z.string(), error: z.string().nullable() })),
    differences: z.array(
      z.object({
        productId: Id,
        name: z.string(),
        field: z.string(),
        airstock: z.unknown(),
        shopify: z.unknown(),
        changedBy: z.enum(['shopify', 'airstock']),
        detectedAt: z.string(),
      }),
    ),
  }),
  mappings: z.object({
    locations: z.array(
      z.object({
        shopifyLocationId: z.string(),
        shopifyLocationName: z.string().nullable(),
        scopeId: Id,
        scopeName: z.string().nullable(),
      }),
    ),
    variantCount: z.number().int(),
    variants: z.array(
      z.object({
        shopifyVariantId: z.string(),
        title: z.string().nullable(),
        variantId: Id,
        sku: z.string(),
        sells: z.string(),
        source: z.string(),
      }),
    ),
  }),
});
export type ShopifySyncHealth = z.infer<typeof Health>;

interface MapRow {
  item: string;
  shopify_variant_id: string;
  variant_id: string;
  sku: string;
  sells: string;
}

/** What each mapped Shopify item sells, by inventory item. */
async function mapInfo(tx: Tx, connectionId: string): Promise<Map<string, MapRow>> {
  const rows = await tx.query<MapRow>(
    `select m.shopify_inventory_item_id as item, m.shopify_variant_id, m.variant_id, v.sku,
       case when b.id is not null then 'bundle' when p.id is not null then p.name else 'unit' end as sells
     from shopify_variant_maps m
     join variants v on v.shop_id = m.shop_id and v.id = m.variant_id
     left join packs p on p.shop_id = m.shop_id and p.id = m.pack_id
     left join bundles b on b.shop_id = m.shop_id and b.variant_id = m.variant_id and b.active
     where m.connection_id = $1`,
    [connectionId],
  );
  return new Map(rows.map((r) => [r.item, r]));
}

async function connectionHealth(
  ctx: HandlerContext,
  c: {
    id: string;
    shop_domain: string;
    status: 'active' | 'uninstalled';
    reconciled_at: Date | null;
    last_pushed_at: Date | null;
    orders_synced_through: Date | null;
    levels_compared_at: Date | null;
    last_error: string | null;
    last_error_at: Date | null;
    shopify_locations: Array<{ id: string; name: string; active: boolean }>;
    last_webhook_at: Date | null;
  },
  limit: number,
): Promise<ShopifySyncHealth> {
  const tx = ctx.tx;
  const names = new Map(c.shopify_locations.map((l) => [l.id, l.name]));
  const maps = await tx.query<{
    shopify_location_id: string;
    scope_id: string;
    scope_name: string | null;
    visible: boolean;
  }>(
    `select m.shopify_location_id, m.scope_id, coalesce(w.name, l.path) as scope_name,
       ${visibleScope('m.scope_id', '$2')} as visible
     from shopify_location_maps m
     left join warehouses w on w.shop_id = m.shop_id and w.id = m.warehouse_id
     left join locations l on l.shop_id = m.shop_id and l.id = m.location_id
     where m.connection_id = $1 order by m.position`,
    [c.id, ctx.locationScope],
  );
  const visible = new Set(maps.filter((m) => m.visible).map((m) => m.shopify_location_id));
  const scopeName = new Map(maps.map((m) => [m.shopify_location_id, m.scope_name]));
  const info = await mapInfo(tx, c.id);
  const level = (item: string, location: string) => {
    const m = info.get(item);
    return {
      inventoryItemId: item,
      shopifyLocationId: location,
      shopifyLocationName: names.get(location) ?? null,
      scopeName: scopeName.get(location) ?? null,
      variantId: m?.variant_id ?? null,
      sku: m?.sku ?? null,
      sells: m?.sells ?? 'unit',
      shopifyVariantId: m?.shopify_variant_id ?? null,
    };
  };

  const records = await tx.query<{
    item: string;
    location: string;
    expected_available: number | null;
    conflict_at: Date | null;
    conflict_shopify_available: number | null;
    conflict_airstock_available: number | null;
    conflict_alert_id: string | null;
  }>(
    `select shopify_inventory_item_id as item, shopify_location_id as location,
       expected_available, conflict_at, conflict_shopify_available, conflict_airstock_available,
       conflict_alert_id
     from shopify_inventory_levels where connection_id = $1`,
    [c.id],
  );
  const byKey = new Map(records.map((r) => [`${r.item}@${r.location}`, r]));
  const pending: ShopifySyncHealth['pendingPushes']['levels'] = [];
  let pendingCount = 0;
  if (c.status === 'active') {
    for (const t of await levelTargets(tx, c.id)) {
      if (!visible.has(t.shopifyLocationId)) continue;
      const r = byKey.get(`${t.inventoryItemId}@${t.shopifyLocationId}`);
      if (r?.conflict_at) continue;
      if (r && r.expected_available === t.target) continue;
      pendingCount += 1;
      if (pending.length < limit) {
        pending.push({
          ...level(t.inventoryItemId, t.shopifyLocationId),
          airstock: t.target,
          shopify: r?.expected_available ?? null,
        });
      }
    }
  }
  const conflicts = records
    .filter((r) => r.conflict_at && visible.has(r.location))
    .slice(0, limit)
    .map((r) => ({
      ...level(r.item, r.location),
      expected: r.expected_available,
      airstock: r.conflict_airstock_available,
      shopify: r.conflict_shopify_available,
      since: iso(r.conflict_at),
      alertId: r.conflict_alert_id,
    }));

  // Order demand no stock covers yet (D6). Not tied to one location: shown with every location.
  const shortages =
    ctx.locationScope === null
      ? await tx.query<{
          id: string;
          variant_id: string;
          sku: string;
          external_ref: string | null;
          quantity: string;
          shortage: string;
          created_at: Date;
        }>(
          `select r.id, r.variant_id, v.sku, r.external_ref, r.quantity::text,
             r.shortage_quantity::text as shortage, r.created_at
           from reservations r join variants v on v.shop_id = r.shop_id and v.id = r.variant_id
           where r.channel = $1 and r.shortage_quantity > 0
             and r.status in ('active', 'partially_fulfilled')
           order by r.created_at, r.id limit $2`,
          [`shopify:${c.id}`, limit],
        )
      : [];

  const [unmapped] = await tx.query<{
    count: number;
    sample: Array<{
      shopifyVariantId: string;
      inventoryItemId: string | null;
      sku: string | null;
      title: string;
    }>;
  }>(
    `with u as (
       select cv.shopify_variant_id, cv.shopify_inventory_item_id, cv.sku, cv.title
       from shopify_catalog_variants cv
       where cv.connection_id = $1 and cv.tracked
         and not exists (select 1 from shopify_variant_maps m where m.connection_id = cv.connection_id
           and m.shopify_variant_id = cv.shopify_variant_id))
     select (select count(*)::int from u) as count,
       coalesce((select json_agg(json_build_object('shopifyVariantId', x.shopify_variant_id,
         'inventoryItemId', x.shopify_inventory_item_id, 'sku', x.sku, 'title', x.title)) from (select * from u order by sku nulls last, title
         limit $2) x), '[]'::json) as sample`,
    [c.id, limit],
  );
  const variantMaps = await tx.query<{
    shopify_variant_id: string;
    title: string | null;
    variant_id: string;
    sku: string;
    sells: string;
    source: string;
  }>(
    `select m.shopify_variant_id, m.title, m.variant_id, v.sku, m.source,
       case when b.id is not null then 'bundle' when p.id is not null then p.name else 'unit' end as sells
     from shopify_variant_maps m
     join variants v on v.shop_id = m.shop_id and v.id = m.variant_id
     left join packs p on p.shop_id = m.shop_id and p.id = m.pack_id
     left join bundles b on b.shop_id = m.shop_id and b.variant_id = m.variant_id and b.active
     where m.connection_id = $1 order by v.sku, m.shopify_variant_id limit $2`,
    [c.id, limit],
  );
  const [listingCounts] = await tx.query<{ count: number; pending: number }>(
    `select count(*)::int as count, count(*) filter (where state = 'pending')::int as pending
     from shopify_listings where connection_id = $1`,
    [c.id],
  );
  const failed = await tx.query<{ product_id: string; name: string; last_error: string | null }>(
    `select l.product_id, p.name, l.last_error from shopify_listings l
     join products p on p.shop_id = l.shop_id and p.id = l.product_id
     where l.connection_id = $1 and l.state = 'failed' order by l.updated_at desc limit $2`,
    [c.id, limit],
  );
  const differences = await tx.query<{
    product_id: string;
    name: string;
    field: string;
    airstock: unknown;
    shopify: unknown;
    changed_by: 'shopify' | 'airstock';
    detected_at: Date;
  }>(
    `select d.product_id, p.name, d.field, d.airstock, d.shopify, d.changed_by, d.detected_at
     from shopify_listing_differences d join products p on p.shop_id = d.shop_id and p.id = d.product_id
     where d.connection_id = $1 order by d.detected_at desc limit $2`,
    [c.id, limit],
  );
  const mapped = new Set(maps.map((m) => m.shopify_location_id));
  return {
    connectionId: c.id,
    shopDomain: c.shop_domain,
    status: c.status,
    lastSyncAt: iso(c.reconciled_at),
    lastPushedAt: iso(c.last_pushed_at),
    lastWebhookAt: iso(c.last_webhook_at),
    ordersSyncedThrough: iso(c.orders_synced_through),
    levelsComparedAt: iso(c.levels_compared_at),
    lastError: c.last_error ? { message: c.last_error, at: iso(c.last_error_at) } : null,
    pendingPushes: { count: pendingCount, levels: pending },
    conflicts,
    shortages: shortages.map((r) => ({
      reservationId: r.id,
      variantId: r.variant_id,
      sku: r.sku,
      externalRef: r.external_ref,
      quantity: normalize(r.quantity),
      shortage: normalize(r.shortage),
      since: iso(r.created_at) as string,
    })),
    unmappedVariants: { count: unmapped?.count ?? 0, sample: unmapped?.sample ?? [] },
    unmappedLocations: c.shopify_locations
      .filter((l) => l.active && !mapped.has(l.id))
      .map((l) => ({ id: l.id, name: l.name })),
    listings: {
      count: listingCounts?.count ?? 0,
      pending: listingCounts?.pending ?? 0,
      failed: failed.map((f) => ({ productId: f.product_id, name: f.name, error: f.last_error })),
      differences: differences.map((d) => ({
        productId: d.product_id,
        name: d.name,
        field: d.field,
        airstock: d.airstock,
        shopify: d.shopify,
        changedBy: d.changed_by,
        detectedAt: iso(d.detected_at) as string,
      })),
    },
    mappings: {
      locations: maps
        .filter((m) => m.visible)
        .map((m) => ({
          shopifyLocationId: m.shopify_location_id,
          shopifyLocationName: names.get(m.shopify_location_id) ?? null,
          scopeId: m.scope_id,
          scopeName: m.scope_name,
        })),
      variantCount: info.size,
      variants: variantMaps.map((m) => ({
        shopifyVariantId: m.shopify_variant_id,
        title: m.title,
        variantId: m.variant_id,
        sku: m.sku,
        sells: m.sells,
        source: m.source,
      })),
    },
  };
}

export const shopifySyncHealth = defineOperation({
  id: 'shopify.sync.health',
  summary: 'Show whether Shopify is in step with Airstock',
  description:
    'Use this when someone asks whether Shopify is in sync, why a Shopify quantity or listing looks wrong, or what the Shopify connection needs: per connected store, the last sync and push, pending pushes, quantity conflicts (with what Airstock and Shopify each show), Shopify order shortages, unmapped Shopify variants and locations, listings that failed or differ between the two (title, description, status, prices, pictures), and the mappings. Read only. Not for stock levels themselves (use get_stock) or alerts in general (use stock_alerts).',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    connectionId: Id.optional().describe('One store; leave out for every connected store.'),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Most rows per list (conflicts, pending pushes, shortages, unmapped, maps).'),
  }),
  output: z.object({ connections: z.array(Health) }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'shopify.sync.health_viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/shopify/sync-health' },
  mcp: { tool: SYNC_TOOL, action: 'health', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const rows = await ctx.tx.query<Parameters<typeof connectionHealth>[1]>(
      `select c.id, c.shop_domain, c.status, c.reconciled_at, c.last_pushed_at,
         c.orders_synced_through, c.levels_compared_at, c.last_error, c.last_error_at,
         c.shopify_locations,
         (select max(r.received_at) from webhook_receipts r
            where r.shop_id = c.shop_id and r.connection_id = c.id) as last_webhook_at
       from shopify_connections c
       where ($1::uuid is null or c.id = $1)
       order by c.status, c.created_at desc limit 10`,
      [input.connectionId ?? null],
    );
    if (input.connectionId && rows.length === 0) throw errors.notFound('Shopify connection');
    const connections = [];
    for (const r of rows) connections.push(await connectionHealth(ctx, r, input.limit));
    return {
      result: { connections },
      audit: {
        targetType: 'shopify_connection',
        targetId: input.connectionId ?? 'all',
        context: { input },
      },
    };
  },
});

export const resolveShopifyConflict = defineOperation({
  id: 'shopify.conflicts.resolve',
  summary: 'Resolve a Shopify quantity conflict',
  description:
    'Use this when Shopify and Airstock disagree on a quantity no order explains (a conflict in sync health) and the person has decided which is right. choice "push_airstock" sets Shopify to Airstock’s availability (compare-and-set against Shopify’s quantity as last read; if it moved again, a new conflict opens). choice "take_shopify" makes Airstock match Shopify with a stock adjustment (reason count_correction, needs inventory.adjust) at that Shopify location’s scope, then nothing is pushed; it works for items sold one unit at a time, not packs, bundles, lots, or serials. Ask the person which side is right before calling.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    connectionId: Id,
    inventoryItemId: ShopifyId.describe('The Shopify inventory item, as sync health lists it.'),
    shopifyLocationId: ShopifyId,
    choice: z.enum(['push_airstock', 'take_shopify']),
    note: z.string().trim().min(1).max(500).optional(),
  }),
  output: z.object({
    choice: z.enum(['push_airstock', 'take_shopify']),
    airstock: z.number().int().describe('What Shopify should show now.'),
    shopify: z.number().int(),
    adjustmentOperationIds: z.array(Id),
  }),
  permission: 'connections.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'shopify.conflict.resolved' },
  idempotency: 'required',
  http: {
    method: 'POST',
    path: '/shops/{shopId}/shopify/connections/{connectionId}/conflicts/resolve',
  },
  mcp: { tool: SYNC_TOOL, action: 'resolve_conflict', readOnly: false, destructive: true },
  async handler(ctx, input) {
    const item = shopifyNumericId(input.inventoryItemId);
    const location = shopifyNumericId(input.shopifyLocationId);
    const [connection] = await ctx.tx.query<{ status: string }>(
      'select status from shopify_connections where id = $1 for key share',
      [input.connectionId],
    );
    if (!connection) throw errors.notFound('Shopify connection');
    if (connection.status !== 'active') {
      throw errors.conflict('shopify_not_connected', 'This Shopify store is not connected.');
    }
    const [map] = await ctx.tx.query<{
      scope_id: string;
      receive_location_id: string | null;
      in_scope: boolean;
    }>(
      `select m.scope_id, m.receive_location_id, ${visibleScope('m.scope_id', '$3')} as in_scope
       from shopify_location_maps m where m.connection_id = $1 and m.shopify_location_id = $2`,
      [input.connectionId, location, ctx.locationScope],
    );
    if (!map) throw errors.notFound('Shopify location map');
    if (!map.in_scope) {
      throw errors.forbidden('You do not have access to the locations of this Shopify location.');
    }
    const [row] = await ctx.tx.query<{
      expected_available: number | null;
      conflict_at: Date | null;
      conflict_shopify_available: number | null;
      checked_at: Date | null;
    }>(
      `select expected_available, conflict_at, conflict_shopify_available, checked_at
       from shopify_inventory_levels
       where connection_id = $1 and shopify_inventory_item_id = $2 and shopify_location_id = $3
       for update`,
      [input.connectionId, item, location],
    );
    if (!row?.conflict_at) {
      throw errors.conflict('no_conflict', 'There is no open conflict for this item and location.');
    }
    if (row.conflict_shopify_available === null) {
      throw errors.unprocessable(
        'not_stocked_in_shopify',
        'Shopify does not stock this item at that location; map or stock it there first.',
      );
    }
    const shopify = row.conflict_shopify_available;
    const [target] = await levelTargets(ctx.tx, input.connectionId, [item], [location]);
    if (!target) throw errors.notFound('Shopify variant map');
    const acc: Acc = {
      levels: new Set(),
      took: [],
      outbox: [],
      events: [],
      webhooks: [],
      alertVariants: [],
    };
    const operationIds: string[] = [];
    let airstock = target.target;

    if (input.choice === 'take_shopify') {
      const permissions = ctx.membership ? effectivePermissions(ctx.membership) : new Set();
      if (!permissions.has('inventory.adjust')) {
        throw errors.forbidden(
          'Taking Shopify’s quantity adjusts stock: it needs inventory.adjust.',
        );
      }
      const [m] = await ctx.tx.query<{
        pack_id: string | null;
        bundle: boolean;
        tracking_mode: string;
      }>(
        `select m.pack_id, exists (select 1 from bundles b where b.shop_id = m.shop_id
           and b.variant_id = m.variant_id and b.active) as bundle, v.tracking_mode
         from shopify_variant_maps m join variants v on v.shop_id = m.shop_id and v.id = m.variant_id
         where m.connection_id = $1 and m.shopify_inventory_item_id = $2`,
        [input.connectionId, item],
      );
      if (!m || m.pack_id || m.bundle || m.tracking_mode !== 'none') {
        throw errors.unprocessable(
          'take_shopify_unsupported',
          'Shopify’s number can only be taken for an item sold one unit at a time without lots or serials. Adjust the stock yourself, then choose push_airstock.',
        );
      }
      const delta = shopify - target.target;
      if (delta > 0) {
        if (!map.receive_location_id) {
          throw errors.unprocessable(
            'no_receiving_location',
            'This Shopify location has no receiving location to add units to.',
          );
        }
        const done = await inner(ctx, acc, adjustStock, {
          locationId: map.receive_location_id,
          adjustmentReason: 'count_correction',
          adjustments: [{ variantId: target.variantId, direction: 'add', quantity: String(delta) }],
          note: input.note ?? 'Took Shopify’s quantity (sync health).',
        });
        operationIds.push(done.operationId);
      } else if (delta < 0) {
        // Free units in the scope, most first, one adjustment per shelf.
        const shelves = await ctx.tx.query<{ location_id: string; available: string }>(
          `select location_id, sum(available)::text as available
           from stock_positions(array[$1::uuid]) where $2::uuid = any(path_ids) and available > 0
           group by location_id order by sum(available) desc, location_id`,
          [target.variantId, map.scope_id],
        );
        let left = String(-delta);
        for (const shelf of shelves) {
          if (compare(left, '0') <= 0) break;
          const take = compare(shelf.available, left) < 0 ? normalize(shelf.available) : left;
          const done = await inner(ctx, acc, adjustStock, {
            locationId: shelf.location_id,
            adjustmentReason: 'count_correction',
            adjustments: [{ variantId: target.variantId, direction: 'remove', quantity: take }],
            note: input.note ?? 'Took Shopify’s quantity (sync health).',
          });
          operationIds.push(done.operationId);
          left = normalize(subtract(left, take));
        }
        if (compare(left, '0') > 0) {
          throw errors.conflict(
            'units_reserved',
            'Some of the units are held for orders; release them first, or choose push_airstock.',
          );
        }
      }
      airstock = shopify;
    }

    // Both sides now agree on Shopify's quantity as read; the push writes Airstock's from there.
    await ctx.tx.query(
      `update shopify_inventory_levels set expected_available = $4,
         expected_as_of = coalesce(checked_at, conflict_at), conflict_at = null,
         conflict_shopify_available = null, conflict_airstock_available = null,
         conflict_alert_id = null, updated_at = now()
       where connection_id = $1 and shopify_inventory_item_id = $2 and shopify_location_id = $3`,
      [input.connectionId, item, location, shopify],
    );
    const [alert] = await ctx.tx.query<{ id: string }>(
      `select id from alerts where dedupe_key = $1 and status <> 'resolved' for update`,
      [`shopify_conflict:${input.connectionId}:${item}@${location}`],
    );
    const resolution = input.choice === 'push_airstock' ? 'pushed_airstock' : 'took_shopify';
    const effects = alert
      ? await applyAlertChanges(
          ctx.tx,
          ctx.event,
          [],
          [
            {
              id: alert.id,
              kind: 'shopify_sync',
              resolution,
              webhookLocationIds: [map.scope_id],
              details: { resolvedBy: ctx.caller.id, airstock, shopify },
            },
          ],
          'shopify_conflict_resolved',
        )
      : { events: [], outbox: [], webhooks: [] };
    return {
      result: {
        choice: input.choice,
        airstock,
        shopify,
        adjustmentOperationIds: operationIds,
      },
      audit: {
        targetType: 'variant',
        targetId: target.variantId,
        externalRef: `shopify:inventory_item/${item}/location/${location}`,
        locationIds: [map.scope_id],
        changes: { choice: input.choice, shopify, airstock, expected: row.expected_available },
        reason: input.note ?? null,
      },
      outbox: [
        ...acc.outbox,
        ...effects.outbox,
        {
          topic: SHOPIFY_PUSH_TOPIC,
          payload: {
            connectionId: input.connectionId,
            inventoryItemIds: [item],
            shopifyLocationIds: [location],
          },
        },
      ],
      events: [...acc.events, ...effects.events],
      webhooks: [...acc.webhooks, ...effects.webhooks],
      ...(acc.alertVariants.length > 0 ? { alertCheck: { variantIds: acc.alertVariants } } : {}),
    };
  },
});

export const shopifySyncOperations = [shopifySyncHealth, resolveShopifyConflict] as const;
