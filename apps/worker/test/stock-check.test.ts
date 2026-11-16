import { reconcileShop } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery, type SeededShop } from '../../../test/helpers.ts';
import { mcpSession } from './mcp-client.ts';
import { apiToken, json, shopWithStock, type TestApp, testApp } from './setup.ts';

// The stock check (D18) over REST and MCP: the status read, the repair preview, and the repair.

let t: TestApp;
let shop: SeededShop;
let variantId: string;
let positionId: string;
let token: string;

beforeAll(async () => {
  t = await testApp();
  ({ shop, variantId } = await shopWithStock(t, 'Stock check shop'));
  const [position] = await ownerQuery<{ id: string }>(
    'select id from inventory_positions where variant_id = $1',
    [variantId],
  );
  positionId = position!.id;
  token = (await apiToken(t, shop, ['inventory:read', 'inventory:write'])).token;
});
afterAll(() => t.close());

function call(path: string, init: RequestInit & { key?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (init.key) headers.set('idempotency-key', init.key);
  if (init.body) headers.set('content-type', 'application/json');
  return t.app.request(`/api/v1/shops/${shop.shopId}${path}`, { ...init, headers });
}

describe('stock check over REST and MCP (D18)', () => {
  it('reports, previews, and repairs a corrupted balance', async () => {
    await ownerQuery('update inventory_positions set on_hand = on_hand - 2 where id = $1', [
      positionId,
    ]);
    await reconcileShop(t.db, shop.shopId, 'scheduled');

    const status = await call('/stock-check');
    expect(status.status).toBe(200);
    const body = await json(status);
    expect(body.lastCheck).toMatchObject({ trigger: 'scheduled', problemCount: 2 });
    expect(body.alert).toMatchObject({ status: 'open' });

    const preview = await call(
      `/stock-check/repair-preview?problem=on_hand_mismatch&targetId=${positionId}`,
    );
    expect(preview.status).toBe(200);
    const plan = await json(preview);
    expect(plan.repair).toMatchObject({ field: 'history', from: '10', to: '8', delta: '-2' });

    const repair = {
      problem: 'on_hand_mismatch',
      targetId: positionId,
      expected: plan.problem.expected,
      actual: plan.problem.actual,
      reason: 'Two units were found missing at the last count.',
    };
    const unconfirmed = await call('/stock-check/repairs', {
      method: 'POST',
      key: 'repair-unconfirmed',
      body: JSON.stringify(repair),
    });
    expect(unconfirmed.status).toBe(400);
    const committed = await call('/stock-check/repairs', {
      method: 'POST',
      key: 'repair-1',
      body: JSON.stringify({ ...repair, confirm: true }),
    });
    expect(committed.status).toBe(201);
    expect((await json(committed)).repair).toMatchObject({ delta: '-2' });

    // Over MCP, get_stock reads the check; the repair stays in REST and the dashboard.
    const mcp = await mcpSession(t, shop, ['inventory:read']);
    const check = await mcp.call('get_stock', { action: 'stock_check' });
    expect(check.error).toBe(false);
    expect(check.body.current.problems).toEqual([
      expect.objectContaining({ problem: 'cost_quantity_mismatch', targetId: variantId }),
    ]);
    await mcp.close();
  });
});
