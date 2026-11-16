/**
 * Import benchmark (plan Section 8): preview and commit time and SQL statements per row for a
 * create import of N rows (products with size variants, custom fields), run in process. --packs
 * adds a supplier, a supplier SKU, a case quantity, and a case barcode to every row.
 *
 *   DATABASE_APP_URL=… DATABASE_OWNER_URL=… tsx scripts/bench/import-catalog.ts [--rows 10000] [--stock] [--packs]
 */
import { parseArgs } from 'node:util';
import { gtinCheckDigit } from '../../packages/core/src/catalog/barcodes.ts';
import {
  ensureUser,
  execute,
  ops,
  runImportJob,
  sessionCaller,
  uuidv7,
} from '../../packages/core/src/index.ts';
import { PgDatabase, poolSource } from '../../packages/db/src/index.ts';

const { values: args } = parseArgs({
  options: {
    rows: { type: 'string', default: '10000' },
    stock: { type: 'boolean', default: false },
    packs: { type: 'boolean', default: false },
  },
});
const url =
  process.env.DATABASE_APP_URL ??
  'postgres://airstock_app:airstock_app@localhost:54329/airstock_bench';
let statements = 0;
const db = new PgDatabase(poolSource(url, 4), {
  onTransactionEnd: (t) => (statements += t.statements),
});
const audit = { send: async () => {} };
const stored = new Map<string, string>();
const files = {
  get: async (k: string) => stored.get(k) ?? null,
  put: async (k: string, b: string) => void stored.set(k, b),
  delete: async (k: string) => void stored.delete(k),
};

const userId = await ensureUser(db, {
  providerUserId: `bench_${uuidv7()}`,
  email: `${uuidv7()}@example.test`,
});
const caller = sessionCaller(userId);
const shop = (
  await execute({ db, audit }, ops.createShop, {
    caller,
    shopId: null,
    input: { name: 'Import bench', currency: 'EUR', timezone: 'Europe/Berlin' },
  })
).result as { shopId: string; defaultLocationId: string };
const run = (op: Parameters<typeof execute>[1], input: unknown) =>
  execute({ db, audit, files }, op, {
    caller,
    shopId: shop.shopId,
    input,
    idempotencyKey: uuidv7(),
  }).then((r) => r.result as never);
await run(ops.addTemplate, { template: 'apparel' });
if (args.packs) await run(ops.createSupplier, { name: 'Bench supplier' });

const n = Number(args.rows);
const lines = [
  `product,name,sku,price,option:Size,material,care_instructions${args.stock ? ',stock' : ''}${args.packs ? ',supplier,supplier_sku,Case qty,Case barcode' : ''}`,
];
const sizes = ['S', 'M', 'L', 'XL'];
const ean = (i: number) => {
  const body = `2${String(i).padStart(11, '0')}`;
  return `${body}${gtinCheckDigit(body)}`;
};
for (let i = 0; i < n; i++) {
  const p = Math.floor(i / 4);
  lines.push(
    `P${p},Bench shirt ${p},BI-${String(i).padStart(6, '0')},${10 + (p % 40)}.90,${sizes[i % 4]},Cotton,Wash at 30.${args.stock ? `,${i % 5}` : ''}${args.packs ? `,Bench supplier,BS-${i},12,${ean(i)}` : ''}`,
  );
}
const created = (await run(ops.createImport, { fileName: 'bench.csv' })) as { importId: string };
stored.set(`shops/${shop.shopId}/imports/${created.importId}/source.csv`, lines.join('\n'));
await run(ops.recordImportUpload, {
  importId: created.importId,
  sizeBytes: lines.join('\n').length,
});
const mapping: Record<string, string> = {
  product: 'product',
  name: 'name',
  sku: 'sku',
  price: 'price',
  'option:Size': 'option:Size',
  material: 'field:material',
  care_instructions: 'field:care_instructions',
};
if (args.stock) mapping.stock = `stock:${shop.defaultLocationId}`;
if (args.packs) {
  mapping.supplier = 'supplier';
  mapping.supplier_sku = 'supplier_sku';
  mapping['Case qty'] = 'pack:Case';
  mapping['Case barcode'] = 'pack_barcode:Case';
}
let t = performance.now();
statements = 0;
await run(ops.previewImport, { importId: created.importId, mapping });
const previewMs = performance.now() - t;
const previewStatements = statements;
await run(ops.commitImport, { importId: created.importId });
t = performance.now();
statements = 0;
let runs = 0;
while ((await runImportJob({ db, audit, files }, shop.shopId, created.importId)) === 'more') runs++;
const commitMs = performance.now() - t;
console.log(
  JSON.stringify(
    {
      rows: n,
      previewMs: Math.round(previewMs),
      previewStatements,
      commitMs: Math.round(commitMs),
      commitStatements: statements,
      statementsPerRow: +(statements / n).toFixed(2),
      runs: runs + 1,
    },
    null,
    2,
  ),
);
await db.close();
