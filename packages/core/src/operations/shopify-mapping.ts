import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { errors } from '../errors.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id } from '../schemas.ts';
import { MAPPING_IN_DASHBOARD, ShopifyId, shopifyNumericId } from '../shopify/ids.ts';
import { SHOPIFY_PUSH_TOPIC, shopifyChannel } from '../shopify/targets.ts';

// Mapping a connected Shopify store (plan Section 5.14, PRD 8.5): each Shopify location to a
// warehouse or a location, each Shopify variant to a variant, a sales pack, or a bundle. Unmapped
// locations and variants are listed, never guessed. Changing a map makes Airstock read Shopify's
// quantity there again, then set it to Airstock's (the first push, ADR 0008).

/** Locks the connection row: mapping changes of one connection apply one at a time. */
export async function lockActiveConnection(tx: Tx, connectionId: string): Promise<void> {
  const [connection] = await tx.query<{ status: string }>(
    'select status from shopify_connections where id = $1 for update',
    [connectionId],
  );
  if (!connection) throw errors.notFound('Shopify connection');
  if (connection.status !== 'active') {
    throw errors.conflict('shopify_not_connected', 'This Shopify store is not connected.');
  }
}

// Locations ----------------------------------------------------------------------------------

export const LocationMapIn = z
  .object({
    shopifyLocationId: ShopifyId,
    warehouseId: Id.optional().describe('Every location in this warehouse.'),
    locationId: Id.optional().describe('This location and its sub-locations.'),
    receiveLocationId: Id.optional().describe(
      'Where quantities read from Shopify are received; defaults to the first location without sub-locations in the scope.',
    ),
  })
  .refine((m) => Boolean(m.warehouseId) !== Boolean(m.locationId), {
    message: 'Name exactly one of warehouseId or locationId.',
  });

export interface LocationMapRow {
  shopifyLocationId: string;
  warehouseId: string | null;
  locationId: string | null;
  scopeId: string;
  receiveLocationId: string | null;
  position: number;
}

/**
 * Replaces a connection's location maps and its allocation rule (channel `shopify:<connection>`,
 * the scopes in the order given). Scopes may not overlap: one unit shown at two Shopify
 * locations could be sold twice. Levels of Shopify locations whose scope changed are read from
 * Shopify again before their next push.
 */
export async function applyLocationMaps(
  ctx: HandlerContext,
  connectionId: string,
  input: Array<z.infer<typeof LocationMapIn>>,
): Promise<{ maps: LocationMapRow[]; reset: string[] }> {
  const shopifyIds = input.map((m) => shopifyNumericId(m.shopifyLocationId));
  if (new Set(shopifyIds).size !== shopifyIds.length) {
    throw errors.validation([{ path: 'locations', message: 'Map each Shopify location once.' }]);
  }
  const scopeIds = input.map((m) => (m.warehouseId ?? m.locationId)!);
  if (new Set(scopeIds).size !== scopeIds.length) {
    throw errors.validation([
      { path: 'locations', message: 'Map each warehouse or location to one Shopify location.' },
    ]);
  }
  // Scopes with their ancestry, locked against archiving or moving while mapped (share lock, as
  // receipts take).
  type Scope = { id: string; kind: 'warehouse' | 'location'; status: string; path_ids: string[] };
  const scopes: Scope[] = [
    ...(await ctx.tx.query<Scope>(
      `select w.id, 'warehouse' as kind, w.status, array[w.id] as path_ids from warehouses w
       where w.id = any($1::uuid[]) for share`,
      [scopeIds],
    )),
    ...(await ctx.tx.query<Scope>(
      `select l.id, 'location' as kind, l.status, l.path_ids from locations l
       where l.id = any($1::uuid[]) and l.kind = 'storage' for share`,
      [scopeIds],
    )),
  ];
  const byId = new Map(scopes.map((s) => [s.id, s]));
  input.forEach((m, i) => {
    const scope = byId.get(scopeIds[i]!);
    const wanted = m.warehouseId ? 'warehouse' : 'location';
    if (!scope || scope.kind !== wanted)
      throw errors.notFound(m.warehouseId ? 'Warehouse' : 'Location');
    if (scope.status !== 'active') {
      throw errors.unprocessable('scope_archived', 'Map an active warehouse or location.');
    }
  });
  for (const a of scopes) {
    for (const b of scopes) {
      if (a.id !== b.id && b.path_ids.includes(a.id)) {
        throw errors.unprocessable(
          'scopes_overlap',
          'Two Shopify locations would show the same stock: map warehouses or locations that do not contain each other.',
        );
      }
    }
  }
  // Receiving locations: inside the scope, active, without sub-locations.
  const leaves = await ctx.tx.query<{ id: string; path_ids: string[] }>(
    `select l.id, l.path_ids from locations l
     where l.kind = 'storage' and l.status = 'active' and l.path_ids && $1::uuid[]
       and not exists (select 1 from locations c where c.shop_id = l.shop_id and c.parent_id = l.id
         and c.status = 'active')
     order by l.path, l.id`,
    [scopeIds],
  );
  const maps: LocationMapRow[] = input.map((m, i) => {
    const scopeId = scopeIds[i]!;
    let receive: string | null = null;
    if (m.receiveLocationId) {
      const leaf = leaves.find((l) => l.id === m.receiveLocationId);
      if (!leaf || !leaf.path_ids.includes(scopeId)) {
        throw errors.unprocessable(
          'receive_location_invalid',
          'Receive at an active location without sub-locations inside the mapped warehouse or location.',
        );
      }
      receive = leaf.id;
    } else {
      receive = leaves.find((l) => l.path_ids.includes(scopeId))?.id ?? null;
    }
    return {
      shopifyLocationId: shopifyIds[i]!,
      warehouseId: m.warehouseId ?? null,
      locationId: m.locationId ?? null,
      scopeId,
      receiveLocationId: receive,
      position: i,
    };
  });

  const before = await ctx.tx.query<{ shopify_location_id: string; scope_id: string }>(
    'select shopify_location_id, scope_id from shopify_location_maps where connection_id = $1',
    [connectionId],
  );
  const now = new Map(maps.map((m) => [m.shopifyLocationId, m.scopeId]));
  const reset = before
    .filter((b) => now.get(b.shopify_location_id) !== b.scope_id)
    .map((b) => b.shopify_location_id);
  // Two statements: every part of one statement sees the same snapshot, so an insert there would
  // still collide with the rows its own delete removes.
  await ctx.tx.query('delete from shopify_location_maps where connection_id = $1', [connectionId]);
  await ctx.tx.query(
    `insert into shopify_location_maps (shop_id, connection_id, shopify_location_id, location_id,
       warehouse_id, receive_location_id, position)
     select app_shop_id(), $1, x."shopifyLocationId", x."locationId", x."warehouseId",
       x."receiveLocationId", x.position
     from jsonb_to_recordset($2::jsonb) as x("shopifyLocationId" text, "locationId" uuid,
       "warehouseId" uuid, "receiveLocationId" uuid, position int)`,
    [connectionId, JSON.stringify(maps)],
  );
  if (reset.length > 0) {
    await ctx.tx.query(
      `update shopify_inventory_levels set expected_available = null, expected_as_of = null,
         conflict_at = null, conflict_shopify_available = null, updated_at = now()
       where connection_id = $1 and shopify_location_id = any($2::text[])`,
      [connectionId, reset],
    );
  }
  // The connection's orders are allocated from the mapped scopes, in this order (D3).
  const channel = shopifyChannel(connectionId);
  if (maps.length === 0) {
    await ctx.tx.query(
      `delete from allocation_rule_locations where rule_id in
         (select id from allocation_rules where channel = $1)`,
      [channel],
    );
  } else {
    const [rule] = await ctx.tx.query<{ id: string }>(
      `insert into allocation_rules (shop_id, id, channel) values (app_shop_id(), $1, $2)
       on conflict (shop_id, channel) do update set version = allocation_rules.version + 1,
         updated_at = now()
       returning id`,
      [ctx.newId(), channel],
    );
    await ctx.tx.query('delete from allocation_rule_locations where rule_id = $1', [rule!.id]);
    await ctx.tx.query(
      `insert into allocation_rule_locations (shop_id, rule_id, position, scope_id)
       select app_shop_id(), $1, x.i - 1, x.id from unnest($2::uuid[]) with ordinality as x(id, i)`,
      [rule!.id, maps.map((m) => m.scopeId)],
    );
  }
  return { maps, reset };
}

const LocationMapOut = z.object({
  shopifyLocationId: z.string(),
  warehouseId: Id.nullable(),
  locationId: Id.nullable(),
  receiveLocationId: Id.nullable(),
});

export const mapShopifyLocations = defineOperation({
  id: 'shopify.locations.map',
  summary: 'Map Shopify locations to warehouses or locations',
  description:
    'Replaces the location maps of one connected Shopify store. Each Shopify location shows the availability of one warehouse, or one location and its sub-locations; Shopify orders are reserved from these, in the order listed. Scopes may not overlap. A Shopify location left out is not synced. Airstock then reads Shopify’s quantity at each changed location and sets it to Airstock’s.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ connectionId: Id, locations: z.array(LocationMapIn).max(50) }),
  output: z.object({ connectionId: Id, locations: z.array(LocationMapOut) }),
  permission: 'connections.manage',
  connectionScope: 'session',
  audit: { action: 'shopify.locations.mapped' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/shopify/connections/{connectionId}/locations' },
  mcp: { exception: MAPPING_IN_DASHBOARD },
  locations: (input) =>
    input.locations.flatMap((m) => [
      ...(m.locationId ? [m.locationId] : []),
      ...(m.receiveLocationId ? [m.receiveLocationId] : []),
    ]),
  async handler(ctx, input) {
    await lockActiveConnection(ctx.tx, input.connectionId);
    const { maps, reset } = await applyLocationMaps(ctx, input.connectionId, input.locations);
    const out = maps.map((m) => ({
      shopifyLocationId: m.shopifyLocationId,
      warehouseId: m.warehouseId,
      locationId: m.locationId,
      receiveLocationId: m.receiveLocationId,
    }));
    return {
      result: { connectionId: input.connectionId, locations: out },
      audit: {
        targetType: 'shopify_connection',
        targetId: input.connectionId,
        locationIds: maps.flatMap((m) => (m.locationId ? [m.locationId] : [])),
        changes: { locations: out, readAgain: reset },
      },
      outbox: [{ topic: SHOPIFY_PUSH_TOPIC, payload: { connectionId: input.connectionId } }],
    };
  },
});

// Variants -----------------------------------------------------------------------------------

export const VariantMapIn = z.object({
  shopifyVariantId: ShopifyId,
  shopifyInventoryItemId: ShopifyId,
  shopifyProductId: ShopifyId.optional(),
  sku: z.string().max(255).nullable().optional(),
  title: z.string().max(1000).nullable().optional(),
  variantId: Id.nullable().describe('Null removes the map.'),
  packId: Id.nullable()
    .optional()
    .describe('A sales pack of the variant: one Shopify item is one pack.'),
});

export type VariantMapInput = z.infer<typeof VariantMapIn> & {
  source?: 'sku' | 'barcode' | 'manual' | 'onboarding' | 'listing';
};

/**
 * Sets or removes variant maps of one connection. A Shopify variant sells one unit of a variant,
 * one of its packs, or one bundle; two Shopify variants may not sell the same thing (they would
 * both show the same stock). With `replace`, maps not listed are removed.
 */
export async function applyVariantMaps(
  ctx: HandlerContext,
  connectionId: string,
  input: VariantMapInput[],
  replace = false,
): Promise<{ set: number; removed: number; items: string[] }> {
  const rows = input.map((v) => ({
    shopifyVariantId: shopifyNumericId(v.shopifyVariantId),
    shopifyInventoryItemId: shopifyNumericId(v.shopifyInventoryItemId),
    shopifyProductId: v.shopifyProductId ? shopifyNumericId(v.shopifyProductId) : null,
    sku: v.sku ?? null,
    title: v.title ?? null,
    variantId: v.variantId,
    packId: v.packId ?? null,
    source: v.source ?? 'manual',
  }));
  const unique = (values: string[]) => new Set(values).size === values.length;
  const targets = rows.filter((r) => r.variantId);
  if (
    !unique(rows.map((r) => r.shopifyVariantId)) ||
    !unique(targets.map((r) => `${r.variantId}:${r.packId ?? ''}`))
  ) {
    throw errors.validation([
      {
        path: 'variants',
        message:
          'Each Shopify variant may appear once, and two Shopify variants may not sell the same variant or pack.',
      },
    ]);
  }
  const variantIds = [...new Set(targets.map((r) => r.variantId!))];
  const known = await ctx.tx.query<{ id: string; status: string; bundle: boolean }>(
    `select v.id, v.status, exists (select 1 from bundles b where b.shop_id = v.shop_id
       and b.variant_id = v.id and b.active) as bundle
     from variants v where v.id = any($1::uuid[]) for key share`,
    [variantIds],
  );
  if (known.length !== variantIds.length) throw errors.notFound('Variant');
  const byVariant = new Map(known.map((k) => [k.id, k]));
  const packIds = targets.flatMap((r) => (r.packId ? [r.packId] : []));
  const packs = await ctx.tx.query<{ id: string; variant_id: string; status: string }>(
    'select id, variant_id, status from packs where id = any($1::uuid[])',
    [packIds],
  );
  const byPack = new Map(packs.map((p) => [p.id, p]));
  for (const r of targets) {
    if (byVariant.get(r.variantId!)!.status !== 'active') {
      throw errors.conflict('variant_archived', 'Map active variants only.');
    }
    if (r.packId) {
      const pack = byPack.get(r.packId);
      if (!pack || pack.variant_id !== r.variantId) throw errors.notFound('Pack');
      if (pack.status !== 'active') {
        throw errors.conflict('pack_archived', 'This pack is archived.');
      }
      if (byVariant.get(r.variantId!)!.bundle) {
        throw errors.unprocessable('bundle_pack', 'A bundle is mapped without a pack.');
      }
    }
  }

  // Maps whose target or item changes: their levels are read from Shopify again.
  const before = await ctx.tx.query<{
    shopify_variant_id: string;
    shopify_inventory_item_id: string;
    variant_id: string;
    pack_id: string | null;
  }>(
    `select shopify_variant_id, shopify_inventory_item_id, variant_id, pack_id
     from shopify_variant_maps where connection_id = $1
       and ($2 or shopify_variant_id = any($3::text[]))
     for update`,
    [connectionId, replace, rows.map((r) => r.shopifyVariantId)],
  );
  const listed = new Map(rows.map((r) => [r.shopifyVariantId, r]));
  const changedItems = new Set<string>();
  const removedIds: string[] = [];
  for (const b of before) {
    const r = listed.get(b.shopify_variant_id);
    if (!r?.variantId) {
      removedIds.push(b.shopify_variant_id);
      changedItems.add(b.shopify_inventory_item_id);
    } else if (
      r.variantId !== b.variant_id ||
      r.packId !== b.pack_id ||
      r.shopifyInventoryItemId !== b.shopify_inventory_item_id
    ) {
      changedItems.add(b.shopify_inventory_item_id);
      changedItems.add(r.shopifyInventoryItemId);
    }
  }
  const existing = new Set(before.map((b) => b.shopify_variant_id));
  for (const r of targets) {
    if (!existing.has(r.shopifyVariantId)) changedItems.add(r.shopifyInventoryItemId);
  }
  if (removedIds.length > 0) {
    await ctx.tx.query(
      'delete from shopify_variant_maps where connection_id = $1 and shopify_variant_id = any($2::text[])',
      [connectionId, removedIds],
    );
  }
  if (targets.length > 0) {
    try {
      await ctx.tx.query(
        `insert into shopify_variant_maps (shop_id, connection_id, shopify_variant_id,
           shopify_inventory_item_id, variant_id, pack_id, shopify_product_id, sku, title, source)
         select app_shop_id(), $1, x."shopifyVariantId", x."shopifyInventoryItemId", x."variantId",
           x."packId", x."shopifyProductId", x.sku, x.title, x.source
         from jsonb_to_recordset($2::jsonb) as x("shopifyVariantId" text, "shopifyInventoryItemId" text,
           "variantId" uuid, "packId" uuid, "shopifyProductId" text, sku text, title text, source text)
         on conflict (shop_id, connection_id, shopify_variant_id) do update set
           shopify_inventory_item_id = excluded.shopify_inventory_item_id,
           variant_id = excluded.variant_id, pack_id = excluded.pack_id,
           shopify_product_id = coalesce(excluded.shopify_product_id, shopify_variant_maps.shopify_product_id),
           sku = coalesce(excluded.sku, shopify_variant_maps.sku),
           title = coalesce(excluded.title, shopify_variant_maps.title),
           source = excluded.source, updated_at = now()`,
        [connectionId, JSON.stringify(targets)],
      );
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'shopify_variant_maps_target_idx') {
        throw errors.conflict(
          'target_already_mapped',
          'Another Shopify variant already sells this variant or pack. Remove that map first.',
        );
      }
      throw error;
    }
  }
  const items = [...changedItems];
  if (items.length > 0) {
    await ctx.tx.query(
      `update shopify_inventory_levels set expected_available = null, expected_as_of = null,
         conflict_at = null, conflict_shopify_available = null, updated_at = now()
       where connection_id = $1 and shopify_inventory_item_id = any($2::text[])`,
      [connectionId, items],
    );
  }
  return { set: targets.length, removed: removedIds.length, items };
}

export const mapShopifyVariants = defineOperation({
  id: 'shopify.variants.map',
  summary: 'Map Shopify variants to variants, packs, or bundles',
  description:
    'Sets or removes the maps of up to 1,000 Shopify variants of one connected store. A Shopify variant sells one unit of a variant, one of its sales packs (Shopify shows whole packs: floor(available ÷ pack size), and a sale reserves that many units), or one bundle (its components are reserved). variantId null removes a map. Airstock then reads Shopify’s quantity for each changed item and sets it to Airstock’s.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ connectionId: Id, variants: z.array(VariantMapIn).min(1).max(1000) }),
  output: z.object({ connectionId: Id, set: z.number().int(), removed: z.number().int() }),
  permission: 'connections.manage',
  connectionScope: 'session',
  audit: { action: 'shopify.variants.mapped' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/shopify/connections/{connectionId}/variants' },
  mcp: { exception: MAPPING_IN_DASHBOARD },
  async handler(ctx, input) {
    await lockActiveConnection(ctx.tx, input.connectionId);
    const done = await applyVariantMaps(ctx, input.connectionId, input.variants);
    return {
      result: { connectionId: input.connectionId, set: done.set, removed: done.removed },
      audit: {
        targetType: 'shopify_connection',
        targetId: input.connectionId,
        changes: {
          variants: input.variants.map((v) => ({
            shopifyVariantId: shopifyNumericId(v.shopifyVariantId),
            variantId: v.variantId,
            packId: v.packId ?? null,
          })),
        },
      },
      outbox:
        done.items.length > 0
          ? [
              {
                topic: SHOPIFY_PUSH_TOPIC,
                payload: { connectionId: input.connectionId, inventoryItemIds: done.items },
              },
            ]
          : [],
    };
  },
});

export const shopifyMappingOperations = [mapShopifyLocations, mapShopifyVariants] as const;
