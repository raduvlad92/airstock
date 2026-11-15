// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppInfoProvider } from '../src/context.tsx';
import { routeTree } from '../src/router.tsx';

const SHOP = '0196f3a0-0000-7000-8000-000000000001';

const EMPTY_SCHEMA = {
  fields: [],
  families: [],
  templates: [],
  units: { display: 'metric', kinds: {} },
  limits: { activeFieldsPerShop: 300 },
  currency: 'EUR',
};

function context(permissions: string[]) {
  return {
    shop: {
      id: SHOP,
      name: 'Bibica',
      currency: 'EUR',
      timezone: 'Europe/Bucharest',
      displayUnits: 'metric',
    },
    role: 'viewer',
    permissions,
    allLocations: true,
    locationScopeIds: [],
    connectionScopes: 'all',
    rateLimits: [{ kind: 'session', label: 'Dashboard session, per user', perSecond: 20 }],
  };
}

/** Answers /api/v1 calls from a table of paths; records what was called. */
function mockApi(routes: Record<string, unknown>) {
  const calls: Array<{ path: string; headers: Record<string, string>; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname.replace('/api/v1', '');
      calls.push({
        path,
        headers: (init.headers ?? {}) as Record<string, string>,
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

describe('dashboard shell', () => {
  it('shows only the sections the member has permission for', async () => {
    mockApi({
      [`/shops/${SHOP}`]: context(['shop.read', 'catalog.read', 'activity.read']),
      '/shops': {
        shops: [
          {
            id: SHOP,
            name: 'Bibica',
            currency: 'EUR',
            timezone: 'Europe/Bucharest',
            role: 'viewer',
          },
        ],
      },
      [`/shops/${SHOP}/catalog/schema`]: EMPTY_SCHEMA,
      [`/shops/${SHOP}/items/query`]: {
        mode: 'variants',
        rows: [],
        nextCursor: null,
        total: 0,
        totalCapped: false,
      },
      [`/shops/${SHOP}/saved-views`]: { views: [] },
    });
    renderAt(`/app/shops/${SHOP}/products`);
    const nav = await screen.findByRole('navigation', { name: 'Shop' });
    await waitFor(() => expect(nav.textContent).toContain('Products'));
    expect(nav.textContent).toContain('Activity');
    expect(nav.textContent).not.toContain('Inventory');
    expect(nav.textContent).not.toContain('Warehouses');
    expect(await screen.findByText('No products yet. Add one to start.')).toBeTruthy();
  });

  it('calls the API with the custom header that cross-site pages cannot send', async () => {
    const calls = mockApi({
      [`/shops/${SHOP}`]: context(['shop.read']),
      '/shops': { shops: [] },
    });
    renderAt(`/app/shops/${SHOP}/settings/shop`);
    expect(await screen.findByText('20 per second')).toBeTruthy();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.headers['x-airstock-request']).toBe('1');
  });

  it('redirects a shop index to its products', async () => {
    mockApi({
      [`/shops/${SHOP}`]: context(['shop.read', 'catalog.read']),
      '/shops': { shops: [] },
      [`/shops/${SHOP}/catalog/schema`]: EMPTY_SCHEMA,
      [`/shops/${SHOP}/items/query`]: {
        mode: 'variants',
        rows: [],
        nextCursor: null,
        total: 0,
        totalCapped: false,
      },
      [`/shops/${SHOP}/saved-views`]: { views: [] },
    });
    const router = renderAt(`/app/shops/${SHOP}`);
    await waitFor(() =>
      expect(router.history.location.pathname).toBe(`/app/shops/${SHOP}/products`),
    );
  });
});
