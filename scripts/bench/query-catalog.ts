/**
 * Catalog query benchmark (plan Section 8, F12): p50 and p95 of catalog.items.query at the server,
 * 50 rows per page, for list, search, and custom-field filter and sort, on shops from
 * seed-catalog.ts. Runs the operation in process against the database, so the figures are server
 * time without the network.
 *
 *   DATABASE_APP_URL=postgres://airstock_app:…@…/db tsx scripts/bench/query-catalog.ts \
 *     --seed seed.json [--n 30]
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { type Caller, execute, ops } from '../../packages/core/src/index.ts';
import { PgDatabase, poolSource } from '../../packages/db/src/index.ts';

const { values: args } = parseArgs({
  options: { seed: { type: 'string', default: 'seed.json' }, n: { type: 'string', default: '30' } },
});
const url =
  process.env.DATABASE_APP_URL ??
  'postgres://airstock_app:airstock_app@localhost:54329/airstock_dev';
const seed = JSON.parse(await readFile(args.seed, 'utf8')) as { shops: Array<{ shopId: string }> };
const db = new PgDatabase(poolSource(url, 4));
const audit = { send: async () => {} };

const scenarios: Array<[string, Record<string, unknown>]> = [
  ['list 50, default sort', { limit: 50 }],
  ['list 50, sort by price desc', { limit: 50, sort: { field: 'price', direction: 'desc' } }],
  ['search "classic lamp"', { limit: 50, search: 'classic lamp' }],
  ['search exact SKU', { limit: 50, search: 'B0-000123' }],
  [
    'custom select filter + custom sort',
    {
      limit: 50,
      filter: [{ field: 'material', op: 'is_any_of', value: ['Oak', 'Walnut'] }],
      sort: { field: 'net_weight', direction: 'asc' },
    },
  ],
  [
    'custom range filter + sort, with values',
    {
      limit: 50,
      filter: [
        { field: 'shelf_life_days', op: 'between', value: ['100', '400'] },
        { field: 'seasons', op: 'has_any', value: ['Winter'] },
      ],
      sort: { field: 'margin', direction: 'desc' },
      fields: ['brand', 'material', 'net_weight', 'rrp'],
    },
  ],
  [
    'products mode, filter on variant field',
    { mode: 'products', limit: 50, filter: [{ field: 'price', op: 'lt', value: '50' }] },
  ],
  [
    'in stock, with available',
    { limit: 50, filter: [{ field: 'available', op: 'gt', value: '0' }], fields: ['available'] },
  ],
];

const caller = async (shopId: string): Promise<Caller> => {
  const rows = await db.transaction({ shopId, userId: null, readOnly: true }, (tx) =>
    tx.query<{ id: string; user_id: string }>(
      `select id, user_id from memberships where role = 'owner' limit 1`,
    ),
  );
  const m = rows[0]!;
  return {
    kind: 'api_credential',
    id: 'bench',
    userId: m.user_id,
    boundShopId: shopId,
    membership: { id: m.id, role: 'owner', allLocations: true, locationScopeIds: [] },
    scopes: 'all',
    source: 'api',
  };
};

const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
for (const [label, input] of scenarios) {
  const times: number[] = [];
  let statements = 0;
  let rows = 0;
  for (let i = 0; i < Number(args.n); i++) {
    const shop = seed.shops[i % seed.shops.length]!;
    const c = await caller(shop.shopId);
    const t = performance.now();
    const res = await execute({ db, audit }, ops.queryItems, {
      caller: c,
      shopId: shop.shopId,
      input,
    });
    times.push(performance.now() - t);
    rows = (res.result as { rows: unknown[] }).rows.length;
    statements++;
  }
  console.log(
    `${label.padEnd(42)} p50 ${pct(times, 50).toFixed(1).padStart(7)} ms   p95 ${pct(times, 95).toFixed(1).padStart(7)} ms   rows ${rows}`,
  );
}
await db.close();
