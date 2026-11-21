import { execute, ops, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, type SeededShop, seedShop } from '../../../test/helpers.ts';
import { mcpSession, restClient } from './mcp-client.ts';
import { apiToken, type GrantMember, type Json, type TestApp, testApp } from './setup.ts';

// warehouse_work end to end through an MCP client: pick lists (create, get, list, pick, short
// pick, complete, cancel) and the scan lookup, with the same answers as REST. A grant without
// inventory:write cannot pick, another shop's lists and codes are not found, and a member limited
// to one warehouse neither sees nor picks lines elsewhere.

const READ = ['inventory:read'];
const WRITE = ['inventory:read', 'inventory:write'];

let t: TestApp;
let shop: SeededShop;
let other: SeededShop;
let storeWarehouse: string;
let storeShelf: string;
let scoped: GrantMember;
let rest: ReturnType<typeof restClient>;

async function run(op: (typeof ops)[keyof typeof ops], input: unknown, s = shop): Promise<Json> {
  const res = await execute({ db: t.db, audit: t.sink }, op as never, {
    caller: s.caller,
    shopId: s.shopId,
    input,
    idempotencyKey: uuidv7(),
  });
  return res.result as Json;
}

/** A variant with stock at a shelf, and a reservation of `reserve` units for an order. */
async function ordered(s: SeededShop, locationId: string, reserve: number) {
  const sku = `PICK-${uuidv7().slice(-8)}`;
  const { variantId } = await run(ops.createItem, { name: `Pick ${sku}`, sku }, s);
  await run(ops.receiveStock, { variantId, locationId, quantity: '5' }, s);
  const order = `order-${sku}`;
  const reserved = await run(
    ops.reserveStock,
    { variantId, quantity: String(reserve), locationId, externalRef: order },
    s,
  );
  return { variantId: variantId as string, sku, order, reservationId: reserved.reservationId };
}

beforeAll(async () => {
  t = await testApp();
  shop = await seedShop(t.db, t.sink, 'Picking MCP shop');
  other = await seedShop(t.db, t.sink, 'Other picking shop');
  storeWarehouse = (await run(ops.createWarehouse, { name: 'Store' })).warehouseId;
  storeShelf = (await run(ops.createLocation, { warehouseId: storeWarehouse, name: 'Front' }))
    .locationId;
  scoped = await addMember(shop.shopId, 'manager', [storeWarehouse]);
  rest = restClient(t, shop.shopId, (await apiToken(t, shop, WRITE)).token);
});
afterAll(() => t.close());

describe('warehouse_work over MCP', () => {
  it('builds, picks, shorts, completes, and cancels pick lists, with the same answers as REST', async () => {
    const mcp = await mcpSession(t, shop, WRITE);
    const a = await ordered(shop, shop.locationId, 2);
    const b = await ordered(shop, shop.locationId, 3);
    const created = await mcp.call('warehouse_work', {
      action: 'create_pick_list',
      warehouseId: shop.warehouseId,
      orders: [a.order, b.order],
    });
    expect(created.error, JSON.stringify(created.body)).toBe(false);
    expect(created.body).toMatchObject({ status: 'open', lines: 2, orders: 2, partial: false });
    const pickListId = created.body.pickListId as string;
    const line = (v: { variantId: string }) =>
      created.body.pickLines.find((l: Json) => l.variantId === v.variantId).lineId as string;

    const got = await mcp.call('warehouse_work', { action: 'get_pick_list', pickListId });
    expect(got.body).toEqual((await rest.get(`/pick-lists/${pickListId}`)).body);
    const listed = await mcp.call('warehouse_work', { action: 'list_pick_lists' });
    expect(listed.body).toEqual((await rest.get('/pick-lists')).body);
    expect(listed.body.pickLists.map((l: Json) => l.pickListId)).toContain(pickListId);

    const picked = await mcp.call('warehouse_work', {
      action: 'record_pick',
      pickListId,
      lineId: line(a),
    });
    expect(picked.body).toMatchObject({ line: { picked: '2', status: 'picked' }, openLines: 1 });
    const shorted = await mcp.call('warehouse_work', {
      action: 'short_pick',
      pickListId,
      lineId: line(b),
      found: '1',
      reason: 'Only one on the shelf',
    });
    expect(shorted.error, JSON.stringify(shorted.body)).toBe(false);
    expect(shorted.body.line).toMatchObject({ picked: '1', short: '2' });
    // Picks never change stock; completing the list fulfills what was picked.
    const stock = await mcp.call('get_stock', { action: 'stock', variantId: a.variantId });
    expect(stock.body.totals).toMatchObject({ onHand: '5.000000', reserved: '2.000000' });
    const completed = await mcp.call('warehouse_work', {
      action: 'complete_pick_list',
      pickListId,
    });
    expect(completed.body.status).toBe('completed');
    expect(completed.body.fulfilled.map((f: Json) => f.externalRef)).toContain(a.order);
    const after = await mcp.call('get_stock', { action: 'stock', variantId: a.variantId });
    expect(after.body.totals).toMatchObject({ onHand: '3.000000', reserved: '0.000000' });
    expect((await rest.get(`/pick-lists/${pickListId}`)).body.status).toBe('completed');

    const c = await ordered(shop, shop.locationId, 1);
    const second = await mcp.call('warehouse_work', {
      action: 'create_pick_list',
      orders: [c.order],
    });
    const cancelled = await mcp.call('warehouse_work', {
      action: 'cancel_pick_list',
      pickListId: second.body.pickListId,
    });
    expect(cancelled.body).toEqual({
      pickListId: second.body.pickListId,
      status: 'cancelled',
      lines: 1,
    });
    await mcp.close();
  });

  it('identifies a scanned SKU and location label like REST, and an unknown code', async () => {
    const mcp = await mcpSession(t, shop, READ);
    const a = await ordered(shop, shop.locationId, 1);
    const item = await mcp.call('warehouse_work', { action: 'scan', code: a.sku });
    expect(item.body).toMatchObject({ kind: 'item', item: { variantId: a.variantId } });
    expect(item.body.stock.totals).toMatchObject({ onHand: '5.000000', available: '4.000000' });
    expect(item.body).toEqual((await rest.get('/scan', { code: a.sku })).body);
    const label = await mcp.call('warehouse_work', { action: 'scan', code: `LOC:${storeShelf}` });
    expect(label.body).toMatchObject({ kind: 'location', location: { locationId: storeShelf } });
    expect(label.body).toEqual((await rest.get('/scan', { code: `LOC:${storeShelf}` })).body);
    const unknown = await mcp.call('warehouse_work', { action: 'scan', code: 'NO-SUCH-CODE' });
    expect(unknown.body).toMatchObject({ kind: 'unknown', item: null, location: null });
    await mcp.close();
  });

  it('refuses a grant without the scope, another shop’s lists and codes, and lines outside the member’s scope', async () => {
    const readOnly = await mcpSession(t, shop, READ);
    const refused = await readOnly.call('warehouse_work', { action: 'create_pick_list' });
    expect(refused).toMatchObject({ error: true, body: { code: 'forbidden' } });
    expect(refused.body.detail).toContain('inventory:write');
    expect((await readOnly.call('warehouse_work', { action: 'list_pick_lists' })).error).toBe(
      false,
    );
    await readOnly.close();

    const theirs = await ordered(other, other.locationId, 1);
    const theirList = await run(ops.createPickList, { orders: [theirs.order] }, other);
    const mcp = await mcpSession(t, shop, WRITE);
    for (const args of [
      { action: 'get_pick_list', pickListId: theirList.pickListId },
      {
        action: 'record_pick',
        pickListId: theirList.pickListId,
        lineId: theirList.pickLines[0].lineId,
      },
      { action: 'cancel_pick_list', pickListId: theirList.pickListId },
    ]) {
      const foreign = await mcp.call('warehouse_work', args);
      expect(foreign.body.code, args.action).toBe('not_found');
    }
    // Their reservation is not picked into this shop's list; their SKU is unknown here, and their
    // location's label names a location this shop does not have.
    const none = await mcp.call('warehouse_work', {
      action: 'create_pick_list',
      orders: [theirs.order],
    });
    expect(none.body.code).toBe('nothing_to_pick');
    const sku = await mcp.call('warehouse_work', { action: 'scan', code: theirs.sku });
    expect(sku.body).toMatchObject({ kind: 'unknown', item: null });
    const theirLabel = await mcp.call('warehouse_work', {
      action: 'scan',
      code: `LOC:${other.locationId}`,
    });
    expect(theirLabel).toMatchObject({ error: true, body: { code: 'not_found' } });

    // The member limited to the store: the warehouse's line is hidden and cannot be picked.
    const atWarehouse = await ordered(shop, shop.locationId, 1);
    const atStore = await ordered(shop, storeShelf, 1);
    const both = await mcp.call('warehouse_work', {
      action: 'create_pick_list',
      orders: [atWarehouse.order, atStore.order],
    });
    expect(both.body.lines).toBe(2);
    await mcp.close();
    const limited = await mcpSession(t, shop, WRITE, scoped);
    const seen = await limited.call('warehouse_work', {
      action: 'get_pick_list',
      pickListId: both.body.pickListId,
    });
    expect(seen.body.partial).toBe(true);
    expect(seen.body.pickLines.map((l: Json) => l.variantId)).toEqual([atStore.variantId]);
    const hidden = both.body.pickLines.find((l: Json) => l.variantId === atWarehouse.variantId);
    const outside = await limited.call('warehouse_work', {
      action: 'record_pick',
      pickListId: both.body.pickListId,
      lineId: hidden.lineId,
    });
    expect(outside.body.code).toBe('location_out_of_scope');
    const inside = await limited.call('warehouse_work', {
      action: 'record_pick',
      pickListId: both.body.pickListId,
      lineId: seen.body.pickLines[0].lineId,
    });
    expect(inside.error, JSON.stringify(inside.body)).toBe(false);
    const label = await limited.call('warehouse_work', {
      action: 'scan',
      code: `LOC:${shop.locationId}`,
    });
    expect(label.body.code).toBe('location_out_of_scope');
    const item = await limited.call('warehouse_work', { action: 'scan', code: atWarehouse.sku });
    expect(item.body.stock).toMatchObject({ partial: true, positions: [] });
    await limited.close();
  });
});
