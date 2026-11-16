import { execute, type FileAccess, ops, runExportJob, runImportJob, uuidv7 } from '@airstock/core';
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
import { gtinCheckDigit } from '../src/catalog/barcodes.ts';
import { suggestMapping } from '../src/catalog/imports.ts';
import { parseCsv } from '../src/csv.ts';

// N7: CSV import (preview, chunked commit, resume, opening stock) and export (F10, A19).

const db = appDatabase();
const sink = new MemoryAuditSink();
const stored = new Map<string, string>();
const files: FileAccess = {
  get: async (k) => stored.get(k) ?? null,
  put: async (k, body) => {
    stored.set(k, body);
  },
  delete: async (k) => {
    stored.delete(k);
  },
};
let shop: SeededShop;
let h: Harness;
let backRoom: string;

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Import shop');
  h = harness(db, sink, shop);
  await h.run(ops.addTemplate, { template: 'food' });
  backRoom = await createLeafLocation(h, shop.warehouseId, 'Back room');
});
afterAll(() => db.close());

const run = (
  op: Parameters<typeof execute>[1],
  input: unknown,
  key: string | null = uuidv7(),
  caller = shop.caller,
) =>
  execute({ db, audit: sink, files }, op, {
    caller,
    shopId: shop.shopId,
    input,
    idempotencyKey: key,
  }).then((r) => r.result as never);

/** Creates an import with `csv` as its file and previews it with the suggested or given mapping. */
async function upload(csv: string, mapping?: Record<string, string>, caller = shop.caller) {
  const created = (await run(ops.createImport, { fileName: 'catalog.csv' }, uuidv7(), caller)) as {
    importId: string;
  };
  stored.set(`shops/${shop.shopId}/imports/${created.importId}/source.csv`, csv);
  await run(
    ops.recordImportUpload,
    { importId: created.importId, sizeBytes: csv.length },
    null,
    caller,
  );
  const first = (await run(
    ops.previewImport,
    { importId: created.importId },
    uuidv7(),
    caller,
  )) as {
    suggestedMapping: Record<string, string>;
  };
  const preview = (await run(
    ops.previewImport,
    { importId: created.importId, mapping: mapping ?? first.suggestedMapping },
    uuidv7(),
    caller,
  )) as {
    import: { counts: Record<string, number>; status: string };
    problems: Array<{ rowNumber: number; errors: string[]; warnings: string[] }>;
  };
  return { importId: created.importId, suggested: first.suggestedMapping, preview };
}

const deps = (extra: Partial<Parameters<typeof runImportJob>[0]> = {}) => ({
  db,
  audit: sink,
  files,
  ...extra,
});

describe('CSV import (plan 5.12)', () => {
  it('previews creates, updates, errors, and duplicates, then commits with opening stock', async () => {
    await h.run(ops.createItem, {
      name: 'Existing honey',
      sku: 'HON-1',
      price: '9',
      family: 'Food',
      fields: { net_weight: '250 g', storage: 'Ambient' },
    });
    const csv = [
      `product;name;sku;price;option:Size;net_weight;storage;allergens;stock:${shop.locationId};stock:${backRoom}`,
      `JAM;Strawberry jam;JAM-S;4.50;Small;200 g;Ambient;;5;0`,
      `JAM;Strawberry jam;JAM-L;"7,10";Large;450 g;Ambient;;3;2`,
      `;Existing honey;HON-1;10.50;;;;Nuts;;`,
      `;Cheese;CH-1;12;;300 g;Chilled;Milk;1;`,
      `;Bad price;BAD-1;-3;;100 g;Ambient;;;`,
      `;Repeat;CH-1;12;;300 g;Chilled;;;`,
      `;Existing Honey jar;HJ-1;8;;250 g;Frozen;;;`,
    ].join('\n');
    const { suggested, preview } = await upload(csv);
    expect(suggested).toMatchObject({
      product: 'product',
      sku: 'sku',
      'option:Size': 'option:Size',
      net_weight: 'field:net_weight',
      [`stock:${backRoom}`]: `stock:${backRoom}`,
    });
    expect(preview.import.counts).toMatchObject({
      rows: 7,
      creates: 3,
      updates: 1,
      errors: 3,
      newProducts: 3,
    });
    const problems = Object.fromEntries(preview.problems.map((p) => [p.rowNumber, p]));
    expect(problems[3]!.errors[0]).toContain('price');
    expect(problems[6]!.errors[0]).toContain('Use a price');
    expect(problems[7]!.errors[0]).toContain('repeats row 5');
    expect(problems[8]!.warnings[0]).toContain('Existing honey');
    // Nothing was written by the preview.
    expect(
      (
        await ownerQuery('select 1 from variants where shop_id = $1 and sku = $2', [
          shop.shopId,
          'JAM-S',
        ])
      ).length,
    ).toBe(0);

    // Fix the price format and preview again; commit.
    const fixed = await upload(csv.replace('"7,10"', '7.10'));
    expect(fixed.preview.import.counts).toMatchObject({ creates: 4, updates: 1, errors: 2 });
    await run(ops.commitImport, { importId: fixed.importId });
    expect(await runImportJob(deps(), shop.shopId, fixed.importId)).toBe('done');
    const job = (await run(ops.getImport, { importId: fixed.importId }, null)) as {
      import: { status: string; counts: Record<string, number> };
    };
    expect(job.import).toMatchObject({
      status: 'completed',
      counts: { done: 5, skipped: 2, failed: 0 },
    });

    const jam = (await h.run(ops.getItem, { sku: 'JAM-L' })).item;
    expect(jam.product.name).toBe('Strawberry jam');
    expect(jam.options.map((o: { name: string }) => o.name)).toEqual(['Size']);
    expect(
      jam.variants.map((v: { sku: string; title: string }) => `${v.sku} ${v.title}`).sort(),
    ).toEqual(['JAM-L Large', 'JAM-S Small']);
    expect(
      jam.variants.find((v: { sku: string }) => v.sku === 'JAM-L').fields.net_weight.value,
    ).toMatchObject({ value: '450', unit: 'g' });
    // The update kept the product and changed only the mapped, non-empty values.
    const honey = (await h.run(ops.getItem, { sku: 'HON-1' })).item;
    expect(honey.variants[0].price).toBe('10.500000');
    expect(honey.product.fields.allergens.display).toBe('Nuts');
    expect(honey.variants[0].fields.net_weight.value).toMatchObject({ value: '250' });
    // Opening stock went through receipts with the reason recorded.
    const stock = await h.run(ops.getAvailability, {
      variantId: jam.variants.find((v: { sku: string }) => v.sku === 'JAM-L').id,
    });
    expect(Number(stock.totals.onHand)).toBe(5);
    const receipts = await ownerQuery<{ reason: string; n: number }>(
      `select reason, count(*)::int as n from inventory_operations where shop_id = $1 and kind = 'receipt' group by reason`,
      [shop.shopId],
    );
    expect(receipts).toEqual([{ reason: 'opening stock', n: 4 }]);
    // One availability event for the chunk, naming every position it stocked, so a large import
    // does not flood the outbox ahead of other shops' events.
    const announced = await ownerQuery<{ positions: number }>(
      `select jsonb_array_length(payload->'positionIds') as positions from outbox_events
       where shop_id = $1 and topic = 'inventory.availability_changed'`,
      [shop.shopId],
    );
    expect(announced).toEqual([{ positions: 4 }]);
    // Every created record has its own event, linked to the import.
    const events = await ownerQuery<{ action: string; n: number }>(
      `select action, count(*)::int as n from audit_events where shop_id = $1 and changes->>'importId' = $2 group by action order by action`,
      [shop.shopId, fixed.importId],
    );
    expect(events).toEqual([
      { action: 'catalog.product.imported', n: 3 },
      { action: 'catalog.variant.changed', n: 1 },
      { action: 'catalog.variant.imported', n: 4 },
      { action: 'inventory.receipt.created', n: 4 },
    ]);
    const rows = (await run(
      ops.listImportRows,
      { importId: fixed.importId, only: 'problems' },
      null,
    )) as { rows: Array<{ rowNumber: number }> };
    expect(rows.rows.map((r) => r.rowNumber)).toEqual([6, 7, 8]);
  });

  it('A19: an import interrupted after a chunk resumes without duplicating records or receipts', async () => {
    const lines = ['name;sku;price;stock'];
    for (let i = 0; i < 450; i++)
      lines.push(`Resume item ${i};RES-${String(i).padStart(4, '0')};${i % 50}.25;${i % 3}`);
    const { importId } = await upload(lines.join('\n'), {
      name: 'name',
      sku: 'sku',
      price: 'price',
      stock: `stock:${shop.locationId}`,
    });
    await run(ops.commitImport, { importId });
    // The worker dies right after the first chunk commits.
    await expect(
      runImportJob(
        deps({
          afterChunk: (n) => {
            if (n === 1) throw new Error('worker restarted');
          },
        }),
        shop.shopId,
        importId,
      ),
    ).rejects.toThrow('worker restarted');
    const [mid] = await ownerQuery<{ checkpoint: number; status: string }>(
      'select checkpoint, status from import_jobs where id = $1',
      [importId],
    );
    expect(mid).toMatchObject({ status: 'committing', checkpoint: 201 });
    // A second run, as the sweep or the queue would start it, finishes the rest.
    expect(await runImportJob(deps(), shop.shopId, importId)).toBe('done');
    const [variants] = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from variants where shop_id = $1 and sku like 'RES-%'`,
      [shop.shopId],
    );
    expect(variants!.n).toBe(450);
    const [entries] = await ownerQuery<{ n: number; total: string }>(
      `select count(*)::int as n, sum(e.delta)::text as total from inventory_entries e join variants v on v.id = e.variant_id
       where e.shop_id = $1 and v.sku like 'RES-%'`,
      [shop.shopId],
    );
    expect(entries!.n).toBe(300);
    expect(Number(entries!.total)).toBe(450);
    // Running again changes nothing.
    await ownerQuery(`update import_jobs set status = 'committing' where id = $1`, [importId]);
    await runImportJob(deps(), shop.shopId, importId);
    const [again] = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from inventory_entries where shop_id = $1`,
      [shop.shopId],
    );
    const [before] = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from inventory_entries e join variants v on v.id = e.variant_id where e.shop_id = $1`,
      [shop.shopId],
    );
    expect(again!.n).toBe(before!.n);
  });

  it('refuses a commit without a preview, a malformed file, and another shop’s import', async () => {
    const created = (await run(ops.createImport, { fileName: 'x.csv' })) as { importId: string };
    await expect(run(ops.commitImport, { importId: created.importId })).rejects.toMatchObject({
      code: 'import_not_previewed',
    });
    stored.set(
      `shops/${shop.shopId}/imports/${created.importId}/source.csv`,
      'name,sku\n"broken,X',
    );
    await run(ops.recordImportUpload, { importId: created.importId, sizeBytes: 10 }, null);
    await expect(run(ops.previewImport, { importId: created.importId })).rejects.toMatchObject({
      code: 'csv_invalid',
    });
    const other = await seedShop(db, sink, 'Other import shop');
    await expect(
      execute({ db, audit: sink, files }, ops.getImport, {
        caller: other.caller,
        shopId: other.shopId,
        input: { importId: created.importId },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('barcodes in CSV (ADR 0019)', () => {
  it('imports a barcode column, refuses codes held elsewhere, and exports it back', async () => {
    const tag = uuidv7().slice(-6).toUpperCase();
    const held = (await run(ops.createItem, {
      name: `Held ${tag}`,
      sku: `HELD-${tag}`,
      barcode: '5901234123457',
      acknowledgeSimilar: true,
    })) as { variantId: string };
    const csv = [
      'name,sku,EAN',
      `Scanned tea ${tag},BC-${tag}-1,4006381333931`,
      `Scanned tea ${tag} B,BC-${tag}-2,05901234123457`,
      `Scanned tea ${tag} C,BC-${tag}-3,4006381333931`,
      `Scanned tea ${tag} D,BC-${tag}-4,12345`,
    ].join('\n');
    const { importId, suggested, preview } = await upload(csv);
    expect(suggested.EAN).toBe('barcode');
    const problems = new Map(preview.problems.map((p) => [p.rowNumber, p.errors.join(' ')]));
    expect(problems.get(3)).toContain(`already belongs to HELD-${tag}`);
    expect(problems.get(4)).toContain('repeats row 2');
    expect(problems.has(5)).toBe(false);
    await run(ops.commitImport, { importId });
    while ((await runImportJob(deps(), shop.shopId, importId)) === 'more') {}
    const [stored1] = await ownerQuery<{ symbology: string; code: string; sku: string }>(
      `select b.symbology, b.code, v.sku from barcodes b join variants v on v.id = b.variant_id
       where b.shop_id = $1 and b.code_normalized = $2`,
      [shop.shopId, '04006381333931'],
    );
    expect(stored1).toMatchObject({ symbology: 'ean13', sku: `BC-${tag}-1` });
    const [short] = await ownerQuery<{ symbology: string }>(
      `select b.symbology from barcodes b join variants v on v.id = b.variant_id
       where v.shop_id = $1 and v.sku = $2`,
      [shop.shopId, `BC-${tag}-4`],
    );
    expect(short).toMatchObject({ symbology: 'code128' });
    expect(held.variantId).toBeTruthy();

    const created = (await run(ops.createExport, {
      mode: 'variants',
      filter: [{ field: 'sku', op: 'starts_with', value: `BC-${tag}` }],
    })) as { export: { exportId: string } };
    await runExportJob(deps(), shop.shopId, created.export.exportId);
    const text = stored.get(`shops/${shop.shopId}/exports/${created.export.exportId}.csv`)!;
    const [header, ...rows] = parseCsv(text.replace(/^\uFEFF/, ''));
    const at = header!.indexOf('barcode');
    expect(rows.map((r) => r[at]).sort()).toEqual(['12345', '4006381333931']);
    // Importing the export again changes nothing about the barcodes.
    const back = await upload(text.replace(/^\uFEFF/, ''));
    expect(back.preview.import.counts).toMatchObject({ updates: 2, errors: 0 });
  });
});

describe('CSV export (plan 5.12)', () => {
  it('writes the query as importable CSV that previews back as updates only', async () => {
    const created = (await run(ops.createExport, {
      mode: 'variants',
      filter: [{ field: 'sku', op: 'starts_with', value: 'JAM' }],
    })) as {
      export: { exportId: string; status: string; downloadPath: string | null };
    };
    expect(created.export).toMatchObject({ status: 'pending', downloadPath: null });
    await runExportJob(deps(), shop.shopId, created.export.exportId);
    const done = (await run(ops.getExport, { exportId: created.export.exportId }, null)) as {
      export: { status: string; rowCount: number; downloadPath: string };
    };
    expect(done.export).toMatchObject({ status: 'completed', rowCount: 2 });
    expect(done.export.downloadPath).toContain(created.export.exportId);
    const text = stored.get(`shops/${shop.shopId}/exports/${created.export.exportId}.csv`)!;
    const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
    expect(header).toEqual(
      expect.arrayContaining([
        'product',
        'name',
        'sku',
        'price',
        'option:Size',
        'net_weight',
        'allergens',
        'available',
      ]),
    );
    expect(rows).toHaveLength(2);
    // The file imports back: the same SKUs are updates, with nothing invalid.
    const back = await upload(text.replace(/^﻿/, ''));
    expect(back.preview.import.counts).toMatchObject({
      rows: 2,
      updates: 2,
      creates: 0,
      errors: 0,
    });
    const download = (await run(
      ops.downloadExport,
      { exportId: created.export.exportId },
      null,
    )) as { fileName: string };
    expect(download.fileName).toMatch(/\.csv$/);
  });

  it('leaves out restricted fields for members who cannot see them', async () => {
    await h.run(ops.createField, {
      key: 'cost_note',
      label: 'Cost note',
      type: 'text',
      visibility: 'restricted',
    });
    const editor = await addMember(shop.shopId, 'catalog_editor');
    const created = (
      await execute({ db, audit: sink, files }, ops.createExport, {
        caller: editor.caller,
        shopId: shop.shopId,
        input: { mode: 'products' },
        idempotencyKey: uuidv7(),
      })
    ).result as { export: { exportId: string } };
    await runExportJob(deps(), shop.shopId, created.export.exportId);
    const text = stored.get(`shops/${shop.shopId}/exports/${created.export.exportId}.csv`)!;
    expect(text.split('\r\n')[0]).not.toContain('cost_note');
  });
});

describe('packs and suppliers in CSV (ADR 0018)', () => {
  /** A valid EAN-13 no other test uses. */
  const ean = () => {
    const body = `2${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}`;
    return `${body}${gtinCheckDigit(body)}`;
  };
  const errorsOf = (problems: Array<{ errors: string[] }>) => problems.flatMap((p) => p.errors);
  /** A product with one variant and a name no other test uses. */
  const item = async (sku: string, extra: Record<string, unknown> = {}) =>
    (
      (await run(ops.createItem, {
        name: `Packed ${sku}`,
        sku,
        acknowledgeSimilar: true,
        ...extra,
      })) as { variantId: string }
    ).variantId;
  const packaging = (variantId: string) =>
    h.run(ops.getPackaging, { variantId }) as Promise<{
      packsVersion: number;
      packs: Array<{
        id: string;
        name: string;
        quantity: string;
        baseQuantity: string;
        version: number;
      }>;
      barcodes: Array<{ code: string; packId: string | null }>;
    }>;
  const supplier = async (name: string, on = h) =>
    ((await on.run(ops.createSupplier, { name })) as { supplier: { id: string } }).supplier.id;
  const supplierItems = (variantId: string) =>
    ownerQuery<{
      name: string;
      supplier_sku: string | null;
      preferred: boolean;
      last_cost: string | null;
      version: number;
    }>(
      `select s.name, i.supplier_sku, i.preferred, i.last_cost::text as last_cost, i.version
       from supplier_items i join suppliers s on s.shop_id = i.shop_id and s.id = i.supplier_id
       where i.shop_id = $1 and i.variant_id = $2 and i.status = 'active' order by s.name`,
      [shop.shopId, variantId],
    );
  const importEvents = (importId: string) =>
    ownerQuery<{ action: string; target_type: string; changes: Record<string, unknown> }>(
      `select action, target_type, changes from audit_events where shop_id = $1 and changes->>'importId' = $2
       order by action, target_id`,
      [shop.shopId, importId],
    );
  const commit = async (importId: string) => {
    await run(ops.commitImport, { importId });
    while ((await runImportJob(deps(), shop.shopId, importId)) === 'more') {}
  };

  it('suggests supplier and pack columns from common headers', async () => {
    expect(
      suggestMapping(
        [
          'Supplier',
          'Vendor',
          'Vendor SKU',
          'supplier_sku',
          'Supplier part number',
          'Case qty',
          'Units per carton',
          'Inner pack quantity',
          'Case GTIN',
          'pack:Pallet',
          'pack_barcode:Pallet',
          'Stock qty',
          'Box size',
        ],
        [],
      ),
    ).toEqual({
      Supplier: 'supplier',
      Vendor: 'supplier',
      'Vendor SKU': 'supplier_sku',
      supplier_sku: 'supplier_sku',
      'Supplier part number': 'supplier_sku',
      'Case qty': 'pack:Case',
      'Units per carton': 'pack:Carton',
      'Inner pack quantity': 'pack:Inner pack',
      'Case GTIN': 'pack_barcode:Case',
      'pack:Pallet': 'pack:Pallet',
      'pack_barcode:Pallet': 'pack_barcode:Pallet',
      'Stock qty': 'ignore',
      'Box size': 'ignore',
    });
    // A shop's own field keeps its header: Shopify's "Vendor" is often a brand field.
    expect(suggestMapping(['Vendor'], [{ key: 'vendor', label: 'Vendor' } as never])).toEqual({
      Vendor: 'field:vendor',
    });
  });

  it('suggests a Vendor column as the supplier only when it names the shop’s suppliers', async () => {
    const tag = uuidv7().slice(-6).toUpperCase();
    // Shopify's product CSV: Vendor holds the brand, and no supplier has that name.
    const brand = await upload(
      `name,Vendor,Vendor SKU,sku\nMug ${tag},Brand ${tag},B-1,VEN-${tag}-1\n`,
    );
    expect(brand.suggested).toMatchObject({ Vendor: 'ignore', 'Vendor SKU': 'ignore' });
    expect(brand.preview.problems).toEqual([]);
    await supplier(`Acme ${tag}`);
    const named = await upload(
      `name,Vendor,Vendor SKU,sku\nCup ${tag},acme ${tag.toLowerCase()},AC-1,VEN-${tag}-2\n`,
    );
    expect(named.suggested).toMatchObject({ Vendor: 'supplier', 'Vendor SKU': 'supplier_sku' });
  });

  it('refuses unknown suppliers, taken supplier SKUs and barcodes, and unsafe pack changes', async () => {
    const tag = uuidv7().slice(-6).toUpperCase();
    const acme = await supplier(`Acme ${tag}`);
    const held = ean();
    const first = ean();
    const owner = await item(`PO-${tag}-OWN`, { barcode: held });
    await run(ops.saveSupplierItem, {
      supplierId: acme,
      variantId: owner,
      supplierSku: `AC-${tag}-OWNED`,
    });
    // A nested case (12 inner packs of 6) and a case a bundle counts in.
    const nested = await item(`PO-${tag}-NEST`);
    await h.run(ops.setPacks, {
      variantId: nested,
      packsVersion: 0,
      packs: [
        { name: 'Inner', quantity: '6' },
        { name: 'Case', quantity: '12', innerPack: 'Inner' },
      ],
    });
    const bundled = await item(`PO-${tag}-BUND`);
    const bundledCase = (
      (await h.run(ops.setPacks, {
        variantId: bundled,
        packsVersion: 0,
        packs: [{ name: 'Case', quantity: '10' }],
      })) as { packaging: { packs: Array<{ id: string }> } }
    ).packaging.packs[0]!.id;
    const gift = await item(`PO-${tag}-GIFT`);
    await h.run(ops.setBundle, {
      variantId: gift,
      bundleVersion: 0,
      components: [{ variantId: bundled, packId: bundledCase, quantity: '1' }],
    });
    // A supplier of another shop with the same name pattern never matches here.
    const other = await seedShop(db, sink, 'Other supplier shop');
    await supplier(`Northwind ${tag}`, harness(db, sink, other));

    const csv = [
      'name,sku,Vendor,Vendor SKU,Case qty,Case GTIN,pack:Inner',
      `New ${tag} 1,PO-${tag}-1,Acme ${tag},AC-${tag}-1,12,${first},`,
      `New ${tag} 2,PO-${tag}-2,acme ${tag.toLowerCase()},ac-${tag.toLowerCase()}-1,,,`,
      `New ${tag} 3,PO-${tag}-3,Northwind ${tag},,,,`,
      `New ${tag} 4,PO-${tag}-4,,AC-${tag}-4,,,`,
      `New ${tag} 5,PO-${tag}-5,Acme ${tag},AC-${tag}-OWNED,,,`,
      `New ${tag} 6,PO-${tag}-6,,,0,,`,
      `New ${tag} 7,PO-${tag}-7,,,2.5,,`,
      `New ${tag} 8,PO-${tag}-8,,,,${ean()},`,
      `New ${tag} 9,PO-${tag}-9,,,6,${first},`,
      `New ${tag} 10,PO-${tag}-10,,,6,${held},`,
      `,PO-${tag}-NEST,,,72,,6`,
      `,PO-${tag}-BUND,,,20,,`,
    ].join('\n');
    const { suggested, preview } = await upload(csv);
    expect(suggested).toMatchObject({
      Vendor: 'supplier',
      'Vendor SKU': 'supplier_sku',
      'Case qty': 'pack:Case',
      'Case GTIN': 'pack_barcode:Case',
      'pack:Inner': 'pack:Inner',
    });
    const problems = new Map(preview.problems.map((p) => [p.rowNumber, p.errors.join(' ')]));
    expect(problems.has(2)).toBe(false);
    expect(problems.get(3)).toContain('The supplier SKU repeats row 2');
    expect(problems.get(4)).toContain(`No supplier "Northwind ${tag}"`);
    expect(problems.get(5)).toContain('Give the supplier in the same row');
    expect(problems.get(6)).toContain(`already uses AC-${tag}-OWNED for PO-${tag}-OWN`);
    expect(problems.get(7)).toContain('Use a quantity of base units');
    expect(problems.get(8)).toContain('whole number of base units');
    expect(problems.get(9)).toContain('has no pack Case');
    expect(problems.get(10)).toContain('repeats row 2');
    expect(problems.get(11)).toContain(`already belongs to PO-${tag}-OWN`);
    // A nested pack's column must equal its base units, and an inner pack keeps its quantity.
    expect(problems.has(12)).toBe(false);
    expect(problems.get(13)).toContain(`used by a bundle (PO-${tag}-GIFT)`);
    expect(preview.import.counts).toMatchObject({ creates: 1, updates: 1, errors: 10 });

    const changed = await upload(
      ['sku,pack:Case,pack:Inner', `PO-${tag}-NEST,48,`, `PO-${tag}-BUND,,`].join('\n'),
    );
    const again = await upload(['sku,pack:Inner', `PO-${tag}-NEST,8`].join('\n'));
    expect(changed.preview.problems[0]!.errors[0]).toContain('Case is made of Inner');
    expect(again.preview.problems[0]!.errors[0]).toContain('Other packs are made of Inner');
    // The mapping itself: a supplier SKU needs a supplier column, and each value one column.
    await expect(
      upload('sku,Vendor SKU\nX,1', { sku: 'sku', 'Vendor SKU': 'supplier_sku' }),
    ).rejects.toMatchObject({ code: 'mapping_invalid' });
    await expect(
      upload('sku,a,b\nX,1,2', { sku: 'sku', a: 'pack:Case', b: 'pack:case' }),
    ).rejects.toMatchObject({ code: 'mapping_invalid' });
  });

  it('creates and changes packs and supplier items, never costs, then exports them back unchanged', async () => {
    const tag = uuidv7().slice(-6).toUpperCase();
    const acme = await supplier(`Acme ${tag}`);
    const beta = await supplier(`Beta ${tag}`);
    const withCase = await item(`PC-${tag}-UPD`);
    await h.run(ops.setPacks, {
      variantId: withCase,
      packsVersion: 0,
      packs: [{ name: 'Case', quantity: '12' }],
    });
    // Beta is preferred and has a cost; Acme has an old SKU and a cost of its own.
    const supplied = await item(`PC-${tag}-SUP`);
    await run(ops.saveSupplierItem, {
      supplierId: beta,
      variantId: supplied,
      supplierSku: `B-${tag}`,
      lastCost: '3.5',
      preferred: true,
    });
    await run(ops.saveSupplierItem, {
      supplierId: acme,
      variantId: supplied,
      supplierSku: `OLD-${tag}`,
      lastCost: '2',
    });
    // A nested pack exports in base units and imports back as no change.
    const nested = await item(`PC-${tag}-NEST`);
    await h.run(ops.setPacks, {
      variantId: nested,
      packsVersion: 0,
      packs: [
        { name: 'Inner', quantity: '6' },
        { name: 'Case', quantity: '12', innerPack: 'Inner' },
      ],
    });
    // A catalog editor imports: no costs.read, and none needed.
    const editor = await addMember(shop.shopId, 'catalog_editor');
    const caseCode = ean();
    const csv = [
      'name,sku,supplier,supplier_sku,Case qty,Case barcode',
      `Packed new ${tag},PC-${tag}-NEW,Acme ${tag},AC-${tag}-NEW,24,${caseCode}`,
      `,PC-${tag}-UPD,acme ${tag.toLowerCase()},AC-${tag}-UPD,18,`,
      `,PC-${tag}-SUP,Acme ${tag},AC-${tag}-SUP,,`,
    ].join('\n');
    const { importId, preview } = await upload(csv, undefined, editor.caller);
    expect(errorsOf(preview.problems)).toEqual([]);
    expect(preview.import.counts).toMatchObject({
      creates: 1,
      updates: 2,
      packRows: 2,
      supplierRows: 3,
    });
    await commit(importId);

    const created = (await h.run(ops.getItem, { sku: `PC-${tag}-NEW` })).item.variants[0]
      .id as string;
    const createdPacks = await packaging(created);
    expect(createdPacks.packs).toMatchObject([{ name: 'Case', quantity: '24.000000', version: 1 }]);
    expect(createdPacks.barcodes).toEqual([
      expect.objectContaining({ code: caseCode, packId: createdPacks.packs[0]!.id }),
    ]);
    expect(await supplierItems(created)).toEqual([
      {
        name: `Acme ${tag}`,
        supplier_sku: `AC-${tag}-NEW`,
        preferred: true,
        last_cost: null,
        version: 1,
      },
    ]);
    // The existing case got a new version, with its history row.
    const updated = await packaging(withCase);
    expect(updated.packsVersion).toBe(2);
    expect(updated.packs).toMatchObject([{ name: 'Case', quantity: '18.000000', version: 2 }]);
    const versions = await ownerQuery<{ version: number; base_quantity: string }>(
      `select version, base_quantity::text as base_quantity from pack_versions
       where shop_id = $1 and pack_id = $2 order by version`,
      [shop.shopId, updated.packs[0]!.id],
    );
    expect(versions).toEqual([
      { version: 1, base_quantity: '12.000000' },
      { version: 2, base_quantity: '18.000000' },
    ]);
    expect(await supplierItems(withCase)).toMatchObject([
      { name: `Acme ${tag}`, supplier_sku: `AC-${tag}-UPD`, preferred: true },
    ]);
    // Acme's existing item got the SKU; costs and Beta's preference stayed.
    expect(await supplierItems(supplied)).toEqual([
      {
        name: `Acme ${tag}`,
        supplier_sku: `AC-${tag}-SUP`,
        preferred: false,
        last_cost: '2.000000',
        version: 2,
      },
      {
        name: `Beta ${tag}`,
        supplier_sku: `B-${tag}`,
        preferred: true,
        last_cost: '3.500000',
        version: 1,
      },
    ]);
    // One event per variant whose packs changed and per supplier item, linked to the import.
    const events = await importEvents(importId);
    expect(events.filter((e) => e.action === 'catalog.packs.set')).toHaveLength(2);
    expect(events.filter((e) => e.action === 'supplier_item.saved')).toHaveLength(3);
    const packEvent = events.find(
      (e) =>
        e.action === 'catalog.packs.set' &&
        (e.changes.packs as { changed: unknown[] }).changed.length,
    )!;
    expect(packEvent.changes).toMatchObject({
      packs: {
        changed: [{ name: 'Case', from: { quantity: '12' }, to: { quantity: '18' }, version: 2 }],
      },
      packsVersion: 2,
    });
    expect(JSON.stringify(events)).not.toContain('lastCost');

    // Export, then import the file again: nothing changes.
    const exported = (await run(ops.createExport, {
      mode: 'variants',
      filter: [{ field: 'sku', op: 'starts_with', value: `PC-${tag}` }],
    })) as { export: { exportId: string } };
    await runExportJob(deps(), shop.shopId, exported.export.exportId);
    const text = stored
      .get(`shops/${shop.shopId}/exports/${exported.export.exportId}.csv`)!
      .replace(/^﻿/, '');
    const [header, ...lines] = parseCsv(text);
    expect(header).toEqual(
      expect.arrayContaining([
        'supplier',
        'supplier_sku',
        'pack:Case',
        'pack_barcode:Case',
        'pack:Inner',
      ]),
    );
    const cell = (sku: string, column: string) =>
      lines.find((l) => l[header!.indexOf('sku')] === sku)![header!.indexOf(column)];
    expect(cell(`PC-${tag}-NEST`, 'pack:Case')).toBe('72');
    expect(cell(`PC-${tag}-NEW`, 'pack_barcode:Case')).toBe(caseCode);
    expect(cell(`PC-${tag}-SUP`, 'supplier')).toBe(`Beta ${tag}`);
    const back = await upload(text);
    expect(errorsOf(back.preview.problems)).toEqual([]);
    expect(back.preview.import.counts).toMatchObject({ updates: 4, errors: 0 });
    await commit(back.importId);
    expect(
      (await importEvents(back.importId)).filter((e) => e.action !== 'catalog.variant.changed'),
    ).toEqual([]);
    expect((await packaging(withCase)).packsVersion).toBe(2);
    expect((await packaging(nested)).packs.map((p) => p.version)).toEqual([1, 1]);
  });

  it('keeps export lines aligned when a later page adds option and pack columns', async () => {
    const tag = uuidv7().slice(-6).toUpperCase();
    const lines = ['product,name,sku,option:Finish,pack:Case'];
    for (let i = 0; i < 201; i++)
      lines.push(`,Align ${tag} ${String(i).padStart(3, '0')},AL-${tag}-${i},,`);
    lines.push(`Z,Align ${tag} zz,AL-${tag}-ZM,Matte,6`, `Z,Align ${tag} zz,AL-${tag}-ZG,Gloss,`);
    const { importId } = await upload(lines.join('\n'));
    await commit(importId);
    const exported = (await run(ops.createExport, {
      mode: 'variants',
      filter: [{ field: 'sku', op: 'starts_with', value: `AL-${tag}` }],
    })) as { export: { exportId: string } };
    await runExportJob(deps(), shop.shopId, exported.export.exportId);
    const [header, ...rows] = parseCsv(
      stored
        .get(`shops/${shop.shopId}/exports/${exported.export.exportId}.csv`)!
        .replace(/^\uFEFF/, ''),
    );
    expect(rows).toHaveLength(203);
    expect(rows.every((r) => r.length === header!.length)).toBe(true);
    const at = (sku: string, column: string) =>
      rows.find((r) => r[header!.indexOf('sku')] === sku)![header!.indexOf(column)];
    expect(at(`AL-${tag}-ZM`, 'option:Finish')).toBe('Matte');
    expect(at(`AL-${tag}-ZM`, 'pack:Case')).toBe('6');
    expect(at(`AL-${tag}-ZG`, 'pack:Case')).toBe('');
    expect(at(`AL-${tag}-0`, 'option:Finish')).toBe('');
  });

  it('runs only while the committer can still edit the catalog', async () => {
    const tag = uuidv7().slice(-6).toUpperCase();
    await supplier(`Acme ${tag}`);
    const editor = await addMember(shop.shopId, 'catalog_editor');
    const viewer = await addMember(shop.shopId, 'viewer');
    const csv = `name,sku,supplier,supplier_sku,pack:Case\nGone ${tag},PD-${tag},Acme ${tag},AC-${tag},6`;
    await expect(upload(csv, undefined, viewer.caller)).rejects.toMatchObject({ status: 403 });
    const { importId } = await upload(csv, undefined, editor.caller);
    await run(ops.commitImport, { importId }, uuidv7(), editor.caller);
    // The editor becomes a viewer before the job runs.
    await ownerQuery(`update memberships set role = 'viewer' where id = $1`, [editor.membershipId]);
    expect(await runImportJob(deps(), shop.shopId, importId)).toBe('done');
    const [job] = await ownerQuery<{ status: string; error: string }>(
      'select status, error from import_jobs where id = $1',
      [importId],
    );
    expect(job).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('can no longer edit'),
    });
    const [made] = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from variants where shop_id = $1 and sku = $2`,
      [shop.shopId, `PD-${tag}`],
    );
    expect(made!.n).toBe(0);
  });

  it('matches suppliers, supplier SKUs, and barcodes in the importing shop only', async () => {
    const tag = uuidv7().slice(-6).toUpperCase();
    const code = ean();
    const other = await seedShop(db, sink, 'Other pack shop');
    const otherH = harness(db, sink, other);
    const theirs = await supplier(`Shared ${tag}`, otherH);
    const theirVariant = (
      (await otherH.run(ops.createItem, { name: `Theirs ${tag}`, sku: `PX-${tag}` })) as {
        variantId: string;
      }
    ).variantId;
    await otherH.run(ops.setPacks, {
      variantId: theirVariant,
      packsVersion: 0,
      packs: [{ name: 'Case', quantity: '6' }],
    });
    await otherH.run(ops.saveSupplierItem, {
      supplierId: theirs,
      variantId: theirVariant,
      supplierSku: `SH-${tag}`,
    });
    const theirCase = (await otherH.run(ops.getPackaging, { variantId: theirVariant })) as {
      packs: Array<{ id: string }>;
      barcodesVersion: number;
    };
    await otherH.run(ops.setBarcodes, {
      variantId: theirVariant,
      barcodesVersion: theirCase.barcodesVersion,
      barcodes: [{ code, symbology: 'ean13', packId: theirCase.packs[0]!.id }],
    });
    // Same supplier name, SKU, and code in this shop: the other shop's records are invisible.
    const missing = await upload(`name,sku,supplier\nMine ${tag},PX-${tag},Shared ${tag}`);
    expect(missing.preview.problems[0]!.errors[0]).toContain(`No supplier "Shared ${tag}"`);
    await supplier(`Shared ${tag}`);
    const { importId, preview } = await upload(
      `name,sku,supplier,supplier_sku,pack:Case,pack_barcode:Case\nMine ${tag},PX-${tag},Shared ${tag},SH-${tag},6,${code}`,
    );
    expect(errorsOf(preview.problems)).toEqual([]);
    await commit(importId);
    const mine = (await h.run(ops.getItem, { sku: `PX-${tag}` })).item.variants[0].id as string;
    expect(await supplierItems(mine)).toMatchObject([
      { supplier_sku: `SH-${tag}`, preferred: true },
    ]);
    expect((await packaging(mine)).barcodes).toMatchObject([{ code }]);
  });
});
