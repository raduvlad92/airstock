import { type FileAccess, ops, runExportJob, uuidv7 } from '@airstock/core';
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
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';
import { parseCsv } from '../src/csv.ts';

// G6 (plan 5.7): the lot trace as a CSV export. The file lists the lot's supplier and purchase
// order on its receipt, then every order, transfer, return, and disposal, as the trace read does;
// it is written by the export job with the member's location scope, logged when created,
// completed, and downloaded, and downloaded like every other export.

const db = appDatabase({}, 6);
const sink = new MemoryAuditSink();
const stored = new Map<string, string>();
const files: FileAccess = {
  get: async (k) => stored.get(k) ?? null,
  put: async (k, body) => {
    stored.set(k, body);
  },
  delete: async (k) => {
    stored.delete(k);
  },
};

let shop: SeededShop;
let h: Harness;
let farLocation: string;
let variantId: string;
let poNumber: string;
const lotCode = `L-RECALL-${uuidv7().slice(-4)}`;
const supplierName = `Recall Foods ${uuidv7().slice(-4)}`;

// biome-ignore lint/suspicious/noExplicitAny: tests read many result shapes
type Row = Record<string, any>;

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Lot trace export shop');
  h = harness(db, sink, shop);
  const far = await h.run(ops.createWarehouse, { name: 'Far warehouse' });
  farLocation = await createLeafLocation(h, far.warehouseId, 'Far shelf');
  const supplier = await h.run(ops.createSupplier, { name: supplierName });
  variantId = await createVariant(h);
  await h.run(ops.setStockSettings, { variantId, trackingMode: 'lot_expiry' });

  // Receipt against a purchase order: the supplier and the order are on the lot's first line.
  const po = await h.run(ops.draftPurchaseOrder, {
    supplierId: supplier.supplier.id,
    warehouseId: shop.warehouseId,
    locationId: shop.locationId,
    lines: [{ variantId, quantity: '10', unitCost: '2' }],
  });
  poNumber = po.number;
  await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id, email: false });
  await h.run(ops.receivePurchaseOrderLine, {
    purchaseOrderId: po.id,
    lineId: po.lines[0].id,
    quantity: '10',
    lotCode,
    expiresOn: '2031-01-31',
  });
  // A transfer of 4 to the far warehouse.
  const transfer = await h.run(ops.createTransfer, {
    fromLocationId: shop.locationId,
    toLocationId: farLocation,
    lines: [{ variantId, quantity: '4', lotCode }],
    ready: true,
  });
  await h.run(ops.dispatchTransfer, { transferId: transfer.transfer.transferId });
  await h.run(ops.receiveTransfer, { transferId: transfer.transfer.transferId });
  // An order from each warehouse.
  const near = await h.run(ops.reserveStock, {
    variantId,
    quantity: '2',
    locationId: shop.locationId,
    externalRef: 'shop:order/1001',
  });
  await h.run(ops.fulfillReservation, { reservationId: near.reservationId });
  const remote = await h.run(ops.reserveStock, {
    variantId,
    quantity: '1',
    locationId: farLocation,
    externalRef: 'shop:order/1002',
  });
  await h.run(ops.fulfillReservation, { reservationId: remote.reservationId });
  // One unit of order 1001 comes back and is disposed of after inspection.
  const ret = await h.run(ops.createReturn, {
    lines: [{ variantId, quantity: '1' }],
    orderRef: 'shop:order/1001',
  });
  await h.run(ops.receiveReturn, {
    returnId: ret.return.returnId,
    locationId: shop.locationId,
    items: [{ variantId, lotCode }],
  });
  await h.run(ops.inspectReturn, {
    returnId: ret.return.returnId,
    inspections: [{ variantId, disposition: 'disposal', quantity: '1' }],
  });
  // A write-off in the far warehouse.
  await h.run(ops.adjustStock, {
    locationId: farLocation,
    adjustmentReason: 'write_off',
    adjustments: [{ variantId, direction: 'remove', quantity: '1', lotCode }],
  });
});
afterAll(() => db.close());

async function exportFor(opts: { caller?: SeededShop['caller'] } = {}) {
  const created = await h.run(ops.exportLotTrace, { variantId, lotCode }, opts);
  expect(created.export).toMatchObject({ kind: 'lot_trace', status: 'pending' });
  await runExportJob({ db, audit: sink, files }, shop.shopId, created.export.exportId);
  const done = await h.run(ops.getExport, { exportId: created.export.exportId });
  const csv = stored.get(`shops/${shop.shopId}/exports/${created.export.exportId}.csv`) ?? '';
  const [header, ...rows] = parseCsv(csv.replace(/^﻿/, ''));
  return {
    exportId: created.export.exportId as string,
    done: done.export as Row,
    header: header!,
    rows: rows.map((r) => Object.fromEntries(header!.map((k, i) => [k, r[i] ?? '']))),
    csv,
  };
}

describe('lot trace export (G6)', () => {
  it('writes every movement of the lot, from the supplier and order to every disposal', async () => {
    const trace = await h.run(ops.traceLot, { variantId, lotCode });
    const file = await exportFor();
    expect(file.done).toMatchObject({ status: 'completed', kind: 'lot_trace' });
    expect(file.done.downloadPath).toBe(
      `/api/v1/shops/${shop.shopId}/exports/${file.exportId}/file`,
    );
    expect(file.header).toEqual([
      'occurred_at',
      'lot',
      'sku',
      'expires_on',
      'movement',
      'quantity',
      'location',
      'condition',
      'order',
      'reservation_id',
      'reference',
      'purchase_order',
      'supplier',
      'actor_type',
      'source',
      'operation_id',
    ]);
    // The same movements as the trace read, in the same order.
    expect(file.done.rowCount).toBe(trace.movements.length);
    expect(file.rows.map((r) => [r.operation_id, r.movement, r.quantity])).toEqual(
      trace.movements.map((m: Row) => [m.operationId, m.kind, m.quantity]),
    );
    expect(new Set(file.rows.map((r) => r.lot))).toEqual(new Set([lotCode]));
    expect(new Set(file.rows.map((r) => r.expires_on))).toEqual(new Set(['2031-01-31']));
    // The receipt names its supplier and purchase order.
    const receipt = file.rows.find((r) => r.movement === 'receipt')!;
    expect(receipt).toMatchObject({
      quantity: '10.000000',
      purchase_order: poNumber,
      supplier: supplierName,
    });
    // Every order that got units of the lot, and the other movements.
    expect(
      file.rows.filter((r) => r.movement === 'fulfillment').map((r) => [r.order, r.quantity]),
    ).toEqual([
      ['shop:order/1001', '-2.000000'],
      ['shop:order/1002', '-1.000000'],
    ]);
    const kinds = new Set(file.rows.map((r) => r.movement));
    for (const kind of ['receipt', 'fulfillment', 'return', 'adjustment']) {
      expect(kinds).toContain(kind);
    }
    expect([...kinds].some((k) => String(k).startsWith('transfer'))).toBe(true);
    // Quantities add up to the lot's stock now: 10 in, 3 sold, 1 back, 1 disposed, 1 written off.
    const total = file.rows.reduce((sum, r) => sum + Number(r.quantity), 0);
    expect(total).toBe(Number(trace.totals.onHand));
    expect(total).toBe(6);
  });

  it('leaves out movements outside the member’s locations, like the trace read', async () => {
    const scoped = await addMember(shop.shopId, 'manager', [shop.warehouseId]);
    const trace = await h.run(ops.traceLot, { variantId, lotCode }, { caller: scoped.caller });
    expect(trace.partial).toBe(true);
    const file = await exportFor({ caller: scoped.caller });
    expect(file.done.status).toBe('completed');
    expect(file.rows.map((r) => r.operation_id)).toEqual(
      trace.movements.map((m: Row) => m.operationId),
    );
    expect(file.csv).not.toContain('Far warehouse');
    expect(file.csv).not.toContain('shop:order/1002');
    expect(file.rows.some((r) => r.order === 'shop:order/1001')).toBe(true);
    // The full file has the far movements the scoped one leaves out.
    const full = await exportFor();
    expect(full.rows.length).toBeGreaterThan(file.rows.length);
    expect(full.csv).toContain('Far warehouse');
  });

  it('is logged when created, completed, and downloaded, and listed with the exports', async () => {
    const file = await exportFor();
    const listed = await h.run(ops.listExports, {});
    expect(listed.exports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exportId: file.exportId, kind: 'lot_trace' }),
      ]),
    );
    const download = await h.run(ops.downloadExport, { exportId: file.exportId });
    expect(download.fileName).toMatch(
      new RegExp(`^airstock-lot-trace-${lotCode}-[0-9a-f]{8}\\.csv$`),
    );
    await sink.drain(db);
    const logged = await ownerQuery<{ action: string; outcome: string; changes: Row | null }>(
      `select action, outcome, changes from audit_events
       where shop_id = $1 and target_type = 'export' and target_id = $2 and phase = 'outcome'
       order by occurred_at, event_id`,
      [shop.shopId, file.exportId],
    );
    expect(logged.map((e) => e.action)).toEqual([
      'inventory.lot_trace_export.created',
      'inventory.lot_trace_export.completed',
      // The status read while waiting for the file.
      'catalog.export.viewed',
      'catalog.export.downloaded',
    ]);
    expect(logged[1]!.changes).toMatchObject({ rows: file.rows.length, truncated: false });
  });

  it('needs the exports and stock permissions, a known lot, and a member who is still there', async () => {
    const operator = await addMember(shop.shopId, 'inventory_operator');
    await expect(
      h.run(ops.exportLotTrace, { variantId, lotCode }, { caller: operator.caller }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      h.run(ops.exportLotTrace, { variantId, lotCode: 'NO-SUCH-LOT' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.run(ops.exportLotTrace, { variantId })).rejects.toMatchObject({
      code: 'validation_failed',
    });

    const editor = await addMember(shop.shopId, 'catalog_editor');
    const created = await h.run(
      ops.exportLotTrace,
      { variantId, lotCode },
      { caller: editor.caller },
    );
    await ownerQuery(`update memberships set status = 'removed' where shop_id = $1 and id = $2`, [
      shop.shopId,
      editor.membershipId,
    ]);
    await runExportJob({ db, audit: sink, files }, shop.shopId, created.export.exportId);
    const done = await h.run(ops.getExport, { exportId: created.export.exportId });
    expect(done.export.status).toBe('failed');
    expect(
      sink.events.some(
        (e) =>
          e.action === 'inventory.lot_trace_export.failed' &&
          e.target_id === created.export.exportId &&
          e.outcome === 'denied',
      ),
    ).toBe(true);
  });
});
