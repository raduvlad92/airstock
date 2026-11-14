/**
 * Bytes per audit event, including indexes (plan Section 10). Creates a scratch database on a
 * PostgreSQL 17 server, applies the migrations, ingests synthetic events through the same
 * function the queue consumer uses, and reports table, index, and TOAST size per event.
 *
 *   tsx scripts/bench/audit-bytes.ts [--admin postgres://postgres:postgres@localhost:54329/postgres]
 *     [--events 100000] [--keep]
 *
 * The mix follows a read-heavy shop: 60% read access events, 20% command attempts, 20% command
 * outcomes with changes, shaped like the events staging records.
 */
import { parseArgs } from 'node:util';
import { auditEvent, type Caller, uuidv7 } from '@airstock/core';
import { bootstrap, migrate } from '@airstock/db/migrate';
import pg from 'pg';

const { values: args } = parseArgs({
  options: {
    admin: { type: 'string', default: 'postgres://postgres:postgres@localhost:54329/postgres' },
    events: { type: 'string', default: '100000' },
    keep: { type: 'boolean', default: false },
  },
});
const total = Number(args.events);
const dbName = 'airstock_audit_bytes';

const admin = new pg.Client({ connectionString: args.admin });
await admin.connect();
await admin.query(`drop database if exists ${dbName} with (force)`);
await admin.query(`create database ${dbName}`);
const url = new URL(args.admin);
url.pathname = `/${dbName}`;
await bootstrap(url.toString());
await migrate(url.toString());

const db = new pg.Client({ connectionString: url.toString() });
await db.connect();

const shops = Array.from({ length: 50 }, () => uuidv7());
const variants = Array.from({ length: 500 }, () => uuidv7());
const locations = Array.from({ length: 20 }, () => uuidv7());
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)]!;

function caller(shopId: string): Caller {
  return {
    kind: Math.random() < 0.3 ? 'connection' : 'user',
    id: uuidv7(),
    userId: uuidv7(),
    boundShopId: shopId,
    membership: null,
    scopes: 'all',
    source: Math.random() < 0.3 ? 'mcp' : 'dashboard',
    ...(Math.random() < 0.3
      ? { clientId: 'https://chatgpt.com/oauth/client.json', grantId: uuidv7() }
      : {}),
  };
}

function event(kind: 'read' | 'attempt' | 'outcome') {
  const shopId = pick(shops);
  const base = {
    shopId,
    caller: caller(shopId),
    requestId: uuidv7(),
    attemptId: kind === 'read' ? null : uuidv7(),
    idempotencyKey: kind === 'read' ? null : crypto.randomUUID(),
  };
  const variantId = pick(variants);
  const locationId = pick(locations);
  if (kind === 'read') {
    return auditEvent(base, {
      action: 'inventory.availability.viewed',
      phase: 'outcome',
      outcome: 'succeeded',
      target_type: 'variant',
      target_id: variantId,
      location_ids: [locationId],
      context: { input: { variantId } },
    });
  }
  if (kind === 'attempt') {
    return auditEvent(base, {
      action: 'inventory.reservation.created',
      phase: 'attempt',
      outcome: 'received',
    });
  }
  return auditEvent(base, {
    action: 'inventory.reservation.created',
    phase: 'outcome',
    outcome: 'succeeded',
    target_type: 'reservation',
    target_id: uuidv7(),
    operation_id: uuidv7(),
    location_ids: [locationId],
    external_ref: `shopify:order/${Math.floor(Math.random() * 1e13)}/line/${Math.floor(Math.random() * 1e13)}`,
    changes: {
      variantId,
      quantity: '1',
      purpose: 'external_order',
      allocations: [{ positionId: uuidv7(), locationId, quantity: '1.000000' }],
      expiresAt: null,
    },
  });
}

const started = performance.now();
for (let done = 0; done < total; done += 1000) {
  const batch = Array.from({ length: Math.min(1000, total - done) }, () => {
    const r = Math.random();
    return event(r < 0.6 ? 'read' : r < 0.8 ? 'attempt' : 'outcome');
  });
  await db.query('select ingest_audit_events($1::jsonb)', [JSON.stringify(batch)]);
}
const ingestMs = performance.now() - started;
await db.query('vacuum analyze audit_events');

const { rows } = await db.query<{
  events: string;
  heap: string;
  toast: string;
  indexes: string;
  total: string;
}>(
  `select (select count(*) from audit_events)::text as events,
     sum(pg_relation_size(c.oid))::text as heap,
     sum(coalesce(pg_total_relation_size(c.reltoastrelid), 0))::text as toast,
     sum(pg_indexes_size(c.oid))::text as indexes,
     sum(pg_total_relation_size(c.oid))::text as total
   from pg_inherits i join pg_class c on c.oid = i.inhrelid
   where i.inhparent = 'audit_events'::regclass`,
);
const r = rows[0]!;
const n = Number(r.events);
const per = (v: string) => (Number(v) / n).toFixed(0);
const { rows: perIndex } = await db.query<{ index: string; bytes: string }>(
  `select regexp_replace(ci.relname, '^audit_events_\\d{4}_\\d{2}_', '') as index,
     sum(pg_relation_size(ci.oid))::text as bytes
   from pg_inherits i
   join pg_index x on x.indrelid = i.inhrelid
   join pg_class ci on ci.oid = x.indexrelid
   where i.inhparent = 'audit_events'::regclass
   group by 1 order by 2 desc`,
);
console.log(
  JSON.stringify(
    {
      events: n,
      ingestSeconds: Number((ingestMs / 1000).toFixed(1)),
      bytesPerEvent: {
        heap: per(r.heap),
        toast: per(r.toast),
        indexes: per(r.indexes),
        total: per(r.total),
      },
      indexes: Object.fromEntries(perIndex.map((i) => [i.index, per(i.bytes)])),
      totalMB: (Number(r.total) / 1024 / 1024).toFixed(1),
    },
    null,
    2,
  ),
);
await db.end();
if (!args.keep) await admin.query(`drop database ${dbName} with (force)`);
await admin.end();
