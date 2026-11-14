import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiToken, shopWithStock, type TestApp, testApp } from './setup.ts';

let t: TestApp;
let published = 0;

beforeAll(async () => {
  t = await testApp({
    dispatch: async () => {
      published++;
      return 0;
    },
  });
});
afterAll(() => t.close());

describe('outbox publishing', () => {
  it('publishes right after a command that wrote outbox events, not after a read', async () => {
    const { shop, variantId } = await shopWithStock(t, 'Publish shop');
    const { token } = await apiToken(t, shop, ['inventory:read', 'inventory:write']);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const read = await t.app.request(
      `/api/v1/shops/${shop.shopId}/availability?variantId=${variantId}`,
      { headers },
    );
    expect(read.status).toBe(200);
    expect(published).toBe(0);
    const reserve = await t.app.request(`/api/v1/shops/${shop.shopId}/reservations`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ variantId, quantity: '1' }),
    });
    expect(reserve.status).toBe(201);
    await new Promise((r) => setTimeout(r, 10));
    expect(published).toBe(1);
  });
});
