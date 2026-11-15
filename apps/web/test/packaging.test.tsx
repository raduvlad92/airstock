// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarcodesEditor } from '../src/components/catalog/BarcodesEditor.tsx';
import { BundleEditor } from '../src/components/catalog/BundleEditor.tsx';
import { PacksEditor } from '../src/components/catalog/PacksEditor.tsx';
import { ShippingPackagesEditor } from '../src/components/catalog/ShippingPackagesEditor.tsx';
import { SupplierItemsEditor } from '../src/components/catalog/SupplierItemsEditor.tsx';
import type { Packaging } from '../src/components/catalog/shared.tsx';

// N5: the packaging, barcode, bundle, and supplier editors of the detail panel. Each sends the
// list version it read and says plainly when someone else saved first.

const SHOP = '0196f3a0-0000-7000-8000-000000000001';
const PRODUCT = '0196f3a0-0000-7000-8000-000000000002';
const VARIANT = '0196f3a0-0000-7000-8000-000000000003';
const INNER = '0196f3a0-0000-7000-8000-000000000004';
const CASE = '0196f3a0-0000-7000-8000-000000000005';
const COMPONENT = '0196f3a0-0000-7000-8000-000000000006';
const SUPPLIER = '0196f3a0-0000-7000-8000-000000000007';
const ITEM = '0196f3a0-0000-7000-8000-000000000008';
const OTHER_PRODUCT = '0196f3a0-0000-7000-8000-000000000009';

const pack = (id: string, name: string, quantity: string, base: string, inner: string | null) => ({
  id,
  name,
  quantity,
  innerPackId: inner,
  innerPackName: inner ? 'Inner pack' : null,
  baseQuantity: base,
  uses: ['purchasing', 'counting', 'transfer'] as Array<'purchasing' | 'counting' | 'transfer'>,
  dimensions: null,
  weight: null,
  price: null,
  status: 'active' as const,
  version: 1,
});

function packaging(overrides: Partial<Packaging> = {}): Packaging {
  return {
    variantId: VARIANT,
    productId: PRODUCT,
    productName: 'Mug',
    sku: 'MUG-01',
    baseUnit: 'each',
    quantityScale: 0,
    price: '12.50',
    packsVersion: 3,
    barcodesVersion: 5,
    shippingPackagesVersion: 1,
    bundleVersion: 0,
    packs: [pack(INNER, 'Inner pack', '6', '6', null), pack(CASE, 'Case', '4', '24', INNER)],
    barcodes: [
      { id: ITEM, code: '4006381333931', symbology: 'ean13', packId: null, source: 'entered' },
    ],
    shippingPackages: [],
    bundle: null,
    componentOf: [],
    ...overrides,
  };
}

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

type Handler = (body: unknown) => { status?: number; body: unknown } | unknown;

/** Routes by "METHOD path"; records every call with its body. */
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
      const answer =
        out && typeof out === 'object' && 'status' in out && 'body' in out
          ? (out as { status: number; body: unknown })
          : { status: 200, body: out };
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }),
  );
  return calls;
}

function show(ui: ReactNode) {
  const rootRoute = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const conflict = {
  status: 409,
  body: {
    code: 'version_conflict',
    title: 'The packs changed since you read them. Reload and retry.',
    currentVersion: 4,
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const editor = { shopId: SHOP, productId: PRODUCT, variantId: VARIANT };
const PACKAGING = `GET /shops/${SHOP}/variants/${VARIANT}/packaging`;

describe('packs editor', () => {
  it('shows base quantities as you type and saves with the version it read', async () => {
    const calls = mockApi({
      [PACKAGING]: packaging(),
      [`POST /shops/${SHOP}/variants/${VARIANT}/packs`]: {
        packaging: packaging({ packsVersion: 4 }),
      },
    });
    show(<PacksEditor {...editor} />);
    expect(await screen.findByText('Case')).toBeTruthy();
    expect(screen.getByText('24 items')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit packs' }));
    const cases = screen.getByRole('group', { name: 'Pack 2' });
    fireEvent.change(within(cases).getByLabelText('Holds'), { target: { value: '8' } });
    expect(within(cases).getByText('= 48 items')).toBeTruthy();
    // A new pallet of 10 cases, referring to the case by its ID.
    fireEvent.click(screen.getByRole('button', { name: 'Add pack' }));
    const pallet = screen.getByRole('group', { name: 'Pack 3' });
    fireEvent.change(within(pallet).getByLabelText('Name'), { target: { value: 'Pallet' } });
    fireEvent.change(within(pallet).getByLabelText('Holds'), { target: { value: '10' } });
    fireEvent.change(within(pallet).getByLabelText('Of'), { target: { value: CASE } });
    expect(within(pallet).getByText('= 480 items')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save packs' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      packsVersion: 3,
      packs: [
        {
          id: INNER,
          name: 'Inner pack',
          quantity: '6',
          uses: ['purchasing', 'counting', 'transfer'],
          price: null,
        },
        {
          id: CASE,
          name: 'Case',
          quantity: '8',
          innerPack: INNER,
          uses: ['purchasing', 'counting', 'transfer'],
          price: null,
        },
        {
          name: 'Pallet',
          quantity: '10',
          innerPack: CASE,
          uses: ['purchasing', 'counting', 'transfer'],
          price: null,
        },
      ],
    });
    expect(await screen.findByRole('button', { name: 'Edit packs' })).toBeTruthy();
  });

  it('refuses a pack that needs part of an inner pack before saving', async () => {
    mockApi({ [PACKAGING]: packaging() });
    show(<PacksEditor {...editor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit packs' }));
    const cases = screen.getByRole('group', { name: 'Pack 2' });
    fireEvent.change(within(cases).getByLabelText('Holds'), { target: { value: '1.5' } });
    expect(within(cases).getByText(/whole number/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save packs' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('says plainly when someone else saved first, and reloads their version', async () => {
    let reads = 0;
    const calls = mockApi({
      [PACKAGING]: () => {
        reads++;
        return packaging(reads > 1 ? { packsVersion: 4, packs: [] } : {});
      },
      [`POST /shops/${SHOP}/variants/${VARIANT}/packs`]: conflict,
    });
    show(<PacksEditor {...editor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit packs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save packs' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Someone else changed the packs');
    fireEvent.click(within(alert).getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('No packs. Stock is counted in items only.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'GET').length).toBe(2);
  });
});

describe('barcodes editor', () => {
  it('checks the EAN check digit before saving', async () => {
    mockApi({ [PACKAGING]: packaging() });
    show(<BarcodesEditor {...editor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit barcodes' }));
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: '4006381333932' } });
    expect(screen.getByText('The check digit should be 1. Check the number.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Save barcodes' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('names the record that already holds a code, with a link to it', async () => {
    const calls = mockApi({
      [PACKAGING]: packaging(),
      [`POST /shops/${SHOP}/variants/${VARIANT}/barcodes`]: {
        status: 409,
        body: {
          code: 'duplicate_barcode',
          title: 'This barcode already belongs to LAMP-1.',
          existing: {
            productId: OTHER_PRODUCT,
            productName: 'Desk lamp',
            sku: 'LAMP-1',
            packName: null,
          },
        },
      },
    });
    show(<BarcodesEditor {...editor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit barcodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add barcode' }));
    const second = screen.getByRole('group', { name: 'Barcode 2' });
    fireEvent.change(within(second).getByLabelText(/^Code/), { target: { value: '036000291452' } });
    fireEvent.change(within(second).getByLabelText('Type'), { target: { value: 'upca' } });
    fireEvent.change(within(second).getByLabelText('On'), { target: { value: CASE } });
    fireEvent.click(screen.getByRole('button', { name: 'Save barcodes' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('already belongs to Desk lamp (LAMP-1)');
    expect(within(alert).getByRole('link', { name: 'Desk lamp' }).getAttribute('href')).toContain(
      `item=${OTHER_PRODUCT}`,
    );
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      barcodesVersion: 5,
      barcodes: [
        { code: '4006381333931', symbology: 'ean13', packId: null },
        { code: '036000291452', symbology: 'upca', packId: CASE },
      ],
    });
  });

  it('generates an internal code for a pack', async () => {
    const generated = packaging({
      barcodesVersion: 6,
      barcodes: [
        ...packaging().barcodes,
        {
          id: COMPONENT,
          code: 'AS00000042',
          symbology: 'qr',
          packId: CASE,
          source: 'generated',
        },
      ],
    });
    const calls = mockApi({
      [PACKAGING]: packaging(),
      [`POST /shops/${SHOP}/variants/${VARIANT}/barcodes/generate`]: {
        barcode: generated.barcodes[1],
        packaging: generated,
      },
    });
    show(<BarcodesEditor {...editor} />);
    fireEvent.change(await screen.findByLabelText('Generate a code'), { target: { value: 'qr' } });
    fireEvent.change(screen.getByLabelText('For'), { target: { value: CASE } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText('AS00000042')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      symbology: 'qr',
      packId: CASE,
    });
    expect(screen.getByRole('link', { name: 'Print labels' }).getAttribute('href')).toContain(
      `variants=${VARIANT}`,
    );
  });
});

describe('shipping boxes editor', () => {
  it('saves the boxes with the version it read', async () => {
    const calls = mockApi({
      [PACKAGING]: packaging(),
      [`POST /shops/${SHOP}/variants/${VARIANT}/shipping-packages`]: conflict,
    });
    show(<ShippingPackagesEditor {...editor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit boxes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add box' }));
    fireEvent.change(screen.getByLabelText('Dimensions'), {
      target: { value: '120 x 60 x 75 cm' },
    });
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '18 kg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save boxes' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Someone else changed the shipping boxes',
    );
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      shippingPackagesVersion: 1,
      shippingPackages: [{ dimensions: '120 x 60 x 75 cm', weight: '18 kg' }],
    });
  });
});

describe('bundle editor', () => {
  const bundle = packaging({
    bundleVersion: 2,
    bundle: {
      version: 2,
      active: true,
      components: [
        {
          variantId: COMPONENT,
          sku: 'SAUCER-01',
          productName: 'Saucer',
          title: '',
          packId: null,
          packName: null,
          quantity: '2',
          baseQuantity: '2',
          status: 'active',
        },
      ],
    },
  });

  it('shows how many bundles the components allow', async () => {
    mockApi({
      [`GET /shops/${SHOP}`]: context(['catalog.read', 'inventory.read']),
      [PACKAGING]: bundle,
      [`GET /shops/${SHOP}/variants/${VARIANT}/bundle-availability`]: {
        variantId: VARIANT,
        sku: 'MUG-01',
        bundleVersion: 2,
        partial: true,
        available: '7',
        limitedBy: COMPONENT,
        components: [
          {
            variantId: COMPONENT,
            sku: 'SAUCER-01',
            status: 'active',
            perBundle: '2',
            available: '15',
            bundles: '7',
          },
        ],
      },
    });
    show(<BundleEditor {...editor} />);
    expect(await screen.findByText('Saucer')).toBeTruthy();
    expect(await screen.findByText('7')).toBeTruthy();
    expect(screen.getByText(/limited by SAUCER-01/)).toBeTruthy();
    expect(screen.getByText('Counts only the locations you can access.')).toBeTruthy();
  });

  it('hides availability without inventory access and saves with the bundle version', async () => {
    const calls = mockApi({
      [`GET /shops/${SHOP}`]: context(['catalog.read', 'catalog.write']),
      [PACKAGING]: bundle,
      [`GET /shops/${SHOP}/variants/${COMPONENT}/packaging`]: packaging({
        variantId: COMPONENT,
        packs: [pack(INNER, 'Six-pack', '6', '6', null)],
      }),
      [`POST /shops/${SHOP}/variants/${VARIANT}/bundle`]: { packaging: bundle },
    });
    show(<BundleEditor {...editor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit bundle' }));
    expect(calls.some((c) => c.path.endsWith('/bundle-availability'))).toBe(false);
    const line = screen.getByRole('group', { name: 'Component 1' });
    fireEvent.change(within(line).getByLabelText('Quantity'), { target: { value: '1' } });
    await within(line).findByRole('option', { name: 'Six-pack (6 items)' });
    fireEvent.change(within(line).getByLabelText('Counted in'), { target: { value: INNER } });
    fireEvent.click(screen.getByRole('button', { name: 'Save bundle' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      bundleVersion: 2,
      components: [{ variantId: COMPONENT, packId: INNER, quantity: '1' }],
    });
  });
});

describe('supplier items editor', () => {
  const item = (costVisible: boolean) => ({
    id: ITEM,
    supplierId: SUPPLIER,
    supplierName: 'Ceramics Ltd',
    variantId: VARIANT,
    productId: PRODUCT,
    productName: 'Mug',
    sku: 'MUG-01',
    packId: CASE,
    packName: 'Case',
    packBaseQuantity: '24',
    supplierSku: 'CL-77',
    costVisible,
    lastCost: costVisible ? '12.4' : null,
    lastCostAt: null,
    minimumOrderQuantity: '5',
    preferred: true,
    status: 'active' as const,
    version: 3,
  });

  it('shows the cost only when the answer says it is visible', async () => {
    mockApi({
      [`GET /shops/${SHOP}`]: context(['catalog.read', 'costs.read']),
      [PACKAGING]: packaging(),
      [`GET /shops/${SHOP}/supplier-items`]: {
        items: [item(true)],
        costVisible: true,
        nextCursor: null,
      },
    });
    show(<SupplierItemsEditor {...editor} />);
    expect(await screen.findByText(/12\.40 EUR per Case/)).toBeTruthy();
    expect(screen.getByText(/SKU CL-77/)).toBeTruthy();
    expect(screen.getByText('preferred')).toBeTruthy();
  });

  it('leaves the cost out without costs access, and edits with the version read', async () => {
    const calls = mockApi({
      [`GET /shops/${SHOP}`]: context(['catalog.read', 'catalog.write']),
      [PACKAGING]: packaging(),
      [`GET /shops/${SHOP}/supplier-items`]: {
        items: [item(false)],
        costVisible: false,
        nextCursor: null,
      },
      [`POST /shops/${SHOP}/supplier-items`]: { item: item(false) },
    });
    show(<SupplierItemsEditor {...editor} />);
    expect(await screen.findByText('Ceramics Ltd')).toBeTruthy();
    expect(screen.queryByText(/EUR per/)).toBeNull();
    expect(screen.getByText('Costs are hidden: they need the costs permission.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByLabelText(/Last cost/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Supplier SKU'), { target: { value: 'CL-78' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      itemId: ITEM,
      expectedVersion: 3,
      packId: CASE,
      supplierSku: 'CL-78',
      minimumOrderQuantity: '5',
      preferred: true,
    });
  });

  it('adds a supplier with a cost when costs are visible', async () => {
    const calls = mockApi({
      [`GET /shops/${SHOP}`]: context(['catalog.read', 'catalog.write', 'costs.read']),
      [PACKAGING]: packaging(),
      [`GET /shops/${SHOP}/supplier-items`]: { items: [], costVisible: true, nextCursor: null },
      [`GET /shops/${SHOP}/suppliers`]: {
        suppliers: [
          {
            id: SUPPLIER,
            name: 'Ceramics Ltd',
            contactName: null,
            email: null,
            phone: null,
            website: null,
            address: null,
            currency: 'EUR',
            leadTimeDays: 10,
            notes: null,
            status: 'active',
            version: 1,
            itemCount: 0,
            createdAt: '2026-11-01T00:00:00.000Z',
            updatedAt: '2026-11-01T00:00:00.000Z',
          },
        ],
        nextCursor: null,
      },
      [`POST /shops/${SHOP}/supplier-items`]: { item: item(true) },
    });
    show(<SupplierItemsEditor {...editor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a supplier' }));
    fireEvent.change(await screen.findByLabelText('Supplier'), { target: { value: SUPPLIER } });
    fireEvent.change(screen.getByLabelText('Sold in'), { target: { value: CASE } });
    fireEvent.change(screen.getByLabelText(/Last cost/), { target: { value: '12.40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      supplierId: SUPPLIER,
      variantId: VARIANT,
      packId: CASE,
      supplierSku: null,
      minimumOrderQuantity: null,
      preferred: true,
      lastCost: '12.40',
    });
  });
});
