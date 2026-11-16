import { execute, ops, runExportJob, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery, type SeededShop, seedShop } from '../../../test/helpers.ts';
import { mcpSession } from './mcp-client.ts';
import { apiToken, type Json, json, type TestApp, testApp } from './setup.ts';

// G6: the lot trace export over REST and MCP. The job writes the file; it downloads through the
// export file route like every other export, and each download is logged.

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
const lotCode = `L-W${uuidv7().slice(-4)}`;

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
  shop = await seedShop(t.db, t.sink, 'Worker lot trace shop');
  variantId = (await run(ops.createItem, { name: 'Oat milk', sku: `OAT-${uuidv7().slice(-6)}` }))
    .variantId;
  await run(ops.setStockSettings, { variantId, trackingMode: 'lot_expiry' });
  await run(ops.receiveStock, {
    variantId,
    locationId: shop.locationId,
    quantity: '6',
    lotCode,
    expiresOn: '2030-12-31',
  });
  const r = await run(ops.reserveStock, {
    variantId,
    quantity: '2',
    externalRef: 'shop:order/7',
  });
  await run(ops.fulfillReservation, { reservationId: r.reservationId });
});
afterAll(() => t.close());

describe('lot trace export over REST', () => {
  it('starts the export, and the file downloads through the export route, logged', async () => {
    // Downloading an export file needs catalog:read, as for catalog and report exports.
    const { token } = await apiToken(t, shop, ['inventory:read', 'catalog:read']);
    const headers = { authorization: `Bearer ${token}` };
    const started = await t.app.request(`/api/v1/shops/${shop.shopId}/lots/trace/exports`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': uuidv7() },
      body: JSON.stringify({ variantId, lotCode: lotCode.toLowerCase() }),
    });
    expect(started.status).toBe(201);
    const exportId = (await json(started)).export.exportId as string;
    await runExportJob({ db: t.db, audit: t.sink, files }, shop.shopId, exportId);
    const status = await json(
      await t.app.request(`/api/v1/shops/${shop.shopId}/exports/${exportId}`, { headers }),
    );
    expect(status.export).toMatchObject({ kind: 'lot_trace', status: 'completed', rowCount: 2 });
    const file = await t.app.request(`/api/v1/shops/${shop.shopId}/exports/${exportId}/file`, {
      headers,
    });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toContain(`airstock-lot-trace-${lotCode}-`);
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    const lines = (await file.text()).replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toMatch(/^occurred_at,lot,sku,expires_on,movement,quantity,location/);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(',receipt,6.000000,');
    expect(lines[2]).toContain(',fulfillment,-2.000000,');
    expect(lines[2]).toContain('shop:order/7');
    // Created and downloaded commit with their commands; the job's completion goes through the
    // audit queue.
    const logged = await ownerQuery<{ action: string }>(
      `select action from audit_events where shop_id = $1 and target_id = $2 and phase = 'outcome'
       order by occurred_at, event_id`,
      [shop.shopId, exportId],
    );
    expect(logged.map((e) => e.action)).toEqual(
      expect.arrayContaining(['inventory.lot_trace_export.created', 'catalog.export.downloaded']),
    );
    expect(
      t.sink.events.filter(
        (e) => e.target_id === exportId && e.action === 'inventory.lot_trace_export.completed',
      ),
    ).toHaveLength(1);
  });
});

describe('lot trace export over MCP', () => {
  it('is an import_export action, followed with get_export', async () => {
    const mcp = await mcpSession(t, shop, ['inventory:read', 'catalog:read']);
    const tool = (await mcp.client.listTools()).tools.find((x) => x.name === 'import_export')!;
    expect(tool.description).toContain('action "export_lot_trace"');
    const started = await mcp.call('import_export', {
      action: 'export_lot_trace',
      variantId,
      lotCode,
      idempotency_key: uuidv7(),
    });
    expect(started.error).toBe(false);
    expect(started.body).toMatchObject({ export: { kind: 'lot_trace', status: 'pending' } });
    const followed = await mcp.call('import_export', {
      action: 'get_export',
      exportId: (started.body as Json).export.exportId,
    });
    expect(followed.error).toBe(false);
    expect(followed.body).toMatchObject({ export: { kind: 'lot_trace' } });
  });
});
