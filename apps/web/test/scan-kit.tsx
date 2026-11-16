import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { AppInfoProvider } from '../src/context.tsx';
import { routeTree } from '../src/router.tsx';

// Shared stand-ins for the scan page's component tests: a stubbed API (each call recorded), the
// page rendered at /app/scan, and codes typed into the scan field as a wedge scanner would.

export const SHOP = '0196f3a0-0000-7000-8000-000000000001';
export const LOC = '0196f3a0-0000-7000-8000-0000000000b1';
export const VAR = '0196f3a0-0000-7000-8000-0000000000d1';
export const PROD = '0196f3a0-0000-7000-8000-0000000000e1';
export const CASE = '0196f3a0-0000-7000-8000-0000000000f1';
export const SLAB = '0196f3a0-0000-7000-8000-0000000000d2';

export function context(permissions: string[]) {
  return {
    shop: { id: SHOP, name: 'Card shop', currency: 'EUR', timezone: 'Europe/Bucharest' },
    role: 'inventory_operator',
    permissions,
    allLocations: true,
    locationScopeIds: [],
    connectionScopes: 'all',
    rateLimits: [],
  };
}

export const LOCATION = {
  code: `LOC:${LOC.toUpperCase()}`,
  kind: 'location',
  location: {
    locationId: LOC,
    warehouseId: '0196f3a0-0000-7000-8000-0000000000a1',
    warehouseName: 'Main stock',
    path: 'Main stock/B-02',
    code: 'B-02',
    holdsStock: true,
  },
  item: null,
  stock: null,
};

export function item(over: Record<string, unknown> = {}) {
  return {
    variantId: VAR,
    productId: PROD,
    productName: 'Booster box',
    variantName: null,
    sku: 'BOX-1',
    trackingMode: 'none',
    oneOfAKind: false,
    quantityScale: 0,
    matchedBy: 'barcode',
    pack: null,
    serial: null,
    packs: [{ packId: CASE, name: 'Case', baseQuantity: '6' }],
    ...over,
  };
}

export const STOCK = {
  variantId: VAR,
  sku: 'BOX-1',
  trackingMode: 'none',
  partial: false,
  totals: {
    onHand: '12',
    sellableOnHand: '12',
    reserved: '2',
    available: '10',
    quarantined: '0',
    damaged: '0',
    repair: '0',
    supplierReturn: '0',
    expired: '0',
    inTransit: '0',
    ownedTotal: '12',
    shortage: '0',
  },
  positions: [
    {
      positionId: '0196f3a0-0000-7000-8000-000000000101',
      locationId: LOC,
      locationPath: 'Main stock/B-02',
      warehouseId: null,
      condition: 'sellable',
      lotId: null,
      lotCode: null,
      expiresOn: null,
      lotExpired: false,
      serial: null,
      inTransit: false,
      sellable: true,
      onHand: '12',
      reserved: '2',
      available: '10',
    },
  ],
  costVisible: false,
  cost: null,
};

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  key: string | null;
}

export type Handler = (call: Call) => unknown;

export function mockApi(routes: Record<string, unknown | Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname.replace('/api/v1', '');
      const headers = (init.headers ?? {}) as Record<string, string>;
      const call: Call = {
        method: init.method ?? 'GET',
        path,
        query: Object.fromEntries(url.searchParams),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        key: headers['idempotency-key'] ?? null,
      };
      calls.push(call);
      const route = routes[`${call.method} ${path}`] ?? routes[path];
      // A handler may answer later (a promise), to stage lookups that come back out of order.
      const body = typeof route === 'function' ? await (route as Handler)(call) : route;
      if (body === undefined) {
        return new Response(JSON.stringify({ code: 'not_found', title: 'Not found' }), {
          status: 404,
        });
      }
      if (body instanceof Problem) {
        return new Response(JSON.stringify(body.problem), { status: body.status });
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

/** A route's answer that is an RFC 9457 problem with this status instead of a 200. */
export class Problem {
  constructor(
    readonly status: number,
    readonly problem: Record<string, unknown>,
  ) {}
}

export function renderScan(search = '') {
  // A built-in detector, so the page does not fetch the zxing script into happy-dom.
  vi.stubGlobal(
    'BarcodeDetector',
    Object.assign(
      function BarcodeDetector() {
        return { detect: async () => [] };
      },
      { getSupportedFormats: async () => ['ean_13', 'code_128', 'qr_code'] },
    ),
  );
  const router = createRouter({
    routeTree,
    basepath: '/app',
    history: createMemoryHistory({ initialEntries: [`/app/scan${search}`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <AppInfoProvider info={{ email: 'me@example.test', mcpUrl: 'https://airstock.test/mcp' }}>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppInfoProvider>,
  );
}

export async function scan(code: string) {
  const field = await screen.findByRole('textbox', { name: 'Code' });
  fireEvent.change(field, { target: { value: code } });
  fireEvent.submit(field.closest('form')!);
}

export function scanRoutes(byCode: Record<string, unknown>): Handler {
  return (call) =>
    byCode[call.query.code ?? ''] ?? {
      code: call.query.code,
      kind: 'unknown',
      location: null,
      item: null,
      stock: null,
    };
}

export const BASE = (permissions: string[]) => ({
  [`/shops/${SHOP}`]: context(permissions),
  '/shops': {
    shops: [{ id: SHOP, name: 'Card shop', role: 'owner', currency: 'EUR', timezone: 'UTC' }],
  },
});

export const OPERATOR = ['shop.read', 'catalog.read', 'inventory.read', 'inventory.receive'];
