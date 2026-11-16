import { objectKey, uuidv7 } from '@airstock/core';
import { publishListing, reconcileConnection } from '@airstock/shopify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../../test/helpers.ts';
import type { FakeStore } from './fake-shopify.ts';
import { json } from './setup.ts';
import { type Merchant, type ShopifyHarness, shopifyHarness } from './shopify-harness.ts';

// I6, part 5: listings in both directions (plan Section 5.14, D21). Each case uses its own shop
// and store, and handles only its own outbox rows.

let h: ShopifyHarness;
beforeAll(async () => {
  h = await shopifyHarness();
});
afterAll(() => h.t.close());

interface Setup {
  m: Merchant;
  store: FakeStore;
  connectionId: string;
}

async function setup(name: string): Promise<Setup> {
  const m = await h.merchant(name);
  const store = h.newStore('list');
  const connectionId = await h.install(m, store);
  await h.command(m.cookie, `/shops/${m.shopId}/shopify/connections/${connectionId}/locations`, {
    connectionId,
    locations: [{ shopifyLocationId: '1001', locationId: m.locationId }],
  });
  await h.flushTogether(m.shopId);
  return { m, store, connectionId };
}

const sku = (prefix: string) => `${prefix}-${uuidv7().slice(-6).toUpperCase()}`;

/** A picture of the product, as an upload leaves it: a media record and its original in R2. */
async function addPicture(m: Merchant, productId: string) {
  const mediaId = uuidv7();
  await ownerQuery(
    `insert into media_upload_intents (shop_id, id, media_id, kind, file_name, content_type,
       size_bytes, sha256, status, created_by, expires_at, finalized_at)
     values ($1, $2, $3, 'image', 'front.jpg', 'image/jpeg', 4, $4, 'finalized', 'test',
       now() + interval '1 hour', now())`,
    [m.shopId, uuidv7(), mediaId, 'a'.repeat(64)],
  );
  await ownerQuery(
    `insert into media_assets (shop_id, id, kind, file_name, content_type, size_bytes, sha256, width,
       height, created_by)
     values ($1, $2, 'image', 'front.jpg', 'image/jpeg', 4, $3, 2048, 2048, 'test')`,
    [m.shopId, mediaId, 'a'.repeat(64)],
  );
  await ownerQuery(
    `insert into media_links (shop_id, id, media_id, product_id, role, position, is_primary)
     values ($1, $2, $3, $4, 'product', 0, true)`,
    [m.shopId, uuidv7(), mediaId, productId],
  );
  h.originals.set(objectKey(m.shopId, mediaId, 'original'), {
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    contentType: 'image/jpeg',
  });
  return mediaId;
}

/** Runs this shop's listing publish requests, as the jobs consumer would. */
const handled = new Set<string>();
async function publishRequested(s: Setup) {
  const rows = (
    await ownerQuery<{
      id: string;
      payload: { connectionId: string; productId: string; fields?: [] };
    }>(
      `select id, payload from outbox_events where shop_id = $1 and topic = 'shopify.listing.publish'
       order by created_at, id`,
      [s.m.shopId],
    )
  ).filter((r) => !handled.has(r.id));
  const out = [];
  for (const r of rows) {
    handled.add(r.id);
    out.push(
      await publishListing(h.deps(), s.m.shopId, r.payload.connectionId, r.payload.productId, {
        fields: r.payload.fields,
      }),
    );
  }
  return out;
}

async function listing(s: Setup, productId: string) {
  const [row] = await ownerQuery<{
    origin: string;
    state: string;
    shopify_product_id: string | null;
    desired_status: string;
  }>(
    `select origin, state, shopify_product_id, desired_status from shopify_listings
     where shop_id = $1 and product_id = $2`,
    [s.m.shopId, productId],
  );
  return row;
}

async function differences(s: Setup) {
  return ownerQuery<{ field: string; changed_by: string; shopify: unknown; airstock: unknown }>(
    `select field, changed_by, shopify, airstock from shopify_listing_differences
     where shop_id = $1 order by field`,
    [s.m.shopId],
  );
}

async function webhook(s: Setup, topic: string, productId: string) {
  const res = await h.deliver(s.store.domain, topic, s.store.productBody(productId));
  expect(res.status).toBe(200);
  return h.runJobs(s.m.shopId);
}

describe('listing Airstock products on Shopify', () => {
  it('lists a product with its variants, SKUs, barcodes, prices, description, and pictures', async () => {
    const s = await setup('Lister');
    const code = sku('ETB');
    const made = await h.item(s.m, 'Elite Trainer Box', code, {
      price: '49.90',
      barcode: '4006381333931',
      description: 'Sealed.\n\nEnglish edition.',
    });
    const options = await h.command(
      s.m.cookie,
      `/shops/${s.m.shopId}/products/${made.productId}/variants/generate`,
      {
        productId: made.productId,
        options: [{ name: 'Edition', values: ['English', 'German'] }],
        skuPattern: `${code}-{Edition}`,
        mode: 'create',
      },
    );
    expect(options.status, await options.clone().text()).toBe(200);
    const mediaId = await addPicture(s.m, made.productId);
    await h.receive(s.m, made.variantId, 3);

    const res = await h.command(
      s.m.cookie,
      `/shops/${s.m.shopId}/products/${made.productId}/shopify-listing`,
      { productId: made.productId, status: 'active' },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await json(res)).toMatchObject({ status: 'active', state: 'pending' });
    expect(await publishRequested(s)).toEqual(['created']);

    const [call] = s.store.productCalls;
    expect(call?.kind).toBe('create');
    const input = call!.input as {
      title: string;
      descriptionHtml: string;
      status: string;
      options: Array<{ name: string; values: string[] }>;
      variants: Array<{
        sku: string;
        barcode: string | null;
        price: string | null;
        locationIds: string[];
      }>;
      files: Array<{ originalSource: string }>;
    };
    expect(input).toMatchObject({
      title: 'Elite Trainer Box',
      descriptionHtml: '<p>Sealed.</p><p>English edition.</p>',
      status: 'ACTIVE',
      options: [{ name: 'Edition', values: ['English', 'German'] }],
    });
    expect(input.variants.map((v) => [v.price, v.locationIds])).toEqual([
      ['49.9', ['1001']],
      ['49.9', ['1001']],
    ]);
    expect(input.variants.some((v) => v.barcode === '4006381333931')).toBe(true);
    expect(input.files).toHaveLength(1);
    expect(s.store.staged.get(input.files[0]!.originalSource)).toEqual({
      filename: 'front.jpg',
      mimeType: 'image/jpeg',
      size: 4,
    });
    const row = await listing(s, made.productId);
    expect(row).toMatchObject({ origin: 'airstock', state: 'published', desired_status: 'active' });
    const maps = await ownerQuery<{ source: string }>(
      'select source from shopify_variant_maps where shop_id = $1',
      [s.m.shopId],
    );
    expect(maps.map((x) => x.source)).toEqual(['listing', 'listing']);
    // Shopify then shows Airstock's availability.
    await h.flushTogether(s.m.shopId);
    const shopifyVariant = s.store.variants.find(
      (v) => v.sku === code || v.sku === `${code}-English`,
    )!;
    expect(s.store.available(shopifyVariant)).toBe(3);
    // Shopify's own products/create for the new product changes nothing.
    expect(await webhook(s, 'products/create', row!.shopify_product_id!)).toEqual([
      { status: 'done' },
    ]);
    expect(await differences(s)).toEqual([]);
    const [pictures] = await ownerQuery<{ pictures: Record<string, string> }>(
      'select pictures from shopify_listings where shop_id = $1',
      [s.m.shopId],
    );
    expect(Object.keys(pictures!.pictures)).toEqual([mediaId]);
  });

  it('pushes Airstock’s changes; a Shopify edit to an Airstock-owned field is a difference', async () => {
    const s = await setup('Owner');
    const code = sku('BOX');
    const made = await h.item(s.m, 'Booster box', code, { price: '120.00' });
    await h.command(s.m.cookie, `/shops/${s.m.shopId}/products/${made.productId}/shopify-listing`, {
      productId: made.productId,
    });
    await publishRequested(s);
    const shopifyId = (await listing(s, made.productId))!.shopify_product_id!;

    // Someone renames it in Shopify: shown, not applied.
    s.store.editProduct(shopifyId, { title: 'Booster box (Shopify)' });
    await webhook(s, 'products/update', shopifyId);
    expect(await differences(s)).toEqual([
      {
        field: 'title',
        changed_by: 'shopify',
        shopify: 'Booster box (Shopify)',
        airstock: 'Booster box',
      },
    ]);
    const [name] = await ownerQuery<{ name: string }>('select name from products where id = $1', [
      made.productId,
    ]);
    expect(name?.name).toBe('Booster box');

    // A price changed here is pushed by the reconciler's listing pass.
    const change = await h.command(
      s.m.cookie,
      `/shops/${s.m.shopId}/items/${made.productId}/changes`,
      {
        productId: made.productId,
        changes: [{ variantId: made.variantId, field: 'price', expected: '120', value: '110.00' }],
      },
    );
    expect(change.status, await change.clone().text()).toBe(200);
    const result = await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, {
      daily: false,
    });
    expect(result.listingsPublished).toBe(1);
    expect(s.store.productCalls.at(-1)).toMatchObject({ kind: 'prices' });
    expect((await s.store.product(shopifyId))?.variants[0]?.price).toBe('110');

    // The person keeps Airstock's title: it is pushed back.
    const resolve = await h.command(
      s.m.cookie,
      `/shops/${s.m.shopId}/shopify/connections/${s.connectionId}/listing-differences/resolve`,
      {
        connectionId: s.connectionId,
        productId: made.productId,
        field: 'title',
        choice: 'push_airstock',
      },
    );
    expect(resolve.status, await resolve.clone().text()).toBe(200);
    expect(await publishRequested(s)).toEqual(['updated']);
    expect((await s.store.product(shopifyId))?.title).toBe('Booster box');
    expect(await differences(s)).toEqual([]);
  });

  it('a sold one-of-a-kind item drops to zero, and the setting archives its listing', async () => {
    const s = await setup('Single card');
    const made = await h.item(s.m, 'Charizard PSA 10', sku('PSA'), { price: '900.00' });
    await ownerQuery('update variants set one_of_a_kind = true where id = $1', [made.variantId]);
    await h.receive(s.m, made.variantId, 1);
    await ownerQuery('update shopify_connections set archive_sold_listings = true where id = $1', [
      s.connectionId,
    ]);
    await h.command(s.m.cookie, `/shops/${s.m.shopId}/products/${made.productId}/shopify-listing`, {
      productId: made.productId,
      status: 'active',
    });
    await publishRequested(s);
    await h.flushTogether(s.m.shopId);
    const variant = s.store.variants.find((v) => v.sku.startsWith('PSA-'))!;
    expect(s.store.available(variant)).toBe(1);
    const order = s.store.placeOrder([{ variant, quantity: 1 }]);
    await h.deliver(s.store.domain, 'orders/create', s.store.webhookBody(order));
    await h.runJobs(s.m.shopId);
    const f = s.store.fulfill(order);
    await h.deliver(
      s.store.domain,
      'fulfillments/create',
      s.store.topicBody('fulfillments/create', order, f.fulfillmentId),
    );
    await h.runJobs(s.m.shopId);
    await h.flushTogether(s.m.shopId);
    expect(s.store.available(variant)).toBe(0);
    await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, { daily: false });
    const shopifyId = (await listing(s, made.productId))!.shopify_product_id!;
    expect((await s.store.product(shopifyId))?.status).toBe('ARCHIVED');
  });
});

describe('picking up products created in Shopify', () => {
  it('matches by SKU or barcode, maps, and pushes Airstock’s availability', async () => {
    const s = await setup('Picker');
    const code = sku('SET');
    const bySku = await h.item(s.m, 'LEGO set 10300', code, { price: '199.99' });
    const byBarcode = await h.item(s.m, 'Lion Knights castle', sku('CASTLE'), {
      barcode: '5702017152776',
    });
    await h.receive(s.m, bySku.variantId, 2);
    await h.receive(s.m, byBarcode.variantId, 4);
    const [a] = s.store.addProduct({
      title: 'LEGO 10300',
      variants: [{ sku: code, price: '199.99', quantities: { '1001': 7 } }],
    });
    const [b] = s.store.addProduct({
      title: 'LEGO Lion Knights Castle',
      variants: [{ sku: null, barcode: '5702017152776', quantities: { '1001': 1 } }],
    });
    const productOf = (variantId: string) =>
      s.store.products.find((p) => p.variants.some((v) => v.variant.variantId === variantId))!
        .productId;
    await webhook(s, 'products/create', productOf(a!.variantId));
    await webhook(s, 'products/create', productOf(b!.variantId));
    const maps = await ownerQuery<{ variant_id: string; source: string }>(
      'select variant_id, source from shopify_variant_maps where shop_id = $1 order by source',
      [s.m.shopId],
    );
    expect(maps).toEqual([
      { variant_id: byBarcode.variantId, source: 'barcode' },
      { variant_id: bySku.variantId, source: 'sku' },
    ]);
    expect(await listing(s, bySku.productId)).toMatchObject({ origin: 'shopify' });
    // The title differs on the first match: shown for a person to choose, nothing overwritten.
    expect((await differences(s)).map((d) => d.field)).toEqual(['title', 'title']);
    await h.flushTogether(s.m.shopId);
    expect(s.store.available(a!)).toBe(2);
    expect(s.store.available(b!)).toBe(4);
  });

  it('creates a new single-variant product, then follows Shopify’s edits to the fields it owns', async () => {
    const s = await setup('Creator');
    const code = sku('NEW');
    const [v] = s.store.addProduct({
      title: 'Pikachu promo',
      description: '<p>Promo card.</p>',
      variants: [
        { sku: code, price: '12.50', barcode: '0820650850103', quantities: { '1001': 0 } },
      ],
    });
    const shopifyId = s.store.products.at(-1)!.productId;
    await webhook(s, 'products/create', shopifyId);
    const [product] = await ownerQuery<{ id: string; name: string; description: string | null }>(
      `select p.id, p.name, p.description from products p join variants v on v.product_id = p.id
       where p.shop_id = $1 and v.sku = $2`,
      [s.m.shopId, code],
    );
    expect(product).toMatchObject({ name: 'Pikachu promo', description: 'Promo card.' });
    expect(await listing(s, product!.id)).toMatchObject({ origin: 'shopify', state: 'published' });
    const [map] = await ownerQuery<{ shopify_variant_id: string }>(
      'select shopify_variant_id from shopify_variant_maps where shop_id = $1',
      [s.m.shopId],
    );
    expect(map?.shopify_variant_id).toBe(v!.variantId);
    // Shopify owns this listing: its edits are applied here.
    s.store.editProduct(shopifyId, {
      title: 'Pikachu promo (2026)',
      price: { sku: code, price: '14.00' },
    });
    await webhook(s, 'products/update', shopifyId);
    const [after] = await ownerQuery<{ name: string; price: string }>(
      `select p.name, v.price::text from products p join variants v on v.product_id = p.id
       where p.id = $1`,
      [product!.id],
    );
    expect(after).toEqual({ name: 'Pikachu promo (2026)', price: '14.000000' });
    expect(await differences(s)).toEqual([]);
    // Listing it from Airstock is refused: Shopify owns it.
    const again = await h.command(
      s.m.cookie,
      `/shops/${s.m.shopId}/products/${product!.id}/shopify-listing`,
      {
        productId: product!.id,
      },
    );
    expect(again.status).toBe(409);
  });
});
