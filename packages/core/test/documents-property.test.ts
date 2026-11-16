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
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';
import { reconcileAll } from './documents-helpers.ts';

// A21 for milestone I2: random mixes of receipts (in packs, by lot, by serial), reservations and
// fulfillments, transfers (create, ready, partial dispatch and receipt, cancel, exception
// resolution, moves), and returns (receipt into quarantine and every inspection disposition) keep the ledger, balances, allocations, reservations, serials, owned
// quantities, and every transfer line reconciled, with availability never below zero.

const db = appDatabase({}, 6);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let locations: string[];

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
  const w1 = await h.run(ops.createWarehouse, { name: 'Property I2 north' });
  const w2 = await h.run(ops.createWarehouse, { name: 'Property I2 south' });
  locations = [
    await createLeafLocation(h, w1.warehouseId, 'N1'),
    await createLeafLocation(h, w1.warehouseId, 'N2'),
    await createLeafLocation(h, w2.warehouseId, 'S1'),
  ];
});
afterAll(() => db.close());

type Kind = 'plain' | 'lot' | 'serial';
type Step =
  | { kind: 'receive'; what: Kind; loc: number; qty: number; inPacks: boolean; lot: number }
  | { kind: 'reserve'; what: Kind; qty: number }
  | { kind: 'fulfill'; pick: number }
  | { kind: 'transfer'; what: Kind; from: number; to: number; qty: number; ready: boolean }
  // \`to\` is an offset from \`from\`, so the two always differ.
  | { kind: 'ready'; pick: number }
  | { kind: 'dispatch'; pick: number; qty: number | null }
  | { kind: 'receiveTransfer'; pick: number; qty: number | null; damaged: boolean }
  | { kind: 'cancel'; pick: number; qty: number | null }
  | { kind: 'resolve'; pick: number; qty: number | null }
  | { kind: 'move'; what: Kind; from: number; qty: number }
  | { kind: 'return'; what: Kind; qty: number; loc: number }
  | { kind: 'inspect'; pick: number; disposition: Disposition; qty: number | null };

type Disposition = 'sellable' | 'damaged' | 'repair' | 'supplier_return' | 'disposal';

const what = fc.constantFrom<Kind>('plain', 'lot', 'serial');
const loc = fc.integer({ min: 0, max: 2 });
const pick = fc.nat();
const maybeQty = fc.option(fc.integer({ min: 1, max: 3 }));
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('receive' as const),
      what,
      loc,
      qty: fc.integer({ min: 2, max: 8 }),
      inPacks: fc.boolean(),
      lot: fc.integer({ min: 0, max: 1 }),
    }),
  },
  fc.record({ kind: fc.constant('reserve' as const), what, qty: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ kind: fc.constant('fulfill' as const), pick }),
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('transfer' as const),
      what,
      from: loc,
      to: fc.integer({ min: 1, max: 2 }),
      qty: fc.integer({ min: 1, max: 2 }),
      ready: fc.constantFrom(true, true, false),
    }),
  },
  fc.record({ kind: fc.constant('ready' as const), pick }),
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('dispatch' as const), pick, qty: maybeQty }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('receiveTransfer' as const),
      pick,
      qty: maybeQty,
      damaged: fc.boolean(),
    }),
  },
  fc.record({ kind: fc.constant('cancel' as const), pick, qty: maybeQty }),
  fc.record({ kind: fc.constant('resolve' as const), pick, qty: maybeQty }),
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('return' as const),
      what,
      qty: fc.integer({ min: 1, max: 2 }),
      loc,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('inspect' as const),
      pick,
      disposition: fc.constantFrom<Disposition>(
        'sellable',
        'damaged',
        'repair',
        'supplier_return',
        'disposal',
      ),
      qty: maybeQty,
    }),
  },
  fc.record({
    kind: fc.constant('move' as const),
    what,
    from: fc.integer({ min: 0, max: 1 }),
    qty: fc.integer({ min: 1, max: 2 }),
  }),
);

const EXPECTED = new Set([
  'insufficient_stock',
  'reservation_not_open',
  'quantity_exceeds_allocated',
  'quantity_exceeds_held',
  'quantity_exceeds_in_transit',
  'nothing_to_cancel',
  'transfer_not_ready',
  'transfer_not_draft',
  'transfer_closed',
  'nothing_to_transfer',
  'same_location',
  'serial_count_mismatch',
  'quantity_exceeds_uninspected',
  'return_closed',
  'nothing_returnable',
]);

describe('stock conservation with transfers (A21, I2)', () => {
  it('keeps every invariant after each step', async () => {
    let serialNo = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 8, maxLength: 30 }), async (steps) => {
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
        const ids: Record<Kind, string> = { plain, lot, serial };
        const received: Record<Kind, number> = { plain: 0, lot: 0, serial: 0 };
        const gone: Record<string, number> = {};
        const reservations: string[] = [];
        const transfers: string[] = [];
        const returns: Array<{ returnId: string; variantId: string }> = [];
        const back: Record<string, number> = {};
        const disposedSoFar: Record<string, number> = {};
        // Some stock everywhere to start with, so transfers have something to move.
        for (const locationId of locations) {
          await h.run(ops.receiveStock, {
            variantId: plain,
            locationId,
            quantity: '6',
            unitCost: '3',
          });
          await h.run(ops.receiveStock, {
            variantId: lot,
            locationId,
            quantity: '4',
            lotCode: 'A',
            expiresOn: '2031-01-31',
          });
          const serials = Array.from({ length: 3 }, () => `D-${++serialNo}`);
          await h.run(ops.receiveStock, { variantId: serial, locationId, quantity: '3', serials });
        }
        received.plain += 18;
        received.lot += 12;
        received.serial += 9;
        const out = (variantId: string, q: string) => {
          gone[variantId] = (gone[variantId] ?? 0) + Number(q);
        };

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
                  lotCode: ['A', 'B'][s.lot],
                  expiresOn: ['2031-01-31', '2030-06-30'][s.lot],
                });
                received.lot += s.qty;
              } else {
                const serials = Array.from({ length: s.qty }, () => `D-${++serialNo}`);
                await h.run(ops.receiveStock, { ...base, quantity: String(s.qty), serials });
                received.serial += s.qty;
              }
            } else if (s.kind === 'reserve') {
              const r = await h.run(ops.reserveStock, {
                variantId: ids[s.what],
                quantity: String(s.qty),
              });
              reservations.push(r.reservationId);
            } else if (s.kind === 'fulfill') {
              if (reservations.length === 0) continue;
              const done = await h.run(ops.fulfillReservation, {
                reservationId: reservations[s.pick % reservations.length],
              });
              for (const l of done.lines as Array<{ variantId: string; quantity: string }>) {
                out(l.variantId, l.quantity);
              }
            } else if (s.kind === 'transfer') {
              const usePack = s.what === 'plain' && s.qty % 2 === 0;
              const t = await h.run(ops.createTransfer, {
                fromLocationId: locations[s.from],
                toLocationId: locations[(s.from + s.to) % 3],
                lines: [
                  {
                    variantId: ids[s.what],
                    quantity: usePack ? '1' : String(s.qty),
                    ...(usePack ? { packId: caseId } : {}),
                  },
                ],
                ready: s.ready,
              });
              transfers.push(t.transfer.transferId);
            } else if (s.kind === 'return') {
              const variantId = ids[s.what];
              const returned = back[variantId] ?? 0;
              let item: Record<string, unknown> = { variantId, quantity: String(s.qty) };
              if (s.what === 'lot') item = { ...item, lotCode: 'A' };
              if (s.what === 'serial') {
                const soldSerials = await ownerQuery<{ serial: string }>(
                  `select serial from serial_units where variant_id = $1 and status = 'sold'
                   order by serial limit $2`,
                  [variantId, s.qty],
                );
                if (soldSerials.length < s.qty)
                  throw Object.assign(new Error(), { code: 'nothing_returnable' });
                item = { variantId, serials: soldSerials.map((x) => x.serial) };
              }
              const ret = await h.run(ops.createReturn, {
                lines: [{ variantId, quantity: String(s.qty) }],
              });
              await h.run(ops.receiveReturn, {
                returnId: ret.return.returnId,
                locationId: locations[s.loc],
                items: [item],
              });
              returns.push({ returnId: ret.return.returnId, variantId });
              back[variantId] = returned + s.qty;
            } else if (s.kind === 'inspect') {
              if (returns.length === 0) continue;
              const r = returns[s.pick % returns.length]!;
              const done = await h.run(ops.inspectReturn, {
                returnId: r.returnId,
                inspections: [
                  {
                    variantId: r.variantId,
                    disposition: s.disposition,
                    ...(s.qty ? { quantity: String(s.qty) } : {}),
                  },
                ],
              });
              // Only what this step disposed leaves owned stock.
              const disposed = Number(done.return.lines[0].disposed);
              out(r.variantId, String(disposed - (disposedSoFar[r.returnId] ?? 0)));
              disposedSoFar[r.returnId] = disposed;
            } else if (s.kind === 'move') {
              await h.run(ops.moveStock, {
                fromLocationId: locations[s.from],
                toLocationId: locations[1 - s.from],
                lines: [{ variantId: ids[s.what], quantity: String(s.qty) }],
              });
            } else if (transfers.length > 0) {
              const transferId = transfers[s.pick % transfers.length]!;
              const t = await h.run(ops.getTransfer, { transferId });
              const variantId = t.lines[0].variantId as string;
              const qty =
                'qty' in s && s.qty ? [{ variantId, quantity: String(s.qty) }] : undefined;
              if (s.kind === 'ready') await h.run(ops.readyTransfer, { transferId });
              else if (s.kind === 'dispatch') {
                await h.run(ops.dispatchTransfer, { transferId, items: qty });
              } else if (s.kind === 'receiveTransfer') {
                await h.run(ops.receiveTransfer, {
                  transferId,
                  items: qty,
                  ...(s.damaged ? { condition: 'damaged' } : {}),
                });
              } else if (s.kind === 'cancel') {
                await h.run(ops.cancelTransfer, { transferId, items: qty });
              } else if (s.kind === 'resolve') {
                const r = await h.run(ops.resolveTransferException, {
                  transferId,
                  resolution: 'lost',
                  items: qty,
                });
                const after = await h.run(ops.getTransfer, { transferId });
                out(
                  variantId,
                  String(Number(after.lines[0].resolved) - Number(t.lines[0].resolved)),
                );
                expect(r.transfer.lines[0].resolved).toBe(after.lines[0].resolved);
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
          expect(Number(view.totals.ownedTotal)).toBe(
            received[k] - (gone[ids[k]] ?? 0) + (back[ids[k]] ?? 0),
          );
        }
        expect(await reconcileAll(shop.shopId)).toEqual([]);
      }),
      { numRuns: 15 },
    );
  });
});
