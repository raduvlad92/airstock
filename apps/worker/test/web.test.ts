import { sweepUnboundConnectionGrants, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../../test/helpers.ts';
import { seal, unseal } from '../src/session.ts';
import { safeReturnTo } from '../src/web.ts';
import type { WorkosUser } from '../src/workos.ts';
import { GRANT_CLAIM, ISSUER, json, PUBLIC_URL, type TestApp, testApp } from './setup.ts';

let t: TestApp;

beforeAll(async () => {
  t = await testApp();
});
afterAll(() => t.close());

const ORIGIN = { origin: PUBLIC_URL };

function cookiesFrom(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair!.indexOf('=');
    out[pair!.slice(0, eq)] = pair!.slice(eq + 1);
  }
  return out;
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function form(values: Record<string, string | string[]>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    for (const v of [value].flat()) body.append(key, v);
  }
  return body;
}

function newUser(): WorkosUser {
  const id = `user_${uuidv7().replace(/-/g, '')}`;
  return { id, email: `${id}@example.com`, firstName: 'Ana', lastName: null };
}

/** Signs in through the provider flow and returns the session cookie header. */
async function signIn(user: WorkosUser, returnTo = '/app') {
  const code = `code-${user.id}`;
  t.workos.addUser(code, user);
  const start = await t.app.request(`/auth/oauth/google?return_to=${encodeURIComponent(returnTo)}`);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const callback = await t.app.request(`/auth/callback?code=${code}&state=${state}`, {
    headers: { cookie: cookieHeader(cookiesFrom(start)) },
  });
  expect(callback.status).toBe(303);
  expect(callback.headers.get('location')).toBe(returnTo);
  return { cookie: cookieHeader(cookiesFrom(callback)), res: callback };
}

async function dashboardApi(cookie: string, path: string, init: RequestInit = {}) {
  return t.app.request(`/api/v1${path}`, {
    ...init,
    headers: {
      cookie,
      'x-airstock-request': '1',
      'content-type': 'application/json',
      ...ORIGIN,
      ...(init.headers ?? {}),
    },
  });
}

async function createShop(cookie: string, name: string): Promise<string> {
  const res = await dashboardApi(cookie, '/shops', {
    method: 'POST',
    body: JSON.stringify({ name, currency: 'EUR', timezone: 'Europe/Bucharest' }),
  });
  expect(res.status).toBe(201);
  return (await json(res)).shopId;
}

/** Runs the consent step and returns the grant ID WorkOS was asked to put in the token. */
async function approve(
  cookie: string,
  shopId: string,
  scopes: string[],
  externalAuthId = `ext_${uuidv7().replace(/-/g, '')}`,
) {
  const consent = await t.app.request(`/connect/login?external_auth_id=${externalAuthId}`, {
    headers: { cookie },
  });
  expect(consent.status).toBe(200);
  const page = await consent.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
  const res = await t.app.request('/connect/approve', {
    method: 'POST',
    headers: { cookie, ...ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ external_auth_id: externalAuthId, csrf, shop_id: shopId, scope: scopes }),
  });
  return { res, externalAuthId, csrf };
}

async function mcpCall(token: string, tool: string, args: Record<string, unknown> = {}) {
  return t.app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
}

describe('sealed cookies', () => {
  it('round-trips and rejects tampering, another purpose, and expiry', async () => {
    const secret = 'unit-secret-0123456789';
    const exp = Math.floor(Date.now() / 1000) + 60;
    const value = await seal(secret, 'session', { uid: 'u', exp });
    expect(await unseal(secret, 'session', value)).toMatchObject({ uid: 'u' });
    const flipped = value.slice(0, -2) + (value.endsWith('A') ? 'BB' : 'AA');
    expect(await unseal(secret, 'session', flipped)).toBeNull();
    expect(await unseal(secret, 'flow', value)).toBeNull();
    expect(await unseal('other-secret-0123456789', 'session', value)).toBeNull();
    const expired = await seal(secret, 'session', { uid: 'u', exp: exp - 120 });
    expect(await unseal(secret, 'session', expired)).toBeNull();
  });

  it('serves pages whose referrer policy keeps Origin on same-site form posts', async () => {
    const res = await t.app.request('/auth/login');
    // Under `no-referrer`, browsers send `Origin: null` on same-origin POSTs and every form
    // would be refused by the Origin check.
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(await res.text()).toContain('<meta name="referrer" content="same-origin">');
  });

  it('keeps sign-in redirects on this site', () => {
    expect(safeReturnTo('/connect/login?external_auth_id=abc')).toBe(
      '/connect/login?external_auth_id=abc',
    );
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'app', null]) {
      expect(safeReturnTo(bad)).toBe('/app');
    }
  });
});

describe('sign-in (plan M4)', () => {
  it('signs in with a provider and sets only a host-only session cookie', async () => {
    const user = newUser();
    const { res } = await signIn(user);
    const lines = res.headers.getSetCookie();
    const session = lines.find((l) => l.startsWith('__Host-airstock_session='))!;
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(session).toContain('SameSite=Lax');
    expect(session).toContain('Path=/');
    expect(session.toLowerCase()).not.toContain('domain=');
    const [row] = await ownerQuery<{ email: string }>(
      'select email from users where workos_user_id = $1',
      [user.id],
    );
    expect(row?.email).toBe(user.email);
  });

  it('rejects a callback whose state does not match the browser that started it', async () => {
    const user = newUser();
    t.workos.addUser('code-x', user);
    const start = await t.app.request('/auth/oauth/google');
    const res = await t.app.request('/auth/callback?code=code-x&state=forged', {
      headers: { cookie: cookieHeader(cookiesFrom(start)) },
    });
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie().some((l) => l.includes('airstock_session'))).toBe(false);
  });

  it('signs in with an emailed code, and refuses the form from another site', async () => {
    const user = newUser();
    t.workos.addUser(`magic-${user.id}`, user);
    const blocked = await t.app.request('/auth/magic/send', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: form({ email: user.email }),
    });
    expect(blocked.status).toBe(403);
    expect(t.workos.sentCodes).not.toContain(user.email);

    const sent = await t.app.request('/auth/magic/send', {
      method: 'POST',
      headers: { ...ORIGIN },
      body: form({ email: user.email, return_to: '/app' }),
    });
    expect(sent.status).toBe(200);
    expect(t.workos.sentCodes).toContain(user.email);
    const flow = cookieHeader(cookiesFrom(sent));

    const wrong = await t.app.request('/auth/magic/verify', {
      method: 'POST',
      headers: { ...ORIGIN, cookie: flow },
      body: form({ code: '000000' }),
    });
    expect(wrong.status).toBe(400);
    const right = await t.app.request('/auth/magic/verify', {
      method: 'POST',
      headers: { ...ORIGIN, cookie: flow },
      body: form({ code: '123456' }),
    });
    expect(right.status).toBe(303);
    expect(cookiesFrom(right)['__Host-airstock_session']).toBeTruthy();
  });

  it('serves the dashboard API to a session only with the custom header from this site', async () => {
    const { cookie } = await signIn(newUser());
    await createShop(cookie, 'Session shop');
    const noHeader = await t.app.request('/api/v1/shops', { headers: { cookie } });
    expect(noHeader.status).toBe(401);
    const crossSite = await dashboardApi(cookie, '/shops', {
      headers: { origin: 'https://evil.example' },
    });
    expect(crossSite.status).toBe(401);
    const ok = await dashboardApi(cookie, '/shops');
    expect(ok.status).toBe(200);
    expect((await json(ok)).shops.map((s: { name: string }) => s.name)).toEqual(['Session shop']);
    // An account-level read is audited without inventing a shop.
    const listed = t.sink.events.filter((e) => e.action === 'shops.listed').at(-1)!;
    expect(listed.shop_id).toBeNull();
  });
});

describe('connect consent and shop binding (plan Section 7.2, option A)', () => {
  it('sends a signed-out user to sign in and back to the consent step', async () => {
    const res = await t.app.request('/connect/login?external_auth_id=ext_123');
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!, PUBLIC_URL);
    expect(location.pathname).toBe('/auth/login');
    expect(location.searchParams.get('return_to')).toBe('/connect/login?external_auth_id=ext_123');
  });

  it('lets a user with no shop create one inside the consent step', async () => {
    const { cookie } = await signIn(newUser());
    const ext = 'ext_firstshop';
    const consent = await (
      await t.app.request(`/connect/login?external_auth_id=${ext}`, { headers: { cookie } })
    ).text();
    expect(consent).toContain('Create your first shop');
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent)![1]!;
    const res = await t.app.request('/connect/shop', {
      method: 'POST',
      headers: { cookie, ...ORIGIN },
      body: form({
        external_auth_id: ext,
        csrf,
        name: 'Atelier',
        currency: 'eur',
        timezone: 'Europe/Bucharest',
      }),
    });
    expect(res.status).toBe(303);
    const next = await t.app.request(res.headers.get('location')!, { headers: { cookie } });
    expect(await next.text()).toContain('Atelier');
  });

  it('meets all five pass criteria', async () => {
    const user = newUser();
    const { cookie } = await signIn(user);
    const shopA = await createShop(cookie, 'Shop A');
    const shopB = await createShop(cookie, 'Shop B');
    const item = await dashboardApi(cookie, `/shops/${shopB}/items`, {
      method: 'POST',
      headers: { 'idempotency-key': uuidv7() },
      body: JSON.stringify({ name: 'Secret B item', sku: 'SECRET-B' }),
    });
    expect(item.status).toBe(201);

    const { res, externalAuthId } = await approve(cookie, shopA, [
      'shop:read',
      'inventory:read',
      'catalog:read',
    ]);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${ISSUER}/oauth2/consent?ext=${externalAuthId}`);
    const completed = t.workos.completed.at(-1)!;
    expect(completed.user.id).toBe(user.id);
    const option = completed.consent[0]!;
    expect(option.claim).toBe(GRANT_CLAIM);
    expect(option.choices).toHaveLength(1);
    const grantId = option.choices[0]!.value;
    expect(option.choices[0]!.label).toBe('Shop A (read only)');

    // 5. The scopes chosen at consent are the ones stored, and the grant is not yet bound.
    const [stored] = await ownerQuery<{
      shop_id: string;
      scopes: string[];
      client_id: string | null;
    }>('select shop_id, scopes, client_id from connection_grants where id = $1', [grantId]);
    expect(stored).toEqual({
      shop_id: shopA,
      scopes: ['shop:read', 'catalog:read', 'inventory:read'],
      client_id: null,
    });

    // The first verified token binds the grant to its client and subject.
    const claims = { sub: user.id, client_id: 'client_chatgpt', [GRANT_CLAIM]: grantId };
    const first = await mcpCall(await t.sign(claims), 'get_shop_context');
    expect(first.status).toBe(200);
    expect(await first.text()).toContain(shopA);

    // 1. A refreshed token (new jti and expiry, same claims) keeps working on the same shop.
    const refreshed = await mcpCall(await t.sign({ ...claims, jti: uuidv7() }), 'get_shop_context');
    expect(await refreshed.text()).toContain(shopA);

    // 2. Nothing in the arguments can reach shop B, and another client or user cannot use the grant.
    const search = await (
      await mcpCall(await t.sign(claims), 'find_items', { query: 'Secret' })
    ).text();
    expect(search).toContain('variants');
    expect(search).not.toContain('isError');
    expect(search).not.toContain('Secret B item');
    const crossShop = await mcpCall(await t.sign(claims), 'find_items', {
      query: 'Secret',
      shopId: shopB,
    });
    expect(await crossShop.text()).not.toContain('Secret B item');
    const otherClient = await mcpCall(
      await t.sign({ ...claims, client_id: 'client_other' }),
      'get_shop_context',
    );
    expect(otherClient.status).toBe(401);
    const otherUser = await mcpCall(
      await t.sign({ ...claims, sub: 'user_other' }),
      'get_shop_context',
    );
    expect(otherUser.status).toBe(401);

    // 4. Creating or switching shops in the dashboard does not move the connection.
    await createShop(cookie, 'Shop C');
    const still = await mcpCall(await t.sign(claims), 'get_shop_context');
    expect(await still.text()).toContain(shopA);

    // The dashboard lists the bound connection; 3. revoking it blocks the next call.
    const listed = await json(await dashboardApi(cookie, `/shops/${shopA}/connections`));
    const row = listed.connections.find((c: { grantId: string }) => c.grantId === grantId);
    expect(row).toMatchObject({ clientId: 'client_chatgpt', status: 'active' });
    expect(row.boundAt).not.toBeNull();
    const revoked = await dashboardApi(cookie, `/shops/${shopA}/connections/${grantId}/revoke`, {
      method: 'POST',
    });
    expect(revoked.status).toBe(200);
    const after = await mcpCall(await t.sign(claims), 'get_shop_context');
    expect(after.status).toBe(401);
  });

  it('refuses a forged or cross-site consent form', async () => {
    const { cookie } = await signIn(newUser());
    const shop = await createShop(cookie, 'Forge shop');
    const before = t.workos.completed.length;
    const forged = await t.app.request('/connect/approve', {
      method: 'POST',
      headers: { cookie, ...ORIGIN },
      body: form({
        external_auth_id: 'ext_forged',
        csrf: 'nope',
        shop_id: shop,
        scope: 'shop:read',
      }),
    });
    expect(forged.status).toBe(403);
    const { csrf, externalAuthId } = await approve(cookie, shop, ['shop:read']);
    const crossSite = await t.app.request('/connect/approve', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
      body: form({ external_auth_id: externalAuthId, csrf, shop_id: shop, scope: 'shop:read' }),
    });
    expect(crossSite.status).toBe(403);
    expect(t.workos.completed.length).toBe(before + 1);
  });

  it('refuses a shop the user is not a member of', async () => {
    const owner = await signIn(newUser());
    const foreignShop = await createShop(owner.cookie, 'Not yours');
    const { cookie } = await signIn(newUser());
    await createShop(cookie, 'Yours');
    const { res } = await approve(cookie, foreignShop, ['shop:read']);
    expect(res.status).toBe(400);
    const [count] = await ownerQuery<{ n: number }>(
      'select count(*)::int as n from connection_grants where shop_id = $1',
      [foreignShop],
    );
    expect(count?.n).toBe(0);
  });

  it('revokes the grant when WorkOS refuses to complete the authorization', async () => {
    const { cookie } = await signIn(newUser());
    const shop = await createShop(cookie, 'Expired shop');
    t.workos.failComplete = true;
    try {
      const { res } = await approve(cookie, shop, ['shop:read']);
      expect(res.status).toBe(400);
    } finally {
      t.workos.failComplete = false;
    }
    const rows = await ownerQuery<{ status: string }>(
      'select status from connection_grants where shop_id = $1',
      [shop],
    );
    expect(rows.map((r) => r.status)).toEqual(['revoked']);
  });

  it('expires a grant that no client binds within the bind window (report P15)', async () => {
    const user = newUser();
    const { cookie } = await signIn(user);
    const shop = await createShop(cookie, 'Abandoned shop');
    const grantOf = () => t.workos.completed.at(-1)!.consent[0]!.choices[0]!.value;
    // Approved in Airstock, then abandoned on the WorkOS screen: no client ever gets a token.
    await approve(cookie, shop, ['shop:read']);
    const abandoned = grantOf();
    // Approved and used at once, as ChatGPT does.
    await approve(cookie, shop, ['shop:read']);
    const used = grantOf();
    const usedClaims = { sub: user.id, client_id: 'client_used', [GRANT_CLAIM]: used };
    expect((await mcpCall(await t.sign(usedClaims), 'get_shop_context')).status).toBe(200);
    await ownerQuery(
      `update connection_grants set created_at = now() - interval '11 minutes'
       where id = any($1::uuid[])`,
      [[abandoned, used]],
    );

    // Before any sweep: listed as expired, not revocable, and a late token cannot bind it.
    const listed = await json(await dashboardApi(cookie, `/shops/${shop}/connections`));
    const statusOf = (id: string) =>
      listed.connections.find((c: { grantId: string }) => c.grantId === id)?.status;
    expect(statusOf(abandoned)).toBe('expired');
    expect(statusOf(used)).toBe('active');
    const revoke = await dashboardApi(cookie, `/shops/${shop}/connections/${abandoned}/revoke`, {
      method: 'POST',
    });
    expect(revoke.status).toBe(409);
    const late = await mcpCall(
      await t.sign({ sub: user.id, client_id: 'client_late', [GRANT_CLAIM]: abandoned }),
      'get_shop_context',
    );
    expect(late.status).toBe(401);

    // The sweep records the expiry once, as the system; the bound grant keeps working.
    expect(await sweepUnboundConnectionGrants(t.db)).toBeGreaterThanOrEqual(1);
    await sweepUnboundConnectionGrants(t.db);
    const rows = await ownerQuery<{ id: string; status: string; client_id: string | null }>(
      'select id, status, client_id from connection_grants where shop_id = $1 order by id',
      [shop],
    );
    expect(rows).toEqual([
      { id: abandoned, status: 'expired', client_id: null },
      { id: used, status: 'active', client_id: 'client_used' },
    ]);
    const events = await ownerQuery(
      `select target_id, actor_type, actor_id, source, outcome from audit_events
       where shop_id = $1 and action = 'connection.expired'`,
      [shop],
    );
    expect(events).toEqual([
      {
        target_id: abandoned,
        actor_type: 'system',
        actor_id: 'connection-expiry',
        source: 'scheduled',
        outcome: 'succeeded',
      },
    ]);
    expect((await mcpCall(await t.sign(usedClaims), 'get_shop_context')).status).toBe(200);
  });

  it('rejects tokens issued to an agent identity rather than a person', async () => {
    const user = newUser();
    const { cookie } = await signIn(user);
    const shop = await createShop(cookie, 'Agent shop');
    await approve(cookie, shop, ['shop:read']);
    const grantId = t.workos.completed.at(-1)!.consent[0]!.choices[0]!.value;
    const res = await mcpCall(
      await t.sign({
        sub: user.id,
        client_id: 'client_agent',
        sub_profile: 'ai_agent',
        [GRANT_CLAIM]: grantId,
      }),
      'get_shop_context',
    );
    expect(res.status).toBe(401);
  });
});
