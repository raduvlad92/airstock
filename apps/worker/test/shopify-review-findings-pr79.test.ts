import { objectKey, uuidv7 } from '@airstock/core';
import { publishListing, ShopifyApiError } from '@airstock/shopify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../../test/helpers.ts';
import type { FakeStore } from './fake-shopify.ts';
import { type Merchant, type ShopifyHarness, shopifyHarness } from './shopify-harness.ts';

// Review of the Shopify connector (16 November 2026), findings in PR #79 (listings): one test per
// confirmed defect, named after the finding. Each is `it.fails` so CI stays green until the fix
// lands; the comment above each says what goes wrong. The findings on main are in
// shopify-review-findings.test.ts. Every query here is limited to this file's shops.

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
  const store = h.newStore('review79');
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
async function addPicture(m: Merchant, productId: string, position: number) {
  const mediaId = uuidv7();
  const sha = String(position).repeat(64);
  await ownerQuery(
    `insert into media_upload_intents (shop_id, id, media_id, kind, file_name, content_type,
       size_bytes, sha256, status, created_by, expires_at, finalized_at)
     values ($1, $2, $3, 'image', 'front.jpg', 'image/jpeg', 4, $4, 'finalized', 'test',
       now() + interval '1 hour', now())`,
    [m.shopId, uuidv7(), mediaId, sha],
  );
  await ownerQuery(
    `insert into media_assets (shop_id, id, kind, file_name, content_type, size_bytes, sha256, width,
       height, created_by)
     values ($1, $2, 'image', 'front.jpg', 'image/jpeg', 4, $3, 2048, 2048, 'test')`,
    [m.shopId, mediaId, sha],
  );
  await ownerQuery(
    `insert into media_links (shop_id, id, media_id, product_id, role, position, is_primary)
     values ($1, $2, $3, $4, 'product', $5, $6)`,
    [m.shopId, uuidv7(), mediaId, productId, position, position === 0],
  );
  h.originals.set(objectKey(m.shopId, mediaId, 'original'), {
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    contentType: 'image/jpeg',
  });
  return mediaId;
}

async function webhook(s: Setup, topic: string, productId: string) {
  const res = await h.deliver(s.store.domain, topic, s.store.productBody(productId));
  expect(res.status).toBe(200);
  return h.runJobs(s.m.shopId);
}

describe('Shopify connector review findings (PR #79, listings)', () => {
  // FINDING L1 (Shopify quantity overwritten; PR #79). shopify.products.sync creates an Airstock
  // item for a new single-variant Shopify product (with no stock) and maps it at once, with no
  // person involved. The map change pushes: the first push reads Shopify's quantity as the record
  // and then writes Airstock's 0 over it. A merchant who creates a product in Shopify with 10 in
  // stock sees it sold out seconds later. PRD 8.5: a Shopify-side quantity no order explains is
  // shown as a conflict, not silently replaced (or it should come in as opening stock, as the
  // onboarding import does).
  it.fails('L1: a product created in Shopify with stock keeps its quantity', async () => {
    const s = await setup('Created stock');
    const code = sku('NEWQ');
    const [v] = s.store.addProduct({
      title: 'Charizard promo',
      variants: [{ sku: code, price: '9.00', quantities: { '1001': 10 } }],
    });
    await webhook(s, 'products/create', s.store.products.at(-1)!.productId);
    await h.flushTogether(s.m.shopId);
    expect(s.store.available(v!)).toBe(10);
  });

  // FINDING L2 (pictures uploaded twice; PR #79). publishListing adds new pictures with
  // updateProduct, then reads the product back, then records which pictures Shopify has. When
  // the read after the update fails (throttled, a timeout, the Worker stopped), nothing is
  // recorded, so the next publish uploads the same pictures again: the storefront shows each one
  // twice. The create path guards against this (it adopts by SKU); the update path does not.
  it.fails('L2: a picture is uploaded once even when the publish fails after the update', async () => {
    const s = await setup('Picture twice');
    const made = await h.item(s.m, 'Booster bundle', sku('BB'));
    await addPicture(s.m, made.productId, 0);
    const res = await h.command(
      s.m.cookie,
      `/shops/${s.m.shopId}/products/${made.productId}/shopify-listing`,
      { productId: made.productId, status: 'active' },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await publishListing(h.deps(), s.m.shopId, s.connectionId, made.productId)).toBe(
      'created',
    );
    const shopifyProduct = s.store.products.at(-1)!;
    expect(shopifyProduct.images).toHaveLength(1);
    // A second picture in Airstock; the read after Shopify's update is throttled once.
    await addPicture(s.m, made.productId, 1);
    const read = s.store.product.bind(s.store);
    let fail = 1;
    s.store.product = async (id: string) => {
      if (fail-- > 0) throw new ShopifyApiError('Throttled', 200, true, 'THROTTLED');
      return read(id);
    };
    await expect(
      publishListing(h.deps(), s.m.shopId, s.connectionId, made.productId),
    ).rejects.toMatchObject({ retryable: true });
    // The job retries.
    await publishListing(h.deps(), s.m.shopId, s.connectionId, made.productId);
    expect(shopifyProduct.images).toHaveLength(2);
  });
});
