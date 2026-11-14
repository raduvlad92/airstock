import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiToken,
  connectionGrant,
  GRANT_CLAIM,
  shopWithStock,
  type TestApp,
  testApp,
} from './setup.ts';

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
    // A read: one access event on the queue, and its statements counted.
    expect(read.headers.get('server-timing')).toMatch(/queue;dur=[\d.]+;desc="sends 1, events 1"/);
    expect(read.headers.get('server-timing')).toMatch(/db;dur=[\d.]+;desc="tx \d+, sql \d+"/);
    const reserve = await t.app.request(`/api/v1/shops/${shop.shopId}/reservations`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ variantId, quantity: '1' }),
    });
    expect(reserve.status).toBe(201);
    // A command: the attempt event is the only queue send; the outcome commits with the change.
    expect(reserve.headers.get('server-timing')).toContain('desc="sends 1, events 1"');
    await new Promise((r) => setTimeout(r, 10));
    expect(published).toBe(1);
  });
});

describe('MCP request lifetime', () => {
  it('finishes the tool before the request ends, so its work is measured and its handle open', async () => {
    const { shop, variantId } = await shopWithStock(t, 'MCP lifetime shop');
    const grant = await connectionGrant(shop, ['inventory:read', 'inventory:write']);
    const token = await t.sign({
      sub: grant.sub,
      client_id: grant.clientId,
      [GRANT_CLAIM]: grant.grantId,
    });
    const before = published;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await t.app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      return { res, text: await res.text() };
    };
    const read = await call('get_availability', { variantId });
    expect(read.text).not.toContain('"isError":true');
    expect(read.res.headers.get('server-timing')).toContain('desc="sends 1, events 1"');
    const reserve = await call('reserve_stock', { action: 'reserve', variantId, quantity: '1' });
    expect(reserve.text).not.toContain('"isError":true');
    await new Promise((r) => setTimeout(r, 10));
    expect(published).toBe(before + 1);
  });
});
