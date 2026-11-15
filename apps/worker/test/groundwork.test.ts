import { readFile } from 'node:fs/promises';
import { RATE_LIMIT_PERIOD_SECONDS, RATE_LIMITS, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery, type SeededShop, seedShop } from '../../../test/helpers.ts';
import { packAuditEvents, unpackAuditMessages } from '../src/audit-queue.ts';
import { memoryLimiter, RefusalRecorder } from '../src/rate-limit.ts';
import {
  apiToken,
  connectionGrant,
  GRANT_CLAIM,
  json,
  PUBLIC_URL,
  signInAs,
  type TestApp,
  testApp,
} from './setup.ts';

// Phase 1, milestone N0: the React shell, rate limits, and client-reported events.

describe('dashboard shell (ADR 0010)', () => {
  let t: TestApp;
  let cookie: string;
  beforeAll(async () => {
    t = await testApp();
    ({ cookie } = await signInAs(t, {
      id: `user_${uuidv7()}`,
      email: 'shell@example.test',
      firstName: null,
      lastName: null,
    }));
  });
  afterAll(() => t.close());

  it('serves the same shell for every client-side route under /app, with the site CSP', async () => {
    for (const path of [
      '/app',
      '/app/',
      '/app/shops/x/products',
      '/app/shops/x/settings/members?tab=1',
    ]) {
      const res = await t.app.request(path, { headers: { cookie } });
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body).toContain('<script type="module" src="/app/assets/app.js"></script>');
      expect(body).toContain('<link rel="stylesheet" href="/app/assets/app.css">');
      expect(body).toContain('data-email="shell@example.test"');
      expect(body).not.toMatch(/<script>|<style|style="/);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('wasm');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('sends a signed-out visitor to sign in and back to the same route', async () => {
    const res = await t.app.request('/app/shops/abc/activity?x=1');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `/auth/login?return_to=${encodeURIComponent('/app/shops/abc/activity?x=1')}`,
    );
  });

  it('answers 404 for a missing built file instead of the shell', async () => {
    const res = await t.app.request('/app/assets/missing-abc123.js', { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });

  it('leaves every other path to the Worker', async () => {
    expect((await t.app.request('/auth/login')).status).toBe(200);
    expect((await t.app.request('/api/v1/shops')).status).toBe(401);
    expect((await t.app.request('/application')).status).toBe(404);
  });
});

describe('rate limits (D11, plan 5.15)', () => {
  it('match the bindings in wrangler.jsonc', async () => {
    const text = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as {
      ratelimits: Array<{ name: string; simple: { limit: number; period: number } }>;
    };
    const byName = Object.fromEntries(config.ratelimits.map((r) => [r.name, r.simple]));
    const expected = {
      RATE_LIMIT_SESSION: RATE_LIMITS.session.perSecond,
      RATE_LIMIT_API: RATE_LIMITS.api_credential.perSecond,
      RATE_LIMIT_MCP: RATE_LIMITS.connection.perSecond,
      RATE_LIMIT_CLIENT_EVENTS: RATE_LIMITS.client_events.perSecond,
    };
    for (const [name, perSecond] of Object.entries(expected)) {
      expect(byName[name]).toEqual({
        limit: perSecond * RATE_LIMIT_PERIOD_SECONDS,
        period: RATE_LIMIT_PERIOD_SECONDS,
      });
    }
  });

  let t: TestApp;
  let shop: SeededShop;
  beforeAll(async () => {
    t = await testApp({
      rateLimiter: memoryLimiter({
        api_credential: 3,
        connection: 2,
        session: 5,
        client_events: 1,
      }),
    });
    shop = await seedShop(t.db, t.sink, 'Limits shop');
  });
  afterAll(() => t.close());

  it('refuses an API credential past its limit with 429 before any queue send', async () => {
    const { token } = await apiToken(t, shop, ['shop:read']);
    const statuses: number[] = [];
    const before = t.sink.events.length;
    for (let i = 0; i < 6; i++) {
      const res = await t.app.request(`/api/v1/shops/${shop.shopId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(res.headers.get('retry-after')).toBe(String(RATE_LIMIT_PERIOD_SECONDS));
        expect((await json(res)).code).toBe('rate_limited');
      }
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
    const sent = t.sink.events.slice(before);
    // Three allowed reads, each with one access event, and one summary for three refusals.
    expect(sent.filter((e) => e.action === 'shop.context.viewed')).toHaveLength(3);
    const summaries = sent.filter((e) => e.action === 'ratelimit.exceeded');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      outcome: 'denied',
      actor_type: 'api_credential',
      shop_id: shop.shopId,
      target_id: 'api_credential',
    });
  });

  it('limits an MCP connection by its grant', async () => {
    const grant = await connectionGrant(shop, ['shop:read']);
    const token = await t.sign({
      sub: grant.sub,
      client_id: grant.clientId,
      [GRANT_CLAIM]: grant.grantId,
    });
    const call = () =>
      t.app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await call()).status);
    expect(statuses).toEqual([200, 200, 429, 429]);
    expect(
      t.sink.events.filter(
        (e) => e.action === 'ratelimit.exceeded' && e.actor_type === 'connection',
      ),
    ).toHaveLength(1);
  });

  it('records one summary per caller per minute, carrying the previous minute’s count', () => {
    let now = Date.UTC(2026, 10, 15, 10, 0, 5);
    const recorder = new RefusalRecorder(() => now);
    const caller = {
      kind: 'user',
      id: 'u1',
      userId: 'u1',
      boundShopId: null,
      membership: null,
      scopes: 'all',
      source: 'dashboard',
    } as const;
    const first = recorder.refused(caller, 'session', null, uuidv7());
    expect(first?.action).toBe('ratelimit.exceeded');
    for (let i = 0; i < 9; i++)
      expect(recorder.refused(caller, 'session', null, uuidv7())).toBeNull();
    now += 60_000;
    const next = recorder.refused(caller, 'session', null, uuidv7());
    expect(next?.context).toMatchObject({ previousWindow: { refused: 10 } });
  });
});

describe('client-reported events (plan 5.14)', () => {
  let t: TestApp;
  let cookie: string;
  let shopId: string;
  beforeAll(async () => {
    t = await testApp({ rateLimiter: memoryLimiter({ client_events: 1 }, 1000) });
    ({ cookie } = await signInAs(t, {
      id: `user_${uuidv7()}`,
      email: 'events@example.test',
      firstName: null,
      lastName: null,
    }));
    const created = await t.app.request('/api/v1/shops', {
      method: 'POST',
      headers: {
        cookie,
        'x-airstock-request': '1',
        origin: PUBLIC_URL,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Events shop', currency: 'EUR', timezone: 'Europe/Berlin' }),
    });
    shopId = (await json(created)).shopId;
  });
  afterAll(() => t.close());

  const post = (events: unknown[], headers: Record<string, string> = {}) =>
    t.app.request(`/api/v1/shops/${shopId}/activity/client-events`, {
      method: 'POST',
      headers: {
        cookie,
        'x-airstock-request': '1',
        origin: PUBLIC_URL,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ events }),
    });

  it('stores a batch as client-reported events in audit_events, once per event ID', async () => {
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    const events = [
      {
        eventId: ids[0],
        seq: 1,
        type: 'grid.column_resized',
        details: { column: 'sku', width: 140 },
      },
      {
        eventId: ids[1],
        seq: 2,
        type: 'detail_panel.opened',
        targetType: 'variant',
        targetId: uuidv7(),
      },
      { eventId: ids[2], seq: 3, type: 'view.type_switched', details: { to: 'gallery' } },
      { eventId: ids[2], seq: 3, type: 'view.type_switched', details: { to: 'gallery' } },
    ];
    const res = await post(events);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ accepted: 3, duplicates: 1, rejected: 0 });
    await new Promise((r) => setTimeout(r, 1100));
    // The same batch again, as after a lost response: nothing new lands.
    expect((await post(events.slice(0, 3))).status).toBe(200);
    await t.sink.drain(t.db);
    const rows = await ownerQuery<{
      event_id: string;
      action: string;
      source: string;
      context: { clientReported: boolean; clientSeq: number };
    }>(
      `select event_id, action, source, context from audit_events
       where event_id = any($1::uuid[]) order by (context->>'clientSeq')::int`,
      [ids],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'client.grid.column_resized',
      'client.detail_panel.opened',
      'client.view.type_switched',
    ]);
    expect(rows.every((r) => r.context.clientReported && r.source === 'dashboard')).toBe(true);
    const receipts = await ownerQuery(
      'select 1 from audit_events where shop_id = $1 and action = $2',
      [shopId, 'activity.client_events.received'],
    );
    expect(receipts).toHaveLength(2);
  });

  it('drops events dated too far in the past or future', async () => {
    await new Promise((r) => setTimeout(r, 1100));
    const res = await post([
      { eventId: uuidv7(Date.now() - 2 * 24 * 3600_000), seq: 1, type: 'page.viewed' },
      { eventId: uuidv7(Date.now() + 3600_000), seq: 2, type: 'page.viewed' },
    ]);
    expect(await json(res)).toEqual({ accepted: 0, duplicates: 0, rejected: 2 });
  });

  it('allows one batch per second per user', async () => {
    await new Promise((r) => setTimeout(r, 1100));
    const first = await post([{ eventId: uuidv7(), seq: 9, type: 'page.viewed' }]);
    const second = await post([{ eventId: uuidv7(), seq: 10, type: 'page.viewed' }]);
    expect([first.status, second.status]).toEqual([200, 429]);
  });

  it('accepts no unknown event type and is not open to API credentials', async () => {
    await new Promise((r) => setTimeout(r, 1100));
    expect((await post([{ eventId: uuidv7(), seq: 1, type: 'catalog.deleted' }])).status).toBe(400);
    const shop = await seedShop(t.db, t.sink, 'Token shop');
    const { token } = await apiToken(t, shop, ['shop:read']);
    const res = await t.app.request(`/api/v1/shops/${shop.shopId}/activity/client-events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ eventId: uuidv7(), seq: 1, type: 'page.viewed' }] }),
    });
    expect(res.status).toBe(403);
  });
});

describe('audit queue messages', () => {
  it('packs one send into one message and splits only past the size limit', () => {
    const event = (n: number) => ({
      event_id: uuidv7(),
      action: `a${n}`,
      context: { pad: 'x'.repeat(2000) },
    });
    // biome-ignore lint/suspicious/noExplicitAny: shape-only test events
    const small = packAuditEvents([event(1), event(2)] as any);
    expect(small).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: shape-only test events
    const big = packAuditEvents(Array.from({ length: 100 }, (_, i) => event(i)) as any);
    expect(big.length).toBeGreaterThan(1);
    expect(unpackAuditMessages(big)).toHaveLength(100);
    // A single-event message from before packing is still read.
    expect(unpackAuditMessages([{ event_id: 'x' }, { events: [{ event_id: 'y' }] }])).toHaveLength(
      2,
    );
  });
});
