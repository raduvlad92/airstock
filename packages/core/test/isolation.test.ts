import { ops } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appDatabase,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
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

beforeAll(async () => {
  a = await seedShop(db, sink, 'Shop A');
  b = await seedShop(db, sink, 'Shop B');
  ha = harness(db, sink, a);
  hb = harness(db, sink, b);
  variantB = await createVariant(hb);
  await hb.run(ops.receiveStock, { variantId: variantB, locationId: b.locationId, quantity: '10' });
  reservationB = (await hb.run(ops.reserveStock, { variantId: variantB, quantity: '2' }))
    .reservationId;
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
