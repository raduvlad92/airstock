import { type Caller, ops, sweepExpiredReservations, sweepShortages, uuidv7 } from '@airstock/core';
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
  reconcile,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';

// Milestone I1 engine scenarios: A28 (receipt half), A36 (engine half), A37, A38 (receive and
// fulfill), A39, shortages (D6), reallocation, and allocation rules (D3).

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
});
afterAll(() => db.close());

async function tracked(mode: 'lot' | 'lot_expiry' | 'serial', margin?: number): Promise<string> {
  const variantId = await createVariant(h);
  await h.run(ops.setStockSettings, {
    variantId,
    trackingMode: mode,
    ...(margin !== undefined ? { sellByMarginDays: margin } : {}),
  });
  return variantId;
}

async function stock(variantId: string, caller?: Caller) {
  return h.run(ops.getAvailability, { variantId }, caller ? { caller } : {});
}

function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** The Shopify connector's caller shape, bound to this shop (D6: only connectors record shortages). */
async function connector(s: SeededShop): Promise<Caller> {
  const [m] = await ownerQuery<{ id: string }>(
    'select id from memberships where shop_id = $1 and user_id = $2',
    [s.shopId, s.userId],
  );
  return {
    kind: 'connector',
    id: uuidv7(),
    userId: null,
    boundShopId: s.shopId,
    membership: {
      id: m!.id,
      role: 'inventory_operator',
      allLocations: true,
      locationScopeIds: [],
      permissions: new Set(['inventory.read', 'inventory.reserve', 'inventory.fulfill']),
    },
    scopes: new Set(['inventory:read', 'inventory:write']),
    clientId: 'shopify',
    source: 'shopify',
  };
}

describe('receipts in packs (A28, receipt half; G8)', () => {
  it('stores 3 cases of 24 as 72 base units with the pack, its factor, and what was entered', async () => {
    const variantId = await createVariant(h);
    const packs = await h.run(ops.setPacks, {
      variantId,
      packsVersion: 0,
      packs: [{ name: 'Case', quantity: '24' }],
    });
    const caseId = packs.packaging.packs[0].id;
    const res = await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '3',
      packId: caseId,
      unitCost: '48',
      costPer: 'pack',
    });
    expect(res).toMatchObject({
      quantity: '72',
      entered: { packId: caseId, packName: 'Case', packVersion: 1, quantity: '3', factor: '24' },
      unitCost: '2.000000',
    });
    const [entry] = await ownerQuery<{
      delta: string;
      pack_id: string;
      pack_version: number;
      entered_quantity: string;
      conversion_factor: string;
    }>(
      `select delta::text, pack_id, pack_version, entered_quantity::text, conversion_factor::text
       from inventory_entries where operation_id = $1`,
      [res.operationId],
    );
    expect(entry).toEqual({
      delta: '72.000000',
      pack_id: caseId,
      pack_version: 1,
      entered_quantity: '3.000000',
      conversion_factor: '24.000000',
    });
    // Shopify later sells 5 singles and one 6-pack: 61 base units stay, a 6-pack shows 10.
    const singles = await h.run(ops.reserveStock, { variantId, quantity: '5' });
    const sixPack = await h.run(ops.reserveStock, { variantId, quantity: '6' });
    await h.run(ops.fulfillReservation, { reservationId: singles.reservationId });
    await h.run(ops.fulfillReservation, { reservationId: sixPack.reservationId });
    const view = await stock(variantId);
    expect(view.totals.onHand).toBe('61.000000');
    expect(Math.floor(Number(view.totals.available) / 6)).toBe(10);
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('refuses a pack quantity that breaks the variant’s precision', async () => {
    const variantId = await createVariant(h);
    const packs = await h.run(ops.setPacks, {
      variantId,
      packsVersion: 0,
      packs: [{ name: 'Case', quantity: '12' }],
    });
    await expect(
      h.run(ops.receiveStock, {
        variantId,
        locationId: shop.locationId,
        quantity: '1.5',
        packId: packs.packaging.packs[0].id,
      }),
    ).resolves.toMatchObject({ quantity: '18' });
    await expect(
      h.run(ops.receiveStock, {
        variantId,
        locationId: shop.locationId,
        quantity: '0.25',
        packId: packs.packaging.packs[0].id,
      }),
    ).resolves.toMatchObject({ quantity: '3' });
    await expect(
      h.run(ops.receiveStock, {
        variantId,
        locationId: shop.locationId,
        quantity: '0.1',
        packId: packs.packaging.packs[0].id,
      }),
    ).rejects.toMatchObject({ code: 'quantity_precision' });
  });
});

describe('lots and expiry (A37, D4)', () => {
  it('allocates the earliest expiry first, stops selling an expired lot at once, and traces every order', async () => {
    const variantId = await tracked('lot_expiry');
    await expect(
      h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '5' }),
    ).rejects.toMatchObject({ code: 'lot_required' });
    await expect(
      h.run(ops.receiveStock, {
        variantId,
        locationId: shop.locationId,
        quantity: '5',
        lotCode: 'L-1',
      }),
    ).rejects.toMatchObject({ code: 'expiry_required' });
    const late = await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '10',
      lotCode: 'L-LATE',
      expiresOn: day(60),
    });
    const early = await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '4',
      lotCode: 'l-early ',
      expiresOn: day(20),
    });
    expect(early.lot).toMatchObject({ code: 'l-early', expiresOn: day(20) });
    // The same code ignores case and spaces, and the expiry must match.
    await expect(
      h.run(ops.receiveStock, {
        variantId,
        locationId: shop.locationId,
        quantity: '1',
        lotCode: 'L-EARLY',
        expiresOn: day(21),
      }),
    ).rejects.toMatchObject({ code: 'lot_expiry_mismatch' });

    const order1 = await h.run(ops.reserveStock, {
      variantId,
      quantity: '6',
      purpose: 'external_order',
      externalRef: 'order-1',
    });
    expect(
      order1.allocations.map((a: { lotId: string; quantity: string }) => [a.lotId, a.quantity]),
    ).toEqual([
      [early.lot.lotId, '4.000000'],
      [late.lot.lotId, '2.000000'],
    ]);
    await h.run(ops.fulfillReservation, { reservationId: order1.reservationId });

    // The late lot passes its date: unavailable now, with no job run.
    await ownerQuery(`update lots set expires_on = $2 where id = $1`, [late.lot.lotId, day(-1)]);
    const view = await stock(variantId);
    expect(view.totals).toMatchObject({
      onHand: '8.000000',
      available: '0.000000',
      expired: '8.000000',
    });
    await expect(h.run(ops.reserveStock, { variantId, quantity: '1' })).rejects.toMatchObject({
      code: 'insufficient_stock',
    });
    const lots = await h.run(ops.listLots, { variantId });
    expect(lots.lots).toEqual([
      expect.objectContaining({
        code: 'L-LATE',
        expired: true,
        onHand: '8.000000',
        available: '0',
      }),
    ]);

    const trace = await h.run(ops.traceLot, { variantId, lotCode: 'l-late' });
    expect(trace.totals).toEqual({
      received: '10.000000',
      fulfilled: '2.000000',
      onHand: '8.000000',
    });
    expect(trace.orders).toEqual([
      { externalRef: 'order-1', reservationId: order1.reservationId, quantity: '2' },
    ]);
    expect(trace.movements.map((m: { kind: string }) => m.kind)).toEqual([
      'receipt',
      'fulfillment',
    ]);
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('applies the sell-by margin before the expiry date', async () => {
    const variantId = await tracked('lot_expiry', 30);
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '3',
      lotCode: 'SOON',
      expiresOn: day(10),
    });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '2',
      lotCode: 'LATER',
      expiresOn: day(90),
    });
    expect((await stock(variantId)).totals).toMatchObject({
      available: '2.000000',
      expired: '3.000000',
    });
    const soon = await h.run(ops.listLots, { variantId, expiringWithinDays: 45 });
    // SOON stops selling in the past (10 − 30 days); LATER on day 60.
    expect(soon.lots.map((l: { code: string }) => l.code)).toEqual(['SOON']);
  });

  it('keeps expired reservations from holding stock even when the sweeper is late (A37, A08)', async () => {
    const variantId = await tracked('lot');
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '5',
      lotCode: 'B1',
    });
    const r = await h.run(ops.reserveStock, { variantId, quantity: '5', expiresInSeconds: 600 });
    await ownerQuery(
      `update reservations set expires_at = now() - interval '1 second' where id = $1`,
      [r.reservationId],
    );
    expect((await stock(variantId)).totals.available).toBe('5.000000');
    // Refused whether or not a sweeper (other test files run one) has released it yet.
    await expect(
      h.run(ops.fulfillReservation, { reservationId: r.reservationId }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^reservation_(expired|not_open)$/),
    });
    const again = await h.run(ops.reserveStock, { variantId, quantity: '5', lotCode: 'b1' });
    expect(again.allocations).toHaveLength(1);
    await sweepExpiredReservations(db, 50, [shop.shopId]);
    const [row] = await ownerQuery<{ status: string }>(
      'select status from reservations where id = $1',
      [r.reservationId],
    );
    expect(row?.status).toBe('expired');
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('refuses a tracking change while the variant has stock or open reservations', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '1' });
    await expect(
      h.run(ops.setStockSettings, { variantId, trackingMode: 'lot' }),
    ).rejects.toMatchObject({ code: 'variant_has_stock' });
  });

  it('traces a lot and a serial within a scoped member’s locations only (PRD 2.4)', async () => {
    const wh = await h.run(ops.createWarehouse, { name: `Trace ${uuidv7().slice(-4)}` });
    const own = await createLeafLocation(h, wh.warehouseId, 'Shelf');
    const scoped = await addMember(shop.shopId, 'viewer', [wh.warehouseId]);
    const as = { caller: scoped.caller };
    const lotted = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId: lotted, trackingMode: 'lot' });
    for (const [locationId, quantity] of [
      [shop.locationId, '5'],
      [own, '2'],
    ] as const) {
      await h.run(ops.receiveStock, { variantId: lotted, locationId, quantity, lotCode: 'TR-1' });
    }
    const trace = await h.run(ops.traceLot, { variantId: lotted, lotCode: 'TR-1' }, as);
    expect({
      partial: trace.partial,
      locations: trace.movements.map((m: { locationId: string }) => m.locationId),
      onHand: trace.totals.onHand,
    }).toEqual({ partial: true, locations: [own], onHand: '2.000000' });
    const full = await h.run(ops.traceLot, { variantId: lotted, lotCode: 'TR-1' });
    expect({ partial: full.partial, onHand: full.totals.onHand }).toEqual({
      partial: false,
      onHand: '7.000000',
    });
    const serialized = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId: serialized, trackingMode: 'serial' });
    await h.run(ops.receiveStock, {
      variantId: serialized,
      locationId: own,
      quantity: '1',
      serials: ['TR-S1'],
    });
    const history = await h.run(ops.serialHistory, { variantId: serialized, serial: 'TR-S1' }, as);
    expect({ at: history.current?.locationId, moves: history.movements.length }).toEqual({
      at: own,
      moves: 1,
    });
  });
});

describe('serials (A38, receive and fulfill)', () => {
  it('receives one position per serial, rejects duplicates, and records each step', async () => {
    const variantId = await tracked('serial');
    await expect(
      h.run(ops.receiveStock, {
        variantId,
        locationId: shop.locationId,
        quantity: '2',
        serials: ['A'],
      }),
    ).rejects.toMatchObject({ code: 'serial_count_mismatch' });
    await expect(
      h.run(ops.receiveStock, {
        variantId,
        locationId: shop.locationId,
        quantity: '2',
        serials: ['SN-1', 'sn-1'],
      }),
    ).rejects.toMatchObject({ code: 'duplicate_serial' });
    const res = await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '2',
      serials: ['SN-1', 'SN-2'],
    });
    expect(res.positions).toHaveLength(2);
    await expect(
      h.run(ops.receiveStock, {
        variantId,
        locationId: shop.locationId,
        quantity: '1',
        serials: ['sn-2'],
      }),
    ).rejects.toMatchObject({ code: 'serial_exists', extra: { serials: ['sn-2'] } });

    // A picker who grabs the other serial reallocates the claim to it.
    const r = await h.run(ops.reserveStock, { variantId, quantity: '1', externalRef: 'order-77' });
    const held = r.allocations[0].serialId;
    const other = res.serials.find((x: { serialId: string }) => x.serialId !== held);
    const kept = res.serials.find((x: { serialId: string }) => x.serialId === held);
    await expect(
      h.run(ops.reallocateReservation, { reservationId: r.reservationId, serial: 'SN-404' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const moved = await h.run(ops.reallocateReservation, {
      reservationId: r.reservationId,
      serial: other.serial.toLowerCase(),
    });
    expect(moved.to[0].serialId).toBe(other.serialId);
    await h.run(ops.fulfillReservation, { reservationId: r.reservationId });

    const sold = await h.run(ops.serialHistory, { variantId, serial: other.serial });
    expect(sold).toMatchObject({ status: 'sold', current: null });
    expect(
      sold.movements.map((m: { kind: string; quantity: string }) => [m.kind, m.quantity]),
    ).toEqual([
      ['receipt', '1.000000'],
      ['fulfillment', '-1.000000'],
    ]);
    expect(sold.movements[1].externalRef).toBe('order-77');
    const stays = await h.run(ops.serialHistory, { variantId, serial: kept.serial });
    expect(stays).toMatchObject({ status: 'in_stock', current: { locationId: shop.locationId } });
    expect(await reconcile(shop.shopId)).toEqual([]);
  });
});

describe('moving average and cost of goods (A39, D7)', () => {
  it('gives €5 average, €75 value, and €25 cost of goods, the same when asked again later', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '10',
      unitCost: '4',
    });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '10',
      unitCost: '6',
    });
    const from = new Date().toISOString();
    const r = await h.run(ops.reserveStock, { variantId, quantity: '5' });
    const shipped = await h.run(ops.fulfillReservation, { reservationId: r.reservationId });
    expect(shipped.costOfGoods).toBe('25.000000');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const at = new Date().toISOString();
    const now = await h.run(ops.getValuation, { variantId, at, from, to: at });
    expect(now).toMatchObject({
      value: '75.000000',
      quantity: '15.000000',
      currency: 'EUR',
      costOfGoods: { quantity: '5.000000', value: '25.000000' },
    });
    expect(now.variants[0]).toMatchObject({ averageCost: '5.000000', value: '75.000000' });

    // Later activity changes today's value but not the value at that moment.
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '5',
      unitCost: '8',
    });
    const later = await h.run(ops.getValuation, { variantId, at, from, to: at });
    expect(later.value).toBe('75.000000');
    expect(later.costOfGoods.value).toBe('25.000000');
    const today = await h.run(ops.getValuation, { variantId });
    expect(today.value).toBe('115.000000');
    expect((await stock(variantId)).cost).toMatchObject({
      averageCost: '5.750000',
      value: '115.000000',
    });
  });

  it('rounds the average half to even and uses the default cost while there is no stock', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, defaultCost: '2.5' });
    const first = await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '2',
    });
    expect(first).toMatchObject({ unitCost: '2.500000', averageCost: '2.500000' });
    // (2 × 2.5 + 1 × 1.0000005) / 3 = 2.0000001666… → 2.000000
    const second = await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '1',
      unitCost: '1.000001',
    });
    expect(second.averageCost).toBe('2.000000');
  });

  it('hides costs without costs.read and refuses to take one', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '2',
      unitCost: '3',
    });
    const operator = await addMember(shop.shopId, 'inventory_operator');
    const view = await stock(variantId, operator.caller);
    expect(view).toMatchObject({ costVisible: false, cost: null });
    await expect(
      h.run(
        ops.receiveStock,
        { variantId, locationId: shop.locationId, quantity: '1', unitCost: '3' },
        { caller: operator.caller },
      ),
    ).rejects.toMatchObject({ status: 403 });
    const plain = await h.run(
      ops.receiveStock,
      { variantId, locationId: shop.locationId, quantity: '1' },
      { caller: operator.caller },
    );
    expect(plain).toMatchObject({ costVisible: false, unitCost: null, averageCost: null });
    await expect(h.run(ops.getValuation, {}, { caller: operator.caller })).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('partial release and fulfillment (D2)', () => {
  it('releases and fulfills by quantity and by allocation', async () => {
    const variantId = await createVariant(h);
    const wh = await h.run(ops.createWarehouse, { name: 'Partial' });
    const a = await createLeafLocation(h, wh.warehouseId, 'A');
    const b = await createLeafLocation(h, wh.warehouseId, 'B');
    await h.run(ops.receiveStock, { variantId, locationId: a, quantity: '4' });
    await h.run(ops.receiveStock, { variantId, locationId: b, quantity: '6' });
    const r = await h.run(ops.reserveStock, { variantId, quantity: '8' });
    expect(r.allocations).toHaveLength(2);
    const [first, second] = r.allocations;
    const part = await h.run(ops.fulfillReservation, {
      reservationId: r.reservationId,
      allocationId: second.allocationId,
      quantity: '1',
    });
    expect(part).toMatchObject({ fulfilled: '1', status: 'partially_fulfilled' });
    await h.run(ops.releaseReservation, {
      reservationId: r.reservationId,
      allocationId: first.allocationId,
    });
    await expect(
      h.run(ops.fulfillReservation, { reservationId: r.reservationId, quantity: '4' }),
    ).rejects.toMatchObject({ code: 'quantity_exceeds_allocated' });
    const rest = await h.run(ops.fulfillReservation, { reservationId: r.reservationId });
    expect(rest).toMatchObject({ fulfilled: '3', status: 'fulfilled' });
    expect((await stock(variantId)).totals).toMatchObject({
      onHand: '6.000000',
      reserved: '0.000000',
      available: '6.000000',
    });
    const [listed] = (await h.run(ops.listReservations, { reservationId: r.reservationId }))
      .reservations;
    expect(listed).toMatchObject({
      status: 'fulfilled',
      fulfilled: '4.000000',
      outstanding: '0.000000',
    });
    expect(await reconcile(shop.shopId)).toEqual([]);
  });
});

describe('allocation rules per channel (D3)', () => {
  it('takes stock from the channel’s locations in order, and only from them', async () => {
    const variantId = await createVariant(h);
    const store = await h.run(ops.createWarehouse, { name: 'Rule store' });
    const depot = await h.run(ops.createWarehouse, { name: 'Rule depot' });
    const storeLoc = await createLeafLocation(h, store.warehouseId, 'Shelf');
    const depotLoc = await createLeafLocation(h, depot.warehouseId, 'Bay');
    await h.run(ops.receiveStock, { variantId, locationId: storeLoc, quantity: '3' });
    await h.run(ops.receiveStock, { variantId, locationId: depotLoc, quantity: '3' });
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '50' });
    await h.run(ops.setAllocationRule, {
      channel: 'web',
      locationIds: [depot.warehouseId, storeLoc],
    });
    const res = await h.run(ops.reserveStock, { variantId, quantity: '5', channel: 'web' });
    expect(res.allocations.map((a: { locationId: string }) => a.locationId)).toEqual([
      depotLoc,
      storeLoc,
    ]);
    await expect(
      h.run(ops.reserveStock, { variantId, quantity: '2', channel: 'web' }),
    ).rejects.toMatchObject({ code: 'insufficient_stock', extra: { available: '1.000000' } });
    const rules = await h.run(ops.getStockSettings, {});
    expect(rules.rules).toEqual([
      {
        channel: 'web',
        version: 1,
        locations: [
          { id: depot.warehouseId, kind: 'warehouse', name: 'Rule depot' },
          { id: storeLoc, kind: 'location', name: 'Rule store/Shelf' },
        ],
      },
    ]);
  });

  it('lets a scoped manager change only a rule that stays within their locations', async () => {
    const own = await h.run(ops.createWarehouse, { name: 'Rule own' });
    const ownLoc = await createLeafLocation(h, own.warehouseId, 'Shelf');
    const scoped = await addMember(shop.shopId, 'manager', [own.warehouseId]);
    const as = { caller: scoped.caller };
    const channel = `scoped:${uuidv7().slice(-8)}`;
    // No rule yet means every location: not theirs to replace.
    await expect(
      h.run(ops.setAllocationRule, { channel, locationIds: [ownLoc] }, as),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
    await h.run(ops.setAllocationRule, { channel, locationIds: [own.warehouseId] });
    // Within their warehouse: allowed, both ways.
    await h.run(ops.setAllocationRule, { channel, locationIds: [ownLoc] }, as);
    await h.run(ops.setAllocationRule, { channel, locationIds: [own.warehouseId] }, as);
    // Widening to every location is not.
    await expect(
      h.run(ops.setAllocationRule, { channel, locationIds: [] }, as),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
    // Nor replacing a rule that names a warehouse outside their scope.
    await h.run(ops.setAllocationRule, { channel, locationIds: [shop.warehouseId] });
    await expect(
      h.run(ops.setAllocationRule, { channel, locationIds: [own.warehouseId] }, as),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
  });
});

describe('bundles (A36, engine half; G7)', () => {
  async function giftSet() {
    const soap = await createVariant(h);
    const candle = await createVariant(h);
    const gift = await createVariant(h);
    await h.run(ops.setBundle, {
      variantId: gift,
      bundleVersion: 0,
      components: [
        { variantId: soap, quantity: '2' },
        { variantId: candle, quantity: '1' },
      ],
    });
    return { soap, candle, gift };
  }

  it('reserves only whole sets, all components at once, and fulfills them together', async () => {
    const { soap, candle, gift } = await giftSet();
    await h.run(ops.receiveStock, { variantId: soap, locationId: shop.locationId, quantity: '5' });
    await h.run(ops.receiveStock, {
      variantId: candle,
      locationId: shop.locationId,
      quantity: '10',
    });
    await expect(h.run(ops.reserveStock, { variantId: gift, quantity: '3' })).rejects.toMatchObject(
      {
        code: 'insufficient_stock',
        extra: { requested: '3', available: '2' },
      },
    );
    // Nothing was held by the failed attempt.
    expect((await stock(soap)).totals.reserved).toBe('0.000000');
    const two = await h.run(ops.reserveStock, { variantId: gift, quantity: '2' });
    expect(two.bundle).toMatchObject({ version: 1 });
    expect(
      two.bundle.components.map((c: { variantId: string; quantity: string }) => [
        c.variantId,
        c.quantity,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [soap, '4'],
        [candle, '2'],
      ]),
    );
    expect((await stock(soap)).totals).toMatchObject({
      reserved: '4.000000',
      available: '1.000000',
    });
    expect((await h.run(ops.getBundleAvailability, { variantId: gift })).available).toBe('0');

    // Components cannot be acted on alone.
    await expect(
      h.run(ops.releaseReservation, { reservationId: two.bundle.components[0].reservationId }),
    ).rejects.toMatchObject({ code: 'reservation_is_component' });
    const one = await h.run(ops.fulfillReservation, {
      reservationId: two.reservationId,
      quantity: '1',
    });
    expect(one).toMatchObject({ fulfilled: '1', status: 'partially_fulfilled' });
    await h.run(ops.releaseReservation, { reservationId: two.reservationId });
    expect((await stock(soap)).totals).toMatchObject({ onHand: '3.000000', reserved: '0.000000' });
    expect((await stock(candle)).totals).toMatchObject({
      onHand: '9.000000',
      reserved: '0.000000',
    });
    const [listed] = (
      await h.run(ops.listReservations, { reservationId: two.reservationId, status: 'all' })
    ).reservations;
    expect(listed.status).toBe('fulfilled');
    expect(listed.components).toHaveLength(2);
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('keeps open reservations on the bundle version they were made with', async () => {
    const { soap, candle, gift } = await giftSet();
    await h.run(ops.receiveStock, { variantId: soap, locationId: shop.locationId, quantity: '10' });
    await h.run(ops.receiveStock, {
      variantId: candle,
      locationId: shop.locationId,
      quantity: '10',
    });
    const r = await h.run(ops.reserveStock, { variantId: gift, quantity: '1' });
    await h.run(ops.setBundle, {
      variantId: gift,
      bundleVersion: 1,
      components: [{ variantId: candle, quantity: '3' }],
    });
    const done = await h.run(ops.fulfillReservation, { reservationId: r.reservationId });
    expect(
      done.lines.map((l: { variantId: string; quantity: string }) => [l.variantId, l.quantity]),
    ).toEqual(
      expect.arrayContaining([
        [soap, '2.000000'],
        [candle, '1.000000'],
      ]),
    );
    const [row] = await ownerQuery<{ version: number }>(
      `select bv.version from reservations r join bundle_versions bv on bv.id = r.bundle_version_id
       where r.id = $1`,
      [r.reservationId],
    );
    expect(row?.version).toBe(1);
  });

  it('records a shortage per component for a connector order, filled by the next receipt', async () => {
    const { soap, candle, gift } = await giftSet();
    await h.run(ops.receiveStock, { variantId: soap, locationId: shop.locationId, quantity: '3' });
    await h.run(ops.receiveStock, {
      variantId: candle,
      locationId: shop.locationId,
      quantity: '5',
    });
    const shopify = await connector(shop);
    const order = await h.run(
      ops.reserveStock,
      { variantId: gift, quantity: '2', allowShortage: true, purpose: 'external_order' },
      { caller: shopify },
    );
    const soapPart = order.bundle.components.find(
      (c: { variantId: string }) => c.variantId === soap,
    );
    expect(soapPart).toMatchObject({ quantity: '4', shortage: '1' });
    await expect(
      h.run(ops.fulfillReservation, { reservationId: order.reservationId, quantity: '2' }),
    ).rejects.toMatchObject({ code: 'quantity_exceeds_allocated' });
    const filled = await h.run(ops.receiveStock, {
      variantId: soap,
      locationId: shop.locationId,
      quantity: '2',
    });
    expect(filled.shortagesFilled).toEqual([
      { reservationId: soapPart.reservationId, quantity: '1' },
    ]);
    expect((await stock(soap)).totals).toMatchObject({
      available: '1.000000',
      shortage: '0.000000',
    });
    await h.run(ops.fulfillReservation, { reservationId: order.reservationId, quantity: '2' });
    expect(await reconcile(shop.shopId)).toEqual([]);
  });
});

describe('shortages (D6)', () => {
  it('lets only a connector record a shortage; receipts fill them oldest first; availability stays at zero', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '2' });
    await expect(
      h.run(ops.reserveStock, { variantId, quantity: '5', allowShortage: true }),
    ).rejects.toMatchObject({ status: 403 });
    const shopify = await connector(shop);
    const first = await h.run(
      ops.reserveStock,
      { variantId, quantity: '5', allowShortage: true, externalRef: 'shopify:1' },
      { caller: shopify },
    );
    expect(first).toMatchObject({ shortage: '3', expiresAt: null });
    const second = await h.run(
      ops.reserveStock,
      { variantId, quantity: '2', allowShortage: true, externalRef: 'shopify:2' },
      { caller: shopify },
    );
    expect(second.shortage).toBe('2');
    expect((await stock(variantId)).totals).toMatchObject({
      available: '0.000000',
      shortage: '5.000000',
    });
    const listed = await h.run(ops.listShortages, { variantId });
    expect(listed.byVariant).toEqual([expect.objectContaining({ variantId, shortage: '5' })]);

    const receipt = await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '4',
    });
    expect(receipt.shortagesFilled).toEqual([
      { reservationId: first.reservationId, quantity: '3' },
      { reservationId: second.reservationId, quantity: '1' },
    ]);
    expect((await stock(variantId)).totals).toMatchObject({
      onHand: '6.000000',
      available: '0.000000',
      shortage: '1.000000',
    });
    // A cancelled line releases its shortage first.
    const released = await h.run(ops.releaseReservation, {
      reservationId: second.reservationId,
      quantity: '1',
    });
    expect(released).toMatchObject({ shortageReleased: '1', status: 'active' });
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('leaves shortages open when the shop turns filling off', async () => {
    const other = await seedShop(db, sink, 'No fill');
    const oh = harness(db, sink, other);
    await oh.run(ops.updateStockSettings, { fillShortagesOnReceipt: false });
    const variantId = await createVariant(oh);
    const order = await oh.run(
      ops.reserveStock,
      { variantId, quantity: '2', allowShortage: true },
      { caller: await connector(other) },
    );
    const receipt = await oh.run(ops.receiveStock, {
      variantId,
      locationId: other.locationId,
      quantity: '5',
    });
    expect(receipt.shortagesFilled).toEqual([]);
    expect((await oh.run(ops.listShortages, {})).shortages).toEqual([
      expect.objectContaining({ reservationId: order.reservationId, shortage: '2.000000' }),
    ]);
    // The sweep respects the setting too; once filling is on again it takes the free stock.
    expect(await sweepShortages(db, 50, [other.shopId])).toBe(0);
    await oh.run(ops.updateStockSettings, { fillShortagesOnReceipt: true });
    expect(await sweepShortages(db, 50, [other.shopId])).toBeGreaterThanOrEqual(1);
    expect((await oh.run(ops.listShortages, {})).shortages).toEqual([]);
    expect((await oh.run(ops.getAvailability, { variantId })).totals).toMatchObject({
      reserved: '2.000000',
      available: '3.000000',
    });
    expect(await reconcile(other.shopId)).toEqual([]);
  });

  it('applies the shop’s default reservation expiry, which a caller can override with null', async () => {
    const other = await seedShop(db, sink, 'Expiry default');
    const oh = harness(db, sink, other);
    await oh.run(ops.updateStockSettings, { reservationExpiryMinutes: 30 });
    const variantId = await createVariant(oh);
    await oh.run(ops.receiveStock, { variantId, locationId: other.locationId, quantity: '5' });
    const timed = await oh.run(ops.reserveStock, { variantId, quantity: '1' });
    expect(timed.expiresAt).not.toBeNull();
    const forever = await oh.run(ops.reserveStock, {
      variantId,
      quantity: '1',
      expiresInSeconds: null,
    });
    expect(forever.expiresAt).toBeNull();
  });
});

describe('reallocation (D3)', () => {
  it('moves a claim to another lot without changing stock, and refuses more than the target has', async () => {
    const variantId = await tracked('lot');
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '3',
      lotCode: 'A',
    });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '2',
      lotCode: 'B',
    });
    const r = await h.run(ops.reserveStock, { variantId, quantity: '3', lotCode: 'A' });
    await expect(
      h.run(ops.reallocateReservation, { reservationId: r.reservationId, lotCode: 'B' }),
    ).rejects.toMatchObject({ code: 'insufficient_stock' });
    await expect(
      h.run(ops.reallocateReservation, { reservationId: r.reservationId }),
    ).rejects.toMatchObject({ code: 'target_required' });
    const moved = await h.run(ops.reallocateReservation, {
      reservationId: r.reservationId,
      lotCode: 'b',
      quantity: '2',
    });
    expect(moved).toMatchObject({ moved: '2' });
    const lots = await h.run(ops.listLots, { variantId });
    expect(lots.lots.map((l: { code: string; reserved: string }) => [l.code, l.reserved])).toEqual([
      ['A', '1.000000'],
      ['B', '2.000000'],
    ]);
    const done = await h.run(ops.fulfillReservation, { reservationId: r.reservationId });
    expect(done.fulfilled).toBe('3');
    expect(await reconcile(shop.shopId)).toEqual([]);
  });
});
