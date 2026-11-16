/**
 * Stock commands through the deployed Worker (plan Section 8, milestone I7): a small test shop is
 * filled through the API, then each stock command runs `--n` times, one at a time, and the
 * response's Server-Timing gives the server's own time (Worker, database, transactions, SQL
 * statements, queue sends). Optionally times webhook delivery, commit to receipt, with a receiver
 * on this machine behind a public HTTPS tunnel (`--webhook-url`, forwarded to `--webhook-port`).
 *
 *   AIRSTOCK_TOKEN=ask_… tsx scripts/bench/staging-stock.ts --shop <id> \
 *     [--base https://airstock.deletecookies.dev] [--items 300] [--n 30] [--json out.json] \
 *     [--webhook-url https://….trycloudflare.com --webhook-port 8787 --webhook-n 30]
 *
 * The token is an API credential of the test shop with every scope; it is read from the
 * environment and never printed. The shop is created through the API and removed afterwards with
 * cleanup.ts. Large seeds never go to staging (plan Section 7.3).
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string', default: 'https://airstock.deletecookies.dev' },
    shop: { type: 'string' },
    items: { type: 'string', default: '300' },
    n: { type: 'string', default: '30' },
    json: { type: 'string' },
    'skip-setup': { type: 'boolean', default: false },
    contention: { type: 'boolean', default: false },
    'webhook-only': { type: 'boolean', default: false },
    workers: { type: 'string', default: '10' },
    'webhook-url': { type: 'string' },
    'webhook-port': { type: 'string', default: '8787' },
    'webhook-n': { type: 'string', default: '30' },
  },
});
const token = process.env.AIRSTOCK_TOKEN;
if (!token || !args.shop) throw new Error('Needs AIRSTOCK_TOKEN and --shop.');
const base = `${args.base}/api/v1/shops/${args.shop}`;
const N = Number(args.n);

interface Timing {
  status: number;
  clientMs: number;
  appMs: number;
  dbMs: number;
  tx: number;
  sql: number;
  queueMs: number;
  sends: number;
}
function parseTiming(h: string | null): Omit<Timing, 'status' | 'clientMs'> {
  const num = (re: RegExp) => Number(re.exec(h ?? '')?.[1] ?? Number.NaN);
  return {
    appMs: num(/app;dur=([\d.]+)/),
    dbMs: num(/db;dur=([\d.]+)/),
    tx: num(/tx (\d+)/),
    sql: num(/sql (\d+)/),
    queueMs: num(/queue;dur=([\d.]+)/),
    sends: num(/sends (\d+)/),
  };
}

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ json: T; timing: Timing }> {
  for (let attempt = 0; ; attempt++) {
    const t = performance.now();
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const clientMs = performance.now() - t;
    const text = await res.text();
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return {
      json: (text ? JSON.parse(text) : {}) as T,
      timing: { status: res.status, clientMs, ...parseTiming(res.headers.get('server-timing')) },
    };
  }
}

const pct = (xs: number[], p: number) => {
  const s = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : Number.NaN;
};
const r1 = (x: number) => Math.round(x * 10) / 10;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
async function pool<J>(jobs: J[], n: number, fn: (j: J, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < jobs.length) {
        const i = next++;
        await fn(jobs[i]!, i);
      }
    }),
  );
}

// Setup -------------------------------------------------------------------------------------------

interface Item {
  variantId: string;
  lot: boolean;
}
const warehouses = (await api<{ warehouses: Array<{ warehouseId: string }> }>('GET', '/warehouses'))
  .json.warehouses;
const warehouseId = warehouses[0]!.warehouseId;
let locations = (
  await api<{ locations: Array<{ locationId: string; path: string }> }>('GET', '/locations')
).json.locations;
if (locations.length < 2) {
  await api('POST', '/locations', { warehouseId, name: 'Shelf B', code: 'B' });
  locations = (
    await api<{ locations: Array<{ locationId: string; path: string }> }>('GET', '/locations')
  ).json.locations;
}
const [shelfA, shelfB] = locations.map((l) => l.locationId) as [string, string];

const items: Item[] = [];
const tag = randomUUID().slice(0, 4);
if (!args['skip-setup']) {
  const t0 = performance.now();
  await pool(
    Array.from({ length: Number(args.items) }, (_, i) => i),
    6,
    async (i) => {
      const { json } = await api<{ variantId: string }>('POST', '/items', {
        name: `Bench I7 ${tag} item ${String(i).padStart(4, '0')}`,
        sku: `I7-${tag}-${String(i).padStart(4, '0')}`,
        acknowledgeSimilar: true,
        price: (5 + (i % 40)).toFixed(2),
      });
      const lot = i % 6 === 0;
      if (lot)
        await api('POST', `/variants/${json.variantId}/stock-settings`, {
          variantId: json.variantId,
          trackingMode: 'lot_expiry',
          sellByMarginDays: 7,
        });
      await api('POST', '/receipts', {
        variantId: json.variantId,
        locationId: shelfA,
        quantity: '200',
        unitCost: '3.50',
        ...(lot ? { lotCode: `OPEN-${i}`, expiresOn: day(200) } : {}),
      });
      items[i] = { variantId: json.variantId, lot };
    },
  );
  console.log(
    `Setup: ${items.length} items with opening stock in ${((performance.now() - t0) / 1000).toFixed(0)} s`,
  );
} else {
  // Items an earlier run created: SKU I7-<tag>-<n>, every sixth tracked by lot.
  const { json } = await api<{ rows: Array<{ variantId: string; sku: string | null }> }>(
    'POST',
    '/items/query',
    { limit: 200, search: 'I7' },
  );
  for (const r of json.rows) {
    const m = /^I7-[0-9a-f]{4}-(\d{4})$/.exec(r.sku ?? '');
    if (m) items.push({ variantId: r.variantId, lot: Number(m[1]) % 6 === 0 });
  }
  console.log(`Reusing ${items.length} items`);
}

const pickItems = (n: number, lot?: boolean) =>
  items
    .filter((i) => lot === undefined || i.lot === lot)
    .sort(() => Math.random() - 0.5)
    .slice(0, n);

// Concurrent callers (--contention) ---------------------------------------------------------------
// The same variant with 200 lots reserved by --workers callers at once (plan risk R5), then
// reservations, fulfillments, and receipts on different variants by --workers callers at once.
if (args.contention) {
  const W = Number(args.workers);
  const results: Array<Record<string, unknown>> = [];
  const summarize = (label: string, ts: Timing[]) => {
    const row = {
      label,
      callers: W,
      n: ts.length,
      sql: pct(
        ts.map((t) => t.sql),
        50,
      ),
      appP50: r1(
        pct(
          ts.map((t) => t.appMs),
          50,
        ),
      ),
      appP95: r1(
        pct(
          ts.map((t) => t.appMs),
          95,
        ),
      ),
      dbP50: r1(
        pct(
          ts.map((t) => t.dbMs),
          50,
        ),
      ),
      dbP95: r1(
        pct(
          ts.map((t) => t.dbMs),
          95,
        ),
      ),
      queueP95: r1(
        pct(
          ts.map((t) => t.queueMs),
          95,
        ),
      ),
    };
    results.push(row);
    console.log(
      `${label.padEnd(44)} x${W} n=${row.n} sql ${row.sql}  server p50 ${row.appP50} p95 ${row.appP95}  db p50 ${row.dbP50} p95 ${row.dbP95}  queue p95 ${row.queueP95} ms`,
    );
  };
  const { json: lotItem } = await api<{ variantId: string }>('POST', '/items', {
    name: `Bench I7 ${tag} two hundred lots`,
    sku: `I7-${tag}-LOTS`,
    acknowledgeSimilar: true,
  });
  await api('POST', `/variants/${lotItem.variantId}/stock-settings`, {
    variantId: lotItem.variantId,
    trackingMode: 'lot_expiry',
  });
  await pool(
    Array.from({ length: 200 }, (_, i) => i),
    6,
    async (i) => {
      await api('POST', '/receipts', {
        variantId: lotItem.variantId,
        locationId: i % 2 ? shelfA : shelfB,
        quantity: '24',
        unitCost: '2.10',
        lotCode: `L200-${String(i).padStart(3, '0')}`,
        expiresOn: day(40 + ((i * 37) % 400)),
      });
    },
  );
  for (const [label, qty, callers] of [
    ['reserve, 200 lots, one caller', '1', 1],
    ['reserve, 200 lots, same variant', '1', W],
    ['reserve, 200 lots, same variant, 12 units', '12', W],
  ] as const) {
    const ts: Timing[] = [];
    const ids: string[] = [];
    await pool(Array.from({ length: callers === 1 ? N : W * 10 }), callers, async () => {
      const { json, timing } = await api<{ reservationId: string }>('POST', '/reservations', {
        variantId: lotItem.variantId,
        quantity: qty,
        purpose: 'external_order',
        externalRef: `I7-R5-${randomUUID().slice(0, 8)}`,
      });
      ts.push(timing);
      ids.push(json.reservationId);
    });
    summarize(label, ts);
    await pool(ids, 6, async (id) => {
      await api('POST', `/reservations/${id}/release`, { reservationId: id });
    });
  }
  // Different variants, all callers at once.
  const many = pickItems(W * 10);
  const resT: Timing[] = [];
  const resIds: string[] = [];
  await pool(many, W, async (it) => {
    const { json, timing } = await api<{ reservationId: string }>('POST', '/reservations', {
      variantId: it.variantId,
      quantity: '1',
      purpose: 'external_order',
      externalRef: `I7-${randomUUID().slice(0, 8)}`,
    });
    resT.push(timing);
    resIds.push(json.reservationId);
  });
  summarize('reserve, different variants', resT);
  const fulT: Timing[] = [];
  await pool(resIds, W, async (id) => {
    fulT.push((await api('POST', `/reservations/${id}/fulfill`, { reservationId: id })).timing);
  });
  summarize('fulfill, different variants', fulT);
  const recT: Timing[] = [];
  await pool(pickItems(W * 10), W, async (it) => {
    recT.push(
      (
        await api('POST', '/receipts', {
          variantId: it.variantId,
          locationId: shelfA,
          quantity: '6',
          unitCost: '3.60',
        })
      ).timing,
    );
  });
  summarize('receive, different variants', recT);
  if (args.json)
    await writeFile(
      args.json,
      JSON.stringify({ at: new Date().toISOString(), base: args.base, results }, null, 2),
    );
  process.exit(0);
}

// Timed commands, one at a time -------------------------------------------------------------------

const results: Array<Record<string, unknown>> = [];
function report(label: string, ts: Timing[]) {
  const row = {
    label,
    n: ts.length,
    sql: pct(
      ts.map((t) => t.sql),
      50,
    ),
    tx: pct(
      ts.map((t) => t.tx),
      50,
    ),
    sends: pct(
      ts.map((t) => t.sends),
      50,
    ),
    appP50: r1(
      pct(
        ts.map((t) => t.appMs),
        50,
      ),
    ),
    appP95: r1(
      pct(
        ts.map((t) => t.appMs),
        95,
      ),
    ),
    dbP50: r1(
      pct(
        ts.map((t) => t.dbMs),
        50,
      ),
    ),
    dbP95: r1(
      pct(
        ts.map((t) => t.dbMs),
        95,
      ),
    ),
    queueP95: r1(
      pct(
        ts.map((t) => t.queueMs),
        95,
      ),
    ),
    clientP95: r1(
      pct(
        ts.map((t) => t.clientMs),
        95,
      ),
    ),
  };
  results.push(row);
  console.log(
    `${label.padEnd(30)} n=${row.n} sql ${row.sql} tx ${row.tx} sends ${row.sends}  server p50 ${row.appP50} p95 ${row.appP95}  db p50 ${row.dbP50} p95 ${row.dbP95}  queue p95 ${row.queueP95}  client p95 ${row.clientP95} ms`,
  );
}
const sequential = !args['webhook-only'];
if (sequential) {
  // Receive (a third into lots).
  const receipts: Timing[] = [];
  for (const [k, it] of pickItems(N).entries()) {
    const lotted = it.lot;
    const { timing } = await api('POST', '/receipts', {
      variantId: it.variantId,
      locationId: shelfA,
      quantity: '12',
      unitCost: '3.60',
      ...(lotted ? { lotCode: `I7-${k}-${randomUUID().slice(0, 6)}`, expiresOn: day(250) } : {}),
    });
    receipts.push(timing);
  }
  report('receive', receipts);

  // Reserve, then fulfill.
  const reservations: string[] = [];
  const reserveT: Timing[] = [];
  for (const it of pickItems(N)) {
    const { json, timing } = await api<{ reservationId: string }>('POST', '/reservations', {
      variantId: it.variantId,
      quantity: '1',
      purpose: 'external_order',
      externalRef: `I7-${randomUUID().slice(0, 8)}`,
    });
    reservations.push(json.reservationId);
    reserveT.push(timing);
  }
  report('reserve', reserveT);
  const fulfillT: Timing[] = [];
  for (const id of reservations)
    fulfillT.push((await api('POST', `/reservations/${id}/fulfill`, { reservationId: id })).timing);
  report('fulfill', fulfillT);

  // Transfers: created ready (not timed), dispatched, received.
  const transfers: string[] = [];
  for (let i = 0; i < N; i++) {
    const lines = pickItems(3, false).map((it) => ({ variantId: it.variantId, quantity: '2' }));
    const { json } = await api<{ transfer: { transferId: string } }>('POST', '/transfers', {
      fromLocationId: i % 2 ? shelfB : shelfA,
      toLocationId: i % 2 ? shelfA : shelfB,
      lines,
      ready: true,
    }).catch(async () =>
      // Shelf B may not hold these yet: send from A.
      api<{ transfer: { transferId: string } }>('POST', '/transfers', {
        fromLocationId: shelfA,
        toLocationId: shelfB,
        lines,
        ready: true,
      }),
    );
    transfers.push(json.transfer.transferId);
  }
  const dispatchT: Timing[] = [];
  for (const id of transfers)
    dispatchT.push((await api('POST', `/transfers/${id}/dispatch`, { transferId: id })).timing);
  report('transfer dispatch', dispatchT);
  const receiptT: Timing[] = [];
  for (const id of transfers)
    receiptT.push((await api('POST', `/transfers/${id}/receive`, { transferId: id })).timing);
  report('transfer receipt', receiptT);

  // Counts: started and recorded (not timed), then submitted.
  const submitT: Timing[] = [];
  for (let i = 0; i < N; i++) {
    const its = pickItems(5, false);
    const { json: session } = await api<{ sessionId: string }>('POST', '/counts', {
      locationId: shelfA,
      variantIds: its.map((it) => it.variantId),
      name: 'I7 bench count',
    });
    const avail = await Promise.all(
      its.map((it) =>
        api<{ positions: Array<{ locationId: string; onHand: string; condition: string }> }>(
          'GET',
          `/availability?variantId=${it.variantId}&locationId=${shelfA}`,
        ),
      ),
    );
    await api('POST', `/counts/${session.sessionId}/record`, {
      sessionId: session.sessionId,
      counts: its.map((it, k) => {
        const onHand = Number(
          avail[k]!.json.positions.find(
            (p) => p.locationId === shelfA && p.condition === 'sellable',
          )?.onHand ?? 0,
        );
        return {
          variantId: it.variantId,
          locationId: shelfA,
          counted: String(k === 0 ? Math.max(0, onHand - 1) : onHand),
        };
      }),
    });
    submitT.push(
      (await api('POST', `/counts/${session.sessionId}/submit`, { sessionId: session.sessionId }))
        .timing,
    );
  }
  report('count submit', submitT);

  // Reads.
  const availT: Timing[] = [];
  for (const it of pickItems(N))
    availT.push((await api('GET', `/availability?variantId=${it.variantId}`)).timing);
  report('availability, one variant', availT);
  const listT: Timing[] = [];
  for (let i = 0; i < N; i++)
    listT.push((await api('GET', '/reports/stock_on_hand?limit=50')).timing);
  report('inventory list, 50 rows', listT);
}

// Webhook delivery, commit to receipt -------------------------------------------------------------

let webhook: Record<string, unknown> | null = null;
if (args['webhook-url']) {
  const arrivals = new Map<string, number>();
  const server = createServer((req, res) => {
    const at = Date.now();
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      try {
        const e = JSON.parse(body) as {
          data?: { positions?: Array<{ variantId: string }> };
          created_at?: string;
        };
        const createdAt = Date.parse(e.created_at ?? '');
        for (const p of e.data?.positions ?? []) arrivals.set(p.variantId, at);
        arrivals.set(`created:${at}`, createdAt);
      } catch {}
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(Number(args['webhook-port']), r));
  const { json: sub } = await api<{ subscription: { subscriptionId: string } }>(
    'POST',
    '/webhook-subscriptions',
    { name: 'I7 bench receiver', url: args['webhook-url'], eventTypes: ['stock.changed'] },
  );
  const subscriptionId = sub.subscription.subscriptionId;
  const sendEnd: number[] = [];
  const created: number[] = [];
  const lags: Array<{ fromResponse: number; fromEvent: number | null }> = [];
  try {
    for (const it of pickItems(Number(args['webhook-n']), false)) {
      await api('POST', '/receipts', {
        variantId: it.variantId,
        locationId: shelfA,
        quantity: '1',
        unitCost: '3.60',
      });
      const responded = Date.now();
      sendEnd.push(responded);
      for (let w = 0; w < 600 && !arrivals.has(it.variantId); w++)
        await new Promise((r) => setTimeout(r, 50));
      const at = arrivals.get(it.variantId);
      const ev = arrivals.get(`created:${at}`);
      if (ev !== undefined && !Number.isNaN(ev)) created.push(ev);
      lags.push({
        fromResponse: at === undefined ? Number.NaN : at - responded,
        fromEvent: at === undefined || ev === undefined ? null : at - ev,
      });
    }
  } finally {
    await api('POST', `/webhook-subscriptions/${subscriptionId}/delete`, { subscriptionId });
    server.close();
  }
  const fromResponse = lags.map((l) => l.fromResponse);
  const fromEvent = lags.map((l) => l.fromEvent ?? Number.NaN);
  webhook = {
    n: lags.length,
    missed: fromResponse.filter((x) => Number.isNaN(x)).length,
    afterResponseP50: pct(fromResponse, 50),
    afterResponseP95: pct(fromResponse, 95),
    afterEventP50: pct(fromEvent, 50),
    afterEventP95: pct(fromEvent, 95),
    afterEventMax: pct(fromEvent, 100),
  };
  console.log(`webhook stock.changed: ${JSON.stringify(webhook)}`);
}

if (args.json)
  await writeFile(
    args.json,
    JSON.stringify(
      { at: new Date().toISOString(), base: args.base, n: N, results, webhook },
      null,
      2,
    ),
  );
