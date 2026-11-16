/**
 * Activity search timings over the seeded history (Phase 2 plan, milestone I0; Section 8: "activity
 * search over 1 million events with two filters, p95 under 1 s"), on the current schema and
 * indexes.
 *
 *   DATABASE_APP_URL=postgres://airstock_app:…@…/db tsx scripts/bench/query-activity.ts \
 *     --seed seed-personas.json [--n 30] [--explain 4] [--json activity.json]
 *
 * Two groups of shapes, each run --n times, rotating over the shops and over targets, members,
 * and dates drawn from each shop's own history:
 *
 * - `activity.list` as it is today (per-target history, the newest-first timeline with its
 *   cursor, one attempt, and the timeline of a member limited to one warehouse), through the
 *   product's own operation;
 * - the PRD 7.4 filters that milestone I5 adds (actor, action, date, outcome, source and
 *   integration, warehouse, batch, and combinations), as SQL in the shape I5 will need, newest
 *   first, 50 rows.
 *
 * Every query runs as the runtime role in a read-only transaction with the shop set, so row-level
 * security applies as in the product. The time reported is the server's: planning plus execution
 * from EXPLAIN (ANALYZE, TIMING OFF), run right after the query itself; the client round trip is
 * reported beside it. The slowest shapes get a full EXPLAIN (ANALYZE, BUFFERS) at the end.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { type Caller, execute, ops } from '../../packages/core/src/index.ts';
import { PgDatabase, poolSource, type Tx } from '../../packages/db/src/index.ts';

const { values: args } = parseArgs({
  options: {
    n: { type: 'string', default: '30' },
    seed: { type: 'string', default: 'seed-personas.json' },
    explain: { type: 'string', default: '4' },
    json: { type: 'string' },
  },
});
const url = process.env.DATABASE_APP_URL;
if (!url) throw new Error('Set DATABASE_APP_URL (the runtime role).');
const N = Number(args.n);
const db = new PgDatabase(poolSource(url, 2));
const audit = { send: async () => {} };

let seed = 11;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;

// What each shop's history contains, sampled once (not timed) ----------------------------------

interface ShopSample {
  id: string;
  name: string;
  events: number;
  ownerMembership: { id: string; userId: string };
  scoped: { id: string; userId: string; scopeIds: string[] } | null;
  members: string[];
  variants: string[];
  products: string[];
  attempts: string[];
  warehouses: string[];
  grantId: string | null;
  importRef: string | null;
  first: string;
  last: string;
}

const ro = <T>(shopId: string, fn: (tx: Tx) => Promise<T>) =>
  db.transaction({ shopId, userId: null, readOnly: true }, fn);

// The runtime role sees a shop only with its ID set, so the IDs come from seed-personas.ts.
const seedFile = JSON.parse(await readFile(args.seed, 'utf8')) as {
  shops: Array<{ shopId: string }>;
};
const shops: ShopSample[] = [];
for (const { shopId } of seedFile.shops) {
  const sample = await ro(shopId, async (tx) => {
    const [shop] = await tx.query<{ name: string }>(
      'select name from shops where id = app_shop_id()',
    );
    if (!shop) return null;
    const members = await tx.query<{
      id: string;
      user_id: string;
      role: string;
      all_locations: boolean;
    }>(
      'select id, user_id, role, all_locations from memberships where shop_id = app_shop_id() order by created_at, id',
    );
    const scopedRow = members.find((m) => !m.all_locations);
    const scopeIds = scopedRow
      ? (
          await tx.query<{ scope_id: string }>(
            'select scope_id from membership_location_scopes where membership_id = $1',
            [scopedRow.id],
          )
        ).map((r) => r.scope_id)
      : [];
    const [range] = await tx.query<{ n: string; first: Date; last: Date }>(
      'select count(*)::text as n, min(occurred_at) as first, max(occurred_at) as last from audit_events where shop_id = app_shop_id()',
    );
    // Targets with history: variants and products seen in the last days, as people open them.
    const variants = await tx.query<{ target_id: string }>(
      `select target_id from audit_events where shop_id = app_shop_id() and target_type = 'variant'
         and occurred_at > now() - interval '3 days' group by target_id limit 200`,
    );
    const products = await tx.query<{ target_id: string }>(
      `select target_id from audit_events where shop_id = app_shop_id() and target_type = 'product'
         and occurred_at > now() - interval '3 days' group by target_id limit 200`,
    );
    const attempts = await tx.query<{ attempt_id: string }>(
      `select attempt_id from audit_events where shop_id = app_shop_id() and attempt_id is not null
         and occurred_at > now() - interval '20 days' limit 200`,
    );
    const warehouses = await tx.query<{ id: string }>('select id from warehouses');
    const [grant] = await tx.query<{ id: string }>('select id from connection_grants limit 1');
    const [imp] = await tx.query<{ external_ref: string }>(
      `select external_ref from audit_events where shop_id = app_shop_id() and source = 'import'
         and external_ref like 'import %' limit 1`,
    );
    return {
      id: shopId,
      name: shop.name,
      events: Number(range!.n),
      ownerMembership: { id: members[0]!.id, userId: members[0]!.user_id },
      scoped: scopedRow ? { id: scopedRow.id, userId: scopedRow.user_id, scopeIds } : null,
      members: members.map((m) => m.user_id),
      variants: variants.map((v) => v.target_id),
      products: products.map((p) => p.target_id),
      attempts: attempts.map((a) => a.attempt_id),
      warehouses: warehouses.map((w) => w.id),
      grantId: grant?.id ?? null,
      importRef: imp?.external_ref ?? null,
      first: range!.first.toISOString(),
      last: range!.last.toISOString(),
    } satisfies ShopSample;
  });
  if (sample && sample.events > 0) shops.push(sample);
}
if (shops.length === 0) throw new Error('No shops with history. Run seed-history.ts first.');
const totalEvents = shops.reduce((n, s) => n + s.events, 0);
console.log(
  `${shops.length} shops, ${totalEvents.toLocaleString('en')} events: ${shops.map((s) => `${s.name} ${s.events.toLocaleString('en')}`).join(', ')}`,
);

// Shapes ---------------------------------------------------------------------------------------

/** activity.list's own SQL (packages/core/src/operations/activity.ts), for EXPLAIN. */
const LIST_SQL = `select event_id, occurred_at, action, phase, outcome, source, actor_type, actor_id, client_id,
         target_type, target_id, operation_id, attempt_id, external_ref, reason, changes, error
       from audit_events e
       where e.shop_id = app_shop_id()
         and ($1::text is null or e.target_type = $1)
         and ($2::text is null or e.target_id = $2)
         and ($3::uuid is null or e.attempt_id = $3)
         and ($4::timestamptz is null or (e.occurred_at, e.event_id) < ($4::timestamptz, $5::uuid))
         and ($6::uuid[] is null or e.location_ids is null or exists (
           select 1 from locations l where l.id = any(e.location_ids) and l.path_ids && $6::uuid[]))
       order by e.occurred_at desc, e.event_id desc
       limit $7`;

const COLUMNS = `event_id, occurred_at, action, phase, outcome, source, actor_type, actor_id, client_id,
  target_type, target_id, operation_id, attempt_id, external_ref, reason, changes, error`;
/** An I5 filter shape: the conditions, newest first, 50 rows (51 to know about a next page). */
const filtered = (where: string) =>
  `select ${COLUMNS} from audit_events e where e.shop_id = app_shop_id() and ${where}
   order by e.occurred_at desc, e.event_id desc limit 51`;

const WAREHOUSE_JOIN = `exists (select 1 from locations l where l.id = any(e.location_ids) and l.path_ids && $1::uuid[])`;

const daysAgo = (s: ShopSample, from: number) =>
  new Date(Date.parse(s.last) - from * 86_400_000).toISOString();
/** A cursor somewhere in the history, as a later page of the timeline has. */
const cursorAt = (s: ShopSample) => {
  const t = Date.parse(s.first) + rand() * (Date.parse(s.last) - Date.parse(s.first));
  return [new Date(t).toISOString(), '00000000-0000-7000-8000-000000000000'] as const;
};

interface Shape {
  key: string;
  group: 'activity.list' | 'I5 filter';
  label: string;
  /** Through the product's operation (activity.list), or null for SQL only. */
  op?: (s: ShopSample) => { input: Record<string, unknown>; scoped?: boolean };
  sql: string;
  params: (s: ShopSample) => unknown[];
}

const listParams = (p: {
  type?: string;
  id?: string;
  attempt?: string;
  cursor?: readonly [string, string];
  scope?: string[];
}) => [
  p.type ?? null,
  p.id ?? null,
  p.attempt ?? null,
  p.cursor?.[0] ?? null,
  p.cursor?.[1] ?? null,
  p.scope ?? null,
  51,
];

// Each run draws its parameters once and uses them for the operation and its EXPLAIN.
const SHAPES: Array<Shape & { draw: (s: ShopSample) => Record<string, unknown> }> = [
  {
    key: 'timeline',
    group: 'activity.list',
    label: 'Timeline, first page',
    draw: () => ({}),
    sql: LIST_SQL,
    params: () => listParams({}),
  },
  {
    key: 'timeline_cursor',
    group: 'activity.list',
    label: 'Timeline, a later page (cursor anywhere in 3 months)',
    draw: (s) => ({ cursor: cursorAt(s) }),
    sql: LIST_SQL,
    params: () => listParams({ cursor: current.cursor as readonly [string, string] }),
  },
  {
    key: 'target_variant',
    group: 'activity.list',
    label: 'One variant’s history',
    draw: (s) => ({ id: pick(s.variants) }),
    sql: LIST_SQL,
    params: () => listParams({ type: 'variant', id: current.id as string }),
  },
  {
    key: 'target_product',
    group: 'activity.list',
    label: 'One product’s history',
    draw: (s) => ({ id: pick(s.products) }),
    sql: LIST_SQL,
    params: () => listParams({ type: 'product', id: current.id as string }),
  },
  {
    key: 'attempt',
    group: 'activity.list',
    label: 'One attempt',
    draw: (s) => ({ attempt: pick(s.attempts) }),
    sql: LIST_SQL,
    params: () => listParams({ attempt: current.attempt as string }),
  },
  {
    key: 'timeline_scoped',
    group: 'activity.list',
    label: 'Timeline of a member limited to one warehouse',
    draw: () => ({}),
    sql: LIST_SQL,
    params: (s) => listParams({ scope: s.scoped?.scopeIds ?? [s.warehouses[0]!] }),
  },
  {
    key: 'actor',
    group: 'I5 filter',
    label: 'Actor: one member',
    draw: (s) => ({ actor: pick(s.members) }),
    sql: filtered(`e.actor_type = 'user' and e.actor_id = $1`),
    params: () => [current.actor],
  },
  {
    key: 'action',
    group: 'I5 filter',
    label: 'Action: receipts',
    draw: () => ({}),
    sql: filtered(`e.action = 'inventory.receipt.created' and e.phase = 'outcome'`),
    params: () => [],
  },
  {
    key: 'action_prefix',
    group: 'I5 filter',
    label: 'Action group: inventory.*',
    draw: () => ({}),
    sql: filtered(`e.action like 'inventory.%'`),
    params: () => [],
  },
  {
    key: 'date',
    group: 'I5 filter',
    label: 'Date: one week, a month ago',
    draw: () => ({ from: 30 + Math.floor(rand() * 30) }),
    sql: filtered(`e.occurred_at >= $1 and e.occurred_at < $2`),
    params: (s) => [daysAgo(s, current.from as number), daysAgo(s, (current.from as number) - 7)],
  },
  {
    key: 'outcome',
    group: 'I5 filter',
    label: 'Outcome: failed, denied, conflict (under 1%)',
    draw: () => ({}),
    sql: filtered(`e.outcome in ('failed', 'denied', 'conflict', 'unknown')`),
    params: () => [],
  },
  {
    key: 'source',
    group: 'I5 filter',
    label: 'Source: MCP',
    draw: () => ({}),
    sql: filtered(`e.source = 'mcp'`),
    params: () => [],
  },
  {
    key: 'integration',
    group: 'I5 filter',
    label: 'Integration: one ChatGPT connection',
    draw: () => ({}),
    sql: filtered(`e.actor_type = 'connection' and e.actor_id = $1`),
    params: (s) => [s.grantId],
  },
  {
    key: 'warehouse',
    group: 'I5 filter',
    label: 'Warehouse, through the location tree',
    draw: (s) => ({ warehouse: pick(s.warehouses) }),
    sql: filtered(WAREHOUSE_JOIN),
    params: () => [[current.warehouse]],
  },
  {
    key: 'batch',
    group: 'I5 filter',
    label: 'Batch: the catalog import',
    draw: () => ({}),
    sql: filtered(`e.external_ref = $1`),
    params: (s) => [s.importRef],
  },
  {
    key: 'actor_date',
    group: 'I5 filter',
    label: 'Two filters: member and last 7 days',
    draw: (s) => ({ actor: pick(s.members) }),
    sql: filtered(`e.actor_type = 'user' and e.actor_id = $1 and e.occurred_at >= $2`),
    params: (s) => [current.actor, daysAgo(s, 7)],
  },
  {
    key: 'action_warehouse',
    group: 'I5 filter',
    label: 'Two filters: receipts in one warehouse',
    draw: (s) => ({ warehouse: pick(s.warehouses) }),
    sql: filtered(
      `e.action = 'inventory.receipt.created' and e.phase = 'outcome' and ${WAREHOUSE_JOIN}`,
    ),
    params: () => [[current.warehouse]],
  },
  {
    key: 'source_outcome',
    group: 'I5 filter',
    label: 'Two filters: MCP calls that failed or were denied',
    draw: () => ({}),
    sql: filtered(`e.source = 'mcp' and e.outcome in ('failed', 'denied', 'conflict')`),
    params: () => [],
  },
  {
    key: 'action_date',
    group: 'I5 filter',
    label: 'Two filters: reservations in one week, two months ago',
    draw: () => ({ from: 50 + Math.floor(rand() * 20) }),
    sql: filtered(
      `e.action = 'inventory.reservation.created' and e.occurred_at >= $1 and e.occurred_at < $2`,
    ),
    params: (s) => [daysAgo(s, current.from as number), daysAgo(s, (current.from as number) - 7)],
  },
  {
    key: 'three',
    group: 'I5 filter',
    label: 'Three filters: Shopify, reservations, last 30 days',
    draw: () => ({}),
    sql: filtered(
      `e.source = 'shopify' and e.action = 'inventory.reservation.created' and e.occurred_at >= $1`,
    ),
    params: (s) => [daysAgo(s, 30)],
  },
];
let current: Record<string, unknown> = {};

// Runs -----------------------------------------------------------------------------------------

const ownerCaller = (s: ShopSample, scoped: boolean): Caller => {
  const m = scoped && s.scoped ? s.scoped : s.ownerMembership;
  return {
    kind: 'user',
    id: m.userId,
    userId: m.userId,
    boundShopId: null,
    membership: null,
    scopes: 'all',
    source: 'dashboard',
  };
};

interface Sample {
  shop: string;
  serverMs: number;
  planningMs: number;
  clientMs: number;
  rows: number;
  params: unknown[];
}

const pct = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};

// The network round trip, to read the client times against.
const rtt: number[] = [];
for (let i = 0; i < 20; i++) {
  const t = performance.now();
  await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query('select 1'),
  );
  rtt.push(performance.now() - t);
}
console.log(
  `Round trip for a read-only transaction with one statement: p50 ${pct(rtt, 50).toFixed(1)} ms`,
);

const results: Array<{
  key: string;
  group: string;
  label: string;
  samples: Sample[];
  p50: number;
  p95: number;
  max: number;
  clientP50: number;
  clientP95: number;
  rows: number;
}> = [];
for (const shape of SHAPES) {
  const samples: Sample[] = [];
  for (let i = 0; i < N; i++) {
    const s = shops[i % shops.length]!;
    current = shape.draw(s);
    const params = shape.params(s);
    let clientMs: number;
    let rows: number;
    if (shape.group === 'activity.list') {
      // Through the operation: authorization, the query, and the response mapping.
      const input: Record<string, unknown> = { limit: 50 };
      if (params[0]) input.targetType = params[0];
      if (params[1]) input.targetId = params[1];
      if (params[2]) input.attemptId = params[2];
      if (params[3]) input.before = `${params[3]}|${params[4]}`;
      const scoped = shape.key === 'timeline_scoped';
      const caller = ownerCaller(s, scoped);
      const t = performance.now();
      const res = await execute({ db, audit }, ops.listActivity, {
        caller,
        shopId: s.id,
        input,
      });
      clientMs = performance.now() - t;
      rows = (res.result as { events: unknown[] }).events.length;
      if (scoped && !s.scoped) params[5] = [s.warehouses[0]];
    } else {
      const t0 = performance.now();
      const r = await ro(s.id, (tx) => tx.query(shape.sql, params));
      clientMs = performance.now() - t0;
      rows = Math.min(50, r.length);
    }
    const [plan] = await ro(s.id, (tx) =>
      tx.query<{ 'QUERY PLAN': Array<{ 'Execution Time': number; 'Planning Time': number }> }>(
        `explain (analyze, timing off, format json) ${shape.sql}`,
        params,
      ),
    );
    const p = plan!['QUERY PLAN'][0]!;
    samples.push({
      shop: s.name,
      serverMs: p['Execution Time'] + p['Planning Time'],
      planningMs: p['Planning Time'],
      clientMs,
      rows,
      params,
    });
  }
  const server = samples.map((x) => x.serverMs);
  const client = samples.map((x) => x.clientMs);
  const row = {
    key: shape.key,
    group: shape.group,
    label: shape.label,
    samples,
    p50: pct(server, 50),
    p95: pct(server, 95),
    max: Math.max(...server),
    clientP50: pct(client, 50),
    clientP95: pct(client, 95),
    rows: Math.round(samples.reduce((n, x) => n + x.rows, 0) / samples.length),
  };
  results.push(row);
  console.log(
    `${shape.label.padEnd(56)} server p50 ${row.p50.toFixed(1).padStart(7)}  p95 ${row.p95.toFixed(1).padStart(7)}  max ${row.max.toFixed(1).padStart(7)} ms   client p50 ${row.clientP50.toFixed(0).padStart(5)}  p95 ${row.clientP95.toFixed(0).padStart(5)} ms   rows ${row.rows}`,
  );
}

// The slowest shapes, explained in full with the parameters of their slowest run.
const slowest = [...results].sort((a, b) => b.p95 - a.p95).slice(0, Number(args.explain));
const plans: Record<string, string> = {};
for (const r of slowest) {
  const shape = SHAPES.find((s) => s.key === r.key)!;
  const worst = r.samples.reduce((a, b) => (b.serverMs > a.serverMs ? b : a));
  const s = shops.find((x) => x.name === worst.shop)!;
  const rowsOut = await ro(s.id, (tx) =>
    tx.query<{ 'QUERY PLAN': string }>(
      `explain (analyze, buffers, verbose off, costs off) ${shape.sql}`,
      worst.params,
    ),
  );
  plans[r.key] = rowsOut.map((x) => x['QUERY PLAN']).join('\n');
  console.log(`\n=== ${r.label} (${s.name}, p95 ${r.p95.toFixed(0)} ms)\n${plans[r.key]}`);
}

console.log('\n| Shape | Server p50 | Server p95 | Server max | Client p95 | Rows |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  console.log(
    `| ${r.label} | ${r.p50.toFixed(0)} ms | ${r.p95.toFixed(0)} ms | ${r.max.toFixed(0)} ms | ${r.clientP95.toFixed(0)} ms | ${r.rows} |`,
  );
}
await db.close();
if (args.json) {
  await writeFile(
    args.json,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        n: N,
        events: totalEvents,
        rttP50: pct(rtt, 50),
        shops: shops.map((s) => ({ name: s.name, events: s.events })),
        results: results.map(({ samples, ...r }) => ({
          ...r,
          perShop: Object.fromEntries(
            shops.map((s) => [
              s.name,
              pct(
                samples.filter((x) => x.shop === s.name).map((x) => x.serverMs),
                95,
              ),
            ]),
          ),
        })),
        plans,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${args.json}`);
}
