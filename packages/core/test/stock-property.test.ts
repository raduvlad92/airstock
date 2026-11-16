import { type Caller, ops, sweepExpiredReservations, sweepShortages, uuidv7 } from '@airstock/core';
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

// A21 for the I1 engine: random mixes of receipts (in packs, by lot, by serial), reservations of
// variants and bundles (with expiry and connector shortages), releases, fulfillments,
// reallocations, expiry, and the sweepers keep the ledger, balances, allocations, reservations,
// serials, and owned quantities reconciled, and availability never below zero.

const db = appDatabase({}, 6);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let locations: string[];
let shopify: Caller;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
  const wh = await h.run(ops.createWarehouse, { name: 'Property I1' });
  locations = [
    await createLeafLocation(h, wh.warehouseId, 'Q1'),
    await createLeafLocation(h, wh.warehouseId, 'Q2'),
  ];
  const [m] = await ownerQuery<{ id: string }>(
    'select id from memberships where shop_id = $1 and user_id = $2',
    [shop.shopId, shop.userId],
  );
  shopify = {
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
});
afterAll(() => db.close());

type Kind = 'plain' | 'lot' | 'serial';
type Step =
  | { kind: 'receive'; what: Kind; loc: number; qty: number; inPacks: boolean; lot: number }
  | {
      kind: 'reserve';
      what: Kind | 'bundle';
      qty: number;
      loc: number | null;
      expiring: boolean;
      shortage: boolean;
    }
  | { kind: 'release'; pick: number; qty: number | null }
  | { kind: 'fulfill'; pick: number; qty: number | null }
  | { kind: 'reallocate'; pick: number; loc: number }
  | { kind: 'expire'; pick: number }
  | { kind: 'sweep' };

const what = fc.constantFrom<Kind>('plain', 'lot', 'serial');
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('receive' as const),
      what,
      loc: fc.integer({ min: 0, max: 1 }),
      qty: fc.integer({ min: 1, max: 4 }),
      inPacks: fc.boolean(),
      lot: fc.integer({ min: 0, max: 2 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('reserve' as const),
      what: fc.constantFrom<Kind | 'bundle'>('plain', 'lot', 'serial', 'bundle'),
      qty: fc.integer({ min: 1, max: 5 }),
      loc: fc.option(fc.integer({ min: 0, max: 1 })),
      expiring: fc.boolean(),
      shortage: fc.boolean(),
    }),
  },
  fc.record({
    kind: fc.constant('release' as const),
    pick: fc.nat(),
    qty: fc.option(fc.integer({ min: 1, max: 3 })),
  }),
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('fulfill' as const),
      pick: fc.nat(),
      qty: fc.option(fc.integer({ min: 1, max: 3 })),
    }),
  },
  fc.record({
    kind: fc.constant('reallocate' as const),
    pick: fc.nat(),
    loc: fc.integer({ min: 0, max: 1 }),
  }),
  fc.record({ kind: fc.constant('expire' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('sweep' as const) }),
);

const EXPECTED = new Set([
  'insufficient_stock',
  'reservation_not_open',
  'reservation_expired',
  'quantity_exceeds_reserved',
  'quantity_exceeds_allocated',
  'allocation_required',
  'nothing_allocated',
  'quantity_precision',
]);

const LOTS = [
  { code: 'FRESH', expiresOn: '2031-06-30' },
  { code: 'SOON', expiresOn: '2030-01-31' },
  { code: 'GONE', expiresOn: '2020-01-31' },
];

describe('stock conservation with lots, serials, packs, bundles, and shortages (A21)', () => {
  it('keeps every invariant after each step', async () => {
    let serialNo = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 5, maxLength: 22 }), async (steps) => {
        const plain = await createVariant(h);
        const packs = await h.run(ops.setPacks, {
          variantId: plain,
          packsVersion: 0,
          packs: [{ name: 'Case', quantity: '6' }],
        });
        const caseId = packs.packaging.packs[0].id as string;
        const lot = await createVariant(h);
        await h.run(ops.setStockSettings, { variantId: lot, trackingMode: 'lot_expiry' });
        const serial = await createVariant(h);
        await h.run(ops.setStockSettings, { variantId: serial, trackingMode: 'serial' });
        const bundle = await createVariant(h);
        await h.run(ops.setBundle, {
          variantId: bundle,
          bundleVersion: 0,
          components: [
            { variantId: plain, quantity: '2' },
            { variantId: lot, quantity: '1' },
          ],
        });
        const ids: Record<Kind | 'bundle', string> = { plain, lot, serial, bundle };
        const received: Record<Kind, number> = { plain: 0, lot: 0, serial: 0 };
        const shipped: Record<string, number> = {};
        const reservations: string[] = [];

        for (const s of steps) {
          try {
            if (s.kind === 'receive') {
              const base = { variantId: ids[s.what], locationId: locations[s.loc] };
              if (s.what === 'plain') {
                await h.run(ops.receiveStock, {
                  ...base,
                  quantity: String(s.qty),
                  ...(s.inPacks ? { packId: caseId } : {}),
                  unitCost: String(s.qty + 1),
                });
                received.plain += s.inPacks ? s.qty * 6 : s.qty;
              } else if (s.what === 'lot') {
                await h.run(ops.receiveStock, {
                  ...base,
                  quantity: String(s.qty),
                  lotCode: LOTS[s.lot]!.code,
                  expiresOn: LOTS[s.lot]!.expiresOn,
                });
                received.lot += s.qty;
              } else {
                const serials = Array.from({ length: s.qty }, () => `P-${++serialNo}`);
                await h.run(ops.receiveStock, { ...base, quantity: String(s.qty), serials });
                received.serial += s.qty;
              }
            } else if (s.kind === 'reserve') {
              const r = await h.run(
                ops.reserveStock,
                {
                  variantId: ids[s.what],
                  quantity: String(s.qty),
                  ...(s.loc === null ? {} : { locationId: locations[s.loc] }),
                  ...(s.expiring && !s.shortage ? { expiresInSeconds: 600 } : {}),
                  ...(s.shortage ? { allowShortage: true } : {}),
                },
                s.shortage ? { caller: shopify } : {},
              );
              reservations.push(r.reservationId);
            } else if (s.kind === 'sweep') {
              await sweepExpiredReservations(db, 50, [shop.shopId]);
              // Only this shop: a global sweep fills other files' shortages under them.
              await sweepShortages(db, 50, [shop.shopId]);
            } else if (reservations.length > 0) {
              const id = reservations[s.pick % reservations.length]!;
              if (s.kind === 'release') {
                await h.run(ops.releaseReservation, {
                  reservationId: id,
                  ...(s.qty ? { quantity: String(s.qty) } : {}),
                });
              } else if (s.kind === 'fulfill') {
                const done = await h.run(ops.fulfillReservation, {
                  reservationId: id,
                  ...(s.qty ? { quantity: String(s.qty) } : {}),
                });
                for (const line of done.lines as Array<{ variantId: string; quantity: string }>) {
                  shipped[line.variantId] = (shipped[line.variantId] ?? 0) + Number(line.quantity);
                }
              } else if (s.kind === 'reallocate') {
                await h.run(ops.reallocateReservation, {
                  reservationId: id,
                  locationId: locations[s.loc],
                  quantity: '1',
                });
              } else {
                await ownerQuery(
                  `update reservations set expires_at = now() - interval '1 second'
                   where (id = $1 or parent_id = $1) and expires_at is not null`,
                  [id],
                );
              }
            }
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (!code || !EXPECTED.has(code)) throw error;
          }
          for (const k of ['plain', 'lot', 'serial'] as const) {
            const view = await h.run(ops.getAvailability, { variantId: ids[k] });
            expect(Number(view.totals.available)).toBeGreaterThanOrEqual(0);
            expect(Number(view.totals.reserved)).toBeLessThanOrEqual(Number(view.totals.onHand));
          }
        }
        for (const k of ['plain', 'lot', 'serial'] as const) {
          const view = await h.run(ops.getAvailability, { variantId: ids[k] });
          expect(Number(view.totals.ownedTotal)).toBe(received[k] - (shipped[ids[k]] ?? 0));
        }
        expect(await reconcile(shop.shopId)).toEqual([]);
      }),
      { numRuns: 12 },
    );
  });
});
