// @vitest-environment happy-dom
import { normalizeBarcode } from '@airstock/core/barcodes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppInfoProvider } from '../src/context.tsx';
import { barcodeBitmap } from '../src/labels/barcode.ts';
import { routeTree } from '../src/router.tsx';
import { readLabelPdf } from './pdf-images.ts';
import { decodeGrey } from './zxing.ts';

// N5: the labels page (D9) and the suppliers page.

const SHOP = '0196f3a0-0000-7000-8000-000000000001';
const VARIANT = '0196f3a0-0000-7000-8000-000000000003';
const CASE = '0196f3a0-0000-7000-8000-000000000005';
const SUPPLIER = '0196f3a0-0000-7000-8000-000000000007';
const ITEM = '0196f3a0-0000-7000-8000-000000000008';
const PRODUCT = '0196f3a0-0000-7000-8000-000000000002';
const TEMPLATE = '0196f3a0-0000-7000-8000-00000000000a';

function context(permissions: string[]) {
  return {
    shop: { id: SHOP, name: 'Bibica', currency: 'EUR', timezone: 'Europe/Bucharest' },
    role: 'manager',
    permissions,
    allLocations: true,
    locationScopeIds: [],
    connectionScopes: 'all',
    rateLimits: [],
  };
}

const BUILTIN = [
  {
    id: null,
    key: 'items_a4_3x8',
    name: 'Product labels, A4 3 × 8',
    kind: 'item',
    layout: 'a4_3x8',
    fields: ['name', 'sku', 'options', 'price', 'pack', 'barcode'],
    status: 'active',
    version: 0,
    updatedAt: null,
  },
  {
    id: null,
    key: 'locations_a4_3x8',
    name: 'Location labels, A4 3 × 8',
    kind: 'location',
    layout: 'a4_3x8',
    fields: ['path', 'warehouse', 'barcode'],
    status: 'active',
    version: 0,
    updatedAt: null,
  },
];

type Handler = (body: unknown) => unknown;

function mockApi(routes: Record<string, Handler | unknown>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      const path = url.pathname.replace('/api/v1', '');
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const route = routes[`${method} ${path}`];
      if (route === undefined)
        return new Response(JSON.stringify({ code: 'not_found', title: 'Not found' }), {
          status: 404,
        });
      const out = typeof route === 'function' ? (route as Handler)(body) : route;
      return new Response(JSON.stringify(out), { status: 200 });
    }),
  );
  return calls;
}

function renderAt(path: string) {
  const router = createRouter({
    routeTree,
    basepath: '/app',
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <AppInfoProvider info={{ email: 'me@example.test', mcpUrl: 'https://airstock.test/mcp' }}>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppInfoProvider>,
  );
  return router;
}

/** Catches the PDF the page saves. */
function catchDownloads() {
  const files: Array<{ name: string; blob: Blob }> = [];
  const blobs = new Map<string, Blob>();
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    files.push({ name: this.download, blob: blobs.get(this.href)! });
  });
  return files;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const itemLabels = (copies: [number, number]) => ({
  template: { name: 'Product labels, A4 3 × 8', layout: 'a4_3x8', fields: BUILTIN[0]!.fields },
  currency: 'EUR',
  total: copies[0] + copies[1],
  missingBarcodes: 0,
  labels: [
    {
      kind: 'variant',
      variantId: VARIANT,
      packId: null,
      copies: copies[0],
      name: 'Mug',
      sku: 'MUG-01',
      options: 'Blue',
      price: '12.5',
      pack: null,
      barcode: { symbology: 'ean13', code: '4006381333931' },
    },
    {
      kind: 'pack',
      variantId: VARIANT,
      packId: CASE,
      copies: copies[1],
      name: 'Mug',
      sku: 'MUG-01',
      options: 'Blue',
      price: '150',
      pack: 'Case · 12 each',
      barcode: { symbology: 'code128', code: 'AS00000042' },
    },
  ],
});

describe('labels page', () => {
  it('prints the variants it was opened with, unit and pack, as one PDF', async () => {
    const files = catchDownloads();
    const calls = mockApi({
      [`GET /shops/${SHOP}`]: context(['catalog.read', 'catalog.write']),
      'GET /shops': { shops: [] },
      [`GET /shops/${SHOP}/labels/templates`]: { templates: BUILTIN },
      [`POST /shops/${SHOP}/labels/items`]: (body: unknown) => {
        const items = (body as { items: Array<{ copies?: number }> }).items;
        return itemLabels([items[0]!.copies ?? 1, items[1]!.copies ?? 1]);
      },
    });
    renderAt(`/app/shops/${SHOP}/labels?variants=${VARIANT},${VARIANT}:${CASE}`);
    expect(await screen.findByRole('heading', { name: 'Labels' })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText(/^Mug · Blue/)).toHaveLength(2));
    // What the labels say is resolved once for the list, with the template.
    expect(calls.find((c) => c.path.endsWith('/labels/items'))!.body).toEqual({
      items: [{ variantId: VARIANT }, { variantId: VARIANT, packId: CASE }],
      template: 'items_a4_3x8',
    });
    fireEvent.change(screen.getAllByLabelText('Copies')[0]!, { target: { value: '3' } });
    expect(screen.getByText('4 labels on 1 sheet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(
      await screen.findByText(/Downloaded labels-\d{4}-\d{2}-\d{2}\.pdf: 4 labels on 1 page/),
    ).toBeTruthy();
    const printed = calls.filter((c) => c.path.endsWith('/labels/items')).at(-1)!;
    expect(printed.body).toEqual({
      items: [
        { variantId: VARIANT, copies: 3 },
        { variantId: VARIANT, packId: CASE, copies: 1 },
      ],
      template: 'items_a4_3x8',
    });

    // The saved file holds exactly the two symbols, which decode to their codes.
    expect(files).toHaveLength(1);
    const pdf = await readLabelPdf(new Uint8Array(await files[0]!.blob.arrayBuffer()));
    expect(pdf.placements).toHaveLength(4);
    expect(pdf.images).toHaveLength(2);
    const decoded = await Promise.all(pdf.images.map(decodeGrey));
    expect(new Set(decoded.map((d) => normalizeBarcode(d[0]!.text)))).toEqual(
      new Set([normalizeBarcode('4006381333931'), 'AS00000042']),
    );
    const ean = barcodeBitmap('ean13', '4006381333931');
    expect(pdf.images.some((i) => Buffer.from(i.pixels).equals(Buffer.from(ean.pixels)))).toBe(
      true,
    );
  });

  it('saves a custom choice of fields as a template', async () => {
    const calls = mockApi({
      [`GET /shops/${SHOP}`]: context(['catalog.read', 'catalog.write']),
      'GET /shops': { shops: [] },
      [`GET /shops/${SHOP}/labels/templates`]: { templates: BUILTIN },
      [`POST /shops/${SHOP}/labels/templates`]: (body: unknown) => ({
        template: {
          ...(body as object),
          id: TEMPLATE,
          key: null,
          status: 'active',
          version: 1,
          updatedAt: '2026-11-15T00:00:00.000Z',
        },
      }),
    });
    renderAt(`/app/shops/${SHOP}/labels`);
    fireEvent.change(await screen.findByLabelText('Label size'), {
      target: { value: 'thermal_50x25' },
    });
    fireEvent.click(screen.getByLabelText('Price'));
    fireEvent.click(screen.getByLabelText('Options'));
    fireEvent.change(screen.getByPlaceholderText('Template name'), {
      target: { value: 'Shelf price' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      name: 'Shelf price',
      kind: 'item',
      layout: 'thermal_50x25',
      fields: ['name', 'sku', 'pack', 'barcode'],
    });
    // A thermal roll has no sheet positions.
    expect(screen.queryByLabelText('Start at label')).toBeNull();
  });

  it('prints location labels from the location list', async () => {
    catchDownloads();
    const LOC = '0196f3a0-0000-7000-8000-0000000000b1';
    const calls = mockApi({
      [`GET /shops/${SHOP}`]: context(['catalog.read', 'storage.read']),
      'GET /shops': { shops: [] },
      [`GET /shops/${SHOP}/labels/templates`]: { templates: BUILTIN },
      [`GET /shops/${SHOP}/locations`]: {
        partial: false,
        locations: [
          {
            locationId: LOC,
            warehouseId: SHOP,
            warehouseName: 'Main',
            ownership: 'owned',
            parentId: null,
            name: 'Bay 1',
            code: 'B-01',
            path: 'Main/Bay 1',
            holdsStockAllowed: true,
            fulfillmentEligible: true,
            effectiveFulfillmentEligible: true,
            status: 'active',
            version: 1,
          },
        ],
      },
      [`POST /shops/${SHOP}/labels/locations`]: (body: unknown) => ({
        template: {
          name: 'Location labels, A4 3 × 8',
          layout: 'a4_3x8',
          fields: BUILTIN[1]!.fields,
        },
        total: 2,
        labels: [
          {
            locationId: LOC,
            copies: (body as { locations: Array<{ copies?: number }> }).locations[0]!.copies ?? 1,
            path: 'Main/Bay 1',
            code: 'B-01',
            warehouse: 'Main',
            barcode: { symbology: 'qr', code: `LOC:${LOC.toUpperCase()}` },
          },
        ],
      }),
    });
    renderAt(`/app/shops/${SHOP}/labels?kind=location`);
    fireEvent.click(await screen.findByLabelText(/Main\/Bay 1/));
    fireEvent.change(screen.getByLabelText('Copies of each'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(
      await screen.findByText(/Downloaded location-labels-.*: 2 labels on 1 page/),
    ).toBeTruthy();
    expect(calls.filter((c) => c.path.endsWith('/labels/locations')).at(-1)!.body).toEqual({
      locations: [{ locationId: LOC, copies: 2 }],
      template: 'locations_a4_3x8',
    });
  });
});

describe('suppliers page', () => {
  const supplier = (status: 'active' | 'archived') => ({
    id: SUPPLIER,
    name: 'Ceramics Ltd',
    contactName: 'Ana Pop',
    email: 'ana@ceramics.test',
    phone: null,
    website: null,
    address: null,
    currency: 'EUR',
    leadTimeDays: 10,
    notes: null,
    status,
    version: 4,
    itemCount: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  });
  const item = (costVisible: boolean) => ({
    id: ITEM,
    supplierId: SUPPLIER,
    supplierName: 'Ceramics Ltd',
    variantId: VARIANT,
    productId: PRODUCT,
    productName: 'Mug',
    sku: 'MUG-01',
    packId: null,
    packName: null,
    packBaseQuantity: null,
    supplierSku: 'CL-77',
    costVisible,
    lastCost: costVisible ? '3.1' : null,
    lastCostAt: null,
    minimumOrderQuantity: null,
    preferred: false,
    status: 'active',
    version: 1,
  });

  it('lists suppliers, shows their items, and archives with the version read', async () => {
    const calls = mockApi({
      [`GET /shops/${SHOP}`]: context(['catalog.read', 'catalog.write']),
      'GET /shops': { shops: [] },
      [`GET /shops/${SHOP}/suppliers`]: { suppliers: [supplier('active')], nextCursor: null },
      [`GET /shops/${SHOP}/suppliers/${SUPPLIER}`]: {
        supplier: supplier('active'),
        items: [item(false)],
        costVisible: false,
      },
      [`POST /shops/${SHOP}/suppliers/${SUPPLIER}`]: { supplier: supplier('archived') },
    });
    renderAt(`/app/shops/${SHOP}/suppliers`);
    fireEvent.click(await screen.findByRole('button', { name: 'Ceramics Ltd' }));
    expect(await screen.findByText('CL-77')).toBeTruthy();
    expect(screen.getByText('ana@ceramics.test')).toBeTruthy();
    expect(screen.queryByText('Last cost')).toBeNull();
    expect(screen.getByText('Costs are hidden: they need the costs permission.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      expectedVersion: 4,
      status: 'archived',
    });
  });

  it('shows costs to members who may see them', async () => {
    mockApi({
      [`GET /shops/${SHOP}`]: context(['catalog.read', 'costs.read']),
      'GET /shops': { shops: [] },
      [`GET /shops/${SHOP}/suppliers`]: { suppliers: [supplier('active')], nextCursor: null },
      [`GET /shops/${SHOP}/suppliers/${SUPPLIER}`]: {
        supplier: supplier('active'),
        items: [item(true)],
        costVisible: true,
      },
    });
    renderAt(`/app/shops/${SHOP}/suppliers?supplier=${SUPPLIER}`);
    expect(await screen.findByText('Last cost')).toBeTruthy();
    expect(screen.getByText('3.10 EUR per unit')).toBeTruthy();
    // Read-only members get no edit buttons.
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('creates a supplier', async () => {
    const calls = mockApi({
      [`GET /shops/${SHOP}`]: context(['catalog.read', 'catalog.write']),
      'GET /shops': { shops: [] },
      [`GET /shops/${SHOP}/suppliers`]: { suppliers: [], nextCursor: null },
      [`POST /shops/${SHOP}/suppliers`]: { supplier: supplier('active') },
      [`GET /shops/${SHOP}/suppliers/${SUPPLIER}`]: {
        supplier: supplier('active'),
        items: [],
        costVisible: false,
      },
    });
    renderAt(`/app/shops/${SHOP}/suppliers`);
    expect(await screen.findByText('No suppliers yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ceramics Ltd' } });
    fireEvent.change(screen.getByLabelText('Lead time (days)'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create supplier' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      name: 'Ceramics Ltd',
      contactName: null,
      email: null,
      phone: null,
      website: null,
      address: null,
      notes: null,
      leadTimeDays: 10,
    });
    expect(await screen.findByText(/None yet/)).toBeTruthy();
  });
});
