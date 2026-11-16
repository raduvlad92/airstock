/**
 * Times activity searches (plan Section 8: p95 under 1 s with two filters over 1 million events).
 * Runs the same SQL as `activity.list` (packages/core/src/activity/query.ts) as the app role,
 * inside the shop's tenant context, so row-level security applies as in production.
 *
 *   DATABASE_URL=postgres://airstock_app:…@host/db SHOP_ID=<uuid> tsx scripts/activity-bench.ts
 *
 * Optional: RUNS (default 20), EXPLAIN=1 to print each plan once. The filter values are read from
 * the shop's own history, so the script works on any seed.
 */
import { type ActivityFiltersInput, activityQuery } from '../packages/core/src/activity/query.ts';
import { PgDatabase, poolSource } from '../packages/db/src/index.ts';

const url = process.env.DATABASE_URL;
const shopId = process.env.SHOP_ID;
if (!url || !shopId) {
  console.error('Set DATABASE_URL (app role) and SHOP_ID.');
  process.exit(1);
}
const runs = Number(process.env.RUNS ?? 20);
const db = new PgDatabase(poolSource(url, 2));
const ctx = { shopId, userId: null, readOnly: true };

async function one<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await db.transaction(ctx, (tx) => tx.query<T>(sql, params));
  return rows[0];
}

// Realistic values from the shop's own history.
const sample = async (column: string, where = 'true') =>
  (
    await one<{ v: string }>(
      `select ${column}::text as v from audit_events where shop_id = app_shop_id() and ${where}
       and ${column} is not null group by 1 order by count(*) desc limit 1`,
    )
  )?.v;

const user = await sample('actor_id', "actor_type = 'user'");
const connection =
  (await sample('actor_id', "actor_type in ('connection', 'api_credential') and actor_id ~ '^[0-9a-f-]{36}$'")) ??
  (await sample('client_id', "actor_type in ('connection', 'connector')"));
const location = await sample('location_ids[1]', 'cardinality(location_ids) > 0');
const warehouse = location
  ? (await one<{ v: string }>('select path_ids[1]::text as v from locations where id = $1', [location]))?.v
  : undefined;
const target = await one<{ t: string; i: string }>(
  `select target_type as t, target_id as i from audit_events
   where shop_id = app_shop_id() and target_type = 'variant' limit 1`,
);
const attempt = await sample('attempt_id', "phase = 'attempt'");
// The least frequent actor and action with at least 10 events: worst cases for a search.
const rare = async (column: string) =>
  (
    await one<{ v: string }>(
      `select ${column} as v from audit_events where shop_id = app_shop_id() and ${column} is not null
       group by 1 having count(*) >= 10 order by count(*) limit 1`,
    )
  )?.v;
const rareActor = await rare('actor_id');
const rareAction = await rare('action');
const day = 24 * 60 * 60 * 1000;
const since = (days: number) => new Date(Date.now() - days * day).toISOString();

const cases: Array<[string, ActivityFiltersInput, string[] | null]> = [
  ['no filter (first page)', {}, null],
  ['actor + last 30 days', { actorId: user, from: since(30) }, null],
  ['action inventory.* + outcome failed', { action: 'inventory.*', outcome: 'failed' }, null],
  ['warehouse + last 7 days', { locationId: warehouse, from: since(7) }, null],
  ['location + outcome succeeded', { locationId: location, outcome: 'succeeded' }, null],
  ['source mcp + outcome denied', { source: 'mcp', outcome: 'denied' }, null],
  ['target + phase outcome', { targetType: target?.t, targetId: target?.i, phase: 'outcome' }, null],
  ['integration + action catalog.*', { integration: connection, action: 'catalog.*' }, null],
  ['outcome failed + last 7 days', { outcome: 'failed', from: since(7) }, null],
  [
    'action exact + actor',
    { action: 'catalog.item.updated', actorId: user },
    null,
  ],
  ['batch (attempt ID)', { attemptId: attempt }, null],
  ['scoped reader: inventory.* + last 30 days', { action: 'inventory.*', from: since(30) }, warehouse ? [warehouse] : null],
  ['rare: actor + outcome conflict', { actorId: user, outcome: 'conflict' }, null],
  ['rare actor + last 90 days', { actorId: rareActor ?? user, from: since(90) }, null],
  ['rare action + last 90 days', { action: rareAction ?? 'member.invited', from: since(90) }, null],
  ['rare prefix webhook.subscription.* + outcome succeeded', { action: 'webhook.subscription.*', outcome: 'succeeded' }, null],
];

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

console.log(`shop ${shopId}, ${runs} runs each, page of 50`);
console.log('| Search | Rows | Median ms | p95 ms |');
console.log('| --- | --- | --- | --- |');
for (const [name, filters, scope] of cases) {
  const { sql, params } = activityQuery({ filters, scope, limit: 51, cursor: null });
  if (process.env.EXPLAIN) {
    const plan = await db.transaction(ctx, (tx) =>
      tx.query<{ 'QUERY PLAN': string }>(`explain (analyze, buffers) ${sql}`, params),
    );
    console.error(`\n-- ${name}\n${plan.map((p) => p['QUERY PLAN']).join('\n')}`);
  }
  const times: number[] = [];
  let rows = 0;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    rows = (await db.transaction(ctx, (tx) => tx.query(sql, params))).length;
    times.push(performance.now() - t);
  }
  console.log(`| ${name} | ${rows} | ${pct(times, 50).toFixed(1)} | ${pct(times, 95).toFixed(1)} |`);
}
await db.close();
