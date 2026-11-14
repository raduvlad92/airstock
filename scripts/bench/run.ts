/**
 * Staging measurement harness (plan Section 10). Runs each operation N times, one at a time, and
 * records the client latency and the server's own Server-Timing (Worker time, database time,
 * transactions, SQL statements, queue sends).
 *
 *   AIRSTOCK_TOKEN=ask_… [MCP_TOKEN=…] tsx scripts/bench/run.ts \
 *     --base https://airstock.deletecookies.dev --shop <id> --variant <id> --location <id> \
 *     [--n 40] [--out bench.json]
 *
 * The variant should not be mapped to Shopify, so the run does not push to a store.
 * Tokens come from the environment and are never printed.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string', default: 'https://airstock.deletecookies.dev' },
    shop: { type: 'string' },
    variant: { type: 'string' },
    location: { type: 'string' },
    n: { type: 'string', default: '40' },
    out: { type: 'string', default: 'bench.json' },
  },
});
const token = process.env.AIRSTOCK_TOKEN;
const mcpToken = process.env.MCP_TOKEN;
if (!token || !args.shop || !args.variant || !args.location) {
  console.error('Needs AIRSTOCK_TOKEN, --shop, --variant, and --location.');
  process.exit(2);
}
const N = Number(args.n);
const base = `${args.base}/api/v1/shops/${args.shop}`;

interface Sample {
  op: string;
  status: number;
  clientMs: number;
  appMs: number | null;
  dbMs: number | null;
  tx: number | null;
  sql: number | null;
  queueMs: number | null;
  sends: number | null;
}

function parseServerTiming(header: string | null) {
  const out: Record<string, { dur: number; desc: string }> = {};
  for (const part of (header ?? '').split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const dur = Number(/dur=([\d.]+)/.exec(params.join(';'))?.[1] ?? Number.NaN);
    const desc = /desc="([^"]*)"/.exec(params.join(';'))?.[1] ?? '';
    out[name] = { dur, desc };
  }
  const num = (s: string, key: string) => {
    const m = new RegExp(`${key} (\\d+)`).exec(s);
    return m ? Number(m[1]) : null;
  };
  return {
    appMs: out.app?.dur ?? null,
    dbMs: out.db?.dur ?? null,
    tx: num(out.db?.desc ?? '', 'tx'),
    sql: num(out.db?.desc ?? '', 'sql'),
    queueMs: out.queue?.dur ?? null,
    sends: num(out.queue?.desc ?? '', 'sends'),
  };
}

async function timed(op: string, url: string, init: RequestInit): Promise<[Sample, Response]> {
  const started = performance.now();
  const res = await fetch(url, init);
  const body = await res.clone().text();
  const clientMs = performance.now() - started;
  if (!res.ok) console.error(`${op} ${res.status} ${body.slice(0, 200)}`);
  return [
    { op, status: res.status, clientMs, ...parseServerTiming(res.headers.get('server-timing')) },
    res,
  ];
}

const headers = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'user-agent': 'airstock-bench',
  ...extra,
});

const samples: Sample[] = [];

async function availability() {
  const [s] = await timed(
    'rest get_availability',
    `${base}/availability?variantId=${args.variant}`,
    {
      headers: headers(),
    },
  );
  samples.push(s);
}

async function reserveAndRelease() {
  const [s, res] = await timed('rest reserve_stock', `${base}/reservations`, {
    method: 'POST',
    headers: headers({ 'idempotency-key': crypto.randomUUID() }),
    body: JSON.stringify({ variantId: args.variant, locationId: args.location, quantity: '1' }),
  });
  samples.push(s);
  const { reservationId } = (await res.json()) as { reservationId?: string };
  if (!reservationId) return;
  const [r] = await timed(
    'rest release_reservation',
    `${base}/reservations/${reservationId}/release`,
    {
      method: 'POST',
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
      body: '{}',
    },
  );
  samples.push(r);
}

async function receipt() {
  const [s] = await timed('rest receive_stock', `${base}/receipts`, {
    method: 'POST',
    headers: headers({ 'idempotency-key': crypto.randomUUID() }),
    body: JSON.stringify({ variantId: args.variant, locationId: args.location, quantity: '1' }),
  });
  samples.push(s);
}

let rpcId = 1;
async function mcpCall(tool: string, toolArgs: Record<string, unknown>) {
  const [s] = await timed(`mcp ${tool}`, `${args.base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${mcpToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': 'airstock-bench',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name: tool, arguments: toolArgs },
    }),
  });
  samples.push(s);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}

function summarize() {
  const ops = [...new Set(samples.map((s) => s.op))];
  const rows = ops.map((op) => {
    const list = samples.filter((s) => s.op === op && s.status < 400);
    const stat = (key: keyof Sample) => {
      const values = list
        .map((s) => s[key])
        .filter((v): v is number => typeof v === 'number' && !Number.isNaN(v))
        .sort((a, b) => a - b);
      return { p50: percentile(values, 50), p95: percentile(values, 95) };
    };
    return {
      op,
      n: list.length,
      errors: samples.filter((s) => s.op === op && s.status >= 400).length,
      client: stat('clientMs'),
      app: stat('appMs'),
      db: stat('dbMs'),
      queue: stat('queueMs'),
      sql: stat('sql').p50,
      tx: stat('tx').p50,
      sends: stat('sends').p50,
    };
  });
  const f = (n: number) => (Number.isNaN(n) ? '–' : n.toFixed(0));
  console.log(
    '| Operation | n | Client p50 / p95 ms | Worker p50 / p95 ms | DB p50 / p95 ms | Queue p50 ms | Tx | SQL | Queue sends |',
  );
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    console.log(
      `| ${r.op} | ${r.n}${r.errors ? ` (${r.errors} errors)` : ''} | ${f(r.client.p50)} / ${f(r.client.p95)} | ${f(r.app.p50)} / ${f(r.app.p95)} | ${f(r.db.p50)} / ${f(r.db.p95)} | ${f(r.queue.p50)} | ${f(r.tx)} | ${f(r.sql)} | ${f(r.sends)} |`,
    );
  }
  return rows;
}

// Warm-up: the first request opens connections; it is recorded separately.
await availability();
samples[0]!.op = 'rest get_availability (first)';
for (let i = 0; i < N; i++) await availability();
for (let i = 0; i < N; i++) await reserveAndRelease();
for (let i = 0; i < Math.ceil(N / 2); i++) await receipt();
if (mcpToken) {
  for (let i = 0; i < N; i++) await mcpCall('get_availability', { variantId: args.variant });
  for (let i = 0; i < Math.ceil(N / 2); i++) {
    await mcpCall('reserve_stock', {
      action: 'reserve',
      variantId: args.variant,
      locationId: args.location,
      quantity: '1',
      expiresInSeconds: 60,
    });
  }
}
const summary = summarize();
await writeFile(
  args.out,
  JSON.stringify(
    { at: new Date().toISOString(), base: args.base, n: N, summary, samples },
    null,
    2,
  ),
);
console.log(`\nWrote ${args.out}`);
