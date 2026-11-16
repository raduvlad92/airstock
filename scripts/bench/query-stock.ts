/**
 * Stock command and read timings on the persona shops (plan Section 8, milestone I7):
 *
 * - the six stock commands (receive, reserve, fulfill, transfer dispatch, transfer receipt, count
 *   submit), each with `--workers` concurrent callers in one shop at a time;
 * - a reservation with earliest-expiry allocation for a variant with 200 lots, alone and with
 *   concurrent callers on the same variant (plan risk R5);
 * - availability for one variant across the shop (`inventory.availability.get`);
 * - the inventory list: `reports.run` stock on hand by position (variant, location, condition, and
 *   lot), 50 rows;
 * - SQL statements per command, from the database layer's own count.
 *
 * Everything runs through the product's pipeline (`execute`) in process, as the runtime role with
 * row-level security, so the client time includes one round trip per statement from wherever this
 * runs. Two figures stand in for the server's time:
 *
 * - **database time:** `pg_stat_statements` (reset before each timed phase), its execution time
 *   summed over the phase's statements and divided by the commands; planning is not tracked;
 * - **server estimate per command:** client time less the statements times the measured round trip
 *   (p50 and p95 per phase). In the Worker each statement costs about 6 ms instead (Phase 1 report,
 *   Section 4), so the Worker estimate is the database time plus statements × 6 ms.
 *
 *   DATABASE_OWNER_URL=… DATABASE_APP_URL=… tsx scripts/bench/query-stock.ts \
 *     [--workers 10] [--per-worker 10] [--names 'Bench %'] [--json stock.json] \
 *     [--phases commands,list,r5]
 *
 * Run it on the bench branch after seed-stock-activity.ts, never on staging. It writes: the
 * commands' own receipts, reservations, transfers, and counts, and the 200 lots (about 5 MB).
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { type Caller, execute, ops } from '../../packages/core/src/index.ts';
import type { AnyOperation } from '../../packages/core/src/registry.ts';
import { PgDatabase, poolSource } from '../../packages/db/src/index.ts';

const { values: args } = parseArgs({
  options: {
    workers: { type: 'string', default: '10' },
    'per-worker': { type: 'string', default: '10' },
    names: { type: 'string', default: 'Bench %' },
    only: { type: 'string', multiple: true, default: [] },
    'skip-shops': { type: 'boolean', default: false },
    json: { type: 'string' },
    // Which parts to run: commands (the six commands and availability), list, r5 (200 lots).
    phases: { type: 'string', default: 'commands,list,r5' },
  },
});
const want = (part: string) => args.phases.split(',').includes(part);
const ownerUrl = process.env.DATABASE_OWNER_URL;
const appUrl = process.env.DATABASE_APP_URL;
if (!ownerUrl || !appUrl) throw new Error('Set DATABASE_OWNER_URL and DATABASE_APP_URL.');
const WORKERS = Number(args.workers);
const PER = Number(args['per-worker']);
const WORKER_MS_PER_STATEMENT = 6;

const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
const oq = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await owner.query<T>(sql, params)).rows;

// Workers: one connection each, so statements are counted per command.
class Worker {
  statements = 0;
  db: PgDatabase;
  constructor() {
    this.db = new PgDatabase(poolSource(appUrl!, 1), {
      onTransactionEnd: (s) => {
        this.statements += s.statements;
      },
    });
  }
}
const workers = Array.from({ length: WORKERS }, () => new Worker());
const audit = { send: async () => {} };
let lastError = '';
const logger = {
  error: (_m: string, data?: Record<string, unknown>) => {
    lastError = String(data?.error ?? '');
  },
};

const pct = (xs: number[], p: number) => {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const r1 = (x: number) => Math.round(x * 10) / 10;

// The round trip, per worker connection: BEGIN with the context, select 1, COMMIT.
async function roundTrip(): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < 10; i++)
    for (const w of workers) {
      const t = performance.now();
      await w.db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
        tx.query('select 1'),
      );
      xs.push((performance.now() - t) / 3);
    }
  return pct(xs, 50);
}

interface Shop {
  id: string;
  name: string;
  caller: Caller;
}
async function shops(): Promise<Shop[]> {
  const rows = await oq<{ id: string; name: string; mid: string; uid: string }>(
    `select s.id, s.name, m.id as mid, m.user_id as uid from shops s
     join lateral (select id, user_id from memberships m where m.shop_id = s.id and m.role = 'owner'
       order by m.created_at limit 1) m on true
     where s.name like $1 order by s.name`,
    [args.names],
  );
  return rows
    .filter((r) => args.only.length === 0 || args.only.some((o) => r.name.includes(o)))
    .map((r) => ({
      id: r.id,
      name: r.name,
      caller: {
        kind: 'api_credential',
        id: 'bench-i7',
        userId: r.uid,
        boundShopId: r.id,
        membership: { id: r.mid, role: 'owner', allLocations: true, locationScopeIds: [] },
        scopes: 'all',
        source: 'api',
      } as Caller,
    }));
}

interface Run {
  ms: number;
  statements: number;
  ok: boolean;
  result?: unknown;
}
async function call(w: Worker, shop: Shop, op: AnyOperation, input: unknown): Promise<Run> {
  const before = w.statements;
  const t = performance.now();
  try {
    const res = await execute({ db: w.db, audit, logger }, op, {
      caller: shop.caller,
      shopId: shop.id,
      input,
      idempotencyKey: op.kind === 'command' ? randomUUID() : null,
    });
    return {
      ms: performance.now() - t,
      statements: w.statements - before,
      ok: true,
      result: res.result,
    };
  } catch (error) {
    const key = `${(error as Error).message} ${lastError}`.trim().slice(0, 160);
    failures[key] = (failures[key] ?? 0) + 1;
    return { ms: performance.now() - t, statements: w.statements - before, ok: false };
  }
}
let failures: Record<string, number> = {};

/** Runs the jobs on `n` workers at once, each taking the next job. */
async function concurrently<J>(
  jobs: J[],
  n: number,
  fn: (w: Worker, job: J) => Promise<Run>,
): Promise<Run[]> {
  const out: Run[] = [];
  let next = 0;
  await Promise.all(
    workers.slice(0, n).map(async (w) => {
      while (next < jobs.length) {
        const job = jobs[next++]!;
        out.push(await fn(w, job));
      }
    }),
  );
  return out;
}

// pg_stat_statements: execution time of the runtime role's statements in a phase.
const appRole = (
  await oq<{ oid: number }>(`select oid from pg_roles where rolname = 'airstock_app'`)
)[0]!.oid;
async function resetStats() {
  await oq('select pg_stat_statements_reset()');
}
async function dbStats() {
  const rows = await oq<{ calls: string; total: number; query: string; mean: number; max: number }>(
    `select calls::text, total_exec_time as total, mean_exec_time as mean, max_exec_time as max,
       left(regexp_replace(query, '\\s+', ' ', 'g'), 140) as query
     from pg_stat_statements where userid = $1 order by total_exec_time desc`,
    [appRole],
  );
  return {
    totalMs: rows.reduce((s, r) => s + r.total, 0),
    calls: rows.reduce((s, r) => s + Number(r.calls), 0),
    top: rows.slice(0, 6).map((r) => ({
      calls: Number(r.calls),
      totalMs: r1(r.total),
      meanMs: Math.round(r.mean * 100) / 100,
      maxMs: r1(r.max),
      query: r.query,
    })),
  };
}

const results: Array<Record<string, unknown>> = [];
let rtt = 0;
async function phase<J>(
  label: string,
  shop: Shop,
  jobs: J[],
  n: number,
  op: AnyOperation,
  input: (job: J) => unknown,
): Promise<Run[]> {
  failures = {};
  await resetStats();
  const t0 = performance.now();
  const runs = await concurrently(jobs, n, (w, job) => call(w, shop, op, input(job)));
  const wall = performance.now() - t0;
  const stats = await dbStats();
  const ok = runs.filter((r) => r.ok);
  const client = ok.map((r) => r.ms);
  const server = ok.map((r) => Math.max(0, r.ms - r.statements * rtt));
  const statements = pct(
    ok.map((r) => r.statements),
    50,
  );
  const dbPerCommand = ok.length ? stats.totalMs / runs.length : Number.NaN;
  const row = {
    label,
    shop: shop.name,
    callers: n,
    commands: runs.length,
    failed: runs.length - ok.length,
    failures,
    statements,
    clientP50: r1(pct(client, 50)),
    clientP95: r1(pct(client, 95)),
    serverP50: r1(pct(server, 50)),
    serverP95: r1(pct(server, 95)),
    dbMsPerCommand: r1(dbPerCommand),
    workerEstimateMs: r1(dbPerCommand + statements * WORKER_MS_PER_STATEMENT),
    throughputPerS: r1(runs.length / (wall / 1000)),
    dbTop: stats.top,
  };
  results.push(row);
  console.log(
    `${label.padEnd(34)} ${shop.name.padEnd(24)} x${n} n=${runs.length}${row.failed ? ` FAILED ${row.failed} ${JSON.stringify(failures)}` : ''}  stmts ${statements}  client p50 ${row.clientP50} p95 ${row.clientP95}  server≈ p50 ${row.serverP50} p95 ${row.serverP95}  db/cmd ${row.dbMsPerCommand}  worker≈ ${row.workerEstimateMs} ms`,
  );
  return runs;
}

const shuffle = <T>(xs: T[]) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
};
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// ------------------------------------------------------------------------------------------------

rtt = await roundTrip();
console.log(`Round trip per statement: p50 ${rtt.toFixed(1)} ms; ${WORKERS} callers`);
const neonBefore = await neonUsage();
const N = WORKERS * PER;

// The inventory list: stock on hand by position (variant, location, condition, lot), 50 rows.
async function inventoryList(shop: Shop) {
  await phase(
    'inventory list, 50 rows',
    shop,
    Array.from({ length: 10 }),
    1,
    ops.runStandardReport,
    () => ({
      report: 'stock_on_hand',
      limit: 50,
    }),
  );
  await phase(
    'inventory list, 50 rows',
    shop,
    Array.from({ length: 30 }),
    WORKERS,
    ops.runStandardReport,
    () => ({
      report: 'stock_on_hand',
      limit: 50,
    }),
  );
}

for (const shop of args['skip-shops'] ? [] : await shops()) {
  if (!want('commands')) {
    if (want('list')) await inventoryList(shop);
    continue;
  }
  // Leaf storage locations that are fulfillment-eligible, with their warehouse.
  const leaves = await oq<{ id: string; warehouse_id: string }>(
    `select l.id, l.warehouse_id from locations l
     where l.shop_id = $1 and l.kind = 'storage' and l.status = 'active'
       and location_fulfillment_eligible(l.shop_id, l.path_ids)
       and not exists (select 1 from locations c where c.shop_id = l.shop_id and c.parent_id = l.id)`,
    [shop.id],
  );
  const leafSet = new Set(leaves.map((l) => l.id));
  // Variants with free sellable stock at a leaf location, by tracking mode.
  const stocked = await oq<{
    variant_id: string;
    location_id: string;
    tracking_mode: string;
    free: number;
    lot_code: string | null;
    on_hand: number;
    position_id: string;
  }>(
    `select p.variant_id, p.location_id, v.tracking_mode, (p.on_hand - p.allocated)::float8 as free,
       lt.code as lot_code, p.on_hand::float8 as on_hand, p.id as position_id
     from inventory_positions p
     join variants v on v.shop_id = p.shop_id and v.id = p.variant_id
     left join lots lt on lt.shop_id = p.shop_id and lt.id = p.lot_id
     where p.shop_id = $1 and p.condition = 'sellable' and p.transfer_id is null
       and p.on_hand - p.allocated >= 2 and not v.one_of_a_kind
       and (lt.expires_on is null or lt.expires_on > current_date + 60)`,
    [shop.id],
  );
  const usable = stocked.filter((s) => leafSet.has(s.location_id));
  if (usable.length < 20) {
    console.log(`${shop.name}: too few stocked positions (${usable.length}); skipped`);
    continue;
  }

  // Receive: 10 callers, each a delivery of one variant to a shelf it is already on.
  const receiveJobs = shuffle([...usable]).slice(0, N);
  await phase('receive', shop, receiveJobs, WORKERS, ops.receiveStock, (s) => {
    const base = {
      variantId: s.variant_id,
      locationId: s.location_id,
      unitCost: '4.20',
      reference: 'I7 bench delivery',
    };
    if (s.tracking_mode === 'serial')
      return { ...base, quantity: '1', serials: [`I7-${randomUUID().slice(0, 12)}`] };
    if (s.tracking_mode === 'lot_expiry')
      return {
        ...base,
        quantity: '12',
        lotCode: `I7-${randomUUID().slice(0, 8)}`,
        expiresOn: day(300),
      };
    return { ...base, quantity: '6' };
  });

  // Reserve: 10 callers, one unit each of a stocked variant (allocation rule picks the position).
  const variants = shuffle([...new Set(usable.map((s) => s.variant_id))]).slice(0, N);
  const reserved = await phase('reserve', shop, variants, WORKERS, ops.reserveStock, (v) => ({
    variantId: v,
    quantity: '1',
    purpose: 'external_order',
    externalRef: `I7-${randomUUID().slice(0, 8)}`,
  }));
  const reservationIds = reserved
    .filter((r) => r.ok)
    .map((r) => (r.result as { reservationId: string }).reservationId);

  // Fulfill those reservations.
  await phase('fulfill', shop, reservationIds, WORKERS, ops.fulfillReservation, (id) => ({
    reservationId: id,
    reference: 'I7 shipment',
  }));

  // Transfers: created ready (not timed), then dispatched and received (timed).
  const bySource = new Map<string, typeof usable>();
  for (const s of usable.filter((x) => x.tracking_mode !== 'serial')) {
    const list = bySource.get(s.location_id) ?? [];
    list.push(s);
    bySource.set(s.location_id, list);
  }
  const sources = [...bySource.entries()].filter(([, l]) => l.length >= 2);
  const transferJobs: Array<{
    from: string;
    to: string;
    lines: Array<{ variantId: string; quantity: string; lotCode?: string }>;
  }> = [];
  for (let i = 0; i < N && sources.length; i++) {
    const [from, list] = sources[i % sources.length]!;
    const src = leaves.find((l) => l.id === from)!;
    const others = leaves.filter((l) => l.warehouse_id !== src.warehouse_id);
    const dest = pick(others.length ? others : leaves.filter((l) => l.id !== from));
    const seen = new Set<string>();
    const lines = shuffle([...list])
      .filter((s) => !seen.has(s.variant_id) && seen.add(s.variant_id))
      .slice(0, 3)
      .map((s) => ({
        variantId: s.variant_id,
        quantity: '1',
        ...(s.lot_code ? { lotCode: s.lot_code } : {}),
      }));
    transferJobs.push({ from, to: dest.id, lines });
  }
  failures = {};
  const created = await concurrently(transferJobs, WORKERS, (w, j) =>
    call(w, shop, ops.createTransfer, {
      fromLocationId: j.from,
      toLocationId: j.to,
      lines: j.lines,
      reference: 'I7 bench',
      ready: true,
    }),
  );
  const transferIds = created
    .filter((r) => r.ok)
    .map((r) => (r.result as { transfer: { transferId: string } }).transfer.transferId);
  if (Object.keys(failures).length)
    console.log(`  transfer setup failures: ${JSON.stringify(failures)}`);
  await phase('transfer dispatch', shop, transferIds, WORKERS, ops.dispatchTransfer, (id) => ({
    transferId: id,
  }));
  await phase('transfer receipt', shop, transferIds, WORKERS, ops.receiveTransfer, (id) => ({
    transferId: id,
  }));

  // Counts: started and recorded (not timed) for a few positions on one shelf, then submitted.
  const byShelf = new Map<string, typeof usable>();
  for (const s of usable.filter((x) => x.tracking_mode !== 'serial')) {
    const list = byShelf.get(s.location_id) ?? [];
    list.push(s);
    byShelf.set(s.location_id, list);
  }
  const shelves = shuffle([...byShelf.entries()]).slice(0, N);
  failures = {};
  const sessions = await concurrently(shelves, WORKERS, async (w, [loc, list]) => {
    const positions = list.slice(0, 6);
    const started = await call(w, shop, ops.startCount, {
      positionIds: positions.map((p) => p.position_id),
      name: 'I7 bench count',
    });
    if (!started.ok) return started;
    const sessionId = (started.result as { sessionId: string }).sessionId;
    const recorded = await call(w, shop, ops.recordCount, {
      sessionId,
      counts: positions.map((p, i) => ({
        variantId: p.variant_id,
        locationId: loc,
        counted: String(i === 0 ? p.on_hand - 1 : p.on_hand),
        ...(p.lot_code ? { lotCode: p.lot_code } : {}),
      })),
    });
    return { ...recorded, result: { sessionId } };
  });
  if (Object.keys(failures).length)
    console.log(`  count setup failures: ${JSON.stringify(failures)}`);
  const sessionIds = sessions
    .filter((r) => r.ok)
    .map((r) => (r.result as { sessionId: string }).sessionId);
  await phase('count submit', shop, sessionIds, WORKERS, ops.submitCount, (id) => ({
    sessionId: id,
  }));

  // Availability: one variant across the shop, the busiest positions first.
  const busiest = await oq<{ variant_id: string; n: number }>(
    `select variant_id, count(*)::int as n from inventory_positions
     where shop_id = $1 and on_hand > 0 group by variant_id order by n desc limit 5`,
    [shop.id],
  );
  const availJobs = [
    ...Array.from({ length: 15 }, (_, i) => busiest[i % busiest.length]!.variant_id),
    ...shuffle([...variants]).slice(0, 15),
  ];
  await phase('availability, one variant', shop, availJobs, 1, ops.getAvailability, (v) => ({
    variantId: v,
  }));
  await phase(
    'availability, one variant',
    shop,
    [...availJobs, ...availJobs],
    WORKERS,
    ops.getAvailability,
    (v) => ({
      variantId: v,
    }),
  );

  if (want('list')) await inventoryList(shop);
}

// A reservation with earliest-expiry allocation on a variant with 200 lots (plan R5).
const [food] = (await shops()).filter((s) => s.name === 'Bench Fuel Kitchen');
if (food && want('r5')) {
  const [v] = await oq<{ id: string; location_id: string; lots: number }>(
    `select p.variant_id as id, min(p.location_id::text)::uuid as location_id, count(distinct p.lot_id)::int as lots
     from inventory_positions p join locations l on l.shop_id = p.shop_id and l.id = p.location_id
     where p.shop_id = $1 and p.condition = 'sellable' and p.lot_id is not null and l.kind = 'storage'
       and not exists (select 1 from locations c where c.shop_id = l.shop_id and c.parent_id = l.id)
     group by p.variant_id order by lots desc limit 1`,
    [food.id],
  );
  if (v) {
    const leaves = await oq<{ id: string }>(
      `select l.id from locations l where l.shop_id = $1 and l.kind = 'storage' and l.status = 'active'
         and location_fulfillment_eligible(l.shop_id, l.path_ids)
         and not exists (select 1 from locations c where c.shop_id = l.shop_id and c.parent_id = l.id)
       order by l.path limit 20`,
      [food.id],
    );
    // Lots with sellable stock now (older lots may be empty or past their sell-by date).
    const have = (
      await oq<{ n: number }>(
        `select count(distinct p.lot_id)::int as n from inventory_positions p
         join lots lt on lt.shop_id = p.shop_id and lt.id = p.lot_id
         where p.shop_id = $1 and p.variant_id = $2 and p.on_hand > 0 and p.condition = 'sellable'
           and lt.expires_on > current_date + 30`,
        [food.id, v.id],
      )
    )[0]!.n;
    const needed = Math.max(0, 200 - have);
    failures = {};
    await concurrently(
      Array.from({ length: needed }, (_, i) => i),
      WORKERS,
      (w, i) =>
        call(w, food, ops.receiveStock, {
          variantId: v.id,
          locationId: leaves[i % leaves.length]!.id,
          quantity: '24',
          lotCode: `I7-200-${randomUUID().slice(0, 6)}`,
          // Spread over the next 400 days, so earliest expiry first has to sort them all.
          expiresOn: day(40 + ((i * 37) % 400)),
          unitCost: '2.10',
        }),
    );
    const lots = (
      await oq<{ n: number; positions: number }>(
        `select count(distinct lot_id)::int as n, count(*)::int as positions from inventory_positions
         where shop_id = $1 and variant_id = $2 and on_hand > 0`,
        [food.id, v.id],
      )
    )[0]!;
    console.log(`200-lot variant: ${lots.n} lots with stock in ${lots.positions} positions`);
    const one = { variantId: v.id, purpose: 'external_order' };
    // Alone: each reservation is released again (not timed), so every run sees the same lots.
    for (const [label, qty, n] of [
      ['reserve, 200 lots, 1 unit', '1', 1],
      ['reserve, 200 lots, 30 units (several lots)', '30', 1],
      ['reserve, 200 lots, 1 unit', '1', WORKERS],
      ['reserve, 200 lots, 12 units (one or two lots)', '12', WORKERS],
    ] as const) {
      const runs = await phase(
        label,
        food,
        Array.from({ length: n === 1 ? 30 : N }),
        n,
        ops.reserveStock,
        () => ({
          ...one,
          quantity: qty,
          externalRef: `I7-R5-${randomUUID().slice(0, 8)}`,
        }),
      );
      await concurrently(
        runs.filter((r) => r.ok).map((r) => (r.result as { reservationId: string }).reservationId),
        WORKERS,
        (w, id) => call(w, food, ops.releaseReservation, { reservationId: id }),
      );
    }
    await phase(
      'availability, 200-lot variant',
      food,
      Array.from({ length: 30 }),
      1,
      ops.getAvailability,
      () => ({
        variantId: v.id,
      }),
    );
    await phase(
      'lots list, 200-lot variant',
      food,
      Array.from({ length: 30 }),
      1,
      ops.listLots,
      () => ({
        variantId: v.id,
      }),
    );
  }
}

const neonAfter = await neonUsage();
await owner.end();
for (const w of workers) await w.db.close();
const report = {
  at: new Date().toISOString(),
  roundTripMs: rtt,
  workers: WORKERS,
  perWorker: PER,
  neon: { before: neonBefore, after: neonAfter },
  results,
};
if (args.json) await writeFile(args.json, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.neon));

function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!;
}

/** Neon's compute counters for the project, when NEON_API_KEY and NEON_PROJECT_ID are set. */
async function neonUsage() {
  if (!process.env.NEON_API_KEY || !process.env.NEON_PROJECT_ID) return null;
  const res = await fetch(
    `https://console.neon.tech/api/v2/projects/${process.env.NEON_PROJECT_ID}`,
    {
      headers: { authorization: `Bearer ${process.env.NEON_API_KEY}`, accept: 'application/json' },
    },
  );
  const p = ((await res.json()) as { project: Record<string, unknown> }).project;
  return {
    computeTimeSeconds: p.compute_time_seconds,
    activeTimeSeconds: p.active_time_seconds,
    cpuUsedSec: p.cpu_used_sec,
  };
}
