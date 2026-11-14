import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery, type SeededShop } from '../../../test/helpers.ts';
import { apiToken, json, shopWithStock, type TestApp, testApp } from './setup.ts';

let t: TestApp;
let shop: SeededShop;
let other: SeededShop;
let variantId: string;
let fullToken: string;
let readToken: string;

beforeAll(async () => {
  t = await testApp();
  ({ shop, variantId } = await shopWithStock(t, 'REST shop'));
  ({ shop: other } = await shopWithStock(t, 'Other REST shop'));
  fullToken = (
    await apiToken(t, shop, [
      'shop:read',
      'catalog:read',
      'catalog:write',
      'storage:read',
      'inventory:read',
      'inventory:write',
      'activity:read',
    ])
  ).token;
  readToken = (await apiToken(t, shop, ['inventory:read'])).token;
});
afterAll(() => t.close());

function call(path: string, init: RequestInit & { token?: string; key?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (init.key) headers.set('idempotency-key', init.key);
  if (init.body) headers.set('content-type', 'application/json');
  return t.app.request(`/api/v1${path}`, { ...init, headers });
}

describe('authentication (plan P3)', () => {
  it.each([
    ['no credential', undefined],
    ['a malformed token', 'nope'],
    ['an unknown credential', `ask_${'0'.repeat(32)}_${'a'.repeat(43)}`],
  ])('rejects %s with 401 before anything reaches the audit queue', async (_label, token) => {
    const before = t.sink.events.length;
    const res = await call(`/shops/${shop.shopId}/availability?variantId=${variantId}`, { token });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect((await json(res)).code).toBe('unauthenticated');
    expect(t.sink.events.length).toBe(before);
  });

  it('rejects a revoked credential', async () => {
    const { token, credentialId } = await apiToken(t, shop, ['inventory:read']);
    expect(
      (await call(`/shops/${shop.shopId}/availability?variantId=${variantId}`, { token })).status,
    ).toBe(200);
    await ownerQuery(`update api_credentials set status = 'revoked' where id = $1`, [credentialId]);
    expect(
      (await call(`/shops/${shop.shopId}/availability?variantId=${variantId}`, { token })).status,
    ).toBe(401);
  });
});

describe('REST routes generated from the registry', () => {
  it('runs the stock flow with idempotency over HTTP', async () => {
    const receipt = await call(`/shops/${shop.shopId}/receipts`, {
      method: 'POST',
      token: fullToken,
      key: 'receipt-1',
      body: JSON.stringify({ variantId, locationId: shop.locationId, quantity: '5' }),
    });
    expect(receipt.status).toBe(201);
    expect(receipt.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const replay = await call(`/shops/${shop.shopId}/receipts`, {
      method: 'POST',
      token: fullToken,
      key: 'receipt-1',
      body: JSON.stringify({ variantId, locationId: shop.locationId, quantity: '5' }),
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await json(replay)).toEqual(await json(receipt));

    const reserve = await call(`/shops/${shop.shopId}/reservations`, {
      method: 'POST',
      token: fullToken,
      key: 'reserve-1',
      body: JSON.stringify({ variantId, quantity: '4' }),
    });
    expect(reserve.status).toBe(201);
    const { reservationId } = await json(reserve);
    const release = await call(`/shops/${shop.shopId}/reservations/${reservationId}/release`, {
      method: 'POST',
      token: fullToken,
      key: 'release-1',
    });
    expect(release.status).toBe(200);
    expect((await json(release)).status).toBe('released');

    const view = await call(`/shops/${shop.shopId}/availability?variantId=${variantId}`, {
      token: fullToken,
    });
    expect((await json(view)).totals.onHand).toBe('15.000000');
  });

  it('refuses a write beyond the credential scopes, whatever the request says (A15)', async () => {
    const res = await call(`/shops/${shop.shopId}/reservations`, {
      method: 'POST',
      token: readToken,
      key: 'nope',
      body: JSON.stringify({ variantId, quantity: '1' }),
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('keeps credential management to interactive sessions', async () => {
    const res = await call(`/shops/${shop.shopId}/api-credentials`, {
      method: 'POST',
      token: fullToken,
      body: JSON.stringify({ name: 'x', scopes: ['inventory:read'] }),
    });
    expect(res.status).toBe(403);
  });

  it('answers not found for another shop’s path (A13)', async () => {
    const res = await call(`/shops/${other.shopId}/locations`, { token: fullToken });
    expect(res.status).toBe(404);
  });

  it('reports validation problems as RFC 9457 problem details', async () => {
    const missingKey = await call(`/shops/${shop.shopId}/receipts`, {
      method: 'POST',
      token: fullToken,
      body: JSON.stringify({ variantId, locationId: shop.locationId, quantity: '5' }),
    });
    expect(missingKey.status).toBe(400);
    const badJson = await call(`/shops/${shop.shopId}/receipts`, {
      method: 'POST',
      token: fullToken,
      key: 'k',
      body: '{',
    });
    expect(badJson.status).toBe(400);
    const badQuantity = await call(`/shops/${shop.shopId}/receipts`, {
      method: 'POST',
      token: fullToken,
      key: 'k2',
      body: JSON.stringify({ variantId, locationId: shop.locationId, quantity: '-1' }),
    });
    const body = await json(badQuantity);
    expect(body).toMatchObject({ code: 'validation_failed', status: 400 });
    expect(body.errors[0].path).toBe('quantity');
  });

  it('answers unknown routes with a problem document', async () => {
    const res = await call('/nope', { token: fullToken });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
  });
});
