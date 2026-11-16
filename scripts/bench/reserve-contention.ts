/**
 * Reservation contention, locally (plan risk R5, I7): many callers reserving one variant with many
 * lots at once, as on a release day. It makes a fresh database on a local PostgreSQL server, one
 * shop, and a lot-tracked variant with `--lots` lots of 24 units at expiry dates spread over 400
 * days, then times reservations through the product's pipeline (`execute`), one caller and
 * `--workers` callers on that variant.
 *
 * `--rtt` adds that many milliseconds before every statement, standing in for the round trip
 * from the Worker to Neon (Phase 1 report: 4–8 ms), so lock waits weigh as they do in production.
 * Locally the database itself answers in well under a millisecond.
 *
 *   ADMIN_URL=postgres://postgres:postgres@localhost:54329/postgres \
 *     tsx scripts/bench/reserve-contention.ts [--rtt 6] [--workers 10] [--per-worker 10] [--lots 200]
 *
 * The database (`airstock_contention` by default) is dropped and made again on every run.
 */
import { parseArgs } from 'node:util';
import pg from 'pg';
import {
  type AnyOperation,
  type Caller,
  ensureUser,
  execute,
  ops,
  sessionCaller,
  uuidv7,
} from '../../packages/core/src/index.ts';
import { type ConnectionSource, PgDatabase } from '../../packages/db/src/index.ts';
import { bootstrap, migrate } from '../../packages/db/src/migrate.ts';

const { values: args } = parseArgs({
  options: {
    rtt: { type: 'string', default: '6' },
    workers: { type: 'string', default: '10' },
    'per-worker': { type: 'string', default: '10' },
    lots: { type: 'string', default: '200' },
    database: { type: 'string', default: 'airstock_contention' },
  },
});
const RTT = Number(args.rtt);
const WORKERS = Number(args.workers);
const PER = Number(args['per-worker']);
const LOTS = Number(args.lots);
const admin = process.env.ADMIN_URL ?? 'postgres://postgres:postgres@localhost:54329/postgres';

// A fresh database with the roles and migrations, as the tests make theirs.
const ownerUrl = new URL(admin);
ownerUrl.pathname = `/${args.database}`;
const appUrl = new URL(ownerUrl.toString());
appUrl.username = 'airstock_app';
appUrl.password = 'airstock_app';
{
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`drop database if exists ${args.database} with (force)`);
  await client.query(`create database ${args.database}`);
  await client.end();
  await bootstrap(ownerUrl.toString());
  await migrate(ownerUrl.toString());
  const owner = new pg.Client({ connectionString: ownerUrl.toString() });
  await owner.connect();
  await owner.query(`alter role airstock_app password 'airstock_app'`);
  await owner.end();
}

/** Pooled connections whose every query waits `delay` ms first: the simulated round trip. */
function delayedSource(url: string, max: number, delay: number): ConnectionSource {
  const pool = new pg.Pool({ connectionString: url, max });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    async acquire() {
      const client = await pool.connect();
      const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      const wrapped = Object.create(client) as pg.PoolClient;
      (wrapped as unknown as { query: unknown }).query = async (...a: unknown[]) => {
        if (delay > 0) await sleep(delay);
        return query(...a);
      };
      return { client: wrapped, release: (broken) => client.release(broken) };
    },
    close: () => pool.end(),
  };
}

let statements: number[] = [];
const setupDb = new PgDatabase(delayedSource(appUrl.toString(), WORKERS + 2, 0));
const timedDb = new PgDatabase(delayedSource(appUrl.toString(), WORKERS + 2, RTT), {
  onTransactionEnd: (s) => statements.push(s.statements),
});
const audit = { send: async () => {} };

const userId = await ensureUser(setupDb, {
  providerUserId: `bench_${uuidv7()}`,
  email: `${uuidv7()}@example.test`,
});
const caller: Caller = sessionCaller(userId);
const run = async (db: PgDatabase, op: AnyOperation, shopId: string | null, input: unknown) =>
  (
    await execute({ db, audit }, op, {
      caller,
      shopId,
      input,
      idempotencyKey: op.idempotency === 'required' ? uuidv7() : null,
    })
  ).result as Record<string, unknown>;

const shop = await run(setupDb, ops.createShop, null, {
  name: 'Contention',
  currency: 'EUR',
  timezone: 'Europe/Berlin',
});
const shopId = shop.shopId as string;
const item = await run(setupDb, ops.createItem, shopId, { name: 'Booster box', sku: 'BOX-1' });
const variantId = item.variantId as string;
await run(setupDb, ops.setStockSettings, shopId, { variantId, trackingMode: 'lot_expiry' });
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
for (let i = 0; i < LOTS; i++) {
  await run(setupDb, ops.receiveStock, shopId, {
    variantId,
    locationId: shop.defaultLocationId,
    quantity: '24',
    lotCode: `LOT-${i}`,
    expiresOn: day(40 + ((i * 37) % 400)),
  });
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? Number.NaN;
};

async function phase(label: string, callers: number, count: number, quantity: string) {
  statements = [];
  const times: number[] = [];
  const made: string[] = [];
  let next = 0;
  let failed = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: callers }, async () => {
      while (next < count) {
        next++;
        const t = performance.now();
        try {
          const r = await run(timedDb, ops.reserveStock, shopId, {
            variantId,
            quantity,
            purpose: 'external_order',
          });
          made.push(r.reservationId as string);
          times.push(performance.now() - t);
        } catch {
          failed++;
        }
      }
    }),
  );
  const wall = performance.now() - t0;
  console.log(
    // A session caller's membership lookup is a transaction of its own (3 statements).
    `${label.padEnd(30)} x${callers} n=${count}${failed ? ` FAILED ${failed}` : ''}  statements ${pct(
      statements.filter((n) => n > 3),
      50,
    )}  p50 ${pct(times, 50).toFixed(0)} ms  p95 ${pct(times, 95).toFixed(0)} ms  max ${Math.max(...times).toFixed(0)} ms  ${(count / (wall / 1000)).toFixed(1)}/s`,
  );
  // Released again (not timed), so every phase starts from the same lots.
  for (const id of made) await run(setupDb, ops.releaseReservation, shopId, { reservationId: id });
}

console.log(`${LOTS} lots of 24 units; ${RTT} ms added per statement`);
await phase('reserve 1 unit', 1, 30, '1');
await phase('reserve 1 unit', WORKERS, WORKERS * PER, '1');
await phase('reserve 12 units (1–2 lots)', WORKERS, WORKERS * PER, '12');
// Every invariant still holds after the races (A21).
const check = await setupDb.transaction({ shopId, userId: null, readOnly: true }, (tx) =>
  tx.query<{ problem: string }>('select problem from stock_reconciliation_problems()'),
);
console.log(`reconciliation: ${check.length === 0 ? 'no problems' : JSON.stringify(check)}`);
await setupDb.close();
await timedDb.close();
