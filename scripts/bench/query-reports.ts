/**
 * Report timings on the persona shops (Phase 2 plan, Section 8: "reports on 31,000 variants: stock
 * on hand, value at a past date, under 5 s and under 10 s, or run as a job"), milestone I5.
 *
 *   DATABASE_APP_URL=postgres://airstock_app:…@…/db DATABASE_OWNER_URL=… \
 *     tsx scripts/bench/query-reports.ts \
 *     [--n 5] [--names 'Bench %'] [--json reports.json]
 *
 * Each report shape runs --n times per shop through the product's own operation (`execute`, as
 * the shop's owner, so the pipeline, row-level security, and the access event are as in the
 * product). Reported per shape: the client's time for the whole run (median and slowest), the
 * slowest statement as the client saw it, and the server's time for that statement (planning
 * plus execution from EXPLAIN (ANALYZE, TIMING OFF), run once after the timed runs). The export
 * job of the largest stock-on-hand report is timed at the end.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import {
  type Caller,
  execute,
  type FileAccess,
  ops,
  runReportExportJob,
  sessionCaller,
} from '../../packages/core/src/index.ts';
import { type Database, PgDatabase, poolSource, type Tx } from '../../packages/db/src/index.ts';

const { values: args } = parseArgs({
  options: {
    n: { type: 'string', default: '5' },
    names: { type: 'string', default: 'Bench %' },
    json: { type: 'string' },
  },
});
const url = process.env.DATABASE_APP_URL;
const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!url || !ownerUrl)
  throw new Error(
    'Set DATABASE_APP_URL (the runtime role) and DATABASE_OWNER_URL (to list shops).',
  );
const N = Number(args.n);
const base = new PgDatabase(poolSource(url, 2));

// Statement timing: every query of a run, with its SQL for the EXPLAIN afterwards.
interface Statement {
  ms: number;
  sql: string;
  params: unknown[];
}
let statements: Statement[] = [];
const timed = (tx: Tx): Tx =>
  new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop !== 'query') return Reflect.get(target, prop, receiver);
      return async (sql: string, params: unknown[] = []) => {
        const t0 = performance.now();
        try {
          return await target.query(sql, params);
        } finally {
          statements.push({ ms: performance.now() - t0, sql, params });
        }
      };
    },
  });
const db: Database = {
  transaction: (ctx, fn) => base.transaction(ctx, (tx) => fn(timed(tx))),
  close: () => base.close(),
} as Database;
const audit = { send: async () => {} };

interface Shape {
  name: string;
  input: Record<string, unknown>;
}
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const SHAPES: Shape[] = [
  { name: 'stock on hand, positions, first 100', input: { report: 'stock_on_hand' } },
  {
    name: 'stock on hand, per variant, by on hand',
    input: { report: 'stock_on_hand', groupBy: 'variant', sort: '-onHand' },
  },
  {
    name: 'stock on hand, per location',
    input: { report: 'stock_on_hand', groupBy: 'location' },
  },
  { name: 'inventory value now, per location', input: { report: 'inventory_value' } },
  {
    name: 'inventory value 7 days ago, per location',
    input: { report: 'inventory_value', at: day(-7) },
  },
  {
    name: 'inventory value 7 days ago, per variant, by value',
    input: { report: 'inventory_value', at: day(-7), groupBy: 'variant' },
  },
  {
    name: 'inventory value 7 days ago, per category',
    input: { report: 'inventory_value', at: day(-7), groupBy: 'category' },
  },
  { name: 'movements, 30 days, per variant', input: { report: 'movements' } },
  { name: 'movements, 30 days, entries', input: { report: 'movements', groupBy: 'entry' } },
  { name: 'cost of goods, 30 days, per variant', input: { report: 'cost_of_goods' } },
  { name: 'low stock', input: { report: 'low_stock' } },
  { name: 'purchasing', input: { report: 'purchasing' } },
  { name: 'expiring lots, 30 days', input: { report: 'expiring_lots' } },
  { name: 'shortages', input: { report: 'shortages' } },
];

// The shops, their owners, and their sizes, read as the owner role (the runtime role sees one
// shop at a time).
const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
const targets = (
  await owner.query<{ id: string; name: string; ownerUserId: string; variants: number }>(
    `select s.id, s.name, m.user_id as "ownerUserId",
       (select count(*)::int from variants v where v.shop_id = s.id) as variants
     from shops s
     join lateral (select user_id from memberships m where m.shop_id = s.id and m.role = 'owner'
       and m.status = 'active' order by m.created_at limit 1) m on true
     where s.name like $1 order by s.name`,
    [args.names],
  )
).rows;
await owner.end();

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const results: Array<Record<string, unknown>> = [];

async function serverTime(shopId: string, s: Statement): Promise<number> {
  return base.transaction({ shopId, userId: null, readOnly: true }, async (tx) => {
    await tx.query(`select set_config('statement_timeout', '120000', true)`);
    const [row] = await tx.query<{ 'QUERY PLAN': Array<Record<string, number>> }>(
      `explain (analyze, timing off, format json) ${s.sql}`,
      s.params,
    );
    const plan = row!['QUERY PLAN'][0]!;
    return (plan['Planning Time'] ?? 0) + (plan['Execution Time'] ?? 0);
  });
}

for (const shop of targets) {
  const caller: Caller = sessionCaller(shop.ownerUserId);
  for (const shape of SHAPES) {
    const totals: number[] = [];
    let slowest: Statement | null = null;
    let rows = 0;
    let rowCount = 0;
    for (let i = 0; i < N; i++) {
      statements = [];
      const t0 = performance.now();
      const res = await execute({ db, audit }, ops.runStandardReport, {
        caller,
        shopId: shop.id,
        input: shape.input,
      });
      totals.push(performance.now() - t0);
      const top = statements.reduce((a, b) => (b.ms > a.ms ? b : a));
      if (!slowest || top.ms > slowest.ms) slowest = top;
      const out = res.result as { rows: unknown[]; rowCount: number };
      rows = out.rows.length;
      rowCount = out.rowCount;
    }
    const server = slowest ? await serverTime(shop.id, slowest) : 0;
    const line = {
      shop: shop.name,
      variants: shop.variants,
      shape: shape.name,
      rowCount,
      rows,
      medianMs: Math.round(median(totals)),
      maxMs: Math.round(Math.max(...totals)),
      slowestStatementMs: Math.round(slowest?.ms ?? 0),
      serverMs: Math.round(server),
    };
    results.push(line);
    console.log(
      `${shop.name.padEnd(24)} ${shape.name.padEnd(50)} ${String(rowCount).padStart(6)} rows  median ${String(line.medianMs).padStart(5)} ms  max ${String(line.maxMs).padStart(5)} ms  server ${String(line.serverMs).padStart(5)} ms`,
    );
  }
}

// The export job for the largest shop's stock on hand, every row.
const largest = [...targets].sort((a, b) => b.variants - a.variants)[0]!;
const files: FileAccess & { bytes: number } = {
  bytes: 0,
  async get() {
    return null;
  },
  async put(_key, body) {
    files.bytes = body.length;
  },
  async delete() {},
};
const started = await execute({ db: base, audit }, ops.exportReport, {
  caller: sessionCaller(largest.ownerUserId),
  shopId: largest.id,
  input: { report: 'stock_on_hand', filters: {} },
  idempotencyKey: crypto.randomUUID(),
});
const exportId = (started.result as { export: { exportId: string } }).export.exportId;
const t0 = performance.now();
await runReportExportJob({ db: base, audit, files }, largest.id, exportId);
const exportMs = Math.round(performance.now() - t0);
const [job] = await base.transaction({ shopId: largest.id, userId: null, readOnly: true }, (tx) =>
  tx.query<{ status: string; row_count: number }>(
    'select status, row_count from export_jobs where id = $1',
    [exportId],
  ),
);
console.log(
  `\nExport job, ${largest.name}, stock on hand: ${job?.status}, ${job?.row_count} rows, ${(files.bytes / 1024).toFixed(0)} kB, ${exportMs} ms`,
);
results.push({
  shop: largest.name,
  shape: 'export job, stock on hand',
  exportMs,
  rows: job?.row_count,
});
if (args.json) await writeFile(args.json, JSON.stringify(results, null, 2));
await base.close();
