import { ops } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appDatabase,
  createLeafLocation,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';
import { reconcileAll } from './documents-helpers.ts';

// Concurrency for counts and adjustments (ADR 0006 lock order): counts racing reservations and
// fulfillments on the same shelf never leave availability below zero or a claim uncovered.

const db = appDatabase({}, 16);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let shelf: string;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
  shelf = await createLeafLocation(h, shop.warehouseId, 'Race shelf');
});
afterAll(() => db.close());

async function race(n: number, call: (i: number) => Promise<unknown>) {
  const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => call(i)));
  return results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason as { code?: string }).code ?? String(r.reason));
}

describe('counts against reservations', () => {
  it('lets each count and reservation apply whole, never under reserved stock', async () => {
    for (let round = 0; round < 4; round++) {
      const variantId = await createVariant(h);
      await h.run(ops.receiveStock, { variantId, locationId: shelf, quantity: '10' });
      const errors = await race(12, (i) =>
        i % 3 === 0
          ? h.run(ops.quickCount, {
              locationId: shelf,
              counts: [{ variantId, counted: String(4 + (i % 4)) }],
            })
          : h.run(ops.reserveStock, { variantId, quantity: '2' }),
      );
      expect(
        errors.filter(
          (e) => !['insufficient_stock', 'below_reserved', 'retry_conflict'].includes(e),
        ),
      ).toEqual([]);
      const view = await h.run(ops.getAvailability, { variantId });
      expect(Number(view.totals.available)).toBeGreaterThanOrEqual(0);
      expect(Number(view.totals.reserved)).toBeLessThanOrEqual(Number(view.totals.onHand));
    }
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('serializes adjustments and fulfillments on one position', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shelf, quantity: '20' });
    const reservations: Array<{ reservationId: string }> = [];
    for (let i = 0; i < 4; i++) {
      reservations.push(await h.run(ops.reserveStock, { variantId, quantity: '2' }));
    }
    const errors = await race(12, (i) =>
      i < 4
        ? h.run(ops.fulfillReservation, { reservationId: reservations[i]!.reservationId })
        : h.run(ops.adjustStock, {
            locationId: shelf,
            adjustmentReason: 'damage',
            adjustments: [{ variantId, direction: 'remove', quantity: '2' }],
          }),
    );
    // 20 on hand: 8 fulfilled, then removals while at least the reserved stays.
    expect(errors.filter((e) => !['below_reserved', 'below_zero'].includes(e))).toEqual([]);
    const view = await h.run(ops.getAvailability, { variantId });
    expect(view.totals.reserved).toBe('0.000000');
    expect(Number(view.totals.onHand)).toBe(20 - 8 - 2 * (8 - errors.length));
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});
