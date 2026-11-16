import { describe, expect, it } from 'vitest';
import { httpShopifyAdmin, throttleWaitMs } from '../src/admin.ts';

// The Admin client's batched inventory calls and its backoff on Shopify's cost limit.

function fakeFetch(responses: Array<{ status?: number; body: unknown; headers?: object }>) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const quantities = [
  { inventoryItemId: '11', locationId: '1001', quantity: 5, from: 4 },
  { inventoryItemId: '12', locationId: '1001', quantity: 2, from: 3 },
];

describe('Shopify Admin client', () => {
  it('sets many quantities in one call, each with changeFromQuantity', async () => {
    const { fetch, calls } = fakeFetch([
      { body: { data: { inventorySetQuantities: { userErrors: [] } } } },
    ]);
    const admin = httpShopifyAdmin('a.myshopify.com', 'token', fetch);
    expect(await admin.setAvailable({ quantities, idempotencyKey: 'k', reference: 'r' })).toEqual({
      kind: 'set',
    });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.variables.input as { quantities: unknown[] }).quantities).toEqual([
      {
        inventoryItemId: 'gid://shopify/InventoryItem/11',
        locationId: 'gid://shopify/Location/1001',
        quantity: 5,
        changeFromQuantity: 4,
      },
      {
        inventoryItemId: 'gid://shopify/InventoryItem/12',
        locationId: 'gid://shopify/Location/1001',
        quantity: 2,
        changeFromQuantity: 3,
      },
    ]);
  });

  it('names the stale quantities from the error field paths', async () => {
    const stale = (field: string[] | null) => ({
      data: {
        inventorySetQuantities: {
          userErrors: [{ code: 'CHANGE_FROM_QUANTITY_STALE', field, message: 'stale' }],
        },
      },
    });
    const { fetch } = fakeFetch([
      { body: stale(['input', 'quantities', '1', 'changeFromQuantity']) },
      { body: stale(null) },
    ]);
    const admin = httpShopifyAdmin('a.myshopify.com', 'token', fetch);
    const input = { quantities, idempotencyKey: 'k', reference: 'r' };
    expect(await admin.setAvailable(input)).toEqual({ kind: 'refused', stale: [1], failed: [] });
    // Without a path, every quantity is a suspect; the push reads Shopify before deciding.
    expect(await admin.setAvailable(input)).toEqual({
      kind: 'refused',
      stale: [0, 1],
      failed: [],
    });
  });

  it('names quantities refused for another reason, and fails a refusal tied to none', async () => {
    const refused = (errors: unknown[]) => ({
      data: { inventorySetQuantities: { userErrors: errors } },
    });
    const { fetch } = fakeFetch([
      {
        body: refused([
          {
            code: 'INVALID_INVENTORY_ITEM',
            field: ['input', 'quantities', '0', 'inventoryItemId'],
            message: 'The specified inventory item could not be found.',
          },
          {
            code: 'CHANGE_FROM_QUANTITY_STALE',
            field: ['input', 'quantities', '1', 'changeFromQuantity'],
            message: 'stale',
          },
        ]),
      },
      {
        body: refused([{ code: 'INVALID_INVENTORY_ITEM', field: null, message: 'Not found.' }]),
      },
    ]);
    const admin = httpShopifyAdmin('a.myshopify.com', 'token', fetch);
    const input = { quantities, idempotencyKey: 'k', reference: 'r' };
    expect(await admin.setAvailable(input)).toEqual({
      kind: 'refused',
      stale: [1],
      failed: [
        {
          index: 0,
          code: 'INVALID_INVENTORY_ITEM',
          message: 'The specified inventory item could not be found.',
        },
      ],
    });
    // Shopify did not say which quantity: the push splits the batch to find it.
    await expect(admin.setAvailable(input)).rejects.toMatchObject({
      code: 'INVALID_INVENTORY_ITEM',
      retryable: false,
    });
  });

  it('waits for the cost bucket when throttled, then retries', async () => {
    const throttled = {
      errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
      extensions: {
        cost: {
          requestedQueryCost: 10,
          throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 0, restoreRate: 100 },
        },
      },
    };
    const { fetch, calls } = fakeFetch([
      { body: throttled },
      { body: { data: { inventorySetQuantities: { userErrors: [] } } } },
    ]);
    const admin = httpShopifyAdmin('a.myshopify.com', 'token', fetch);
    const started = Date.now();
    expect(
      await admin.setAvailable({ quantities, idempotencyKey: 'k', reference: 'r' }),
    ).toMatchObject({ kind: 'set' });
    expect(calls).toHaveLength(2);
    // 10 points at 100 per second: the 250 ms floor.
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    expect(throttleWaitMs(throttled.extensions.cost)).toBe(250);
  });

  it('reads available for many items at once, keyed item@location', async () => {
    const { fetch, calls } = fakeFetch([
      {
        body: {
          data: {
            nodes: [
              {
                id: 'gid://shopify/InventoryItem/11',
                inventoryLevels: {
                  nodes: [
                    {
                      location: { id: 'gid://shopify/Location/1001' },
                      quantities: [{ name: 'available', quantity: 7 }],
                    },
                  ],
                },
              },
              null,
            ],
          },
        },
      },
    ]);
    const admin = httpShopifyAdmin('a.myshopify.com', 'token', fetch);
    expect([...(await admin.getAvailable(['11', '12']))]).toEqual([['11@1001', 7]]);
    expect(calls[0]!.variables.ids).toEqual([
      'gid://shopify/InventoryItem/11',
      'gid://shopify/InventoryItem/12',
    ]);
  });
});
