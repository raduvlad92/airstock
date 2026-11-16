import { uuidv7 } from '@airstock/core';
import { pushAvailability, reconcileConnection, type ShopifyVariant } from '@airstock/shopify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../../test/helpers.ts';
import type { FakeStore } from './fake-shopify.ts';
import { type Merchant, type ShopifyHarness, shopifyHarness } from './shopify-harness.ts';

// I6, part 3: the batched push and the reconciler (plan Section 5.14, D18). Each case uses its own
// shop and store, and drains only its own outbox rows.

let h: ShopifyHarness;
beforeAll(async () => {
  h = await shopifyHarness();
});
afterAll(() => h.t.close());

interface Setup {
  m: Merchant;
  store: FakeStore;
  connectionId: string;
  items: Array<{ variantId: string; shopify: ShopifyVariant }>;
}

const NAMES = ['mug', 'teapot', 'kettle'];

/** A shop whose items (with stock) are each sold by one Shopify variant at "Shop location". */
async function setup(name: string, stocks: number[]): Promise<Setup> {
  const m = await h.merchant(name);
  const store = h.newStore('push');
  const items: Setup['items'] = [];
  for (const [i, stock] of stocks.entries()) {
    const sku = `${name.replace(/\W/g, '').slice(0, 6).toUpperCase()}-${i}-${uuidv7().slice(-6)}`;
    const made = await h.item(m, `${name} ${NAMES[i]}`, sku);
    if (stock > 0) await h.receive(m, made.variantId, stock);
    const [shopify] = store.addProduct({
      title: `${name} ${NAMES[i]}`,
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

async function reconcile(s: Setup, daily = false) {
  return reconcileConnection(h.deps(), s.m.shopId, s.connectionId, { daily });
}

async function alerts(s: Setup) {
  return ownerQuery<{ kind: string; status: string; resolution: string | null; details: object }>(
    `select kind, status, resolution, details from alerts where shop_id = $1 order by opened_at`,
    [s.m.shopId],
  );
}

describe('Shopify push', () => {
  it('pushes many changes in one compare-and-set call', async () => {
    const s = await setup('Batch', [1, 1, 1]);
    const calls = s.store.setCalls.length;
    for (const i of s.items) await h.receive(s.m, i.variantId, 4);
    const outcomes = await h.flushTogether(s.m.shopId);
    expect(outcomes.map((o) => o.outcome)).toEqual(['pushed', 'pushed', 'pushed']);
    // Three receipts, three levels, one call.
    expect(s.store.setCalls.slice(calls)).toEqual([3]);
    for (const i of s.items) expect(s.store.available(i.shopify)).toBe(5);
    const events = await ownerQuery<{ count: number }>(
      `select count(*)::int as count from audit_events
       where shop_id = $1 and action = 'shopify.inventory.pushed'`,
      [s.m.shopId],
    );
    expect(events[0]?.count).toBe(6);
  });

  it('a refused quantity in a batch: an unseen order explains it, then all are written', async () => {
    const s = await setup('Stale', [5, 5]);
    // Shopify accepts an order for the first item; its webhook has not arrived.
    const order = s.store.placeOrder([{ variant: s.items[0]!.shopify, quantity: 2 }]);
    for (const i of s.items) await h.receive(s.m, i.variantId, 1);
    const refused = s.store.refused.length;
    const outcomes = await h.flushTogether(s.m.shopId);
    expect(outcomes.map((o) => o.outcome)).toEqual(['pushed', 'pushed']);
    // The batch was refused once for the first item (Shopify held 3, not 5), nothing applied; the
    // order was processed, and the retry wrote both.
    expect(s.store.refused.slice(refused)).toEqual([
      { item: s.items[0]!.shopify.inventoryItemId, location: '1001', from: 5, actual: 3 },
    ]);
    expect(s.store.available(s.items[0]!.shopify)).toBe(4);
    expect(s.store.available(s.items[1]!.shopify)).toBe(6);
    const [line] = await ownerQuery<{ outcome: string }>(
      'select outcome from shopify_order_lines where shop_id = $1 and shopify_order_id = $2',
      [s.m.shopId, order.orderId],
    );
    expect(line?.outcome).toBe('reserved');
    expect(await alerts(s)).toEqual([]);
  });

  it('a throttled write fails as retryable and the next run pushes', async () => {
    const s = await setup('Throttle', [2]);
    await h.receive(s.m, s.items[0]!.variantId, 3);
    s.store.throttleNext = 1;
    await expect(h.flushTogether(s.m.shopId)).rejects.toMatchObject({
      code: 'THROTTLED',
      retryable: true,
    });
    expect(s.store.available(s.items[0]!.shopify)).toBe(2);
    // The queue retries the message: the same levels again.
    await pushAvailability(h.deps(), s.m.shopId, {
      variantId: s.items[0]!.variantId,
      locationIds: [s.m.locationId],
    });
    expect(s.store.available(s.items[0]!.shopify)).toBe(5);
  });
});

describe('Shopify reconciler', () => {
  it('A30: finds an order whose webhooks never came, and its cancellation', async () => {
    const s = await setup('Missed', [6]);
    const order = s.store.placeOrder([{ variant: s.items[0]!.shopify, quantity: 2 }]);
    const first = await reconcile(s);
    expect(first).toMatchObject({ orders: 1, ordersApplied: 1, conflicts: 0 });
    expect(await h.available(s.m, s.items[0]!.variantId)).toBe('4.000000');
    expect(s.store.available(s.items[0]!.shopify)).toBe(4);
    // A later run reads it again (the cursor overlaps) and changes nothing.
    const second = await reconcile(s);
    expect(second).toMatchObject({ ordersApplied: 0, conflicts: 0, pushed: 0 });
    s.store.cancel(order);
    expect(await reconcile(s)).toMatchObject({ ordersApplied: 1, conflicts: 0 });
    expect(await h.available(s.m, s.items[0]!.variantId)).toBe('6.000000');
    expect(s.store.available(s.items[0]!.shopify)).toBe(6);
    expect(s.store.refused).toHaveLength(0);
    const [conn] = await ownerQuery<{ reconciled_at: Date | null; synced: Date | null }>(
      `select reconciled_at, orders_synced_through as synced from shopify_connections
       where shop_id = $1`,
      [s.m.shopId],
    );
    expect(conn?.reconciled_at).not.toBeNull();
    expect(conn?.synced).not.toBeNull();
  });

  it('an unexplained quantity is a conflict: an alert, a webhook event, Shopify left alone', async () => {
    const s = await setup('Conflict', [4]);
    const item = s.items[0]!;
    // A webhook subscription for sync conflicts.
    const [membership] = await ownerQuery<{ id: string }>(
      'select id from memberships where shop_id = $1 limit 1',
      [s.m.shopId],
    );
    await ownerQuery(
      `insert into webhook_subscriptions (shop_id, id, name, url, event_types, secret_key_id,
         secret_ciphertext, secret_hint, created_by_membership_id)
       values ($1, $2, 'n8n', 'https://n8n.example.com/hook', '{shopify.sync_conflict}', 'k1',
         'x', 'abcd', $3)`,
      [s.m.shopId, uuidv7(), membership!.id],
    );
    // Someone sets 9 in the Shopify admin.
    s.store.levels.set(s.store.key(item.shopify.inventoryItemId, '1001'), 9);
    expect(await reconcile(s, true)).toMatchObject({ levelsCompared: 1, conflicts: 1 });
    expect(await alerts(s)).toEqual([
      {
        kind: 'shopify_sync',
        status: 'open',
        resolution: null,
        details: expect.objectContaining({
          kind: 'quantity',
          expected: 4,
          airstock: 4,
          shopify: 9,
        }),
      },
    ]);
    const [webhook] = await ownerQuery<{ payload: { type: string; input: { data: object } } }>(
      `select payload from outbox_events where shop_id = $1 and topic = 'webhook.event'`,
      [s.m.shopId],
    );
    expect(webhook?.payload.type).toBe('shopify.sync_conflict');
    expect(webhook?.payload.input.data).toMatchObject({
      conflict: { sku: expect.any(String), airstock: 4, shopify: 9 },
    });
    // While it is open, Airstock's changes are not pushed: Shopify keeps what the person set.
    await h.receive(s.m, item.variantId, 1);
    expect((await h.flushTogether(s.m.shopId)).map((o) => o.outcome)).toEqual(['conflict']);
    expect(s.store.available(item.shopify)).toBe(9);
    // The same difference again is not a new alert.
    expect(await reconcile(s, true)).toMatchObject({ conflicts: 0 });
    expect(await alerts(s)).toHaveLength(1);
    // The person puts Shopify back: the conflict is explained, and Airstock's 5 is pushed.
    s.store.levels.set(s.store.key(item.shopify.inventoryItemId, '1001'), 4);
    expect(await reconcile(s)).toMatchObject({ explained: 1, pushed: 1 });
    expect(await alerts(s)).toMatchObject([{ status: 'resolved', resolution: 'explained' }]);
    expect(s.store.available(item.shopify)).toBe(5);
  });

  it('a lower Shopify quantity from an order placed during the check is not a conflict', async () => {
    const s = await setup('Racing', [5]);
    // Shopify sold 1; the webhook is late, and Shopify's search by update time does not list the
    // order yet: the daily comparison sees 4 against a record of 5.
    const order = s.store.placeOrder([{ variant: s.items[0]!.shopify, quantity: 1 }]);
    s.store.searchLag.add(order.orderId);
    // The comparison processes orders created since the record before calling it a conflict.
    const result = await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, {
      daily: true,
    });
    expect(result).toMatchObject({ conflicts: 0 });
    expect(await alerts(s)).toEqual([]);
    expect(await h.available(s.m, s.items[0]!.variantId)).toBe('4.000000');
  });
});
