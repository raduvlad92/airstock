// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppInfoProvider } from '../src/context.tsx';
import { routeTree } from '../src/router.tsx';

// N6: warehouse cards, the commercial section, the location tree, and member location scopes.

const SHOP = '0196f3a0-0000-7000-8000-000000000001';
const WH = '0196f3a0-0000-7000-8000-0000000000a1';
const LOC = '0196f3a0-0000-7000-8000-0000000000b1';
const MEMBER = '0196f3a0-0000-7000-8000-0000000000c1';

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

const CONTRACT = {
  startDate: '2026-01-01',
  endDate: null,
  feeDescription: 'Storage and handling',
  currency: 'EUR',
  rates: [{ description: 'Storage per pallet', amount: '12.50', unit: 'pallet per week' }],
  notes: null,
  attachmentMediaIds: [],
};

function warehouses(commercial: boolean) {
  return {
    partial: false,
    commercialVisible: commercial,
    warehouses: [
      {
        warehouseId: WH,
        name: 'Rented hall',
        ownership: 'rented',
        operatorName: 'Hall Logistics',
        timezone: null,
        address: { city: 'Cluj', country: 'RO' },
        contact: null,
        providerRefs: [],
        operatingStatus: 'operating',
        fulfillmentEligible: true,
        status: 'active',
        activeLocations: 1,
        version: 3,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
        archivedAt: null,
        ...(commercial ? { contract: CONTRACT } : {}),
      },
    ],
  };
}

const LOCATIONS = {
  partial: false,
  locations: [
    {
      locationId: LOC,
      warehouseId: WH,
      warehouseName: 'Rented hall',
      ownership: 'rented',
      parentId: null,
      name: 'Bay 1',
      code: null,
      path: 'Rented hall/Bay 1',
      holdsStockAllowed: true,
      fulfillmentEligible: true,
      effectiveFulfillmentEligible: true,
      status: 'active',
      version: 2,
    },
  ],
};

function mockApi(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname.replace('/api/v1', '');
      calls.push({
        method: init.method ?? 'GET',
        path,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const body = routes[path];
      if (body === undefined)
        return new Response(JSON.stringify({ code: 'not_found', title: 'Not found' }), {
          status: 404,
        });
      return new Response(JSON.stringify(body), { status: 200 });
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STORAGE = ['shop.read', 'storage.read', 'storage.manage'];

describe('warehouses page', () => {
  it('shows the contract only to members with commercial access', async () => {
    mockApi({
      [`/shops/${SHOP}`]: context([...STORAGE, 'storage.commercial.read']),
      '/shops': { shops: [] },
      [`/shops/${SHOP}/warehouses`]: warehouses(true),
      [`/shops/${SHOP}/locations`]: LOCATIONS,
    });
    renderAt(`/app/shops/${SHOP}/warehouses`);
    expect(await screen.findByRole('heading', { name: 'Rented hall' })).toBeTruthy();
    expect(await screen.findByText('Hall Logistics')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Contract' })).toBeTruthy();
    expect(screen.getByText('Storage per pallet')).toBeTruthy();
    expect(screen.getByText('12.50 EUR')).toBeTruthy();
  });

  it('leaves the commercial section out without the permission, including in the edit form', async () => {
    const calls = mockApi({
      [`/shops/${SHOP}`]: context(STORAGE),
      '/shops': { shops: [] },
      [`/shops/${SHOP}/warehouses`]: warehouses(false),
      [`/shops/${SHOP}/locations`]: LOCATIONS,
      [`/shops/${SHOP}/warehouses/${WH}`]: { warehouse: warehouses(false).warehouses[0] },
    });
    renderAt(`/app/shops/${SHOP}/warehouses`);
    expect(await screen.findByText('Hall Logistics')).toBeTruthy();
    expect(screen.queryByText('Contract')).toBeNull();
    expect(screen.queryByText('Storage per pallet')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    expect(await screen.findByLabelText(/^Operator/)).toBeTruthy();
    expect(screen.queryByText('Contract')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === `/shops/${SHOP}/warehouses/${WH}`)).toBe(true),
    );
    const save = calls.find((c) => c.path === `/shops/${SHOP}/warehouses/${WH}`)!;
    expect(save.body).toMatchObject({ expectedVersion: 3, operatorName: 'Hall Logistics' });
    expect(save.body).not.toHaveProperty('contract');
  });

  it('starts the time zone, country, and currency from the shop when the warehouse has none', async () => {
    const bare = { ...warehouses(true), warehouses: [] as unknown[] };
    bare.warehouses = [{ ...warehouses(true).warehouses[0]!, address: null, contract: null }];
    const calls = mockApi({
      [`/shops/${SHOP}`]: context([...STORAGE, 'storage.commercial.read']),
      '/shops': { shops: [] },
      [`/shops/${SHOP}/warehouses`]: bare,
      [`/shops/${SHOP}/locations`]: LOCATIONS,
      [`/shops/${SHOP}/warehouses/${WH}`]: { warehouse: bare.warehouses[0] },
    });
    renderAt(`/app/shops/${SHOP}/warehouses`);
    expect(await screen.findByText('Europe/Bucharest')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    const form = (await screen.findByRole('button', { name: 'Save' })).closest('form')!;
    const pick = (label: string) => within(form).getByLabelText(label) as HTMLSelectElement;
    expect(pick('Time zone').value).toBe('Europe/Bucharest');
    expect(pick('Country').value).toBe('RO');
    expect(pick('Country').selectedOptions[0]!.textContent).toBe('Romania');
    expect(pick('Currency').value).toBe('EUR');
    expect(within(form).queryByText(/Empty uses the shop/)).toBeNull();
    expect(
      within(form).getByPlaceholderText(
        "The site's IDs in other systems, one per line: provider: ID",
      ),
    ).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Fees'), { target: { value: 'Per pallet' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === `/shops/${SHOP}/warehouses/${WH}`)).toBe(true),
    );
    const save = calls.find((c) => c.path === `/shops/${SHOP}/warehouses/${WH}`)!;
    // The shop's own zone stays null, so the warehouse follows the shop if it changes.
    expect(save.body).toMatchObject({
      timezone: null,
      address: { country: 'RO' },
      contract: { feeDescription: 'Per pallet', currency: 'EUR' },
    });
  });

  it('renames a location with the version it read', async () => {
    const calls = mockApi({
      [`/shops/${SHOP}`]: context(STORAGE),
      '/shops': { shops: [] },
      [`/shops/${SHOP}/warehouses`]: warehouses(false),
      [`/shops/${SHOP}/locations`]: LOCATIONS,
      [`/shops/${SHOP}/locations/${LOC}`]: {
        location: LOCATIONS.locations[0],
        locationsRenamed: 1,
      },
    });
    renderAt(`/app/shops/${SHOP}/warehouses`);
    expect(await screen.findByText('Bay 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move' })).toBeTruthy();
    // The second Edit button belongs to the location row.
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]!);
    // The add-location form has a Code field too; use the one in the row's edit form.
    const save = await screen.findByRole('button', { name: 'Save' });
    fireEvent.change(within(save.closest('form')!).getByLabelText('Code'), {
      target: { value: 'B-01' },
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(calls.some((c) => c.path === `/shops/${SHOP}/locations/${LOC}`)).toBe(true),
    );
    expect(calls.find((c) => c.path === `/shops/${SHOP}/locations/${LOC}`)!.body).toEqual({
      expectedVersion: 2,
      name: 'Bay 1',
      code: 'B-01',
      fulfillmentEligible: true,
    });
  });
});

describe('member location scopes', () => {
  it('limits a member to a warehouse from the members page', async () => {
    const calls = mockApi({
      [`/shops/${SHOP}`]: context(['shop.read', 'storage.read', 'members.manage']),
      '/shops': { shops: [] },
      [`/shops/${SHOP}/warehouses`]: warehouses(false),
      [`/shops/${SHOP}/locations`]: LOCATIONS,
      [`/shops/${SHOP}/members`]: {
        members: [
          {
            membershipId: MEMBER,
            userId: MEMBER,
            email: 'picker@example.test',
            displayName: null,
            role: 'inventory_operator',
            allLocations: true,
            locationScopeIds: [],
            status: 'active',
          },
        ],
        invitations: [],
      },
      [`/shops/${SHOP}/members/${MEMBER}/location-scope`]: {
        membershipId: MEMBER,
        allLocations: false,
        locationScopeIds: [WH],
        version: 2,
      },
    });
    renderAt(`/app/shops/${SHOP}/settings/members`);
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    fireEvent.click(await screen.findByLabelText(/Only the warehouses and locations/));
    fireEvent.click(await screen.findByLabelText('Rented hall'));
    // A chosen warehouse covers its locations.
    expect((screen.getByLabelText('Bay 1') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/location-scope'))).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/location-scope'))!.body).toEqual({
      allLocations: false,
      scopeIds: [WH],
    });
  });
});
