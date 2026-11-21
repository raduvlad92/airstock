import { ops, uuidv7 } from '@airstock/core';
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

// Valuation (plan Section 7.1, ADR 0022): random sequences of receipts at random unit costs (per
// base unit and per pack, some without a cost), fulfillments, adjustments in and out, returns
// back to stock (traced to their order's fulfillment cost), shelf moves, and transfers (received,
// left in transit, or lost) against a reference moving average written here. After every step
// the variant's owned quantity, moving average, value, and cost of goods match the reference.
//
// The reference works in exact integers of millionths (costs are numeric(20, 6)) and rounds the
// way the engine does: the average, a per-pack cost divided down to a base unit, and a return's
// traced cost are rounded half to even at 6 places; a value is the exact product of a whole
// quantity and the average; cost of goods is the exact sum of each fulfillment's quantity times
// the unit cost it recorded.

const db = appDatabase({}, 6);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
/** N1 and N2 in one warehouse, S1 in another. */
let locations: string[];

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Valuation property');
  h = harness(db, sink, shop);
  const north = await h.run(ops.createWarehouse, { name: 'Valuation north' });
  const south = await h.run(ops.createWarehouse, { name: 'Valuation south' });
  locations = [
    await createLeafLocation(h, north.warehouseId, 'N1'),
    await createLeafLocation(h, north.warehouseId, 'N2'),
    await createLeafLocation(h, south.warehouseId, 'S1'),
  ];
});
afterAll(() => db.close());

// Exact decimals as bigint millionths ------------------------------------------------------------

const SCALE = 1_000_000n;

function micro(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  if (fraction.length > 6) throw new Error(`more than 6 places: ${value}`);
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
  return negative ? -units : units;
}

function text(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  return `${sign}${abs / SCALE}.${(abs % SCALE).toString().padStart(6, '0')}`;
}

/** numerator ÷ denominator, rounded half to even to a whole number (both positive here). */
function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const twice = (numerator % denominator) * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) return quotient + 1n;
  return quotient;
}

// The reference model -----------------------------------------------------------------------------

interface Model {
  /** Owned whole units: on hand in every condition plus in transit. */
  quantity: bigint;
  /** Millionths per unit; null until a cost is known. */
  average: bigint | null;
  defaultCost: bigint | null;
  /** Exact cost of goods, in millionths. */
  costOfGoods: bigint;
  fulfilled: bigint;
  /** Per order: each fulfillment's units and the unit cost it recorded. */
  orders: Array<Array<{ quantity: bigint; unitCost: bigint | null }>>;
  returned: bigint[];
}

/** Units in, as apply_stock_cost costs them: entered, else default without stock, else average. */
function unitsIn(m: Model, quantity: bigint, entered: bigint | null): void {
  let applied: bigint | null = null;
  let moves = false;
  if (entered !== null) {
    applied = entered;
    moves = true;
  } else if (m.quantity === 0n && m.defaultCost !== null) {
    applied = m.defaultCost;
    moves = true;
  }
  if (moves && applied !== null) {
    m.average =
      m.average === null || m.quantity === 0n
        ? applied
        : divideHalfEven(m.quantity * m.average + quantity * applied, m.quantity + quantity);
  }
  m.quantity += quantity;
}

/** Units out leave at the average, which does not change. Returns the unit cost recorded. */
function unitsOut(m: Model, quantity: bigint): bigint | null {
  m.quantity -= quantity;
  return m.average;
}

// Steps -----------------------------------------------------------------------------------------

type Step =
  | { kind: 'receive'; loc: number; qty: number; cost: bigint | null; inPacks: boolean }
  | { kind: 'fulfill'; qty: number; order: number }
  | { kind: 'adjust'; loc: number; add: boolean; qty: number }
  | { kind: 'return'; order: number; qty: number; loc: number; disposition: Disposition }
  | { kind: 'move'; from: number; qty: number }
  | { kind: 'transfer'; from: number; qty: number; outcome: 'receive' | 'transit' | 'lost' };
type Disposition = 'sellable' | 'damaged' | 'disposal';

const PACK = 6n;

// Costs with whole cents, and costs using all six places (which make the averages round).
const cost = fc.oneof(
  fc.integer({ min: 0, max: 20_000 }).map((cents) => BigInt(cents) * 10_000n),
  fc.integer({ min: 1, max: 250_000_000 }).map(BigInt),
);

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('receive' as const),
      loc: fc.integer({ min: 0, max: 2 }),
      qty: fc.integer({ min: 1, max: 5 }),
      cost: fc.option(cost, { freq: 4 }),
      inPacks: fc.boolean(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('fulfill' as const),
      qty: fc.integer({ min: 1, max: 4 }),
      order: fc.integer({ min: 0, max: 1 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('adjust' as const),
      loc: fc.integer({ min: 0, max: 2 }),
      add: fc.boolean(),
      qty: fc.integer({ min: 1, max: 3 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('return' as const),
      order: fc.integer({ min: 0, max: 1 }),
      qty: fc.integer({ min: 1, max: 3 }),
      loc: fc.integer({ min: 0, max: 2 }),
      disposition: fc.constantFrom<Disposition>('sellable', 'sellable', 'damaged', 'disposal'),
    }),
  },
  fc.record({
    kind: fc.constant('move' as const),
    from: fc.integer({ min: 0, max: 1 }),
    qty: fc.integer({ min: 1, max: 4 }),
  }),
  fc.record({
    kind: fc.constant('transfer' as const),
    from: fc.integer({ min: 0, max: 2 }),
    qty: fc.integer({ min: 1, max: 4 }),
    outcome: fc.constantFrom('receive' as const, 'transit' as const, 'lost' as const),
  }),
);

/** Sellable available units of the variant at a shelf (or anywhere), as the engine sees them. */
async function available(variantId: string, locationId?: string): Promise<number> {
  const view = await h.run(ops.getAvailability, {
    variantId,
    ...(locationId ? { locationId } : {}),
  });
  return Number(view.totals.available);
}

async function expectEngineMatches(variantId: string, m: Model, label: string): Promise<void> {
  const [row] = await ownerQuery<{ quantity: string; average_cost: string | null }>(
    `select quantity::text, average_cost::text from variant_costs
     where shop_id = $1 and variant_id = $2`,
    [shop.shopId, variantId],
  );
  const valuation = await h.run(ops.getValuation, {
    variantId,
    from: '2000-01-01T00:00:00.000Z',
  });
  const [v] = valuation.variants as Array<{
    quantity: string;
    averageCost: string | null;
    value: string | null;
  }>;
  const engine = {
    quantity: micro(row?.quantity ?? '0'),
    average: row?.average_cost == null ? null : text(micro(row.average_cost)),
    valuedQuantity: v ? micro(v.quantity) : 0n,
    valuedAverage: v?.averageCost == null ? null : text(micro(v.averageCost)),
    value: v?.value == null ? null : text(micro(v.value)),
    costOfGoods: text(micro(valuation.costOfGoods.value)),
    fulfilled: micro(valuation.costOfGoods.quantity),
  };
  const average = m.average === null ? null : text(m.average);
  expect(engine, label).toEqual({
    quantity: m.quantity * SCALE,
    average,
    // Before the first change there is no history row, so nothing is valued.
    valuedQuantity: v ? m.quantity * SCALE : 0n,
    valuedAverage: v ? average : null,
    value: v && m.average !== null ? text(m.quantity * m.average) : null,
    costOfGoods: text(m.costOfGoods),
    fulfilled: m.fulfilled * SCALE,
  });
}

describe('moving average, value, and cost of goods against a reference (plan 7.1)', () => {
  it('match after every receipt, fulfillment, adjustment, return, and transfer', async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.option(cost, { freq: 2 }),
        fc.array(step, { minLength: 8, maxLength: 24 }),
        async (defaultCost, steps) => {
          run++;
          const variantId = await createVariant(h);
          const packs = await h.run(ops.setPacks, {
            variantId,
            packsVersion: 0,
            packs: [{ name: 'Case', quantity: String(PACK) }],
          });
          const caseId = packs.packaging.packs[0].id as string;
          if (defaultCost !== null) {
            await h.run(ops.setStockSettings, { variantId, defaultCost: text(defaultCost) });
          }
          const m: Model = {
            quantity: 0n,
            average: null,
            defaultCost,
            costOfGoods: 0n,
            fulfilled: 0n,
            orders: [[], []],
            returned: [0n, 0n],
          };
          const orderRef = (n: number) => `val-${run}-${n}-${uuidv7().slice(-6)}`;
          const refs = [orderRef(0), orderRef(1)];

          for (const [i, s] of steps.entries()) {
            const label = `step ${i + 1}: ${JSON.stringify(s, (_, x) => (typeof x === 'bigint' ? String(x) : x))}`;
            if (s.kind === 'receive') {
              const base = { variantId, locationId: locations[s.loc] };
              if (s.inPacks) {
                await h.run(ops.receiveStock, {
                  ...base,
                  quantity: String(s.qty),
                  packId: caseId,
                  ...(s.cost === null ? {} : { unitCost: text(s.cost), costPer: 'pack' }),
                });
                // A per-pack cost is divided down to a base unit, half to even at 6 places.
                unitsIn(
                  m,
                  BigInt(s.qty) * PACK,
                  s.cost === null ? null : divideHalfEven(s.cost, PACK),
                );
              } else {
                await h.run(ops.receiveStock, {
                  ...base,
                  quantity: String(s.qty),
                  ...(s.cost === null ? {} : { unitCost: text(s.cost) }),
                });
                unitsIn(m, BigInt(s.qty), s.cost);
              }
            } else if (s.kind === 'fulfill') {
              const qty = Math.min(s.qty, await available(variantId));
              if (qty === 0) continue;
              const reserved = await h.run(ops.reserveStock, {
                variantId,
                quantity: String(qty),
                purpose: 'external_order',
                externalRef: refs[s.order],
              });
              await h.run(ops.fulfillReservation, { reservationId: reserved.reservationId });
              const unitCost = unitsOut(m, BigInt(qty));
              m.costOfGoods += BigInt(qty) * (unitCost ?? 0n);
              m.fulfilled += BigInt(qty);
              m.orders[s.order]!.push({ quantity: BigInt(qty), unitCost });
            } else if (s.kind === 'adjust') {
              const locationId = locations[s.loc]!;
              const qty = s.add ? s.qty : Math.min(s.qty, await available(variantId, locationId));
              if (qty === 0) continue;
              await h.run(ops.adjustStock, {
                locationId,
                adjustmentReason: s.add ? 'found' : 'damage',
                adjustments: [
                  { variantId, direction: s.add ? 'add' : 'remove', quantity: String(qty) },
                ],
              });
              // Units found come in at the average (or the default cost without stock).
              if (s.add) unitsIn(m, BigInt(qty), null);
              else unitsOut(m, BigInt(qty));
            } else if (s.kind === 'return') {
              const shipped = m.orders[s.order]!.reduce((sum, f) => sum + f.quantity, 0n);
              const qty = Math.min(s.qty, Number(shipped - m.returned[s.order]!));
              if (qty === 0) continue;
              const created = await h.run(ops.createReturn, {
                lines: [{ variantId, quantity: String(qty) }],
                orderRef: refs[s.order],
                reason: 'Changed their mind',
              });
              const returnId = created.return.returnId as string;
              await h.run(ops.receiveReturn, { returnId, locationId: locations[s.loc] });
              // Returned units re-enter at the order's fulfillment cost, weighted by quantity
              // over every fulfillment of the order, when each recorded a cost (ADR 0029).
              const lines = m.orders[s.order]!;
              const traced = lines.every((f) => f.unitCost !== null)
                ? divideHalfEven(
                    lines.reduce((sum, f) => sum + f.quantity * f.unitCost!, 0n),
                    shipped,
                  )
                : null;
              unitsIn(m, BigInt(qty), traced);
              m.returned[s.order]! += BigInt(qty);
              await h.run(ops.inspectReturn, {
                returnId,
                inspections: [{ variantId, disposition: s.disposition }],
              });
              // Sellable and damaged change only the condition; disposal writes the units off.
              if (s.disposition === 'disposal') unitsOut(m, BigInt(qty));
            } else if (s.kind === 'move') {
              const qty = Math.min(s.qty, await available(variantId, locations[s.from]));
              if (qty === 0) continue;
              await h.run(ops.moveStock, {
                fromLocationId: locations[s.from],
                toLocationId: locations[1 - s.from],
                lines: [{ variantId, quantity: String(qty) }],
              });
            } else {
              const qty = Math.min(s.qty, await available(variantId, locations[s.from]));
              if (qty === 0) continue;
              const created = await h.run(ops.createTransfer, {
                fromLocationId: locations[s.from],
                toLocationId: locations[s.from === 2 ? 0 : 2],
                lines: [{ variantId, quantity: String(qty) }],
                ready: true,
              });
              const transferId = created.transfer.transferId as string;
              await h.run(ops.dispatchTransfer, { transferId });
              // In transit the units stay owned, at the same average (ADR 0028).
              if (s.outcome === 'receive') await h.run(ops.receiveTransfer, { transferId });
              if (s.outcome === 'lost') {
                await h.run(ops.resolveTransferException, { transferId, resolution: 'lost' });
                unitsOut(m, BigInt(qty));
              }
            }
            await expectEngineMatches(variantId, m, label);
          }
          expect(await reconcile(shop.shopId)).toEqual([]);
        },
      ),
      { numRuns: 20 },
    );
  });
});
