import { uuidv7 } from '@airstock/core';
import type { ShopifyVariant } from '@airstock/shopify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../../test/helpers.ts';
import type { FakeStore } from './fake-shopify.ts';
import { json } from './setup.ts';
import { type Merchant, type ShopifyHarness, shopifyHarness } from './shopify-harness.ts';

// I6, part 2: the order lifecycle (PRD 8.5). Every case checks Airstock's stock and that Shopify
// shows Airstock's availability without a refused write: Shopify's own changes (an order taking
// units, an edit or a restock giving them back) are explained, never called conflicts.

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
async function setup(name: string, stock: number, oneOfAKind = false): Promise<Setup> {
  const m = await h.merchant(name);
  const sku = `${name.replace(/\W/g, '').slice(0, 8).toUpperCase()}-${uuidv7().slice(-6)}`;
  const made = await h.item(m, name, sku);
  if (oneOfAKind) {
    await ownerQuery('update variants set one_of_a_kind = true where id = $1', [made.variantId]);
  }
  if (stock > 0) await h.receive(m, made.variantId, stock);
  const store = h.newStore('orders');
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

async function reservations(s: Setup) {
  return ownerQuery<{ quantity: string; status: string; shortage: string }>(
    `select quantity::text, status, shortage_quantity::text as shortage from reservations
     where shop_id = $1 and variant_id = $2 order by created_at, id`,
    [s.m.shopId, s.variantId],
  );
}

describe('Shopify order lifecycle', () => {
  it('edits: more reserves more, less releases the newest first; Shopify stays in step', async () => {
    const s = await setup('Edit mug', 10);
    const order = s.store.placeOrder([{ variant: s.item, quantity: 2 }]);
    await event(s, 'orders/create', s.store.webhookBody(order));
    expect(await h.available(s.m, s.variantId)).toBe('8.000000');
    const line = order.lines[0]!;

    s.store.editLine(order, line.lineId, 5);
    await event(s, 'orders/edited', s.store.topicBody('orders/edited', order));
    expect(await h.available(s.m, s.variantId)).toBe('5.000000');
    expect((await reservations(s)).map((r) => r.quantity)).toEqual(['2.000000', '3.000000']);

    s.store.editLine(order, line.lineId, 1);
    await event(s, 'orders/edited', s.store.topicBody('orders/edited', order));
    expect(await h.available(s.m, s.variantId)).toBe('9.000000');
    // The newest reservation (3) went first, then 1 of the first.
    expect((await reservations(s)).map((r) => r.status)).toEqual(['active', 'released']);
    expect(s.store.available(s.item)).toBe(9);
    expect(s.store.refused).toHaveLength(0);
  });

  it('cancelled: releases what is still open; Shopify’s restock is explained', async () => {
    const s = await setup('Cancel mug', 6);
    const order = s.store.placeOrder([{ variant: s.item, quantity: 4 }]);
    await event(s, 'orders/create', s.store.webhookBody(order));
    expect(await h.available(s.m, s.variantId)).toBe('2.000000');
    s.store.cancel(order);
    expect(s.store.available(s.item)).toBe(6);
    await event(s, 'orders/cancelled', s.store.topicBody('orders/cancelled', order));
    expect(await h.available(s.m, s.variantId)).toBe('6.000000');
    expect((await reservations(s)).map((r) => r.status)).toEqual(['released']);
    expect(s.store.available(s.item)).toBe(6);
    expect(s.store.refused).toHaveLength(0);
  });

  it('A41: a fulfillment from Shopify fulfills here; a sold one-of-a-kind item drops to zero', async () => {
    const s = await setup('Graded card', 1, true);
    const order = s.store.placeOrder([{ variant: s.item, quantity: 1 }]);
    await event(s, 'orders/create', s.store.webhookBody(order));
    const f = s.store.fulfill(order);
    await event(
      s,
      'fulfillments/create',
      s.store.topicBody('fulfillments/create', order, f.fulfillmentId),
    );
    expect(await onHand(s)).toEqual({ on_hand: '0.000000', allocated: '0.000000' });
    expect((await reservations(s)).map((r) => r.status)).toEqual(['fulfilled']);
    const [product] = await ownerQuery<{ status: string }>(
      'select status from products where id = $1',
      [s.productId],
    );
    expect(product?.status).toBe('sold');
    expect(s.store.available(s.item)).toBe(0);
    // The history names the Shopify fulfillment.
    const [op] = await ownerQuery<{ external_ref: string; source: string }>(
      `select external_ref, source from inventory_operations where shop_id = $1 and kind = 'fulfillment'`,
      [s.m.shopId],
    );
    expect(op).toEqual({
      external_ref: `shopify:fulfillment/${f.fulfillmentId}`,
      source: 'shopify',
    });
  });

  it('fulfills at the fulfilling location, reallocating there first', async () => {
    const s = await setup('Two shelf mug', 3);
    // A second warehouse mapped to Shopify's "Warehouse", with 5 more units.
    const warehouse = await json(
      await h.command(s.m.cookie, `/shops/${s.m.shopId}/warehouses`, { name: 'Back store' }),
    );
    const shelf = await json(
      await h.command(s.m.cookie, `/shops/${s.m.shopId}/locations`, {
        warehouseId: warehouse.warehouseId,
        name: 'Shelf B',
      }),
    );
    await h.receive(s.m, s.variantId, 5, { locationId: shelf.locationId });
    // The item is stocked at Shopify's warehouse too.
    s.store.levels.set(s.store.key(s.item.inventoryItemId, '1002'), 0);
    const base = `/shops/${s.m.shopId}/shopify/connections/${s.connectionId}`;
    await h.command(s.m.cookie, `${base}/locations`, {
      connectionId: s.connectionId,
      locations: [
        { shopifyLocationId: '1001', locationId: s.m.locationId },
        { shopifyLocationId: '1002', warehouseId: warehouse.warehouseId },
      ],
    });
    await h.flush(s.m.shopId);
    expect(s.store.available(s.item, '1002')).toBe(5);
    // Sold at the shop: reserved there (first in the connection's rule).
    const order = s.store.placeOrder([{ variant: s.item, quantity: 2 }]);
    await event(s, 'orders/create', s.store.webhookBody(order));
    // Shopify ships it from the warehouse instead.
    const f = s.store.fulfill(order, null, '1002');
    await event(
      s,
      'fulfillments/create',
      s.store.topicBody('fulfillments/create', order, f.fulfillmentId),
    );
    const stock = await ownerQuery<{ location_id: string; on_hand: string; allocated: string }>(
      `select location_id, on_hand::text, allocated::text from inventory_positions
       where shop_id = $1 and variant_id = $2 order by on_hand`,
      [s.m.shopId, s.variantId],
    );
    // 2 left the warehouse shelf; the shop keeps its 3, no longer held.
    expect(Object.fromEntries(stock.map((x) => [x.location_id, [x.on_hand, x.allocated]]))).toEqual(
      {
        [shelf.locationId]: ['3.000000', '0.000000'],
        [s.m.locationId]: ['3.000000', '0.000000'],
      },
    );
    const [moved] = await ownerQuery<{ count: number }>(
      `select count(*)::int as count from inventory_operations where shop_id = $1 and kind = 'reallocation'`,
      [s.m.shopId],
    );
    expect(moved?.count).toBe(1);
  });

  it('a cancelled fulfillment comes back with a compensating receipt and reserves again', async () => {
    const s = await setup('Return mug', 5);
    const order = s.store.placeOrder([{ variant: s.item, quantity: 2 }]);
    await event(s, 'orders/create', s.store.webhookBody(order));
    const f = s.store.fulfill(order);
    await event(
      s,
      'fulfillments/create',
      s.store.topicBody('fulfillments/create', order, f.fulfillmentId),
    );
    expect(await onHand(s)).toEqual({ on_hand: '3.000000', allocated: '0.000000' });
    s.store.cancelFulfillment(order, f.fulfillmentId);
    await event(
      s,
      'fulfillments/update',
      s.store.topicBody('fulfillments/update', order, f.fulfillmentId),
    );
    // The units are back, and held for the order again.
    expect(await onHand(s)).toEqual({ on_hand: '5.000000', allocated: '2.000000' });
    expect((await reservations(s)).map((r) => r.status)).toEqual(['fulfilled', 'active']);
    const [reversal] = await ownerQuery<{ reason: string; reverses: string }>(
      `select o.reason, f.kind as reverses from inventory_operations o
       join inventory_operations f on f.shop_id = o.shop_id and f.id = o.reverses_operation_id
       where o.shop_id = $1 and o.kind = 'reversal'`,
      [s.m.shopId],
    );
    expect(reversal).toEqual({ reason: 'shopify_fulfillment_cancelled', reverses: 'fulfillment' });
    expect(await h.available(s.m, s.variantId)).toBe('3.000000');
    expect(s.store.available(s.item)).toBe(3);
    expect(s.store.refused).toHaveLength(0);
  });

  it('a refund with restock starts a return into quarantine, whatever Shopify restocked', async () => {
    const s = await setup('Refund mug', 5);
    const order = s.store.placeOrder([{ variant: s.item, quantity: 2 }]);
    await event(s, 'orders/create', s.store.webhookBody(order));
    const f = s.store.fulfill(order);
    await event(
      s,
      'fulfillments/create',
      s.store.topicBody('fulfillments/create', order, f.fulfillmentId),
    );
    const refund = s.store.refund(order, [
      { lineId: order.lines[0]!.lineId, quantity: 1, restockType: 'return' },
    ]);
    // Shopify counts the returned unit as available again; Airstock does not until inspection.
    expect(s.store.available(s.item)).toBe(4);
    await event(s, 'refunds/create', s.store.topicBody('refunds/create', order, refund.refundId));
    const [ret] = await ownerQuery<{ status: string; order_ref: string; reference: string }>(
      `select status, order_ref, reference from returns where shop_id = $1`,
      [s.m.shopId],
    );
    expect(ret).toEqual({
      status: 'received',
      order_ref: `shopify:order/${order.orderId}/line/${order.lines[0]!.lineId}`,
      reference: `shopify:refund/${refund.refundId}`,
    });
    const [quarantine] = await ownerQuery<{ on_hand: string }>(
      `select sum(on_hand)::text as on_hand from inventory_positions
       where shop_id = $1 and variant_id = $2 and condition = 'quarantine'`,
      [s.m.shopId, s.variantId],
    );
    expect(quarantine?.on_hand).toBe('1.000000');
    expect(await h.available(s.m, s.variantId)).toBe('3.000000');
    // Shopify is set back to Airstock's 3, and the restock was explained: no refused write.
    expect(s.store.available(s.item)).toBe(3);
    expect(s.store.refused).toHaveLength(0);
    // The same refund again changes nothing.
    await event(s, 'refunds/create', s.store.topicBody('refunds/create', order, refund.refundId));
    const returns = await ownerQuery('select 1 from returns where shop_id = $1', [s.m.shopId]);
    expect(returns).toHaveLength(1);
  });

  it('A29: an order larger than the stock is reserved with a shortage; a receipt fills it', async () => {
    const s = await setup('Short mug', 2);
    const order = s.store.placeOrder([{ variant: s.item, quantity: 2 }]);
    // Shopify oversold: someone else bought the last units in the meantime.
    const other = s.store.placeOrder([{ variant: s.item, quantity: 1 }]);
    await event(s, 'orders/create', s.store.webhookBody(order));
    await event(s, 'orders/create', s.store.webhookBody(other));
    expect((await reservations(s)).map((r) => [r.quantity, r.shortage])).toEqual([
      ['2.000000', '0.000000'],
      ['1.000000', '1.000000'],
    ]);
    // Availability stays at zero, never below, in Airstock and in Shopify.
    expect(await h.available(s.m, s.variantId)).toBe('0.000000');
    expect(s.store.available(s.item)).toBe(0);
    const [line] = await ownerQuery<{ outcome: string }>(
      `select outcome from shopify_order_lines where shop_id = $1 and shopify_order_id = $2`,
      [s.m.shopId, other.orderId],
    );
    expect(line?.outcome).toBe('shortage');
    await h.receive(s.m, s.variantId, 3);
    expect((await reservations(s)).map((r) => r.shortage)).toEqual(['0.000000', '0.000000']);
    await h.flush(s.m.shopId);
    expect(s.store.available(s.item)).toBe(2);
    expect(s.store.refused).toHaveLength(0);
  });

  it('A30: a duplicate fulfillment webhook has no second effect', async () => {
    const s = await setup('Dup mug', 4);
    const order = s.store.placeOrder([{ variant: s.item, quantity: 1 }]);
    await event(s, 'orders/create', s.store.webhookBody(order));
    const f = s.store.fulfill(order);
    const body = s.store.topicBody('fulfillments/create', order, f.fulfillmentId);
    const eventId = uuidv7();
    await event(s, 'fulfillments/create', body, eventId);
    expect(await event(s, 'fulfillments/create', body, eventId)).toEqual([]);
    // The same fulfillment under another event (fulfillments/update) changes nothing either.
    await event(s, 'fulfillments/update', body);
    expect(await onHand(s)).toEqual({ on_hand: '3.000000', allocated: '0.000000' });
    const [ops] = await ownerQuery<{ count: number }>(
      `select count(*)::int as count from inventory_operations where shop_id = $1 and kind = 'fulfillment'`,
      [s.m.shopId],
    );
    expect(ops?.count).toBe(1);
  });

  it('refuses a bad signature on every topic, acknowledges privacy webhooks, keeps shops apart', async () => {
    const a = await setup('Shop A mug', 3);
    const b = await setup('Shop B mug', 3);
    const order = b.store.placeOrder([{ variant: b.item, quantity: 1 }]);
    const bad = await h.deliver(
      b.store.domain,
      'fulfillments/create',
      b.store.topicBody('fulfillments/create', order),
      {
        secret: 'not-the-secret',
      },
    );
    expect(bad.status).toBe(401);
    for (const topic of ['customers/data_request', 'customers/redact', 'shop/redact']) {
      const ok = await h.deliver(
        b.store.domain,
        topic,
        JSON.stringify({ shop_domain: b.store.domain }),
      );
      expect(ok.status).toBe(200);
      const refused = await h.deliver(b.store.domain, topic, '{}', { secret: 'wrong' });
      expect(refused.status).toBe(401);
    }
    // Store B's order and fulfillment touch shop B only (A13).
    await event(b, 'orders/create', b.store.webhookBody(order));
    const f = b.store.fulfill(order);
    await event(
      b,
      'fulfillments/create',
      b.store.topicBody('fulfillments/create', order, f.fulfillmentId),
    );
    expect(await onHand(b)).toEqual({ on_hand: '2.000000', allocated: '0.000000' });
    expect(await onHand(a)).toEqual({ on_hand: '3.000000', allocated: '0.000000' });
    expect(await reservations(a)).toEqual([]);
  });
});
