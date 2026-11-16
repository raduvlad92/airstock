import { ops } from '@airstock/core';
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

const db = appDatabase();
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
});
afterAll(() => db.close());

describe('receive, reserve, release, availability', () => {
  it('creates the default Main stock location with the shop (PRD 3.1)', async () => {
    const res = await h.run(ops.listLocations, {});
    expect(res.locations).toHaveLength(1);
    expect(res.locations[0]).toMatchObject({
      name: 'Main stock',
      path: 'Main stock',
      holdsStockAllowed: true,
    });
  });

  it('keeps one catalog identity with per-location totals (A03)', async () => {
    const variantId = await createVariant(h);
    const rented = await h.run(ops.createWarehouse, {
      name: 'Rented warehouse',
      ownership: 'rented',
    });
    const partner = await h.run(ops.createWarehouse, {
      name: 'Fulfillment partner',
      ownership: 'third_party',
    });
    const rentedLoc = await createLeafLocation(h, rented.warehouseId, 'Bay 1');
    const partnerLoc = await createLeafLocation(h, partner.warehouseId, 'Zone A');

    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '20' });
    await h.run(ops.receiveStock, { variantId, locationId: rentedLoc, quantity: '80' });
    await h.run(ops.receiveStock, { variantId, locationId: partnerLoc, quantity: '50' });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: partnerLoc,
      quantity: '4',
      condition: 'damaged',
    });
    await h.run(ops.reserveStock, { variantId, quantity: '3', locationId: shop.locationId });
    await h.run(ops.reserveStock, { variantId, quantity: '10', locationId: rentedLoc });
    await h.run(ops.reserveStock, { variantId, quantity: '5', locationId: partnerLoc });

    const view = await h.run(ops.getAvailability, { variantId });
    expect(view.totals).toEqual({
      onHand: '154.000000',
      sellableOnHand: '150.000000',
      reserved: '18.000000',
      available: '132.000000',
      quarantined: '0',
      damaged: '4.000000',
      repair: '0',
      supplierReturn: '0',
      expired: '0',
      inTransit: '0',
      ownedTotal: '154.000000',
      shortage: '0.000000',
      onOrder: '0',
    });
    // Per location: one catalog identity, three sites (PRD 5.4).
    const sellable = view.positions.filter(
      (p: { condition: string }) => p.condition === 'sellable',
    );
    expect(
      sellable.map((p: { locationId: string; available: string }) => [p.locationId, p.available]),
    ).toEqual(
      expect.arrayContaining([
        [shop.locationId, '17.000000'],
        [rentedLoc, '70.000000'],
        [partnerLoc, '45.000000'],
      ]),
    );
    expect(view.partial).toBe(false);
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('rejects a reservation larger than availability without reserving anything', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '5' });
    await expect(h.run(ops.reserveStock, { variantId, quantity: '6' })).rejects.toMatchObject({
      code: 'insufficient_stock',
      status: 409,
      extra: { requested: '6', available: '5.000000' },
    });
    const view = await h.run(ops.getAvailability, { variantId });
    expect(view.totals.available).toBe('5.000000');
  });

  it('allocates the oldest stock first, then in path order, when no location is given (D3)', async () => {
    const variantId = await createVariant(h);
    const wh = await h.run(ops.createWarehouse, { name: 'Path order' });
    const a = await createLeafLocation(h, wh.warehouseId, 'A');
    const b = await createLeafLocation(h, wh.warehouseId, 'B');
    const c = await createLeafLocation(h, wh.warehouseId, 'C');
    await h.run(ops.receiveStock, { variantId, locationId: b, quantity: '5' });
    await h.run(ops.receiveStock, { variantId, locationId: a, quantity: '3' });
    await h.run(ops.receiveStock, { variantId, locationId: c, quantity: '2' });
    // A and C arrived together: path order breaks the tie.
    await ownerQuery(
      'update inventory_positions set received_at = $2 where variant_id = $1 and location_id = any($3::uuid[])',
      [variantId, new Date(Date.now() + 60_000), [a, c]],
    );
    const res = await h.run(ops.reserveStock, { variantId, quantity: '9' });
    expect(
      res.allocations.map((x: { locationId: string; quantity: string }) => [
        x.locationId,
        x.quantity,
      ]),
    ).toEqual([
      [b, '5.000000'],
      [a, '3.000000'],
      [c, '1.000000'],
    ]);
  });

  it('releases partly, then fully, and returns units to availability', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '10' });
    const r = await h.run(ops.reserveStock, { variantId, quantity: '6' });
    const partial = await h.run(ops.releaseReservation, {
      reservationId: r.reservationId,
      quantity: '2',
    });
    expect(partial).toMatchObject({ released: '2', status: 'active' });
    expect((await h.run(ops.getAvailability, { variantId })).totals.available).toBe('6.000000');
    await expect(
      h.run(ops.releaseReservation, { reservationId: r.reservationId, quantity: '5' }),
    ).rejects.toMatchObject({ code: 'quantity_exceeds_reserved' });
    const rest = await h.run(ops.releaseReservation, { reservationId: r.reservationId });
    expect(rest).toMatchObject({ released: '4', status: 'released' });
    expect((await h.run(ops.getAvailability, { variantId })).totals.available).toBe('10.000000');
    await expect(
      h.run(ops.releaseReservation, { reservationId: r.reservationId }),
    ).rejects.toMatchObject({
      code: 'reservation_not_open',
    });
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('enforces the variant quantity precision', async () => {
    const whole = await createVariant(h);
    await expect(
      h.run(ops.receiveStock, { variantId: whole, locationId: shop.locationId, quantity: '1.5' }),
    ).rejects.toMatchObject({ code: 'quantity_precision' });
    const kg = await createVariant(h, undefined, 3);
    const res = await h.run(ops.receiveStock, {
      variantId: kg,
      locationId: shop.locationId,
      quantity: '1.250',
    });
    expect(res.position.onHand).toBe('1.250000');
  });

  it('rejects stock at a location that has sub-locations, and sub-locations under stock', async () => {
    const variantId = await createVariant(h);
    const wh = await h.run(ops.createWarehouse, { name: 'Hierarchy' });
    const aisle = await createLeafLocation(h, wh.warehouseId, 'Aisle');
    await h.run(ops.createLocation, {
      warehouseId: wh.warehouseId,
      parentId: aisle,
      name: 'Shelf 1',
    });
    await expect(
      h.run(ops.receiveStock, { variantId, locationId: aisle, quantity: '1' }),
    ).rejects.toMatchObject({ code: 'location_not_leaf' });
    const bin = await createLeafLocation(h, wh.warehouseId, 'Bin');
    await h.run(ops.receiveStock, { variantId, locationId: bin, quantity: '1' });
    await expect(
      h.run(ops.createLocation, { warehouseId: wh.warehouseId, parentId: bin, name: 'Inner' }),
    ).rejects.toMatchObject({ code: 'location_holds_stock' });
  });

  it('rejects duplicate SKUs after normalization', async () => {
    await h.run(ops.createItem, { name: 'Chair', sku: 'chair  oak-1' });
    await expect(
      h.run(ops.createItem, { name: 'Chair 2', sku: ' CHAIR OAK-1 ' }),
    ).rejects.toMatchObject({
      code: 'duplicate_sku',
    });
    const found = await h.run(ops.searchVariants, { sku: 'Chair Oak-1' });
    expect(found.variants).toHaveLength(1);
  });
});

describe('expiry', () => {
  it('stops counting an expired reservation immediately, before any sweeper runs (PRD 6.3)', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '10' });
    const r = await h.run(ops.reserveStock, { variantId, quantity: '8', expiresInSeconds: 3600 });
    await ownerQuery(
      `update reservations set expires_at = now() - interval '1 second' where id = $1`,
      [r.reservationId],
    );

    // Reads already treat the claim as gone.
    expect((await h.run(ops.getAvailability, { variantId })).totals).toMatchObject({
      reserved: '0.000000',
      available: '10.000000',
    });
    // A command on the same position releases it in its own transaction and can use the units.
    const again = await h.run(ops.reserveStock, { variantId, quantity: '10' });
    expect(again.allocations).toHaveLength(1);
    const [row] = await ownerQuery<{ status: string }>(
      'select status from reservations where id = $1',
      [r.reservationId],
    );
    expect(row?.status).toBe('expired');
    await expect(
      h.run(ops.releaseReservation, { reservationId: r.reservationId }),
    ).rejects.toMatchObject({
      code: 'reservation_not_open',
    });
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('lets the sweeper release expired reservations for every shop', async () => {
    const { sweepExpiredReservations } = await import('@airstock/core');
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '4' });
    const r = await h.run(ops.reserveStock, { variantId, quantity: '4', expiresInSeconds: 60 });
    await ownerQuery(
      `update reservations set expires_at = now() - interval '1 second' where id = $1`,
      [r.reservationId],
    );
    expect(await sweepExpiredReservations(db)).toBeGreaterThanOrEqual(1);
    const [row] = await ownerQuery<{ status: string }>(
      'select status from reservations where id = $1',
      [r.reservationId],
    );
    expect(row?.status).toBe('expired');
    const events = await ownerQuery<{ action: string; actor_type: string }>(
      `select action, actor_type from audit_events where target_id = $1 and action = 'inventory.reservation.expired'`,
      [r.reservationId],
    );
    expect(events).toEqual([{ action: 'inventory.reservation.expired', actor_type: 'system' }]);
    expect(await reconcile(shop.shopId)).toEqual([]);
  });
});

describe('location-scoped members (C31, A42)', () => {
  it('sees and acts only within their locations, with totals labelled partial', async () => {
    const variantId = await createVariant(h);
    const store = await h.run(ops.createWarehouse, { name: 'Store' });
    const storeLoc = await createLeafLocation(h, store.warehouseId, 'Backroom');
    await h.run(ops.receiveStock, { variantId, locationId: storeLoc, quantity: '7' });
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '100' });

    const member = await addMember(shop.shopId, 'inventory_operator', [store.warehouseId]);
    const asMember = { caller: member.caller };

    const view = await h.run(ops.getAvailability, { variantId }, asMember);
    expect(view.partial).toBe(true);
    expect(view.totals.available).toBe('7.000000');
    expect(view.positions.map((p: { locationId: string }) => p.locationId)).toEqual([storeLoc]);

    await expect(
      h.run(ops.getAvailability, { variantId, locationId: shop.locationId }, asMember),
    ).rejects.toMatchObject({ code: 'location_out_of_scope', status: 403 });
    await expect(
      h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '1' }, asMember),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
    // Without a location, only in-scope stock can be allocated.
    await expect(
      h.run(ops.reserveStock, { variantId, quantity: '8' }, asMember),
    ).rejects.toMatchObject({
      code: 'insufficient_stock',
    });
    const ok = await h.run(ops.reserveStock, { variantId, quantity: '7' }, asMember);
    expect(ok.allocations[0].locationId).toBe(storeLoc);
  });

  it('denies operations the role does not permit', async () => {
    const viewer = await addMember(shop.shopId, 'viewer');
    const variantId = await createVariant(h);
    await expect(
      h.run(
        ops.receiveStock,
        { variantId, locationId: shop.locationId, quantity: '1' },
        { caller: viewer.caller },
      ),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    const denied = sink.events.filter((e) => e.actor_id === viewer.userId);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      phase: 'outcome',
      outcome: 'denied',
      action: 'inventory.receipt.created',
    });
  });
});
