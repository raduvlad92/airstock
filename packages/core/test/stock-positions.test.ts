import { readFileSync } from 'node:fs';
import { ops, uuidv7 } from '@airstock/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
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

// I7 (migration 0081): stock_positions computes eligibility once per query and filters variants
// with a semi-join, and stock_positions() covers the whole shop. Every form must return exactly
// what migration 0017's function returned, for every branch of the "sellable now" rule.

const db = appDatabase({}, 4);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
});
afterAll(() => db.close());

/** Migration 0017's body of stock_positions(p_variant_ids), as a query taking $1. */
function originalRule(): string {
  const sql = readFileSync(
    new URL('../../db/migrations/0017_stock_engine.sql', import.meta.url),
    'utf8',
  );
  const start = sql.indexOf('create function stock_positions(p_variant_ids uuid[])');
  const body = sql.slice(sql.indexOf('as $$', start) + 5, sql.indexOf('$$;', start));
  // The function's own column names (RETURNS TABLE), not the body's expressions.
  return `select * from (${body.replaceAll('p_variant_ids', '$1::uuid[]')}) as sp(position_id,
    variant_id, location_id, warehouse_id, location_path, path_ids, condition, lot_id, serial_id,
    transfer_id, on_hand, allocated, reserved, sellable, lot_expired, available, received_at,
    expires_on)`;
}

/** Runs queries as the runtime role in this shop, like the app. */
async function asApp<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<unknown[]>) => T) {
  const client = new pg.Client({ connectionString: inject('databases').appUrl });
  await client.connect();
  try {
    await client.query('begin read only');
    await client.query(`select set_config('app.shop_id', $1, true)`, [shop.shopId]);
    return await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const byPosition = (rows: unknown[]) =>
  [...(rows as Array<{ position_id: string }>)].sort((a, b) =>
    a.position_id.localeCompare(b.position_id),
  );

describe('stock_positions after migration 0081 (I7)', () => {
  it('returns the same rows as the original rule in every form, for every branch', async () => {
    // Locations: an eligible shelf, a shelf under an ineligible parent, and a shelf in an
    // ineligible warehouse.
    const parent = await createLeafLocation(h, shop.warehouseId, `Parent ${uuidv7().slice(-4)}`);
    const child = (
      await h.run(ops.createLocation, {
        warehouseId: shop.warehouseId,
        parentId: parent,
        name: 'Child',
      })
    ).locationId as string;
    const far = await h.run(ops.createWarehouse, { name: `Closed ${uuidv7().slice(-4)}` });
    const closed = await createLeafLocation(h, far.warehouseId, 'Closed shelf');
    const open = await createLeafLocation(h, far.warehouseId, 'Still closed');

    const plain = await createVariant(h);
    for (const [locationId, quantity] of [
      [shop.locationId, '10'],
      [child, '5'],
      [closed, '4'],
    ] as const) {
      await h.run(ops.receiveStock, { variantId: plain, locationId, quantity });
    }
    await h.run(ops.receiveStock, {
      variantId: plain,
      locationId: shop.locationId,
      quantity: '2',
      condition: 'quarantine',
    });
    // A claim that expires below (the sweeper has not run), and one that never expires.
    const expiring = await h.run(ops.reserveStock, {
      variantId: plain,
      quantity: '3',
      expiresInSeconds: 60,
    });
    await h.run(ops.reserveStock, { variantId: plain, quantity: '1', expiresInSeconds: null });
    // In transit.
    const { transfer } = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: open,
      lines: [{ variantId: plain, quantity: '1' }],
      ready: true,
    });
    await h.run(ops.dispatchTransfer, { transferId: transfer.transferId });

    // Lots: one past its sell-by date (margin 30 days), one still good.
    const lotted = await createVariant(h);
    await h.run(ops.setStockSettings, {
      variantId: lotted,
      trackingMode: 'lot_expiry',
      sellByMarginDays: 30,
    });
    await h.run(ops.receiveStock, {
      variantId: lotted,
      locationId: shop.locationId,
      quantity: '3',
      lotCode: 'SOON',
      expiresOn: day(10),
    });
    await h.run(ops.receiveStock, {
      variantId: lotted,
      locationId: child,
      quantity: '2',
      lotCode: 'LATER',
      expiresOn: day(90),
    });

    // The claim expires after the last command (a command releases expired claims it meets).
    await ownerQuery(
      `update reservations set expires_at = now() - interval '1 minute' where shop_id = $1 and id = $2`,
      [shop.shopId, expiring.reservationId],
    );
    // Eligibility switched off after the stock arrived, as a person would.
    await ownerQuery(
      'update locations set fulfillment_eligible = false where shop_id = $1 and id = $2',
      [shop.shopId, parent],
    );
    await ownerQuery(
      'update warehouses set fulfillment_eligible = false where shop_id = $1 and id = $2',
      [shop.shopId, far.warehouseId],
    );

    const variants = [plain, lotted];
    await asApp(async (q) => {
      const original = byPosition(await q(originalRule(), [variants]));
      // Every branch of the rule is exercised.
      const rows = original as Array<Record<string, unknown>>;
      expect(rows.some((r) => r.transfer_id !== null)).toBe(true);
      expect(rows.some((r) => r.condition === 'quarantine')).toBe(true);
      expect(rows.some((r) => r.lot_expired === true)).toBe(true);
      expect(rows.some((r) => Number(r.reserved) < Number(r.allocated))).toBe(true);
      expect(
        rows
          .filter((r) => r.location_id === child || r.location_id === closed)
          .every((r) => r.sellable === false),
      ).toBe(true);
      expect(rows.some((r) => r.sellable === true)).toBe(true);

      expect(byPosition(await q('select * from stock_positions($1::uuid[])', [variants]))).toEqual(
        original,
      );
      expect(
        byPosition(
          await q('select * from stock_positions() where variant_id = any($1::uuid[])', [variants]),
        ),
      ).toEqual(original);
      const each = [];
      for (const v of variants) {
        each.push(...(await q('select * from stock_positions(array[$1::uuid])', [v])));
      }
      expect(byPosition(each)).toEqual(original);
      // The whole shop: the same as the original over every variant of the shop.
      expect(byPosition(await q('select * from stock_positions()'))).toEqual(
        byPosition(await q(originalRule(), [await allVariants(q)])),
      );
    });
    expect(await reconcile(shop.shopId)).toEqual([]);
  });
});

async function allVariants(q: (sql: string, params?: unknown[]) => Promise<unknown[]>) {
  const rows = (await q('select array_agg(id) as ids from variants')) as Array<{ ids: string[] }>;
  return rows[0]!.ids;
}
