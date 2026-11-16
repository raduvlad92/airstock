import { createHash, randomBytes } from 'node:crypto';
import { formatApiToken, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, ownerQuery, type SeededShop } from '../../../test/helpers.ts';
import type { WorkosUser } from '../src/workos.ts';
import { mcpSession } from './mcp-client.ts';
import {
  apiToken,
  json,
  PUBLIC_URL,
  shopWithStock,
  signInAs,
  type TestApp,
  testApp,
} from './setup.ts';

// N6 through REST and MCP: warehouse records, hidden commercial terms (F14), location rules,
// location scopes, and cross-shop isolation for every new route (A13).

const STORAGE = ['shop:read', 'storage:read', 'storage:write', 'inventory:read', 'inventory:write'];
const CONTRACT = {
  startDate: '2026-03-01',
  feeDescription: 'Pallet storage and handling',
  rates: [{ description: 'Storage per pallet', amount: '9.75', unit: 'pallet per week' }],
};

let t: TestApp;
let shop: SeededShop;
let other: SeededShop;
let variantId: string;
let owner: string;
let viewer: string;

beforeAll(async () => {
  t = await testApp();
  ({ shop, variantId } = await shopWithStock(t, 'Storage REST shop'));
  ({ shop: other } = await shopWithStock(t, 'Other storage shop'));
  owner = (await apiToken(t, shop, STORAGE)).token;
  viewer = await memberToken(shop.shopId, (await addMember(shop.shopId, 'viewer')).membershipId);
});
afterAll(() => t.close());

/** An API credential for any member, inserted directly: viewers cannot create credentials. */
async function memberToken(shopId: string, membershipId: string, scopes = STORAGE) {
  const id = uuidv7();
  const secret = randomBytes(32).toString('base64url');
  await ownerQuery(
    `insert into api_credentials (shop_id, id, membership_id, name, secret_hash, scopes)
     values ($1, $2, $3, 'test', $4, $5)`,
    [shopId, id, membershipId, createHash('sha256').update(secret).digest('hex'), scopes],
  );
  return formatApiToken(id, secret);
}

function rest(token: string, path: string, body?: unknown, shopId = shop.shopId) {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    headers.set('idempotency-key', crypto.randomUUID());
  }
  return t.app.request(`/api/v1/shops/${shopId}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function mcpFor(membershipId: string, userId: string, scopes: string[]) {
  const mcp = await mcpSession(t, shop, scopes, { membershipId, userId });
  return {
    client: mcp.client,
    call: (args: Record<string, unknown>) => mcp.call('manage_storage', args),
  };
}

async function ownerMembership(s: SeededShop) {
  const [m] = await ownerQuery<{ id: string }>(
    'select id from memberships where shop_id = $1 and user_id = $2',
    [s.shopId, s.userId],
  );
  return m!.id;
}

describe('warehouses through REST (F14)', () => {
  let warehouseId: string;

  it('records a rented warehouse with its operator and contract', async () => {
    const res = await rest(owner, '/warehouses', {
      name: 'Rented REST hall',
      ownership: 'rented',
      operatorName: 'Hall Co',
      address: { city: 'Porto', country: 'PT' },
      contract: CONTRACT,
    });
    expect(res.status).toBe(201);
    const created = await json(res);
    warehouseId = created.warehouseId;
    expect(created.warehouse.contract).toMatchObject({ ...CONTRACT, currency: 'EUR' });
    const one = await json(await rest(owner, `/warehouses/${warehouseId}`));
    expect(one).toMatchObject({
      commercialVisible: true,
      warehouse: { operatorName: 'Hall Co', address: { city: 'Porto' }, contract: CONTRACT },
    });
  });

  it('hides fees and contracts from a viewer in lists, details, and history', async () => {
    const list = await json(await rest(viewer, '/warehouses'));
    expect(list.commercialVisible).toBe(false);
    const row = list.warehouses.find((w: { warehouseId: string }) => w.warehouseId === warehouseId);
    expect(row).toMatchObject({ ownership: 'rented', operatorName: 'Hall Co' });
    expect(row).not.toHaveProperty('contract');
    const one = await json(await rest(viewer, `/warehouses/${warehouseId}`));
    expect(one.warehouse).not.toHaveProperty('contract');
    const write = await rest(viewer, `/warehouses/${warehouseId}`, {
      expectedVersion: 1,
      name: 'Nope',
    });
    expect(write.status).toBe(403);

    await t.sink.drain(t.db);
    t.sink.events.length = 0;
    const activityToken = await memberToken(
      shop.shopId,
      (await addMember(shop.shopId, 'viewer')).membershipId,
      ['activity:read'],
    );
    const history = await json(
      await rest(activityToken, `/activity?targetType=warehouse&targetId=${warehouseId}`),
    );
    const created = history.events.find(
      (e: { action: string; phase: string }) =>
        e.action === 'storage.warehouse.created' && e.phase === 'outcome',
    );
    expect(created.changes.contract).toBe('hidden');
    expect(JSON.stringify(history)).not.toContain('"9.75');
  });

  it('updates with compare-and-set and refuses a stale version', async () => {
    const ok = await rest(owner, `/warehouses/${warehouseId}`, {
      expectedVersion: 1,
      operatingStatus: 'paused',
      contract: { ...CONTRACT, endDate: '2027-02-28' },
    });
    expect(ok.status).toBe(200);
    expect((await json(ok)).warehouse).toMatchObject({
      operatingStatus: 'paused',
      version: 2,
      contract: { endDate: '2027-02-28' },
    });
    const stale = await rest(owner, `/warehouses/${warehouseId}`, {
      expectedVersion: 1,
      name: 'Late',
    });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({ code: 'version_conflict', currentVersion: 2 });
  });

  it('refuses to archive a warehouse with stock, and archives and restores an empty one', async () => {
    const stocked = await rest(owner, `/warehouses/${shop.warehouseId}/archive`, {});
    expect(stocked.status).toBe(409);
    expect(await json(stocked)).toMatchObject({
      code: 'location_holds_stock',
      onHand: '10.000000',
    });
    const archived = await rest(owner, `/warehouses/${warehouseId}/archive`, {});
    expect(archived.status).toBe(200);
    expect((await json(archived)).status).toBe('archived');
    const listed = await json(await rest(owner, '/warehouses?includeArchived=true'));
    expect(
      listed.warehouses.find((w: { warehouseId: string }) => w.warehouseId === warehouseId).status,
    ).toBe('archived');
    const restored = await rest(owner, `/warehouses/${warehouseId}/restore`, {});
    expect((await json(restored)).status).toBe('active');
  });
});

describe('locations through REST', () => {
  it('renames, moves, archives, and restores, and archived locations accept no receipts', async () => {
    const wh = await json(await rest(owner, '/warehouses', { name: 'Tree' }));
    const a = await json(
      await rest(owner, '/locations', { warehouseId: wh.warehouseId, name: 'A' }),
    );
    const b = await json(
      await rest(owner, '/locations', { warehouseId: wh.warehouseId, name: 'B' }),
    );
    const renamed = await rest(owner, `/locations/${a.locationId}`, {
      expectedVersion: 1,
      code: 'A-01',
    });
    expect((await json(renamed)).location).toMatchObject({ path: 'Tree/A-01', version: 2 });
    const moved = await rest(owner, `/locations/${b.locationId}/move`, {
      expectedVersion: 1,
      parentId: a.locationId,
    });
    expect((await json(moved)).location.path).toBe('Tree/A-01/B');
    const cycle = await rest(owner, `/locations/${a.locationId}/move`, {
      expectedVersion: 2,
      parentId: b.locationId,
    });
    expect(cycle.status).toBe(422);
    expect((await json(cycle)).code).toBe('move_cycle');

    const archived = await rest(owner, `/locations/${a.locationId}/archive`, {});
    expect(await json(archived)).toMatchObject({ status: 'archived', locationsChanged: 1 });
    const receipt = await rest(owner, '/receipts', {
      variantId,
      locationId: b.locationId,
      quantity: '1',
    });
    expect(receipt.status).toBe(409);
    expect((await json(receipt)).code).toBe('location_archived');
    const restored = await rest(owner, `/locations/${a.locationId}/restore`, {});
    expect((await json(restored)).locationsChanged).toBe(1);
    const stockRefused = await rest(owner, `/locations/${shop.locationId}/archive`, {});
    expect(stockRefused.status).toBe(409);
  });
});

describe('manage_storage over MCP', () => {
  it('covers warehouses and locations, with contract terms only within permission', async () => {
    const { call, client } = await mcpFor(await ownerMembership(shop), shop.userId, STORAGE);
    const { tools } = await client.listTools();
    const tool = tools.find((x) => x.name === 'manage_storage')!;
    const schema = tool.inputSchema as {
      properties: Record<string, { enum?: string[]; default?: unknown }>;
    };
    expect(schema.properties.action!.enum).toEqual(
      expect.arrayContaining([
        'list_warehouses',
        'get_warehouse',
        'create_warehouse',
        'update_warehouse',
        'archive_warehouse',
        'restore_warehouse',
        'list_locations',
        'create_location',
        'update_location',
        'move_location',
        'archive_location',
        'restore_location',
      ]),
    );
    // A default would leak from create into update in a flat schema.
    for (const [name, prop] of Object.entries(schema.properties)) {
      expect(prop.default, name).toBeUndefined();
    }

    const created = await call({
      action: 'create_warehouse',
      name: 'MCP partner',
      ownership: 'third_party',
      operatorName: 'Partner BV',
      contract: CONTRACT,
    });
    expect(created.error).toBe(false);
    const id = created.body.warehouseId;
    const updated = await call({
      action: 'update_warehouse',
      warehouseId: id,
      expectedVersion: 1,
      fulfillmentEligible: false,
    });
    expect(updated.body.warehouse).toMatchObject({
      ownership: 'third_party',
      fulfillmentEligible: false,
      contract: { feeDescription: CONTRACT.feeDescription },
    });
    const loc = await call({ action: 'create_location', warehouseId: id, name: 'Dock' });
    const moved = await call({
      action: 'update_location',
      locationId: loc.body.locationId,
      expectedVersion: 1,
      code: 'D1',
    });
    expect(moved.body.location).toMatchObject({
      path: 'MCP partner/D1',
      fulfillmentEligible: true,
      effectiveFulfillmentEligible: false,
    });
    const list = await call({ action: 'list_locations', warehouseId: id });
    expect(list.body.locations).toHaveLength(1);
    await client.close();

    const member = await addMember(shop.shopId, 'viewer');
    const limited = await mcpFor(member.membershipId, member.userId, STORAGE);
    const seen = await limited.call({ action: 'get_warehouse', warehouseId: id });
    expect(seen.body.commercialVisible).toBe(false);
    expect(seen.body.warehouse).not.toHaveProperty('contract');
    expect(seen.body.warehouse.operatorName).toBe('Partner BV');
    const refused = await limited.call({ action: 'archive_warehouse', warehouseId: id });
    expect(refused.error).toBe(true);
    expect(refused.body.code).toBe('forbidden');
    await limited.client.close();
  });
});

describe('location scopes through the dashboard API', () => {
  const DASHBOARD = {
    origin: PUBLIC_URL,
    'x-airstock-request': '1',
    'content-type': 'application/json',
  };
  const user = (): WorkosUser => ({
    id: `user_${uuidv7().replace(/-/g, '')}`,
    email: `${uuidv7()}@example.com`,
    firstName: 'Ana',
    lastName: null,
  });

  it('sets a member’s scope in a session, lists it, and applies it on the next request', async () => {
    const session = await signInAs(t, user());
    const shopRes = await t.app.request('/api/v1/shops', {
      method: 'POST',
      headers: { cookie: session.cookie, ...DASHBOARD },
      body: JSON.stringify({ name: 'Scope shop', currency: 'EUR', timezone: 'Europe/Lisbon' }),
    });
    const created = await json(shopRes);
    const shopId = created.shopId as string;
    const api = (path: string, body?: unknown) =>
      t.app.request(`/api/v1/shops/${shopId}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie: session.cookie, ...DASHBOARD, 'idempotency-key': uuidv7() },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const second = await json(await api('/warehouses', { name: 'Second site' }));
    const member = await addMember(shopId, 'inventory_operator');
    const token = await memberToken(shopId, member.membershipId);

    const before = await json(
      await t.app.request(`/api/v1/shops/${shopId}/locations`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(before.partial).toBe(false);

    const set = await api(`/members/${member.membershipId}/location-scope`, {
      allLocations: false,
      scopeIds: [second.warehouseId],
    });
    expect(set.status).toBe(200);
    expect(await json(set)).toMatchObject({ locationScopeIds: [second.warehouseId] });
    const members = await json(await api('/members'));
    expect(
      members.members.find((m: { membershipId: string }) => m.membershipId === member.membershipId),
    ).toMatchObject({ allLocations: false, locationScopeIds: [second.warehouseId] });

    // The member's credential follows the new scope on its next request.
    const after = await t.app.request(`/api/v1/shops/${shopId}/receipts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': uuidv7(),
      },
      body: JSON.stringify({
        variantId: uuidv7(),
        locationId: created.defaultLocationId,
        quantity: '1',
      }),
    });
    expect(after.status).toBe(403);
    expect((await json(after)).code).toBe('location_out_of_scope');

    const ownerSelf = await api(`/members/${created.membershipId}/location-scope`, {
      allLocations: false,
      scopeIds: [second.warehouseId],
    });
    expect((await json(ownerSelf)).code).toBe('owner_all_locations');
    const viaToken = await t.app.request(
      `/api/v1/shops/${shopId}/members/${member.membershipId}/location-scope`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': uuidv7(),
        },
        body: JSON.stringify({ allLocations: true }),
      },
    );
    expect(viaToken.status).toBe(403);
  });
});

describe('cross-shop isolation for every new route (A13)', () => {
  it('answers not found for another shop’s warehouses, locations, and members', async () => {
    const theirMember = await ownerMembership(other);
    const routes: Array<[string, unknown?]> = [
      [`/warehouses/${other.warehouseId}`],
      [`/warehouses/${other.warehouseId}`, { expectedVersion: 1, name: 'Mine' }],
      [`/warehouses/${other.warehouseId}/archive`, {}],
      [`/warehouses/${other.warehouseId}/restore`, {}],
      [`/locations/${other.locationId}`, { expectedVersion: 1, name: 'Mine' }],
      [`/locations/${other.locationId}/move`, { expectedVersion: 1, parentId: null }],
      [`/locations/${other.locationId}/archive`, {}],
      [`/locations/${other.locationId}/restore`, {}],
      ['/locations', { warehouseId: other.warehouseId, name: 'Mine' }],
      [`/locations/${shop.locationId}/move`, { expectedVersion: 1, parentId: other.locationId }],
    ];
    for (const [path, body] of routes) {
      const res = await rest(owner, path, body);
      expect(res.status, path).toBe(404);
    }
    // The same routes under the other shop's path.
    for (const path of ['/warehouses', `/warehouses/${other.warehouseId}`, '/locations']) {
      expect((await rest(owner, path, undefined, other.shopId)).status, path).toBe(404);
    }
    expect(
      (await rest(owner, `/warehouses/${other.warehouseId}/archive`, {}, other.shopId)).status,
    ).toBe(404);
    const list = await json(await rest(owner, '/warehouses?includeArchived=true'));
    expect(list.warehouses.map((w: { warehouseId: string }) => w.warehouseId)).not.toContain(
      other.warehouseId,
    );
    // Session-only: another shop's member or scope IDs are not found either.
    const session = await signInAs(t, {
      id: `user_${uuidv7().replace(/-/g, '')}`,
      email: `${uuidv7()}@example.com`,
      firstName: null,
      lastName: null,
    });
    const mine = await json(
      await t.app.request('/api/v1/shops', {
        method: 'POST',
        headers: {
          cookie: session.cookie,
          origin: PUBLIC_URL,
          'x-airstock-request': '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Iso shop', currency: 'EUR', timezone: 'Europe/Paris' }),
      }),
    );
    const member = await addMember(mine.shopId, 'viewer');
    const scope = (membershipId: string, scopeIds: string[]) =>
      t.app.request(`/api/v1/shops/${mine.shopId}/members/${membershipId}/location-scope`, {
        method: 'POST',
        headers: {
          cookie: session.cookie,
          origin: PUBLIC_URL,
          'x-airstock-request': '1',
          'content-type': 'application/json',
          'idempotency-key': uuidv7(),
        },
        body: JSON.stringify({ allLocations: false, scopeIds }),
      });
    expect((await scope(theirMember, [mine.defaultWarehouseId])).status).toBe(404);
    expect((await scope(member.membershipId, [other.warehouseId])).status).toBe(404);
    expect((await scope(member.membershipId, [other.locationId])).status).toBe(404);
  });
});
