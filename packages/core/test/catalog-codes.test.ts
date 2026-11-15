import { ops, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appDatabase,
  type Harness,
  harness,
  MemoryAuditSink,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';
import { inferSymbology } from '../src/catalog/barcodes.ts';

// Barcodes and supplier SKUs across milestones: the duplicate check on create (plan 5.7, N2 with
// N5) and catalog search by code (plan 5.8).

const db = appDatabase();
const sink = new MemoryAuditSink();
let shop: SeededShop;
let other: SeededShop;
let h: Harness;
let ho: Harness;

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Codes shop');
  other = await seedShop(db, sink, 'Other codes shop');
  h = harness(db, sink, shop);
  ho = harness(db, sink, other);
});
afterAll(() => db.close());

async function rejects(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { status: number; code: string; extra: Record<string, unknown> };
  }
  throw new Error('Expected the call to fail.');
}

const create = (harnessFor: Harness, extra: Record<string, unknown>) =>
  harnessFor.run(ops.createItem, {
    name: `Coded item ${uuidv7().slice(-8)}`,
    sku: `CODE-${uuidv7().slice(-8)}`,
    acknowledgeSimilar: true,
    ...extra,
  }) as Promise<{ productId: string; variantId: string; sku: string }>;

describe('barcodes on create', () => {
  it('detects the symbology of a bare code', () => {
    expect(inferSymbology('4006381333931')).toBe('ean13');
    expect(inferSymbology('036000291452')).toBe('upca');
    expect(inferSymbology('96385074')).toBe('ean8');
    expect(inferSymbology('4 006381 333931')).toBe('ean13');
    expect(inferSymbology('4006381333932')).toBe('code128');
    expect(inferSymbology('INT-0042')).toBe('code128');
    expect(inferSymbology('Ünïcode')).toBe('other');
  });

  it('stores the barcode and refuses the same code, however it is written', async () => {
    const first = await create(h, { barcode: '036000291452' });
    const packaging = await h.run(ops.getPackaging, { variantId: first.variantId });
    expect(packaging.barcodes).toEqual([
      expect.objectContaining({ code: '036000291452', symbology: 'upca', packId: null }),
    ]);

    // The same GTIN as an EAN-13, on another product.
    const dup = await rejects(create(h, { barcode: '0036000291452' }));
    expect(dup).toMatchObject({ status: 409, code: 'duplicate_barcode' });
    expect(dup.extra.existing).toMatchObject({ ownerType: 'variant', ownerId: first.variantId });

    // The check names the owner before anything is created.
    const check = await h.run(ops.checkDuplicates, { barcode: '0036000291452' });
    expect(check.barcodeTaken).toMatchObject({ ownerId: first.variantId });

    // Another shop may use the same code.
    await create(ho, { barcode: '036000291452' });
  });

  it('refuses a GTIN with a wrong check digit only when it is typed as one', async () => {
    // Thirteen digits that fail the GS1 check digit are not a GTIN, so they are stored as Code 128.
    const item = await create(h, { barcode: '4006381333932' });
    const packaging = await h.run(ops.getPackaging, { variantId: item.variantId });
    expect(packaging.barcodes[0]).toMatchObject({ symbology: 'code128' });
  });
});

describe('search by code', () => {
  it('finds a variant by its barcode, a pack barcode, or a supplier SKU, in this shop only', async () => {
    const item = await create(h, { barcode: '4006381333931' });
    const supplier = (await h.run(ops.createSupplier, { name: `Acme ${uuidv7().slice(-6)}` }))
      .supplier;
    await h.run(ops.saveSupplierItem, {
      supplierId: supplier.id,
      variantId: item.variantId,
      supplierSku: 'acme 77-b',
    });

    const variantsFor = async (harnessFor: Harness, search: string, mode = 'variants') =>
      (
        (await harnessFor.run(ops.queryItems, { search, mode })) as {
          rows: Array<{ variantId: string | null; productId: string }>;
        }
      ).rows;

    // Scanned with the leading zero a GTIN-14 reader adds.
    expect((await variantsFor(h, '04006381333931'))[0]).toMatchObject({
      variantId: item.variantId,
    });
    expect((await variantsFor(h, 'ACME 77-B'))[0]).toMatchObject({ variantId: item.variantId });
    expect((await variantsFor(h, '4006381333931', 'products')).map((r) => r.productId)).toContain(
      item.productId,
    );
    expect(await variantsFor(ho, '4006381333931')).toEqual([]);
  });
});
