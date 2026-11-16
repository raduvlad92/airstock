import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SeededShop } from '../../../test/helpers.ts';
import { mcpSession } from './mcp-client.ts';
import { shopWithStock, type TestApp, testApp } from './setup.ts';

let t: TestApp;
let shop: SeededShop;
let variantId: string;

beforeAll(async () => {
  t = await testApp();
  ({ shop, variantId } = await shopWithStock(t, 'Inventory MCP shop'));
});
afterAll(() => t.close());

describe('stock over MCP', () => {
  it('answers with the same scoped result as REST, logged as the connection (A14)', async () => {
    const mcp = await mcpSession(t, shop, ['shop:read', 'inventory:read', 'catalog:read']);
    const context = await mcp.call('get_shop_context');
    expect(context.body.shop.id).toBe(shop.shopId);
    const stock = await mcp.call('get_availability', { variantId });
    expect(stock.body.totals.available).toBe('10.000000');
    expect(t.sink.events.at(-1)!).toMatchObject({
      source: 'mcp',
      actor_type: 'connection',
      grant_id: mcp.grantId,
      client_id: 'chatgpt-test',
    });
    await mcp.close();
  });

  it('reserves within a write grant, idempotently when the client retries with a key', async () => {
    const mcp = await mcpSession(t, shop, ['inventory:read', 'inventory:write']);
    const args = { action: 'reserve', variantId, quantity: '2', idempotency_key: 'chat-turn-7' };
    const first = await mcp.call('reserve_stock', args);
    const again = await mcp.call('reserve_stock', args);
    expect(first.error).toBe(false);
    expect(again.body).toEqual({ ...first.body, replayed: true });
    await mcp.close();
  });
});
