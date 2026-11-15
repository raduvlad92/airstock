import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery, type SeededShop } from '../../../test/helpers.ts';
import {
  connectionGrant,
  GRANT_CLAIM,
  json,
  shopWithStock,
  type TestApp,
  testApp,
} from './setup.ts';

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

async function connect(token: string) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://airstock.test/mcp'), {
    fetch: async (url, init) => t.app.fetch(new Request(url, init)),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function parse(result: { content?: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content?.[0]?.text ?? 'null');
}

describe('MCP endpoint (plan Section 7)', () => {
  it('challenges requests without a token and publishes protected-resource metadata', async () => {
    const res = await t.app.request('/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
    const meta = await json(await t.app.request('/.well-known/oauth-protected-resource'));
    expect(meta.authorization_servers).toEqual(['https://auth.test.example']);
    expect(meta.scopes_supported).toContain('offline_access');
  });

  it('lists task-shaped tools and answers with the same scoped result as REST (A14)', async () => {
    const grant = await connectionGrant(shop, ['shop:read', 'inventory:read', 'catalog:read']);
    const client = await connect(
      await t.sign({ sub: grant.sub, client_id: grant.clientId, [GRANT_CLAIM]: grant.grantId }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([
      'describe_catalog',
      'edit_catalog',
      'get_availability',
      'get_operation_outcome',
      'get_shop_context',
      'import_export',
      'manage_catalog_schema',
      'manage_media',
      'manage_storage',
      'receive_stock',
      'reserve_stock',
      'search_activity',
      'search_catalog',
    ]);
    const context = parse(await client.callTool({ name: 'get_shop_context', arguments: {} }));
    expect(context.shop.id).toBe(shop.shopId);
    const stock = parse(
      await client.callTool({ name: 'get_availability', arguments: { variantId } }),
    );
    expect(stock.totals.available).toBe('10.000000');
    const access = t.sink.events.at(-1)!;
    expect(access).toMatchObject({
      source: 'mcp',
      actor_type: 'connection',
      grant_id: grant.grantId,
      client_id: 'chatgpt-test',
    });
    await client.close();
  });

  it('refuses writes beyond the grant regardless of the prompt (A15)', async () => {
    const grant = await connectionGrant(shop, ['inventory:read']);
    const client = await connect(
      await t.sign({ sub: grant.sub, client_id: grant.clientId, [GRANT_CLAIM]: grant.grantId }),
    );
    const res = await client.callTool({
      name: 'reserve_stock',
      arguments: { action: 'reserve', variantId, quantity: '1' },
    });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ code: 'forbidden' });
    await client.close();
  });

  it('reserves within a write grant, idempotently when the client retries with a key', async () => {
    const grant = await connectionGrant(shop, ['inventory:read', 'inventory:write']);
    const client = await connect(
      await t.sign({ sub: grant.sub, client_id: grant.clientId, [GRANT_CLAIM]: grant.grantId }),
    );
    const args = { action: 'reserve', variantId, quantity: '2', idempotency_key: 'chat-turn-7' };
    const first = parse(await client.callTool({ name: 'reserve_stock', arguments: args }));
    const again = parse(await client.callTool({ name: 'reserve_stock', arguments: args }));
    expect(again).toEqual({ ...first, replayed: true });
    await client.close();
  });

  it('stays bound to the granted shop, whatever the arguments name (A13)', async () => {
    const grant = await connectionGrant(shop, ['inventory:read']);
    const client = await connect(
      await t.sign({ sub: grant.sub, client_id: grant.clientId, [GRANT_CLAIM]: grant.grantId }),
    );
    const res = await client.callTool({
      name: 'get_availability',
      arguments: { variantId: otherVariantId, shopId: other.shopId },
    });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ status: 404 });
    await client.close();
  });

  it('stops working on the next call after revocation, with the token still valid (A16)', async () => {
    const grant = await connectionGrant(shop, ['inventory:read']);
    const token = await t.sign({
      sub: grant.sub,
      client_id: grant.clientId,
      [GRANT_CLAIM]: grant.grantId,
    });
    const client = await connect(token);
    expect(
      (await client.callTool({ name: 'get_availability', arguments: { variantId } })).isError,
    ).toBeFalsy();
    await ownerQuery(`update connection_grants set status = 'revoked' where id = $1`, [
      grant.grantId,
    ]);
    await expect(
      client.callTool({ name: 'get_availability', arguments: { variantId } }),
    ).rejects.toThrow();
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
