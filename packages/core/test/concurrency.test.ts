import { execute, ops, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appDatabase,
  createLeafLocation,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
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

async function race(n: number, call: (i: number) => Promise<unknown>) {
  const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => call(i)));
  return {
    ok: results.filter((r) => r.status === 'fulfilled').length,
    errors: results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason as { code?: string }).code ?? String(r.reason)),
  };
}

describe('concurrent reservations of the last units (A04)', () => {
  it('lets exactly ten of fifty callers reserve ten units at one location', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '10' });
    const { ok, errors } = await race(50, () =>
      h.run(ops.reserveStock, { variantId, quantity: '1' }),
    );
    expect(ok).toBe(10);
    expect(new Set(errors)).toEqual(new Set(['insufficient_stock']));
    const view = await h.run(ops.getAvailability, { variantId });
    expect(view.totals).toMatchObject({ reserved: '10.000000', available: '0.000000' });
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('holds across two positions and mixed quantities', async () => {
    const variantId = await createVariant(h);
    const wh = await h.run(ops.createWarehouse, { name: 'Race' });
    const a = await createLeafLocation(h, wh.warehouseId, 'A');
    const b = await createLeafLocation(h, wh.warehouseId, 'B');
    await h.run(ops.receiveStock, { variantId, locationId: a, quantity: '4' });
    await h.run(ops.receiveStock, { variantId, locationId: b, quantity: '6' });
    const quantities = Array.from({ length: 40 }, (_, i) => String((i % 3) + 1));
    const { ok } = await race(40, (i) =>
      h.run(ops.reserveStock, { variantId, quantity: quantities[i] }),
    );
    const view = await h.run(ops.getAvailability, { variantId });
    expect(Number(view.totals.available)).toBeGreaterThanOrEqual(0);
    expect(Number(view.totals.reserved)).toBeLessThanOrEqual(10);
    expect(ok).toBeGreaterThan(0);
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('serializes reservations with concurrent releases and receipts without drift', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '20' });
    const first = await Promise.all(
      Array.from({ length: 10 }, () => h.run(ops.reserveStock, { variantId, quantity: '2' })),
    );
    await race(30, (i) => {
      if (i < 10) return h.run(ops.releaseReservation, { reservationId: first[i].reservationId });
      if (i < 20)
        return h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '1' });
      return h.run(ops.reserveStock, { variantId, quantity: '3' });
    });
    const view = await h.run(ops.getAvailability, { variantId });
    expect(Number(view.totals.available)).toBeGreaterThanOrEqual(0);
    expect(view.totals.onHand).toBe('30.000000');
    expect(await reconcile(shop.shopId)).toEqual([]);
  });
});

describe('concurrent duplicates of one command (A05)', () => {
  it('applies one effect when the same key arrives fifty times at once', async () => {
    const variantId = await createVariant(h);
    const key = uuidv7();
    const input = { variantId, locationId: shop.locationId, quantity: '5' };
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        execute({ db, audit: sink }, ops.receiveStock, {
          caller: shop.caller,
          shopId: shop.shopId,
          input,
          idempotencyKey: key,
        }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const operationIds = new Set(
      results.map((r) => (r.result as { operationId: string }).operationId),
    );
    expect(operationIds.size).toBe(1);
    const view = await h.run(ops.getAvailability, { variantId });
    expect(view.totals.onHand).toBe('5.000000');
    expect(
      sink.events.filter((e) => e.idempotency_key === key && e.outcome === 'replayed'),
    ).toHaveLength(49);
  });
});
