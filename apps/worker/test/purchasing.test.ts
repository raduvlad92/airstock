import { execute, ops, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, type SeededShop, seedShop } from '../../../test/helpers.ts';
import { mcpSession } from './mcp-client.ts';
import { apiToken, type Json, json, type TestApp, testApp } from './setup.ts';

// Purchase orders over REST and MCP (D11): the PDF download renders in the Worker with the label
// fonts, costs print only with costs.read, and manage_purchasing drafts, sends, and receives.

let t: TestApp;
let shop: SeededShop;
let token: string;

beforeAll(async () => {
  t = await testApp();
  shop = await seedShop(t.db, t.sink, 'Worker purchasing shop');
  token = (await apiToken(t, shop, ['inventory:read', 'inventory:write', 'catalog:write'])).token;
});
afterAll(() => t.close());

function rest(path: string, body?: unknown, bearer = token) {
  const headers = new Headers({ authorization: `Bearer ${bearer}` });
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    headers.set('idempotency-key', crypto.randomUUID());
  }
  return t.app.request(`/api/v1/shops/${shop.shopId}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function run(op: (typeof ops)[keyof typeof ops], input: unknown): Promise<Json> {
  const res = await execute({ db: t.db, audit: t.sink }, op as never, {
    caller: shop.caller,
    shopId: shop.shopId,
    input,
    idempotencyKey: uuidv7(),
  });
  return res.result as Json;
}

/** The PDF unit test (packages/pdf) proves the text; here the download is a whole PDF file. */
async function pdfBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

describe('purchase orders over REST', () => {
  it('drafts, sends, receives, and downloads the PDF', async () => {
    const supplier = await run(ops.createSupplier, {
      name: 'Ștefan & Fiii',
      email: 'comenzi@example.test',
    });
    const item = await run(ops.createItem, { name: 'Bol roșu', sku: `BOL-${uuidv7().slice(-6)}` });
    const draft = await rest('/purchase-orders', {
      supplierId: supplier.supplier.id,
      warehouseId: shop.warehouseId,
      locationId: shop.locationId,
      lines: [{ variantId: item.variantId, quantity: '6', unitCost: '2.5' }],
    });
    expect(draft.status).toBe(201);
    const po = await json(draft);
    expect(po).toMatchObject({ status: 'draft', total: '15.000000' });

    const sent = await rest(`/purchase-orders/${po.id}/send`, { email: false });
    expect(sent.status).toBe(200);
    expect((await json(sent)).purchaseOrder.status).toBe('sent');

    const received = await rest(`/purchase-orders/${po.id}/receive`, {
      lineId: po.lines[0].id,
      quantity: '4',
    });
    expect(received.status).toBe(200);
    expect((await json(received)).purchaseOrder.status).toBe('partially_received');

    const stock = await json(await rest(`/availability?variantId=${item.variantId}`));
    expect(stock.totals.onOrder).toBe('2');

    const pdf = await rest(`/purchase-orders/${po.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-disposition')).toBe(`attachment; filename="${po.number}.pdf"`);
    const bytes = await pdfBytes(pdf);
    expect(new TextDecoder('latin1').decode(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(new TextDecoder('latin1').decode(bytes.subarray(-6))).toContain('%%EOF');
    // The download is a read of the order: it is in the history.
    expect(
      t.sink.events.some(
        (e) =>
          e.action === 'purchasing.order.viewed' && e.target_id === po.id && e.phase === 'outcome',
      ),
    ).toBe(true);
  });

  it('refuses the PDF of another shop’s order and without a credential', async () => {
    const other = await seedShop(t.db, t.sink, 'Other worker purchasing shop');
    const supplier = await execute({ db: t.db, audit: t.sink }, ops.createSupplier, {
      caller: other.caller,
      shopId: other.shopId,
      input: { name: 'Elsewhere' },
      idempotencyKey: uuidv7(),
    });
    const item = await execute({ db: t.db, audit: t.sink }, ops.createItem, {
      caller: other.caller,
      shopId: other.shopId,
      input: { name: 'Mug', sku: `MUG-${uuidv7().slice(-6)}` },
      idempotencyKey: uuidv7(),
    });
    const foreign = await execute({ db: t.db, audit: t.sink }, ops.draftPurchaseOrder, {
      caller: other.caller,
      shopId: other.shopId,
      input: {
        supplierId: (supplier.result as Json).supplier.id,
        warehouseId: other.warehouseId,
        lines: [{ variantId: (item.result as Json).variantId, quantity: '1' }],
      },
      idempotencyKey: uuidv7(),
    });
    const id = (foreign.result as Json).id;
    expect((await rest(`/purchase-orders/${id}/pdf`)).status).toBe(404);
    const anonymous = await t.app.request(`/api/v1/shops/${shop.shopId}/purchase-orders/${id}/pdf`);
    expect(anonymous.status).toBe(401);
  });

  it('needs purchasing.manage to draft: an inventory operator only receives', async () => {
    const operator = await addMember(shop.shopId, 'inventory_operator');
    const operatorToken = (
      await apiToken(t, shop, ['inventory:read', 'inventory:write'], operator.caller).catch(
        () => null,
      )
    )?.token;
    // Operators cannot create credentials; the permission check is what matters, so use MCP.
    expect(operatorToken ?? null).toBeNull();
    const mcp = await mcpSession(t, shop, ['inventory:read', 'inventory:write'], {
      membershipId: operator.membershipId,
      userId: operator.userId,
    });
    const refused = await mcp.call('manage_purchasing', { action: 'list' });
    expect(refused.error).toBe(false);
    const draft = await mcp.call('manage_purchasing', {
      action: 'draft',
      supplierId: uuidv7(),
      warehouseId: shop.warehouseId,
      lines: [{ variantId: uuidv7(), quantity: '1' }],
    });
    expect(draft.error).toBe(true);
    expect(draft.body.code).toBe('forbidden');
    await mcp.close();
  });
});

describe('manage_purchasing over MCP', () => {
  it('drafts, sends, and receives with flat arguments and an action', async () => {
    const supplier = await run(ops.createSupplier, { name: `MCP supplier ${uuidv7().slice(-4)}` });
    const item = await run(ops.createItem, { name: 'Cup', sku: `CUP-${uuidv7().slice(-6)}` });
    const mcp = await mcpSession(t, shop, ['inventory:read', 'inventory:write']);
    const listed = await mcp.client.listTools();
    const tool = listed.tools.find((x) => x.name === 'manage_purchasing')!;
    expect(tool.description).toContain('Use this');
    expect(tool.annotations?.readOnlyHint).toBe(false);
    const draft = await mcp.call('manage_purchasing', {
      action: 'draft',
      supplierId: supplier.supplier.id,
      warehouseId: shop.warehouseId,
      locationId: shop.locationId,
      lines: [{ variantId: item.variantId, quantity: '3', unitCost: '1' }],
    });
    expect(draft.error).toBe(false);
    const send = await mcp.call('manage_purchasing', {
      action: 'send',
      purchaseOrderId: draft.body.id,
      email: false,
    });
    expect(send.body.purchaseOrder.status).toBe('sent');
    const receive = await mcp.call('manage_purchasing', {
      action: 'receive',
      purchaseOrderId: draft.body.id,
      lineId: draft.body.lines[0].id,
      quantity: '3',
    });
    expect(receive.body.purchaseOrder.status).toBe('received');
    const got = await mcp.call('manage_purchasing', {
      action: 'get',
      purchaseOrderId: draft.body.id,
    });
    expect(got.body.lines[0].received).toBe('3.000000');
    await mcp.close();
  });
});
