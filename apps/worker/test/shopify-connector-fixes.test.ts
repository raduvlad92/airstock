import { uuidv7 } from '@airstock/core';
import {
  catchUpOrders,
  connectedStore,
  publishListing,
  pushChanges,
  reconcileConnection,
  ShopifyApiError,
  type ShopifyVariant,
} from '@airstock/shopify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ownerQuery } from '../../../test/helpers.ts';
import type { FakeStore } from './fake-shopify.ts';
import { json } from './setup.ts';
import { type Merchant, type ShopifyHarness, shopifyHarness } from './shopify-harness.ts';

// Fixes of the Shopify connector review (#82) beyond its own tests: the cases next to each
// finding that its fix has to get right as well. Every query is limited to this file's shops.

let h: ShopifyHarness;
beforeAll(async () => {
  h = await shopifyHarness();
});
afterAll(() => h.t.close());

interface Setup {
  m: Merchant;
  store: FakeStore;
  connectionId: string;
  items: Array<{ variantId: string; productId: string; shopify: ShopifyVariant }>;
}

const NAMES = ['mug', 'teapot', 'kettle'];

/** A shop whose items (with stock) are each sold by one Shopify variant at "Shop location". */
async function setup(name: string, stocks: number[]): Promise<Setup> {
  const m = await h.merchant(name);
  const store = h.newStore('fixes');
  const items: Setup['items'] = [];
  for (const [i, stock] of stocks.entries()) {
    const sku = `${name.replace(/\W/g, '').slice(0, 6).toUpperCase()}-${i}-${uuidv7().slice(-6)}`;
    const made = await h.item(m, `${name} ${NAMES[i]}`, sku);
    if (stock > 0) await h.receive(m, made.variantId, stock);
    const [shopify] = store.addProduct({
      title: `${name} ${NAMES[i]}`,
      variants: [{ sku, quantities: { '1001': 0 } }],
    });
    items.push({ variantId: made.variantId, productId: made.productId, shopify: shopify! });
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

async function health(s: Setup) {
  const res = await h.dashboard(
    s.m.cookie,
    `/shops/${s.m.shopId}/shopify/sync-health?connectionId=${s.connectionId}`,
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json(res)).connections[0];
}

async function shopifyAlerts(shopId: string) {
  return ownerQuery<{ status: string }>(
    `select status from alerts where shop_id = $1 and kind = 'shopify_sync'`,
    [shopId],
  );
}

async function record(s: Setup, item: ShopifyVariant) {
  const [row] = await ownerQuery<{ expected_available: number | null }>(
    `select expected_available from shopify_inventory_levels
     where connection_id = $1 and shopify_inventory_item_id = $2 and shopify_location_id = '1001'`,
    [s.connectionId, item.inventoryItemId],
  );
  return row?.expected_available ?? null;
}

const changed = (s: Setup, variantId: string) => ({
  topic: 'inventory.availability_changed',
  payload: { variantId, locationIds: [s.m.locationId] },
});

describe('Shopify connector fixes', () => {
  it('F12: a level Shopify names as refused fails alone and shows in sync health', async () => {
    const s = await setup('Named refusal', [5, 5]);
    const [gone, kept] = s.items as [Setup['items'][0], Setup['items'][0]];
    s.store.namesDeletedItems = true;
    s.store.deletedItems.add(gone.shopify.inventoryItemId);
    await h.receive(s.m, gone.variantId, 1);
    await h.receive(s.m, kept.variantId, 1);
    const calls = s.store.setCalls.length;
    const outcomes = await h.flushTogether(s.m.shopId);
    expect(new Map(outcomes.map((o) => [o.inventoryItemId, o.outcome]))).toEqual(
      new Map([
        [gone.shopify.inventoryItemId, 'failed'],
        [kept.shopify.inventoryItemId, 'pushed'],
      ]),
    );
    // One call refused, the other level written in the next: no splitting needed.
    expect(s.store.setCalls.slice(calls)).toEqual([2, 1]);
    expect(s.store.available(kept.shopify)).toBe(6);
    // The reconciler tries again, and keeps the error for sync health.
    await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, { daily: true });
    const view = await health(s);
    expect(view.lastError?.message).toContain('could not be found');
    expect(view.pendingPushes.levels).toEqual([
      expect.objectContaining({ inventoryItemId: gone.shopify.inventoryItemId, airstock: 6 }),
    ]);
    // Once Shopify takes the quantity again, the next good run clears the error.
    s.store.deletedItems.delete(gone.shopify.inventoryItemId);
    await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, { daily: true });
    expect((await health(s)).lastError).toBeNull();
    expect(s.store.available(gone.shopify)).toBe(6);
  });

  it('F12: an unnamed refusal is found by splitting the batch', async () => {
    const s = await setup('Unnamed refusal', [2, 2, 2]);
    const [a, gone, c] = s.items as [Setup['items'][0], Setup['items'][0], Setup['items'][0]];
    s.store.deletedItems.add(gone.shopify.inventoryItemId);
    for (const i of s.items) await h.receive(s.m, i.variantId, 1);
    const outcomes = await h.flushTogether(s.m.shopId);
    expect(outcomes.find((o) => o.inventoryItemId === gone.shopify.inventoryItemId)?.outcome).toBe(
      'failed',
    );
    expect(s.store.available(a.shopify)).toBe(3);
    expect(s.store.available(c.shopify)).toBe(3);
    expect(await shopifyAlerts(s.m.shopId)).toEqual([]);
  });

  it('F7: a retry with the same quantities is answered by Shopify from the idempotency key', async () => {
    const s = await setup('Same key', [5]);
    const [only] = s.items as [Setup['items'][0]];
    await h.receive(s.m, only.variantId, 1);
    const set = s.store.setAvailable.bind(s.store);
    let lose = 1;
    s.store.setAvailable = async (input) => {
      const done = await set(input);
      if (lose-- > 0) throw new ShopifyApiError('Shopify Admin API returned 502.', 502, true);
      return done;
    };
    await expect(h.flushTogether(s.m.shopId)).rejects.toMatchObject({ retryable: true });
    const replays = s.store.replays;
    const reads = s.store.reads;
    const retried = await pushChanges(h.deps(), s.m.shopId, [changed(s, only.variantId)]);
    expect(retried.map((r) => r.outcome)).toEqual(['pushed']);
    // The same request: Shopify returned the first result; nothing was read to decide.
    expect(s.store.replays).toBe(replays + 1);
    expect(s.store.reads).toBe(reads);
    expect(await record(s, only.shopify)).toBe(6);
  });

  it('F7: a lost write retried in another batch is recorded once Shopify shows it', async () => {
    const s = await setup('Other batch', [5, 5]);
    const [a, b] = s.items as [Setup['items'][0], Setup['items'][0]];
    await h.receive(s.m, a.variantId, 1);
    const set = s.store.setAvailable.bind(s.store);
    let lose = 1;
    s.store.setAvailable = async (input) => {
      const done = await set(input);
      if (lose-- > 0) throw new ShopifyApiError('Shopify Admin API returned 502.', 502, true);
      return done;
    };
    await expect(h.flushTogether(s.m.shopId)).rejects.toMatchObject({ retryable: true });
    expect(s.store.available(a.shopify)).toBe(6);
    // The queue retries the first message together with a new one: another request to Shopify.
    await h.receive(s.m, b.variantId, 2);
    const retried = await pushChanges(h.deps(), s.m.shopId, [
      changed(s, a.variantId),
      changed(s, b.variantId),
    ]);
    expect(retried.map((r) => r.outcome)).toEqual(['pushed', 'pushed']);
    expect(s.store.available(a.shopify)).toBe(6);
    expect(s.store.available(b.shopify)).toBe(7);
    expect(await record(s, a.shopify)).toBe(6);
    expect(await shopifyAlerts(s.m.shopId)).toEqual([]);
  });

  it('F3: a quantity changed by hand is still a conflict, with every order applied', async () => {
    const s = await setup('Hand edit', [5]);
    const [only] = s.items as [Setup['items'][0]];
    // An old order is cancelled in Shopify (its restock is applied by the catch-up), and someone
    // also types 20 into Shopify: the cancellation does not explain that.
    const order = s.store.placeOrder([{ variant: only.shopify, quantity: 1 }]);
    await h.deliver(s.store.domain, 'orders/create', s.store.webhookBody(order));
    await h.runJobs(s.m.shopId);
    await h.flushTogether(s.m.shopId);
    expect(s.store.available(only.shopify)).toBe(4);
    s.store.cancel(order);
    s.store.levels.set(s.store.key(only.shopify.inventoryItemId, '1001'), 20);
    await h.receive(s.m, only.variantId, 1);
    const outcomes = await h.flushTogether(s.m.shopId);
    expect(outcomes.map((o) => o.outcome)).toEqual(['conflict']);
    expect(await h.available(s.m, only.variantId)).toBe('6.000000');
    expect(s.store.available(only.shopify)).toBe(20);
    expect(await shopifyAlerts(s.m.shopId)).toEqual([{ status: 'open' }]);
  });

  it('F3: the catch-up says when more orders changed than it reads', async () => {
    const s = await setup('Many changes', [10]);
    const [only] = s.items as [Setup['items'][0]];
    for (let i = 0; i < 3; i++) s.store.placeOrder([{ variant: only.shopify, quantity: 1 }]);
    s.store.orderPageSize = 1;
    const store = await connectedStore(h.deps(), s.m.shopId, s.connectionId);
    // ordersSince lists new orders in one page; changed ones are read a page at a time.
    store.admin.ordersSince = async () => [];
    const since = new Date(Date.now() - 60_000);
    expect(await catchUpOrders(h.deps(), store, since, 2)).toMatchObject({
      orders: 2,
      complete: false,
    });
    expect(await catchUpOrders(h.deps(), store, since)).toMatchObject({
      orders: 3,
      complete: true,
    });
  });

  it('F6: a retried uninstall from before a reinstall leaves the new connection alone', async () => {
    const m = await h.merchant('Reinstall');
    const store = h.newStore('fixes');
    const first = await h.install(m, store);
    const eventId = uuidv7();
    const triggeredAt = new Date().toISOString();
    const body = JSON.stringify({ id: 1, domain: store.domain });
    const uninstall = (opts: { eventId: string; triggeredAt: string }) =>
      h.deliver(store.domain, 'app/uninstalled', body, opts);
    expect((await uninstall({ eventId, triggeredAt })).status).toBe(200);
    // The merchant installs the app again; Shopify then delivers the old event once more.
    await new Promise((r) => setTimeout(r, 10));
    const second = await h.install(m, store);
    expect(second).not.toBe(first);
    expect((await uninstall({ eventId, triggeredAt })).status).toBe(200);
    const status = async (id: string) =>
      (
        await ownerQuery<{ status: string }>(
          'select status from shopify_connections where id = $1',
          [id],
        )
      )[0]?.status;
    expect(await status(second)).toBe('active');
    // A new uninstall does apply.
    expect(
      (await uninstall({ eventId: uuidv7(), triggeredAt: new Date().toISOString() })).status,
    ).toBe(200);
    expect(await status(second)).toBe('uninstalled');
  });

  it('L1: a product created in Shopify comes in with its quantity as opening stock', async () => {
    const m = await h.merchant('Opening stock');
    const store = h.newStore('fixes');
    const connectionId = await h.install(m, store);
    await h.command(m.cookie, `/shops/${m.shopId}/shopify/connections/${connectionId}/locations`, {
      connectionId,
      locations: [{ shopifyLocationId: '1001', locationId: m.locationId }],
    });
    await h.flushTogether(m.shopId);
    const [v] = store.addProduct({
      title: 'Promo tin',
      variants: [
        { sku: `TIN-${uuidv7().slice(-6)}`, price: '9.00', quantities: { '1001': 10, '1002': 4 } },
      ],
    });
    const res = await h.deliver(
      store.domain,
      'products/create',
      store.productBody(store.products.at(-1)!.productId),
    );
    expect(res.status).toBe(200);
    await h.runJobs(m.shopId);
    const outcomes = await h.flushTogether(m.shopId);
    expect(outcomes.map((o) => o.outcome)).not.toContain('pushed');
    const [mapped] = await ownerQuery<{ variant_id: string }>(
      'select variant_id from shopify_variant_maps where shop_id = $1',
      [m.shopId],
    );
    expect(await h.available(m, mapped!.variant_id)).toBe('10.000000');
    expect(store.available(v!)).toBe(10);
    // The unmapped warehouse is not Airstock's.
    expect(store.available(v!, '1002')).toBe(4);
    // A later sale lowers both.
    const order = store.placeOrder([{ variant: v!, quantity: 3 }]);
    await h.deliver(store.domain, 'orders/create', store.webhookBody(order));
    await h.runJobs(m.shopId);
    await h.flushTogether(m.shopId);
    expect(await h.available(m, mapped!.variant_id)).toBe('7.000000');
    expect(store.available(v!)).toBe(7);
  });

  it('taking Shopify’s number locks the level after the stock, as an order sync does', async () => {
    const s = await setup('Lock order', [5]);
    const [only] = s.items as [Setup['items'][0]];
    // Someone sets 8 in Shopify; the daily comparison makes it a conflict.
    s.store.levels.set(s.store.key(only.shopify.inventoryItemId, '1001'), 8);
    await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, { daily: true });
    expect(await shopifyAlerts(s.m.shopId)).toEqual([{ status: 'open' }]);
    // An order sync holds the item's stock rows (step 1 of the lock order) ...
    const sync = new pg.Client({ connectionString: inject('databases').ownerUrl });
    await sync.connect();
    try {
      await sync.query('begin');
      await sync.query(
        'select id from inventory_positions where variant_id = $1 order by id for update',
        [only.variantId],
      );
      const [{ pid }] = (await sync.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows as [{ pid: number }];
      // ... while a person takes Shopify's number: it waits for the stock rows.
      const resolving = h.command(
        s.m.cookie,
        `/shops/${s.m.shopId}/shopify/connections/${s.connectionId}/conflicts/resolve`,
        {
          connectionId: s.connectionId,
          inventoryItemId: only.shopify.inventoryItemId,
          shopifyLocationId: '1001',
          choice: 'take_shopify',
        },
      );
      for (let i = 0; i < 200; i++) {
        const [waiting] = await ownerQuery<{ n: number }>(
          'select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
          [pid],
        );
        if (waiting!.n > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      // The order sync then reaches the level row (applying what Shopify took): it is free, so
      // the two never wait on each other.
      await sync.query(
        `select 1 from shopify_inventory_levels where connection_id = $1
           and shopify_inventory_item_id = $2 and shopify_location_id = '1001' for update nowait`,
        [s.connectionId, only.shopify.inventoryItemId],
      );
      await sync.query('rollback');
      const res = await resolving;
      expect(res.status, await res.clone().text()).toBe(200);
    } finally {
      await sync.end();
    }
    expect(await h.available(s.m, only.variantId)).toBe('8.000000');
  });

  describe('publishing a listing whose SKU Shopify already has', () => {
    async function listed(name: string, code: string) {
      const m = await h.merchant(name);
      const store = h.newStore('fixes');
      const connectionId = await h.install(m, store);
      await h.command(
        m.cookie,
        `/shops/${m.shopId}/shopify/connections/${connectionId}/locations`,
        { connectionId, locations: [{ shopifyLocationId: '1001', locationId: m.locationId }] },
      );
      await h.flushTogether(m.shopId);
      const made = await h.item(m, 'Booster box', code, { price: '12.00' });
      const res = await h.command(
        m.cookie,
        `/shops/${m.shopId}/products/${made.productId}/shopify-listing`,
        { productId: made.productId, status: 'active' },
      );
      expect(res.status, await res.clone().text()).toBe(200);
      return { m, store, connectionId, made };
    }

    it('does not adopt someone else’s product carrying the SKU', async () => {
      const code = `BOX-${uuidv7().slice(-6)}`;
      const s = await listed('Taken SKU', code);
      s.store.addProduct({
        title: 'Merchant’s own bundle',
        variants: [
          { sku: code, price: '30.00' },
          { sku: `OTHER-${uuidv7().slice(-6)}`, price: '5.00' },
        ],
      });
      const calls = s.store.productCalls.length;
      expect(await publishListing(h.deps(), s.m.shopId, s.connectionId, s.made.productId)).toBe(
        'failed',
      );
      expect(s.store.productCalls.length).toBe(calls);
      const [listing] = await ownerQuery<{ state: string; last_error: string; product: string }>(
        `select state, last_error, shopify_product_id as product from shopify_listings
         where shop_id = $1`,
        [s.m.shopId],
      );
      expect(listing).toMatchObject({ state: 'failed', product: null });
      expect(listing?.last_error).toContain(code);
      const maps = await ownerQuery('select 1 from shopify_variant_maps where shop_id = $1', [
        s.m.shopId,
      ]);
      expect(maps).toEqual([]);
    });

    it('adopts the product an earlier attempt created, and shows where it differs', async () => {
      const code = `BOX-${uuidv7().slice(-6)}`;
      const s = await listed('Crashed create', code);
      // The earlier attempt created the product, then the Worker stopped; the item has been
      // renamed in Airstock since.
      s.store.addProduct({
        title: 'Booster box (old name)',
        variants: [{ sku: code, price: '12.00' }],
      });
      expect(await publishListing(h.deps(), s.m.shopId, s.connectionId, s.made.productId)).toBe(
        'adopted',
      );
      const differences = await ownerQuery<{ field: string; shopify: unknown }>(
        'select field, shopify from shopify_listing_differences where shop_id = $1',
        [s.m.shopId],
      );
      expect(differences).toEqual([{ field: 'title', shopify: 'Booster box (old name)' }]);
      const [map] = await ownerQuery<{ variant_id: string }>(
        'select variant_id from shopify_variant_maps where shop_id = $1',
        [s.m.shopId],
      );
      expect(map?.variant_id).toBe(s.made.variantId);
    });
  });
});
