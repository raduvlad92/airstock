// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppInfoProvider } from '../src/context.tsx';
import { routeTree } from '../src/router.tsx';

const SHOP = '0196f3a0-0000-7000-8000-000000000001';
const ATTEMPT = '0196f3a0-0000-7000-8000-0000000000a1';
const VARIANT = '0196f3a0-0000-7000-8000-0000000000b1';

const context = {
  shop: {
    id: SHOP,
    name: 'Bibica',
    currency: 'EUR',
    timezone: 'Europe/Bucharest',
    displayUnits: 'metric',
  },
  role: 'owner',
  permissions: ['shop.read', 'activity.read', 'exports.run', 'storage.read'],
  allLocations: true,
  locationScopeIds: [],
  connectionScopes: 'all',
  rateLimits: [],
};

const event = (over: Record<string, unknown>) => ({
  eventId: '0196f3a0-0000-7000-8000-0000000000e1',
  occurredAt: '2026-11-16T10:00:00.000Z',
  action: 'inventory.receipt.created',
  phase: 'outcome',
  outcome: 'succeeded',
  source: 'dashboard',
  actorType: 'user',
  actorId: '0196f3a0-0000-7000-8000-0000000000c1',
  clientId: null,
  targetType: 'variant',
  targetId: VARIANT,
  operationId: null,
  attemptId: ATTEMPT,
  requestId: null,
  locationIds: null,
  externalRef: null,
  reason: null,
  changes: null,
  error: null,
  ...over,
});

/** Answers the API from a table of paths and records each activity request's parameters. */
function mockApi() {
  const searches: URLSearchParams[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname.replace('/api/v1', '');
      const routes: Record<string, unknown> = {
        [`/shops/${SHOP}`]: context,
        '/shops': { shops: [] },
        [`/shops/${SHOP}/members`]: {
          members: [
            {
              membershipId: '0196f3a0-0000-7000-8000-0000000000d1',
              userId: '0196f3a0-0000-7000-8000-0000000000c1',
              email: 'ana@example.test',
              displayName: 'Ana',
              role: 'owner',
              allLocations: true,
              locationScopeIds: [],
              status: 'active',
            },
          ],
          invitations: [],
        },
        [`/shops/${SHOP}/connections`]: { connections: [] },
        [`/shops/${SHOP}/warehouses`]: { warehouses: [] },
        [`/shops/${SHOP}/locations`]: { locations: [] },
        [`/shops/${SHOP}/activity`]: {
          events: [
            event({}),
            event({
              eventId: '0196f3a0-0000-7000-8000-0000000000e2',
              phase: 'attempt',
              outcome: 'received',
              targetType: null,
              targetId: null,
            }),
          ],
          nextCursor: null,
          lifecycle: url.searchParams.get('attemptId')
            ? {
                attemptId: ATTEMPT,
                action: 'inventory.receipt.created',
                status: 'succeeded',
                startedAt: '2026-11-16T09:59:59.800Z',
                finishedAt: '2026-11-16T10:00:00.000Z',
                durationMs: 200,
                lastEventAt: '2026-11-16T10:00:00.000Z',
                events: 2,
                problems: 0,
              }
            : null,
          ingestion: {
            delayed: true,
            pendingRequests: 2,
            oldestPendingSeconds: 12,
            lastBatchAt: '2026-11-16T10:00:00.000Z',
            lastBatchLagSeconds: 1,
            newestEventAt: '2026-11-16T10:00:00.000Z',
          },
        },
      };
      if (path === `/shops/${SHOP}/activity`) searches.push(url.searchParams);
      const body = routes[path];
      if (body === undefined)
        return new Response(JSON.stringify({ code: 'not_found', title: 'Not found' }), {
          status: 404,
        });
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return searches;
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

describe('activity page (PRD 7.4)', () => {
  it('sends the filters in the address, shows the request’s lifecycle and the delay', async () => {
    const searches = mockApi();
    renderAt(
      `/app/shops/${SHOP}/activity?who=type:api_credential&source=api&action=inventory.*&attempt=${ATTEMPT}&from=2026-11-01&to=2026-11-15`,
    );
    expect(await screen.findByRole('heading', { name: 'Request' })).toBeTruthy();
    const sent = searches.at(-1)!;
    expect(sent.get('actorType')).toBe('api_credential');
    expect(sent.get('source')).toBe('api');
    expect(sent.get('action')).toBe('inventory.*');
    expect(sent.get('attemptId')).toBe(ATTEMPT);
    // "To" includes its day: the search ends at the next midnight.
    expect(Date.parse(sent.get('to')!) - Date.parse(sent.get('from')!)).toBeGreaterThan(
      14 * 86_400_000,
    );
    expect(screen.getByText(/took 200 ms/)).toBeTruthy();
    expect(screen.getByText(/The history is catching up/).textContent).toContain(
      '2 recent commands are still on the way, the oldest for 12 s',
    );
    expect(screen.getByText(/One request/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeTruthy();
  });

  it('filters from the dropdowns and links each record to its history', async () => {
    const searches = mockApi();
    renderAt(`/app/shops/${SHOP}/activity`);
    const table = await screen.findByRole('table', { name: 'Activity' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), {
      target: { value: 'mcp' },
    });
    await waitFor(() => expect(searches.at(-1)!.get('source')).toBe('mcp'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Who' }), {
      target: { value: 'user:0196f3a0-0000-7000-8000-0000000000c1' },
    });
    await waitFor(() =>
      expect(searches.at(-1)!.get('actorId')).toBe('0196f3a0-0000-7000-8000-0000000000c1'),
    );
    const record = table.querySelector(`a[href*="targetId=${VARIANT}"]`);
    expect(record?.textContent).toContain('variant');
    expect(table.querySelector(`a[href*="attempt=${ATTEMPT}"]`)).not.toBeNull();
  });
});
