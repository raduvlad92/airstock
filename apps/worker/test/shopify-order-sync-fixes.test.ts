import { runImportJob, uuidv7 } from '@airstock/core';
import { reconcileConnection, runJob, type ShopifyVariant } from '@airstock/shopify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../../test/helpers.ts';
import { json } from './setup.ts';
import { type ShopifyHarness, shopifyHarness } from './shopify-harness.ts';

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
  it('units are held where Shopify committed the line, with several mapped locations', async () => {
    const m = await h.merchant('Two shops');
    const store = h.newStore('fixes');
    const sku = `TWO-${uuidv7().slice(-6)}`;
    const made = await h.item(m, 'Two shops mug', sku);
    // A second warehouse with a shelf: Shopify's "Warehouse" (1002).
    const warehouse = await json(
      await h.command(m.cookie, `/shops/${m.shopId}/warehouses`, { name: 'Second' }),
    );
    const shelf = await json(
      await h.command(m.cookie, `/shops/${m.shopId}/locations`, {
        warehouseId: warehouse.warehouseId,
        name: 'Shelf',
      }),
    );
    await h.receive(m, made.variantId, 5);
    await h.receive(m, made.variantId, 5, { locationId: shelf.locationId });
    const [variant] = store.addProduct({
      title: 'Two shops mug',
      variants: [{ sku, quantities: { '1001': 0, '1002': 0 } }],
    });
    const connectionId = await h.install(m, store);
    const base = `/shops/${m.shopId}/shopify/connections/${connectionId}`;
    expect(
      (
        await h.command(m.cookie, `${base}/locations`, {
          connectionId,
          locations: [
            { shopifyLocationId: '1001', locationId: m.locationId },
            { shopifyLocationId: '1002', warehouseId: warehouse.warehouseId },
          ],
        })
      ).status,
    ).toBe(200);
    await h.command(m.cookie, `${base}/variants`, {
      connectionId,
      variants: [
        {
          shopifyVariantId: variant!.variantId,
          shopifyInventoryItemId: variant!.inventoryItemId,
          variantId: made.variantId,
        },
      ],
    });
    await h.flushTogether(m.shopId);
    expect([store.available(variant!, '1001'), store.available(variant!, '1002')]).toEqual([5, 5]);
    // Shopify commits the order at "Warehouse", the allocation rule's second location.
    const order = store.placeOrder([{ variant: variant!, quantity: 2 }], '1002');
    await h.deliver(store.domain, 'orders/create', store.webhookBody(order));
    await h.runJobs(m.shopId);
    await h.flushTogether(m.shopId);
    const held = await ownerQuery<{ location_id: string; allocated: string }>(
      `select location_id, allocated::text from inventory_positions
       where shop_id = $1 and variant_id = $2 and allocated > 0`,
      [m.shopId, made.variantId],
    );
    expect(held).toEqual([{ location_id: shelf.locationId, allocated: '2.000000' }]);
    // Each Shopify location shows what Airstock can still sell there.
    expect([store.available(variant!, '1001'), store.available(variant!, '1002')]).toEqual([5, 3]);
    // Shipped from there: stock leaves the shelf, and nothing differs.
    const f = store.fulfill(order, null, '1002');
    await h.deliver(
      store.domain,
      'fulfillments/create',
      store.topicBody('fulfillments/create', order, f.fulfillmentId),
    );
    await h.runJobs(m.shopId);
    await h.flushTogether(m.shopId);
    const [onShelf] = await ownerQuery<{ on_hand: string }>(
      `select on_hand::text from inventory_positions where shop_id = $1 and variant_id = $2
       and location_id = $3`,
      [m.shopId, made.variantId, shelf.locationId],
    );
    expect(onShelf?.on_hand).toBe('3.000000');
    await reconcileConnection(h.deps(), m.shopId, connectionId, { daily: true });
    expect(await shopifyAlerts(m.shopId)).toEqual([]);
  });

  it('a line committed at an unmapped Shopify location holds nothing; shipped from a mapped one, it leaves stock', async () => {
    const s = await setup('Pop-up', [5]);
    const [only] = s.items as [Item];
    s.store.levels.set(s.store.key(only.shopify.inventoryItemId, '1002'), 4);
    const order = s.store.placeOrder([{ variant: only.shopify, quantity: 2 }], '1002');
    await h.deliver(s.store.domain, 'orders/create', s.store.webhookBody(order));
    await h.runJobs(s.m.shopId);
    await h.flushTogether(s.m.shopId);
    expect(await h.available(s.m, only.variantId)).toBe('5.000000');
    expect(s.store.available(only.shopify, '1001')).toBe(5);
    const [line] = await ownerQuery<{ outcome: string; shopify_location_id: string }>(
      `select outcome, shopify_location_id from shopify_order_lines
       where shop_id = $1 and shopify_order_id = $2`,
      [s.m.shopId, order.orderId],
    );
    expect(line).toEqual({ outcome: 'unmapped_location', shopify_location_id: '1002' });
    // The merchant ships it from the shop instead (the fulfillment order moved): units leave here.
    const f = s.store.fulfill(order, null, '1001');
    await h.deliver(
      s.store.domain,
      'fulfillments/create',
      s.store.topicBody('fulfillments/create', order, f.fulfillmentId),
    );
    await h.runJobs(s.m.shopId);
    const [stock] = await ownerQuery<{ on_hand: string; allocated: string }>(
      `select sum(on_hand)::text as on_hand, sum(allocated)::text as allocated
       from inventory_positions where shop_id = $1 and variant_id = $2 and condition = 'sellable'`,
      [s.m.shopId, only.variantId],
    );
    expect(stock).toEqual({ on_hand: '3.000000', allocated: '0.000000' });
  });

  it('a store with one location, mapped, does not read where lines were committed', async () => {
    const s = await setup('One place', [5]);
    const [only] = s.items as [Item];
    s.store.locationList = [{ id: '1001', name: 'Shop location', active: true }];
    // The daily run refreshes the store's locations (the install recorded two).
    await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, { daily: true });
    let reads = 0;
    const lineLocations = s.store.lineLocations.bind(s.store);
    s.store.lineLocations = async (id: string) => {
      reads++;
      return lineLocations(id);
    };
    const order = s.store.placeOrder([{ variant: only.shopify, quantity: 1 }]);
    await h.deliver(s.store.domain, 'orders/create', s.store.webhookBody(order));
    await h.runJobs(s.m.shopId);
    await h.flushTogether(s.m.shopId);
    expect(reads).toBe(0);
    expect(await h.available(s.m, only.variantId)).toBe('4.000000');
    expect(s.store.available(only.shopify)).toBe(4);
  });
  it('onboarding: an order shipped while the preview waited leaves stock; one from before the read stays Shopify’s', async () => {
    const m = await h.merchant('Onboarding shipped');
    const store = h.newStore('fixes');
    const code = `SHIP-${uuidv7().slice(-6)}`;
    const [variant] = store.addProduct({
      title: 'Shipped mug',
      variants: [{ sku: code, quantities: { '1001': 10 } }],
    });
    const connectionId = await h.install(m, store);
    const base = `/shops/${m.shopId}/shopify/connections/${connectionId}`;
    await h.command(m.cookie, `${base}/locations`, {
      connectionId,
      locations: [{ shopifyLocationId: '1001', locationId: m.locationId }],
    });
    // Sold after the connection, before the onboarding: already out of the catalog read.
    const before = store.placeOrder([{ variant: variant!, quantity: 1 }]);
    await h.deliver(store.domain, 'orders/create', store.webhookBody(before));
    await h.runJobs(m.shopId);
    await new Promise((r) => setTimeout(r, 5));
    const started = await h.command(m.cookie, `${base}/onboardings`, { connectionId });
    const onboardingId = (await json(started)).onboarding.onboardingId as string;
    await h.runOnboardingSteps(m.shopId, onboardingId);
    const viewed = await json(
      await h.dashboard(m.cookie, `/shops/${m.shopId}/shopify/onboardings/${onboardingId}`),
    );
    expect(viewed.onboarding.status).toBe('previewed');
    // While the preview waits: 2 sold and shipped, then 3 sold (not shipped yet).
    const shipped = store.placeOrder([{ variant: variant!, quantity: 2 }]);
    await h.deliver(store.domain, 'orders/create', store.webhookBody(shipped));
    const f = store.fulfill(shipped);
    await h.deliver(
      store.domain,
      'fulfillments/create',
      store.topicBody('fulfillments/create', shipped, f.fulfillmentId),
    );
    const open = store.placeOrder([{ variant: variant!, quantity: 3 }]);
    await h.deliver(store.domain, 'orders/create', store.webhookBody(open));
    await h.runJobs(m.shopId);
    expect(store.available(variant!)).toBe(4);
    const committed = await h.command(
      m.cookie,
      `/shops/${m.shopId}/shopify/onboardings/${onboardingId}/commit`,
      {},
    );
    expect(committed.status, await committed.clone().text()).toBe(200);
    await h.runOnboardingSteps(m.shopId, onboardingId, 1);
    await runImportJob(
      { db: h.t.db, audit: h.t.sink, files: h.deps().files! },
      m.shopId,
      viewed.onboarding.importId,
    );
    await h.runOnboardingSteps(m.shopId, onboardingId);
    await h.flushTogether(m.shopId);
    // Opening stock 9 (Shopify's 10 less the order before the read): 2 shipped, 3 held.
    const [mapped] = await ownerQuery<{ variant_id: string }>(
      'select variant_id from shopify_variant_maps where shop_id = $1',
      [m.shopId],
    );
    const [stock] = await ownerQuery<{ on_hand: string; allocated: string }>(
      `select sum(on_hand)::text as on_hand, sum(allocated)::text as allocated
       from inventory_positions where shop_id = $1 and variant_id = $2`,
      [m.shopId, mapped!.variant_id],
    );
    expect(stock).toEqual({ on_hand: '7.000000', allocated: '3.000000' });
    expect(store.available(variant!)).toBe(4);
    const lines = await ownerQuery<{ shopify_order_id: string; outcome: string }>(
      'select shopify_order_id, outcome from shopify_order_lines where shop_id = $1',
      [m.shopId],
    );
    expect(lines.find((l) => l.shopify_order_id === before.orderId)?.outcome).toBe('unmapped');
    // Shipping the order placed before the read changes nothing here.
    const g = store.fulfill(before);
    await h.deliver(
      store.domain,
      'fulfillments/create',
      store.topicBody('fulfillments/create', before, g.fulfillmentId),
    );
    await h.runJobs(m.shopId);
    await h.flushTogether(m.shopId);
    expect(await h.available(m, mapped!.variant_id)).toBe('4.000000');
    await reconcileConnection(h.deps(), m.shopId, connectionId, { daily: true });
    expect(await shopifyAlerts(m.shopId)).toEqual([]);
    expect(store.available(variant!)).toBe(4);
  });
  it('uninstall keeps the holds; installed again in the shop, the store continues its orders', async () => {
    const s = await setup('Reinstall', [5]);
    const [only] = s.items as [Item];
    const held = s.store.placeOrder([{ variant: only.shopify, quantity: 2 }]);
    await h.deliver(s.store.domain, 'orders/create', s.store.webhookBody(held));
    await h.runJobs(s.m.shopId);
    await h.flushTogether(s.m.shopId);
    expect(s.store.available(only.shopify)).toBe(3);
    const gone = await h.deliver(
      s.store.domain,
      'app/uninstalled',
      JSON.stringify({ id: 1, domain: s.store.domain }),
    );
    expect(gone.status).toBe(200);
    // Uninstalled: the order's units stay held (the store may come back).
    expect(await h.available(s.m, only.variantId)).toBe('3.000000');
    // While the app is away: the held order ships, and a new order is placed.
    s.store.fulfill(held);
    const during = s.store.placeOrder([{ variant: only.shopify, quantity: 1 }]);
    expect(s.store.available(only.shopify)).toBe(2);
    const again = await h.install(s.m, s.store);
    expect(again).not.toBe(s.connectionId);
    const [maps] = await ownerQuery<{ count: number }>(
      'select count(*)::int as count from shopify_variant_maps where connection_id = $1',
      [again],
    );
    expect(maps?.count).toBe(1);
    await reconcileConnection(h.deps(), s.m.shopId, again, { daily: true });
    await h.flushTogether(s.m.shopId);
    const [stock] = await ownerQuery<{ on_hand: string; allocated: string }>(
      `select sum(on_hand)::text as on_hand, sum(allocated)::text as allocated
       from inventory_positions where shop_id = $1 and variant_id = $2 and condition = 'sellable'`,
      [s.m.shopId, only.variantId],
    );
    // The shipped order left stock from its hold; the new one is held.
    expect(stock).toEqual({ on_hand: '3.000000', allocated: '1.000000' });
    const lines = await ownerQuery<{ shopify_order_id: string; connection_id: string }>(
      'select shopify_order_id, connection_id from shopify_order_lines where shop_id = $1',
      [s.m.shopId],
    );
    expect(lines.map((l) => l.connection_id)).toEqual([again, again]);
    expect(lines.map((l) => l.shopify_order_id).sort()).toEqual(
      [held.orderId, during.orderId].sort(),
    );
    expect(s.store.available(only.shopify)).toBe(2);
    expect(await shopifyAlerts(s.m.shopId)).toEqual([]);
  });

  it('shop/redact releases what an uninstalled store’s orders still hold', async () => {
    const s = await setup('Redacted', [5]);
    const [only] = s.items as [Item];
    const order = s.store.placeOrder([{ variant: only.shopify, quantity: 2 }]);
    await h.deliver(s.store.domain, 'orders/create', s.store.webhookBody(order));
    await h.runJobs(s.m.shopId);
    await h.deliver(
      s.store.domain,
      'app/uninstalled',
      JSON.stringify({ id: 1, domain: s.store.domain }),
    );
    expect(await h.available(s.m, only.variantId)).toBe('3.000000');
    const body = JSON.stringify({ shop_id: 1, shop_domain: s.store.domain });
    expect((await h.deliver(s.store.domain, 'shop/redact', body)).status).toBe(200);
    expect(await h.available(s.m, only.variantId)).toBe('5.000000');
    const [line] = await ownerQuery<{ open_items: number }>(
      'select open_items from shopify_order_lines where shop_id = $1',
      [s.m.shopId],
    );
    expect(line?.open_items).toBe(0);
    // Delivered again, nothing changes.
    expect((await h.deliver(s.store.domain, 'shop/redact', body)).status).toBe(200);
    expect(await h.available(s.m, only.variantId)).toBe('5.000000');
  });
});
