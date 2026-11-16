import { runExportJob, runImportJob } from '@airstock/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery, type SeededShop, seedShop } from '../../../test/helpers.ts';
import { apiToken, connectionGrant, GRANT_CLAIM, json, type TestApp, testApp } from './setup.ts';

// N7 through the API: upload, preview, commit, export, download (F10).

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
let token: string;

beforeAll(async () => {
  t = await testApp({ files });
  shop = await seedShop(t.db, t.sink, 'Import REST shop');
  token = (
    await apiToken(t, shop, ['shop:read', 'catalog:read', 'catalog:write', 'inventory:write'])
  ).token;
});
afterAll(() => t.close());

const call = (path: string, init: RequestInit & { key?: boolean } = {}) => {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (init.key) headers.set('idempotency-key', crypto.randomUUID());
  return t.app.request(`/api/v1/shops/${shop.shopId}${path}`, { ...init, headers });
};
const jobDeps = () => ({
  db: t.db,
  audit: t.sink,
  files: { get: files.get, put: files.put, delete: files.delete },
});

describe('import and export over REST', () => {
  it('uploads a file, previews, commits, exports, and downloads', async () => {
    const created = await json(
      await call('/imports', {
        method: 'POST',
        body: JSON.stringify({ fileName: 'lamps.csv' }),
        key: true,
      }),
    );
    const csv = 'name,sku,price,Case qty\nDesk lamp,REST-L1,30,4\nFloor lamp,REST-L2,90,\n';
    const upload = await call(`/imports/${created.importId}/file`, {
      method: 'PUT',
      body: csv,
      headers: { 'content-type': 'text/csv', 'content-length': String(csv.length) },
    });
    expect(upload.status).toBe(200);
    const preview = await json(
      await call(`/imports/${created.importId}/preview`, {
        method: 'POST',
        body: JSON.stringify({
          mapping: { name: 'name', sku: 'sku', price: 'price', 'Case qty': 'pack:Case' },
        }),
        key: true,
      }),
    );
    expect(preview.import.counts).toMatchObject({ creates: 2, errors: 0, packRows: 1 });
    expect(preview.suggestedMapping['Case qty']).toBe('pack:Case');
    expect(preview.packNames).toEqual([]);
    expect(
      (await call(`/imports/${created.importId}/commit`, { method: 'POST', body: '{}', key: true }))
        .status,
    ).toBe(200);
    expect(await runImportJob(jobDeps(), shop.shopId, created.importId)).toBe('done');
    expect((await json(await call(`/imports/${created.importId}`))).import.status).toBe(
      'completed',
    );

    const exp = await json(
      await call('/exports', {
        method: 'POST',
        body: JSON.stringify({ search: 'REST-L' }),
        key: true,
      }),
    );
    await runExportJob(jobDeps(), shop.shopId, exp.export.exportId);
    const file = await call(`/exports/${exp.export.exportId}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toMatch(
      /^attachment; filename="airstock-variants-/,
    );
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    const text = await file.text();
    expect(text).toContain('REST-L1');
    expect(text).toContain('REST-L2');
    // The pack the import created exports in its own column, ready to import back.
    expect(text.split('\r\n')[0]).toContain('pack:Case,pack_barcode:Case');
    const downloads = await ownerQuery(
      `select 1 from audit_events where target_id = $1 and action = 'catalog.export.downloaded' and outcome = 'succeeded'`,
      [exp.export.exportId],
    );
    expect(downloads).toHaveLength(1);
  });

  it('refuses an upload over the size limit or from a caller without imports.run', async () => {
    const created = await json(
      await call('/imports', {
        method: 'POST',
        body: JSON.stringify({ fileName: 'big.csv' }),
        key: true,
      }),
    );
    const big = await call(`/imports/${created.importId}/file`, {
      method: 'PUT',
      body: 'x',
      headers: { 'content-length': String(30 * 1024 * 1024) },
    });
    expect(big.status).toBe(400);
    const reader = (await apiToken(t, shop, ['catalog:read'])).token;
    const refused = await t.app.request(
      `/api/v1/shops/${shop.shopId}/imports/${created.importId}/file`,
      {
        method: 'PUT',
        body: 'name,sku\n',
        headers: { authorization: `Bearer ${reader}`, 'content-length': '9' },
      },
    );
    expect(refused.status).toBe(403);
    expect(stored.has(`shops/${shop.shopId}/imports/${created.importId}/source.csv`)).toBe(false);
  });

  it('starts an export and reads its status over MCP; downloads stay in the dashboard and API', async () => {
    const grant = await connectionGrant(shop, ['shop:read', 'catalog:read']);
    const client = new Client({ name: 'export-test', version: '1.0.0' });
    const bearer = await t.sign({
      sub: grant.sub,
      client_id: grant.clientId,
      [GRANT_CLAIM]: grant.grantId,
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://airstock.test/mcp'), {
        fetch: async (url, init) => t.app.fetch(new Request(url, init)),
        requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      }),
    );
    const parse = (r: unknown) =>
      JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);
    const started = parse(
      await client.callTool({
        name: 'import_export',
        arguments: { action: 'start_export', mode: 'products' },
      }),
    );
    expect(started.export.status).toBe('pending');
    await runExportJob(jobDeps(), shop.shopId, started.export.exportId);
    const status = parse(
      await client.callTool({
        name: 'import_export',
        arguments: { action: 'get_export', exportId: started.export.exportId },
      }),
    );
    expect(status.export.status).toBe('completed');
    expect(status.export.downloadPath).toContain('/file');
  });
});
