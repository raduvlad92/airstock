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
    const stock = await mcp.call('get_stock', { action: 'stock', variantId });
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
    const first = await mcp.call('manage_reservations', args);
    const again = await mcp.call('manage_reservations', args);
    expect(first.error).toBe(false);
    expect(again.body).toEqual({ ...first.body, replayed: true });
    await mcp.close();
  });

  it('fulfills, lists, and reads stock and lots through the Phase 2 tools', async () => {
    const mcp = await mcpSession(t, shop, ['inventory:read', 'inventory:write']);
    const reserved = await mcp.call('manage_reservations', {
      action: 'reserve',
      variantId,
      quantity: '1',
      externalRef: 'mcp-order-1',
      idempotency_key: 'mcp-reserve-2',
    });
    expect(reserved.error).toBe(false);
    const shipped = await mcp.call('manage_reservations', {
      action: 'fulfill',
      reservationId: reserved.body.reservationId,
      idempotency_key: 'mcp-fulfill-1',
    });
    expect(shipped.body).toMatchObject({ fulfilled: '1', status: 'fulfilled' });
    const listed = await mcp.call('manage_reservations', {
      action: 'list',
      externalRef: 'mcp-order-1',
      status: 'all',
    });
    expect(listed.body.reservations).toHaveLength(1);
    const lots = await mcp.call('get_stock', { action: 'lots', variantId });
    expect(lots.body.lots).toEqual([]);
    const stock = await mcp.call('get_stock', { action: 'stock', variantId });
    expect(stock.body).toMatchObject({ costVisible: true, totals: { shortage: '0.000000' } });
    await mcp.close();
  });
});
