import { uuidv7 } from '@airstock/core';
import type { ShopifyVariant } from '@airstock/shopify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../../test/helpers.ts';
import type { FakeStore } from './fake-shopify.ts';
import { type Merchant, type ShopifyHarness, shopifyHarness } from './shopify-harness.ts';

// Review of the Shopify connector (16 November 2026): one test per confirmed defect, named after
// the finding. Each is `it.fails` so CI stays green until the defect is fixed; the comment above
// each says what goes wrong. When a fix lands, its test starts passing, `it.fails` then fails,
// and the fix turns it into a plain `it`.
//
// Test files run in parallel against one database and outbox: every query here is limited to
// this file's shops.

let h: ShopifyHarness;
beforeAll(async () => {
  h = await shopifyHarness();
});
afterAll(() => h.t.close());

interface Setup {
  m: Merchant;
  store: FakeStore;
  connectionId: string;
  variantId: string;
  productId: string;
  item: ShopifyVariant;
}

/** A shop with `stock` units of one item, a store selling it at "Shop location", mapped. */
async function setup(name: string, stock: number): Promise<Setup> {
  const m = await h.merchant(name);
  const sku = `${name.replace(/\W/g, '').slice(0, 8).toUpperCase()}-${uuidv7().slice(-6)}`;
  const made = await h.item(m, name, sku);
  if (stock > 0) await h.receive(m, made.variantId, stock);
  const store = h.newStore('review');
  const [item] = store.addProduct({ title: name, variants: [{ sku, quantities: { '1001': 0 } }] });
  const connectionId = await h.install(m, store);
  const base = `/shops/${m.shopId}/shopify/connections/${connectionId}`;
  expect(
    (
      await h.command(m.cookie, `${base}/locations`, {
        connectionId,
        locations: [{ shopifyLocationId: '1001', locationId: m.locationId }],
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.command(m.cookie, `${base}/variants`, {
        connectionId,
        variants: [
          {
            shopifyVariantId: item!.variantId,
            shopifyInventoryItemId: item!.inventoryItemId,
            variantId: made.variantId,
          },
        ],
      })
    ).status,
  ).toBe(200);
  await h.flush(m.shopId);
  expect(store.available(item!)).toBe(stock);
  return {
    m,
    store,
    connectionId,
    variantId: made.variantId,
    productId: made.productId,
    item: item!,
  };
}

/** Delivers a topic's webhook, runs this shop's jobs, and pushes this shop's changes. */
async function event(s: Setup, topic: string, body: string, eventId?: string) {
  const res = await h.deliver(s.store.domain, topic, body, eventId ? { eventId } : {});
  expect(res.status).toBe(200);
  const jobs = await h.runJobs(s.m.shopId);
  await h.flush(s.m.shopId);
  return jobs;
}

async function onHand(s: Setup) {
  const [row] = await ownerQuery<{ on_hand: string; allocated: string }>(
    `select coalesce(sum(on_hand), 0)::text as on_hand, coalesce(sum(allocated), 0)::text as allocated
     from inventory_positions where shop_id = $1 and variant_id = $2 and condition = 'sellable'`,
    [s.m.shopId, s.variantId],
  );
  return row!;
}

describe('Shopify connector review findings', () => {
  // FINDING 1 (stock drift, main). shopify.orders.sync runs fulfillments (step 2) before it
  // reserves new lines (step 3). An order whose first sync already carries a fulfillment (its
  // fulfillments/create webhook came before orders/create, or the reconciler found an order whose
  // webhooks were missed, as with a POS sale) has no reservation to fulfill: fulfillItems counts
  // every unit as "released", step 3's target is then 0, and no stock ever leaves. Airstock keeps
  // the shipped units as available and pushes them back to Shopify.
  it.fails('F1: an order first seen with its fulfillment takes the shipped units out of stock', async () => {
    const s = await setup('Late create mug', 5);
    const order = s.store.placeOrder([{ variant: s.item, quantity: 2 }]);
    const f = s.store.fulfill(order);
    // fulfillments/create arrives first; orders/create is late.
    await event(
      s,
      'fulfillments/create',
      s.store.topicBody('fulfillments/create', order, f.fulfillmentId),
    );
    await event(s, 'orders/create', s.store.webhookBody(order));
    expect(await onHand(s)).toEqual({ on_hand: '3.000000', allocated: '0.000000' });
    expect(await h.available(s.m, s.variantId)).toBe('3.000000');
    // Shopify sold 2 of 5: it must not be told 5 are available again.
    expect(s.store.available(s.item)).toBe(3);
  });
});
