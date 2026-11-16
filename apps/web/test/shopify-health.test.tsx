// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncHealth } from '../src/pages/shopify-health.tsx';

// I6 part 4: the sync health section of a connected Shopify store.

const SHOP = '0196f3a0-0000-7000-8000-000000000001';
const CONNECTION = '0196f3a0-0000-7000-8000-0000000000d1';

const HEALTH = {
  connections: [
    {
      connectionId: CONNECTION,
      shopDomain: 'store.myshopify.com',
      status: 'active',
      lastSyncAt: '2026-11-16T10:00:00.000Z',
      lastPushedAt: '2026-11-16T09:59:00.000Z',
      lastWebhookAt: null,
      ordersSyncedThrough: '2026-11-16T09:55:00.000Z',
      levelsComparedAt: null,
      lastError: null,
      pendingPushes: { count: 0, levels: [] },
      conflicts: [
        {
          inventoryItemId: '44001',
          shopifyLocationId: '1001',
          shopifyLocationName: 'Shop location',
          scopeName: 'Home/Shelf A',
          variantId: '0196f3a0-0000-7000-8000-0000000000e1',
          sku: 'ETB-PRE-01',
          sells: 'unit',
          shopifyVariantId: '55001',
          expected: 4,
          airstock: 4,
          shopify: 9,
          since: '2026-11-16T09:00:00.000Z',
          alertId: null,
        },
      ],
      shortages: [
        {
          reservationId: '0196f3a0-0000-7000-8000-0000000000f1',
          variantId: '0196f3a0-0000-7000-8000-0000000000e1',
          sku: 'ETB-PRE-01',
          externalRef: 'shopify:order/1/line/2',
          quantity: '3',
          shortage: '1',
          since: '2026-11-16T08:00:00.000Z',
        },
      ],
      unmappedVariants: {
        count: 1,
        sample: [
          {
            shopifyVariantId: '66001',
            inventoryItemId: '77001',
            sku: 'BOOSTER-1',
            title: 'Booster',
          },
        ],
      },
      unmappedLocations: [{ id: '1002', name: 'Warehouse' }],
      listings: {
        count: 2,
        pending: 0,
        failed: [],
        differences: [
          {
            productId: '0196f3a0-0000-7000-8000-0000000000e2',
            name: 'Booster box',
            field: 'title',
            airstock: 'Booster box',
            shopify: 'Booster box (Shopify)',
            changedBy: 'shopify',
            detectedAt: '2026-11-16T09:30:00.000Z',
          },
        ],
      },
      mappings: { locations: [], variantCount: 1, variants: [] },
    },
  ],
};

function renderHealth() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SyncHealth shopId={SHOP} connectionId={CONNECTION} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Shopify sync health', () => {
  it('lists conflicts, shortages, and unmapped records, and resolves a conflict', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.includes('/conflicts/resolve')) {
          return new Response(
            JSON.stringify({
              choice: 'push_airstock',
              airstock: 4,
              shopify: 9,
              adjustmentOperationIds: [],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(HEALTH), { status: 200 });
      }),
    );
    renderHealth();
    expect(await screen.findAllByText('ETB-PRE-01', { selector: 'td' })).toHaveLength(2);
    expect(screen.getByText('shopify:order/1/line/2')).toBeTruthy();
    expect(screen.getByText(/Shopify locations not synced: Warehouse/)).toBeTruthy();
    expect(screen.getByText('Booster')).toBeTruthy();
    // A Shopify edit to a field Airstock owns, with both choices.
    expect(screen.getByText('Booster box (Shopify)')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Take Shopify’s' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Push Airstock’s' })[0]!);
    await waitFor(() => expect(screen.getByText('Resolved.')).toBeTruthy());
    const resolve = calls.find((c) => c.url.includes('/conflicts/resolve'))!;
    expect(resolve.body).toEqual({
      connectionId: CONNECTION,
      inventoryItemId: '44001',
      shopifyLocationId: '1001',
      choice: 'push_airstock',
    });
    // "Map…" on an unmapped variant fills the mapping form.
    fireEvent.click(screen.getByRole('button', { name: 'Map…' }));
    expect((screen.getByLabelText('Shopify variant ID') as HTMLInputElement).value).toBe('66001');
    expect((screen.getByLabelText('Shopify inventory item ID') as HTMLInputElement).value).toBe(
      '77001',
    );
  });
});
