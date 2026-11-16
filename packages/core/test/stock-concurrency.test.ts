import { type Caller, ops, sweepExpiredReservations, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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

// Concurrency for the I1 commands (ADR 0006 lock order): fulfillment against expiry (A08), last
// units across lots and bundles (A04, A36), and receipts filling shortages while orders arrive.

const db = appDatabase({}, 16);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
});
afterAll(() => db.close());

async function race(n: number, call: (i: number) => Promise<unknown>) {
  const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => call(i)));
  return {
    ok: results.filter((r) => r.status === 'fulfilled').length,
    values: results
      .filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
      .map((r) => r.value),
    errors: results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason as { code?: string }).code ?? String(r.reason)),
  };
}

async function connector(): Promise<Caller> {
  const [m] = await ownerQuery<{ id: string }>(
    'select id from memberships where shop_id = $1 and user_id = $2',
    [shop.shopId, shop.userId],
  );
  return {
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
}

describe('fulfillment racing expiry (A08)', () => {
  it('gives one valid outcome per reservation: shipped or expired, never both', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '100' });
    let shipped = 0;
    for (let round = 0; round < 12; round++) {
      const r = await h.run(ops.reserveStock, { variantId, quantity: '5', expiresInSeconds: 60 });
      // Expiry lands somewhere in the next few milliseconds, while the commands run.
      await ownerQuery(
        `update reservations set expires_at = clock_timestamp() + make_interval(secs => $2) where id = $1`,
        [r.reservationId, (round % 4) * 0.004],
      );
      const outcome = await race(4, (i) =>
        i === 0
          ? h.run(ops.fulfillReservation, { reservationId: r.reservationId })
          : i === 1
            ? sweepExpiredReservations(db)
            : h.run(ops.reserveStock, { variantId, quantity: '1' }),
      );
      expect(
        outcome.errors.filter(
          (e) => !['reservation_expired', 'reservation_not_open', 'retry_conflict'].includes(e),
        ),
      ).toEqual([]);
      const [row] = await ownerQuery<{ status: string; fulfilled: string; released: string }>(
        `select r.status, sum(a.fulfilled)::text as fulfilled, sum(a.released)::text as released
         from reservations r join reservation_allocations a on a.reservation_id = r.id
         where r.id = $1 group by r.status`,
        [r.reservationId],
      );
      if (row!.status === 'fulfilled') {
        expect(row).toMatchObject({ fulfilled: '5.000000', released: '0.000000' });
        shipped += 5;
      } else {
        // Expired: possibly still active until a command or the sweeper releases it.
        expect(Number(row!.fulfilled)).toBe(0);
      }
      await sweepExpiredReservations(db);
    }
    const view = await h.run(ops.getAvailability, { variantId });
    expect(view.totals.onHand).toBe(`${100 - shipped}.000000`);
    expect(await reconcile(shop.shopId)).toEqual([]);
  });
});

describe('last units with lots, serials, and bundles (A04, A36)', () => {
  it('lets exactly nine of thirty callers reserve nine units spread over three lots', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'lot' });
    for (const code of ['L1', 'L2', 'L3']) {
      await h.run(ops.receiveStock, {
        variantId,
        locationId: shop.locationId,
        quantity: '3',
        lotCode: code,
      });
    }
    const { ok, errors } = await race(30, () =>
      h.run(ops.reserveStock, { variantId, quantity: '1' }),
    );
    expect(ok).toBe(9);
    expect(new Set(errors)).toEqual(new Set(['insufficient_stock']));
    expect((await h.run(ops.getAvailability, { variantId })).totals.available).toBe('0.000000');
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('gives each serial to one caller only', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'serial' });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '4',
      serials: ['C1', 'C2', 'C3', 'C4'],
    });
    const { ok, values } = await race(12, () =>
      h.run(ops.reserveStock, { variantId, quantity: '1' }),
    );
    expect(ok).toBe(4);
    const serials = values.map(
      (v) => (v as { allocations: Array<{ serialId: string }> }).allocations[0]!.serialId,
    );
    expect(new Set(serials).size).toBe(4);
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('reserves whole gift sets atomically: two of twenty callers win with 5 soaps at 2 per set', async () => {
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
    await h.run(ops.receiveStock, { variantId: soap, locationId: shop.locationId, quantity: '5' });
    await h.run(ops.receiveStock, {
      variantId: candle,
      locationId: shop.locationId,
      quantity: '20',
    });
    const { ok, errors } = await race(20, (i) =>
      i % 2 === 0
        ? h.run(ops.reserveStock, { variantId: gift, quantity: '1' })
        : h.run(ops.reserveStock, { variantId: candle, quantity: '1' }),
    );
    expect(errors.filter((e) => e !== 'insufficient_stock')).toEqual([]);
    const soapView = await h.run(ops.getAvailability, { variantId: soap });
    expect(soapView.totals).toMatchObject({ reserved: '4.000000', available: '1.000000' });
    const candleView = await h.run(ops.getAvailability, { variantId: candle });
    expect(candleView.totals.reserved).toBe('12.000000');
    expect(ok).toBe(12);
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('keeps one-of-a-kind receipts at two locations to one unit', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, oneOfAKind: true });
    const wh = await h.run(ops.createWarehouse, { name: 'One of a kind race' });
    const a = await createLeafLocation(h, wh.warehouseId, 'A');
    const b = await createLeafLocation(h, wh.warehouseId, 'B');
    const { ok, errors } = await race(6, (i) =>
      h.run(ops.receiveStock, { variantId, locationId: i % 2 ? a : b, quantity: '1' }),
    );
    expect(ok).toBe(1);
    expect(new Set(errors)).toEqual(new Set(['one_of_a_kind']));
    expect((await h.run(ops.getAvailability, { variantId })).totals.ownedTotal).toBe('1.000000');
  });
});

describe('receipts filling shortages while orders arrive (D6)', () => {
  it('never over-allocates and leaves no shortage the stock could cover', async () => {
    const variantId = await createVariant(h);
    const shopify = await connector();
    // The position exists, so an order waits for a receipt in progress there. (An order that
    // races the very first receipt at a location is caught by the shortage sweep instead.)
    const first = await h.run(
      ops.reserveStock,
      { variantId, quantity: '1', allowShortage: true },
      {
        caller: shopify,
      },
    );
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '1' });
    await h.run(ops.fulfillReservation, { reservationId: first.reservationId });
    await race(20, (i) =>
      i % 2 === 0
        ? h.run(
            ops.reserveStock,
            { variantId, quantity: '2', allowShortage: true },
            { caller: shopify },
          )
        : h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '3' }),
    );
    const view = await h.run(ops.getAvailability, { variantId });
    // 10 orders of 2 against 10 receipts of 3: every order is covered, 10 units stay free.
    expect(view.totals).toMatchObject({
      onHand: '30.000000',
      reserved: '20.000000',
      available: '10.000000',
      shortage: '0.000000',
    });
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('serializes fulfillments, releases, and reallocations on one reservation', async () => {
    const variantId = await createVariant(h);
    const wh = await h.run(ops.createWarehouse, { name: 'Mixed race' });
    const a = await createLeafLocation(h, wh.warehouseId, 'A');
    const b = await createLeafLocation(h, wh.warehouseId, 'B');
    await h.run(ops.receiveStock, { variantId, locationId: a, quantity: '20' });
    await h.run(ops.receiveStock, { variantId, locationId: b, quantity: '20' });
    const r = await h.run(ops.reserveStock, { variantId, quantity: '20', locationId: a });
    const { errors } = await race(15, (i) =>
      i % 3 === 0
        ? h.run(ops.fulfillReservation, { reservationId: r.reservationId, quantity: '2' })
        : i % 3 === 1
          ? h.run(ops.releaseReservation, { reservationId: r.reservationId, quantity: '1' })
          : h.run(ops.reallocateReservation, {
              reservationId: r.reservationId,
              locationId: b,
              quantity: '1',
              allocationId: r.allocations[0].allocationId,
            }),
    );
    expect(
      errors.filter(
        (e) => !['retry_conflict', 'quantity_exceeds_allocated', 'allocation_required'].includes(e),
      ),
    ).toEqual([]);
    const [totals] = await ownerQuery<{ fulfilled: string; released: string; moved: string }>(
      `select sum(fulfilled)::text as fulfilled, sum(released)::text as released, sum(moved)::text as moved
       from reservation_allocations where reservation_id = $1`,
      [r.reservationId],
    );
    expect(Number(totals!.fulfilled) + Number(totals!.released)).toBeLessThanOrEqual(20);
    expect(await reconcile(shop.shopId)).toEqual([]);
  });
});
