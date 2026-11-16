import { ops, uuidv7 } from '@airstock/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  appDatabase,
  createLeafLocation,
  type Harness,
  harness,
  MemoryAuditSink,
  ownerQuery,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';
import {
  checkBarcode,
  findBarcodeOwner,
  gtinCheckDigit,
  isValidGtin,
  normalizeBarcode,
  parseLocationCode,
} from '../src/catalog/barcodes.ts';
import { resolvePacks } from '../src/catalog/packs.ts';

// Phase 1, milestone N5: packs (A28 definitions), barcodes (F7), bundles, suppliers, labels.

const db = appDatabase();
const sink = new MemoryAuditSink();
let shop: SeededShop;
let other: SeededShop;
let h: Harness;
let ho: Harness;

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Packaging shop');
  other = await seedShop(db, sink, 'Other packaging shop');
  h = harness(db, sink, shop);
  ho = harness(db, sink, other);
});
afterAll(() => db.close());

async function rejects(
  promise: Promise<unknown>,
): Promise<{ status: number; code: string; extra: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { status: number; code: string; extra: Record<string, unknown> };
    return { status: e.status, code: e.code, extra: e.extra };
  }
  throw new Error('Expected the call to fail.');
}

let n = 0;
async function item(harnessFor: Harness = h, extra: Record<string, unknown> = {}) {
  n += 1;
  const created = await harnessFor.run(ops.createItem, {
    name: `Item ${n}`,
    sku: `PK-${n}-${uuidv7().slice(-6)}`,
    price: '2.50',
    acknowledgeSimilar: true,
    ...extra,
  });
  return created as { productId: string; variantId: string; sku: string };
}

const packaging = (variantId: string, harnessFor: Harness = h) =>
  harnessFor.run(ops.getPackaging, { variantId });

/** BigInt reference for a decimal string, scaled to 6 places. */
const micro = (d: string) => {
  const [w, f = ''] = d.split('.');
  return BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, '0'));
};

describe('A28 (definitions): packs nest and convert exactly to base units', () => {
  it('property: a chain of nested packs resolves to the exact product of its quantities', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.array(fc.integer({ min: 1, max: 60 }), { minLength: 0, maxLength: 4 }),
        fc.bigInt({ min: 1n, max: 999_999n }),
        (scale, outer, innerUnits) => {
          // The innermost pack holds innerUnits × 10^-scale base units: always on the scale.
          const inner = (Number(innerUnits) / 10 ** scale).toFixed(scale);
          const specs = [
            { key: 'p0', name: 'P0', quantity: inner, inner: null as string | null },
            ...outer.map((q, i) => ({
              key: `p${i + 1}`,
              name: `P${i + 1}`,
              quantity: String(q),
              inner: `p${i}`,
            })),
          ].reverse(); // Order in the list does not matter.
          const resolved = resolvePacks(specs, scale);
          if (outer.length >= 5) return !resolved.ok;
          if (!resolved.ok) return false;
          let expected = micro(inner);
          for (const [i, q] of outer.entries()) {
            expected *= BigInt(q);
            if (micro(resolved.base.get(`p${i + 1}`)!) !== expected) return false;
          }
          return micro(resolved.base.get('p0')!) === micro(inner);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('property: a pack that breaks the quantity scale is rejected', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 1, max: 99 }),
        (scale, lastDigit, whole) => {
          // One more decimal place than the scale allows, ending in a non-zero digit.
          const quantity = `${whole}.${'0'.repeat(scale)}${lastDigit}`;
          const resolved = resolvePacks(
            [
              { key: 'a', name: 'Bag', quantity, inner: null },
              { key: 'b', name: 'Case', quantity: '10', inner: 'a' },
            ],
            scale,
          );
          return !resolved.ok && resolved.code === 'pack_breaks_quantity_scale';
        },
      ),
      { numRuns: 200 },
    );
  });

  it('rejects cycles, fractions of an inner pack, and unknown inner packs', () => {
    const cycle = resolvePacks(
      [
        { key: 'a', name: 'A', quantity: '2', inner: 'b' },
        { key: 'b', name: 'B', quantity: '3', inner: 'a' },
      ],
      0,
    );
    expect(cycle.ok ? null : cycle.code).toBe('pack_cycle');
    const fraction = resolvePacks(
      [
        { key: 'a', name: 'Inner', quantity: '6', inner: null },
        { key: 'b', name: 'Case', quantity: '1.5', inner: 'a' },
      ],
      3,
    );
    expect(fraction.ok ? null : fraction.code).toBe('pack_inner_quantity_not_whole');
    const unknown = resolvePacks([{ key: 'a', name: 'A', quantity: '2', inner: 'zzz' }], 0);
    expect(unknown.ok ? null : unknown.code).toBe('pack_unknown_inner');
  });

  it('property through the operation: nested packs store exact base quantities', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: 1, max: 48 }),
        fc.integer({ min: 1, max: 40 }),
        async (scale, innerUnits, perCase, perPallet) => {
          const { variantId } = await item(h, { quantityScale: scale });
          const inner = (innerUnits / 10 ** scale).toFixed(scale);
          const res = await h.run(ops.setPacks, {
            variantId,
            packsVersion: 0,
            packs: [
              { name: 'Pallet', quantity: String(perPallet), innerPack: 'Case' },
              { name: 'Case', quantity: String(perCase), innerPack: 'Inner' },
              { name: 'Inner', quantity: inner },
            ],
          });
          const byName = new Map(
            res.packaging.packs.map((p: { name: string; baseQuantity: string }) => [
              p.name,
              p.baseQuantity,
            ]),
          );
          const expected = micro(inner) * BigInt(perCase);
          return (
            micro(byName.get('Inner') as string) === micro(inner) &&
            micro(byName.get('Case') as string) === expected &&
            micro(byName.get('Pallet') as string) === expected * BigInt(perPallet)
          );
        },
      ),
      { numRuns: 15 },
    );
  });

  it('refuses a pack that breaks the variant’s quantity scale', async () => {
    const { variantId } = await item(h, { quantityScale: 1 });
    const res = await rejects(
      h.run(ops.setPacks, {
        variantId,
        packsVersion: 0,
        packs: [{ name: 'Bag', quantity: '2.25' }],
      }),
    );
    expect(res).toMatchObject({ status: 422, code: 'pack_breaks_quantity_scale' });
    expect(res.extra).toMatchObject({ pack: 'Bag', quantityScale: 1 });
  });
});

describe('pack versions, archiving, and list versions', () => {
  it('records a version for every definition, including outer packs whose base changes', async () => {
    const { variantId } = await item();
    const first = await h.run(ops.setPacks, {
      variantId,
      packsVersion: 0,
      packs: [
        { name: 'Inner pack', quantity: '6' },
        { name: 'Case', quantity: '12', innerPack: 'Inner pack', uses: ['purchasing'] },
      ],
    });
    expect(first.packaging.packsVersion).toBe(1);
    const [inner, kase] = first.packaging.packs;
    expect(kase).toMatchObject({ baseQuantity: '72.000000', innerPackId: inner.id, version: 1 });

    // The inner pack grows to 8: the case now holds 96, and both get a new version.
    const second = await h.run(ops.setPacks, {
      variantId,
      packsVersion: 1,
      packs: [
        { id: inner.id, name: 'Inner pack', quantity: '8' },
        { id: kase.id, name: 'Case', quantity: '12', innerPack: inner.id, uses: ['purchasing'] },
      ],
    });
    const caseAfter = second.packaging.packs.find((p: { id: string }) => p.id === kase.id);
    expect(caseAfter).toMatchObject({ baseQuantity: '96.000000', version: 2 });
    const versions = await ownerQuery<{ version: number; base_quantity: string }>(
      'select version, base_quantity::text from pack_versions where pack_id = $1 order by version',
      [kase.id],
    );
    expect(versions).toEqual([
      { version: 1, base_quantity: '72.000000' },
      { version: 2, base_quantity: '96.000000' },
    ]);

    // A stale list version is refused.
    const stale = await rejects(h.run(ops.setPacks, { variantId, packsVersion: 1, packs: [] }));
    expect(stale).toMatchObject({ status: 409, code: 'version_conflict' });
    expect(stale.extra.currentVersion).toBe(2);

    // Leaving a pack out archives it and releases its barcodes.
    await h.run(ops.generateBarcode, { variantId, packId: kase.id });
    const third = await h.run(ops.setPacks, {
      variantId,
      packsVersion: 2,
      packs: [{ id: inner.id, name: 'Inner pack', quantity: '8' }],
    });
    expect(third.packaging.packs.map((p: { name: string }) => p.name)).toEqual(['Inner pack']);
    expect(third.packaging.barcodes).toEqual([]);
    const all = await h.run(ops.getPackaging, { variantId, includeArchived: true });
    expect(all.packs.find((p: { id: string }) => p.id === kase.id).status).toBe('archived');
  });

  it('a no-op set reports no change and keeps the version', async () => {
    const { variantId } = await item();
    const first = await h.run(ops.setPacks, {
      variantId,
      packsVersion: 0,
      packs: [{ name: 'Box', quantity: '10', weight: '1.2 kg', dimensions: '30 x 20 x 10 cm' }],
    });
    const box = first.packaging.packs[0];
    expect(box.weight).toMatchObject({ value: '1.2', unit: 'kg', canonical: '1200' });
    const again = await h.run(ops.setPacks, {
      variantId,
      packsVersion: 1,
      packs: [
        {
          id: box.id,
          name: 'Box',
          quantity: '10.0',
          weight: '1.2 kg',
          dimensions: '30 x 20 x 10 cm',
        },
      ],
    });
    expect(again.packaging.packsVersion).toBe(1);
  });

  it('stores shipping packages in order, separate from packs', async () => {
    const { variantId } = await item();
    const res = await h.run(ops.setShippingPackages, {
      variantId,
      shippingPackagesVersion: 0,
      shippingPackages: [
        { name: 'Frame', dimensions: '200 x 40 x 30 cm', weight: '25 kg' },
        { name: 'Cushions', dimensions: '100 x 60 x 50 cm', weight: '8 kg' },
      ],
    });
    expect(res.packaging.shippingPackages.map((p: { name: string }) => p.name)).toEqual([
      'Frame',
      'Cushions',
    ]);
    expect(res.packaging.packs).toEqual([]);
    const invalid = await rejects(
      h.run(ops.setShippingPackages, {
        variantId,
        shippingPackagesVersion: 1,
        shippingPackages: [{ dimensions: '10 x 10 cm', weight: '1 kg' }],
      }),
    );
    expect(invalid.code).toBe('validation_failed');
  });
});

describe('F7: barcodes are valid and unique per shop across variants and packs', () => {
  it('validates EAN-13, EAN-8, and UPC-A check digits', () => {
    expect(gtinCheckDigit('400638133393')).toBe(1);
    expect(isValidGtin('4006381333931')).toBe(true);
    expect(checkBarcode('4006381333931', 'ean13')).toMatchObject({ ok: true });
    expect(checkBarcode('4 006381 333931', 'ean13')).toMatchObject({
      ok: true,
      code: '4006381333931',
    });
    expect(checkBarcode('4006381333932', 'ean13')).toEqual({
      ok: false,
      message: 'The check digit should be 1. Check the number.',
    });
    expect(checkBarcode('96385074', 'ean8')).toMatchObject({ ok: true });
    expect(checkBarcode('96385075', 'ean8').ok).toBe(false);
    expect(checkBarcode('036000291452', 'upca')).toMatchObject({ ok: true });
    expect(checkBarcode('036000291453', 'upca').ok).toBe(false);
    expect(checkBarcode('03600029145', 'upca')).toEqual({
      ok: false,
      message: 'An UPC-A has 12 digits.',
    });
    expect(checkBarcode('ÄÖ', 'code128').ok).toBe(false);
    // UPC-A and the same GTIN as EAN-13 are one code; other codes ignore case.
    expect(normalizeBarcode('036000291452')).toBe(normalizeBarcode('0036000291452'));
    expect(normalizeBarcode(' as-12 ')).toBe('AS-12');
  });

  it('property: every valid GTIN round-trips and every wrong check digit is refused', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(['ean13', 12], ['ean8', 7], ['upca', 11]),
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 12 }),
        fc.integer({ min: 1, max: 9 }),
        ([symbology, length], digits, offset) => {
          const body = digits.slice(0, length as number).join('');
          const check = gtinCheckDigit(body);
          const good = checkBarcode(`${body}${check}`, symbology as 'ean13');
          const bad = checkBarcode(`${body}${(check + offset) % 10}`, symbology as 'ean13');
          return good.ok && good.normalized.length === 14 && !bad.ok;
        },
      ),
    );
  });

  it('rejects a duplicate across variants and packs, with the record that holds it', async () => {
    const a = await item();
    const b = await item();
    const packs = await h.run(ops.setPacks, {
      variantId: b.variantId,
      packsVersion: 0,
      packs: [{ name: 'Case', quantity: '12' }],
    });
    const caseId = packs.packaging.packs[0].id;
    const set = await h.run(ops.setBarcodes, {
      variantId: a.variantId,
      barcodesVersion: 0,
      barcodes: [{ code: '036000291452', symbology: 'upca' }],
    });
    expect(set.packaging.barcodes[0]).toMatchObject({ code: '036000291452', source: 'entered' });

    // The same GTIN typed as EAN-13 on another variant's pack.
    const dup = await rejects(
      h.run(ops.setBarcodes, {
        variantId: b.variantId,
        barcodesVersion: 0,
        barcodes: [{ code: '0036000291452', symbology: 'ean13', packId: caseId }],
      }),
    );
    expect(dup).toMatchObject({ status: 409, code: 'duplicate_barcode' });
    expect(dup.extra.existing).toMatchObject({ variantId: a.variantId, sku: a.sku, packId: null });

    // A pack barcode, then the variant tries to take it.
    await h.run(ops.setBarcodes, {
      variantId: b.variantId,
      barcodesVersion: 0,
      barcodes: [{ code: '4006381333931', symbology: 'ean13', packId: caseId }],
    });
    const fromPack = await rejects(
      h.run(ops.setBarcodes, {
        variantId: a.variantId,
        barcodesVersion: 1,
        barcodes: [
          { code: '036000291452', symbology: 'upca' },
          { code: '4006381333931', symbology: 'ean13' },
        ],
      }),
    );
    expect(fromPack.code).toBe('duplicate_barcode');
    expect(fromPack.extra.existing).toMatchObject({ variantId: b.variantId, packId: caseId });

    // The exported helper the duplicate check on every create path uses.
    const owner = await db.transaction(
      { shopId: shop.shopId, userId: shop.userId, readOnly: true },
      (tx) => findBarcodeOwner(tx, normalizeBarcode('04006381333931')),
    );
    expect(owner).toMatchObject({
      variantId: b.variantId,
      packId: caseId,
      baseQuantity: '12.000000',
    });

    // Lookup resolves a scanned pack code to the variant and pack.
    const lookup = await h.run(ops.lookupBarcode, { code: '4006381333931' });
    expect(lookup.match).toMatchObject({ variantId: b.variantId, packName: 'Case' });

    // The database enforces uniqueness too, should two writes race.
    const raw = await ownerQuery<{ n: number }>(
      'select count(*)::int as n from barcodes where shop_id = $1 and code_normalized = $2',
      [shop.shopId, normalizeBarcode('036000291452')],
    );
    expect(raw[0]!.n).toBe(1);
  });

  it('moves a code between a variant and its own pack', async () => {
    const { variantId } = await item();
    const packs = await h.run(ops.setPacks, {
      variantId,
      packsVersion: 0,
      packs: [{ name: 'Six', quantity: '6', uses: ['sales'] }],
    });
    const six = packs.packaging.packs[0].id;
    await h.run(ops.setBarcodes, {
      variantId,
      barcodesVersion: 0,
      barcodes: [{ code: '96385074', symbology: 'ean8' }],
    });
    const moved = await h.run(ops.setBarcodes, {
      variantId,
      barcodesVersion: 1,
      barcodes: [{ code: '96385074', symbology: 'ean8', packId: six }],
    });
    expect(moved.packaging.barcodes).toEqual([
      expect.objectContaining({ code: '96385074', packId: six }),
    ]);
  });

  it('generates internal codes from a shop-wide sequence, skipping codes already in use', async () => {
    const a = await item();
    const b = await item();
    const first = await h.run(ops.generateBarcode, { variantId: a.variantId });
    const second = await h.run(ops.generateBarcode, { variantId: b.variantId, symbology: 'qr' });
    expect(first.barcode.code).toMatch(/^AS\d{8}$/);
    expect(first.barcode).toMatchObject({ symbology: 'code128', source: 'generated' });
    expect(second.barcode.symbology).toBe('qr');
    const seq = (code: string) => Number(code.slice(2));
    expect(seq(second.barcode.code)).toBe(seq(first.barcode.code) + 1);
    // Someone typed the next code in by hand: generation skips it.
    const next = `AS${String(seq(second.barcode.code) + 1).padStart(8, '0')}`;
    await h.run(ops.setBarcodes, {
      variantId: b.variantId,
      barcodesVersion: second.packaging.barcodesVersion,
      barcodes: [...second.packaging.barcodes, { code: next.toLowerCase(), symbology: 'other' }],
    });
    const third = await h.run(ops.generateBarcode, { variantId: a.variantId });
    expect(seq(third.barcode.code)).toBe(seq(next) + 1);
    // Another shop has its own sequence and may hold the same internal code.
    const foreign = await item(ho);
    const theirs = await ho.run(ops.generateBarcode, { variantId: foreign.variantId });
    expect(theirs.barcode.code).toBe('AS00000001');
  });

  it('refuses invalid codes and packs of another variant', async () => {
    const a = await item();
    const b = await item();
    const packs = await h.run(ops.setPacks, {
      variantId: b.variantId,
      packsVersion: 0,
      packs: [{ name: 'Case', quantity: '4' }],
    });
    const bad = await rejects(
      h.run(ops.setBarcodes, {
        variantId: a.variantId,
        barcodesVersion: 0,
        barcodes: [
          { code: '4006381333932', symbology: 'ean13' },
          { code: 'X-1', symbology: 'code128', packId: packs.packaging.packs[0].id },
        ],
      }),
    );
    expect(bad.code).toBe('validation_failed');
    expect((bad.extra.errors as Array<{ path: string }>).map((e) => e.path)).toEqual([
      'barcodes.0.code',
      'barcodes.1.packId',
    ]);
  });
});

describe('bundles: versioned definitions and availability under location scope', () => {
  let candle: { variantId: string; sku: string };
  let soap: { variantId: string; sku: string };
  let gift: { variantId: string; sku: string };
  let soapPack: string;
  let shelfA: string;
  let shelfB: string;

  beforeAll(async () => {
    candle = await item();
    soap = await item();
    gift = await item();
    const packs = await h.run(ops.setPacks, {
      variantId: soap.variantId,
      packsVersion: 0,
      packs: [{ name: 'Pair', quantity: '2', uses: ['sales'] }],
    });
    soapPack = packs.packaging.packs[0].id;
    shelfA = await createLeafLocation(h, shop.warehouseId, `Shelf A ${uuidv7().slice(-4)}`);
    shelfB = await createLeafLocation(h, shop.warehouseId, `Shelf B ${uuidv7().slice(-4)}`);
    const receive = (variantId: string, locationId: string, quantity: string) =>
      h.run(ops.receiveStock, { variantId, locationId, quantity });
    await receive(candle.variantId, shelfA, '7');
    await receive(candle.variantId, shelfB, '3');
    await receive(soap.variantId, shelfA, '9');
    await receive(soap.variantId, shelfB, '20');
  });

  it('defines a bundle by SKU and pack, versioned', async () => {
    const res = await h.run(ops.setBundle, {
      variantId: gift.variantId,
      bundleVersion: 0,
      components: [
        { sku: candle.sku.toLowerCase(), quantity: '1' },
        { variantId: soap.variantId, packId: soapPack, quantity: '1' },
      ],
    });
    expect(res.packaging.bundleVersion).toBe(1);
    expect(res.packaging.bundle.components).toMatchObject([
      { variantId: candle.variantId, baseQuantity: '1.000000' },
      { variantId: soap.variantId, packName: 'Pair', baseQuantity: '2.000000' },
    ]);
    const soapView = await packaging(soap.variantId);
    expect(soapView.componentOf).toEqual([expect.objectContaining({ variantId: gift.variantId })]);
  });

  it('computes floor(available ÷ per bundle) over components, per scope', async () => {
    const all = await h.run(ops.getBundleAvailability, { variantId: gift.variantId });
    // Candles: 10 → 10 bundles; soap: 29 ÷ 2 → 14. The candle limits it.
    expect(all).toMatchObject({ available: '10', limitedBy: candle.variantId, partial: false });
    const atA = await h.run(ops.getBundleAvailability, {
      variantId: gift.variantId,
      locationId: shelfA,
    });
    // Shelf A: candles 7, soap 9 ÷ 2 = 4.
    expect(atA).toMatchObject({ available: '4', limitedBy: soap.variantId });
    const byWarehouse = await h.run(ops.getBundleAvailability, {
      variantId: gift.variantId,
      warehouseId: shop.warehouseId,
    });
    expect(byWarehouse.available).toBe('10');

    // A reservation of candles lowers what the bundle can sell.
    await h.run(ops.reserveStock, {
      variantId: candle.variantId,
      quantity: '6',
      locationId: shelfA,
    });
    const after = await h.run(ops.getBundleAvailability, { variantId: gift.variantId });
    expect(after.available).toBe('4');

    // A member limited to shelf B sees only shelf B, labelled partial.
    const scoped = await addMember(shop.shopId, 'viewer', [shelfB]);
    const theirs = await h.run(
      ops.getBundleAvailability,
      { variantId: gift.variantId },
      { caller: scoped.caller },
    );
    // Shelf B: candles 3, soap 20 ÷ 2 = 10.
    expect(theirs).toMatchObject({ available: '3', partial: true });
    const denied = await rejects(
      h.run(
        ops.getBundleAvailability,
        { variantId: gift.variantId, locationId: shelfA },
        { caller: scoped.caller },
      ),
    );
    expect(denied).toMatchObject({ status: 403, code: 'location_out_of_scope' });
  });

  it('keeps bundles flat and stock-free', async () => {
    const nested = await rejects(
      h.run(ops.setBundle, {
        variantId: candle.variantId,
        bundleVersion: 0,
        components: [{ variantId: gift.variantId, quantity: '1' }],
      }),
    );
    expect(nested.code).toBe('validation_failed');
    const self = await rejects(
      h.run(ops.setBundle, {
        variantId: gift.variantId,
        bundleVersion: 1,
        components: [{ variantId: gift.variantId, quantity: '1' }],
      }),
    );
    expect(self.code).toBe('validation_failed');
    // The candle has stock, so it cannot become a bundle; and it is a component already.
    const plain = await item();
    const stocked = await rejects(
      h.run(ops.setBundle, {
        variantId: candle.variantId,
        bundleVersion: 0,
        components: [{ variantId: plain.variantId, quantity: '1' }],
      }),
    );
    expect(stocked.code).toBe('bundle_is_component');
    // A bundle holds no stock of its own.
    const receipt = await rejects(
      h.run(ops.receiveStock, { variantId: gift.variantId, locationId: shelfA, quantity: '1' }),
    );
    expect(receipt).toMatchObject({ status: 422, code: 'bundle_holds_no_stock' });
    // A pack in use by a bundle cannot be resized or archived.
    const soapView = await packaging(soap.variantId);
    const resized = await rejects(
      h.run(ops.setPacks, {
        variantId: soap.variantId,
        packsVersion: soapView.packsVersion,
        packs: [{ id: soapPack, name: 'Pair', quantity: '3' }],
      }),
    );
    expect(resized.code).toBe('pack_in_bundle');
  });

  it('a new version changes components; an empty list ends the bundle', async () => {
    const changed = await h.run(ops.setBundle, {
      variantId: gift.variantId,
      bundleVersion: 1,
      components: [{ variantId: candle.variantId, quantity: '2' }],
    });
    expect(changed.packaging.bundleVersion).toBe(2);
    const versions = await ownerQuery<{ version: number; n: number }>(
      `select bv.version, count(c.id)::int as n from bundle_versions bv
       join bundles b on b.shop_id = bv.shop_id and b.id = bv.bundle_id
       left join bundle_components c on c.shop_id = bv.shop_id and c.bundle_version_id = bv.id
       where b.variant_id = $1 group by bv.version order by bv.version`,
      [gift.variantId],
    );
    expect(versions).toEqual([
      { version: 1, n: 2 },
      { version: 2, n: 1 },
    ]);
    const ended = await h.run(ops.setBundle, {
      variantId: gift.variantId,
      bundleVersion: 2,
      components: [],
    });
    expect(ended.packaging.bundle).toMatchObject({ active: false, version: 3 });
    const notBundle = await rejects(
      h.run(ops.getBundleAvailability, { variantId: gift.variantId }),
    );
    expect(notBundle.code).toBe('not_a_bundle');
  });
});

describe('suppliers: costs are visible only with costs.read', () => {
  it('hides and protects costs for members without costs.read, in results and history', async () => {
    const { variantId } = await item();
    const created = await h.run(ops.createSupplier, {
      name: `Acme ${uuidv7().slice(-6)}`,
      email: 'orders@acme.example',
      leadTimeDays: 14,
    });
    const supplierId = created.supplier.id;
    expect(created.supplier.currency).toBe('EUR');
    const saved = await h.run(ops.saveSupplierItem, {
      supplierId,
      variantId,
      supplierSku: 'ac-100',
      lastCost: '1.25',
      minimumOrderQuantity: '24',
      preferred: true,
    });
    expect(saved.item).toMatchObject({ lastCost: '1.250000', costVisible: true, preferred: true });

    const editor = await addMember(shop.shopId, 'catalog_editor');
    const asEditor = await h.run(ops.listSupplierItems, { variantId }, { caller: editor.caller });
    expect(asEditor.costVisible).toBe(false);
    expect(asEditor.items[0]).toMatchObject({
      supplierSku: 'ac-100',
      lastCost: null,
      lastCostAt: null,
      costVisible: false,
    });
    const detail = await h.run(ops.getSupplier, { supplierId }, { caller: editor.caller });
    expect(detail.items[0].lastCost).toBeNull();
    const cannotSet = await rejects(
      h.run(
        ops.saveSupplierItem,
        { itemId: saved.item.id, expectedVersion: saved.item.version, lastCost: '0.99' },
        { caller: editor.caller },
      ),
    );
    expect(cannotSet.status).toBe(403);
    // Editors still change what they can see.
    const moq = await h.run(
      ops.saveSupplierItem,
      { itemId: saved.item.id, expectedVersion: saved.item.version, minimumOrderQuantity: '48' },
      { caller: editor.caller },
    );
    expect(moq.item).toMatchObject({ minimumOrderQuantity: '48.000000', lastCost: null });
    const asOwner = await h.run(ops.listSupplierItems, { supplierId });
    expect(asOwner.items[0].lastCost).toBe('1.250000');

    // The activity history hides the cost change from members without costs.read. (Command
    // outcomes are written in their transaction, so no queue delivery is needed here.)
    const viewer = await addMember(shop.shopId, 'viewer');
    const history = (caller?: typeof viewer.caller) =>
      h.run(
        ops.listActivity,
        { targetType: 'supplier_item', targetId: saved.item.id },
        caller ? { caller } : {},
      );
    const ownerEvents = await history();
    const created_ = ownerEvents.events.find(
      (e: { action: string; phase: string; changes: { created?: boolean } }) =>
        e.action === 'supplier_item.saved' && e.phase === 'outcome' && e.changes?.created,
    );
    expect(created_.changes.restricted.fields.lastCost).toEqual({ from: null, to: '1.25' });
    const viewerEvents = await history(viewer.caller);
    const hidden = viewerEvents.events.find(
      (e: { action: string; phase: string; changes: { created?: boolean } }) =>
        e.action === 'supplier_item.saved' && e.phase === 'outcome' && e.changes?.created,
    );
    expect(hidden.changes.restricted).toEqual({ permission: 'costs.read', hidden: true });
    expect(JSON.stringify(viewerEvents)).not.toContain('"1.25');
  });

  it('keeps one preferred item per variant and unique supplier SKUs', async () => {
    const { variantId } = await item();
    const s1 = (await h.run(ops.createSupplier, { name: `North ${uuidv7().slice(-6)}` })).supplier;
    const s2 = (await h.run(ops.createSupplier, { name: `South ${uuidv7().slice(-6)}` })).supplier;
    const a = await h.run(ops.saveSupplierItem, {
      supplierId: s1.id,
      variantId,
      preferred: true,
      supplierSku: 'N-1',
    });
    const b = await h.run(ops.saveSupplierItem, { supplierId: s2.id, variantId, preferred: true });
    const list = await h.run(ops.listSupplierItems, { variantId });
    const preferred = list.items.filter((i: { preferred: boolean }) => i.preferred);
    expect(preferred.map((i: { id: string }) => i.id)).toEqual([b.item.id]);
    const other = await item();
    const dupSku = await rejects(
      h.run(ops.saveSupplierItem, {
        supplierId: s1.id,
        variantId: other.variantId,
        supplierSku: 'n-1',
      }),
    );
    expect(dupSku.code).toBe('duplicate_supplier_sku');
    const dupItem = await rejects(h.run(ops.saveSupplierItem, { supplierId: s1.id, variantId }));
    expect(dupItem).toMatchObject({
      code: 'supplier_item_exists',
      extra: { existingItemId: a.item.id },
    });
    // Giving way to b changed a, so its version moved on.
    const current = list.items.find((i: { id: string }) => i.id === a.item.id);
    expect(current.version).toBe(a.item.version + 1);
    const removed = await h.run(ops.removeSupplierItem, {
      itemId: a.item.id,
      expectedVersion: current.version,
    });
    expect(removed.item.status).toBe('archived');
    const archived = await h.run(ops.updateSupplier, {
      supplierId: s1.id,
      expectedVersion: s1.version,
      status: 'archived',
    });
    expect(archived.supplier.status).toBe('archived');
    const stale = await rejects(
      h.run(ops.updateSupplier, { supplierId: s1.id, expectedVersion: s1.version, notes: 'x' }),
    );
    expect(stale.code).toBe('version_conflict');
    const otherCurrency = await rejects(
      h.run(ops.createSupplier, { name: 'Dollar', currency: 'USD' }),
    );
    expect(otherCurrency.code).toBe('currency_not_supported');
  });
});

describe('labels: fields resolved and logged on the server', () => {
  it('resolves item and pack labels without falling back to the variant’s barcode', async () => {
    const { variantId, sku } = await item(h, { price: '1.50' });
    const packs = await h.run(ops.setPacks, {
      variantId,
      packsVersion: 0,
      packs: [
        { name: 'Six', quantity: '6', uses: ['sales'] },
        { name: 'Crate', quantity: '4', innerPack: 'Six', price: '30' },
      ],
    });
    const [six, crate] = packs.packaging.packs;
    await h.run(ops.setBarcodes, {
      variantId,
      barcodesVersion: 0,
      barcodes: [{ code: '5901234123457', symbology: 'ean13' }],
    });
    const res = await h.run(ops.renderItemLabels, {
      template: 'items_a4_3x8',
      items: [
        { variantId, copies: 2 },
        { variantId, packId: six.id },
        { variantId, packId: crate.id },
      ],
    });
    expect(res.template).toMatchObject({ layout: 'a4_3x8' });
    expect(res.total).toBe(4);
    expect(res.labels).toMatchObject([
      {
        kind: 'variant',
        sku,
        price: '1.5',
        barcode: { symbology: 'ean13', code: '5901234123457' },
      },
      { kind: 'pack', price: '9', pack: 'Six · 6 each', barcode: null },
      { kind: 'pack', price: '30', pack: 'Crate · 24 each', barcode: null },
    ]);
    expect(res.missingBarcodes).toBe(2);
    // The request is logged as a read with what was printed.
    const event = sink.events.findLast((e) => e.action === 'labels.items.rendered');
    expect(event).toMatchObject({ outcome: 'succeeded', target_type: 'label' });
    expect((event!.context as { total: number }).total).toBe(4);
  });

  it('encodes a location’s ID in its label and respects location scope', async () => {
    const shelf = await createLeafLocation(h, shop.warehouseId, `Bin ${uuidv7().slice(-4)}`);
    const res = await h.run(ops.renderLocationLabels, { locations: [{ locationId: shelf }] });
    expect(res.labels[0].path).toContain('Bin');
    expect(parseLocationCode(res.labels[0].barcode.code)).toBe(shelf);
    const scoped = await addMember(shop.shopId, 'viewer', [uuidv7()]);
    const denied = await rejects(
      h.run(
        ops.renderLocationLabels,
        { locations: [{ locationId: shelf }] },
        { caller: scoped.caller },
      ),
    );
    expect(denied.code).toBe('location_out_of_scope');
  });

  it('saves templates with fields checked against the label kind', async () => {
    const saved = await h.run(ops.saveLabelTemplate, {
      name: 'Shelf strips',
      kind: 'item',
      layout: 'a4_4x10',
      fields: ['sku', 'barcode'],
    });
    const list = await h.run(ops.listLabelTemplates, {});
    expect(list.templates.map((t: { name: string }) => t.name)).toContain('Shelf strips');
    const res = await h.run(ops.renderItemLabels, {
      templateId: saved.template.id,
      items: [{ variantId: (await item()).variantId }],
    });
    expect(res.template).toEqual({
      name: 'Shelf strips',
      layout: 'a4_4x10',
      fields: ['sku', 'barcode'],
    });
    const wrong = await rejects(
      h.run(ops.saveLabelTemplate, {
        name: 'Bad',
        kind: 'location',
        layout: 'a4_3x8',
        fields: ['price'],
      }),
    );
    expect(wrong.code).toBe('validation_failed');
  });
});

describe('A13 (SQL layer): another shop’s IDs are refused', () => {
  it('does not reach another shop’s variants, packs, barcodes, bundles, or suppliers', async () => {
    const mine = await item();
    const theirs = await item(ho);
    const theirPacks = await ho.run(ops.setPacks, {
      variantId: theirs.variantId,
      packsVersion: 0,
      packs: [{ name: 'Case', quantity: '12' }],
    });
    await ho.run(ops.setBarcodes, {
      variantId: theirs.variantId,
      barcodesVersion: 0,
      barcodes: [{ code: '4012345678901', symbology: 'ean13' }],
    });
    const theirSupplier = (await ho.run(ops.createSupplier, { name: 'Their supplier' })).supplier;

    expect((await rejects(packaging(theirs.variantId))).status).toBe(404);
    expect(
      (
        await rejects(
          h.run(ops.setPacks, { variantId: theirs.variantId, packsVersion: 0, packs: [] }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await rejects(
          h.run(ops.generateBarcode, {
            variantId: mine.variantId,
            packId: theirPacks.packaging.packs[0].id,
          }),
        )
      ).status,
    ).toBe(404);
    // Their barcode is not visible here, so this shop may use the same code.
    expect((await h.run(ops.lookupBarcode, { code: '4012345678901' })).match).toBeNull();
    await h.run(ops.setBarcodes, {
      variantId: mine.variantId,
      barcodesVersion: 0,
      barcodes: [{ code: '4012345678901', symbology: 'ean13' }],
    });
    expect(
      (
        await rejects(
          h.run(ops.setBundle, {
            variantId: mine.variantId,
            bundleVersion: 0,
            components: [{ variantId: theirs.variantId, quantity: '1' }],
          }),
        )
      ).status,
    ).toBe(404);
    expect((await rejects(h.run(ops.getSupplier, { supplierId: theirSupplier.id }))).status).toBe(
      404,
    );
    expect(
      (
        await rejects(
          h.run(ops.saveSupplierItem, { supplierId: theirSupplier.id, variantId: mine.variantId }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await rejects(h.run(ops.renderItemLabels, { items: [{ variantId: theirs.variantId }] })))
        .status,
    ).toBe(404);

    // Composite foreign keys refuse a cross-shop pack even for code that bypassed the checks.
    await expect(
      ownerQuery(
        `insert into barcodes (shop_id, id, variant_id, pack_id, symbology, code, code_normalized)
         values ($1, $2, $3, $4, 'other', 'X', 'X')`,
        [shop.shopId, uuidv7(), mine.variantId, theirPacks.packaging.packs[0].id],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});
