/**
 * Export benchmark (plan Section 8): time to write a 10,000-variant shop to CSV, run in process
 * against a shop seeded with `seed-catalog.ts`.
 *
 *   DATABASE_APP_URL=… tsx scripts/bench/export-catalog.ts --seed seed.json
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { type Caller, execute, ops, runExportJob, uuidv7 } from '../../packages/core/src/index.ts';
import { PgDatabase, poolSource } from '../../packages/db/src/index.ts';

const { values: args } = parseArgs({ options: { seed: { type: 'string', default: 'seed.json' } } });
const url =
  process.env.DATABASE_APP_URL ??
  'postgres://airstock_app:airstock_app@localhost:54329/airstock_bench';
const seed = JSON.parse(await readFile(args.seed, 'utf8')) as { shops: Array<{ shopId: string }> };
let statements = 0;
const db = new PgDatabase(poolSource(url, 4), {
  onTransactionEnd: (t) => (statements += t.statements),
});
const audit = { send: async () => {} };
const stored = new Map<string, string>();
const files = {
  get: async (k: string) => stored.get(k) ?? null,
  put: async (k: string, body: string) => {
    stored.set(k, body);
  },
  delete: async (k: string) => {
    stored.delete(k);
  },
};
const shopId = seed.shops[0]!.shopId;
const [m] = await db.transaction({ shopId, userId: null, readOnly: true }, (tx) =>
  tx.query<{ id: string; user_id: string }>(
    `select id, user_id from memberships where role = 'owner' limit 1`,
  ),
);
const caller: Caller = {
  kind: 'user',
  id: 'bench',
  userId: m!.user_id,
  boundShopId: null,
  membership: { id: m!.id, role: 'owner', allLocations: true, locationScopeIds: [] },
  scopes: 'all',
  source: 'dashboard',
};
const created = (
  await execute({ db, audit, files }, ops.createExport, {
    caller,
    shopId,
    input: { mode: 'variants' },
    idempotencyKey: uuidv7(),
  })
).result as { export: { exportId: string } };
statements = 0;
const t = performance.now();
await runExportJob({ db, audit, files }, shopId, created.export.exportId);
const ms = performance.now() - t;
const text = [...stored.values()][0] ?? '';
console.log(
  JSON.stringify(
    {
      rows: text.split('\r\n').length - 2,
      ms: Math.round(ms),
      statements,
      bytes: Buffer.byteLength(text),
    },
    null,
    2,
  ),
);
await db.close();
