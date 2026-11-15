import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SeededShop, seedShop } from '../../../test/helpers.ts';
import { apiToken, connectionGrant, GRANT_CLAIM, json, type TestApp, testApp } from './setup.ts';

// N1 done-when: A01 and A02 through REST and MCP.

let t: TestApp;
let shop: SeededShop;
let token: string;

beforeAll(async () => {
  t = await testApp();
  shop = await seedShop(t.db, t.sink, 'Catalog REST shop');
  token = (
    await apiToken(t, shop, [
      'shop:read',
      'catalog:read',
      'catalog:write',
      'inventory:read',
      'inventory:write',
    ])
  ).token;
});
afterAll(() => t.close());

function rest(path: string, body?: unknown, key = crypto.randomUUID()) {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    headers.set('idempotency-key', key);
  }
  return t.app.request(`/api/v1/shops/${shop.shopId}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function mcp(scopes: string[]) {
  const grant = await connectionGrant(shop, scopes);
  const client = new Client({ name: 'catalog-test', version: '1.0.0' });
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
  return {
    client,
    async call(name: string, args: Record<string, unknown>) {
      const res = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      return { error: res.isError === true, body: JSON.parse(res.content[0]!.text) };
    },
  };
}

describe('A01 through REST', () => {
  it('adds families, creates products with typed values, and reads them back', async () => {
    const template = await rest('/catalog/templates', { template: 'food' });
    expect(template.status).toBe(201);
    expect((await rest('/catalog/templates', { template: 'spare_parts' })).status).toBe(201);
    const schema = await json(await rest('/catalog/schema?includeArchived=false'));
    expect(schema.families.map((f: { name: string }) => f.name)).toEqual(['Food', 'Spare parts']);
    expect(schema.units.kinds.weight.units).toEqual(['g', 'kg', 'oz', 'lb']);

    const honey = await rest('/items', {
      name: 'Honey',
      sku: 'REST-HONEY',
      family: 'Food',
      fields: { net_weight: '250 g', storage: 'Ambient', allergens: ['Nuts'] },
    });
    expect(honey.status).toBe(201);
    const created = await json(honey);
    expect(created.item.product.fields.allergens.display).toBe('Nuts');

    const invalid = await rest('/items', { name: 'X', sku: 'REST-X', fields: { storage: 'Hot' } });
    expect(invalid.status).toBe(400);
    expect((await json(invalid)).errors[0].path).toBe('fields.storage');

    const detail = await json(await rest('/items/detail?sku=rest-honey'));
    expect(detail.item.product.id).toBe(created.productId);
  });

  it('edits with compare-and-set and reports a conflict with who changed it', async () => {
    const created = await json(
      await rest('/items', { name: 'Kettle', sku: 'REST-KETTLE', price: '30' }),
    );
    const path = `/items/${created.productId}/changes`;
    const first = await rest(path, {
      changes: [{ variantId: created.variantId, field: 'price', expected: '30', value: '32' }],
    });
    expect(first.status).toBe(200);
    const stale = await rest(path, {
      changes: [{ variantId: created.variantId, field: 'price', expected: '30', value: '35' }],
    });
    expect(stale.status).toBe(409);
    const problem = await json(stale);
    expect(problem.code).toBe('edit_conflict');
    expect(problem.conflicts[0]).toMatchObject({
      field: 'price',
      current: '32.000000',
      changedBy: { actorType: 'api_credential', source: 'api' },
    });
  });
});

describe('A01 and A02 through MCP', () => {
  it('describes the catalog, creates a product, and previews then creates variants', async () => {
    const { call, client } = await mcp(['shop:read', 'catalog:read', 'catalog:write']);
    const { tools } = await client.listTools();
    const edit = tools.find((x) => x.name === 'edit_catalog')!;
    expect(edit.description).toContain('action "generate_variants"');
    expect(Object.keys((edit.inputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining([
        'action',
        'productId',
        'changes',
        'options',
        'skuPattern',
        'mode',
        'fields',
      ]),
    );

    const added = await call('manage_catalog_schema', {
      action: 'add_template',
      template: 'apparel',
    });
    expect(added.error).toBe(false);
    const described = await call('describe_catalog', {});
    expect(described.body.families.map((f: { name: string }) => f.name)).toContain('Apparel');

    const shirt = await call('edit_catalog', {
      action: 'create_product',
      name: 'MCP T-shirt',
      sku: 'MCP-TS',
      price: '19.90',
      family: 'Apparel',
      fields: { material: 'Cotton' },
    });
    expect(shirt.error).toBe(false);
    const preview = await call('edit_catalog', {
      action: 'generate_variants',
      productId: shirt.body.productId,
      options: [
        { name: 'Color', values: ['Black', 'White'] },
        { name: 'Size', values: ['S', 'M', 'L', 'XL'] },
      ],
      skuPattern: 'TS-{color}-{size}',
    });
    expect(preview.body.mode).toBe('preview');
    expect(preview.body.combinations).toHaveLength(8);
    const created = await call('edit_catalog', {
      action: 'generate_variants',
      productId: shirt.body.productId,
      options: [
        { name: 'Color', values: ['Black', 'White'] },
        { name: 'Size', values: ['S', 'M', 'L', 'XL'] },
      ],
      skuPattern: 'TS-{color}-{size}',
      mode: 'create',
    });
    expect(created.body.created).toBe(7);
    const found = await call('search_catalog', { action: 'get', sku: 'TS-BLACK-M' });
    expect(found.body.item.variants).toHaveLength(8);
    expect(found.body.item.variants.find((v: { sku: string }) => v.sku === 'MCP-TS').title).toBe(
      'Black / S',
    );

    const variant = found.body.item.variants.find((v: { sku: string }) => v.sku === 'TS-BLACK-M');
    const priced = await call('edit_catalog', {
      action: 'update',
      productId: shirt.body.productId,
      changes: [{ variantId: variant.id, field: 'price', expected: variant.price, value: '21.90' }],
    });
    expect(priced.error).toBe(false);
  });

  it('refuses schema and catalog changes on a read-only connection (A15)', async () => {
    const { call } = await mcp(['shop:read', 'catalog:read']);
    const denied = await call('manage_catalog_schema', {
      action: 'add_template',
      template: 'furniture',
    });
    expect(denied.error).toBe(true);
    expect(denied.body.code).toBe('forbidden');
    const edit = await call('edit_catalog', { action: 'create_product', name: 'No', sku: 'NO-1' });
    expect(edit.body.code).toBe('forbidden');
    expect((await call('describe_catalog', {})).error).toBe(false);
  });
});

describe('A43 and search through REST and MCP (N2)', () => {
  it('REST: blocks a duplicate SKU, returns similar names until acknowledged, and queries', async () => {
    expect((await rest('/items', { name: 'Brass floor lamp', sku: 'A43-LAMP-1' })).status).toBe(
      201,
    );
    const dup = await rest('/items', { name: 'Other', sku: 'a43-lamp-1' });
    expect(dup.status).toBe(409);
    expect((await json(dup)).code).toBe('duplicate_sku');
    const similar = await rest('/items', { name: 'Brass Floor Lamps', sku: 'A43-LAMP-2' });
    expect(similar.status).toBe(409);
    expect((await json(similar)).similarNames[0].name).toBe('Brass floor lamp');
    expect(
      (
        await rest('/items', {
          name: 'Brass Floor Lamps',
          sku: 'A43-LAMP-2',
          acknowledgeSimilar: true,
        })
      ).status,
    ).toBe(201);
    const query = await json(
      await rest('/items/query', {
        search: 'brass lamp',
        filter: [{ field: 'sku', op: 'starts_with', value: 'A43' }],
        sort: { field: 'sku', direction: 'desc' },
      }),
    );
    expect(query.rows.map((r: { sku: string }) => r.sku)).toEqual(['A43-LAMP-2', 'A43-LAMP-1']);
    expect(query.total).toBe(2);
  });

  it('MCP: a create without acknowledgment returns the matches instead of creating', async () => {
    const { call } = await mcp(['shop:read', 'catalog:read', 'catalog:write']);
    await call('edit_catalog', {
      action: 'create_product',
      name: 'Velvet armchair',
      sku: 'A43-CHAIR-1',
    });
    const check = await call('search_catalog', {
      action: 'check_duplicates',
      name: 'velvet arm chair',
    });
    expect(check.body.similarNames[0].name).toBe('Velvet armchair');
    const attempt = await call('edit_catalog', {
      action: 'create_product',
      name: 'Velvet Armchairs',
      sku: 'A43-CHAIR-2',
    });
    expect(attempt.error).toBe(true);
    expect(attempt.body).toMatchObject({
      code: 'similar_items_found',
      similarNames: [{ name: 'Velvet armchair' }],
    });
    const found = await call('search_catalog', { action: 'query', search: 'A43-CHAIR-2' });
    expect(found.body.rows).toHaveLength(0);
    const created = await call('edit_catalog', {
      action: 'create_product',
      name: 'Velvet Armchairs',
      sku: 'A43-CHAIR-2',
      acknowledgeSimilar: true,
    });
    expect(created.error).toBe(false);
    const query = await call('search_catalog', {
      action: 'query',
      filter: [{ field: 'name', op: 'contains', value: 'velvet' }],
      sort: { field: 'name', direction: 'asc' },
    });
    expect(query.body.rows.map((r: { sku: string }) => r.sku)).toEqual([
      'A43-CHAIR-1',
      'A43-CHAIR-2',
    ]);
  });
});

describe('bulk edits through MCP (D4)', () => {
  it('previews a multi-record change, then commits it', async () => {
    const { call } = await mcp(['shop:read', 'catalog:read', 'catalog:write']);
    const a = await call('edit_catalog', {
      action: 'create_product',
      name: 'Bulk mug one',
      sku: 'BM-1',
      price: '4',
    });
    const b = await call('edit_catalog', {
      action: 'create_product',
      name: 'Bulk plate two',
      sku: 'BM-2',
      price: '6',
    });
    const preview = await call('edit_catalog', {
      action: 'bulk_preview',
      edits: [
        { productId: a.body.productId, variantId: a.body.variantId, field: 'price', value: '4.5' },
        { productId: b.body.productId, variantId: b.body.variantId, field: 'price', value: '6.5' },
      ],
    });
    expect(preview.body.records).toBe(2);
    expect(preview.body.previewId).toBeTruthy();
    const commit = await call('edit_catalog', {
      action: 'bulk_commit',
      previewId: preview.body.previewId,
    });
    expect(commit.error).toBe(false);
    const found = await call('search_catalog', { action: 'query', search: 'BM-2' });
    expect(found.body.rows[0].price).toBe('6.500000');
  });
});

describe('cross-shop isolation for the new routes (A13)', () => {
  it('answers another shop’s catalog IDs with 404', async () => {
    const other = await seedShop(t.db, t.sink, 'Other catalog REST shop');
    const theirs = await t.app.request(`/api/v1/shops/${other.shopId}/catalog/schema`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(theirs.status).toBe(404);
  });
});
