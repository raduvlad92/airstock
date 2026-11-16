import { execute, ops, runReportExportJob, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, ownerQuery, type SeededShop, seedShop } from '../../../test/helpers.ts';
import { mcpSession } from './mcp-client.ts';
import { apiToken, type Json, json, type TestApp, testApp } from './setup.ts';

// Reports over REST and MCP (D15): run_report runs a standard or saved report and lists saved
// ones; a member limited to one warehouse sees partial totals through both (A42); a CSV export
// runs as a job and downloads through the export file route.

const stored = new Map<string, string>();
const files = {
  put: async (key: string, body: string) => {
    stored.set(key, body);
  },
  list: async (prefix: string) => [...stored.keys()].filter((k) => k.startsWith(prefix)),
  get: async (key: string) => stored.get(key) ?? null,
  delete: async (key: string) => {
    stored.delete(key);
  },
};

let t: TestApp;
let shop: SeededShop;
let variantId: string;
let storeLocation: string;
let storeWarehouse: string;

async function run(op: (typeof ops)[keyof typeof ops], input: unknown): Promise<Json> {
  const res = await execute({ db: t.db, audit: t.sink }, op as never, {
    caller: shop.caller,
    shopId: shop.shopId,
    input,
    idempotencyKey: uuidv7(),
  });
  return res.result as Json;
}

beforeAll(async () => {
  t = await testApp({ files });
  shop = await seedShop(t.db, t.sink, 'Worker reports shop');
  storeWarehouse = (await run(ops.createWarehouse, { name: 'Store' })).warehouseId;
  storeLocation = (await run(ops.createLocation, { warehouseId: storeWarehouse, name: 'Front' }))
    .locationId;
  variantId = (await run(ops.createItem, { name: 'Booster box', sku: `BB-${uuidv7().slice(-6)}` }))
    .variantId;
  await run(ops.receiveStock, {
    variantId,
    locationId: shop.locationId,
    quantity: '10',
    unitCost: '4',
  });
  await run(ops.receiveStock, {
    variantId,
    locationId: storeLocation,
    quantity: '2',
    unitCost: '4',
  });
});
afterAll(() => t.close());

describe('run_report over MCP', () => {
  it('describes itself, runs a report and a saved one, and lists saved reports', async () => {
    const mcp = await mcpSession(t, shop, ['inventory:read']);
    const tool = (await mcp.client.listTools()).tools.find((x) => x.name === 'run_report')!;
    expect(tool.description).toContain('Use this when');
    expect(tool.annotations?.readOnlyHint).toBe(true);

    const value = await mcp.call('run_report', {
      action: 'run',
      report: 'inventory_value',
      variantId,
      groupBy: 'warehouse',
    });
    expect(value.error).toBe(false);
    expect(value.body).toMatchObject({
      report: 'inventory_value',
      partial: false,
      totals: { quantity: '12', value: '48' },
    });
    const past = await mcp.call('run_report', {
      action: 'run',
      report: 'inventory_value',
      variantId,
      at: '2020-12-01',
    });
    expect(past.body.totals).toMatchObject({ quantity: '0', value: '0' });

    const saved = await run(ops.saveReport, {
      name: 'Stock by location',
      report: 'stock_on_hand',
      filters: { groupBy: 'location', variantId },
      shared: true,
    });
    const listed = await mcp.call('run_report', { action: 'list_saved' });
    expect(listed.body.savedReports.map((r: Json) => r.name)).toContain('Stock by location');
    const ran = await mcp.call('run_report', {
      action: 'run_saved',
      savedReportId: saved.savedReport.id,
    });
    expect(ran.body).toMatchObject({ groupBy: 'location', totals: { onHand: '12' } });
    const refused = await mcp.call('run_report', {
      action: 'run',
      report: 'shortages',
      groupBy: 'lot',
    });
    expect(refused.error).toBe(true);
    await mcp.close();
  });

  it('shows a member limited to one warehouse only their stock, labelled partial (A42)', async () => {
    const scoped = await addMember(shop.shopId, 'manager', [storeWarehouse]);
    const mcp = await mcpSession(t, shop, ['inventory:read'], scoped);
    const soh = await mcp.call('run_report', { action: 'run', report: 'stock_on_hand', variantId });
    expect(soh.body).toMatchObject({ partial: true, totals: { onHand: '2' } });
    expect(soh.body.rows.map((r: Json) => r.location)).toEqual(['Store/Front']);
    const value = await mcp.call('run_report', {
      action: 'run',
      report: 'inventory_value',
      variantId,
    });
    expect(value.body).toMatchObject({ partial: true, totals: { value: '8' } });
    await mcp.close();
  });
});

describe('reports over REST', () => {
  it('runs a report from the query string and exports it as CSV through the file route', async () => {
    // Downloading an export file needs catalog:read, as for catalog exports.
    const { token } = await apiToken(t, shop, ['inventory:read', 'catalog:read']);
    const headers = { authorization: `Bearer ${token}` };
    const res = await t.app.request(
      `/api/v1/shops/${shop.shopId}/reports/stock_on_hand?variantId=${variantId}&groupBy=variant&limit=5`,
      { headers },
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.rows[0]).toMatchObject({ onHand: '12', value: '48' });
    const bad = await t.app.request(`/api/v1/shops/${shop.shopId}/reports/nope`, { headers });
    expect(bad.status).toBe(400);

    const started = await t.app.request(`/api/v1/shops/${shop.shopId}/report-exports`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': uuidv7() },
      body: JSON.stringify({ report: 'stock_on_hand', filters: { variantId } }),
    });
    expect(started.status).toBe(201);
    const exportId = (await json(started)).export.exportId as string;
    await runReportExportJob({ db: t.db, audit: t.sink, files }, shop.shopId, exportId);
    const file = await t.app.request(`/api/v1/shops/${shop.shopId}/exports/${exportId}/file`, {
      headers,
    });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toContain('airstock-report-stock_on_hand');
    const text = await file.text();
    expect(text).toContain('Value (EUR)');
    expect(text.trim().split('\r\n').at(-1)).toMatch(/^Total,/);
    const [logged] = await ownerQuery(
      `select 1 from audit_events where target_id = $1 and action = 'catalog.export.downloaded'`,
      [exportId],
    );
    expect(logged).toBeDefined();
  });
});
