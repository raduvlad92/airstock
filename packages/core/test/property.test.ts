import { ops } from '@airstock/core';
import fc from 'fast-check';
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

const db = appDatabase();
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let locations: string[];

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
  const wh = await h.run(ops.createWarehouse, { name: 'Property' });
  locations = [
    await createLeafLocation(h, wh.warehouseId, 'P1'),
    await createLeafLocation(h, wh.warehouseId, 'P2'),
  ];
});
afterAll(() => db.close());

type Step =
  | { kind: 'receive'; loc: number; qty: number }
  | { kind: 'reserve'; loc: number | null; qty: number; expiring: boolean }
  | { kind: 'release'; pick: number; qty: number | null }
  | { kind: 'expire'; pick: number };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant('receive' as const),
    loc: fc.integer({ min: 0, max: 1 }),
    qty: fc.integer({ min: 1, max: 9 }),
  }),
  fc.record({
    kind: fc.constant('reserve' as const),
    loc: fc.option(fc.integer({ min: 0, max: 1 })),
    qty: fc.integer({ min: 1, max: 12 }),
    expiring: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('release' as const),
    pick: fc.nat(),
    qty: fc.option(fc.integer({ min: 1, max: 5 })),
  }),
  fc.record({ kind: fc.constant('expire' as const), pick: fc.nat() }),
);

describe('stock conservation under random command sequences (A21)', () => {
  it('keeps ledger, balances, and allocations reconciled, with availability never negative', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 5, maxLength: 25 }), async (steps) => {
        const variantId = await createVariant(h);
        const reservations: string[] = [];
        let received = 0;
        for (const s of steps) {
          try {
            if (s.kind === 'receive') {
              await h.run(ops.receiveStock, {
                variantId,
                locationId: locations[s.loc],
                quantity: String(s.qty),
              });
              received += s.qty;
            } else if (s.kind === 'reserve') {
              const r = await h.run(ops.reserveStock, {
                variantId,
                quantity: String(s.qty),
                ...(s.loc === null ? {} : { locationId: locations[s.loc] }),
                ...(s.expiring ? { expiresInSeconds: 600 } : {}),
              });
              reservations.push(r.reservationId);
            } else if (reservations.length > 0) {
              const id = reservations[s.pick % reservations.length]!;
              if (s.kind === 'release') {
                await h.run(ops.releaseReservation, {
                  reservationId: id,
                  ...(s.qty ? { quantity: String(s.qty) } : {}),
                });
              } else {
                await ownerQuery(
                  `update reservations set expires_at = now() - interval '1 second' where id = $1 and expires_at is not null`,
                  [id],
                );
              }
            }
          } catch (error) {
            const code = (error as { code?: string }).code;
            const expected = [
              'insufficient_stock',
              'reservation_not_open',
              'reservation_expired',
              'quantity_exceeds_reserved',
            ];
            if (!code || !expected.includes(code)) throw error;
          }
          const view = await h.run(ops.getAvailability, { variantId });
          expect(Number(view.totals.available)).toBeGreaterThanOrEqual(0);
          expect(Number(view.totals.reserved)).toBeLessThanOrEqual(Number(view.totals.onHand));
        }
        const view = await h.run(ops.getAvailability, { variantId });
        expect(Number(view.totals.onHand)).toBe(received);
        expect(await reconcile(shop.shopId)).toEqual([]);
      }),
      { numRuns: 15 },
    );
  });
});
