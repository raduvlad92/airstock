/**
 * Catalog query benchmark (plan Section 8, F12): p50 and p95 of catalog.items.query at the server,
 * 50 rows per page, for list, search, and custom-field filter and sort. Runs the operation in
 * process against the database, so the figures are the operation's time plus the network round
 * trips to the database; the statement count and the measured round trip give the server's share.
 *
 *   DATABASE_APP_URL=postgres://airstock_app:…@…/db tsx scripts/bench/query-catalog.ts \
 *     --seed seed.json [--n 30] [--json catalog.json]
 *
 * With a seed file from seed-catalog.ts (Phase 1), every shop runs the same inputs. With one from
 * seed-personas.ts (Phase 2), each shop has its own fields, so each shape uses the shop's query
 * hints: the same eight shapes, on that shop's select, measurement, range, multi-select, and
 * decimal fields.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { type Caller, execute, ops } from '../../packages/core/src/index.ts';
import { PgDatabase, poolSource } from '../../packages/db/src/index.ts';
import type { QueryHints } from './personas.ts';

const { values: args } = parseArgs({
  options: {
    seed: { type: 'string', default: 'seed.json' },
    n: { type: 'string', default: '30' },
    json: { type: 'string' },
  },
});
const url =
  process.env.DATABASE_APP_URL ??
  'postgres://airstock_app:airstock_app@localhost:54329/airstock_dev';
const seed = JSON.parse(await readFile(args.seed, 'utf8')) as {
  shops: Array<{ shopId: string; name?: string; query?: QueryHints & { sku: string } }>;
};
let statements = 0;
const db = new PgDatabase(poolSource(url, 4), {
  onTransactionEnd: (stats) => {
    statements += stats.statements;
  },
});
const audit = { send: async () => {} };
let lastError = '';
const logger = {
  error: (_message: string, data?: Record<string, unknown>) => {
    lastError = String(data?.error ?? '');
  },
};

type Input = Record<string, unknown>;
/** Each shape: a label and the input for a shop (from its hints, or Phase 1's fixed inputs). */
const scenarios: Array<[string, (h: (QueryHints & { sku: string }) | undefined) => Input]> = [
  ['list 50, default sort', () => ({ limit: 50 })],
  [
    'list 50, sort by price desc',
    () => ({ limit: 50, sort: { field: 'price', direction: 'desc' } }),
  ],
  ['search words', (h) => ({ limit: 50, search: h?.search ?? 'classic lamp' })],
  ['search exact SKU', (h) => ({ limit: 50, search: h?.sku ?? 'B0-000123' })],
  [
    'custom select filter + custom sort',
    (h) => ({
      limit: 50,
      filter: [
        {
          field: h?.select.field ?? 'material',
          op: 'is_any_of',
          value: h?.select.values ?? ['Oak', 'Walnut'],
        },
      ],
      sort: { field: h?.measurementSort ?? 'net_weight', direction: 'asc' },
    }),
  ],
  [
    'custom range filter + sort, with values',
    (h) => ({
      limit: 50,
      filter: [
        {
          field: h?.range.field ?? 'shelf_life_days',
          op: 'between',
          value: h ? [h.range.from, h.range.to] : ['100', '400'],
        },
        { field: h?.multi.field ?? 'seasons', op: 'has_any', value: [h?.multi.value ?? 'Winter'] },
      ],
      sort: { field: h?.decimalSort ?? 'margin', direction: 'desc' },
      fields: h?.fields ?? ['brand', 'material', 'net_weight', 'rrp'],
    }),
  ],
  [
    'products mode, filter on variant field',
    (h) => ({
      mode: 'products',
      limit: 50,
      filter: [{ field: 'price', op: 'lt', value: h?.priceBelow ?? '50' }],
    }),
  ],
  [
    'in stock, with available',
    () => ({
      limit: 50,
      filter: [{ field: 'available', op: 'gt', value: '0' }],
      fields: ['available'],
    }),
  ],
];

const callers = new Map<string, Caller>();
const caller = async (shopId: string): Promise<Caller> => {
  const known = callers.get(shopId);
  if (known) return known;
  const rows = await db.transaction({ shopId, userId: null, readOnly: true }, (tx) =>
    tx.query<{ id: string; user_id: string }>(
      `select id, user_id from memberships where role = 'owner' limit 1`,
    ),
  );
  const m = rows[0]!;
  const c: Caller = {
    kind: 'api_credential',
    id: 'bench',
    userId: m.user_id,
    boundShopId: shopId,
    membership: { id: m.id, role: 'owner', allLocations: true, locationScopeIds: [] },
    scopes: 'all',
    source: 'api',
  };
  callers.set(shopId, c);
  return c;
};

const pct = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};

// The round trip of one statement, to separate the network from the server's time.
const rtt: number[] = [];
for (let i = 0; i < 20; i++) {
  const t = performance.now();
  await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query('select 1'),
  );
  // Three statements, each a round trip: BEGIN with the tenant context, the query, COMMIT.
  rtt.push((performance.now() - t) / 3);
}
const roundTrip = pct(rtt, 50);
console.log(`One round trip to the database: p50 ${roundTrip.toFixed(1)} ms`);

const out: Array<Record<string, unknown>> = [];
for (const [label, inputFor] of scenarios) {
  const times: number[] = [];
  const server: number[] = [];
  let rows = 0;
  let perRun = 0;
  const failed: Record<string, number> = {};
  for (let i = 0; i < Number(args.n); i++) {
    const shop = seed.shops[i % seed.shops.length]!;
    const c = await caller(shop.shopId);
    const before = statements;
    const t = performance.now();
    let res: Awaited<ReturnType<typeof execute>>;
    try {
      res = await execute({ db, audit, logger }, ops.queryItems, {
        caller: c,
        shopId: shop.shopId,
        input: inputFor(shop.query),
      });
    } catch (error) {
      // Counted and reported rather than stopping the run: a failure is a finding.
      const key = `${shop.name ?? shop.shopId}: ${(error as Error).message} ${lastError}`.trim();
      failed[key] = (failed[key] ?? 0) + 1;
      continue;
    }
    const ms = performance.now() - t;
    perRun = statements - before;
    times.push(ms);
    server.push(Math.max(0, ms - perRun * roundTrip));
    rows += (res.result as { rows: unknown[] }).rows.length;
  }
  if (times.length === 0) {
    out.push({ label, failed });
    console.log(`${label.padEnd(42)} every run failed: ${JSON.stringify(failed)}`);
    continue;
  }
  const row = {
    label,
    failed,
    p50: pct(times, 50),
    p95: pct(times, 95),
    serverP50: pct(server, 50),
    serverP95: pct(server, 95),
    statements: perRun,
    rows: Math.round(rows / times.length),
  };
  out.push(row);
  console.log(
    `${label.padEnd(42)} p50 ${row.p50.toFixed(1).padStart(7)} ms   p95 ${row.p95.toFixed(1).padStart(7)} ms   less ${perRun} round trips: p50 ${row.serverP50.toFixed(1).padStart(6)}  p95 ${row.serverP95.toFixed(1).padStart(6)} ms   rows ${row.rows}${Object.keys(failed).length ? `   FAILED ${JSON.stringify(failed)}` : ''}`,
  );
}
await db.close();
if (args.json) {
  await writeFile(
    args.json,
    JSON.stringify({ at: new Date().toISOString(), roundTrip, n: Number(args.n), out }, null, 2),
  );
}
