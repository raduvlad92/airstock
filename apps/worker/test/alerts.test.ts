import { execute, ops, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SeededShop, seedShop } from '../../../test/helpers.ts';
import { mcpSession } from './mcp-client.ts';
import { apiToken, type Json, json, type TestApp, testApp } from './setup.ts';

// Reorder rules and alerts over REST and MCP (D12): manage_purchasing sets a rule and suggests
// orders from low stock; stock_alerts lists, counts, and acknowledges, and sets preferences.

let t: TestApp;
let shop: SeededShop;

beforeAll(async () => {
  t = await testApp();
  shop = await seedShop(t.db, t.sink, 'Worker alerts shop');
});
afterAll(() => t.close());

async function run(op: (typeof ops)[keyof typeof ops], input: unknown): Promise<Json> {
  const res = await execute({ db: t.db, audit: t.sink }, op as never, {
    caller: shop.caller,
    shopId: shop.shopId,
    input,
    idempotencyKey: uuidv7(),
  });
  return res.result as Json;
}

describe('stock_alerts and reorder rules over MCP', () => {
  it('sets a rule, lists the alert it opens, suggests an order, and acknowledges', async () => {
    const supplier = await run(ops.createSupplier, { name: 'MCP alerts supplier' });
    const item = await run(ops.createItem, { name: 'Tea', sku: `TEA-${uuidv7().slice(-6)}` });
    await run(ops.saveSupplierItem, {
      supplierId: supplier.supplier.id,
      variantId: item.variantId,
      preferred: true,
    });
    await run(ops.receiveStock, {
      variantId: item.variantId,
      locationId: shop.locationId,
      quantity: '2',
    });
    const mcp = await mcpSession(t, shop, ['inventory:read', 'inventory:write']);
    const tools = (await mcp.client.listTools()).tools;
    const alerts = tools.find((x) => x.name === 'stock_alerts')!;
    expect(alerts.description).toContain('Use this when');
    expect(alerts.annotations?.readOnlyHint).toBe(false);

    const rule = await mcp.call('manage_purchasing', {
      action: 'set_rule',
      variantId: item.variantId,
      warehouseId: shop.warehouseId,
      reorderPoint: '5',
      reorderQuantity: '12',
    });
    expect(rule.error).toBe(false);
    expect(rule.body.rule).toMatchObject({ low: true, available: '2' });

    const listed = await mcp.call('stock_alerts', { action: 'list', kind: 'low_stock' });
    const alert = listed.body.alerts.find((a: Json) => a.variantId === item.variantId);
    expect(alert).toMatchObject({ status: 'open', title: expect.stringContaining('Low stock') });
    expect((await mcp.call('stock_alerts', { action: 'summary' })).body.open).toBeGreaterThan(0);

    const suggested = await mcp.call('manage_purchasing', { action: 'suggest_from_low_stock' });
    expect(suggested.body.drafts[0]).toMatchObject({
      supplierId: supplier.supplier.id,
      lines: [expect.objectContaining({ variantId: item.variantId, quantity: '12' })],
    });

    const acked = await mcp.call('stock_alerts', { action: 'acknowledge', alertId: alert.id });
    expect(acked.body.alert.status).toBe('acknowledged');
    const prefs = await mcp.call('stock_alerts', {
      action: 'set_preferences',
      preferences: [{ kind: 'lot_expiring', email: false }],
    });
    expect(prefs.body.preferences).toContainEqual(
      expect.objectContaining({ kind: 'lot_expiring', email: false, isDefault: false }),
    );
    await mcp.close();
  });

  it('serves alerts and rules over REST', async () => {
    const { token } = await apiToken(t, shop, ['inventory:read', 'inventory:write']);
    const headers = { authorization: `Bearer ${token}` };
    const list = await t.app.request(`/api/v1/shops/${shop.shopId}/alerts?status=all`, { headers });
    expect(list.status).toBe(200);
    expect(Array.isArray((await json(list)).alerts)).toBe(true);
    const rules = await t.app.request(`/api/v1/shops/${shop.shopId}/reorder-rules?lowOnly=true`, {
      headers,
    });
    expect(rules.status).toBe(200);
    expect((await json(rules)).rules.every((r: Json) => r.low)).toBe(true);
    const settings = await t.app.request(`/api/v1/shops/${shop.shopId}/alert-settings`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': uuidv7() },
      body: JSON.stringify({ lotExpiryAlertDays: 14 }),
    });
    expect(settings.status).toBe(200);
    expect(await json(settings)).toEqual({ lotExpiryAlertDays: 14 });
  });
});
