import {
  airstockValues,
  execute,
  LISTING_FIELDS,
  type ListingField,
  type Owners,
  objectKey,
  ops,
  type StorefrontValues,
  sameValue,
  shopifyValues,
  skuKey,
  textToHtml,
} from '@airstock/core';
import { type ListingInput, ShopifyApiError } from './admin.ts';
import { type ConnectedStore, connectedStore, NotConnectedError, type SyncDeps } from './sync.ts';

// Listings in both directions (plan Section 5.14, D21, ADR 0038): publishing a product created in
// Airstock to Shopify, pushing the fields Airstock owns, and picking up products created or
// changed in Shopify.

/** Binary reads of media originals in R2 (2,048 px, D19) for picture uploads. */
export interface MediaReader {
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
}

export const PRODUCT_JOB = 'shopify.product_sync';

/** A decimal without trailing zeros, as Shopify shows prices ("49.90" → "49.9"). */
function decimalText(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

interface ListingRow {
  shopify_product_id: string | null;
  origin: 'airstock' | 'shopify';
  owners: Owners;
  desired_status: 'draft' | 'active' | 'archived';
  airstock_values: StorefrontValues | null;
  shopify_values: StorefrontValues | null;
  pictures: Record<string, string>;
  archive_sold: boolean;
}

interface ProductDetail {
  listing: ListingRow;
  values: StorefrontValues & { productStatus: string };
  options: Array<{ name: string; values: string[] }>;
  variants: Array<{
    variantId: string;
    sku: string;
    price: string | null;
    barcode: string | null;
    optionValues: Array<{ optionName: string; name: string }>;
  }>;
  pictures: Array<{ mediaId: string; fileName: string; contentType: string; alt: string | null }>;
  shopifyLocations: string[];
  /** Shopify variant IDs of mapped variants, by SKU key. */
  mapped: Map<string, string>;
}

async function readDetail(
  deps: SyncDeps,
  shopId: string,
  connectionId: string,
  productId: string,
): Promise<ProductDetail | null> {
  return deps.db.transaction({ shopId, userId: null, readOnly: true }, async (tx) => {
    const [listing] = await tx.query<ListingRow>(
      `select l.shopify_product_id, l.origin, l.owners, l.desired_status, l.airstock_values,
         l.shopify_values, l.pictures, c.archive_sold_listings as archive_sold
       from shopify_listings l join shopify_connections c on c.shop_id = l.shop_id and c.id = l.connection_id
       where l.connection_id = $1 and l.product_id = $2`,
      [connectionId, productId],
    );
    if (!listing) return null;
    const [p] = await tx.query<{ status: string }>('select status from products where id = $1', [
      productId,
    ]);
    // A sold one-of-a-kind item: its quantity is zero either way; the setting also archives it.
    const status =
      p?.status === 'sold' && listing.archive_sold ? 'archived' : listing.desired_status;
    const values = await airstockValues(tx, productId, status);
    const options = await tx.query<{ id: string; name: string; values: string[] }>(
      `select o.id, o.name, coalesce(array_agg(v.label order by v.position) filter (where v.id is not null), '{}') as values
       from product_options o left join product_option_values v on v.shop_id = o.shop_id and v.option_id = o.id
       where o.product_id = $1 group by o.id, o.name, o.position order by o.position`,
      [productId],
    );
    const variants = await tx.query<{
      id: string;
      sku: string;
      price: string | null;
      barcode: string | null;
      option_values: Array<{ option: string; label: string }> | null;
    }>(
      `select v.id, v.sku, v.price::text,
         (select b.code from barcodes b where b.shop_id = v.shop_id and b.variant_id = v.id
            and b.pack_id is null order by b.position, b.id limit 1) as barcode,
         (select json_agg(json_build_object('option', o.name, 'label', ov.label) order by o.position)
            from product_option_values ov join product_options o on o.shop_id = ov.shop_id and o.id = ov.option_id
            where ov.id = any(v.option_value_ids)) as option_values
       from variants v where v.product_id = $1 and v.status = 'active'
       order by v.is_default desc, v.sku`,
      [productId],
    );
    const pictures = await tx.query<{
      media_id: string;
      file_name: string;
      content_type: string;
      alt: string | null;
    }>(
      `select l.media_id, m.file_name, m.content_type, l.alt_text as alt
       from media_links l join media_assets m on m.shop_id = l.shop_id and m.id = l.media_id
       where l.product_id = $1 and l.variant_id is null and m.kind = 'image' and m.status = 'active'
         and m.external_url is null
       order by l.is_primary desc, l.position, l.id`,
      [productId],
    );
    const locations = await tx.query<{ shopify_location_id: string }>(
      'select shopify_location_id from shopify_location_maps where connection_id = $1 order by position',
      [connectionId],
    );
    const maps = await tx.query<{ sku: string; shopify_variant_id: string }>(
      `select v.sku, m.shopify_variant_id from shopify_variant_maps m
       join variants v on v.shop_id = m.shop_id and v.id = m.variant_id
       where m.connection_id = $1 and v.product_id = $2 and m.pack_id is null`,
      [connectionId, productId],
    );
    return {
      listing,
      values,
      options: options.map((o) => ({ name: o.name, values: o.values })),
      variants: variants.map((v) => ({
        variantId: v.id,
        sku: v.sku,
        price: v.price,
        barcode: v.barcode,
        optionValues: (v.option_values ?? []).map((x) => ({ optionName: x.option, name: x.label })),
      })),
      pictures: pictures.map((p) => ({
        mediaId: p.media_id,
        fileName: p.file_name,
        contentType: p.content_type,
        alt: p.alt,
      })),
      shopifyLocations: locations.map((l) => l.shopify_location_id),
      mapped: new Map(maps.map((m) => [skuKey(m.sku), m.shopify_variant_id])),
    };
  });
}

const SHOPIFY_STATUS = { draft: 'DRAFT', active: 'ACTIVE', archived: 'ARCHIVED' } as const;

/** Uploads pictures not in Shopify yet; returns staged URLs by media ID. */
async function stagePictures(
  deps: SyncDeps,
  store: ConnectedStore,
  pictures: ProductDetail['pictures'],
): Promise<Array<{ mediaId: string; source: string; alt: string | null }>> {
  const out: Array<{ mediaId: string; source: string; alt: string | null }> = [];
  if (!deps.originals) return out;
  for (const p of pictures) {
    const original = await deps.originals.get(objectKey(store.shopId, p.mediaId, 'original'));
    if (!original) {
      deps.logger?.error('shopify_picture_missing', { mediaId: p.mediaId });
      continue;
    }
    const source = await store.admin.stagePicture({
      filename: p.fileName,
      mimeType: original.contentType || p.contentType,
      bytes: original.bytes,
    });
    out.push({ mediaId: p.mediaId, source, alt: p.alt });
  }
  return out;
}

export type PublishOutcome = 'created' | 'adopted' | 'updated' | 'unchanged' | 'failed' | 'missing';

/**
 * Publishes a listing: creates the product in Shopify (or adopts one a crashed attempt already
 * made, found by SKU), or pushes the storefront fields Airstock owns that changed since the last
 * sync. A change to a field Shopify owns is recorded as a difference instead. `fields` forces
 * Airstock's value of those fields (a person chose "push Airstock's").
 */
export async function publishListing(
  deps: SyncDeps,
  shopId: string,
  connectionId: string,
  productId: string,
  opts: { fields?: ListingField[] } = {},
): Promise<PublishOutcome> {
  const detail = await readDetail(deps, shopId, connectionId, productId);
  if (!detail) return 'missing';
  const store = await connectedStore(deps, shopId, connectionId);
  const caller = store.caller;
  const record = (input: Record<string, unknown>) =>
    execute(deps, ops.recordShopifyListing, {
      caller,
      shopId,
      input: { connectionId, productId, ...input },
    });
  const { listing, values } = detail;
  const { productStatus: _, ...airstock } = values;
  try {
    if (!listing.shopify_product_id) {
      const skus = detail.variants.map((v) => v.sku);
      const existing = await store.admin.variantsBySku(skus);
      let shopifyProductId: string;
      let variants: Array<{ variantId: string; inventoryItemId: string; sku: string | null }>;
      let pictures: Record<string, string> = {};
      let outcome: PublishOutcome;
      if (existing.length > 0) {
        // Shopify already has these SKUs (an earlier attempt created the product): adopt it.
        shopifyProductId = existing[0]!.productId;
        variants = existing.filter((v) => v.productId === shopifyProductId);
        pictures = Object.fromEntries(detail.pictures.map((p) => [p.mediaId, 'adopted']));
        outcome = 'adopted';
      } else {
        const staged = await stagePictures(deps, store, detail.pictures);
        const options =
          detail.options.length > 0
            ? detail.options
            : [{ name: 'Title', values: ['Default Title'] }];
        const input: ListingInput = {
          title: airstock.title,
          descriptionHtml: textToHtml(airstock.description),
          status: SHOPIFY_STATUS[airstock.status],
          options,
          variants: detail.variants.map((v) => ({
            sku: v.sku,
            barcode: v.barcode,
            price: v.price === null ? null : decimalText(v.price),
            optionValues:
              detail.options.length > 0
                ? v.optionValues
                : [{ optionName: 'Title', name: 'Default Title' }],
            locationIds: detail.shopifyLocations,
          })),
          files: staged.map((s) => ({ originalSource: s.source, alt: s.alt })),
        };
        const made = await store.admin.createProduct(input);
        shopifyProductId = made.productId;
        variants = made.variants;
        pictures = Object.fromEntries(staged.map((s) => [s.mediaId, s.source]));
        outcome = 'created';
      }
      const read = await store.admin.product(shopifyProductId);
      const bySku = new Map(detail.variants.map((v) => [skuKey(v.sku), v.variantId]));
      await record({
        shopifyProductId,
        variants: variants.flatMap((v) => {
          const id = v.sku ? bySku.get(skuKey(v.sku)) : undefined;
          return id
            ? [
                {
                  variantId: id,
                  shopifyVariantId: v.variantId,
                  shopifyInventoryItemId: v.inventoryItemId,
                },
              ]
            : [];
        }),
        pictures,
        airstockValues: airstock,
        shopifyValues: read ? shopifyValues(read) : undefined,
      });
      return outcome;
    }

    // An existing listing: push what changed here, on the fields Airstock owns.
    const before = (listing.airstock_values ?? {}) as Partial<StorefrontValues>;
    const forced = new Set(opts.fields ?? []);
    const push = new Set<ListingField>();
    const differences: Array<{ field: ListingField; airstock: unknown; shopify: unknown }> = [];
    const nextAirstock: Record<string, unknown> = { ...before };
    for (const field of LISTING_FIELDS) {
      const changed = !sameValue(field, before[field], airstock[field]);
      if (forced.has(field) || (changed && listing.owners[field] === 'airstock')) {
        push.add(field);
        nextAirstock[field] = airstock[field];
      } else if (changed) {
        // Airstock changed a field Shopify owns: shown, not pushed.
        differences.push({
          field,
          airstock: airstock[field],
          shopify: listing.shopify_values?.[field] ?? null,
        });
      }
    }
    if (push.size === 0 && differences.length === 0) return 'unchanged';
    const id = listing.shopify_product_id;
    let pictures: Record<string, string> = {};
    if (
      push.has('title') ||
      push.has('description') ||
      push.has('status') ||
      push.has('pictures')
    ) {
      const fresh = push.has('pictures')
        ? detail.pictures.filter((p) => !listing.pictures[p.mediaId])
        : [];
      const staged = await stagePictures(deps, store, fresh);
      pictures = Object.fromEntries(staged.map((s) => [s.mediaId, s.source]));
      await store.admin.updateProduct({
        productId: id,
        ...(push.has('title') ? { title: airstock.title } : {}),
        ...(push.has('description') ? { descriptionHtml: textToHtml(airstock.description) } : {}),
        ...(push.has('status') ? { status: SHOPIFY_STATUS[airstock.status] } : {}),
        media: staged.map((s) => ({ originalSource: s.source, alt: s.alt })),
      });
    }
    if (push.has('prices')) {
      const prices = Object.entries(airstock.prices).flatMap(([sku, price]) => {
        const variantId = detail.mapped.get(sku);
        return variantId ? [{ variantId, price }] : [];
      });
      await store.admin.updateVariantPrices(id, prices);
    }
    const read = push.size > 0 ? await store.admin.product(id) : null;
    await record({
      pictures,
      airstockValues: nextAirstock,
      shopifyValues: read ? shopifyValues(read) : undefined,
      differences,
    });
    return push.size > 0 ? 'updated' : 'unchanged';
  } catch (error) {
    if (error instanceof NotConnectedError) throw error;
    if (error instanceof ShopifyApiError && error.retryable) throw error;
    const message = String((error as Error).message ?? error).slice(0, 1000);
    deps.logger?.error('shopify_listing_failed', { productId, error: message });
    await record({ error: message });
    return 'failed';
  }
}

/** Applies a product created or changed in Shopify (products/create, products/update). */
export async function syncProductFromShopify(
  deps: SyncDeps,
  shopId: string,
  connectionId: string,
  shopifyProductId: string,
): Promise<string> {
  const store = await connectedStore(deps, shopId, connectionId);
  const product = await store.admin.product(shopifyProductId);
  if (!product) return 'deleted';
  const done = await execute(deps, ops.syncShopifyProduct, {
    caller: store.caller,
    shopId,
    input: { connectionId, product },
  });
  return (done.result as { outcome: string }).outcome;
}

/**
 * Listings the reconciler publishes: pending or failed ones (a few attempts), and those whose
 * product, variants, or pictures changed since the last sync, or a sold one-of-a-kind item to
 * archive.
 */
export async function listingsDue(
  deps: SyncDeps,
  shopId: string,
  connectionId: string,
  limit = 50,
): Promise<string[]> {
  const rows = await deps.db.transaction({ shopId, userId: null, readOnly: true }, (tx) =>
    tx.query<{ product_id: string }>(
      `select l.product_id from shopify_listings l
       join products p on p.shop_id = l.shop_id and p.id = l.product_id
       join shopify_connections c on c.shop_id = l.shop_id and c.id = l.connection_id
       where l.connection_id = $1 and (
         l.state = 'pending' or (l.state = 'failed' and l.attempts < 5)
         or p.updated_at > coalesce(l.synced_at, '-infinity')
         or exists (select 1 from variants v where v.shop_id = p.shop_id and v.product_id = p.id
           and v.updated_at > coalesce(l.synced_at, '-infinity'))
         or exists (select 1 from media_links m where m.shop_id = p.shop_id and m.product_id = p.id
           and m.updated_at > coalesce(l.synced_at, '-infinity'))
         or (p.status = 'sold' and c.archive_sold_listings
           and coalesce(l.airstock_values->>'status', '') <> 'archived'))
       order by l.updated_at limit $2`,
      [connectionId, limit],
    ),
  );
  return rows.map((r) => r.product_id);
}
