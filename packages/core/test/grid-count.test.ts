import { ops, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
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

// G5 (plan 5.6, ADR 0031): a quantity typed in the catalog grid is a one-line quick count. The
// grid reads on hand and the position version at one location (catalog query stockAt) and sends
// them back as `read`; a count whose position moved since is refused for review, never applied
// silently, and a version changed only by reservations passes.

const db = appDatabase({}, 6);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let shelf: string;
let otherShelf: string;

// biome-ignore lint/suspicious/noExplicitAny: tests read many result shapes
type Row = Record<string, any>;

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Grid count shop');
  h = harness(db, sink, shop);
  shelf = await createLeafLocation(h, shop.warehouseId, 'Grid shelf');
  otherShelf = await createLeafLocation(h, shop.warehouseId, 'Other grid shelf');
});
afterAll(() => db.close());

/** The grid's row for a variant, with stock at `at`. */
async function gridRow(variantId: string, at = shelf, caller = shop.caller): Promise<Row> {
  const sku = (await h.run(ops.getAvailability, { variantId })).sku;
  const res = await h.run(
    ops.queryItems,
    { mode: 'variants', search: sku, stockAt: at, fields: ['available'] },
    { caller },
  );
  return res.rows.find((r: Row) => r.variantId === variantId);
}

async function onHandAt(variantId: string, at = shelf): Promise<string> {
  return (await gridRow(variantId, at)).stockAt.onHand;
}

describe('the grid’s stock column (catalog query stockAt)', () => {
  it('gives on hand and the position version at one shelf, and says what can be counted', async () => {
    const plain = await createVariant(h);
    await h.run(ops.receiveStock, { variantId: plain, locationId: shelf, quantity: '7' });
    await h.run(ops.receiveStock, { variantId: plain, locationId: otherShelf, quantity: '2' });
    const row = await gridRow(plain);
    expect(row.stockAt).toEqual({
      locationId: shelf,
      onHand: '7.000000',
      version: expect.any(Number),
      countable: true,
    });
    // Nothing there yet: no version, on hand 0.
    const empty = await createVariant(h);
    expect((await gridRow(empty)).stockAt).toMatchObject({
      onHand: '0',
      version: null,
      countable: true,
    });

    const lotted = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId: lotted, trackingMode: 'lot' });
    await h.run(ops.receiveStock, {
      variantId: lotted,
      locationId: shelf,
      quantity: '3',
      lotCode: 'A',
    });
    await h.run(ops.receiveStock, {
      variantId: lotted,
      locationId: shelf,
      quantity: '4',
      lotCode: 'B',
    });
    // Lots are counted by lot in the stock panel; the grid shows the total, read-only.
    expect((await gridRow(lotted)).stockAt).toMatchObject({ onHand: '7.000000', countable: false });
  });

  it('needs a shelf within the member’s locations', async () => {
    const variantId = await createVariant(h);
    const sku = (await h.run(ops.getAvailability, { variantId })).sku;
    await expect(
      h.run(ops.queryItems, { mode: 'variants', search: sku, stockAt: shop.warehouseId }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const far = await h.run(ops.createWarehouse, { name: `Far ${uuidv7().slice(-4)}` });
    const farShelf = await createLeafLocation(h, far.warehouseId, 'Far shelf');
    const scoped = await addMember(shop.shopId, 'manager', [shop.warehouseId]);
    await expect(
      h.run(
        ops.queryItems,
        { mode: 'variants', search: sku, stockAt: farShelf },
        { caller: scoped.caller },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect((await gridRow(variantId, shelf, scoped.caller)).stockAt.countable).toBe(true);
  });
});

describe('a count typed in the grid (quick count with read)', () => {
  it('sets the shelf to the number typed when nothing moved since it was read', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shelf, quantity: '10' });
    const { stockAt } = await gridRow(variantId);
    const res = await h.run(ops.quickCount, {
      locationId: shelf,
      counts: [
        { variantId, counted: '8', read: { version: stockAt.version, onHand: stockAt.onHand } },
      ],
    });
    expect(res.changes).toEqual([expect.objectContaining({ delta: '-2' })]);
    expect(await onHandAt(variantId)).toBe('8.000000');
    // In the history as a count correction.
    const history = await h.run(ops.listCounts, { status: 'submitted', limit: 100 });
    expect(history.counts.some((c: Row) => c.sessionId === res.sessionId)).toBe(true);
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('is refused for review when units moved since it was read, and posts what the person chose', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shelf, quantity: '10' });
    const read = (await gridRow(variantId)).stockAt;
    // Someone receives 5 while the grid shows 10.
    await h.run(ops.receiveStock, { variantId, locationId: shelf, quantity: '5' });
    const count = (counted: string, r: { version: number; onHand: string }) =>
      h.run(ops.quickCount, { locationId: shelf, counts: [{ variantId, counted, read: r }] });
    const refused = await count('8', { version: read.version, onHand: read.onHand }).catch(
      (e: unknown) => e as Row,
    );
    expect(refused).toMatchObject({ status: 409, code: 'moved_since_read' });
    expect(refused.extra.positions).toEqual([
      {
        variantId,
        locationId: shelf,
        condition: 'sellable',
        lotId: null,
        read: { version: read.version, onHand: '10' },
        now: { version: expect.any(Number), onHand: '15' },
      },
    ]);
    // Nothing changed.
    expect(await onHandAt(variantId)).toBe('15.000000');
    // "Count plus movements since": 8 + 5, against what is there now.
    const now = refused.extra.positions[0].now;
    await count('13', now);
    expect(await onHandAt(variantId)).toBe('13.000000');
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('passes when only reservations changed the position, and still asks about reserved units', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shelf, quantity: '6' });
    const read = (await gridRow(variantId)).stockAt;
    const r = await h.run(ops.reserveStock, {
      variantId,
      quantity: '4',
      locationId: shelf,
      externalRef: 'grid:order/1',
    });
    expect((await gridRow(variantId)).stockAt.version).not.toBe(read.version);
    const input = {
      locationId: shelf,
      counts: [{ variantId, counted: '2', read: { version: read.version, onHand: read.onHand } }],
    };
    // Same on hand: no review, but 2 left under 4 reserved needs a choice per claim.
    await expect(h.run(ops.quickCount, input)).rejects.toMatchObject({ code: 'below_reserved' });
    await h.run(ops.quickCount, {
      ...input,
      reservationChoices: [
        { allocationId: r.allocations[0].allocationId, action: 'release', quantity: '2' },
      ],
    });
    expect(await onHandAt(variantId)).toBe('2.000000');
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('treats a position created since the read as moved, and needs one position for a read', async () => {
    const variantId = await createVariant(h);
    const read = (await gridRow(variantId)).stockAt;
    expect(read).toMatchObject({ version: null, onHand: '0' });
    await h.run(ops.receiveStock, { variantId, locationId: shelf, quantity: '3' });
    await expect(
      h.run(ops.quickCount, {
        locationId: shelf,
        counts: [{ variantId, counted: '1', read: { version: null, onHand: '0' } }],
      }),
    ).rejects.toMatchObject({ code: 'moved_since_read' });

    const serial = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId: serial, trackingMode: 'serial' });
    await h.run(ops.receiveStock, {
      variantId: serial,
      locationId: shelf,
      quantity: '2',
      serials: [`GS-${uuidv7().slice(-6)}`, `GT-${uuidv7().slice(-6)}`],
    });
    await expect(
      h.run(ops.quickCount, {
        locationId: shelf,
        counts: [{ variantId: serial, counted: '0', read: { version: 1, onHand: '2' } }],
      }),
    ).rejects.toMatchObject({ code: 'read_needs_one_position' });
  });
});
