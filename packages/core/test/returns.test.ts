import { type Caller, ops, uuidv7, WEBHOOK_EVENT_TYPES } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  appDatabase,
  createLeafLocation,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
  ownerQuery,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';
import { reconcileAll } from './documents-helpers.ts';

// Milestone I2 returns (plan D9, PRD 6.5): A07, the return half of A38, cost re-entry at the
// fulfillment cost, lots, disposal, shortages, one-of-a-kind items, location scope (A42), shop
// isolation (A13), and return.status_changed events.

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let dock: string; // a returns shelf in a second warehouse
let dockWarehouse: string;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
  const wh = await h.run(ops.createWarehouse, { name: 'Returns centre' });
  dockWarehouse = wh.warehouseId;
  dock = await createLeafLocation(h, dockWarehouse, 'Dock');
});
afterAll(() => db.close());

/** A variant with stock that was sold: `sold` units fulfilled for `orderRef`. */
async function sold(orderRef: string, sold = '6', received = '10', cost = '4'): Promise<string> {
  const variantId = await createVariant(h);
  await h.run(ops.receiveStock, {
    variantId,
    locationId: shop.locationId,
    quantity: received,
    unitCost: cost,
  });
  const r = await h.run(ops.reserveStock, { variantId, quantity: sold, externalRef: orderRef });
  await h.run(ops.fulfillReservation, { reservationId: r.reservationId });
  return variantId;
}

async function stock(variantId: string, caller?: Caller) {
  return h.run(ops.getAvailability, { variantId }, caller ? { caller } : {});
}

describe('a return of six, four released after inspection (A07)', () => {
  it('quarantines all six, releases four to sellable and keeps two damaged, with no refund', async () => {
    const orderRef = `ORD-${uuidv7().slice(-6)}`;
    const variantId = await sold(orderRef);
    const created = await h.run(ops.createReturn, {
      lines: [{ variantId, quantity: '6' }],
      orderRef,
      reason: 'Wrong size',
    });
    expect(created.return).toMatchObject({ status: 'requested', orderRef });
    // Neither the request nor the authorization changes stock.
    const before = await stock(variantId);
    await h.run(ops.authorizeReturn, { returnId: created.return.returnId });
    await h.run(ops.markReturnInTransit, {
      returnId: created.return.returnId,
      trackingReference: 'TRACK-1',
    });
    expect((await stock(variantId)).totals).toEqual(before.totals);

    const received = await h.run(ops.receiveReturn, {
      returnId: created.return.returnId,
      locationId: dock,
    });
    expect(received.return).toMatchObject({
      status: 'received',
      location: { locationId: dock },
      totals: { received: '6.000000', uninspected: '6.000000' },
    });
    let view = await stock(variantId);
    expect(view.totals).toMatchObject({
      quarantined: '6.000000',
      available: '4.000000',
      ownedTotal: '10.000000',
    });

    const inspected = await h.run(ops.inspectReturn, {
      returnId: created.return.returnId,
      inspections: [
        { variantId, disposition: 'sellable', quantity: '4' },
        { variantId, disposition: 'damaged', note: 'Torn box' },
      ],
    });
    expect(inspected.return).toMatchObject({
      status: 'completed',
      totals: { sellable: '4.000000', damaged: '2.000000', uninspected: '0.000000' },
    });
    view = await stock(variantId);
    expect(view.totals).toMatchObject({
      quarantined: '0.000000',
      damaged: '2.000000',
      available: '8.000000',
      ownedTotal: '10.000000',
    });
    await expect(
      h.run(ops.inspectReturn, {
        returnId: created.return.returnId,
        inspections: [{ variantId, disposition: 'sellable', quantity: '1' }],
      }),
    ).rejects.toMatchObject({ code: 'return_closed' });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('re-enters valuation at the fulfillment cost, or the average when it cannot be traced', async () => {
    const orderRef = `ORD-${uuidv7().slice(-6)}`;
    const variantId = await sold(orderRef, '6', '10', '4');
    // The average moves after the sale: 4 left at €4, 4 more at €10 → €7.
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '4',
      unitCost: '10',
    });
    const traced = await h.run(ops.createReturn, {
      lines: [{ variantId, quantity: '2' }],
      orderRef,
      authorize: true,
    });
    const r1 = await h.run(ops.receiveReturn, {
      returnId: traced.return.returnId,
      locationId: dock,
    });
    expect(r1.return.lines[0].units).toEqual([
      expect.objectContaining({ costSource: 'fulfillment', unitCost: '4.000000' }),
    ]);
    // 8 at €7 plus 2 back at €4 → €6.40.
    const [cost] = await ownerQuery<{ average_cost: string }>(
      'select average_cost::text from variant_costs where variant_id = $1',
      [variantId],
    );
    expect(cost!.average_cost).toBe('6.400000');
    const untraced = await h.run(ops.createReturn, {
      lines: [{ variantId, quantity: '1' }],
      orderRef: 'UNKNOWN-ORDER',
    });
    const r2 = await h.run(ops.receiveReturn, {
      returnId: untraced.return.returnId,
      locationId: dock,
    });
    expect(r2.return.lines[0].units[0]).toMatchObject({
      costSource: 'average',
      unitCost: '6.400000',
    });
    // Without costs.read the cost is hidden.
    const viewer = await addMember(shop.shopId, 'inventory_operator');
    const seen = await h.run(
      ops.getReturn,
      { returnId: untraced.return.returnId },
      { caller: viewer.caller },
    );
    expect(seen.lines[0].units[0].unitCost).toBeNull();
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('closes a partial return early, and cancels one that never arrives', async () => {
    const orderRef = `ORD-${uuidv7().slice(-6)}`;
    const variantId = await sold(orderRef, '3');
    const partial = await h.run(ops.createReturn, {
      lines: [{ variantId, quantity: '3' }],
      orderRef,
    });
    const returnId = partial.return.returnId;
    await h.run(ops.receiveReturn, {
      returnId,
      locationId: dock,
      items: [{ variantId, quantity: '2' }],
    });
    await expect(
      h.run(ops.receiveReturn, { returnId, items: [{ variantId, quantity: '2' }] }),
    ).rejects.toMatchObject({ code: 'quantity_exceeds_expected' });
    await expect(h.run(ops.completeReturn, { returnId })).rejects.toMatchObject({
      code: 'inspection_pending',
    });
    const inspected = await h.run(ops.inspectReturn, {
      returnId,
      inspections: [{ variantId, disposition: 'sellable' }],
    });
    expect(inspected.return.status).toBe('inspecting');
    await expect(h.run(ops.cancelReturn, { returnId })).rejects.toMatchObject({
      code: 'return_received',
    });
    const done = await h.run(ops.completeReturn, { returnId });
    expect(done.return).toMatchObject({ status: 'completed', closed: true });

    const never = await h.run(ops.createReturn, { lines: [{ variantId, quantity: '1' }] });
    const cancelled = await h.run(ops.cancelReturn, { returnId: never.return.returnId });
    expect(cancelled.return.status).toBe('cancelled');
    await expect(
      h.run(ops.receiveReturn, { returnId: never.return.returnId, locationId: dock }),
    ).rejects.toMatchObject({ code: 'return_closed' });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});

describe('serials and lots on returns (A38 return half)', () => {
  it('takes back a fulfilled serial, flags one never fulfilled here, and refuses one in stock', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'serial' });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '2',
      serials: ['RS-1', 'RS-2'],
      unitCost: '50',
    });
    const order = await h.run(ops.reserveStock, {
      variantId,
      quantity: '1',
      externalRef: 'ORDER-S',
    });
    const shipped = order.allocations[0].serialId as string;
    await h.run(ops.fulfillReservation, { reservationId: order.reservationId });
    const [{ serial } = { serial: '' }] = await ownerQuery<{ serial: string }>(
      'select serial from serial_units where id = $1',
      [shipped],
    );
    const kept = serial === 'RS-1' ? 'RS-2' : 'RS-1';

    const ret = await h.run(ops.createReturn, {
      lines: [{ variantId, quantity: '2' }],
      orderRef: 'ORDER-S',
    });
    const returnId = ret.return.returnId;
    await expect(h.run(ops.receiveReturn, { returnId, locationId: dock })).rejects.toMatchObject({
      code: 'serials_required',
    });
    await expect(
      h.run(ops.receiveReturn, {
        returnId,
        locationId: dock,
        items: [{ variantId, serials: [kept] }],
      }),
    ).rejects.toMatchObject({ code: 'serial_in_stock' });
    const received = await h.run(ops.receiveReturn, {
      returnId,
      locationId: dock,
      items: [{ variantId, serials: [serial.toLowerCase(), 'RS-STRANGER'] }],
    });
    expect(received.flagged).toEqual([{ variantId, serial: 'RS-STRANGER' }]);
    expect(received.return.status).toBe('exception');
    expect(received.return.lines[0].units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serial,
          matched: true,
          costSource: 'fulfillment',
          unitCost: '50.000000',
        }),
        expect.objectContaining({ serial: 'RS-STRANGER', matched: false, costSource: 'average' }),
      ]),
    );
    const history = await h.run(ops.serialHistory, { variantId, serial });
    expect(history).toMatchObject({
      status: 'in_stock',
      current: { locationId: dock, condition: 'quarantine' },
    });
    expect(history.movements.map((m: { kind: string }) => m.kind)).toEqual([
      'receipt',
      'fulfillment',
      'return',
    ]);
    // After review, the flag is cleared; the sold serial goes back on sale, the stranger is
    // written off.
    await expect(h.run(ops.completeReturn, { returnId })).rejects.toMatchObject({
      code: 'inspection_pending',
    });
    await h.run(ops.setReturnException, {
      returnId,
      note: 'Stranger serial checked: not ours, scrap it.',
      open: false,
    });
    const inspected = await h.run(ops.inspectReturn, {
      returnId,
      inspections: [
        { variantId, disposition: 'sellable', serials: [serial] },
        { variantId, disposition: 'disposal', serials: ['RS-STRANGER'] },
      ],
    });
    expect(inspected.return.status).toBe('completed');
    const back = await h.run(ops.serialHistory, { variantId, serial });
    expect(back).toMatchObject({ status: 'in_stock', current: { condition: 'sellable' } });
    const stranger = await h.run(ops.serialHistory, { variantId, serial: 'RS-STRANGER' });
    expect(stranger.status).toBe('written_off');
    expect((await stock(variantId)).totals).toMatchObject({
      available: '2.000000',
      ownedTotal: '2.000000',
    });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('needs the lot of lot-tracked units, which must be one this shop received', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'lot_expiry' });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '5',
      lotCode: 'L-RET',
      expiresOn: '2031-05-31',
    });
    const r = await h.run(ops.reserveStock, { variantId, quantity: '3', externalRef: 'ORD-L' });
    await h.run(ops.fulfillReservation, { reservationId: r.reservationId });
    const ret = await h.run(ops.createReturn, {
      lines: [{ variantId, quantity: '3' }],
      orderRef: 'ORD-L',
    });
    const returnId = ret.return.returnId;
    await expect(h.run(ops.receiveReturn, { returnId, locationId: dock })).rejects.toMatchObject({
      code: 'lot_required',
    });
    await expect(
      h.run(ops.receiveReturn, {
        returnId,
        locationId: dock,
        items: [{ variantId, lotCode: 'NOPE' }],
      }),
    ).rejects.toMatchObject({ code: 'unknown_lot' });
    await h.run(ops.receiveReturn, {
      returnId,
      locationId: dock,
      items: [{ variantId, lotCode: 'l-ret' }],
    });
    await h.run(ops.inspectReturn, {
      returnId,
      inspections: [
        { variantId, disposition: 'repair', quantity: '1' },
        { variantId, disposition: 'supplier_return', quantity: '1' },
        { variantId, disposition: 'disposal', quantity: '1' },
      ],
    });
    const view = await stock(variantId);
    expect(view.totals).toMatchObject({
      repair: '1.000000',
      supplierReturn: '1.000000',
      ownedTotal: '4.000000',
      available: '2.000000',
    });
    const trace = await h.run(ops.traceLot, { variantId, lotCode: 'L-RET' });
    expect(trace.movements.map((m: { kind: string }) => m.kind)).toEqual(
      expect.arrayContaining([
        'receipt',
        'fulfillment',
        'return',
        'condition_change',
        'adjustment',
      ]),
    );
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});

describe('one of a kind and shortages', () => {
  it('puts a returned one-of-a-kind item back from sold to in stock', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, oneOfAKind: true });
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '1' });
    const r = await h.run(ops.reserveStock, { variantId, quantity: '1', externalRef: 'ORD-1K' });
    await h.run(ops.fulfillReservation, { reservationId: r.reservationId });
    const [before] = await ownerQuery<{ status: string }>(
      'select p.status from products p join variants v on v.product_id = p.id where v.id = $1',
      [variantId],
    );
    expect(before!.status).toBe('sold');
    const ret = await h.run(ops.createReturn, {
      lines: [{ variantId, quantity: '1' }],
      orderRef: 'ORD-1K',
    });
    await h.run(ops.receiveReturn, { returnId: ret.return.returnId, locationId: dock });
    const [after] = await ownerQuery<{ status: string }>(
      'select p.status from products p join variants v on v.product_id = p.id where v.id = $1',
      [variantId],
    );
    expect(after!.status).toBe('active');
  });

  it('fills an open order shortage when inspected units become sellable', async () => {
    const orderRef = `ORD-${uuidv7().slice(-6)}`;
    const variantId = await sold(orderRef, '2', '2');
    const [m] = await ownerQuery<{ id: string }>(
      'select id from memberships where shop_id = $1 and user_id = $2',
      [shop.shopId, shop.userId],
    );
    const connector: Caller = {
      kind: 'connector',
      id: uuidv7(),
      userId: null,
      boundShopId: shop.shopId,
      membership: {
        id: m!.id,
        role: 'inventory_operator',
        allLocations: true,
        locationScopeIds: [],
        permissions: new Set(['inventory.read', 'inventory.reserve']),
      },
      scopes: new Set(['inventory:read', 'inventory:write']),
      source: 'shopify',
    };
    const short = await h.run(
      ops.reserveStock,
      { variantId, quantity: '1', allowShortage: true },
      { caller: connector },
    );
    expect(short.shortage).toBe('1');
    const ret = await h.run(ops.createReturn, { lines: [{ variantId, quantity: '2' }], orderRef });
    await h.run(ops.receiveReturn, { returnId: ret.return.returnId, locationId: dock });
    const inspected = await h.run(ops.inspectReturn, {
      returnId: ret.return.returnId,
      inspections: [{ variantId, disposition: 'sellable' }],
    });
    expect(inspected.shortagesFilled).toEqual([
      { reservationId: short.reservationId, quantity: '1' },
    ]);
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});

describe('location scope (A42) and isolation (A13)', () => {
  it('receives and inspects only at locations in the member’s scope', async () => {
    const orderRef = `ORD-${uuidv7().slice(-6)}`;
    const variantId = await sold(orderRef, '2');
    const main = await addMember(shop.shopId, 'inventory_operator', [shop.warehouseId]);
    const docker = await addMember(shop.shopId, 'inventory_operator', [dockWarehouse]);
    const ret = await h.run(
      ops.createReturn,
      { lines: [{ variantId, quantity: '2' }], orderRef },
      { caller: main.caller },
    );
    const returnId = ret.return.returnId;
    await expect(
      h.run(ops.receiveReturn, { returnId, locationId: dock }, { caller: main.caller }),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
    await h.run(ops.receiveReturn, { returnId, locationId: dock }, { caller: docker.caller });
    await expect(
      h.run(
        ops.inspectReturn,
        { returnId, inspections: [{ variantId, disposition: 'sellable' }] },
        { caller: main.caller },
      ),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
    await expect(h.run(ops.getReturn, { returnId }, { caller: main.caller })).rejects.toMatchObject(
      { code: 'not_found' },
    );
    const listed = await h.run(ops.listReturns, { orderRef }, { caller: docker.caller });
    expect(listed.returns.map((r: { returnId: string }) => r.returnId)).toEqual([returnId]);
    const viewer = await addMember(shop.shopId, 'viewer');
    await expect(
      h.run(ops.createReturn, { lines: [{ variantId, quantity: '1' }] }, { caller: viewer.caller }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('never reaches another shop’s return or variant', async () => {
    const other = await seedShop(db, sink, 'Other returns shop');
    const ho = harness(db, sink, other);
    const theirs = await createVariant(ho);
    const ret = await ho.run(ops.createReturn, { lines: [{ variantId: theirs, quantity: '1' }] });
    await expect(h.run(ops.getReturn, { returnId: ret.return.returnId })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      h.run(ops.receiveReturn, { returnId: ret.return.returnId, locationId: dock }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      h.run(ops.createReturn, { lines: [{ variantId: theirs, quantity: '1' }] }),
    ).rejects.toMatchObject({ status: 404 });
    const [count] = await ownerQuery<{ n: string }>(
      'select count(*)::text as n from returns where shop_id = $1',
      [other.shopId],
    );
    expect(count!.n).toBe('1');
  });
});

describe('webhooks (D14)', () => {
  it('emits return.status_changed with each status change, in the same transaction', async () => {
    const own = await seedShop(db, sink, 'Return webhooks shop');
    const ho = harness(db, sink, own);
    await ownerQuery(
      `insert into webhook_subscriptions (shop_id, id, name, url, event_types, secret_key_id,
         secret_ciphertext, secret_hint)
       values ($1, $2, 'n8n', 'https://hooks.example.test/r', array['return.status_changed'],
         'k1', 'x', 'abcd')`,
      [own.shopId, uuidv7()],
    );
    const variantId = await createVariant(ho);
    await ho.run(ops.receiveStock, { variantId, locationId: own.locationId, quantity: '3' });
    const r = await ho.run(ops.reserveStock, { variantId, quantity: '3', externalRef: 'W-1' });
    await ho.run(ops.fulfillReservation, { reservationId: r.reservationId });
    const ret = await ho.run(ops.createReturn, {
      lines: [{ variantId, quantity: '3' }],
      orderRef: 'W-1',
      authorize: true,
    });
    await ho.run(ops.receiveReturn, { returnId: ret.return.returnId, locationId: own.locationId });
    await ho.run(ops.inspectReturn, {
      returnId: ret.return.returnId,
      inspections: [{ variantId, disposition: 'sellable' }],
    });
    const rows = await ownerQuery<{
      payload: { type: string; input: { returnId: string; from: string | null; to: string } };
    }>(
      `select payload from outbox_events where shop_id = $1 and topic = 'webhook.event'
       order by created_at, id`,
      [own.shopId],
    );
    expect(rows.map((x) => [x.payload.input.from, x.payload.input.to])).toEqual([
      [null, 'authorized'],
      ['authorized', 'received'],
      ['received', 'completed'],
    ]);
    const type = WEBHOOK_EVENT_TYPES.find((t) => t.id === 'return.status_changed')!;
    const built = await db.transaction({ shopId: own.shopId, userId: null }, (tx) =>
      type.build(tx, rows[2]!.payload.input),
    );
    expect(type.data.safeParse(built?.data).success).toBe(true);
    expect(built).toMatchObject({
      data: { return: { status: 'completed', totals: { sellable: '3.000000' } } },
      locationIds: [own.locationId],
    });
  });
});
