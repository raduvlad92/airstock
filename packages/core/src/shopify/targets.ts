import type { Tx } from '@airstock/db';

// What Airstock shows in Shopify (plan Section 5.14, PRD 8.5): for each mapped Shopify inventory
// item at each mapped Shopify location, the whole units sellable in the location map's scope (a
// warehouse, or a location and its sub-locations).
//
//   a variant: floor(available)
//   a sales pack: floor(available ÷ the pack's base quantity)
//   a bundle: the smallest floor(component available ÷ component units per bundle)
//
// Availability is the shared `stock_positions` rule (ADR 0020): never below zero, and expired
// reservations and lots already left out. An archived variant, pack, or component shows zero.

/** The allocation-rule channel of a connection's orders (D3). */
export const shopifyChannel = (connectionId: string) => `shopify:${connectionId}`;

/** Outbox topic: push these levels of one connection (all of them when the lists are absent). */
export const SHOPIFY_PUSH_TOPIC = 'shopify.levels.push';

export interface ShopifyPushPayload {
  connectionId: string;
  inventoryItemIds?: string[];
  shopifyLocationIds?: string[];
}

/** Shopify's limit for an `available` quantity is far above this; it keeps the integer safe. */
const MAX_PUSHED = 1_000_000_000;

export interface LevelTarget {
  inventoryItemId: string;
  shopifyLocationId: string;
  /** The Airstock variant mapped to the item (the bundle's variant for a bundle). */
  variantId: string;
  /** The location map's warehouse or location. */
  scopeId: string;
  target: number;
}

/**
 * Targets for the mapped levels of one connection, optionally limited to some items and
 * Shopify locations. A read: no locks.
 */
export async function levelTargets(
  tx: Tx,
  connectionId: string,
  inventoryItemIds: string[] | null = null,
  shopifyLocationIds: string[] | null = null,
): Promise<LevelTarget[]> {
  const rows = await tx.query<{
    item: string;
    shopify_location_id: string;
    variant_id: string;
    scope_id: string;
    target: string;
  }>(
    `with lm as (
       select shopify_location_id, scope_id from shopify_location_maps
       where connection_id = $1 and ($3::text[] is null or shopify_location_id = any($3::text[]))),
     vm as (
       select m.shopify_inventory_item_id as item, m.variant_id, m.pack_id,
         coalesce(pk.base_quantity, 1) as per_item,
         v.status = 'active' and coalesce(pk.status, 'active') = 'active' as ok,
         b.id as bundle_id, b.version as bundle_version
       from shopify_variant_maps m
       join variants v on v.shop_id = m.shop_id and v.id = m.variant_id
       left join packs pk on pk.shop_id = m.shop_id and pk.id = m.pack_id
       left join bundles b on b.shop_id = m.shop_id and b.variant_id = m.variant_id and b.active
       where m.connection_id = $1 and ($2::text[] is null or m.shopify_inventory_item_id = any($2::text[]))),
     need as (
       select vm.item, vm.variant_id, vm.variant_id as stock_variant_id, vm.per_item as per, vm.ok
       from vm where vm.bundle_id is null
       union all
       select vm.item, vm.variant_id, c.variant_id, sum(c.base_quantity), bool_and(vm.ok and cv.status = 'active')
       from vm
       join bundle_versions bv on bv.shop_id = app_shop_id() and bv.bundle_id = vm.bundle_id
         and bv.version = vm.bundle_version
       join bundle_components c on c.shop_id = bv.shop_id and c.bundle_version_id = bv.id
       join variants cv on cv.shop_id = c.shop_id and cv.id = c.variant_id
       where vm.bundle_id is not null
       group by vm.item, vm.variant_id, c.variant_id),
     stock as (
       select sp.variant_id, lm.shopify_location_id, sum(sp.available) as available
       from stock_positions(array(select distinct stock_variant_id from need)) sp
       join lm on lm.scope_id = any(sp.path_ids)
       group by sp.variant_id, lm.shopify_location_id)
     select n.item, lm.shopify_location_id, min(n.variant_id::text) as variant_id,
       min(lm.scope_id::text) as scope_id,
       min(case when n.ok then floor(coalesce(s.available, 0) / n.per) else 0 end)::text as target
     from need n cross join lm
     left join stock s on s.variant_id = n.stock_variant_id and s.shopify_location_id = lm.shopify_location_id
     group by n.item, lm.shopify_location_id
     order by n.item, lm.shopify_location_id`,
    [connectionId, inventoryItemIds, shopifyLocationIds],
  );
  return rows.map((r) => ({
    inventoryItemId: r.item,
    shopifyLocationId: r.shopify_location_id,
    variantId: r.variant_id,
    scopeId: r.scope_id,
    target: Math.min(MAX_PUSHED, Math.max(0, Number(r.target))),
  }));
}

export interface AffectedLevel {
  connectionId: string;
  inventoryItemId: string;
  shopifyLocationId: string;
}

/**
 * The mapped levels a stock change touches: the items mapped to the changed variant (itself, its
 * sales packs, and every bundle that uses it), at the Shopify locations whose scope holds a
 * changed location. Shops without an active connection cost one query.
 */
export async function affectedLevels(
  tx: Tx,
  change: { variantId: string | null; locationIds: string[]; positionIds: string[] },
): Promise<AffectedLevel[]> {
  const rows = await tx.query<{
    connection_id: string;
    item: string;
    shopify_location_id: string;
  }>(
    `with changed as (
       select $1::uuid as variant_id, l as location_id from unnest($2::uuid[]) l where $1::uuid is not null
       union
       select p.variant_id, p.location_id from inventory_positions p where p.id = any($3::uuid[])),
     cl as (
       select c.variant_id, loc.path_ids from changed c
       join locations loc on loc.shop_id = app_shop_id() and loc.id = c.location_id),
     mv as (
       select m.connection_id, m.shopify_inventory_item_id as item, m.variant_id as stock_variant_id
       from shopify_variant_maps m where m.variant_id in (select variant_id from cl)
       union
       select m.connection_id, m.shopify_inventory_item_id, c.variant_id
       from bundle_components c
       join bundle_versions bv on bv.shop_id = c.shop_id and bv.id = c.bundle_version_id
       join bundles b on b.shop_id = bv.shop_id and b.id = bv.bundle_id and b.version = bv.version
         and b.active
       join shopify_variant_maps m on m.shop_id = b.shop_id and m.variant_id = b.variant_id
       where c.variant_id in (select variant_id from cl))
     select distinct mv.connection_id, mv.item, lm.shopify_location_id
     from cl
     join mv on mv.stock_variant_id = cl.variant_id
     join shopify_location_maps lm on lm.shop_id = app_shop_id() and lm.connection_id = mv.connection_id
       and lm.scope_id = any(cl.path_ids)
     join shopify_connections sc on sc.shop_id = lm.shop_id and sc.id = lm.connection_id
       and sc.status = 'active'
     order by 1, 2, 3`,
    [change.variantId, change.locationIds, change.positionIds],
  );
  return rows.map((r) => ({
    connectionId: r.connection_id,
    inventoryItemId: r.item,
    shopifyLocationId: r.shopify_location_id,
  }));
}

/** How one Shopify variant sells: base units of a variant per item, or a bundle. */
export interface SalesMap {
  shopifyVariantId: string;
  inventoryItemId: string;
  variantId: string;
  packId: string | null;
  /** Base units reserved per Shopify item: the pack's base quantity, or 1. Bundles: 1 bundle. */
  perItem: string;
  bundle: boolean;
}

export async function salesMaps(
  tx: Tx,
  connectionId: string,
  shopifyVariantIds: string[],
): Promise<Map<string, SalesMap>> {
  const rows = await tx.query<{
    shopify_variant_id: string;
    shopify_inventory_item_id: string;
    variant_id: string;
    pack_id: string | null;
    per_item: string;
    bundle: boolean;
  }>(
    `select m.shopify_variant_id, m.shopify_inventory_item_id, m.variant_id, m.pack_id,
       coalesce(pk.base_quantity, 1)::text as per_item,
       exists (select 1 from bundles b where b.shop_id = m.shop_id and b.variant_id = m.variant_id
         and b.active) as bundle
     from shopify_variant_maps m
     left join packs pk on pk.shop_id = m.shop_id and pk.id = m.pack_id
     where m.connection_id = $1 and m.shopify_variant_id = any($2::text[])`,
    [connectionId, shopifyVariantIds],
  );
  return new Map(
    rows.map((r) => [
      r.shopify_variant_id,
      {
        shopifyVariantId: r.shopify_variant_id,
        inventoryItemId: r.shopify_inventory_item_id,
        variantId: r.variant_id,
        packId: r.pack_id,
        perItem: r.per_item,
        bundle: r.bundle,
      },
    ]),
  );
}
