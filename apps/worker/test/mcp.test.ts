import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery, type SeededShop } from '../../../test/helpers.ts';
import { connectMcp, grantToken, mcpSession } from './mcp-client.ts';
import {
  connectionGrant,
  GRANT_CLAIM,
  json,
  shopWithStock,
  type TestApp,
  testApp,
} from './setup.ts';

// The MCP endpoint and connection rules (plan Section 7). Each area's tool tests live with
// that area's tests; the tool list is in mcp-tools.test.ts.

let t: TestApp;
let shop: SeededShop;
let other: SeededShop;
let variantId: string;
let otherVariantId: string;

beforeAll(async () => {
  t = await testApp();
  ({ shop, variantId } = await shopWithStock(t, 'MCP shop'));
  ({ shop: other, variantId: otherVariantId } = await shopWithStock(t, 'Other MCP shop'));
});
afterAll(() => t.close());

describe('MCP endpoint (plan Section 7)', () => {
  it('challenges requests without a token and publishes protected-resource metadata', async () => {
    const res = await t.app.request('/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
    const meta = await json(await t.app.request('/.well-known/oauth-protected-resource'));
    expect(meta.authorization_servers).toEqual(['https://auth.test.example']);
    expect(meta.scopes_supported).toContain('offline_access');
  });

  it('refuses writes beyond the grant regardless of the prompt (A15)', async () => {
    const mcp = await mcpSession(t, shop, ['inventory:read']);
    const res = await mcp.call('reserve_stock', { action: 'reserve', variantId, quantity: '1' });
    expect(res.error).toBe(true);
    expect(res.body).toMatchObject({ code: 'forbidden' });
    await mcp.close();
  });

  it('stays bound to the granted shop, whatever the arguments name (A13)', async () => {
    const mcp = await mcpSession(t, shop, ['inventory:read']);
    const res = await mcp.call('get_availability', {
      variantId: otherVariantId,
      shopId: other.shopId,
    });
    expect(res.error).toBe(true);
    expect(res.body).toMatchObject({ status: 404 });
    await mcp.close();
  });

  it('stops working on the next call after revocation, with the token still valid (A16)', async () => {
    const grant = await connectionGrant(shop, ['inventory:read']);
    const token = await grantToken(t, grant);
    const mcp = await connectMcp(t, token);
    expect((await mcp.call('get_availability', { variantId })).error).toBe(false);
    await ownerQuery(`update connection_grants set status = 'revoked' where id = $1`, [
      grant.grantId,
    ]);
    await expect(mcp.call('get_availability', { variantId })).rejects.toThrow();
    const raw = await t.app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(raw.status).toBe(401);
  });

  it('rejects a grant presented by a different user or client', async () => {
    const grant = await connectionGrant(shop, ['inventory:read']);
    const wrongUser = await t.sign({
      sub: 'someone-else',
      client_id: grant.clientId,
      [GRANT_CLAIM]: grant.grantId,
    });
    const wrongClient = await t.sign({
      sub: grant.sub,
      client_id: 'other-client',
      [GRANT_CLAIM]: grant.grantId,
    });
    for (const token of [wrongUser, wrongClient]) {
      const res = await t.app.request('/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: '{}',
      });
      expect(res.status).toBe(401);
    }
  });
});
