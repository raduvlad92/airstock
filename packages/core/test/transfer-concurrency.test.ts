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

// Concurrency for transfers (ADR 0006 lock order, with the transfer row first): ready and
// dispatch against overlapping reservations (A24), receipt against cancellation, and moves in
// opposite directions.

const db = appDatabase({}, 16);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let store: string;
let shelfB: string;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
  const wh = await h.run(ops.createWarehouse, { name: 'Concurrency store' });
  store = await createLeafLocation(h, wh.warehouseId, 'Front');
  shelfB = await createLeafLocation(h, shop.warehouseId, 'Concurrency B');
});
afterAll(() => db.close());

async function race(n: number, call: (i: number) => Promise<unknown>) {
  const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => call(i)));
  return {
    ok: results.filter((r) => r.status === 'fulfilled').length,
    errors: results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason as { code?: string }).code ?? String(r.reason)),
  };
}

async function stocked(quantity: string, locationId = shop.locationId): Promise<string> {
  const variantId = await createVariant(h);
  await h.run(ops.receiveStock, { variantId, locationId, quantity });
  return variantId;
}

describe('holds against overlapping reservations (A24)', () => {
  it('lets a ready and reservations share the last units exactly, never more', async () => {
    const variantId = await stocked('10');
    const { transfer } = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: store,
      lines: [{ variantId, quantity: '6' }],
    });
    // The ready wants 6 while 12 callers each want 1 of the same 10 units.
    const outcome = await race(13, (i) =>
      i === 0
        ? h.run(ops.readyTransfer, { transferId: transfer.transferId })
        : h.run(ops.reserveStock, { variantId, quantity: '1' }),
    );
    expect(outcome.errors.every((e) => e === 'insufficient_stock')).toBe(true);
    const view = await h.run(ops.getAvailability, { variantId });
    expect(Number(view.totals.reserved)).toBeLessThanOrEqual(10);
    expect(Number(view.totals.available)).toBeGreaterThanOrEqual(0);
    const t = await h.run(ops.getTransfer, { transferId: transfer.transferId });
    const reservations = outcome.ok - (t.status === 'ready' ? 1 : 0);
    expect(Number(view.totals.reserved)).toBe(reservations + (t.status === 'ready' ? 6 : 0));
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('dispatches the hold while others reserve the free units: one effect each, nothing negative', async () => {
    const variantId = await stocked('10');
    const { transfer } = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: store,
      lines: [{ variantId, quantity: '5' }],
      ready: true,
    });
    const outcome = await race(12, (i) =>
      i < 2
        ? h.run(ops.dispatchTransfer, { transferId: transfer.transferId })
        : h.run(ops.reserveStock, { variantId, quantity: '1' }),
    );
    // Exactly one dispatch wins; five reservations take the five free units.
    expect(outcome.ok).toBe(1 + 5);
    expect(outcome.errors.sort()).toEqual([
      'insufficient_stock',
      'insufficient_stock',
      'insufficient_stock',
      'insufficient_stock',
      'insufficient_stock',
      'quantity_exceeds_held',
    ]);
    const view = await h.run(ops.getAvailability, { variantId });
    expect(view.totals).toMatchObject({
      onHand: '5.000000',
      reserved: '5.000000',
      available: '0.000000',
      inTransit: '5.000000',
    });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});

describe('receipt against cancellation', () => {
  it('receives what is in transit and cancels what is held, each exactly once', async () => {
    for (let round = 0; round < 5; round++) {
      const variantId = await stocked('10');
      const { transfer } = await h.run(ops.createTransfer, {
        fromLocationId: shop.locationId,
        toLocationId: store,
        lines: [{ variantId, quantity: '10' }],
        ready: true,
      });
      const transferId = transfer.transferId;
      await h.run(ops.dispatchTransfer, { transferId, items: [{ variantId, quantity: '4' }] });
      // Two receipts of the whole in-transit quantity, two cancels, and a dispatch of the rest.
      const outcome = await race(5, (i) =>
        i < 2
          ? h.run(ops.receiveTransfer, { transferId })
          : i < 4
            ? h.run(ops.cancelTransfer, { transferId })
            : h.run(ops.dispatchTransfer, { transferId }),
      );
      expect(
        outcome.errors.filter(
          (e) =>
            ![
              'quantity_exceeds_in_transit',
              'nothing_to_cancel',
              'quantity_exceeds_held',
              'transfer_closed',
            ].includes(e),
        ),
      ).toEqual([]);
      const t = await h.run(ops.getTransfer, { transferId });
      const line = t.lines[0];
      const sum = (...v: string[]) => v.reduce((s, x) => s + Number(x), 0);
      expect(sum(line.cancelled, line.dispatched)).toBe(10);
      expect(sum(line.received, line.resolved, line.inTransit)).toBe(Number(line.dispatched));
      expect(Number(line.held)).toBe(0);
      const view = await h.run(ops.getAvailability, { variantId });
      expect(Number(view.totals.ownedTotal)).toBe(10);
      expect(Number(view.totals.inTransit)).toBe(Number(line.inTransit));
    }
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});

describe('moves in opposite directions', () => {
  it('never deadlocks or loses units', async () => {
    const a = await stocked('20');
    await h.run(ops.receiveStock, { variantId: a, locationId: shelfB, quantity: '20' });
    const outcome = await race(16, (i) =>
      h.run(ops.moveStock, {
        fromLocationId: i % 2 === 0 ? shop.locationId : shelfB,
        toLocationId: i % 2 === 0 ? shelfB : shop.locationId,
        lines: [{ variantId: a, quantity: '1' }],
      }),
    );
    expect(outcome.errors.filter((e) => e !== 'retry_conflict')).toEqual([]);
    const view = await h.run(ops.getAvailability, { variantId: a });
    expect(view.totals).toMatchObject({ onHand: '40.000000', inTransit: '0.000000' });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});
