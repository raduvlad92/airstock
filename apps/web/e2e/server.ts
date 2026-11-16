/**
 * The end-to-end test server (plan N0): the real Worker app on Node, against a fresh PostgreSQL
 * database, serving the built dashboard from apps/worker/public. Sign-in is the one stand-in: a
 * test-only route seals a session for a new user, because the real flow needs WorkOS.
 *
 * Audit events are ingested right away, as the queue consumer would, so a test can read them.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuditEvent,
  dispatchOutbox,
  ensureUser,
  execute,
  handleWebhookOutbox,
  ingestAuditEvents,
  ops,
  reconcileShop,
  runExportJob,
  runImportJob,
  sessionCaller,
  uuidv7,
  WebhookSecretCipher,
} from '@airstock/core';
import { PgDatabase, poolSource } from '@airstock/db';
import { bootstrap, migrate } from '@airstock/db/migrate';
import pg from 'pg';
import { createApp } from '../../worker/src/app.ts';
import { memoryMediaStore, nodeHasher } from '../../worker/src/media-memory.ts';
import {
  cookie,
  nowSeconds,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  seal,
} from '../../worker/src/session.ts';
import { type WorkosClient, WorkosError } from '../../worker/src/workos.ts';

export const PORT = Number(process.env.E2E_PORT ?? 4173);
const ORIGIN = `http://localhost:${PORT}`;
const PUBLIC_DIR = fileURLToPath(new URL('../../worker/public', import.meta.url));
const SESSION_SECRET = 'e2e-session-secret-0123456789abcdef';

const admin =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/postgres';
export const E2E_DB = e2eDatabaseName();
const ownerUrl = new URL(admin);
ownerUrl.pathname = `/${E2E_DB}`;
const appUrl = new URL(ownerUrl);
appUrl.username = 'airstock_app';
appUrl.password = 'airstock_app';

/** One database per checkout, so end-to-end runs in several worktrees do not collide. */
export function e2eDatabaseName(): string {
  return (
    process.env.E2E_DB_NAME ??
    `airstock_e2e_${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 8)}`
  );
}

async function prepareDatabase() {
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`drop database if exists ${E2E_DB} with (force)`);
  await client.query(`create database ${E2E_DB}`);
  await client.end();
  await bootstrap(ownerUrl.toString());
  await migrate(ownerUrl.toString());
  const owner = new pg.Client({ connectionString: ownerUrl.toString() });
  await owner.connect();
  await owner.query(`alter role airstock_app password 'airstock_app'`);
  await owner.end();
}

const workos: WorkosClient = {
  authorizeUrl: () => `${ORIGIN}/auth/login`,
  authenticateWithCode: async () => {
    throw new WorkosError(400, 'not_in_e2e');
  },
  sendMagicCode: async () => {},
  authenticateWithMagicCode: async () => {
    throw new WorkosError(400, 'not_in_e2e');
  },
  authenticateWithEmailVerification: async () => {
    throw new WorkosError(400, 'not_in_e2e');
  },
  completeConnect: async () => {
    throw new WorkosError(400, 'not_in_e2e');
  },
};

await prepareDatabase();
const db = new PgDatabase(poolSource(appUrl.toString(), 20));
const audit = {
  async send(events: AuditEvent[]) {
    await ingestAuditEvents(db, events);
  },
};
// R2 and the jobs queue, in memory: imports and exports run right after the request commits.
const stored = new Map<string, string>();
const files = {
  put: async (key: string, body: string) => {
    stored.set(key, body);
  },
  list: async (prefix: string) => [...stored.keys()].filter((k) => k.startsWith(prefix)),
  get: async (key: string) => stored.get(key) ?? null,
  delete: async (key: string) => {
    stored.delete(key);
  },
};
const jobDeps = { db, audit, files: { get: files.get, put: files.put, delete: files.delete } };
// Webhooks: deliveries go to an in-memory endpoint that answers 200 (GET /__e2e/webhooks lists
// what it received), so a test can create a webhook and send a test without the internet.
const webhookCipher = await WebhookSecretCipher.fromBase64(
  'e2e',
  Buffer.alloc(32, 7).toString('base64'),
);
const webhookRequests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
const webhookDeps = {
  db,
  cipher: webhookCipher,
  fetch: async (url: string, init: RequestInit) => {
    webhookRequests.push({
      url,
      headers: init.headers as Record<string, string>,
      body: String(init.body),
    });
    return new Response('ok', { status: 200 });
  },
  schedule: async () => {},
};
const app = createApp({
  database: () => ({ transaction: (ctx, fn) => db.transaction(ctx, fn), close: async () => {} }),
  audit,
  files,
  dispatch: (handle) =>
    dispatchOutbox(handle, async (messages) => {
      for (const m of messages) {
        const payload = m.payload as { importId?: string; exportId?: string };
        if (m.topic === 'catalog.import.run' && payload.importId) {
          while ((await runImportJob(jobDeps, m.shopId, payload.importId)) === 'more') {}
        }
        if (m.topic === 'catalog.export.run' && payload.exportId)
          await runExportJob(jobDeps, m.shopId, payload.exportId);
        await handleWebhookOutbox(webhookDeps, m);
      }
    }),
  webhookSecrets: webhookCipher,
  mcp: null,
  web: {
    publicUrl: ORIGIN,
    sessionSecret: SESSION_SECRET,
    workos,
    authkitOrigin: ORIGIN,
    grantClaim: 'urn:airstock:grant',
  },
  // R2 and DigestStream exist only in Workers; uploads go to memory here (ADR 0015).
  media: {
    store: memoryMediaStore(),
    hasher: nodeHasher,
    signingKey: 'e2e-media-signing-key-0123456789',
    publicUrl: ORIGIN,
  },
  logger: { error: (message, data) => console.error(message, data), info: () => {} },
});

async function stockDrift(shopId: string): Promise<void> {
  const owner = new pg.Client({ connectionString: ownerUrl.toString() });
  await owner.connect();
  try {
    const { rows } = await owner.query<{ user_id: string; location_id: string }>(
      `select m.user_id, (select l.id from locations l where l.shop_id = m.shop_id
         and l.kind = 'storage' order by l.created_at limit 1) as location_id
       from memberships m where m.shop_id = $1 and m.role = 'owner' limit 1`,
      [shopId],
    );
    const caller = sessionCaller(rows[0]!.user_id);
    const run = (op: Parameters<typeof execute>[1], input: unknown) =>
      execute({ db, audit }, op, { caller, shopId, input, idempotencyKey: uuidv7() });
    const created = await run(ops.createItem, { name: 'Drifted lamp', sku: 'DRIFT-1' });
    const { variantId } = created.result as { variantId: string };
    await run(ops.receiveStock, { variantId, locationId: rows[0]!.location_id, quantity: '10' });
    await owner.query(
      'update inventory_positions set on_hand = on_hand + 3 where shop_id = $1 and variant_id = $2',
      [shopId, variantId],
    );
  } finally {
    await owner.end();
  }
}

const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.html': 'text/html',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', ORIGIN);
    // Static assets win, as Workers static assets do.
    const file = normalize(join(PUBLIC_DIR, decodeURIComponent(url.pathname)));
    if (file.startsWith(PUBLIC_DIR) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      createReadStream(file).pipe(res);
      return;
    }
    if (url.pathname === '/__e2e/webhooks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(webhookRequests));
      return;
    }
    // The stock check (D18): `drift` adds an item with stock and corrupts its balance through the
    // owner connection, as a bug would; both actions then run the scheduled check for the shop.
    if (url.pathname === '/__e2e/stock-check') {
      const shopId = url.searchParams.get('shopId') ?? '';
      if (url.searchParams.get('action') === 'drift') await stockDrift(shopId);
      const result = await reconcileShop(db, shopId, 'scheduled');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    if (url.pathname === '/__e2e/login') {
      const email = url.searchParams.get('email') ?? `${uuidv7()}@example.test`;
      const wid = `user_${uuidv7()}`;
      const uid = await ensureUser(db, { providerUserId: wid, email, displayName: null });
      const value = await seal(SESSION_SECRET, 'session', {
        uid,
        wid,
        email,
        exp: nowSeconds() + SESSION_TTL_SECONDS,
      });
      res.writeHead(303, {
        location: '/app',
        'set-cookie': cookie(SESSION_COOKIE, value, SESSION_TTL_SECONDS),
        'x-user-id': uid,
      });
      res.end();
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const response = await app.fetch(
      new Request(url, {
        method: req.method,
        headers,
        body: hasBody ? await body(req) : undefined,
      }),
    );
    const out: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie') out[key] = value;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end('e2e server error');
  }
});

server.listen(PORT, () => console.log(`e2e server on ${ORIGIN}`));
