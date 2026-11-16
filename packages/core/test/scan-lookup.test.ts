import { ops } from '@airstock/core';
import { locationCode } from '@airstock/core/barcodes';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  appDatabase,
  createLeafLocation,
  type Harness,
  harness,
  MemoryAuditSink,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';

// Scan lookup (plan 5.12, D13): what a scanned code names — a location label, a variant or pack
// barcode, a serial or certificate number, a location code, or a SKU — with stock per location.
// A lookup is a read and is logged as one. Location scope (A42) and shop isolation (A13) apply.

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let shelf: string;
let box: { variantId: string; productId: string };
let caseId: string;
let slab: { variantId: string };

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Scan lookup shop');
  h = harness(db, sink, shop);
  shelf = (
    await h.run(ops.createLocation, {
      warehouseId: shop.warehouseId,
      name: 'Shelf B',
      code: 'B-02',
    })
  ).locationId;
  box = await h.run(ops.createItem, {
    name: 'Booster box',
    sku: 'BOX-SCAN-1',
    barcode: '4006381333931',
  });
  const packed = await h.run(ops.setPacks, {
    variantId: box.variantId,
    packsVersion: 0,
    packs: [{ name: 'Case', quantity: '6' }],
  });
  caseId = packed.packaging.packs[0].id;
  const pkg = await h.run(ops.getPackaging, { variantId: box.variantId });
  await h.run(ops.setBarcodes, {
    variantId: box.variantId,
    barcodesVersion: pkg.barcodesVersion,
    barcodes: [
      { code: '4006381333931', symbology: 'ean13' },
      { code: 'CASE-BOX-6', symbology: 'code128', packId: caseId },
    ],
  });
  await h.run(ops.receiveStock, {
    variantId: box.variantId,
    locationId: shelf,
    quantity: '2',
    packId: caseId,
  });
  // A serialized shared variant: graded slabs share a price, each has its certificate.
  slab = await h.run(ops.createItem, { name: 'Graded slab', sku: 'SLAB-1' });
  await h.run(ops.setStockSettings, { variantId: slab.variantId, trackingMode: 'serial' });
  await h.run(ops.receiveStock, {
    variantId: slab.variantId,
    locationId: shelf,
    quantity: '1',
    serials: ['84731629'],
  });
});
afterAll(() => db.close());

describe('scan lookup', () => {
  it('reads a location label and a location code', async () => {
    const label = await h.run(ops.scanLookup, { code: locationCode(shelf) });
    expect(label).toMatchObject({
      kind: 'location',
      location: { locationId: shelf, path: 'Main stock/B-02', holdsStock: true },
      item: null,
    });
    const typed = await h.run(ops.scanLookup, { code: 'b-02' });
    expect(typed.location.locationId).toBe(shelf);
  });

  it('reads a product barcode with its stock, and a case barcode with its pack', async () => {
    const product = await h.run(ops.scanLookup, { code: '04006381333931' });
    expect(product).toMatchObject({
      kind: 'item',
      item: {
        variantId: box.variantId,
        sku: 'BOX-SCAN-1',
        matchedBy: 'barcode',
        pack: null,
        packs: [{ packId: caseId, name: 'Case', baseQuantity: '6' }],
      },
    });
    expect(product.stock.totals.onHand).toBe('12.000000');
    expect(product.stock.positions).toEqual([
      expect.objectContaining({ locationId: shelf, onHand: '12.000000' }),
    ]);
    const kase = await h.run(ops.scanLookup, { code: 'case-box-6', includeStock: 'false' });
    expect(kase.item.pack).toEqual({ packId: caseId, name: 'Case', baseQuantity: '6' });
    expect(kase.stock).toBeNull();
  });

  it('reads a certificate number as the serialized unit, and a typed SKU', async () => {
    const cert = await h.run(ops.scanLookup, { code: '84731629' });
    expect(cert).toMatchObject({
      kind: 'item',
      item: {
        variantId: slab.variantId,
        matchedBy: 'serial',
        trackingMode: 'serial',
        serial: { serial: '84731629', status: 'in_stock', locationId: shelf },
      },
    });
    const sku = await h.run(ops.scanLookup, { code: ' box-scan-1 ' });
    expect(sku.item).toMatchObject({ variantId: box.variantId, matchedBy: 'sku' });
  });

  it('says when a code is unknown, and logs every lookup as a read', async () => {
    const before = sink.events.length;
    const unknown = await h.run(ops.scanLookup, { code: 'NOTHING-HERE' });
    expect(unknown).toEqual({
      code: 'NOTHING-HERE',
      kind: 'unknown',
      location: null,
      item: null,
      stock: null,
    });
    const logged = sink.events.slice(before).filter((e) => e.action === 'warehouse.scan.looked_up');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      shop_id: shop.shopId,
      context: expect.objectContaining({ code: 'NOTHING-HERE', kind: 'unknown' }),
    });
  });

  it('keeps a member scoped to one location to that location (A42)', async () => {
    const other = await createLeafLocation(h, shop.warehouseId, 'Back room');
    await h.run(ops.receiveStock, { variantId: box.variantId, locationId: other, quantity: '1' });
    const member = await addMember(shop.shopId, 'inventory_operator', [shelf]);
    const scoped = await h.run(
      ops.scanLookup,
      { code: '4006381333931' },
      { caller: member.caller },
    );
    expect(scoped.stock.partial).toBe(true);
    expect(scoped.stock.positions.map((p: { locationId: string }) => p.locationId)).toEqual([
      shelf,
    ]);
    await expect(
      h.run(ops.scanLookup, { code: locationCode(other) }, { caller: member.caller }),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
  });

  it('never finds another shop’s codes (A13)', async () => {
    const otherShop = await seedShop(db, sink, 'Other scan shop');
    const o = harness(db, sink, otherShop);
    expect((await o.run(ops.scanLookup, { code: '4006381333931' })).kind).toBe('unknown');
    expect((await o.run(ops.scanLookup, { code: '84731629' })).kind).toBe('unknown');
    await expect(o.run(ops.scanLookup, { code: locationCode(shelf) })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
