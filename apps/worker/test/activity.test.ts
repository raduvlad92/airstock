import { execute, ops, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, type SeededShop } from '../../../test/helpers.ts';
import { anonymized, mcpSession, restClient } from './mcp-client.ts';
import {
  apiToken,
  type GrantMember,
  type Json,
  shopWithStock,
  type TestApp,
  testApp,
} from './setup.ts';

// The history over MCP: search_activity and get_operation_outcome end to end through an MCP
// client, with the same answers as REST. A grant without activity:read (or shop:read) is refused,
// another shop's operations, requests, and keys are never found, and a member limited to one
// warehouse sees only that warehouse's events.

const STOCK = ['inventory:read', 'inventory:write'];
const RESERVE = 'inventory.reservations.create';

let t: TestApp;
let shop: SeededShop;
let variantId: string;
let other: SeededShop;
let otherVariant: string;
let storeWarehouse: string;
let storeShelf: string;
let scoped: GrantMember;
let rest: ReturnType<typeof restClient>;

async function run(op: (typeof ops)[keyof typeof ops], input: unknown, s = shop, key = uuidv7()) {
  const res = await execute({ db: t.db, audit: t.sink }, op as never, {
    caller: s.caller,
    shopId: s.shopId,
    input,
    idempotencyKey: key,
  });
  return res.result as Json;
}

beforeAll(async () => {
  t = await testApp();
  ({ shop, variantId } = await shopWithStock(t, 'Activity MCP shop'));
  ({ shop: other, variantId: otherVariant } = await shopWithStock(t, 'Other activity shop'));
  storeWarehouse = (await run(ops.createWarehouse, { name: 'Store' })).warehouseId;
  storeShelf = (await run(ops.createLocation, { warehouseId: storeWarehouse, name: 'Front' }))
    .locationId;
  scoped = await addMember(shop.shopId, 'manager', [storeWarehouse]);
  const { token } = await apiToken(t, shop, ['shop:read', 'activity:read', ...STOCK]);
  rest = restClient(t, shop.shopId, token);
});
afterAll(() => t.close());

describe('search_activity over MCP', () => {
  it('finds a connection’s commands by integration, operation, request, and location, like REST', async () => {
    const mcp = await mcpSession(t, shop, [...STOCK, 'activity:read']);
    const receive = (locationId: string, quantity: string) =>
      mcp.call('receive_stock', { action: 'receive', variantId, locationId, quantity });
    const atWarehouse = await receive(shop.locationId, '2');
    const atStore = await receive(storeShelf, '1');
    await t.sink.drain(t.db);

    const filters = {
      integration: mcp.grantId,
      action: 'inventory.receipt.created',
      phase: 'outcome',
    };
    const found = await mcp.call('search_activity', filters);
    expect(found.error, JSON.stringify(found.body)).toBe(false);
    expect(found.body.events.map((e: Json) => e.operationId)).toEqual([
      atStore.body.operationId,
      atWarehouse.body.operationId,
    ]);
    expect(found.body.events[0]).toMatchObject({
      source: 'mcp',
      actorType: 'connection',
      clientId: 'chatgpt-test',
      outcome: 'succeeded',
    });
    const viaRest = await rest.get('/activity', filters);
    expect(viaRest.status).toBe(200);
    expect(viaRest.body.events).toEqual(found.body.events);
    expect(viaRest.body.nextCursor).toEqual(found.body.nextCursor);

    const byOperation = await mcp.call('search_activity', {
      operationId: atWarehouse.body.operationId,
    });
    expect(byOperation.body.events.map((e: Json) => e.action)).toContain(
      'inventory.receipt.created',
    );
    const attemptId = found.body.events[1].attemptId as string;
    const request = await mcp.call('search_activity', { attemptId });
    expect(request.body.lifecycle).toMatchObject({
      attemptId,
      action: 'inventory.receipt.created',
      status: 'succeeded',
    });
    expect(request.body.events.map((e: Json) => e.phase).sort()).toEqual(['attempt', 'outcome']);
    const viaRestRequest = await rest.get('/activity', { attemptId });
    expect(viaRestRequest.body.events).toEqual(request.body.events);
    expect(viaRestRequest.body.lifecycle).toEqual(request.body.lifecycle);

    const store = await mcp.call('search_activity', { ...filters, locationId: storeWarehouse });
    expect(store.body.events.map((e: Json) => e.operationId)).toEqual([atStore.body.operationId]);
    await mcp.close();
  });

  it('refuses a grant without the scope, never finds another shop’s events, and keeps to the member’s scope', async () => {
    const noHistory = await mcpSession(t, shop, STOCK);
    const refused = await noHistory.call('search_activity', {});
    expect(refused).toMatchObject({ error: true, body: { code: 'forbidden' } });
    expect(refused.body.detail).toContain('activity:read');
    await noHistory.close();

    const theirs = await run(
      ops.receiveStock,
      { variantId: otherVariant, locationId: other.locationId, quantity: '1' },
      other,
    );
    await t.sink.drain(t.db);
    const theirAttempt = t.sink.events.find(
      (e) => e.shop_id === other.shopId && e.action === 'inventory.receipt.created',
    )!.attempt_id!;
    const mcp = await mcpSession(t, shop, ['activity:read']);
    for (const filter of [
      { operationId: theirs.operationId },
      { attemptId: theirAttempt },
      { targetType: 'variant', targetId: otherVariant },
      { locationId: other.locationId },
    ]) {
      const foreign = await mcp.call('search_activity', filter);
      expect(foreign.error, JSON.stringify(foreign.body)).toBe(false);
      expect(foreign.body.events, JSON.stringify(filter)).toEqual([]);
      expect(foreign.body.lifecycle).toBeNull();
    }
    await mcp.close();

    // The owner receives at both warehouses; the member limited to the store sees one receipt.
    const owner = await mcpSession(t, shop, STOCK);
    const atWarehouse = await owner.call('receive_stock', {
      action: 'receive',
      variantId,
      locationId: shop.locationId,
      quantity: '1',
    });
    const atStore = await owner.call('receive_stock', {
      action: 'receive',
      variantId,
      locationId: storeShelf,
      quantity: '1',
    });
    await owner.close();
    await t.sink.drain(t.db);
    const limited = await mcpSession(t, shop, ['activity:read'], scoped);
    const seen = await limited.call('search_activity', {
      integration: owner.grantId,
      phase: 'outcome',
    });
    expect(seen.body.events.map((e: Json) => e.operationId)).toEqual([atStore.body.operationId]);
    const hidden = await limited.call('search_activity', {
      operationId: atWarehouse.body.operationId,
    });
    expect(hidden.body.events).toEqual([]);
    await limited.close();
  });
});

describe('get_operation_outcome over MCP', () => {
  it('returns a replayed command’s original result, and not_found for unknown ones, like REST', async () => {
    const mcp = await mcpSession(t, shop, ['shop:read', ...STOCK]);
    const key = `outcome-${uuidv7()}`;
    const args = { action: 'reserve', variantId, quantity: '1', idempotency_key: key };
    const first = await mcp.call('manage_reservations', args);
    const replay = await mcp.call('manage_reservations', args);
    expect(replay.body).toEqual({ ...first.body, replayed: true });
    const outcome = await mcp.call('get_operation_outcome', {
      operation: RESERVE,
      idempotencyKey: key,
    });
    expect(outcome.body).toEqual({
      status: 'completed',
      result: first.body,
      completedAt: expect.any(String),
    });

    // A key never sent, an operation that does not exist, and a command that failed.
    const failedKey = `failed-${uuidv7()}`;
    const failed = await mcp.call('manage_reservations', {
      action: 'reserve',
      variantId,
      quantity: '1000',
      idempotency_key: failedKey,
    });
    expect(failed.body.code).toBe('insufficient_stock');
    const notFound = { status: 'not_found', result: null, completedAt: null };
    for (const query of [
      { operation: RESERVE, idempotencyKey: 'never-sent' },
      { operation: 'inventory.no_such_operation', idempotencyKey: key },
      { operation: RESERVE, idempotencyKey: failedKey },
    ]) {
      const unknown = await mcp.call('get_operation_outcome', query);
      expect(unknown.body, JSON.stringify(query)).toEqual(notFound);
      expect((await rest.get('/operation-outcomes', query)).body).toEqual(notFound);
    }

    // REST answers the same for the credential's own command.
    const restKey = `outcome-${uuidv7()}`;
    const sent = await rest.post('/reservations', { variantId, quantity: '1' }, restKey);
    expect(sent.status).toBe(201);
    const viaRest = await rest.get('/operation-outcomes', {
      operation: RESERVE,
      idempotencyKey: restKey,
    });
    expect(viaRest.body).toEqual({
      status: 'completed',
      result: sent.body,
      completedAt: expect.any(String),
    });
    expect(anonymized(viaRest.body)).toEqual(anonymized(outcome.body));
    await mcp.close();
  });

  it('refuses a grant without shop:read, and never shows another caller’s or shop’s result', async () => {
    const noShop = await mcpSession(t, shop, STOCK);
    const key = `outcome-${uuidv7()}`;
    await noShop.call('manage_reservations', {
      action: 'reserve',
      variantId,
      quantity: '1',
      idempotency_key: key,
    });
    const refused = await noShop.call('get_operation_outcome', {
      operation: RESERVE,
      idempotencyKey: key,
    });
    expect(refused).toMatchObject({ error: true, body: { code: 'forbidden' } });
    expect(refused.body.detail).toContain('shop:read');
    await noShop.close();

    // Keys belong to the caller: another connection of the same owner, the shop's API
    // credential, and a connection of another shop that sent the same key see nothing.
    const notFound = { status: 'not_found', result: null, completedAt: null };
    const query = { operation: RESERVE, idempotencyKey: key };
    const again = await mcpSession(t, shop, ['shop:read']);
    expect((await again.call('get_operation_outcome', query)).body).toEqual(notFound);
    await again.close();
    expect((await rest.get('/operation-outcomes', query)).body).toEqual(notFound);
    await run(ops.reserveStock, { variantId: otherVariant, quantity: '1' }, other, key);
    const theirs = await mcpSession(t, other, ['shop:read']);
    expect((await theirs.call('get_operation_outcome', query)).body).toEqual(notFound);
    await theirs.close();
  });
});
