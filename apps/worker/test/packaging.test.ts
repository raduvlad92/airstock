import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, ownerQuery, type SeededShop, seedShop } from '../../../test/helpers.ts';
import { mcpSession } from './mcp-client.ts';
import { apiToken, type GrantMember, json, type TestApp, testApp } from './setup.ts';

// N5 through REST and MCP: packs, barcodes, bundles, suppliers, labels; cross-shop isolation (A13)
// and cost visibility at the API layer.

let t: TestApp;
let shop: SeededShop;
let other: SeededShop;
let token: string;
let otherToken: string;

const SCOPES = [
  'shop:read',
  'catalog:read',
  'catalog:write',
  'inventory:read',
  'inventory:write',
  'storage:read',
];

beforeAll(async () => {
  t = await testApp();
  shop = await seedShop(t.db, t.sink, 'Packaging REST shop');
  other = await seedShop(t.db, t.sink, 'Other packaging REST shop');
  token = (await apiToken(t, shop, SCOPES)).token;
  otherToken = (await apiToken(t, other, SCOPES)).token;
});
afterAll(() => t.close());

function call(
  bearer: string,
  shopId: string,
  path: string,
  body?: unknown,
  opts: { key?: string | null; read?: boolean } = {},
) {
  const headers = new Headers({ authorization: `Bearer ${bearer}` });
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    if (opts.key !== null && !opts.read)
      headers.set('idempotency-key', opts.key ?? crypto.randomUUID());
  }
  return t.app.request(`/api/v1/shops/${shopId}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const rest = (path: string, body?: unknown, opts?: { key?: string | null; read?: boolean }) =>
  call(token, shop.shopId, path, body, opts);

async function product(
  bearer = token,
  shopId = shop.shopId,
  sku = `R-${crypto.randomUUID().slice(0, 8)}`,
) {
  const res = await call(bearer, shopId, '/items', {
    name: `Product ${sku}`,
    sku,
    price: '4.00',
    acknowledgeSimilar: true,
  });
  expect(res.status).toBe(201);
  return (await json(res)) as { productId: string; variantId: string; sku: string };
}

/** An MCP client connected as a given member (the owner by default). */
const mcp = (scopes: string[], member?: GrantMember) => mcpSession(t, shop, scopes, member);

describe('packs, barcodes, and shipping packages through REST', () => {
  it('sets nested packs, barcodes, and boxes, with list versions and idempotent replays', async () => {
    const { variantId } = await product();
    const path = `/variants/${variantId}`;
    const key = crypto.randomUUID();
    const body = {
      packsVersion: 0,
      packs: [
        { name: 'Inner', quantity: '6' },
        { name: 'Case', quantity: '4', innerPack: 'Inner', uses: ['purchasing', 'counting'] },
      ],
    };
    const packs = await rest(`${path}/packs`, body, { key });
    expect(packs.status).toBe(200);
    const { packaging } = await json(packs);
    expect(packaging.packs.map((p: { baseQuantity: string }) => p.baseQuantity)).toEqual([
      '6.000000',
      '24.000000',
    ]);
    const replay = await rest(`${path}/packs`, body, { key });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');

    const caseId = packaging.packs[1].id;
    const barcodes = await rest(`${path}/barcodes`, {
      barcodesVersion: 0,
      barcodes: [
        { code: '4006381333931', symbology: 'ean13' },
        { code: '96385074', symbology: 'ean8', packId: caseId },
      ],
    });
    expect(barcodes.status).toBe(200);
    const generated = await rest(`${path}/barcodes/generate`, { symbology: 'qr', packId: caseId });
    expect(generated.status).toBe(201);
    const { barcode } = await json(generated);
    expect(barcode.code).toMatch(/^AS\d{8}$/);

    const boxes = await rest(`${path}/shipping-packages`, {
      shippingPackagesVersion: 0,
      shippingPackages: [{ dimensions: '50 x 40 x 30 cm', weight: '6 kg' }],
    });
    expect(boxes.status).toBe(200);

    const view = await json(await rest(`${path}/packaging`));
    expect(view).toMatchObject({ packsVersion: 1, barcodesVersion: 2, shippingPackagesVersion: 1 });
    expect(view.barcodes).toHaveLength(3);

    const lookup = await json(await rest(`/barcodes/lookup?code=${barcode.code.toLowerCase()}`));
    expect(lookup.match).toMatchObject({ variantId, packId: caseId, baseQuantity: '24.000000' });

    const stale = await rest(`${path}/packs`, { packsVersion: 0, packs: [] });
    expect(stale.status).toBe(409);
    expect((await json(stale)).code).toBe('version_conflict');

    const badCheck = await rest(`${path}/barcodes`, {
      barcodesVersion: 2,
      barcodes: [{ code: '4006381333932', symbology: 'ean13' }],
    });
    expect(badCheck.status).toBe(400);
    expect((await json(badCheck)).errors[0]).toMatchObject({
      path: 'barcodes.0.code',
      message: 'The check digit should be 1. Check the number.',
    });

    const { variantId: second } = await product();
    const dup = await rest(`/variants/${second}/barcodes`, {
      barcodesVersion: 0,
      barcodes: [{ code: '04006381333931', symbology: 'other' }],
    });
    expect(dup.status).toBe(409);
    const problem = await json(dup);
    expect(problem.code).toBe('duplicate_barcode');
    expect(problem.existing.variantId).toBe(variantId);
  });

  it('refuses a pack that breaks the quantity scale', async () => {
    const { variantId } = await product();
    const res = await rest(`/variants/${variantId}/packs`, {
      packsVersion: 0,
      packs: [{ name: 'Half', quantity: '0.5' }],
    });
    expect(res.status).toBe(422);
    expect((await json(res)).code).toBe('pack_breaks_quantity_scale');
  });
});

describe('bundles and suppliers through REST', () => {
  it('defines a bundle and reads its availability', async () => {
    const a = await product();
    const b = await product();
    const bundle = await product();
    for (const [variantId, quantity] of [
      [a.variantId, '5'],
      [b.variantId, '9'],
    ] as const) {
      const r = await rest('/receipts', { variantId, locationId: shop.locationId, quantity });
      expect(r.status).toBe(201);
    }
    const set = await rest(`/variants/${bundle.variantId}/bundle`, {
      bundleVersion: 0,
      components: [
        { variantId: a.variantId, quantity: '1' },
        { sku: b.sku, quantity: '3' },
      ],
    });
    expect(set.status).toBe(200);
    const res = await rest(`/variants/${bundle.variantId}/bundle-availability`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ available: '3', limitedBy: b.variantId });
  });

  it('hides costs from a credential whose member lacks costs.read', async () => {
    const { variantId } = await product();
    const supplier = await json(
      await rest('/suppliers', {
        name: `Brew ${crypto.randomUUID().slice(0, 6)}`,
        leadTimeDays: 5,
      }),
    );
    const saved = await rest('/supplier-items', {
      supplierId: supplier.supplier.id,
      variantId,
      supplierSku: 'B-1',
      lastCost: '2.10',
    });
    expect(saved.status).toBe(200);
    const asOwner = await json(await rest(`/supplier-items?variantId=${variantId}`));
    expect(asOwner.items[0].lastCost).toBe('2.100000');

    const editor = await addMember(shop.shopId, 'catalog_editor');
    const created = await apiToken(t, shop, SCOPES);
    await ownerQuery('update api_credentials set membership_id = $1 where id = $2', [
      editor.membershipId,
      created.credentialId,
    ]);
    const asEditor = await json(
      await call(created.token, shop.shopId, `/supplier-items?variantId=${variantId}`),
    );
    expect(asEditor.items[0]).toMatchObject({
      lastCost: null,
      costVisible: false,
      supplierSku: 'B-1',
    });
    const detail = await json(
      await call(created.token, shop.shopId, `/suppliers/${supplier.supplier.id}`),
    );
    expect(JSON.stringify(detail)).not.toContain('2.1');
    const write = await call(created.token, shop.shopId, '/supplier-items', {
      itemId: (await json(saved)).item.id,
      expectedVersion: 1,
      lastCost: '1.00',
    });
    expect(write.status).toBe(403);
  });
});

describe('labels through REST', () => {
  it('resolves item and location labels as reads', async () => {
    const { variantId } = await product();
    await rest(`/variants/${variantId}/barcodes/generate`, {});
    const items = await rest(
      '/labels/items',
      { template: 'items_thermal_50x25', items: [{ variantId, copies: 3 }] },
      { read: true },
    );
    expect(items.status).toBe(200);
    expect(await json(items)).toMatchObject({
      total: 3,
      template: { layout: 'thermal_50x25' },
      labels: [{ barcode: { symbology: 'code128' } }],
    });
    const locations = await rest(
      '/labels/locations',
      { locations: [{ locationId: shop.locationId }] },
      { read: true },
    );
    expect(locations.status).toBe(200);
    expect((await json(locations)).labels[0].barcode.code).toBe(
      `LOC:${shop.locationId.toUpperCase()}`,
    );
    const templates = await json(await rest('/labels/templates'));
    expect(templates.templates.length).toBeGreaterThanOrEqual(6);
  });
});

describe('A13: every new route refuses another shop’s IDs', () => {
  it('answers not found for another shop’s variants, packs, suppliers, and locations', async () => {
    const theirs = await product(otherToken, other.shopId);
    const theirPacks = await json(
      await call(otherToken, other.shopId, `/variants/${theirs.variantId}/packs`, {
        packsVersion: 0,
        packs: [{ name: 'Case', quantity: '2' }],
      }),
    );
    const theirPack = theirPacks.packaging.packs[0].id;
    const theirSupplier = (
      await json(await call(otherToken, other.shopId, '/suppliers', { name: 'Theirs' }))
    ).supplier.id;
    const mine = await product();
    const v = `/variants/${theirs.variantId}`;
    const attempts: Array<[string, unknown?, { read?: boolean }?]> = [
      [`${v}/packaging`],
      [`${v}/packs`, { packsVersion: 0, packs: [] }],
      [`${v}/barcodes`, { barcodesVersion: 0, barcodes: [] }],
      [`${v}/barcodes/generate`, {}],
      [`${v}/shipping-packages`, { shippingPackagesVersion: 0, shippingPackages: [] }],
      [`${v}/bundle`, { bundleVersion: 0, components: [] }],
      [`${v}/bundle-availability`],
      [`/variants/${mine.variantId}/barcodes/generate`, { packId: theirPack }],
      [
        `/variants/${mine.variantId}/bundle`,
        { bundleVersion: 0, components: [{ variantId: theirs.variantId, quantity: '1' }] },
      ],
      [`/suppliers/${theirSupplier}`],
      [`/suppliers/${theirSupplier}`, { expectedVersion: 1, notes: 'x' }],
      ['/supplier-items', { supplierId: theirSupplier, variantId: mine.variantId }],
      [`/supplier-items?supplierId=${theirSupplier}`],
      ['/labels/items', { items: [{ variantId: theirs.variantId }] }, { read: true }],
      ['/labels/locations', { locations: [{ locationId: other.locationId }] }, { read: true }],
    ];
    for (const [path, body, opts] of attempts) {
      const res = await rest(path, body, opts);
      const status = res.status;
      const problem = await json(res);
      // A list filtered by another shop's supplier is simply empty.
      if (path.startsWith('/supplier-items?')) {
        expect(status, path).toBe(200);
        expect(problem.items, path).toEqual([]);
        continue;
      }
      expect(status, path).toBe(404);
    }
    // The shop path itself: a credential of one shop cannot address another.
    const cross = await call(token, other.shopId, `${v}/packaging`);
    expect(cross.status).toBe(404);
  });
});

describe('N5 through MCP', () => {
  it('edits packaging with edit_catalog, reads it with search_catalog, and manages suppliers', async () => {
    const { call: tool, client } = await mcp([
      'shop:read',
      'catalog:read',
      'catalog:write',
      'inventory:read',
    ]);
    const { tools } = await client.listTools();
    const edit = tools.find((x) => x.name === 'edit_catalog')!;
    const actions = (edit.inputSchema.properties as Record<string, { enum?: string[] }>).action!
      .enum;
    expect(actions).toEqual(
      expect.arrayContaining([
        'set_packs',
        'set_shipping_packages',
        'set_barcodes',
        'generate_barcode',
        'set_bundle',
      ]),
    );
    const search = tools.find((x) => x.name === 'search_catalog')!;
    expect(
      (search.inputSchema.properties as Record<string, { enum?: string[] }>).action!.enum,
    ).toEqual(expect.arrayContaining(['get_packaging', 'lookup_barcode', 'bundle_availability']));
    expect(tools.map((x) => x.name)).toContain('manage_suppliers');
    expect(tools.length).toBeLessThanOrEqual(16);

    const { variantId, sku } = await product();
    const packs = await tool('edit_catalog', {
      action: 'set_packs',
      variantId,
      packsVersion: 0,
      packs: [{ name: 'Six-pack', quantity: '6', uses: ['sales'] }],
      idempotency_key: crypto.randomUUID(),
    });
    expect(packs.error).toBe(false);
    const six = packs.body.packaging.packs[0].id;
    const gen = await tool('edit_catalog', {
      action: 'generate_barcode',
      variantId,
      packId: six,
      idempotency_key: crypto.randomUUID(),
    });
    expect(gen.body.barcode.symbology).toBe('code128');
    const view = await tool('search_catalog', { action: 'get_packaging', variantId });
    expect(view.body.barcodesVersion).toBe(1);
    const found = await tool('search_catalog', {
      action: 'lookup_barcode',
      code: gen.body.barcode.code,
    });
    expect(found.body.match).toMatchObject({ sku, packName: 'Six-pack' });

    const bundle = await product();
    const set = await tool('edit_catalog', {
      action: 'set_bundle',
      variantId: bundle.variantId,
      bundleVersion: 0,
      components: [{ sku, packId: six, quantity: '2' }],
      idempotency_key: crypto.randomUUID(),
    });
    expect(set.body.packaging.bundle.components[0].baseQuantity).toBe('12.000000');
    const avail = await tool('search_catalog', {
      action: 'bundle_availability',
      variantId: bundle.variantId,
    });
    expect(avail.body).toMatchObject({ available: '0', limitedBy: variantId });

    const supplier = await tool('manage_suppliers', {
      action: 'create',
      name: `MCP supplier ${crypto.randomUUID().slice(0, 6)}`,
      idempotency_key: crypto.randomUUID(),
    });
    expect(supplier.error).toBe(false);
    const item = await tool('manage_suppliers', {
      action: 'save_item',
      supplierId: supplier.body.supplier.id,
      variantId,
      packId: six,
      supplierSku: 'MCP-6',
      lastCost: '3.60',
      idempotency_key: crypto.randomUUID(),
    });
    expect(item.body.item).toMatchObject({ packName: 'Six-pack', lastCost: '3.600000' });
    const listed = await tool('manage_suppliers', { action: 'list_items', variantId });
    expect(listed.body.items).toHaveLength(1);
  });

  it('hides costs from a connection whose member lacks costs.read, and refuses writes on read-only', async () => {
    const { variantId } = await product();
    const owner = await mcp(['catalog:read', 'catalog:write']);
    const supplier = await owner.call('manage_suppliers', {
      action: 'create',
      name: `Hidden ${crypto.randomUUID().slice(0, 6)}`,
      idempotency_key: crypto.randomUUID(),
    });
    await owner.call('manage_suppliers', {
      action: 'save_item',
      supplierId: supplier.body.supplier.id,
      variantId,
      lastCost: '9.99',
      idempotency_key: crypto.randomUUID(),
    });
    const editor = await addMember(shop.shopId, 'catalog_editor');
    const asEditor = await mcp(['catalog:read'], editor);
    const got = await asEditor.call('manage_suppliers', {
      action: 'get',
      supplierId: supplier.body.supplier.id,
    });
    expect(got.body.costVisible).toBe(false);
    expect(JSON.stringify(got.body)).not.toContain('9.99');
    const write = await asEditor.call('edit_catalog', {
      action: 'set_packs',
      variantId,
      packsVersion: 0,
      packs: [],
      idempotency_key: crypto.randomUUID(),
    });
    expect(write.error).toBe(true);
    expect(write.body.code).toBe('forbidden');
  });
});
