import { ops } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appDatabase,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
  ownerQuery,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';

const db = appDatabase();
const sink = new MemoryAuditSink();
let a: SeededShop;
let b: SeededShop;
let ha: Harness;
let hb: Harness;
let variantB: string;
let reservationB: string;
let lotB: string;

beforeAll(async () => {
  a = await seedShop(db, sink, 'Shop A');
  b = await seedShop(db, sink, 'Shop B');
  ha = harness(db, sink, a);
  hb = harness(db, sink, b);
  variantB = await createVariant(hb);
  await hb.run(ops.receiveStock, { variantId: variantB, locationId: b.locationId, quantity: '10' });
  reservationB = (await hb.run(ops.reserveStock, { variantId: variantB, quantity: '2' }))
    .reservationId;
  const lotted = await createVariant(hb);
  await hb.run(ops.setStockSettings, { variantId: lotted, trackingMode: 'lot' });
  lotB = (
    await hb.run(ops.receiveStock, {
      variantId: lotted,
      locationId: b.locationId,
      quantity: '1',
      lotCode: 'B-LOT',
    })
  ).lot.lotId;
});
afterAll(() => db.close());

describe('tenant isolation (A13)', () => {
  it('answers not found for a shop the caller does not belong to, and logs the denial', async () => {
    await expect(ha.run(ops.getShopContext, {}, { shopId: b.shopId })).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    const denial = sink.events.find((e) => e.actor_id === a.userId && e.shop_id === b.shopId);
    expect(denial).toMatchObject({ outcome: 'denied', action: 'shop.context.viewed' });
  });

  it.each([
    ['another shop’s variant', () => ha.run(ops.getAvailability, { variantId: variantB })],
    [
      'another shop’s variant in a receipt',
      () =>
        ha.run(ops.receiveStock, { variantId: variantB, locationId: a.locationId, quantity: '1' }),
    ],
    [
      'another shop’s location',
      async () =>
        ha.run(ops.receiveStock, {
          variantId: await createVariant(ha),
          locationId: b.locationId,
          quantity: '1',
        }),
    ],
    [
      'another shop’s reservation',
      () => ha.run(ops.releaseReservation, { reservationId: reservationB }),
    ],
    [
      'another shop’s warehouse',
      () => ha.run(ops.createLocation, { warehouseId: b.warehouseId, name: 'X' }),
    ],
    [
      'another shop’s reservation to fulfill',
      () => ha.run(ops.fulfillReservation, { reservationId: reservationB }),
    ],
    [
      'another shop’s reservation to reallocate',
      () =>
        ha.run(ops.reallocateReservation, {
          reservationId: reservationB,
          locationId: a.locationId,
        }),
    ],
    [
      'another shop’s reservation in a list',
      () => ha.run(ops.listReservations, { reservationId: reservationB }),
    ],
    ['another shop’s variant’s lots', () => ha.run(ops.listLots, { variantId: variantB })],
    ['another shop’s lot', () => ha.run(ops.traceLot, { lotId: lotB })],
    [
      'another shop’s serial',
      () => ha.run(ops.serialHistory, { variantId: variantB, serial: 'X' }),
    ],
    ['another shop’s variant’s value', () => ha.run(ops.getValuation, { variantId: variantB })],
    [
      'another shop’s variant’s stock settings',
      () => ha.run(ops.setStockSettings, { variantId: variantB, oneOfAKind: true }),
    ],
    [
      'another shop’s warehouse in an allocation rule',
      () => ha.run(ops.setAllocationRule, { channel: 'x', locationIds: [b.warehouseId] }),
    ],
    [
      'another shop’s variant in a reservation',
      () => ha.run(ops.reserveStock, { variantId: variantB, quantity: '1' }),
    ],
  ])('cannot reach %s', async (_label, call) => {
    await expect(call()).rejects.toMatchObject({ status: 404 });
  });

  it('leaves the other shop untouched', async () => {
    const view = await hb.run(ops.getAvailability, { variantId: variantB });
    expect(view.totals).toMatchObject({ onHand: '10.000000', reserved: '2.000000' });
  });
});

describe('row-level security for the runtime role', () => {
  it('shows only the current shop’s rows, whatever the query asks for', async () => {
    const rows = await db.transaction({ shopId: a.shopId, userId: null, readOnly: true }, (tx) =>
      tx.query<{ shop_id: string }>(
        'select distinct shop_id from inventory_positions union select distinct shop_id from variants',
      ),
    );
    expect(rows.every((r) => r.shop_id === a.shopId)).toBe(true);
    const leak = await db.transaction({ shopId: a.shopId, userId: null, readOnly: true }, (tx) =>
      tx.query('select * from variants where id = $1', [variantB]),
    );
    expect(leak).toHaveLength(0);
  });

  it('keeps the stock engine tables to their shop (A13, milestone I1)', async () => {
    // Shop B gets a row in every new table; shop A's runtime role must see none of them.
    const op = `select id from inventory_operations where shop_id = $1 limit 1`;
    const [opRow] = await ownerQuery<{ id: string }>(op, [b.shopId]);
    await ownerQuery(
      `with lot as (
         insert into lots (shop_id, id, variant_id, code, code_normalized, created_operation_id)
         values ($1, gen_random_uuid(), $2, 'L1', 'L1', $3) returning id),
       rule as (
         insert into allocation_rules (shop_id, id, channel) values ($1, gen_random_uuid(), 'default')
         returning id),
       rule_loc as (
         insert into allocation_rule_locations (shop_id, rule_id, position, scope_id)
         select $1, rule.id, 0, $4 from rule),
       alert as (
         insert into alerts (shop_id, id, kind, dedupe_key) values ($1, gen_random_uuid(), 'test', 'test')),
       rec as (
         insert into stock_reconciliations (shop_id, id, trigger, problems)
         values ($1, gen_random_uuid(), 'daily', 0))
       select 1`,
      [b.shopId, variantB, opRow!.id, b.locationId],
    );
    const tables = [
      'lots',
      'allocation_rules',
      'allocation_rule_locations',
      'variant_costs',
      'variant_cost_history',
      'alerts',
      'stock_reconciliations',
      'serial_units',
    ];
    for (const table of tables) {
      const rows = await db.transaction({ shopId: a.shopId, userId: null, readOnly: true }, (tx) =>
        tx.query<{ shop_id: string }>(`select shop_id from ${table}`),
      );
      expect(
        rows.filter((r) => r.shop_id !== a.shopId),
        table,
      ).toEqual([]);
    }
    const seenByB = await db.transaction({ shopId: b.shopId, userId: null, readOnly: true }, (tx) =>
      tx.query<{ n: number }>('select count(*)::int as n from variant_costs'),
    );
    expect(seenByB[0]?.n).toBeGreaterThan(0);
    // Valuation history is written once, never changed.
    await expect(
      db.transaction({ shopId: b.shopId, userId: null }, (tx) =>
        tx.query('update variant_cost_history set quantity_after = 0'),
      ),
    ).rejects.toThrow(/permission denied/);
    // Another shop's stock function results stay out of reach too.
    const foreign = await db.transaction({ shopId: a.shopId, userId: null, readOnly: true }, (tx) =>
      tx.query('select * from stock_positions(array[$1::uuid])', [variantB]),
    );
    expect(foreign).toHaveLength(0);
  });

  it('rejects writes into another shop', async () => {
    await expect(
      db.transaction({ shopId: a.shopId, userId: null }, (tx) =>
        tx.query(`insert into products (shop_id, id, name) values ($1, gen_random_uuid(), 'x')`, [
          b.shopId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot change or delete history', async () => {
    await expect(
      db.transaction({ shopId: a.shopId, userId: null }, (tx) =>
        tx.query('update inventory_entries set delta = 999'),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.transaction({ shopId: a.shopId, userId: null }, (tx) =>
        tx.query('delete from audit_events'),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('sees nothing without a tenant context', async () => {
    const rows = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
      tx.query('select 1 from inventory_positions union all select 1 from audit_events'),
    );
    expect(rows).toHaveLength(0);
  });
});
