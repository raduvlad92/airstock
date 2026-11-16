import { uuidv7 } from '@airstock/core';
import { reconcileConnection, runJob, type ShopifyVariant } from '@airstock/shopify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../../test/helpers.ts';
import type { FakeStore } from './fake-shopify.ts';
import { type Merchant, type ShopifyHarness, shopifyHarness } from './shopify-harness.ts';

// The order sync fixes after the connector review (PR #82, ADRs 0033, 0035, 0036): cases beyond
// the review's own tests. Test files run in parallel against one database and outbox: every query
// here is limited to this file's shops.

let h: ShopifyHarness;
beforeAll(async () => {
  h = await shopifyHarness();
});
afterAll(() => h.t.close());

interface Item {
  variantId: string;
  shopify: ShopifyVariant;
}

/** A shop whose items (with stock) are each sold by one Shopify variant at "Shop location". */
async function setup(name: string, stocks: number[]) {
  const m = await h.merchant(name);
  const store = h.newStore('fixes');
  const items: Item[] = [];
  for (const [i, stock] of stocks.entries()) {
    const sku = `${name.replace(/\W/g, '').slice(0, 6).toUpperCase()}-${i}-${uuidv7().slice(-6)}`;
    const made = await h.item(m, `${name} ${i}`, sku);
    if (stock > 0) await h.receive(m, made.variantId, stock);
    const [shopify] = store.addProduct({
      title: `${name} ${i}`,
      variants: [{ sku, quantities: { '1001': 0 } }],
    });
    items.push({ variantId: made.variantId, shopify: shopify! });
  }
  const connectionId = await h.install(m, store);
  const base = `/shops/${m.shopId}/shopify/connections/${connectionId}`;
  await h.command(m.cookie, `${base}/locations`, {
    connectionId,
    locations: [{ shopifyLocationId: '1001', locationId: m.locationId }],
  });
  const mapped = await h.command(m.cookie, `${base}/variants`, {
    connectionId,
    variants: items.map((i) => ({
      shopifyVariantId: i.shopify.variantId,
      shopifyInventoryItemId: i.shopify.inventoryItemId,
      variantId: i.variantId,
    })),
  });
  expect(mapped.status).toBe(200);
  await h.flushTogether(m.shopId);
  for (const [i, stock] of stocks.entries()) expect(store.available(items[i]!.shopify)).toBe(stock);
  return { m, store, connectionId, items };
}

async function connection(connectionId: string) {
  const [row] = await ownerQuery<{
    synced: Date | null;
    last_error: string | null;
    page_after: string | null;
  }>(
    `select orders_synced_through as synced, last_error, orders_page_after as page_after
     from shopify_connections where id = $1`,
    [connectionId],
  );
  return row!;
}

async function shopifyAlerts(shopId: string) {
  return ownerQuery<{ kind: string; status: string }>(
    `select kind, status from alerts where shop_id = $1 and kind = 'shopify_sync'`,
    [shopId],
  );
}

describe('Shopify order sync fixes', () => {
  it('the reconciler moves past an order it cannot apply, retries it as a job, and shows it', async () => {
    const s = await setup('Bad order', [5]);
    const [only] = s.items as [Item];
    const bad = s.store.placeOrder([{ variant: only.shopify, quantity: 1 }]);
    const good = s.store.placeOrder([{ variant: only.shopify, quantity: 2 }]);
    // Shopify answers the first order with something the sync refuses (a line ID it cannot read).
    const lineId = bad.lines[0]!.lineId;
    bad.lines[0]!.lineId = 'not-a-number';
    const run = await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, { daily: false });
    expect(run).toMatchObject({ orders: 2, ordersFailed: 1 });
    // The good order applied, and the cursor moved past both.
    expect(await h.available(s.m, only.variantId)).toBe('3.000000');
    const conn = await connection(s.connectionId);
    expect(conn.synced).not.toBeNull();
    expect(conn.last_error).toContain(`Shopify order ${bad.orderId} could not be applied`);
    // The bad order waits as an order job, once however many runs meet it.
    await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, { daily: false });
    const jobs = await ownerQuery<{ id: string; status: string }>(
      `select id, status from jobs where shop_id = $1 and payload->>'orderId' = $2`,
      [s.m.shopId, bad.orderId],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('pending');
    // Once Shopify answers properly, the job applies the order and a clean run clears the error.
    bad.lines[0]!.lineId = lineId;
    await ownerQuery(`update jobs set run_after = now() where id = $1`, [jobs[0]!.id]);
    expect(await runJob(h.deps(), s.m.shopId, jobs[0]!.id)).toEqual({ status: 'done' });
    expect(await h.available(s.m, only.variantId)).toBe('2.000000');
    await h.flush(s.m.shopId);
    await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, { daily: true });
    expect((await connection(s.connectionId)).last_error).toBeNull();
    expect(s.store.available(only.shopify)).toBe(2);
    // The level check meanwhile found Shopify lower than the record; the late order explains it.
    expect((await shopifyAlerts(s.m.shopId)).filter((a) => a.status !== 'resolved')).toEqual([]);
    expect(good.lines).toHaveLength(1);
  });

  it('a run that stops early continues from Shopify’s page cursor, then clears it', async () => {
    const s = await setup('Cursor', [10]);
    const [only] = s.items as [Item];
    const orders = [];
    for (let i = 0; i < 3; i++) {
      const order = s.store.placeOrder([{ variant: only.shopify, quantity: 1 }]);
      await h.deliver(s.store.domain, 'orders/create', s.store.webhookBody(order));
      orders.push(order);
    }
    await h.runJobs(s.m.shopId);
    await h.flushTogether(s.m.shopId);
    // Shipped with the fulfillment webhooks missed: only the order pass can find them.
    for (const order of orders) s.store.fulfill(order);
    s.store.orderPageSize = 1;
    await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, {
      daily: false,
      maxOrders: 2,
    });
    expect((await connection(s.connectionId)).page_after).not.toBeNull();
    await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, {
      daily: false,
      maxOrders: 2,
    });
    expect((await connection(s.connectionId)).page_after).toBeNull();
    const [stock] = await ownerQuery<{ on_hand: string; allocated: string }>(
      `select sum(on_hand)::text as on_hand, sum(allocated)::text as allocated
       from inventory_positions where shop_id = $1 and variant_id = $2`,
      [s.m.shopId, only.variantId],
    );
    expect(stock).toEqual({ on_hand: '7.000000', allocated: '0.000000' });
  });
});
