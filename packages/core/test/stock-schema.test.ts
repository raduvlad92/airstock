import { ops } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appDatabase,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
  ownerQuery,
  reconcile,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';

// Milestone I1 schema groundwork (migration 0017): the in-transit system location, the shared
// stock function, half-even rounding, lot expiry, and the owned quantity behind valuation.

const db = appDatabase();
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
});
afterAll(() => db.close());

async function inShop<R>(sql: string, params: unknown[] = []): Promise<R[]> {
  return db.transaction({ shopId: shop.shopId, userId: null, readOnly: true }, (tx) =>
    tx.query<R & Record<string, unknown>>(sql, params),
  ) as Promise<R[]>;
}

describe('in-transit system location (D1)', () => {
  it('exists once per shop, outside every warehouse, and is never listed or eligible', async () => {
    const rows = await ownerQuery<{ warehouse_id: string | null; fulfillment_eligible: boolean }>(
      `select warehouse_id, fulfillment_eligible from locations where shop_id = $1 and kind = 'in_transit'`,
      [shop.shopId],
    );
    expect(rows).toEqual([{ warehouse_id: null, fulfillment_eligible: false }]);
    const listed = await h.run(ops.listLocations, {});
    expect(listed.locations.map((l: { path: string }) => l.path)).toEqual(['Main stock']);
  });

  it('takes no receipts', async () => {
    const [transit] = await ownerQuery<{ id: string }>(
      `select id from locations where shop_id = $1 and kind = 'in_transit'`,
      [shop.shopId],
    );
    const variantId = await createVariant(h);
    await expect(
      h.run(ops.receiveStock, { variantId, locationId: transit!.id, quantity: '1' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('allows a second in-transit location for no shop', async () => {
    await expect(
      ownerQuery(
        `insert into locations (shop_id, id, warehouse_id, name, path, path_ids, fulfillment_eligible, kind)
         values ($1, gen_random_uuid(), null, 'Again', 'Again', '{}', false, 'in_transit')`,
        [shop.shopId],
      ),
    ).rejects.toThrow(/locations_in_transit_idx/);
  });
});

describe('shared SQL rules', () => {
  it('rounds half to even (D7)', async () => {
    const rows = await inShop<{ v: string }>(
      `select round_half_even(x, 2)::text as v from unnest(array[
         1.005, 1.015, 1.025, -1.005, -1.015, 2.5, 1.0049, 1.0051]::numeric[]) x`,
    );
    expect(rows.map((r) => Number(r.v))).toEqual([1.0, 1.02, 1.02, -1.0, -1.02, 2.5, 1.0, 1.01]);
    const [whole] = await inShop<{ a: string; b: string; c: string }>(
      `select round_half_even(2.5, 0)::text as a, round_half_even(3.5, 0)::text as b,
         round_half_even(-2.5, 0)::text as c`,
    );
    expect([Number(whole!.a), Number(whole!.b), Number(whole!.c)]).toEqual([2, 4, -2]);
  });

  it('ends a lot at the start of the day after its expiry, in the shop time zone, less the margin', async () => {
    const [row] = await inShop<{ plain: Date; margin: Date }>(
      `select lot_sellable_until('2027-03-31', 0, 'Europe/Berlin') as plain,
         lot_sellable_until('2027-03-31', 10, 'Europe/Berlin') as margin`,
    );
    // Midnight in Berlin (summer time from 28 March 2027) is 22:00 UTC the day before.
    expect(row!.plain.toISOString()).toBe('2027-03-31T22:00:00.000Z');
    expect(row!.margin.toISOString()).toBe('2027-03-21T23:00:00.000Z');
  });
});

describe('owned quantity behind the moving average (D7)', () => {
  it('follows receipts, and the reconciliation check agrees', async () => {
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
    const [cost] = await ownerQuery<{ quantity: string; average_cost: string }>(
      'select quantity::text, average_cost::text from variant_costs where variant_id = $1',
      [variantId],
    );
    expect(cost).toEqual({ quantity: '20.000000', average_cost: '5.000000' });
    const entries = await ownerQuery<{ unit_cost: string; cost_basis: string }>(
      'select unit_cost::text, cost_basis from inventory_entries where variant_id = $1 order by id',
      [variantId],
    );
    expect(entries).toEqual([
      { unit_cost: '4.000000', cost_basis: 'entered' },
      { unit_cost: '6.000000', cost_basis: 'entered' },
    ]);
    // A receipt without a cost takes the current average and leaves it unchanged.
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '5' });
    const [after] = await ownerQuery<{ unit_cost: string; cost_basis: string }>(
      `select unit_cost::text, cost_basis from inventory_entries where variant_id = $1
       order by id desc limit 1`,
      [variantId],
    );
    expect(after).toEqual({ unit_cost: '5.000000', cost_basis: 'average' });
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('reports a balance that history does not explain', async () => {
    const other = await seedShop(db, sink, 'Drift');
    const oh = harness(db, sink, other);
    const variantId = await createVariant(oh);
    await oh.run(ops.receiveStock, { variantId, locationId: other.locationId, quantity: '3' });
    expect(await reconcile(other.shopId)).toEqual([]);
    await ownerQuery('update inventory_positions set on_hand = 4 where variant_id = $1', [
      variantId,
    ]);
    const problems = await reconcile(other.shopId);
    expect(problems.some((p) => p.startsWith('on_hand_mismatch'))).toBe(true);
    expect(problems.some((p) => p.startsWith('cost_quantity_mismatch'))).toBe(true);
  });
});
