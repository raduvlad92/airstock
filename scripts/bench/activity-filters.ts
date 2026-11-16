/**
 * Times the activity search of milestone I5 (plan Section 8: "activity search over 1 million
 * events with two filters, p95 under 1 s"), warm and cold, on the bench history.
 *
 *   DATABASE_OWNER_URL=… DATABASE_APP_URL=… tsx scripts/bench/activity-filters.ts \
 *     [--n 12] [--cold] [--explain] [--only <shape keys, comma-separated>] [--json out.json]
 *
 * Every search is the product's own SQL: `activityQuery` in packages/core/src/activity/query.ts,
 * which `activity.list`, `search_activity`, and the activity export all use, plus the first
 * page's ingestion check. It runs as the runtime role in a read-only transaction with the shop
 * set, so row-level security applies as in the product. The filter values come from each shop's
 * own history: its busiest and quietest member, an integration, its busiest location and its
 * quietest warehouse, a bulk edit, a source and an action it never used, and so on.
 *
 * - **Warm:** each shape runs --n times per shop. The server time is planning plus execution
 *   from EXPLAIN (ANALYZE, TIMING OFF), run right after the query; the client time includes one
 *   round trip for the query and three for the transaction around it.
 * - **Cold (--cold):** before each shape, for each shop, the compute is suspended through the
 *   Neon API (NEON_API_KEY, NEON_PROJECT_ID, NEON_ENDPOINT_ID), so it restarts with an empty
 *   cache. A `select 1` wakes it, then the shape runs once as EXPLAIN (ANALYZE, BUFFERS): its
 *   server time and the pages it had to read from storage. The wake-up is not counted, since the
 *   first request after a suspend pays it whatever it asks.
 *
 * DATABASE_OWNER_URL is used once, to list the bench shops (the runtime role sees a shop only
 * with its ID set). Neither URL is printed.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import {
  type ActivityFiltersInput,
  activityQuery,
  ingestionQuery,
  resolveActivityFilters,
  resolveScope,
} from '../../packages/core/src/activity/query.ts';
import { PgDatabase, poolSource, type Tx } from '../../packages/db/src/index.ts';

const { values: args } = parseArgs({
  options: {
    n: { type: 'string', default: '12' },
    cold: { type: 'boolean', default: false },
    explain: { type: 'boolean', default: false },
    only: { type: 'string' },
    json: { type: 'string' },
  },
});
const ownerUrl = process.env.DATABASE_OWNER_URL;
const appUrl = process.env.DATABASE_APP_URL;
if (!ownerUrl || !appUrl) throw new Error('Set DATABASE_OWNER_URL and DATABASE_APP_URL.');
const N = Number(args.n);
const neon = args.cold
  ? {
      key: process.env.NEON_API_KEY,
      project: process.env.NEON_PROJECT_ID,
      endpoint: process.env.NEON_ENDPOINT_ID,
    }
  : null;
if (neon && (!neon.key || !neon.project || !neon.endpoint)) {
  throw new Error('--cold needs NEON_API_KEY, NEON_PROJECT_ID, and NEON_ENDPOINT_ID.');
}

const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
const shopRows = (
  await owner.query<{ id: string; name: string }>(
    `select id, name from shops where name like 'Bench %' order by name`,
  )
).rows;
await owner.end();
if (shopRows.length === 0) throw new Error('No bench shops. Run seed-personas.ts first.');

// Reassigned after each suspend: suspending the compute ends every open connection.
let db = new PgDatabase(poolSource(appUrl, 2));
const ro = <T>(shopId: string, fn: (tx: Tx) => Promise<T>) =>
  db.transaction({ shopId, userId: null, readOnly: true }, fn);

// What each shop's history contains, sampled once (not timed) ----------------------------------

interface Sample {
  id: string;
  name: string;
  events: number;
  busyUser: string;
  quietUser: string;
  integration: string | null;
  location: string | null;
  warehouse: string | null;
  quietWarehouse: string | null;
  variant: string | null;
  bulkAttempt: string | null;
  scope: string[] | null;
  unusedSource: string;
  rareAction: string;
}

const samples: Sample[] = [];
for (const shop of shopRows) {
  const s = await ro(shop.id, async (tx) => {
    const one = async (sql: string, params: unknown[] = []) =>
      (await tx.query<{ v: string | null }>(sql, params))[0]?.v ?? null;
    const events = Number(
      await one(`select count(*)::text as v from audit_events where shop_id = app_shop_id()`),
    );
    const users = await tx.query<{ v: string; n: number }>(
      `select actor_id as v, count(*)::int as n from audit_events
       where shop_id = app_shop_id() and actor_type = 'user' group by 1 order by 2 desc`,
    );
    const integration = await one(
      `select actor_id as v from audit_events where shop_id = app_shop_id()
         and actor_type in ('connection', 'api_credential') group by 1 order by count(*) desc limit 1`,
    );
    const location = await one(
      `select l as v from audit_events, unnest(location_ids) l where shop_id = app_shop_id()
         and occurred_at > now() - interval '14 days' group by 1 order by count(*) desc limit 1`,
    );
    // Warehouses by how often history names a location inside them: the busiest and quietest.
    const warehouses = await tx.query<{ v: string; n: number }>(
      `select w.id as v, count(e.event_id)::int as n
       from warehouses w
       left join locations l on l.path_ids[1] = w.id
       left join audit_events e on e.shop_id = app_shop_id() and l.id = any(e.location_ids)
       group by w.id order by 2 desc`,
    );
    const variant = await one(
      `select target_id as v from audit_events where shop_id = app_shop_id() and target_type = 'variant'
         and occurred_at > now() - interval '3 days' group by 1 order by count(*) desc limit 1`,
    );
    const bulkAttempt = await one(
      `select attempt_id::text as v from audit_events where shop_id = app_shop_id()
         and attempt_id is not null and occurred_at > now() - interval '30 days'
       group by 1 order by count(*) desc limit 1`,
    );
    const scoped = await one(
      `select m.id::text as v from memberships m where m.shop_id = app_shop_id()
         and not m.all_locations limit 1`,
    );
    const scope = scoped
      ? (
          await tx.query<{ scope_id: string }>(
            'select scope_id from membership_location_scopes where membership_id = $1',
            [scoped],
          )
        ).map((r) => r.scope_id)
      : null;
    const sources = new Set(
      (
        await tx.query<{ source: string }>(
          'select distinct source from audit_events where shop_id = app_shop_id()',
        )
      ).map((r) => r.source),
    );
    const rareAction = await one(
      `select action as v from audit_events where shop_id = app_shop_id()
       group by 1 having count(*) >= 5 order by count(*) limit 1`,
    );
    return {
      id: shop.id,
      name: shop.name,
      events,
      busyUser: users[0]!.v,
      quietUser: users.at(-1)!.v,
      integration,
      location,
      warehouse: warehouses[0]?.v ?? null,
      quietWarehouse: warehouses.at(-1)?.v ?? null,
      variant,
      bulkAttempt,
      scope: scope && scope.length > 0 ? scope : null,
      unusedSource:
        ['shopify', 'scheduled', 'admin', 'webhooks'].find((x) => !sources.has(x)) ?? 'admin',
      rareAction: rareAction ?? 'member.invited',
    } satisfies Sample;
  });
  samples.push(s);
}
const total = samples.reduce((n, s) => n + s.events, 0);
console.log(
  `${samples.length} shops, ${total.toLocaleString('en')} events: ${samples.map((s) => `${s.name} ${s.events.toLocaleString('en')}`).join(', ')}`,
);

// Shapes: two filters each, except the first page and the single-record views --------------------

const DAY = 86_400_000;
const since = (days: number) => new Date(Date.now() - days * DAY).toISOString();

interface Shape {
  key: string;
  label: string;
  run: (
    s: Sample,
  ) => { filters: ActivityFiltersInput; scope?: string[] | null } | 'ingestion' | null;
}

const shapes: Shape[] = [
  { key: 'first-page', label: 'First page, no filter', run: () => ({ filters: {} }) },
  { key: 'ingestion', label: 'First page: the ingestion check', run: () => 'ingestion' },
  {
    key: 'target',
    label: 'One variant’s history (target)',
    run: (s) => (s.variant ? { filters: { targetType: 'variant', targetId: s.variant } } : null),
  },
  {
    key: 'batch',
    label: 'One bulk edit, every record (batch)',
    run: (s) => (s.bulkAttempt ? { filters: { attemptId: s.bulkAttempt } } : null),
  },
  {
    key: 'actor-30d',
    label: 'Busiest member + last 30 days',
    run: (s) => ({ filters: { actorId: s.busyUser, from: since(30) } }),
  },
  {
    key: 'quiet-actor-90d',
    label: 'Quietest member + last 90 days',
    run: (s) => ({ filters: { actorId: s.quietUser, from: since(90) } }),
  },
  {
    key: 'actor-conflict',
    label: 'Busiest member + outcome conflict',
    run: (s) => ({ filters: { actorId: s.busyUser, outcome: 'conflict' } }),
  },
  {
    key: 'action-actor',
    label: 'Action (exact) + member',
    run: (s) => ({ filters: { action: 'catalog.item.updated', actorId: s.busyUser } }),
  },
  {
    key: 'group-failed',
    label: 'Action group inventory.* + outcome failed',
    run: () => ({ filters: { action: 'inventory.*', outcome: 'failed' } }),
  },
  {
    key: 'rare-action',
    label: 'Rarest action + phase outcome',
    run: (s) => ({ filters: { action: s.rareAction, phase: 'outcome' } }),
  },
  {
    key: 'unused-action',
    label: 'Action group never used (transfer.*) + last 90 days',
    run: () => ({ filters: { action: 'inventory.transfer.*', from: since(90) } }),
  },
  {
    key: 'source-denied',
    label: 'Source MCP + outcome denied',
    run: () => ({ filters: { source: 'mcp', outcome: 'denied' } }),
  },
  {
    key: 'unused-source',
    label: 'A source the shop never used + phase outcome',
    run: (s) => ({
      filters: { source: s.unusedSource as ActivityFiltersInput['source'], phase: 'outcome' },
    }),
  },
  {
    key: 'integration-group',
    label: 'Integration + action group catalog.*',
    run: (s) =>
      s.integration ? { filters: { integration: s.integration, action: 'catalog.*' } } : null,
  },
  {
    key: 'failed-7d',
    label: 'Outcome failed + last 7 days',
    run: () => ({ filters: { outcome: 'failed', from: since(7) } }),
  },
  {
    key: 'warehouse-7d',
    label: 'Busiest warehouse + last 7 days',
    run: (s) => (s.warehouse ? { filters: { locationId: s.warehouse, from: since(7) } } : null),
  },
  {
    key: 'quiet-warehouse',
    label: 'Quietest warehouse + outcome succeeded',
    run: (s) =>
      s.quietWarehouse ? { filters: { locationId: s.quietWarehouse, outcome: 'succeeded' } } : null,
  },
  {
    key: 'location-receipts',
    label: 'Busiest location + action receipts',
    run: (s) =>
      s.location
        ? { filters: { locationId: s.location, action: 'inventory.receipt.created' } }
        : null,
  },
  {
    key: 'scoped-group-30d',
    label: 'Member limited to one warehouse: inventory.* + last 30 days',
    run: (s) =>
      s.scope ? { filters: { action: 'inventory.*', from: since(30) }, scope: s.scope } : null,
  },
  {
    key: 'scoped-actor',
    label: 'Member limited to one warehouse: busiest member + phase attempt',
    run: (s) =>
      s.scope ? { filters: { actorId: s.busyUser, phase: 'attempt' }, scope: s.scope } : null,
  },
];

// Timing ----------------------------------------------------------------------------------------

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

interface PlanJson {
  'Planning Time': number;
  'Execution Time': number;
  Plan: { 'Shared Read Blocks'?: number };
}

/** What a search ran: each statement's server time and pages read from storage. */
interface Cost {
  serverMs: number;
  read: number;
}

/**
 * The search as `activity.list` runs it: resolve the filters, then the page (or the ingestion
 * check). With `measure`, each statement first runs as EXPLAIN (ANALYZE, BUFFERS), whose time
 * and reads are added up; the resolve statements then run again for their rows.
 */
async function search(tx: Tx, s: Sample, shape: Shape, measure: Cost | null): Promise<number> {
  const spec = shape.run(s)!;
  const run = async <T>(sql: string, params: unknown[], needRows: boolean): Promise<T[]> => {
    if (measure) {
      const [row] = await tx.query<{ 'QUERY PLAN': PlanJson[] }>(
        `explain (analyze, timing off, buffers, format json) ${sql}`,
        params,
      );
      const plan = row!['QUERY PLAN'][0]!;
      measure.serverMs += plan['Planning Time'] + plan['Execution Time'];
      measure.read += plan.Plan['Shared Read Blocks'] ?? 0;
      if (!needRows) return [];
    }
    return tx.query<T>(sql, params);
  };
  if (spec === 'ingestion') return (await run(ingestionQuery, [], true)).length;
  const proxy = {
    ...tx,
    query: <T>(sql: string, params?: unknown[]) => run<T>(sql, params ?? [], true),
  } as Tx;
  const scope = await resolveScope(proxy, spec.scope ?? null);
  const resolved = await resolveActivityFilters(proxy, spec.filters, scope);
  if (!resolved) return 0;
  const { sql, params } = activityQuery({ filters: resolved, scope, limit: 51, cursor: null });
  return (await run(sql, params, !measure)).length;
}

async function neonApi(path: string, method = 'GET') {
  const res = await fetch(
    `https://console.neon.tech/api/v2/projects/${neon!.project}/endpoints/${neon!.endpoint}${path}`,
    { method, headers: { authorization: `Bearer ${neon!.key}`, accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`Neon API ${method} ${path}: ${res.status}`);
  return (await res.json()) as { endpoint: { current_state: string } };
}

/** Suspends the compute, waits for it to stop, and wakes it with a trivial query. */
async function suspend(shopId: string) {
  await db.close().catch(() => {});
  await neonApi('/suspend', 'POST');
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if ((await neonApi('')).endpoint.current_state === 'idle') break;
  }
  db = new PgDatabase(poolSource(appUrl!, 2));
  await ro(shopId, (tx) => tx.query('select 1'));
}

interface Result {
  key: string;
  label: string;
  warmClient: number[];
  warmServer: number[];
  coldClient: number[];
  coldServer: number[];
  coldRead: number[];
  rows: number[];
}
const results: Result[] = [];
const f = (x: number) => (Number.isNaN(x) ? '—' : x < 10 ? x.toFixed(1) : x.toFixed(0));

console.log(
  '| Search | Server p50 ms | Server p95 ms | Client p95 ms | Cold server p95 ms | Cold client p95 ms | Cold pages read, max | Rows |',
);
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const shape of shapes) {
  if (args.only && !args.only.split(',').includes(shape.key)) continue;
  const r: Result = {
    key: shape.key,
    label: shape.label,
    warmClient: [],
    warmServer: [],
    coldClient: [],
    coldServer: [],
    coldRead: [],
    rows: [],
  };
  for (const s of samples) {
    if (shape.run(s) === null) continue;
    if (neon) {
      await suspend(s.id);
      const cost: Cost = { serverMs: 0, read: 0 };
      const t = performance.now();
      await ro(s.id, (tx) => search(tx, s, shape, cost));
      r.coldClient.push(performance.now() - t);
      r.coldServer.push(cost.serverMs);
      r.coldRead.push(cost.read);
    }
    if (args.explain) {
      const spec = shape.run(s)!;
      if (spec !== 'ingestion') {
        const plan = await ro(s.id, async (tx) => {
          const scope = await resolveScope(tx, spec.scope ?? null);
          const resolved = await resolveActivityFilters(tx, spec.filters, scope);
          if (!resolved) return [{ 'QUERY PLAN': '(resolved to nothing: no query)' }];
          const { sql, params } = activityQuery({
            filters: resolved,
            scope,
            limit: 51,
            cursor: null,
          });
          return tx.query<{ 'QUERY PLAN': string }>(`explain (analyze, buffers) ${sql}`, params);
        });
        console.error(
          `\n-- ${shape.key} · ${s.name}\n${plan.map((p) => p['QUERY PLAN']).join('\n')}`,
        );
      }
    }
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      const rows = await ro(s.id, (tx) => search(tx, s, shape, null));
      r.warmClient.push(performance.now() - t);
      if (i === 0) r.rows.push(rows);
      const cost: Cost = { serverMs: 0, read: 0 };
      await ro(s.id, (tx) => search(tx, s, shape, cost));
      r.warmServer.push(cost.serverMs);
    }
  }
  results.push(r);
  console.log(
    `| ${r.label} | ${f(pct(r.warmServer, 50))} | ${f(pct(r.warmServer, 95))} | ${f(pct(r.warmClient, 95))} | ${f(pct(r.coldServer, 95))} | ${f(pct(r.coldClient, 95))} | ${r.coldRead.length ? Math.max(...r.coldRead) : '—'} | ${Math.min(...r.rows)}–${Math.max(...r.rows)} |`,
  );
}

const all = (k: keyof Result) => results.flatMap((r) => r[k] as number[]);
console.log(
  `\nAll searches: warm server p95 ${f(pct(all('warmServer'), 95))} ms, warm client p95 ${f(pct(all('warmClient'), 95))} ms` +
    (neon
      ? `; cold server p95 ${f(pct(all('coldServer'), 95))} ms, cold client p95 ${f(pct(all('coldClient'), 95))} ms, cold client max ${f(Math.max(...all('coldClient')))} ms`
      : ''),
);
if (args.json) await writeFile(args.json, JSON.stringify({ samples, results }, null, 2));
await db.close();
