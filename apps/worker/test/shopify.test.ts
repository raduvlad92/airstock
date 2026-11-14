import { uuidv7 } from '@airstock/core';
import {
  connectedStore,
  pushAvailability,
  runJob,
  type ShopifyVariant,
  type SyncDeps,
  signQuery,
  signWebhook,
  TokenCipher,
} from '@airstock/shopify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, ownerQuery } from '../../../test/helpers.ts';
import type { JobMessage, ShopifyAppConfig } from '../src/shopify.ts';
import type { WorkosUser } from '../src/workos.ts';
import { FakeAuth, FakeStore } from './fake-shopify.ts';
import {
  cookieHeader,
  cookiesFrom,
  json,
  PUBLIC_URL,
  signInAs,
  type TestApp,
  testApp,
} from './setup.ts';

const SECRET = 'shpss_test_secret_0123456789';
const DASHBOARD = { origin: PUBLIC_URL, 'x-airstock-request': '1' };

let t: TestApp;
let shopify: ShopifyAppConfig;
const stores = new Map<string, FakeStore>();
const auth = new FakeAuth();
const queued: JobMessage[] = [];

function deps(): SyncDeps {
  return { db: t.db, audit: t.sink, shopify };
}

beforeAll(async () => {
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  shopify = {
    clientId: 'test-client-id',
    apiSecret: SECRET,
    redirectUri: `${PUBLIC_URL}/shopify/oauth/callback`,
    webhookUri: `${PUBLIC_URL}/shopify/webhooks`,
    cipher: await TokenCipher.fromBase64('k1', key),
    auth,
    admin: (domain) => {
      const store = stores.get(domain);
      if (!store) throw new Error(`no fake store ${domain}`);
      return store;
    },
  };
  t = await testApp({
    shopify,
    jobs: {
      async send(message) {
        queued.push(message);
      },
    },
  });
});
afterAll(() => t.close());

function newUser(): WorkosUser {
  const id = `user_${uuidv7().replace(/-/g, '')}`;
  return { id, email: `${id}@example.com`, firstName: 'Ana', lastName: null };
}

async function dashboard(cookie: string, path: string, init: RequestInit = {}) {
  return t.app.request(`/api/v1${path}`, {
    ...init,
    headers: { cookie, ...DASHBOARD, 'content-type': 'application/json', ...init.headers },
  });
}

/** A signed-in owner with a shop that holds `stock` units of an item with this SKU. */
async function merchant(sku: string, stock: number) {
  const { cookies, cookie } = await signInAs(t, newUser());
  const shop = await json(
    await dashboard(cookie, '/shops', {
      method: 'POST',
      body: JSON.stringify({ name: `Shop ${sku}`, currency: 'EUR', timezone: 'Europe/Berlin' }),
    }),
  );
  const item = await json(
    await dashboard(cookie, `/shops/${shop.shopId}/items`, {
      method: 'POST',
      headers: { 'idempotency-key': uuidv7() },
      body: JSON.stringify({ name: 'Mug', sku }),
    }),
  );
  await receive(cookie, shop.shopId, item.variantId, shop.defaultLocationId, stock);
  return {
    cookies,
    cookie,
    shopId: shop.shopId as string,
    locationId: shop.defaultLocationId as string,
    variantId: item.variantId as string,
  };
}

async function receive(
  cookie: string,
  shopId: string,
  variantId: string,
  locationId: string,
  quantity: number,
) {
  const res = await dashboard(cookie, `/shops/${shopId}/receipts`, {
    method: 'POST',
    headers: { 'idempotency-key': uuidv7() },
    body: JSON.stringify({ variantId, locationId, quantity: String(quantity) }),
  });
  expect(res.status).toBe(201);
}

/** Runs the install: dashboard → Shopify authorize → signed redirect back to Airstock. */
async function install(
  m: { cookies: Record<string, string>; shopId: string },
  domain: string,
  opts: { tamper?: boolean; asCookies?: Record<string, string> } = {},
) {
  const start = await t.app.request(`/shopify/install?shop_id=${m.shopId}&shop=${domain}`, {
    headers: { cookie: cookieHeader(m.cookies) },
  });
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location')!);
  expect(authorize.origin).toBe(`https://${domain}`);
  const code = `code-${uuidv7()}`;
  auth.codes.set(code, domain);
  const params = new URLSearchParams({
    code,
    host: btoa(`admin.shopify.com/store/${domain.split('.')[0]}`),
    shop: domain,
    state: authorize.searchParams.get('state')!,
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  params.set('hmac', await signQuery(params, opts.tamper ? 'wrong-secret' : SECRET));
  return t.app.request(`/shopify/oauth/callback?${params}`, {
    headers: { cookie: cookieHeader(opts.asCookies ?? m.cookies, cookiesFrom(start)) },
  });
}

async function connectionOf(shopId: string) {
  const [row] = await ownerQuery<{
    id: string;
    status: string;
    access_token_ciphertext: string | null;
    refresh_token_ciphertext: string | null;
    webhooks: Array<{ topic: string; status: string }>;
  }>('select * from shopify_connections where shop_id = $1', [shopId]);
  return row!;
}

async function deliver(
  domain: string,
  topic: string,
  body: string,
  opts: { eventId?: string; secret?: string } = {},
) {
  const bytes = new TextEncoder().encode(body);
  return t.app.request('/shopify/webhooks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': domain,
      'x-shopify-event-id': opts.eventId ?? uuidv7(),
      'x-shopify-webhook-id': uuidv7(),
      'x-shopify-hmac-sha256': await signWebhook(bytes, opts.secret ?? SECRET),
    },
    body: bytes,
  });
}

async function runQueuedJobs() {
  const results = [];
  while (queued.length > 0) {
    const { job } = queued.shift()!;
    results.push(await runJob(deps(), job.shopId, job.jobId));
  }
  return results;
}

/**
 * Delivers this shop's new outbox events to the push, as the jobs consumer would. Tracks what
 * it handled itself: other test files sweep the shared outbox and mark rows dispatched.
 */
const handledOutbox = new Set<string>();
async function flushOutbox(shopId: string) {
  const rows = (
    await ownerQuery<{ id: string; payload: object }>(
      `select id, payload from outbox_events
       where shop_id = $1 and topic = 'inventory.availability_changed' order by created_at, id`,
      [shopId],
    )
  ).filter((r) => !handledOutbox.has(r.id));
  const outcomes = [];
  for (const row of rows) {
    handledOutbox.add(row.id);
    outcomes.push(...(await pushAvailability(deps(), shopId, row.payload)));
  }
  return outcomes.map((o) => o.outcome);
}

async function availability(cookie: string, shopId: string, variantId: string) {
  const res = await dashboard(cookie, `/shops/${shopId}/availability?variantId=${variantId}`);
  return (await json(res)).totals.available as string;
}

async function reservationsFor(shopId: string) {
  return ownerQuery<{ external_ref: string; quantity: string; purpose: string }>(
    `select external_ref, quantity::text, purpose from reservations where shop_id = $1
     order by created_at`,
    [shopId],
  );
}

describe('Shopify install', () => {
  it('connects a store, stores its tokens encrypted, and subscribes to order webhooks', async () => {
    const m = await merchant(`INS-${uuidv7().slice(-6)}`, 1);
    const domain = `ins-${uuidv7().slice(-8)}.myshopify.com`;
    stores.set(domain, new FakeStore(domain));
    const res = await install(m, domain);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/app\?shopify=/);
    const row = await connectionOf(m.shopId);
    expect(row.status).toBe('active');
    expect(row.access_token_ciphertext).not.toContain('shpat_');
    expect(row.refresh_token_ciphertext).not.toContain('shprt_');
    expect(row.webhooks.map((w) => `${w.topic}:${w.status}`)).toEqual([
      'ORDERS_CREATE:subscribed',
      'APP_UNINSTALLED:subscribed',
    ]);
    const store = await connectedStore(deps(), m.shopId, row.id);
    expect(store.shopDomain).toBe(domain);
  });

  it('refuses a redirect with a bad signature or from another user', async () => {
    const m = await merchant(`BAD-${uuidv7().slice(-6)}`, 1);
    const domain = `bad-${uuidv7().slice(-8)}.myshopify.com`;
    stores.set(domain, new FakeStore(domain));
    const tampered = await install(m, domain, { tamper: true });
    expect(tampered.status).toBe(400);
    expect(await tampered.text()).toContain('Install not verified');
    // Someone else's browser session with this install's state: the link cannot be replayed.
    const other = await signInAs(t, newUser());
    const hijack = await install(m, domain, { asCookies: other.cookies });
    expect(hijack.status).toBe(400);
    expect(await hijack.text()).toContain('Install expired');
    const rows = await ownerQuery('select 1 from shopify_connections where shop_id = $1', [
      m.shopId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('refuses a store that is already connected to another shop', async () => {
    const domain = `dup-${uuidv7().slice(-8)}.myshopify.com`;
    stores.set(domain, new FakeStore(domain));
    const first = await merchant(`DUP-${uuidv7().slice(-6)}`, 1);
    expect((await install(first, domain)).status).toBe(303);
    const second = await merchant(`DUP-${uuidv7().slice(-6)}`, 1);
    const res = await install(second, domain);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('already connected to another shop');
  });
});

describe('Shopify orders and availability', () => {
  const sku = `MUG-${uuidv7().slice(-6)}`;
  const domainA = `store-a-${uuidv7().slice(-6)}.myshopify.com`;
  const domainB = `store-b-${uuidv7().slice(-6)}.myshopify.com`;
  let a: Awaited<ReturnType<typeof merchant>>;
  let b: Awaited<ReturnType<typeof merchant>>;
  let storeA: FakeStore;
  let storeB: FakeStore;
  let mugA: ShopifyVariant;
  let mugB: ShopifyVariant;
  let connectionA: string;

  async function mapBySku(m: typeof a, connectionId: string) {
    return t.app.request(`/shopify/connections/${connectionId}/map`, {
      method: 'POST',
      headers: { cookie: m.cookie, ...DASHBOARD, 'content-type': 'application/json' },
      body: JSON.stringify({
        shopId: m.shopId,
        locationId: m.locationId,
        shopifyLocationId: '1001',
      }),
    });
  }

  beforeAll(async () => {
    storeA = new FakeStore(domainA);
    storeB = new FakeStore(domainB);
    stores.set(domainA, storeA);
    stores.set(domainB, storeB);
    mugA = storeA.addVariant(sku, 3);
    mugB = storeB.addVariant(sku, 4);
    storeA.addVariant('ONLY-IN-SHOPIFY', 9);
    a = await merchant(sku, 10);
    b = await merchant(sku, 20);
    expect((await install(a, domainA)).status).toBe(303);
    expect((await install(b, domainB)).status).toBe(303);
    connectionA = (await connectionOf(a.shopId)).id;
    const mapped = await json(await mapBySku(a, connectionA));
    expect(mapped.variantsMapped).toBe(1);
    expect(mapped.unmatchedShopify).toEqual(['ONLY-IN-SHOPIFY']);
    expect((await mapBySku(b, (await connectionOf(b.shopId)).id)).status).toBe(200);
  });

  it('sets Shopify to Airstock’s availability when a store is first mapped', async () => {
    // The opening receipt and the mapping each announced a change; the first push does the work.
    expect(await flushOutbox(a.shopId)).toEqual(['pushed', 'unchanged']);
    expect(storeA.available(mugA)).toBe(10);
    // The first write compared against Shopify's own quantity, read just before.
    expect(storeA.sets.at(-1)).toMatchObject({ from: 3, to: 10 });
    await flushOutbox(b.shopId);
    expect(storeB.available(mugB)).toBe(20);
  });

  it('refuses mapping by a member without connections.manage', async () => {
    const viewer = await addMember(a.shopId, 'viewer');
    const session = await signInAs(t, {
      id: (
        await ownerQuery<{ workos_user_id: string }>(
          'select workos_user_id from users where id = $1',
          [viewer.userId],
        )
      )[0]!.workos_user_id,
      email: 'viewer@example.com',
      firstName: null,
      lastName: null,
    });
    const res = await mapBySku({ ...a, cookie: session.cookie }, connectionA);
    expect(res.status).toBe(403);
  });

  it('turns an order into a reservation and keeps Shopify in step', async () => {
    const order = storeA.placeOrder([{ variant: mugA, quantity: 2 }]);
    expect(storeA.available(mugA)).toBe(8);
    const res = await deliver(domainA, 'orders/create', storeA.webhookBody(order));
    expect(res.status).toBe(200);
    expect(queued).toHaveLength(1);
    expect(await runQueuedJobs()).toEqual([{ status: 'done' }]);
    const reservations = await reservationsFor(a.shopId);
    expect(reservations).toEqual([
      {
        external_ref: `shopify:order/${order.orderId}/line/${order.lines[0]!.lineId}`,
        quantity: '2.000000',
        purpose: 'external_order',
      },
    ]);
    expect(await availability(a.cookie, a.shopId, a.variantId)).toBe('8.000000');
    // Shopify already shows 8, so the push has nothing to change and nothing is refused.
    expect(await flushOutbox(a.shopId)).toEqual(['unchanged']);
    expect(storeA.available(mugA)).toBe(8);
    expect(storeA.refused).toHaveLength(0);
    const [event] = await ownerQuery<{ actor_type: string; source: string }>(
      `select actor_type, source from audit_events
       where shop_id = $1 and action = 'inventory.reservation.created' and outcome = 'succeeded'`,
      [a.shopId],
    );
    expect(event).toEqual({ actor_type: 'connector', source: 'shopify' });
  });

  it('gives a duplicate webhook no second effect (A30)', async () => {
    const order = storeA.placeOrder([{ variant: mugA, quantity: 1 }]);
    const body = storeA.webhookBody(order);
    const eventId = uuidv7();
    expect((await deliver(domainA, 'orders/create', body, { eventId })).status).toBe(200);
    expect((await deliver(domainA, 'orders/create', body, { eventId })).status).toBe(200);
    expect(queued).toHaveLength(1);
    await runQueuedJobs();
    // The same order again under a new event ID: a new receipt, but the line is not reserved twice.
    await deliver(domainA, 'orders/create', body);
    const [again] = await runQueuedJobs();
    expect(again).toEqual({ status: 'done' });
    const refs = (await reservationsFor(a.shopId)).filter((r) =>
      r.external_ref.includes(order.orderId),
    );
    expect(refs).toHaveLength(1);
    const receipts = await ownerQuery(
      'select 1 from webhook_receipts where shop_id = $1 and event_id = $2',
      [a.shopId, eventId],
    );
    expect(receipts).toHaveLength(1);
    expect(await flushOutbox(a.shopId)).toEqual(['unchanged']);
    expect(storeA.available(mugA)).toBe(7);
  });

  it('rejects a webhook with a bad signature before anything is recorded (P3)', async () => {
    const before = t.sink.events.length;
    const order = storeA.placeOrder([{ variant: mugA, quantity: 1 }]);
    const res = await deliver(domainA, 'orders/create', storeA.webhookBody(order), {
      secret: 'not-the-secret',
    });
    expect(res.status).toBe(401);
    expect(t.sink.events.length).toBe(before);
    expect(queued).toHaveLength(0);
    // Put Shopify back: this order never reached Airstock.
    storeA.levels.set(storeA.key(mugA.inventoryItemId, '1001'), 7);
    storeA.orders.pop();
  });

  it('never lets one store’s orders touch another shop (A13)', async () => {
    const before = await reservationsFor(a.shopId);
    const order = storeB.placeOrder([{ variant: mugB, quantity: 5 }]);
    await deliver(domainB, 'orders/create', storeB.webhookBody(order));
    await runQueuedJobs();
    expect(await reservationsFor(a.shopId)).toEqual(before);
    expect((await reservationsFor(b.shopId)).map((r) => r.quantity)).toEqual(['5.000000']);
    await flushOutbox(b.shopId);
    expect(storeB.available(mugB)).toBe(15);
    expect(storeA.available(mugA)).toBe(7);
  });

  it('processes an order Shopify accepted before overwriting its quantity (P1)', async () => {
    // Airstock receives 5 more while an order for 1 is already accepted in Shopify, whose
    // webhook has not arrived yet.
    await receive(a.cookie, a.shopId, a.variantId, a.locationId, 5);
    const order = storeA.placeOrder([{ variant: mugA, quantity: 1 }]);
    expect(storeA.available(mugA)).toBe(6);
    const refusedBefore = storeA.refused.length;
    expect(await flushOutbox(a.shopId)).toEqual(['pushed']);
    // The first write (7 → 12) was refused because Shopify held 6; the push then processed the
    // order and wrote Airstock's new availability, 11. Shopify never showed 12.
    expect(storeA.refused.slice(refusedBefore)).toEqual([
      { item: mugA.inventoryItemId, location: '1001', from: 7, actual: 6 },
    ]);
    expect(storeA.sets.at(-1)).toMatchObject({ from: 6, to: 11 });
    expect(storeA.sets.some((s) => s.to === 12)).toBe(false);
    expect(await availability(a.cookie, a.shopId, a.variantId)).toBe('11.000000');
    // The late webhook changes nothing.
    await deliver(domainA, 'orders/create', storeA.webhookBody(order));
    await runQueuedJobs();
    const refs = (await reservationsFor(a.shopId)).filter((r) =>
      r.external_ref.includes(order.orderId),
    );
    expect(refs).toHaveLength(1);
    // The reservation made during the push announced its own change; it finds nothing to do.
    expect(await flushOutbox(a.shopId)).toEqual(['unchanged']);
    expect(storeA.available(mugA)).toBe(11);
  });

  it('records a conflict and leaves Shopify alone when no order explains a difference', async () => {
    // Someone edits the quantity in the Shopify admin.
    storeA.levels.set(storeA.key(mugA.inventoryItemId, '1001'), 50);
    await receive(a.cookie, a.shopId, a.variantId, a.locationId, 1);
    expect(await flushOutbox(a.shopId)).toEqual(['conflict']);
    expect(storeA.available(mugA)).toBe(50);
    const [conflict] = await ownerQuery<{ changes: object }>(
      `select changes from audit_events where shop_id = $1 and action = 'shopify.inventory.conflict'`,
      [a.shopId],
    );
    expect(conflict?.changes).toEqual({ expected: 11, airstock: 12, actual: 50 });
    const listed = await json(await dashboard(a.cookie, `/shops/${a.shopId}/shopify/connections`));
    expect(listed.connections[0].conflicts).toBe(1);
    // Mapping again reads Shopify's quantity afresh and clears the conflict.
    storeA.levels.set(storeA.key(mugA.inventoryItemId, '1001'), 11);
    expect((await mapBySku(a, connectionA)).status).toBe(200);
    expect(await flushOutbox(a.shopId)).toEqual(['pushed']);
    expect(storeA.available(mugA)).toBe(12);
  });

  it('refreshes an expiring access token once, even when several jobs need it', async () => {
    await ownerQuery(
      `update shopify_connections set access_token_expires_at = now() + interval '1 minute'
       where id = $1`,
      [connectionA],
    );
    const before = auth.refreshes;
    await Promise.all([1, 2, 3].map(() => connectedStore(deps(), a.shopId, connectionA)));
    expect(auth.refreshes - before).toBe(1);
    const [row] = await ownerQuery<{ fresh: boolean }>(
      `select access_token_expires_at > now() + interval '30 minutes' as fresh
       from shopify_connections where id = $1`,
      [connectionA],
    );
    expect(row?.fresh).toBe(true);
  });

  it('forgets the tokens when the app is uninstalled, and ignores later webhooks', async () => {
    const res = await deliver(domainB, 'app/uninstalled', JSON.stringify({ id: 1 }));
    expect(res.status).toBe(200);
    const row = await connectionOf(b.shopId);
    expect(row.status).toBe('uninstalled');
    expect(row.access_token_ciphertext).toBeNull();
    const order = storeB.placeOrder([{ variant: mugB, quantity: 1 }]);
    expect((await deliver(domainB, 'orders/create', storeB.webhookBody(order))).status).toBe(200);
    expect(queued).toHaveLength(0);
  });
});
