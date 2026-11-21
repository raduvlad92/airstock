import { execute, ops, uuidv7 } from '@airstock/core';
import { reconcileConnection, type ShopifyVariant } from '@airstock/shopify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, ownerQuery } from '../../../test/helpers.ts';
import type { FakeStore } from './fake-shopify.ts';
import { json } from './setup.ts';
import { type Merchant, type ShopifyHarness, shopifyHarness } from './shopify-harness.ts';

// I6, part 4: sync health and conflict resolution (plan Section 5.14), in the dashboard API and
// through the shopify_sync tool's operations.

let h: ShopifyHarness;
beforeAll(async () => {
  h = await shopifyHarness();
});
afterAll(() => h.t.close());

interface Setup {
  m: Merchant;
  store: FakeStore;
  connectionId: string;
  variantId: string;
  item: ShopifyVariant;
}

async function setup(name: string, stock: number): Promise<Setup> {
  const m = await h.merchant(name);
  const sku = `${name.replace(/\W/g, '').slice(0, 6).toUpperCase()}-${uuidv7().slice(-6)}`;
  const made = await h.item(m, name, sku);
  if (stock > 0) await h.receive(m, made.variantId, stock);
  const store = h.newStore('health');
  const [item] = store.addProduct({ title: name, variants: [{ sku, quantities: { '1001': 0 } }] });
  const connectionId = await h.install(m, store);
  const base = `/shops/${m.shopId}/shopify/connections/${connectionId}`;
  await h.command(m.cookie, `${base}/locations`, {
    connectionId,
    locations: [{ shopifyLocationId: '1001', locationId: m.locationId }],
  });
  await h.command(m.cookie, `${base}/variants`, {
    connectionId,
    variants: [
      {
        shopifyVariantId: item!.variantId,
        shopifyInventoryItemId: item!.inventoryItemId,
        variantId: made.variantId,
      },
    ],
  });
  await h.flushTogether(m.shopId);
  expect(store.available(item!)).toBe(stock);
  return { m, store, connectionId, variantId: made.variantId, item: item! };
}

async function health(s: Setup) {
  const res = await h.dashboard(
    s.m.cookie,
    `/shops/${s.m.shopId}/shopify/sync-health?connectionId=${s.connectionId}`,
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json(res)).connections[0];
}

/** Someone sets Shopify's quantity by hand; the daily comparison finds it. */
async function conflictAt(s: Setup, shopify: number) {
  s.store.levels.set(s.store.key(s.item.inventoryItemId, '1001'), shopify);
  await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, { daily: true });
}

async function resolve(s: Setup, choice: string, cookie = s.m.cookie) {
  return h.command(
    cookie,
    `/shops/${s.m.shopId}/shopify/connections/${s.connectionId}/conflicts/resolve`,
    {
      connectionId: s.connectionId,
      inventoryItemId: s.item.inventoryItemId,
      shopifyLocationId: '1001',
      choice,
    },
  );
}

describe('Shopify sync health', () => {
  it('shows the last sync, conflicts, pending pushes, shortages, unmapped records, and maps', async () => {
    const s = await setup('Health mug', 3);
    // An unmapped Shopify variant (as the onboarding read records them) and location.
    await ownerQuery(
      `insert into shopify_catalog_variants (shop_id, connection_id, shopify_variant_id,
         shopify_product_id, sku, title) values ($1, $2, '777001', '777000', 'LONELY-1', 'Lonely')`,
      [s.m.shopId, s.connectionId],
    );
    // A Shopify order larger than the stock: a shortage.
    const order = s.store.placeOrder([{ variant: s.item, quantity: 5 }]);
    await h.deliver(s.store.domain, 'orders/create', s.store.webhookBody(order));
    await h.runJobs(s.m.shopId);
    await h.flushTogether(s.m.shopId);
    await conflictAt(s, 4);
    const view = await health(s);
    expect(view).toMatchObject({
      connectionId: s.connectionId,
      status: 'active',
      lastSyncAt: expect.any(String),
      lastError: null,
      pendingPushes: { count: 0 },
      conflicts: [
        {
          inventoryItemId: s.item.inventoryItemId,
          shopifyLocationId: '1001',
          shopifyLocationName: 'Shop location',
          sells: 'unit',
          expected: 0,
          airstock: 0,
          shopify: 4,
          alertId: expect.any(String),
        },
      ],
      shortages: [
        {
          externalRef: `shopify:order/${order.orderId}/line/${order.lines[0]!.lineId}`,
          quantity: '5',
          shortage: '2',
        },
      ],
      unmappedVariants: { count: 1, sample: [{ shopifyVariantId: '777001', sku: 'LONELY-1' }] },
      unmappedLocations: [{ id: '1002', name: 'Warehouse' }],
      mappings: {
        locations: [{ shopifyLocationId: '1001', scopeId: s.m.locationId }],
        variantCount: 1,
        variants: [{ shopifyVariantId: s.item.variantId, sells: 'unit', source: 'manual' }],
      },
    });
    // A member limited to another warehouse sees neither the conflict nor the shortages (A42).
    const other = await json(
      await h.command(s.m.cookie, `/shops/${s.m.shopId}/warehouses`, { name: 'Elsewhere' }),
    );
    const scoped = await addMember(s.m.shopId, 'manager', [other.warehouseId]);
    const seen = await execute(h.deps(), ops.shopifySyncHealth, {
      caller: scoped.caller,
      shopId: s.m.shopId,
      input: { connectionId: s.connectionId },
    });
    const limited = (seen.result as { connections: Array<Record<string, unknown>> }).connections[0];
    expect(limited).toMatchObject({ conflicts: [], shortages: [], pendingPushes: { count: 0 } });
    await expect(
      execute(h.deps(), ops.resolveShopifyConflict, {
        caller: scoped.caller,
        shopId: s.m.shopId,
        idempotencyKey: uuidv7(),
        input: {
          connectionId: s.connectionId,
          inventoryItemId: s.item.inventoryItemId,
          shopifyLocationId: '1001',
          choice: 'push_airstock',
        },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('push Airstock’s: Shopify gets Airstock’s availability, compared against its own number', async () => {
    const s = await setup('Push mug', 5);
    await conflictAt(s, 8);
    expect((await health(s)).conflicts).toHaveLength(1);
    const res = await resolve(s, 'push_airstock');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await json(res)).toMatchObject({ choice: 'push_airstock', airstock: 5, shopify: 8 });
    const sets = s.store.sets.length;
    await h.flushTogether(s.m.shopId);
    expect(s.store.sets.slice(sets)).toEqual([
      { item: s.item.inventoryItemId, location: '1001', from: 8, to: 5 },
    ]);
    const view = await health(s);
    expect(view.conflicts).toEqual([]);
    const [alert] = await ownerQuery<{ status: string; resolution: string }>(
      `select status, resolution from alerts where shop_id = $1 and kind = 'shopify_sync'`,
      [s.m.shopId],
    );
    expect(alert).toEqual({ status: 'resolved', resolution: 'pushed_airstock' });
    // Nothing left to resolve.
    expect((await resolve(s, 'push_airstock')).status).toBe(409);
  });

  it('take Shopify’s: Airstock adjusts its stock to Shopify’s number and pushes nothing', async () => {
    const s = await setup('Take mug', 5);
    await conflictAt(s, 3);
    const res = await resolve(s, 'take_shopify');
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ choice: 'take_shopify', airstock: 3, shopify: 3 });
    expect(body.adjustmentOperationIds).toHaveLength(1);
    expect(await h.available(s.m, s.variantId)).toBe('3.000000');
    const sets = s.store.sets.length;
    const outcomes = await h.flushTogether(s.m.shopId);
    expect(outcomes.map((o) => o.outcome)).toEqual(['unchanged']);
    expect(s.store.sets.length).toBe(sets);
    expect(s.store.available(s.item)).toBe(3);
    const [op] = await ownerQuery<{ kind: string; reason: string }>(
      `select kind, reason from inventory_operations where shop_id = $1 and id = $2`,
      [s.m.shopId, body.adjustmentOperationIds[0]],
    );
    expect(op).toEqual({ kind: 'adjustment', reason: 'count_correction' });
    // Shopify higher than Airstock: units are added at the receiving location.
    await conflictAt(s, 6);
    expect((await resolve(s, 'take_shopify')).status).toBe(200);
    expect(await h.available(s.m, s.variantId)).toBe('6.000000');
  });

  it('refuses a resolution from a member without connections.manage', async () => {
    const s = await setup('Viewer mug', 2);
    await conflictAt(s, 9);
    const viewer = await addMember(s.m.shopId, 'viewer');
    await expect(
      execute(h.deps(), ops.resolveShopifyConflict, {
        caller: viewer.caller,
        shopId: s.m.shopId,
        idempotencyKey: uuidv7(),
        input: {
          connectionId: s.connectionId,
          inventoryItemId: s.item.inventoryItemId,
          shopifyLocationId: '1001',
          choice: 'push_airstock',
        },
      }),
    ).rejects.toMatchObject({ status: 403 });
    // Reading is allowed.
    const seen = await execute(h.deps(), ops.shopifySyncHealth, {
      caller: viewer.caller,
      shopId: s.m.shopId,
      input: {},
    });
    expect(
      (seen.result as { connections: Array<{ conflicts: unknown[] }> }).connections[0]!.conflicts,
    ).toHaveLength(1);
  });
});

describe('shopify_sync over MCP (G15)', () => {
  it('lists connections, reads sync health, and resolves a conflict, with the same answers as REST', async () => {
    const s = await setup('MCP mug', 5);
    await conflictAt(s, 8);
    const mcp = await h.mcp(s.m, ['shop:read', 'inventory:read', 'inventory:write']);
    const connections = await mcp.call('shopify_sync', { action: 'connections' });
    expect(connections.error, JSON.stringify(connections.body)).toBe(false);
    expect(connections.body.connections).toEqual([
      expect.objectContaining({ connectionId: s.connectionId, status: 'active', conflicts: 1 }),
    ]);
    const restConnections = await h.dashboard(
      s.m.cookie,
      `/shops/${s.m.shopId}/shopify/connections`,
    );
    expect(await json(restConnections)).toEqual(connections.body);

    const seen = await mcp.call('shopify_sync', { action: 'health', connectionId: s.connectionId });
    expect(seen.body.connections).toEqual([await health(s)]);
    expect(seen.body.connections[0]).toMatchObject({
      status: 'active',
      lastError: null,
      conflicts: [{ inventoryItemId: s.item.inventoryItemId, airstock: 5, shopify: 8 }],
    });
    const everyStore = await mcp.call('shopify_sync', { action: 'health' });
    expect(everyStore.body).toEqual(seen.body);

    const resolved = await mcp.call('shopify_sync', {
      action: 'resolve_conflict',
      connectionId: s.connectionId,
      inventoryItemId: s.item.inventoryItemId,
      shopifyLocationId: '1001',
      choice: 'push_airstock',
    });
    expect(resolved.error, JSON.stringify(resolved.body)).toBe(false);
    expect(resolved.body).toMatchObject({ choice: 'push_airstock', airstock: 5, shopify: 8 });
    await h.flushTogether(s.m.shopId);
    expect(s.store.available(s.item)).toBe(5);
    const after = await mcp.call('shopify_sync', {
      action: 'health',
      connectionId: s.connectionId,
    });
    expect(after.body.connections[0].conflicts).toEqual([]);
    expect(after.body.connections).toEqual([await health(s)]);
    // Nothing left to resolve, over MCP as over REST.
    const again = await mcp.call('shopify_sync', {
      action: 'resolve_conflict',
      connectionId: s.connectionId,
      inventoryItemId: s.item.inventoryItemId,
      shopifyLocationId: '1001',
      choice: 'push_airstock',
    });
    expect(again.error).toBe(true);
    const restAgain = await resolve(s, 'push_airstock');
    expect(restAgain.status).toBe(409);
    expect(again.body).toEqual({ ...(await json(restAgain)), requestId: again.body.requestId });
    await mcp.close();
  });

  it('refuses grants without the scopes, another shop’s connection, and a conflict outside the member’s scope', async () => {
    const s = await setup('MCP refusal mug', 2);
    await conflictAt(s, 6);
    const conflict = {
      action: 'resolve_conflict',
      connectionId: s.connectionId,
      inventoryItemId: s.item.inventoryItemId,
      shopifyLocationId: '1001',
      choice: 'push_airstock',
    };
    const readOnly = await h.mcp(s.m, ['shop:read', 'inventory:read']);
    const refused = await readOnly.call('shopify_sync', conflict);
    expect(refused).toMatchObject({ error: true, body: { code: 'forbidden' } });
    expect(refused.body.detail).toContain('inventory:write');
    await readOnly.close();
    const shopOnly = await h.mcp(s.m, ['shop:read']);
    const noHealth = await shopOnly.call('shopify_sync', { action: 'health' });
    expect(noHealth.body.detail).toContain('inventory:read');
    await shopOnly.close();
    const stockOnly = await h.mcp(s.m, ['inventory:read']);
    const noConnections = await stockOnly.call('shopify_sync', { action: 'connections' });
    expect(noConnections.body.detail).toContain('shop:read');
    await stockOnly.close();

    // Another merchant's connection is not found from this shop.
    const theirs = await setup('MCP other mug', 1);
    const mcp = await h.mcp(s.m, ['shop:read', 'inventory:read', 'inventory:write']);
    const foreignHealth = await mcp.call('shopify_sync', {
      action: 'health',
      connectionId: theirs.connectionId,
    });
    expect(foreignHealth).toMatchObject({ error: true, body: { code: 'not_found' } });
    const foreignResolve = await mcp.call('shopify_sync', {
      ...conflict,
      connectionId: theirs.connectionId,
      inventoryItemId: theirs.item.inventoryItemId,
    });
    expect(foreignResolve.body.code).toBe('not_found');
    const listed = await mcp.call('shopify_sync', { action: 'connections' });
    expect(listed.body.connections.map((c: { connectionId: string }) => c.connectionId)).toEqual([
      s.connectionId,
    ]);
    await mcp.close();

    // A manager limited to another warehouse sees no conflict there and cannot resolve it (A42).
    const elsewhere = await json(
      await h.command(s.m.cookie, `/shops/${s.m.shopId}/warehouses`, { name: 'Elsewhere' }),
    );
    const scoped = await addMember(s.m.shopId, 'manager', [elsewhere.warehouseId]);
    const limited = await h.mcp(s.m, ['shop:read', 'inventory:read', 'inventory:write'], scoped);
    const limitedHealth = await limited.call('shopify_sync', {
      action: 'health',
      connectionId: s.connectionId,
    });
    expect(limitedHealth.body.connections[0]).toMatchObject({ conflicts: [], shortages: [] });
    const outside = await limited.call('shopify_sync', conflict);
    expect(outside).toMatchObject({ error: true, body: { status: 403 } });
    await limited.close();
    expect((await health(s)).conflicts).toHaveLength(1);
  });
});
