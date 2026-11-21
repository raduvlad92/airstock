import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { normalizeBarcode } from '../catalog/barcodes.ts';
import { errors } from '../errors.ts';
import type { HandlerContext } from '../registry.ts';
import { defineOperation } from '../registry.ts';
import { Id, normalizeSku } from '../schemas.ts';
import {
  airstockValues,
  LISTING_FIELDS,
  type ListingField,
  type Owners,
  ownedBy,
  SHOPIFY_LISTING_TOPIC,
  ShopifyProductState,
  type StorefrontValues,
  sameValue,
  shopifyValues,
  skuKey,
} from '../shopify/listing.ts';
import { createItem, updateItem } from './catalog-items.ts';
import { adjustStock } from './inventory-adjustments.ts';
import { applyVariantMaps } from './shopify-mapping.ts';
import { type Acc, inner } from './shopify-orders.ts';
import { SYNC_TOOL } from './shopify-sync.ts';

// Listings in both directions (plan Section 5.14, D21, ADR 0038). Calls to Shopify live in
// packages/shopify (listings.ts); these operations keep the listing, its owners, and the
// differences, in the database.

const newAcc = (): Acc => ({
  levels: new Set(),
  took: [],
  outbox: [],
  events: [],
  webhooks: [],
  alertVariants: [],
});

interface ListingRow {
  product_id: string;
  shopify_product_id: string | null;
  origin: 'airstock' | 'shopify';
  owners: Owners;
  desired_status: 'draft' | 'active' | 'archived';
  state: string;
  airstock_values: StorefrontValues | null;
  shopify_values: StorefrontValues | null;
  pictures: Record<string, string>;
}

const LISTING_COLUMNS = `product_id, shopify_product_id, origin, owners, desired_status, state,
  airstock_values, shopify_values, pictures`;

async function activeConnection(tx: Tx, connectionId: string | undefined): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    `select id from shopify_connections where status = 'active' and ($1::uuid is null or id = $1)
     order by created_at for key share`,
    [connectionId ?? null],
  );
  if (rows.length === 0) throw errors.notFound('Connected Shopify store');
  if (rows.length > 1) {
    throw errors.unprocessable('connection_required', 'Several stores are connected: name one.');
  }
  return rows[0]!.id;
}

/** Applies Shopify's value of a field to the Airstock product (Shopify owns it, or a person chose). */
async function applyToAirstock(
  ctx: HandlerContext,
  acc: Acc,
  productId: string,
  field: ListingField,
  shopify: StorefrontValues,
): Promise<void> {
  if (field === 'title' || field === 'description') {
    const [p] = await ctx.tx.query<{ name: string; description: string | null }>(
      'select name, description from products where id = $1',
      [productId],
    );
    const key = field === 'title' ? 'name' : 'description';
    const current = field === 'title' ? p!.name : p!.description;
    const value = field === 'title' ? shopify.title : shopify.description || null;
    if ((current ?? null) === value) return;
    await inner(ctx, acc, updateItem, {
      productId,
      changes: [{ field: key, expected: current ?? null, value }],
    });
  } else if (field === 'prices') {
    const variants = await ctx.tx.query<{ id: string; sku: string; price: string | null }>(
      `select id, sku, price::text from variants where product_id = $1 and status = 'active'`,
      [productId],
    );
    const changes = variants.flatMap((v) => {
      const price = (shopify.prices as Record<string, string>)[skuKey(v.sku)];
      if (!price || (v.price !== null && Number(v.price) === Number(price))) return [];
      return [{ variantId: v.id, field: 'price', expected: v.price, value: price }];
    });
    if (changes.length > 0) await inner(ctx, acc, updateItem, { productId, changes });
  } else if (field === 'status') {
    // The listing's status in Shopify; the Airstock product keeps its own.
    await ctx.tx.query(
      `update shopify_listings set desired_status = $2, updated_at = now() where product_id = $1`,
      [productId, shopify.status],
    );
  } else {
    throw errors.unprocessable(
      'pictures_one_way',
      'Pictures go from Airstock to Shopify only: add them here, then push Airstock’s.',
    );
  }
}

export const createShopifyListing = defineOperation({
  id: 'shopify.listings.create',
  summary: 'List a product on Shopify',
  description:
    'Use this when someone wants a product they created in Airstock to appear in their Shopify store: creates it in Shopify as a draft (the default) or active product, with its options, variants, SKUs, barcodes, prices, description, and pictures, then keeps Shopify’s availability in step. Airstock owns those fields: later changes here are pushed; changes made in Shopify show as differences in sync health. Listing it again changes its status. Not for products created in Shopify (they are picked up automatically).',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    productId: Id,
    connectionId: Id.optional().describe('The store; can be left out when only one is connected.'),
    status: z.enum(['draft', 'active']).default('draft'),
  }),
  output: z.object({
    connectionId: Id,
    productId: Id,
    status: z.enum(['draft', 'active']),
    state: z.enum(['pending', 'published', 'failed']),
  }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'shopify.listing.requested' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/products/{productId}/shopify-listing' },
  mcp: { tool: SYNC_TOOL, action: 'list_product', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const connectionId = await activeConnection(ctx.tx, input.connectionId);
    const [product] = await ctx.tx.query<{ status: string }>(
      'select status from products where id = $1 for key share',
      [input.productId],
    );
    if (!product) throw errors.notFound('Product');
    if (product.status === 'archived') {
      throw errors.unprocessable('product_archived', 'An archived product cannot be listed.');
    }
    const [existing] = await ctx.tx.query<ListingRow>(
      `select ${LISTING_COLUMNS} from shopify_listings
       where connection_id = $1 and product_id = $2 for update`,
      [connectionId, input.productId],
    );
    if (existing?.origin === 'shopify') {
      throw errors.conflict(
        'listed_from_shopify',
        'This product came from Shopify, which owns its listing; change it there.',
      );
    }
    if (existing) {
      await ctx.tx.query(
        `update shopify_listings set desired_status = $3, state = case when state = 'failed'
           then 'pending' else state end, updated_at = now()
         where connection_id = $1 and product_id = $2`,
        [connectionId, input.productId, input.status],
      );
    } else {
      await ctx.tx.query(
        `insert into shopify_listings (shop_id, connection_id, product_id, origin, owners,
           desired_status)
         values (app_shop_id(), $1, $2, 'airstock', $3, $4)`,
        [connectionId, input.productId, JSON.stringify(ownedBy('airstock')), input.status],
      );
    }
    return {
      result: {
        connectionId,
        productId: input.productId,
        status: input.status,
        state: (existing?.state ?? 'pending') as 'pending' | 'published' | 'failed',
      },
      audit: {
        targetType: 'product',
        targetId: input.productId,
        changes: { status: input.status, connectionId },
      },
      outbox: [
        { topic: SHOPIFY_LISTING_TOPIC, payload: { connectionId, productId: input.productId } },
      ],
    };
  },
});

export const recordShopifyListing = defineOperation({
  id: 'shopify.listings.published',
  summary: 'Record a listing published to Shopify',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    connectionId: Id,
    productId: Id,
    shopifyProductId: z
      .string()
      .regex(/^[0-9]+$/)
      .optional(),
    variants: z
      .array(
        z.object({
          variantId: Id,
          shopifyVariantId: z.string().regex(/^[0-9]+$/),
          shopifyInventoryItemId: z.string().regex(/^[0-9]+$/),
        }),
      )
      .max(250)
      .default([]),
    pictures: z.record(z.string(), z.string()).default({}),
    airstockValues: z.unknown().optional(),
    shopifyValues: z.unknown().optional(),
    /** Airstock edits to fields Shopify owns: shown, not pushed. */
    differences: z
      .array(
        z.object({ field: z.enum(LISTING_FIELDS), airstock: z.unknown(), shopify: z.unknown() }),
      )
      .default([]),
    error: z.string().max(1000).optional(),
  }),
  output: z.object({ state: z.enum(['pending', 'published', 'failed']), mapped: z.number() }),
  permission: 'integrations.sync',
  connectionScope: 'catalog:write',
  audit: { action: 'shopify.listing.published' },
  idempotency: 'none',
  http: {
    method: 'POST',
    path: '/shops/{shopId}/shopify/connections/{connectionId}/listings/{productId}/published',
  },
  mcp: { exception: 'Integration callback: runs only from the Shopify listing job.' },
  async handler(ctx, input) {
    if (input.error) {
      await ctx.tx.query(
        `update shopify_listings set state = 'failed', last_error = $3, attempts = attempts + 1,
           updated_at = now()
         where connection_id = $1 and product_id = $2`,
        [input.connectionId, input.productId, input.error],
      );
      return {
        result: { state: 'failed' as const, mapped: 0 },
        audit: {
          targetType: 'product',
          targetId: input.productId,
          reason: input.error,
          changes: { state: 'failed' },
        },
      };
    }
    await ctx.tx.query(
      `update shopify_listings set state = 'published', last_error = null, attempts = 0,
         shopify_product_id = coalesce($3, shopify_product_id),
         pictures = pictures || $4::jsonb,
         airstock_values = coalesce($5::jsonb, airstock_values),
         shopify_values = coalesce($6::jsonb, shopify_values),
         published_at = coalesce(published_at, now()), synced_at = now(), updated_at = now()
       where connection_id = $1 and product_id = $2`,
      [
        input.connectionId,
        input.productId,
        input.shopifyProductId ?? null,
        JSON.stringify(input.pictures),
        input.airstockValues === undefined ? null : JSON.stringify(input.airstockValues),
        input.shopifyValues === undefined ? null : JSON.stringify(input.shopifyValues),
      ],
    );
    for (const d of input.differences) {
      await ctx.tx.query(
        `insert into shopify_listing_differences (shop_id, connection_id, product_id, field, airstock,
           shopify, changed_by)
         values (app_shop_id(), $1, $2, $3, $4, $5, 'airstock')
         on conflict (shop_id, connection_id, product_id, field) do update set
           airstock = excluded.airstock, shopify = excluded.shopify, detected_at = now()`,
        [
          input.connectionId,
          input.productId,
          d.field,
          JSON.stringify(d.airstock ?? null),
          JSON.stringify(d.shopify ?? null),
        ],
      );
    }
    // New variants are mapped (a map change pushes their availability); existing maps stay.
    const fresh = await ctx.tx.query<{ shopify_variant_id: string }>(
      `select x.shopify_variant_id from unnest($2::text[]) as x(shopify_variant_id)
       where not exists (select 1 from shopify_variant_maps m where m.connection_id = $1
         and m.shopify_variant_id = x.shopify_variant_id)`,
      [input.connectionId, input.variants.map((v) => v.shopifyVariantId)],
    );
    const toMap = input.variants.filter((v) =>
      fresh.some((f) => f.shopify_variant_id === v.shopifyVariantId),
    );
    const done =
      toMap.length > 0
        ? await applyVariantMaps(
            ctx,
            input.connectionId,
            toMap.map((v) => ({
              shopifyVariantId: v.shopifyVariantId,
              shopifyInventoryItemId: v.shopifyInventoryItemId,
              shopifyProductId: input.shopifyProductId,
              variantId: v.variantId,
              source: 'listing' as const,
            })),
          )
        : { set: 0, items: [] as string[] };
    return {
      result: { state: 'published' as const, mapped: done.set },
      audit: {
        targetType: 'product',
        targetId: input.productId,
        externalRef: input.shopifyProductId ? `shopify:product/${input.shopifyProductId}` : null,
        changes: { mapped: done.set, differences: input.differences.map((d) => d.field) },
      },
      outbox:
        done.items.length > 0
          ? [
              {
                topic: 'shopify.levels.push',
                payload: { connectionId: input.connectionId, inventoryItemIds: done.items },
              },
            ]
          : [],
    };
  },
});

export const syncShopifyProduct = defineOperation({
  id: 'shopify.products.sync',
  summary: 'Apply a product created or changed in Shopify',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    connectionId: Id,
    product: ShopifyProductState,
    /**
     * Shopify's available for a new product's variant, keyed `item@location`, as read at
     * `availableAt`: brought in as opening stock when the product is created here.
     */
    available: z.record(z.string(), z.number().int()).optional(),
    availableAt: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), 'A timestamp.')
      .optional(),
  }),
  output: z.object({
    outcome: z.enum(['created', 'matched', 'updated', 'unchanged', 'unmatched', 'own_echo']),
    productId: Id.nullable(),
    mapped: z.number(),
    applied: z.array(z.string()),
    differences: z.array(z.string()),
  }),
  permission: 'integrations.sync',
  connectionScope: 'catalog:write',
  audit: { action: 'shopify.product.synced' },
  idempotency: 'none',
  http: {
    method: 'POST',
    path: '/shops/{shopId}/shopify/connections/{connectionId}/products/sync',
  },
  mcp: { exception: 'Integration callback: runs only for products the connector reads.' },
  async handler(ctx, input) {
    const { connectionId, product } = input;
    const acc = newAcc();
    const now = shopifyValues(product);
    const ref = `shopify:product/${product.productId}`;
    const out = {
      outcome: 'unchanged' as
        | 'created'
        | 'matched'
        | 'updated'
        | 'unchanged'
        | 'unmatched'
        | 'own_echo',
      productId: null as string | null,
      mapped: 0,
      applied: [] as string[],
      differences: [] as string[],
    };
    // Every Shopify variant is recorded, so unmapped ones show in sync health.
    for (const v of product.variants) {
      await ctx.tx.query(
        `insert into shopify_catalog_variants (shop_id, connection_id, shopify_variant_id,
           shopify_product_id, shopify_inventory_item_id, sku, barcode, title, tracked)
         values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (shop_id, connection_id, shopify_variant_id) do update set
           shopify_inventory_item_id = excluded.shopify_inventory_item_id, sku = excluded.sku,
           barcode = excluded.barcode, title = excluded.title, tracked = excluded.tracked,
           seen_at = now()`,
        [
          connectionId,
          v.variantId,
          product.productId,
          v.inventoryItemId,
          v.sku,
          v.barcode,
          `${product.title} / ${v.title}`.slice(0, 1000),
          v.tracked,
        ],
      );
    }
    let [listing] = await ctx.tx.query<ListingRow>(
      `select ${LISTING_COLUMNS} from shopify_listings
       where connection_id = $1 and shopify_product_id = $2 for update`,
      [connectionId, product.productId],
    );

    // Matches by SKU, then barcode, among Airstock's active variants.
    const matches = new Map<string, { variantId: string; productId: string }>();
    for (const v of product.variants) {
      const [bySku] = v.sku
        ? await ctx.tx.query<{ id: string; product_id: string }>(
            `select id, product_id from variants where sku_normalized = $1 and status = 'active'`,
            [normalizeSku(v.sku)],
          )
        : [];
      const [byBarcode] =
        !bySku && v.barcode
          ? await ctx.tx.query<{ id: string; product_id: string }>(
              `select v.id, v.product_id from barcodes b join variants v on v.shop_id = b.shop_id
                 and v.id = b.variant_id
               where b.code_normalized = $1 and b.pack_id is null and v.status = 'active' limit 1`,
              [normalizeBarcode(v.barcode)],
            )
          : [];
      const hit = bySku ?? byBarcode;
      if (hit) matches.set(v.variantId, { variantId: hit.id, productId: hit.product_id });
    }

    if (!listing) {
      const products = [...new Set([...matches.values()].map((m) => m.productId))];
      if (products.length === 1) {
        const productId = products[0]!;
        const [own] = await ctx.tx.query<ListingRow>(
          `select ${LISTING_COLUMNS} from shopify_listings
           where connection_id = $1 and product_id = $2 for update`,
          [connectionId, productId],
        );
        if (own && own.origin === 'airstock' && !own.shopify_product_id) {
          // Airstock is creating this product in Shopify right now: its own job records it.
          out.outcome = 'own_echo';
          out.productId = productId;
          return finish(out);
        }
        if (own) {
          // Already listed as another Shopify product: the variants stay unmapped (sync health).
          out.outcome = 'unmatched';
          return finish(out);
        }
        // An existing product: Shopify owns its listing, and where the two differ a person
        // decides (nothing is overwritten on the first match).
        const here = await airstockValues(ctx.tx, productId, now.status);
        const { productStatus: _, ...airstock } = here;
        await ctx.tx.query(
          `insert into shopify_listings (shop_id, connection_id, product_id, shopify_product_id,
             origin, owners, desired_status, state, airstock_values, shopify_values, published_at,
             synced_at)
           values (app_shop_id(), $1, $2, $3, 'shopify', $4, $5, 'published', $6, $7, now(), now())`,
          [
            connectionId,
            productId,
            product.productId,
            JSON.stringify(ownedBy('shopify')),
            now.status,
            JSON.stringify(airstock),
            JSON.stringify(now),
          ],
        );
        for (const field of ['title', 'description', 'prices'] as const) {
          if (!sameValue(field, airstock[field], now[field])) {
            await recordDifference(
              ctx.tx,
              connectionId,
              productId,
              field,
              airstock,
              now,
              'shopify',
            );
            out.differences.push(field);
          }
        }
        out.outcome = 'matched';
        out.productId = productId;
      } else if (products.length === 0 && product.variants.length === 1) {
        // New in Shopify, one variant: created here, Shopify owns its listing.
        const v = product.variants[0]!;
        const made = await inner(ctx, acc, createItem, {
          name: product.title.trim() || `Shopify product ${product.productId}`,
          sku: v.sku?.trim() || v.barcode?.trim() || `SHOPIFY-${v.variantId}`,
          ...(v.price ? { price: v.price } : {}),
          ...(v.barcode?.trim() ? { barcode: v.barcode.trim() } : {}),
          ...(now.description ? { description: now.description } : {}),
          status: 'active',
          acknowledgeSimilar: true,
        });
        const here = await airstockValues(ctx.tx, made.productId, now.status);
        const { productStatus: _, ...airstock } = here;
        await ctx.tx.query(
          `insert into shopify_listings (shop_id, connection_id, product_id, shopify_product_id,
             origin, owners, desired_status, state, airstock_values, shopify_values, published_at,
             synced_at)
           values (app_shop_id(), $1, $2, $3, 'shopify', $4, $5, 'published', $6, $7, now(), now())`,
          [
            connectionId,
            made.productId,
            product.productId,
            JSON.stringify(ownedBy('shopify')),
            now.status,
            JSON.stringify(airstock),
            JSON.stringify(now),
          ],
        );
        out.outcome = 'created';
        out.productId = made.productId;
        // Shopify's quantity comes in as opening stock (as with the onboarding import), so the
        // push that follows the map finds nothing to change instead of writing 0 over it (L1).
        if (v.inventoryItemId && v.tracked && input.available && input.availableAt) {
          const opened = await openingStock(ctx, acc, connectionId, made.variantId, {
            item: v.inventoryItemId,
            available: input.available,
            at: input.availableAt,
          });
          // Shopify holds units where Airstock cannot receive them: left unmapped for a person.
          if (opened) {
            matches.set(v.variantId, { variantId: made.variantId, productId: made.productId });
          }
        } else if (!v.tracked || !v.inventoryItemId) {
          matches.set(v.variantId, { variantId: made.variantId, productId: made.productId });
        }
      } else {
        // Several products match, or a new product with several variants: left unmapped in sync
        // health, for a person to map or import with the onboarding import.
        out.outcome = 'unmatched';
        return finish(out);
      }
      [listing] = await ctx.tx.query<ListingRow>(
        `select ${LISTING_COLUMNS} from shopify_listings
         where connection_id = $1 and shopify_product_id = $2 for update`,
        [connectionId, product.productId],
      );
    } else {
      out.productId = listing.product_id;
      // A change in Shopify: applied where Shopify owns the field, shown where Airstock does.
      const before = listing.shopify_values;
      const airstock = (listing.airstock_values ?? {}) as StorefrontValues;
      const nextAirstock = { ...airstock };
      for (const field of LISTING_FIELDS) {
        if (before && sameValue(field, before[field], now[field])) continue;
        if (!before) continue;
        if (listing.owners[field] === 'shopify') {
          if (field === 'pictures') continue;
          await applyToAirstock(ctx, acc, listing.product_id, field, now);
          (nextAirstock as unknown as Record<string, unknown>)[field] = now[field];
          out.applied.push(field);
        } else {
          await recordDifference(
            ctx.tx,
            connectionId,
            listing.product_id,
            field,
            airstock,
            now,
            'shopify',
          );
          out.differences.push(field);
        }
      }
      await ctx.tx.query(
        `update shopify_listings set shopify_values = $3, airstock_values = $4, synced_at = now(),
           updated_at = now()
         where connection_id = $1 and product_id = $2`,
        [connectionId, listing.product_id, JSON.stringify(now), JSON.stringify(nextAirstock)],
      );
      out.outcome = out.applied.length + out.differences.length > 0 ? 'updated' : 'unchanged';
    }

    // Variants matched by SKU or barcode are mapped, unless already mapped either way.
    const candidates = product.variants.flatMap((v) => {
      const m = matches.get(v.variantId);
      return m && v.inventoryItemId && m.productId === listing?.product_id && v.tracked
        ? [{ v, m }]
        : [];
    });
    if (candidates.length > 0) {
      const free = await ctx.tx.query<{ shopify_variant_id: string }>(
        `select x.id as shopify_variant_id from unnest($2::text[], $3::uuid[]) as x(id, variant_id)
         where not exists (select 1 from shopify_variant_maps m where m.connection_id = $1
             and m.shopify_variant_id = x.id)
           and not exists (select 1 from shopify_variant_maps m where m.connection_id = $1
             and m.variant_id = x.variant_id and m.pack_id is null)`,
        [connectionId, candidates.map((c) => c.v.variantId), candidates.map((c) => c.m.variantId)],
      );
      const toMap = candidates.filter((c) =>
        free.some((f) => f.shopify_variant_id === c.v.variantId),
      );
      if (toMap.length > 0) {
        const done = await applyVariantMaps(
          ctx,
          connectionId,
          toMap.map((c) => ({
            shopifyVariantId: c.v.variantId,
            shopifyInventoryItemId: c.v.inventoryItemId!,
            shopifyProductId: product.productId,
            sku: c.v.sku,
            title: c.v.title,
            variantId: c.m.variantId,
            source: (c.v.sku ? 'sku' : 'barcode') as 'sku' | 'barcode',
          })),
        );
        out.mapped = done.set;
        if (done.items.length > 0) {
          acc.outbox.push({
            topic: 'shopify.levels.push',
            payload: { connectionId, inventoryItemIds: done.items },
          });
        }
      }
    }
    return finish(out);

    function finish(result: typeof out) {
      return {
        result,
        audit: {
          targetType: result.productId ? 'product' : 'shopify_connection',
          targetId: result.productId ?? connectionId,
          externalRef: ref,
          outcome:
            result.outcome === 'unchanged' || result.outcome === 'own_echo'
              ? ('no_change' as const)
              : ('succeeded' as const),
          changes: result,
        },
        outbox: acc.outbox,
        events: acc.events,
        webhooks: acc.webhooks,
      };
    }
  },
});

/**
 * Receives Shopify's available of a new item at each mapped Shopify location (at its receiving
 * location, as a count correction) and records it as Airstock's record of Shopify, as of the
 * read. Returns false, and changes nothing, when a location with units has no receiving location.
 */
async function openingStock(
  ctx: HandlerContext,
  acc: Acc,
  connectionId: string,
  variantId: string,
  shopify: { item: string; available: Record<string, number>; at: string },
): Promise<boolean> {
  const maps = await ctx.tx.query<{
    shopify_location_id: string;
    receive_location_id: string | null;
  }>(
    `select shopify_location_id, receive_location_id from shopify_location_maps
     where connection_id = $1 order by position`,
    [connectionId],
  );
  const levels = maps.flatMap((m) => {
    const quantity = shopify.available[`${shopify.item}@${m.shopify_location_id}`];
    return quantity === undefined ? [] : [{ ...m, quantity }];
  });
  if (levels.some((l) => l.quantity > 0 && !l.receive_location_id)) return false;
  for (const l of levels) {
    if (l.quantity > 0) {
      await inner(ctx, acc, adjustStock, {
        locationId: l.receive_location_id,
        adjustmentReason: 'count_correction',
        adjustments: [{ variantId, direction: 'add', quantity: String(l.quantity) }],
        note: 'Opening stock: Shopify’s quantity when the product was created in Shopify.',
      });
    }
    await ctx.tx.query(
      `insert into shopify_inventory_levels (shop_id, connection_id, shopify_inventory_item_id,
         shopify_location_id, expected_available, expected_as_of)
       values (app_shop_id(), $1, $2, $3, $4, $5::timestamptz)
       on conflict (shop_id, connection_id, shopify_inventory_item_id, shopify_location_id)
       do update set expected_available = excluded.expected_available,
         expected_as_of = excluded.expected_as_of, updated_at = now()
       where shopify_inventory_levels.expected_available is null`,
      [connectionId, shopify.item, l.shopify_location_id, l.quantity, shopify.at],
    );
  }
  return true;
}

async function recordDifference(
  tx: Tx,
  connectionId: string,
  productId: string,
  field: ListingField,
  airstock: Partial<StorefrontValues>,
  shopify: Partial<StorefrontValues>,
  changedBy: 'shopify' | 'airstock',
): Promise<void> {
  await tx.query(
    `insert into shopify_listing_differences (shop_id, connection_id, product_id, field, airstock,
       shopify, changed_by)
     values (app_shop_id(), $1, $2, $3, $4, $5, $6)
     on conflict (shop_id, connection_id, product_id, field) do update set
       airstock = excluded.airstock, shopify = excluded.shopify, changed_by = excluded.changed_by,
       detected_at = now()`,
    [
      connectionId,
      productId,
      field,
      JSON.stringify(airstock[field] ?? null),
      JSON.stringify(shopify[field] ?? null),
      changedBy,
    ],
  );
}

export const resolveListingDifference = defineOperation({
  id: 'shopify.listing_differences.resolve',
  summary: 'Resolve a listing difference with Shopify',
  description:
    'Use this when a product’s storefront field (title, description, status, prices, pictures) differs between Airstock and Shopify because the side that does not own it changed it (a difference in sync health), and the person has decided which is right. choice "take_shopify" copies Shopify’s value into Airstock; "push_airstock" writes Airstock’s value to Shopify. Pictures can only be pushed. Ask the person before calling.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    connectionId: Id,
    productId: Id,
    field: z.enum(LISTING_FIELDS),
    choice: z.enum(['take_shopify', 'push_airstock']),
  }),
  output: z.object({
    field: z.enum(LISTING_FIELDS),
    choice: z.enum(['take_shopify', 'push_airstock']),
  }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'shopify.listing_difference.resolved' },
  idempotency: 'required',
  http: {
    method: 'POST',
    path: '/shops/{shopId}/shopify/connections/{connectionId}/listing-differences/resolve',
  },
  mcp: { tool: SYNC_TOOL, action: 'resolve_listing', readOnly: false, destructive: true },
  async handler(ctx, input) {
    const [listing] = await ctx.tx.query<ListingRow>(
      `select ${LISTING_COLUMNS} from shopify_listings
       where connection_id = $1 and product_id = $2 for update`,
      [input.connectionId, input.productId],
    );
    const [difference] = await ctx.tx.query<{ airstock: unknown; shopify: unknown }>(
      `delete from shopify_listing_differences
       where connection_id = $1 and product_id = $2 and field = $3 returning airstock, shopify`,
      [input.connectionId, input.productId, input.field],
    );
    if (!listing || !difference) {
      // A connection or product this shop does not have is not found, as on every route (A13).
      const [known] = await ctx.tx.query<{ connection: boolean; product: boolean }>(
        `select exists (select 1 from shopify_connections where id = $1) as connection,
           exists (select 1 from products where id = $2) as product`,
        [input.connectionId, input.productId],
      );
      if (!known?.connection) throw errors.notFound('Shopify connection');
      if (!known.product) throw errors.notFound('Product');
      throw errors.conflict('no_difference', 'There is no open difference for this field.');
    }
    const acc = newAcc();
    const shopify = { ...(listing.shopify_values ?? {}) } as StorefrontValues;
    const airstock = { ...(listing.airstock_values ?? {}) } as StorefrontValues;
    if (input.choice === 'take_shopify') {
      await applyToAirstock(ctx, acc, input.productId, input.field, shopify);
      (airstock as unknown as Record<string, unknown>)[input.field] = shopify[input.field];
      await ctx.tx.query(
        `update shopify_listings set airstock_values = $3, updated_at = now()
         where connection_id = $1 and product_id = $2`,
        [input.connectionId, input.productId, JSON.stringify(airstock)],
      );
    } else {
      // The publisher writes Airstock's value of this field, whoever owns it.
      acc.outbox.push({
        topic: SHOPIFY_LISTING_TOPIC,
        payload: {
          connectionId: input.connectionId,
          productId: input.productId,
          fields: [input.field],
        },
      });
    }
    return {
      result: { field: input.field, choice: input.choice },
      audit: {
        targetType: 'product',
        targetId: input.productId,
        changes: { field: input.field, choice: input.choice, ...difference },
      },
      outbox: acc.outbox,
      events: acc.events,
      webhooks: acc.webhooks,
    };
  },
});

export const shopifyListingOperations = [createShopifyListing, resolveListingDifference] as const;
export const shopifyListingCallbacks = [recordShopifyListing, syncShopifyProduct] as const;
