import { type ShopifyPushPayload, uuidv7 } from '@airstock/core';
import {
  pushAvailability,
  pushChanges,
  pushConnection,
  runJob,
  runOnboarding,
  type SyncDeps,
  signQuery,
  signWebhook,
  TokenCipher,
} from '@airstock/shopify';
import { expect } from 'vitest';
import { ownerQuery } from '../../../test/helpers.ts';
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

// Shared setup for the I6 connector tests: a test app with fake Shopify stores, a signed-in owner
// per shop, and helpers that deliver webhooks and run this shop's outbox and jobs. Test files run
// in parallel against one database and outbox, so every helper works on its own shop's rows only.

export const SECRET = 'shpss_test_secret_0123456789';
const DASHBOARD = { origin: PUBLIC_URL, 'x-airstock-request': '1' };

export interface Merchant {
  cookies: Record<string, string>;
  cookie: string;
  shopId: string;
  locationId: string;
  warehouseId: string;
}

export async function shopifyHarness() {
  const stores = new Map<string, FakeStore>();
  const auth = new FakeAuth();
  const queued: JobMessage[] = [];
  const files = new Map<string, string>();
  const fileStore = {
    put: async (key: string, body: string) => {
      files.set(key, body);
    },
    list: async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)),
    get: async (key: string) => files.get(key) ?? null,
    delete: async (key: string) => {
      files.delete(key);
    },
  };
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const shopify: ShopifyAppConfig = {
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
  const t: TestApp = await testApp({
    shopify,
    files: fileStore,
    jobs: {
      async send(message) {
        queued.push(message);
      },
    },
  });
  const deps = (): SyncDeps => ({
    db: t.db,
    audit: t.sink,
    shopify,
    files: { get: fileStore.get, put: fileStore.put, delete: fileStore.delete },
  });

  async function dashboard(cookie: string, path: string, init: RequestInit = {}) {
    return t.app.request(`/api/v1${path}`, {
      ...init,
      headers: { cookie, ...DASHBOARD, 'content-type': 'application/json', ...init.headers },
    });
  }
  async function command(cookie: string, path: string, body: unknown) {
    return dashboard(cookie, path, {
      method: 'POST',
      headers: { 'idempotency-key': uuidv7() },
      body: JSON.stringify(body),
    });
  }

  function newUser(): WorkosUser {
    const id = `user_${uuidv7().replace(/-/g, '')}`;
    return { id, email: `${id}@example.com`, firstName: 'Ana', lastName: null };
  }

  async function merchant(name: string): Promise<Merchant> {
    const { cookies, cookie } = await signInAs(t, newUser());
    const shop = await json(
      await dashboard(cookie, '/shops', {
        method: 'POST',
        body: JSON.stringify({ name, currency: 'EUR', timezone: 'Europe/Berlin' }),
      }),
    );
    const [location] = await ownerQuery<{ warehouse_id: string }>(
      'select warehouse_id from locations where id = $1',
      [shop.defaultLocationId],
    );
    return {
      cookies,
      cookie,
      shopId: shop.shopId,
      locationId: shop.defaultLocationId,
      warehouseId: location!.warehouse_id,
    };
  }

  async function item(m: Merchant, name: string, sku: string, extra: object = {}) {
    const res = await command(m.cookie, `/shops/${m.shopId}/items`, { name, sku, ...extra });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await json(res)) as { productId: string; variantId: string };
  }

  async function receive(
    m: Merchant,
    variantId: string,
    quantity: number,
    opts: { locationId?: string; packId?: string } = {},
  ) {
    const res = await command(m.cookie, `/shops/${m.shopId}/receipts`, {
      variantId,
      locationId: opts.locationId ?? m.locationId,
      quantity: String(quantity),
      ...(opts.packId ? { packId: opts.packId } : {}),
    });
    expect(res.status, await res.clone().text()).toBe(201);
  }

  async function available(m: Merchant, variantId: string) {
    const res = await dashboard(m.cookie, `/shops/${m.shopId}/availability?variantId=${variantId}`);
    return (await json(res)).totals.available as string;
  }

  /** Runs the install: dashboard → Shopify authorize → signed redirect back to Airstock. */
  async function install(m: Merchant, store: FakeStore): Promise<string> {
    stores.set(store.domain, store);
    const start = await t.app.request(`/shopify/install?shop_id=${m.shopId}&shop=${store.domain}`, {
      headers: { cookie: cookieHeader(m.cookies) },
    });
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get('location')!);
    const code = `code-${uuidv7()}`;
    auth.codes.set(code, store.domain);
    const params = new URLSearchParams({
      code,
      shop: store.domain,
      state: authorize.searchParams.get('state')!,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    params.set('hmac', await signQuery(params, SECRET));
    const res = await t.app.request(`/shopify/oauth/callback?${params}`, {
      headers: { cookie: cookieHeader(m.cookies, cookiesFrom(start)) },
    });
    expect(res.status).toBe(303);
    const [row] = await ownerQuery<{ id: string }>(
      `select id from shopify_connections where shop_id = $1 and status = 'active'`,
      [m.shopId],
    );
    return row!.id;
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

  /** Runs queued jobs of these shops only (another test file's jobs stay queued for it). */
  async function runJobs(shopId: string) {
    const results = [];
    for (let i = 0; i < queued.length; ) {
      const message = queued[i]!;
      if (message.job.shopId !== shopId) {
        i++;
        continue;
      }
      queued.splice(i, 1);
      results.push(await runJob(deps(), message.job.shopId, message.job.jobId));
    }
    return results;
  }

  /**
   * Delivers this shop's new outbox events to the push, as the jobs consumer would. Tracks what
   * it handled itself: other test files sweep the shared outbox and mark rows dispatched.
   */
  const handled = new Set<string>();
  async function flush(shopId: string) {
    const rows = (
      await ownerQuery<{ id: string; topic: string; payload: object }>(
        `select id, topic, payload from outbox_events
         where shop_id = $1 and topic in ('inventory.availability_changed', 'shopify.levels.push')
         order by created_at, id`,
        [shopId],
      )
    ).filter((r) => !handled.has(r.id));
    const outcomes = [];
    for (const row of rows) {
      handled.add(row.id);
      outcomes.push(
        ...(row.topic === 'shopify.levels.push'
          ? await pushConnection(deps(), shopId, row.payload as ShopifyPushPayload)
          : await pushAvailability(deps(), shopId, row.payload)),
      );
    }
    return outcomes;
  }

  /** Like flush, but every new outbox event of the shop goes to one push, as a queue batch. */
  async function flushTogether(shopId: string) {
    const rows = (
      await ownerQuery<{ id: string; topic: string; payload: object }>(
        `select id, topic, payload from outbox_events
         where shop_id = $1 and topic in ('inventory.availability_changed', 'shopify.levels.push')
         order by created_at, id`,
        [shopId],
      )
    ).filter((r) => !handled.has(r.id));
    for (const row of rows) handled.add(row.id);
    return pushChanges(
      deps(),
      shopId,
      rows.map((r) => ({ topic: r.topic, payload: r.payload })),
    );
  }

  /** Runs an onboarding's steps until it waits for a person or finishes. */
  async function runOnboardingSteps(shopId: string, onboardingId: string, max = 10) {
    const steps = [];
    for (let i = 0; i < max; i++) {
      const step = await runOnboarding(deps(), shopId, onboardingId);
      steps.push(step);
      if (step.status === 'done') break;
    }
    return steps;
  }

  return {
    t,
    stores,
    auth,
    queued,
    files,
    deps,
    dashboard,
    command,
    merchant,
    item,
    receive,
    available,
    install,
    deliver,
    runJobs,
    flush,
    flushTogether,
    runOnboardingSteps,
    newStore: (prefix: string) => new FakeStore(`${prefix}-${uuidv7().slice(-8)}.myshopify.com`),
  };
}

export type ShopifyHarness = Awaited<ReturnType<typeof shopifyHarness>>;
