import {
  type EmailSender,
  type OutgoingEmail,
  ops,
  sendPurchaseOrderEmail,
  uuidv7,
} from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  appDatabase,
  createLeafLocation,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
  ownerQuery,
  reconcile,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';

// Purchase orders (D11, PRD 6.8): drafting with supplier defaults, sending with the send log,
// receiving against lines (partial, over-receipt, lots), close and cancel, on order in get_stock,
// costs behind costs.read, location scope, and isolation between shops (A13). A35 without the
// low-stock half, which comes with reorder rules.

const db = appDatabase({}, 6);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Purchasing shop');
  h = harness(db, sink, shop);
});
afterAll(() => db.close());

async function supplier(name = `Supplier ${uuidv7().slice(-6)}`, email?: string) {
  const res = await h.run(ops.createSupplier, { name, ...(email ? { email } : {}) });
  return res.supplier.id as string;
}

/** A variant sold by the supplier in cases of 24 at 48.00 a case, with a minimum of 2 cases. */
async function casedVariant(supplierId: string) {
  const variantId = await createVariant(h);
  const packs = await h.run(ops.setPacks, {
    variantId,
    packsVersion: 0,
    packs: [{ name: 'Case', quantity: '24' }],
  });
  const caseId = packs.packaging.packs[0].id as string;
  const item = await h.run(ops.saveSupplierItem, {
    supplierId,
    variantId,
    packId: caseId,
    supplierSku: `SUP-${variantId.slice(-6)}`,
    lastCost: '48',
    minimumOrderQuantity: '2',
    preferred: true,
  });
  return { variantId, caseId, itemId: item.item.id as string };
}

async function stock(variantId: string, caller = shop.caller) {
  return h.run(ops.getAvailability, { variantId }, { caller });
}

describe('drafting (PRD 6.8)', () => {
  it('fills the pack, supplier SKU, and cost from the supplier item, and numbers orders per shop', async () => {
    const supplierId = await supplier();
    const { variantId, caseId, itemId } = await casedVariant(supplierId);
    const plain = await createVariant(h);
    const first = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      lines: [
        { variantId, quantity: '3' },
        { variantId: plain, quantity: '5', unitCost: '1.25' },
      ],
    });
    expect(first.status).toBe('draft');
    expect(first.number).toMatch(/^PO-\d{4}$/);
    expect(first.lines[0]).toMatchObject({
      variantId,
      packId: caseId,
      packFactor: '24.000000',
      supplierItemId: itemId,
      supplierSku: `SUP-${variantId.slice(-6)}`,
      quantity: '3.000000',
      ordered: '72.000000',
      unitCost: '48.000000',
      lineTotal: '144.000000',
    });
    expect(first.lines[1]).toMatchObject({
      packId: null,
      ordered: '5.000000',
      unitCost: '1.250000',
    });
    expect(first.total).toBe('150.250000');
    // A draft is not on order.
    expect((await stock(variantId)).totals.onOrder).toBe('0');

    const second = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      lines: [{ variantId, packId: null, quantity: '10' }],
    });
    expect(Number(second.number.slice(3))).toBe(Number(first.number.slice(3)) + 1);
    // Ordering in base units converts the supplier's case cost exactly: 48 / 24 = 2.
    expect(second.lines[0]).toMatchObject({
      packId: null,
      ordered: '10.000000',
      unitCost: '2.000000',
    });
  });

  it('refuses bundles, foreign packs, and a receiving location outside the warehouse', async () => {
    const supplierId = await supplier();
    const variantId = await createVariant(h);
    const other = await casedVariant(supplierId);
    await expect(
      h.run(ops.draftPurchaseOrder, {
        supplierId,
        warehouseId: shop.warehouseId,
        lines: [{ variantId, packId: other.caseId, quantity: '1' }],
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const warehouse = await h.run(ops.createWarehouse, { name: `Other ${uuidv7().slice(-4)}` });
    await expect(
      h.run(ops.draftPurchaseOrder, {
        supplierId,
        warehouseId: warehouse.warehouseId,
        locationId: shop.locationId,
        lines: [{ variantId, quantity: '1' }],
      }),
    ).rejects.toMatchObject({ code: 'location_not_in_warehouse' });
  });

  it('replaces a draft’s lines with the version read, and freezes them once sent', async () => {
    const supplierId = await supplier();
    const { variantId } = await casedVariant(supplierId);
    const po = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      lines: [{ variantId, quantity: '1' }],
    });
    const updated = await h.run(ops.updatePurchaseOrder, {
      purchaseOrderId: po.id,
      expectedVersion: po.version,
      expectedOn: '2027-01-15',
      lines: [{ variantId, quantity: '4' }],
    });
    expect(updated.lines).toHaveLength(1);
    expect(updated.lines[0].ordered).toBe('96.000000');
    expect(updated.expectedOn).toBe('2027-01-15');
    await expect(
      h.run(ops.updatePurchaseOrder, {
        purchaseOrderId: po.id,
        expectedVersion: po.version,
        notes: 'late',
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id, email: false });
    const after = await h.run(ops.getPurchaseOrder, { purchaseOrderId: po.id });
    await expect(
      h.run(ops.updatePurchaseOrder, {
        purchaseOrderId: po.id,
        expectedVersion: after.version,
        lines: [{ variantId, quantity: '9' }],
      }),
    ).rejects.toMatchObject({ code: 'purchase_order_sent' });
    const noted = await h.run(ops.updatePurchaseOrder, {
      purchaseOrderId: po.id,
      expectedVersion: after.version,
      notes: 'Call before delivery',
    });
    expect(noted.notes).toBe('Call before delivery');
  });
});

describe('sending (D11)', () => {
  it('records a manual send, and queues an email send through the outbox', async () => {
    const supplierId = await supplier(undefined, 'orders@supplier.example');
    const { variantId } = await casedVariant(supplierId);
    const po = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      lines: [{ variantId, quantity: '2' }],
    });
    const manual = await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id, email: false });
    expect(manual.purchaseOrder.status).toBe('sent');
    expect(manual.send).toMatchObject({ channel: 'manual', status: 'recorded', recipient: null });
    const emailed = await h.run(ops.sendPurchaseOrder, {
      purchaseOrderId: po.id,
      message: 'Please confirm the date.',
    });
    expect(emailed.send).toMatchObject({
      channel: 'email',
      status: 'queued',
      recipient: 'orders@supplier.example',
    });
    expect(emailed.purchaseOrder.sends.map((s: { id: string }) => s.id)).toEqual([
      emailed.send.id,
      manual.send.id,
    ]);
    // This shop's outbox only (test files share one outbox).
    const outbox = await ownerQuery<{ payload: { sendId: string } }>(
      `select payload from outbox_events where shop_id = $1 and topic = 'email.purchase_order'`,
      [shop.shopId],
    );
    expect(outbox.map((o) => o.payload.sendId)).toContain(emailed.send.id);
  });

  it('refuses an email send without an address', async () => {
    const supplierId = await supplier();
    const { variantId } = await casedVariant(supplierId);
    const po = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      lines: [{ variantId, quantity: '2' }],
    });
    await expect(h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id })).rejects.toMatchObject({
      code: 'supplier_email_missing',
    });
    expect((await h.run(ops.getPurchaseOrder, { purchaseOrderId: po.id })).status).toBe('draft');
  });

  it('emails the PDF once, logs the outcome, and suppresses non-members where mail is limited', async () => {
    const memberEmail = (
      await ownerQuery<{ email: string }>('select email from users where id = $1', [shop.userId])
    )[0]!.email;
    const supplierId = await supplier(undefined, 'someone@supplier.example');
    const { variantId } = await casedVariant(supplierId);
    const po = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      lines: [{ variantId, quantity: '2' }],
    });
    const toMember = await h.run(ops.sendPurchaseOrder, {
      purchaseOrderId: po.id,
      emailTo: memberEmail,
    });
    const toSupplier = await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id });
    const sent: OutgoingEmail[] = [];
    const email: EmailSender = {
      async send(message) {
        sent.push(message);
        return { id: `msg-${sent.length}` };
      },
    };
    const deps = {
      db,
      audit: sink,
      email,
      renderPdf: async () => new TextEncoder().encode('%PDF-1.7 test'),
      recipients: 'members' as const,
    };
    expect(await sendPurchaseOrderEmail(deps, shop.shopId, toMember.send.id)).toBe('sent');
    expect(await sendPurchaseOrderEmail(deps, shop.shopId, toMember.send.id)).toBe('skipped');
    expect(await sendPurchaseOrderEmail(deps, shop.shopId, toSupplier.send.id)).toBe('suppressed');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: memberEmail,
      idempotencyKey: `purchase-order-send/${toMember.send.id}`,
      replyTo: memberEmail,
    });
    expect(sent[0]!.subject).toContain(po.number);
    expect(sent[0]!.attachments?.[0]).toMatchObject({
      filename: `${po.number}.pdf`,
      contentType: 'application/pdf',
    });
    const after = await h.run(ops.getPurchaseOrder, { purchaseOrderId: po.id });
    const byId = new Map(after.sends.map((s: { id: string }) => [s.id, s]));
    expect(byId.get(toMember.send.id)).toMatchObject({ status: 'sent' });
    expect(byId.get(toSupplier.send.id)).toMatchObject({ status: 'suppressed' });
    const [row] = await ownerQuery<{ provider_message_id: string }>(
      'select provider_message_id from po_sends where id = $1',
      [toMember.send.id],
    );
    expect(row!.provider_message_id).toBe('msg-1');

    // A provider refusal that will not pass on a retry marks the send failed.
    const third = await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id });
    const refusing: EmailSender = {
      async send() {
        throw Object.assign(new Error('Resend returned 422: invalid to'), { retryable: false });
      },
    };
    expect(
      await sendPurchaseOrderEmail(
        { ...deps, email: refusing, recipients: 'any' },
        shop.shopId,
        third.send.id,
      ),
    ).toBe('failed');
    const failed = (await h.run(ops.getPurchaseOrder, { purchaseOrderId: po.id })).sends.find(
      (s: { id: string }) => s.id === third.send.id,
    );
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.error).toContain('422');
  });
});

describe('receiving, on order, and closing (A35 without low stock)', () => {
  it('receives half a line by pack at the line cost, keeps the rest on order until closed', async () => {
    const supplierId = await supplier();
    const { variantId, caseId } = await casedVariant(supplierId);
    // 10 units already at 3.00, so the receipt moves the average.
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '24',
      unitCost: '3',
    });
    const po = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      locationId: shop.locationId,
      lines: [{ variantId, quantity: '4', unitCost: '48' }],
    });
    await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id, email: false });
    let s = await stock(variantId);
    expect(s.totals.onOrder).toBe('96');
    expect(s.onOrder).toEqual([
      expect.objectContaining({ purchaseOrderId: po.id, number: po.number, quantity: '96' }),
    ]);
    expect(s.totals.available).toBe('24.000000');

    const line = po.lines[0];
    const received = await h.run(ops.receivePurchaseOrderLine, {
      purchaseOrderId: po.id,
      lineId: line.id,
      quantity: '2',
    });
    expect(received.receipt).toMatchObject({ quantity: '48', overReceived: '0' });
    expect(received.purchaseOrder.status).toBe('partially_received');
    expect(received.purchaseOrder.lines[0]).toMatchObject({
      received: '48.000000',
      open: '48.000000',
    });
    // (24 × 3 + 48 × 2) / 72 = 2.333333 (the case cost 48 is 2 per unit).
    expect(received.receipt.averageCost).toBe('2.333333');
    s = await stock(variantId);
    expect(s.totals.onHand).toBe('72.000000');
    expect(s.totals.onOrder).toBe('48');

    // The receipt is an inventory receipt in packs, linked to the line, at the line's cost.
    const [entry] = await ownerQuery<{
      pack_id: string;
      entered_quantity: string;
      unit_cost: string;
      cost_basis: string;
      external_ref: string;
      supplier_id: string;
    }>(
      `select e.pack_id, e.entered_quantity::text, e.unit_cost::text, e.cost_basis, o.external_ref, o.supplier_id
       from inventory_entries e join inventory_operations o on o.shop_id = e.shop_id and o.id = e.operation_id
       where e.shop_id = $1 and e.operation_id = $2`,
      [shop.shopId, received.receipt.operationId],
    );
    expect(entry).toMatchObject({
      pack_id: caseId,
      entered_quantity: '2.000000',
      unit_cost: '2.000000',
      cost_basis: 'entered',
      external_ref: po.number,
      supplier_id: supplierId,
    });

    const closed = await h.run(ops.closePurchaseOrder, {
      purchaseOrderId: po.id,
      reason: 'Supplier is out of stock',
    });
    expect(closed.purchaseOrder.status).toBe('closed');
    expect(closed.cancelled).toEqual([{ lineId: line.id, quantity: '48' }]);
    expect(closed.purchaseOrder.lines[0]).toMatchObject({
      received: '48.000000',
      cancelled: '48.000000',
      open: '0',
    });
    s = await stock(variantId);
    expect(s.totals.onOrder).toBe('0');
    expect(s.onOrder).toEqual([]);
    await expect(
      h.run(ops.receivePurchaseOrderLine, {
        purchaseOrderId: po.id,
        lineId: line.id,
        quantity: '1',
      }),
    ).rejects.toMatchObject({ code: 'purchase_order_not_open' });
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('asks before an over-receipt, then records it; a full receipt marks the order received', async () => {
    const supplierId = await supplier();
    const variantId = await createVariant(h);
    const po = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      locationId: shop.locationId,
      lines: [{ variantId, quantity: '10', unitCost: '1' }],
    });
    await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id, email: false });
    const lineId = po.lines[0].id;
    await expect(
      h.run(ops.receivePurchaseOrderLine, { purchaseOrderId: po.id, lineId, quantity: '12' }),
    ).rejects.toMatchObject({ code: 'over_receipt', extra: { open: '10', over: '2' } });
    // Refused as a whole: no stock arrived.
    expect((await stock(variantId)).totals.onHand).toBe('0');

    const over = await h.run(ops.receivePurchaseOrderLine, {
      purchaseOrderId: po.id,
      lineId,
      quantity: '12',
      confirmOverReceipt: true,
    });
    expect(over.receipt).toMatchObject({ quantity: '12', overReceived: '2' });
    expect(over.purchaseOrder.status).toBe('received');
    expect(over.purchaseOrder.lines[0]).toMatchObject({
      received: '12.000000',
      overReceived: '2.000000',
      open: '0',
    });
    expect(over.purchaseOrder.receipts).toEqual([
      expect.objectContaining({ lineId, quantity: '12.000000', overReceived: '2.000000' }),
    ]);
    // Received orders can still be closed; nothing is left to cancel.
    const closed = await h.run(ops.closePurchaseOrder, { purchaseOrderId: po.id });
    expect(closed.cancelled).toEqual([]);
  });

  it('links lots to the line and refuses a lot-tracked receipt without a lot', async () => {
    const supplierId = await supplier();
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'lot_expiry' });
    const po = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      locationId: shop.locationId,
      lines: [{ variantId, quantity: '6' }],
    });
    await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id, email: false });
    const lineId = po.lines[0].id;
    await expect(
      h.run(ops.receivePurchaseOrderLine, { purchaseOrderId: po.id, lineId, quantity: '6' }),
    ).rejects.toMatchObject({ code: 'lot_required' });
    const res = await h.run(ops.receivePurchaseOrderLine, {
      purchaseOrderId: po.id,
      lineId,
      quantity: '6',
      lotCode: 'L-2027-01',
      expiresOn: '2027-06-30',
    });
    const [lot] = await ownerQuery<{ purchase_order_line_id: string; purchase_order_ref: string }>(
      'select purchase_order_line_id, purchase_order_ref from lots where id = $1',
      [res.receipt.lot.lotId],
    );
    expect(lot).toEqual({ purchase_order_line_id: lineId, purchase_order_ref: po.number });
  });

  it('cancels before anything arrives, and only closes after', async () => {
    const supplierId = await supplier();
    const variantId = await createVariant(h);
    const draft = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      locationId: shop.locationId,
      lines: [{ variantId, quantity: '5' }],
    });
    await expect(
      h.run(ops.closePurchaseOrder, { purchaseOrderId: draft.id }),
    ).rejects.toMatchObject({
      code: 'purchase_order_not_open',
    });
    const cancelled = await h.run(ops.cancelPurchaseOrder, { purchaseOrderId: draft.id });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.lines[0]).toMatchObject({ cancelled: '5.000000', open: '0' });

    const po = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      locationId: shop.locationId,
      lines: [{ variantId, quantity: '5' }],
    });
    await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id, email: false });
    await h.run(ops.receivePurchaseOrderLine, {
      purchaseOrderId: po.id,
      lineId: po.lines[0].id,
      quantity: '1',
    });
    await expect(h.run(ops.cancelPurchaseOrder, { purchaseOrderId: po.id })).rejects.toMatchObject({
      code: 'purchase_order_received',
    });
    const list = await h.run(ops.listPurchaseOrders, { status: 'open', supplierId });
    expect(list.purchaseOrders.map((o: { id: string }) => o.id)).toEqual([po.id]);
    expect(list.purchaseOrders[0]).toMatchObject({
      received: '1.000000',
      open: '4.000000',
      lineCount: 1,
    });
  });
});

describe('permissions, costs, and scope', () => {
  it('lets an inventory operator receive at the line cost without seeing costs', async () => {
    const supplierId = await supplier();
    const variantId = await createVariant(h);
    const po = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      locationId: shop.locationId,
      lines: [{ variantId, quantity: '4', unitCost: '7.5' }],
    });
    await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id, email: false });
    const operator = await addMember(shop.shopId, 'inventory_operator');
    const seen = await h.run(
      ops.getPurchaseOrder,
      { purchaseOrderId: po.id },
      { caller: operator.caller },
    );
    expect(seen.costVisible).toBe(false);
    expect(seen.lines[0].unitCost).toBeNull();
    expect(seen.total).toBeNull();
    const res = await h.run(
      ops.receivePurchaseOrderLine,
      { purchaseOrderId: po.id, lineId: po.lines[0].id, quantity: '4' },
      { caller: operator.caller },
    );
    expect(res.receipt.averageCost).toBeNull();
    expect(res.purchaseOrder.lines[0].unitCost).toBeNull();
    // The cost still reached valuation.
    expect((await stock(variantId)).cost.averageCost).toBe('7.500000');
    // Operators cannot draft, send, close, or cancel.
    await expect(
      h.run(
        ops.draftPurchaseOrder,
        { supplierId, warehouseId: shop.warehouseId, lines: [{ variantId, quantity: '1' }] },
        { caller: operator.caller },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      h.run(ops.closePurchaseOrder, { purchaseOrderId: po.id }, { caller: operator.caller }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('hides orders for other warehouses from a member limited to one location', async () => {
    const supplierId = await supplier();
    const variantId = await createVariant(h);
    const created = await h.run(ops.createWarehouse, { name: `Annex ${uuidv7().slice(-4)}` });
    const annexId = created.warehouseId as string;
    const annexBin = await createLeafLocation(h, annexId, 'Bin 1');
    const mainPo = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      lines: [{ variantId, quantity: '1' }],
    });
    const annexPo = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: annexId,
      locationId: annexBin,
      lines: [{ variantId, quantity: '1' }],
    });
    const scoped = await addMember(shop.shopId, 'manager', [annexBin]);
    const list = await h.run(ops.listPurchaseOrders, { supplierId }, { caller: scoped.caller });
    expect(list.purchaseOrders.map((o: { id: string }) => o.id)).toEqual([annexPo.id]);
    await expect(
      h.run(ops.getPurchaseOrder, { purchaseOrderId: mainPo.id }, { caller: scoped.caller }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      h.run(
        ops.draftPurchaseOrder,
        { supplierId, warehouseId: shop.warehouseId, lines: [{ variantId, quantity: '1' }] },
        { caller: scoped.caller },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps purchase orders apart between shops (A13)', async () => {
    const other = await seedShop(db, sink, 'Other purchasing shop');
    const o = harness(db, sink, other);
    const otherSupplier = (await o.run(ops.createSupplier, { name: 'Elsewhere' })).supplier.id;
    const otherVariant = await createVariant(o);
    const foreign = await o.run(ops.draftPurchaseOrder, {
      supplierId: otherSupplier,
      warehouseId: other.warehouseId,
      locationId: other.locationId,
      lines: [{ variantId: otherVariant, quantity: '3' }],
    });
    await o.run(ops.sendPurchaseOrder, { purchaseOrderId: foreign.id, email: false });
    await expect(
      h.run(ops.getPurchaseOrder, { purchaseOrderId: foreign.id }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      h.run(ops.receivePurchaseOrderLine, {
        purchaseOrderId: foreign.id,
        lineId: foreign.lines[0].id,
        quantity: '1',
        locationId: shop.locationId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // Another shop's supplier or variant cannot go on this shop's order.
    await expect(
      h.run(ops.draftPurchaseOrder, {
        supplierId: otherSupplier,
        warehouseId: shop.warehouseId,
        lines: [{ variantId: otherVariant, quantity: '1' }],
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    for (const table of [
      'purchase_orders',
      'purchase_order_lines',
      'po_sends',
      'purchase_order_counters',
    ]) {
      const rows = await db.transaction(
        { shopId: shop.shopId, userId: null, readOnly: true },
        (tx) => tx.query<{ shop_id: string }>(`select shop_id from ${table}`),
      );
      expect(
        rows.filter((r) => r.shop_id !== shop.shopId),
        table,
      ).toEqual([]);
    }
    const onOrder = await db.transaction(
      { shopId: shop.shopId, userId: null, readOnly: true },
      (tx) => tx.query('select * from purchase_on_order(array[$1::uuid])', [otherVariant]),
    );
    expect(onOrder).toEqual([]);
  });
});

describe('receiving after the order was sent (review fixes)', () => {
  async function sentOrder(supplierId: string, variantId: string, packId?: string) {
    const po = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      lines: [{ variantId, ...(packId ? { packId } : {}), quantity: '2', unitCost: '48' }],
    });
    await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id, email: false });
    return po;
  }

  it('receives an order sent before its supplier and pack were archived', async () => {
    const supplierId = await supplier();
    const variantId = await createVariant(h);
    const packs = await h.run(ops.setPacks, {
      variantId,
      packsVersion: 0,
      packs: [{ name: 'Case', quantity: '24' }],
    });
    const po = await sentOrder(supplierId, variantId, packs.packaging.packs[0].id);
    // The case is archived (left out of the list) and the supplier archived after sending.
    await h.run(ops.setPacks, { variantId, packsVersion: 1, packs: [] });
    const current = await h.run(ops.getSupplier, { supplierId });
    await h.run(ops.updateSupplier, {
      supplierId,
      expectedVersion: current.supplier.version,
      status: 'archived',
    });
    const res = await h.run(ops.receivePurchaseOrderLine, {
      purchaseOrderId: po.id,
      lineId: po.lines[0].id,
      quantity: '2',
      locationId: shop.locationId,
    });
    expect(res.receipt.quantity).toBe('48');
    expect(res.purchaseOrder.status).toBe('received');
    expect((await stock(variantId)).totals.onHand).toBe('48.000000');
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('refuses to archive a variant that is still on order', async () => {
    const supplierId = await supplier();
    const variantId = await createVariant(h);
    await sentOrder(supplierId, variantId);
    await expect(h.run(ops.archiveVariant, { variantId })).rejects.toMatchObject({
      code: 'open_purchase_orders',
    });
  });

  it('refuses a receiving location outside the order’s warehouse', async () => {
    const supplierId = await supplier();
    const variantId = await createVariant(h);
    const po = await sentOrder(supplierId, variantId);
    const other = await h.run(ops.createWarehouse, { name: `Other ${uuidv7().slice(-4)}` });
    const elsewhere = await createLeafLocation(h, other.warehouseId, 'Dock');
    await expect(
      h.run(ops.receivePurchaseOrderLine, {
        purchaseOrderId: po.id,
        lineId: po.lines[0].id,
        quantity: '2',
        locationId: elsewhere,
      }),
    ).rejects.toMatchObject({ code: 'location_not_in_warehouse' });
  });

  it('opens the low-stock alert when an order arrives unsellable', async () => {
    const supplierId = await supplier();
    const variantId = await createVariant(h);
    await h.run(ops.setReorderRule, {
      variantId,
      warehouseId: shop.warehouseId,
      reorderPoint: '1',
      reorderQuantity: '5',
    });
    const po = await sentOrder(supplierId, variantId);
    // Two on order keep available plus on order above the point; damaged goods take that away.
    const lowStock = async () =>
      (await h.run(ops.listAlerts, { status: 'all', variantId })).alerts.filter(
        (a: { kind: string; status: string }) => a.kind === 'low_stock' && a.status === 'open',
      ).length;
    expect(await lowStock()).toBe(0);
    await h.run(ops.receivePurchaseOrderLine, {
      purchaseOrderId: po.id,
      lineId: po.lines[0].id,
      quantity: '2',
      locationId: shop.locationId,
      condition: 'damaged',
    });
    expect(await lowStock()).toBe(1);
  });
});
