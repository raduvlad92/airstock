import { execute, ops, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, type SeededShop } from '../../../test/helpers.ts';
import { anonymized, mcpSession, restClient, type ToolResult } from './mcp-client.ts';
import {
  apiToken,
  type GrantMember,
  type Json,
  shopWithStock,
  type TestApp,
  testApp,
} from './setup.ts';

// Stock over MCP: get_stock and manage_reservations, and the stock-moving tools receive_stock,
// adjust_stock, transfer_stock, and manage_returns end to end through an MCP client. Each tool's
// answers match the REST routes', a grant without inventory:write (or catalog:write) is refused,
// another shop's IDs are not found, and a member limited to one warehouse writes only there.

const READ = ['inventory:read'];
const WRITE = ['inventory:read', 'inventory:write'];

let t: TestApp;
let shop: SeededShop;
let variantId: string;
let other: SeededShop;
let otherVariant: string;
/** A second shelf in the shop's default warehouse, for moves. */
let shelf: string;
/** A second warehouse, with one shelf, for transfers and the scoped member. */
let storeWarehouse: string;
let storeShelf: string;
/** A manager limited to the store warehouse. */
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

/** A new variant with `quantity` units at a shelf (none when 0). */
async function stocked(quantity: number, locationId = shop.locationId) {
  const sku = `INV-${uuidv7().slice(-8)}`;
  const { variantId } = await run(ops.createItem, { name: `Mug ${sku}`, sku });
  if (quantity > 0) {
    await run(ops.receiveStock, {
      variantId,
      locationId,
      quantity: String(quantity),
      unitCost: '2',
    });
  }
  return { variantId: variantId as string, sku };
}

/**
 * A command on a closed record, over MCP and REST: a 409 problem whose `status` stays the HTTP
 * status (RFC 9457), with the record's own status in `currentStatus`.
 */
async function expectClosed(
  viaMcp: ToolResult,
  viaRest: { status: number; body: Json },
  expected: { code: string; currentStatus: string },
) {
  expect(viaMcp).toMatchObject({ error: true, body: { status: 409, ...expected } });
  expect(viaRest).toEqual({
    status: 409,
    body: { ...viaMcp.body, requestId: expect.any(String) },
  });
}

beforeAll(async () => {
  t = await testApp();
  ({ shop, variantId } = await shopWithStock(t, 'Inventory MCP shop'));
  ({ shop: other, variantId: otherVariant } = await shopWithStock(t, 'Other inventory shop'));
  shelf = (await run(ops.createLocation, { warehouseId: shop.warehouseId, name: 'B2' })).locationId;
  storeWarehouse = (await run(ops.createWarehouse, { name: 'Store' })).warehouseId;
  storeShelf = (await run(ops.createLocation, { warehouseId: storeWarehouse, name: 'Front' }))
    .locationId;
  scoped = await addMember(shop.shopId, 'manager', [storeWarehouse]);
  const { token } = await apiToken(t, shop, [...WRITE, 'catalog:read', 'catalog:write']);
  rest = restClient(t, shop.shopId, token);
});
afterAll(() => t.close());

describe('stock over MCP', () => {
  it('answers with the same scoped result as REST, logged as the connection (A14)', async () => {
    const mcp = await mcpSession(t, shop, ['shop:read', 'inventory:read', 'catalog:read']);
    const context = await mcp.call('get_shop_context');
    expect(context.body.shop.id).toBe(shop.shopId);
    const stock = await mcp.call('get_stock', { action: 'stock', variantId });
    expect(stock.body.totals.available).toBe('10.000000');
    expect(t.sink.events.at(-1)!).toMatchObject({
      source: 'mcp',
      actor_type: 'connection',
      grant_id: mcp.grantId,
      client_id: 'chatgpt-test',
    });
    await mcp.close();
  });

  it('reserves within a write grant, idempotently when the client retries with a key', async () => {
    const mcp = await mcpSession(t, shop, WRITE);
    const args = { action: 'reserve', variantId, quantity: '2', idempotency_key: 'chat-turn-7' };
    const first = await mcp.call('manage_reservations', args);
    const again = await mcp.call('manage_reservations', args);
    expect(first.error).toBe(false);
    expect(again.body).toEqual({ ...first.body, replayed: true });
    await mcp.close();
  });

  it('fulfills, lists, and reads stock and lots through the Phase 2 tools', async () => {
    const mcp = await mcpSession(t, shop, WRITE);
    const reserved = await mcp.call('manage_reservations', {
      action: 'reserve',
      variantId,
      quantity: '1',
      externalRef: 'mcp-order-1',
      idempotency_key: 'mcp-reserve-2',
    });
    expect(reserved.error).toBe(false);
    const shipped = await mcp.call('manage_reservations', {
      action: 'fulfill',
      reservationId: reserved.body.reservationId,
      idempotency_key: 'mcp-fulfill-1',
    });
    expect(shipped.body).toMatchObject({ fulfilled: '1', status: 'fulfilled' });
    const listed = await mcp.call('manage_reservations', {
      action: 'list',
      externalRef: 'mcp-order-1',
      status: 'all',
    });
    expect(listed.body.reservations).toHaveLength(1);
    const lots = await mcp.call('get_stock', { action: 'lots', variantId });
    expect(lots.body.lots).toEqual([]);
    const stock = await mcp.call('get_stock', { action: 'stock', variantId });
    expect(stock.body).toMatchObject({ costVisible: true, totals: { shortage: '0.000000' } });
    await mcp.close();
  });
});

describe('receive_stock over MCP', () => {
  it('receives and quick-adds with the same answers as REST', async () => {
    const mcp = await mcpSession(t, shop, [...WRITE, 'catalog:write']);
    const [a, b] = [await stocked(0), await stocked(0)];
    const receipt = { locationId: shop.locationId, quantity: '4', unitCost: '2.5' };
    const viaMcp = await mcp.call('receive_stock', {
      action: 'receive',
      variantId: a.variantId,
      ...receipt,
    });
    expect(viaMcp.error, JSON.stringify(viaMcp.body)).toBe(false);
    expect(viaMcp.body).toMatchObject({ unitCost: '2.500000', averageCost: '2.500000' });
    const viaRest = await rest.post('/receipts', { variantId: b.variantId, ...receipt });
    expect(viaRest.status).toBe(201);
    expect(anonymized(viaMcp.body, [a.sku])).toEqual(anonymized(viaRest.body, [b.sku]));

    const added = await mcp.call('receive_stock', {
      action: 'quick_add',
      locationId: shop.locationId,
      name: 'Found lamp',
      sku: `QA-${uuidv7().slice(-8)}`,
      acknowledgeSimilar: true,
    });
    expect(added.body).toMatchObject({ created: true });
    const stock = await mcp.call('get_stock', { action: 'stock', variantId: added.body.variantId });
    expect(stock.body.totals.onHand).toBe('1.000000');
    const viaRestAdd = await rest.post('/quick-add', {
      locationId: shop.locationId,
      name: 'Found lamp',
      sku: `QA-${uuidv7().slice(-8)}`,
      acknowledgeSimilar: true,
    });
    expect(viaRestAdd.status).toBe(201);
    expect(anonymized(added.body, [added.body.sku])).toEqual(
      anonymized(viaRestAdd.body, [viaRestAdd.body.sku]),
    );
    await mcp.close();
  });

  it('refuses a grant without the scope, another shop’s IDs, and a shelf outside the member’s scope', async () => {
    const readOnly = await mcpSession(t, shop, READ);
    const refused = await readOnly.call('receive_stock', {
      action: 'receive',
      variantId,
      locationId: shop.locationId,
      quantity: '1',
    });
    expect(refused).toMatchObject({ error: true, body: { code: 'forbidden' } });
    expect(refused.body.detail).toContain('inventory:write');
    await readOnly.close();
    const noCatalog = await mcpSession(t, shop, WRITE);
    const quick = await noCatalog.call('receive_stock', {
      action: 'quick_add',
      locationId: shop.locationId,
      name: 'Not allowed',
    });
    expect(quick.body.detail).toContain('catalog:write');

    for (const ids of [
      { variantId: otherVariant, locationId: shop.locationId },
      { variantId, locationId: other.locationId },
    ]) {
      const foreign = await noCatalog.call('receive_stock', {
        action: 'receive',
        ...ids,
        quantity: '1',
      });
      expect(foreign).toMatchObject({ error: true, body: { code: 'not_found' } });
    }
    await noCatalog.close();

    const limited = await mcpSession(t, shop, WRITE, scoped);
    const outside = await limited.call('receive_stock', {
      action: 'receive',
      variantId,
      locationId: shop.locationId,
      quantity: '1',
    });
    expect(outside.body.code).toBe('location_out_of_scope');
    const inside = await limited.call('receive_stock', {
      action: 'receive',
      variantId,
      locationId: storeShelf,
      quantity: '1',
    });
    expect(inside.error, JSON.stringify(inside.body)).toBe(false);
    await limited.close();
  });
});

describe('adjust_stock over MCP', () => {
  it('adjusts, reverses, changes condition, and counts, with the same answers as REST', async () => {
    const mcp = await mcpSession(t, shop, WRITE);
    const [a, b] = [await stocked(5), await stocked(5)];
    const adjustment = (v: string) => ({
      locationId: shop.locationId,
      adjustmentReason: 'damage',
      adjustments: [{ variantId: v, direction: 'remove', quantity: '2' }],
    });
    const adjusted = await mcp.call('adjust_stock', {
      action: 'adjust',
      ...adjustment(a.variantId),
    });
    expect(adjusted.body.changes).toEqual([expect.objectContaining({ delta: '-2' })]);
    const viaRest = await rest.post('/adjustments', adjustment(b.variantId));
    expect(viaRest.status).toBe(201);
    expect(anonymized(adjusted.body)).toEqual(anonymized(viaRest.body));

    const reversed = await mcp.call('adjust_stock', {
      action: 'reverse',
      operationId: adjusted.body.operationId,
    });
    expect(reversed.body).toMatchObject({ reverses: adjusted.body.operationId });
    const condition = await mcp.call('adjust_stock', {
      action: 'change_condition',
      locationId: shop.locationId,
      fromCondition: 'sellable',
      toCondition: 'damaged',
      items: [{ variantId: a.variantId, quantity: '1' }],
    });
    expect(condition.body.moved).toEqual([expect.objectContaining({ quantity: '1' })]);
    const stock = await mcp.call('get_stock', { action: 'stock', variantId: a.variantId });
    expect(stock.body.totals).toMatchObject({ onHand: '5.000000', available: '4.000000' });

    // A quick count, and a count session from start to submit.
    const counted = await mcp.call('adjust_stock', {
      action: 'count',
      locationId: shop.locationId,
      counts: [{ variantId: b.variantId, counted: '4' }],
    });
    expect(counted.body.changes).toEqual([expect.objectContaining({ delta: '1' })]);
    const started = await mcp.call('adjust_stock', {
      action: 'start_count',
      locationId: shop.locationId,
      variantIds: [a.variantId],
      name: 'Shelf A',
    });
    const sessionId = started.body.sessionId as string;
    const recorded = await mcp.call('adjust_stock', {
      action: 'record_count',
      sessionId,
      counts: [{ variantId: a.variantId, counted: '3' }],
    });
    expect(recorded.body.totals).toMatchObject({ counted: 1 });
    const got = await mcp.call('adjust_stock', { action: 'get_count', sessionId });
    expect(got.body).toEqual((await rest.get(`/counts/${sessionId}`)).body);
    const listed = await mcp.call('adjust_stock', { action: 'list_counts' });
    expect(listed.body).toEqual((await rest.get('/counts')).body);
    expect(listed.body.counts.map((c: Json) => c.sessionId)).toContain(sessionId);
    const submitted = await mcp.call('adjust_stock', { action: 'submit_count', sessionId });
    expect(submitted.body.session.status).toBe('submitted');
    await expectClosed(
      await mcp.call('adjust_stock', { action: 'submit_count', sessionId }),
      await rest.post(`/counts/${sessionId}/submit`),
      { code: 'count_closed', currentStatus: 'submitted' },
    );
    expect(submitted.body.changes).toEqual([expect.objectContaining({ delta: '-1' })]);
    const second = await mcp.call('adjust_stock', {
      action: 'start_count',
      locationId: shop.locationId,
      variantIds: [b.variantId],
    });
    const cancelled = await mcp.call('adjust_stock', {
      action: 'cancel_count',
      sessionId: second.body.sessionId,
    });
    expect(cancelled.body.status).toBe('cancelled');
    await mcp.close();
  });

  it('refuses a grant without the scope, another shop’s IDs, and a shelf outside the member’s scope', async () => {
    const readOnly = await mcpSession(t, shop, READ);
    const refused = await readOnly.call('adjust_stock', {
      action: 'adjust',
      locationId: shop.locationId,
      adjustmentReason: 'found',
      adjustments: [{ variantId, direction: 'add', quantity: '1' }],
    });
    expect(refused).toMatchObject({ error: true, body: { code: 'forbidden' } });
    expect((await readOnly.call('adjust_stock', { action: 'list_counts' })).error).toBe(false);
    await readOnly.close();

    const mcp = await mcpSession(t, shop, WRITE);
    const foreignShelf = await mcp.call('adjust_stock', {
      action: 'count',
      locationId: other.locationId,
      counts: [{ variantId, counted: '1' }],
    });
    expect(foreignShelf.body.code).toBe('not_found');
    const foreignVariant = await mcp.call('adjust_stock', {
      action: 'adjust',
      locationId: shop.locationId,
      adjustmentReason: 'found',
      adjustments: [{ variantId: otherVariant, direction: 'add', quantity: '1' }],
    });
    expect(foreignVariant.body.code).toBe('not_found');
    const theirs = await run(
      ops.startCount,
      { locationId: other.locationId, variantIds: [otherVariant] },
      other,
    );
    const foreignSession = await mcp.call('adjust_stock', {
      action: 'get_count',
      sessionId: theirs.sessionId,
    });
    expect(foreignSession.body.code).toBe('not_found');
    await mcp.close();

    const limited = await mcpSession(t, shop, WRITE, scoped);
    for (const args of [
      {
        action: 'adjust',
        locationId: shop.locationId,
        adjustmentReason: 'found',
        adjustments: [{ variantId, direction: 'add', quantity: '1' }],
      },
      { action: 'count', locationId: shop.locationId, counts: [{ variantId, counted: '1' }] },
      { action: 'start_count', locationId: shop.locationId },
    ]) {
      const outside = await limited.call('adjust_stock', args);
      expect(outside.body.code, args.action).toBe('location_out_of_scope');
    }
    // A count at the warehouse is not shown to the member limited to the store.
    const hidden = await run(ops.startCount, {
      locationId: shop.locationId,
      variantIds: [variantId],
    });
    const unseen = await limited.call('adjust_stock', {
      action: 'get_count',
      sessionId: hidden.sessionId,
    });
    expect(unseen.body.code).toBe('not_found');
    const counts = await limited.call('adjust_stock', { action: 'list_counts', status: 'all' });
    expect(counts.body.counts.map((c: Json) => c.sessionId)).not.toContain(hidden.sessionId);
    const inside = await limited.call('adjust_stock', {
      action: 'adjust',
      locationId: storeShelf,
      adjustmentReason: 'found',
      adjustments: [{ variantId, direction: 'add', quantity: '1' }],
    });
    expect(inside.error, JSON.stringify(inside.body)).toBe(false);
    await limited.close();
  });
});

describe('transfer_stock over MCP', () => {
  it('moves, transfers, resolves, and cancels, with the same answers as REST', async () => {
    const mcp = await mcpSession(t, shop, WRITE);
    const [a, b] = [await stocked(6), await stocked(6)];
    const move = (v: string) => ({
      fromLocationId: shop.locationId,
      toLocationId: shelf,
      lines: [{ variantId: v, quantity: '2' }],
    });
    const moved = await mcp.call('transfer_stock', { action: 'move', ...move(a.variantId) });
    expect(moved.body.transfer).toMatchObject({ kind: 'move', status: 'received' });
    const viaRest = await rest.post('/moves', move(b.variantId));
    expect(viaRest.status).toBe(201);
    expect(anonymized(moved.body, [a.sku])).toEqual(anonymized(viaRest.body, [b.sku]));

    const created = await mcp.call('transfer_stock', {
      action: 'create',
      fromLocationId: shop.locationId,
      toLocationId: storeShelf,
      lines: [{ variantId: a.variantId, quantity: '3' }],
      reference: 'TR-1',
    });
    expect(created.body.transfer.status).toBe('draft');
    const transferId = created.body.transfer.transferId as string;
    const ready = await mcp.call('transfer_stock', { action: 'ready', transferId });
    expect(ready.body.transfer.status).toBe('ready');
    const dispatched = await mcp.call('transfer_stock', { action: 'dispatch', transferId });
    expect(dispatched.body.transfer.totals.inTransit).toBe('3.000000');
    const received = await mcp.call('transfer_stock', {
      action: 'receive',
      transferId,
      items: [{ variantId: a.variantId, quantity: '2' }],
    });
    expect(received.body.transfer.status).toBe('partially_received');
    const flagged = await mcp.call('transfer_stock', {
      action: 'report_exception',
      transferId,
      note: 'One mug never arrived.',
    });
    expect(flagged.body.transfer.exception.open).toBe(true);
    const resolved = await mcp.call('transfer_stock', {
      action: 'resolve',
      transferId,
      resolution: 'lost',
    });
    expect(resolved.body.transfer.totals).toMatchObject({
      resolved: '1.000000',
      inTransit: '0.000000',
    });
    const got = await mcp.call('transfer_stock', { action: 'get', transferId });
    expect(got.body).toEqual((await rest.get(`/transfers/${transferId}`)).body);
    const listed = await mcp.call('transfer_stock', { action: 'list', status: 'all' });
    expect(listed.body).toEqual((await rest.get('/transfers', { status: 'all' })).body);
    expect(listed.body.transfers.map((x: Json) => x.transferId)).toContain(transferId);

    const draft = await mcp.call('transfer_stock', {
      action: 'create',
      fromLocationId: shop.locationId,
      toLocationId: storeShelf,
      lines: [{ variantId: b.variantId, quantity: '1' }],
      ready: true,
    });
    const cancelled = await mcp.call('transfer_stock', {
      action: 'cancel',
      transferId: draft.body.transfer.transferId,
    });
    expect(cancelled.body.transfer.status).toBe('cancelled');
    const cancelledId = draft.body.transfer.transferId as string;
    await expectClosed(
      await mcp.call('transfer_stock', { action: 'dispatch', transferId: cancelledId }),
      await rest.post(`/transfers/${cancelledId}/dispatch`),
      { code: 'transfer_closed', currentStatus: 'cancelled' },
    );
    const stock = await mcp.call('get_stock', { action: 'stock', variantId: b.variantId });
    expect(stock.body.totals).toMatchObject({ onHand: '6.000000', available: '6.000000' });
    await mcp.close();
  });

  it('refuses a grant without the scope, another shop’s IDs, and locations outside the member’s scope', async () => {
    const readOnly = await mcpSession(t, shop, READ);
    const refused = await readOnly.call('transfer_stock', {
      action: 'move',
      fromLocationId: shop.locationId,
      toLocationId: shelf,
      lines: [{ variantId, quantity: '1' }],
    });
    expect(refused).toMatchObject({ error: true, body: { code: 'forbidden' } });
    expect((await readOnly.call('transfer_stock', { action: 'list' })).error).toBe(false);
    await readOnly.close();

    const mcp = await mcpSession(t, shop, WRITE);
    const foreign = await mcp.call('transfer_stock', {
      action: 'create',
      fromLocationId: other.locationId,
      toLocationId: storeShelf,
      lines: [{ variantId, quantity: '1' }],
      ready: true,
    });
    expect(foreign.body.code).toBe('not_found');
    const theirShelf = await run(
      ops.createLocation,
      { warehouseId: other.warehouseId, name: 'Their B2' },
      other,
    );
    const theirs = await run(
      ops.createTransfer,
      {
        fromLocationId: other.locationId,
        toLocationId: theirShelf.locationId,
        lines: [{ variantId: otherVariant, quantity: '1' }],
      },
      other,
    );
    for (const action of ['get', 'ready', 'cancel']) {
      const got = await mcp.call('transfer_stock', {
        action,
        transferId: theirs.transfer.transferId,
      });
      expect(got.body.code, action).toBe('not_found');
    }
    const mine = await mcp.call('transfer_stock', {
      action: 'create',
      fromLocationId: shop.locationId,
      toLocationId: storeShelf,
      lines: [{ variantId, quantity: '1' }],
      ready: true,
    });
    await mcp.close();

    // The member limited to the store may receive there, but not take stock from elsewhere.
    const limited = await mcpSession(t, shop, WRITE, scoped);
    const move = await limited.call('transfer_stock', {
      action: 'move',
      fromLocationId: shop.locationId,
      toLocationId: shelf,
      lines: [{ variantId, quantity: '1' }],
    });
    expect(move.body.code).toBe('location_out_of_scope');
    const dispatch = await limited.call('transfer_stock', {
      action: 'dispatch',
      transferId: mine.body.transfer.transferId,
    });
    expect(dispatch.body.code).toBe('location_out_of_scope');
    await run(ops.dispatchTransfer, { transferId: mine.body.transfer.transferId });
    const receive = await limited.call('transfer_stock', {
      action: 'receive',
      transferId: mine.body.transfer.transferId,
    });
    expect(receive.error, JSON.stringify(receive.body)).toBe(false);
    expect(receive.body.transfer.status).toBe('received');
    // A move inside the warehouse is not shown to them.
    const hidden = await run(ops.moveStock, {
      fromLocationId: shop.locationId,
      toLocationId: shelf,
      lines: [{ variantId, quantity: '1' }],
    });
    const unseen = await limited.call('transfer_stock', {
      action: 'get',
      transferId: hidden.transfer.transferId,
    });
    expect(unseen.body.code).toBe('not_found');
    const listed = await limited.call('transfer_stock', { action: 'list', status: 'all' });
    const ids = listed.body.transfers.map((x: Json) => x.transferId);
    expect(ids).toContain(mine.body.transfer.transferId);
    expect(ids).not.toContain(hidden.transfer.transferId);
    await limited.close();
  });
});

describe('manage_returns over MCP', () => {
  it('creates, receives, inspects, and completes a return, with the same answers as REST', async () => {
    const mcp = await mcpSession(t, shop, WRITE);
    const [a, b] = [await stocked(4), await stocked(4)];
    for (const v of [a, b]) {
      const reserved = await run(ops.reserveStock, {
        variantId: v.variantId,
        quantity: '2',
        purpose: 'external_order',
        externalRef: `order-${v.sku}`,
      });
      await run(ops.fulfillReservation, { reservationId: reserved.reservationId });
    }
    const request = (v: { variantId: string; sku: string }) => ({
      lines: [{ variantId: v.variantId, quantity: '2' }],
      orderRef: `order-${v.sku}`,
      reason: 'Arrived chipped',
    });
    const created = await mcp.call('manage_returns', { action: 'create', ...request(a) });
    expect(created.body.return.status).toBe('requested');
    const viaRest = await rest.post('/returns', request(b));
    expect(viaRest.status).toBe(201);
    expect(anonymized(created.body, [a.sku])).toEqual(anonymized(viaRest.body, [b.sku]));

    const returnId = created.body.return.returnId as string;
    const authorized = await mcp.call('manage_returns', { action: 'authorize', returnId });
    expect(authorized.body.return.status).toBe('authorized');
    const shipped = await mcp.call('manage_returns', {
      action: 'in_transit',
      returnId,
      trackingReference: 'TRACK-1',
    });
    expect(shipped.body.return.status).toBe('in_transit');
    const received = await mcp.call('manage_returns', {
      action: 'receive',
      returnId,
      locationId: shop.locationId,
    });
    expect(received.body.return.status).toBe('received');
    const inspected = await mcp.call('manage_returns', {
      action: 'inspect',
      returnId,
      inspections: [
        { variantId: a.variantId, disposition: 'sellable', quantity: '1' },
        { variantId: a.variantId, disposition: 'damaged', quantity: '1' },
      ],
    });
    expect(inspected.error, JSON.stringify(inspected.body)).toBe(false);
    // Inspecting every unit completes the return; completing it again is a conflict whose
    // problem keeps its HTTP status and names the return's status apart.
    expect(inspected.body.return.status).toBe('completed');
    await expectClosed(
      await mcp.call('manage_returns', { action: 'complete', returnId }),
      await rest.post(`/returns/${returnId}/complete`),
      { code: 'return_closed', currentStatus: 'completed' },
    );
    const stock = await mcp.call('get_stock', { action: 'stock', variantId: a.variantId });
    expect(stock.body.totals).toMatchObject({ onHand: '4.000000', available: '3.000000' });
    const got = await mcp.call('manage_returns', { action: 'get', returnId });
    expect(got.body).toEqual((await rest.get(`/returns/${returnId}`)).body);
    const listed = await mcp.call('manage_returns', { action: 'list', status: 'all' });
    expect(listed.body).toEqual((await rest.get('/returns', { status: 'all' })).body);

    const other = viaRest.body.return.returnId as string;
    const flagged = await mcp.call('manage_returns', {
      action: 'exception',
      returnId: other,
      note: 'The box came back empty.',
    });
    expect(flagged.body.return.exception.open).toBe(true);
    const cancelled = await mcp.call('manage_returns', { action: 'cancel', returnId: other });
    expect(cancelled.body.return.status).toBe('cancelled');
    await mcp.close();
  });

  it('refuses a grant without the scope, another shop’s IDs, and a shelf outside the member’s scope', async () => {
    const readOnly = await mcpSession(t, shop, READ);
    const refused = await readOnly.call('manage_returns', {
      action: 'create',
      lines: [{ variantId, quantity: '1' }],
    });
    expect(refused).toMatchObject({ error: true, body: { code: 'forbidden' } });
    expect((await readOnly.call('manage_returns', { action: 'list' })).error).toBe(false);
    await readOnly.close();

    const mcp = await mcpSession(t, shop, WRITE);
    const foreignVariant = await mcp.call('manage_returns', {
      action: 'create',
      lines: [{ variantId: otherVariant, quantity: '1' }],
    });
    expect(foreignVariant.body.code).toBe('not_found');
    const theirs = await run(
      ops.createReturn,
      { lines: [{ variantId: otherVariant, quantity: '1' }] },
      other,
    );
    const foreignReturn = await mcp.call('manage_returns', {
      action: 'get',
      returnId: theirs.return.returnId,
    });
    expect(foreignReturn.body.code).toBe('not_found');
    const mine = await mcp.call('manage_returns', {
      action: 'create',
      lines: [{ variantId, quantity: '2' }],
    });
    const returnId = mine.body.return.returnId as string;
    const foreignShelf = await mcp.call('manage_returns', {
      action: 'receive',
      returnId,
      locationId: other.locationId,
    });
    expect(foreignShelf.body.code).toBe('not_found');
    await mcp.close();

    // The member limited to the store receives and inspects there, and nowhere else.
    const limited = await mcpSession(t, shop, WRITE, scoped);
    const outside = await limited.call('manage_returns', {
      action: 'receive',
      returnId,
      locationId: shop.locationId,
    });
    expect(outside.body.code).toBe('location_out_of_scope');
    const inside = await limited.call('manage_returns', {
      action: 'receive',
      returnId,
      locationId: storeShelf,
    });
    expect(inside.body.return.location?.locationId).toBe(storeShelf);
    const inspected = await limited.call('manage_returns', {
      action: 'inspect',
      returnId,
      inspections: [{ variantId, disposition: 'sellable' }],
    });
    expect(inspected.error, JSON.stringify(inspected.body)).toBe(false);
    const atWarehouse = await run(ops.createReturn, { lines: [{ variantId, quantity: '1' }] });
    await run(ops.receiveReturn, {
      returnId: atWarehouse.return.returnId,
      locationId: shop.locationId,
    });
    const notHere = await limited.call('manage_returns', {
      action: 'inspect',
      returnId: atWarehouse.return.returnId,
      inspections: [{ variantId, disposition: 'sellable' }],
    });
    expect(notHere.body.code).toBe('location_out_of_scope');
    const unseen = await limited.call('manage_returns', {
      action: 'get',
      returnId: atWarehouse.return.returnId,
    });
    expect(unseen.body.code).toBe('not_found');
    const listed = await limited.call('manage_returns', { action: 'list', status: 'all' });
    const ids = listed.body.returns.map((r: Json) => r.returnId);
    expect(ids).toContain(returnId);
    expect(ids).not.toContain(atWarehouse.return.returnId);
    await limited.close();
  });
});
