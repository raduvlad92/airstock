/**
 * Catalog query benchmark through the deployed Worker (plan Section 8, F12): p50 and p95 of the
 * server's own time (Server-Timing `app`) for 50-row pages, on shops seeded with
 * `seed-catalog.ts --tokens`. Tokens are read from the seed file, never printed.
 *
 *   tsx scripts/bench/query-staging.ts --seed seed.json [--base https://…] [--n 40] [--out results.json]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    seed: { type: 'string', default: 'seed.json' },
    base: { type: 'string', default: 'https://airstock.deletecookies.dev' },
    n: { type: 'string', default: '40' },
    out: { type: 'string', default: 'query-staging.json' },
  },
});
const seed = JSON.parse(await readFile(args.seed, 'utf8')) as {
  shops: Array<{ shopId: string; token: string }>;
};

const scenarios: Array<[string, Record<string, unknown>]> = [
  ['list, default sort', { limit: 50 }],
  ['list, sort by price desc', { limit: 50, sort: { field: 'price', direction: 'desc' } }],
  ['search words', { limit: 50, search: 'classic lamp' }],
  ['search exact SKU', { limit: 50, search: 'B1-000123' }],
  [
    'custom select filter, custom measurement sort',
    {
      limit: 50,
      filter: [{ field: 'material', op: 'is_any_of', value: ['Oak', 'Walnut'] }],
      sort: { field: 'net_weight', direction: 'asc' },
    },
  ],
  [
    'custom range and multi filters, decimal sort, 4 values',
    {
      limit: 50,
      filter: [
        { field: 'shelf_life_days', op: 'between', value: ['100', '400'] },
        { field: 'seasons', op: 'has_any', value: ['Winter'] },
      ],
      sort: { field: 'margin', direction: 'desc' },
      fields: ['brand', 'material', 'net_weight', 'rrp'],
    },
  ],
  [
    'products mode, variant field filter',
    { mode: 'products', limit: 50, filter: [{ field: 'price', op: 'lt', value: '50' }] },
  ],
  [
    'in stock, with availability',
    { limit: 50, filter: [{ field: 'available', op: 'gt', value: '0' }], fields: ['available'] },
  ],
];

const timing = (h: string | null, name: string) =>
  Number(new RegExp(`${name};dur=([\\d.]+)`).exec(h ?? '')?.[1] ?? Number.NaN);
const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const results: Record<string, unknown> = {};
for (const [label, body] of scenarios) {
  const app: number[] = [];
  const db: number[] = [];
  const client: number[] = [];
  for (let i = 0; i < Number(args.n); i++) {
    const shop = seed.shops[i % seed.shops.length]!;
    const t = performance.now();
    const res = await fetch(`${args.base}/api/v1/shops/${shop.shopId}/items/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${shop.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    client.push(performance.now() - t);
    if (!res.ok) throw new Error(`${label}: ${res.status} ${await res.text()}`);
    await res.json();
    app.push(timing(res.headers.get('server-timing'), 'app'));
    db.push(timing(res.headers.get('server-timing'), 'db'));
  }
  results[label] = {
    appP50: pct(app, 50),
    appP95: pct(app, 95),
    dbP95: pct(db, 95),
    clientP95: Math.round(pct(client, 95)),
  };
  console.log(
    `${label.padEnd(52)} server p50 ${pct(app, 50).toFixed(0).padStart(5)} ms  p95 ${pct(app, 95).toFixed(0).padStart(5)} ms  (db p95 ${pct(db, 95).toFixed(0)} ms)`,
  );
}
await writeFile(args.out, JSON.stringify(results, null, 2));
