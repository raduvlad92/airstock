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

const run = (op: Parameters<typeof execute>[1], input: unknown, key: string | null = uuidv7()) =>
  execute({ db, audit: sink, files }, op, {
    caller: shop.caller,
    shopId: shop.shopId,
    input,
    idempotencyKey: key,
  }).then((r) => r.result as never);

/** Creates an import with `csv` as its file and previews it with the suggested or given mapping. */
async function upload(csv: string, mapping?: Record<string, string>) {
  const created = (await run(ops.createImport, { fileName: 'catalog.csv' })) as {
    importId: string;
  };
  stored.set(`shops/${shop.shopId}/imports/${created.importId}/source.csv`, csv);
  await run(ops.recordImportUpload, { importId: created.importId, sizeBytes: csv.length }, null);
  const first = (await run(ops.previewImport, { importId: created.importId })) as {
    suggestedMapping: Record<string, string>;
  };
  const preview = (await run(ops.previewImport, {
    importId: created.importId,
    mapping: mapping ?? first.suggestedMapping,
  })) as {
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
