import { type Caller, type FileAccess, ops, runReportExportJob, uuidv7 } from '@airstock/core';
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

// The eight standard reports (PRD 3.5, plan Section 5.15, D15): figures against hand-computed
// fixtures (lots, packs, conditions, in transit, on order), A39 through the reports, location
// scope with partial totals (A42), costs only with costs.read, one access event per run, saved
// reports' sharing rules, the CSV export job, and isolation between shops (A13).

const db = appDatabase({}, 6);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let storeWarehouse: string;
let front: string;
let shelfB: string;

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Reports shop');
  h = harness(db, sink, shop);
  storeWarehouse = (await h.run(ops.createWarehouse, { name: 'Store' })).warehouseId;
  front = await createLeafLocation(h, storeWarehouse, 'Front');
  shelfB = await createLeafLocation(h, shop.warehouseId, 'Shelf B');
});
afterAll(() => db.close());

function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

// biome-ignore lint/suspicious/noExplicitAny: report rows are keyed by column
type Row = Record<string, any>;

async function report(
  name: string,
  filters: Record<string, unknown> = {},
  caller?: Caller,
): Promise<{
  rows: Row[];
  totals: Record<string, string>;
  columns: Array<{ key: string }>;
  partial: boolean;
  costVisible: boolean;
  nextCursor: string | null;
  rowCount: number;
  // biome-ignore lint/suspicious/noExplicitAny: the rest of the result
  [key: string]: any;
}> {
  return h.run(ops.runStandardReport, { report: name, ...filters }, caller ? { caller } : {});
}

/** A connector caller (only connectors record shortages, D6). */
async function connector(): Promise<Caller> {
  const [m] = await ownerQuery<{ id: string }>(
    'select id from memberships where shop_id = $1 and user_id = $2',
    [shop.shopId, shop.userId],
  );
  return {
    kind: 'connector',
    id: uuidv7(),
    userId: null,
    boundShopId: shop.shopId,
    membership: {
      id: m!.id,
      role: 'inventory_operator',
      allLocations: true,
      locationScopeIds: [],
      permissions: new Set(['inventory.read', 'inventory.reserve', 'inventory.fulfill']),
    },
    scopes: new Set(['inventory:read', 'inventory:write']),
    clientId: 'shopify',
    source: 'shopify',
  };
}

describe('A39 through the reports', () => {
  it('values 15 units at €75 and costs 5 fulfilled at €25, the same when asked again after later receipts', async () => {
    const variantId = await createVariant(h);
    const from = new Date().toISOString();
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '10',
      unitCost: '4',
    });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '10',
      unitCost: '6',
    });
    const r = await h.run(ops.reserveStock, { variantId, quantity: '5' });
    await h.run(ops.fulfillReservation, { reservationId: r.reservationId });
    await pause();
    const at = new Date().toISOString();

    const check = async () => {
      const value = await report('inventory_value', { variantId, at, groupBy: 'variant' });
      expect(value.totals).toMatchObject({ quantity: '15', value: '75' });
      expect(value.rows).toEqual([
        expect.objectContaining({ quantity: '15', averageCost: '5', value: '75' }),
      ]);
      const byLocation = await report('inventory_value', { variantId, at });
      expect(byLocation.rows).toEqual([
        expect.objectContaining({ location: 'Main stock', quantity: '15', value: '75' }),
      ]);
      const cogs = await report('cost_of_goods', { variantId, from, to: at });
      expect(cogs.totals).toMatchObject({ quantity: '5', costOfGoods: '25' });
      expect(cogs.rows[0]).toMatchObject({ averageCost: '5', costOfGoods: '25' });
    };
    await check();
    // A later receipt at €8 moves the average to 5.75, but not the value at that moment.
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '5',
      unitCost: '8',
    });
    await check();
    const now = await report('inventory_value', { variantId, groupBy: 'variant' });
    expect(now.totals).toMatchObject({ quantity: '20', value: '115' });
    // A date means the end of that day in the shop's time zone; tomorrow's value is today's.
    const tomorrow = await report('inventory_value', { variantId, at: day(1) });
    expect(tomorrow.totals.value).toBe('115');
    const yesterday = await report('inventory_value', { variantId, at: day(-1) });
    expect(yesterday.rows).toEqual([]);
  });
});

describe('stock on hand, movements, and expiring lots against fixtures', () => {
  let cased: string;
  let lotted: string;
  let started: string;

  beforeAll(async () => {
    started = new Date().toISOString();
    cased = await createVariant(h);
    const packs = await h.run(ops.setPacks, {
      variantId: cased,
      packsVersion: 0,
      packs: [{ name: 'Case', quantity: '24' }],
    });
    const caseId = packs.packaging.packs[0].id as string;
    // 3 cases of 24 and 5 singles at Main: 77; 4 in quarantine on Shelf B.
    await h.run(ops.receiveStock, {
      variantId: cased,
      locationId: shop.locationId,
      quantity: '3',
      packId: caseId,
      unitCost: '2',
    });
    await h.run(ops.receiveStock, {
      variantId: cased,
      locationId: shop.locationId,
      quantity: '5',
      unitCost: '2',
    });
    await h.run(ops.receiveStock, {
      variantId: cased,
      locationId: shelfB,
      quantity: '4',
      condition: 'quarantine',
      unitCost: '2',
    });
    // 6 sent to the store's Front: 2 arrived, 4 still in transit.
    const t = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: front,
      lines: [{ variantId: cased, quantity: '6' }],
      ready: true,
    });
    await h.run(ops.dispatchTransfer, { transferId: t.transfer.transferId });
    await h.run(ops.receiveTransfer, {
      transferId: t.transfer.transferId,
      items: [{ variantId: cased, quantity: '2' }],
    });
    // 3 reserved at Main.
    await h.run(ops.reserveStock, { variantId: cased, quantity: '3', locationId: shop.locationId });

    lotted = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId: lotted, trackingMode: 'lot_expiry' });
    await h.run(ops.receiveStock, {
      variantId: lotted,
      locationId: shop.locationId,
      quantity: '10',
      lotCode: 'A-SOON',
      expiresOn: day(10),
    });
    await h.run(ops.receiveStock, {
      variantId: lotted,
      locationId: shop.locationId,
      quantity: '5',
      lotCode: 'B-LATER',
      expiresOn: day(100),
    });
  });

  it('lists positions by location, condition, and lot, with packs, in transit, and totals', async () => {
    const soh = await report('stock_on_hand', { variantId: cased, sort: 'location' });
    const rows = soh.rows.map((r) => [r.location, r.condition, r.onHand, r.reserved, r.packs]);
    expect(rows).toEqual([
      ['In transit', 'sellable', '4', '0', null],
      ['Main stock', 'sellable', '71', '3', '2 × Case (24) + 23'],
      ['Main stock/Shelf B', 'quarantine', '4', '0', null],
      ['Store/Front', 'sellable', '2', '0', null],
    ]);
    expect(soh.rows[1]).toMatchObject({ available: '68', value: '142', warehouse: 'Main stock' });
    expect(soh.totals).toMatchObject({ onHand: '81', reserved: '3', available: '70' });
    expect(soh.partial).toBe(false);

    const byVariant = await report('stock_on_hand', { variantId: cased, groupBy: 'variant' });
    expect(byVariant.rows[0]).toMatchObject({
      onHand: '77',
      sellable: '73',
      quarantined: '4',
      inTransit: '4',
      reserved: '3',
      available: '70',
      packs: '3 × Case (24) + 5',
      value: '162',
    });
    const lots = await report('stock_on_hand', { variantId: lotted });
    expect(lots.rows.map((r) => [r.lot, r.onHand, r.expiresOn])).toEqual([
      ['A-SOON', '10', day(10)],
      ['B-LATER', '5', day(100)],
    ]);
    const quarantine = await report('stock_on_hand', { variantId: cased, condition: 'quarantine' });
    expect(quarantine.totals.onHand).toBe('4');
    const byLocation = await report('stock_on_hand', {
      variantId: cased,
      groupBy: 'location',
      warehouseId: shop.warehouseId,
    });
    expect(byLocation.rows.map((r) => [r.location, r.onHand])).toEqual([
      ['Main stock', '71'],
      ['Main stock/Shelf B', '4'],
    ]);
  });

  it('pages by keyset with the same rows and totals as one page', async () => {
    const all = await report('stock_on_hand', { variantId: cased, sort: '-onHand' });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await report('stock_on_hand', {
        variantId: cased,
        sort: '-onHand',
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.totals).toEqual(all.totals);
      expect(page.rowCount).toBe(4);
      seen.push(...page.rows.map((r) => `${r.location}:${r.onHand}`));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.rows.map((r) => `${r.location}:${r.onHand}`));
    await expect(
      report('stock_on_hand', { variantId: lotted, cursor: all.nextCursor ?? 'bad' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('sums receipts, transfers out and in, and fulfillments from the ledger', async () => {
    const r = await h.run(ops.reserveStock, { variantId: cased, quantity: '1' });
    await h.run(ops.fulfillReservation, { reservationId: r.reservationId });
    const mv = await report('movements', { variantId: cased, from: started });
    expect(mv.rows[0]).toMatchObject({
      received: '81',
      transferredOut: '-6',
      transferredIn: '2',
      fulfilled: '-1',
      net: '76',
      // Each entry at the cost it recorded: transfers record none, as they change no cost.
      netValue: '160',
    });
    const byType = await report('movements', { variantId: cased, from: started, groupBy: 'type' });
    expect(byType.rows.map((x) => [x.type, x.in, x.out, x.net])).toEqual([
      ['fulfillment', '0', '-1', '-1'],
      ['receipt', '81', '0', '81'],
      ['transfer', '2', '-6', '-4'],
    ]);
    const entries = await report('movements', {
      variantId: cased,
      from: started,
      groupBy: 'entry',
      movementType: 'transfer',
    });
    expect(entries.rows.map((x) => [x.location, x.quantity]).sort()).toEqual([
      ['Main stock', '-6'],
      ['Store/Front', '2'],
    ]);
    const byLocation = await report('movements', {
      variantId: cased,
      from: started,
      groupBy: 'location',
    });
    expect(byLocation.totals).toMatchObject({ net: '76' });
    const before = await report('movements', { variantId: cased, to: started });
    expect(before.rows).toEqual([]);
  });

  it('lists lots expiring within the window, and only those', async () => {
    const soon = await report('expiring_lots', { variantId: lotted, days: 30 });
    expect(soon.rows).toEqual([
      expect.objectContaining({
        lot: 'A-SOON',
        expiresOn: day(10),
        expired: false,
        onHand: '10',
        locations: 'Main stock',
      }),
    ]);
    expect(Math.abs(soon.rows[0]!.daysLeft - 10)).toBeLessThanOrEqual(1);
    const all = await report('expiring_lots', {
      variantId: lotted,
      days: 365,
      groupBy: 'position',
    });
    expect(all.totals.onHand).toBe('15');
  });
});

describe('low stock and purchasing', () => {
  it('suggests a reorder in the supplier’s packs and lists the open order as on order and overdue', async () => {
    const supplierId = (await h.run(ops.createSupplier, { name: `Sup ${uuidv7().slice(-6)}` }))
      .supplier.id as string;
    const variantId = await createVariant(h);
    const packs = await h.run(ops.setPacks, {
      variantId,
      packsVersion: 0,
      packs: [{ name: 'Case', quantity: '12' }],
    });
    const caseId = packs.packaging.packs[0].id as string;
    await h.run(ops.saveSupplierItem, {
      supplierId,
      variantId,
      packId: caseId,
      lastCost: '24',
      preferred: true,
    });
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '3' });
    await h.run(ops.setReorderRule, {
      variantId,
      warehouseId: shop.warehouseId,
      reorderPoint: '10',
      reorderQuantity: '30',
    });
    const low = await report('low_stock', { variantId });
    expect(low.rows).toEqual([
      expect.objectContaining({
        available: '3',
        onOrder: '0',
        need: '30',
        orderQuantity: '3',
        orderUnit: 'Case',
        orderedUnits: '36',
        unitCost: '24',
        orderValue: '72',
      }),
    ]);
    const po = await h.run(ops.draftPurchaseOrder, {
      supplierId,
      warehouseId: shop.warehouseId,
      expectedOn: day(-2),
      lines: [{ variantId, quantity: '2' }],
    });
    await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id, email: false });
    // Available plus on order (27) is now above the reorder point.
    expect((await report('low_stock', { variantId })).rows).toEqual([]);

    const lines = await report('purchasing', { variantId });
    expect(lines.rows).toEqual([
      expect.objectContaining({
        status: 'sent',
        ordered: '24',
        received: '0',
        onOrder: '24',
        overdue: true,
        unitCost: '2',
        openValue: '48',
      }),
    ]);
    expect(lines.rows[0]!.daysOverdue).toBeGreaterThanOrEqual(1);
    const bySupplier = await report('purchasing', { supplierId, groupBy: 'supplier' });
    expect(bySupplier.rows[0]).toMatchObject({ orders: 1, overdueOrders: 1, onOrder: '24' });
    const overdue = await report('purchasing', {
      variantId,
      overdueOnly: 'true',
      groupBy: 'order',
    });
    expect(overdue.rows).toHaveLength(1);
    await h.run(ops.receivePurchaseOrderLine, {
      purchaseOrderId: po.id,
      lineId: (await h.run(ops.getPurchaseOrder, { purchaseOrderId: po.id })).lines[0].id,
      quantity: '1',
      locationId: shelfB,
    });
    const partly = await report('purchasing', { variantId });
    expect(partly.rows[0]).toMatchObject({ received: '12', onOrder: '12' });
  });
});

describe('shortages', () => {
  it('lists open shortages per order and per variant with what is on order', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '2' });
    const ref = `ORDER-${uuidv7().slice(-6)}`;
    await h.run(
      ops.reserveStock,
      {
        variantId,
        quantity: '5',
        allowShortage: true,
        purpose: 'external_order',
        externalRef: ref,
      },
      { caller: await connector() },
    );
    const byOrder = await report('shortages', { variantId });
    expect(byOrder.rows).toEqual([
      expect.objectContaining({ order: ref, ordered: '5', shortage: '3' }),
    ]);
    const byVariant = await report('shortages', { variantId, groupBy: 'variant' });
    expect(byVariant.rows[0]).toMatchObject({ shortage: '3', orders: 1, onOrder: '0' });
  });
});

describe('location scope (A42) and costs', () => {
  it('shows a scoped member only their locations and labels the totals partial', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '10',
      unitCost: '1',
    });
    await h.run(ops.receiveStock, { variantId, locationId: front, quantity: '3', unitCost: '1' });
    const scoped = await addMember(shop.shopId, 'manager', [storeWarehouse]);
    const soh = await report('stock_on_hand', { variantId }, scoped.caller);
    expect(soh.partial).toBe(true);
    expect(soh.rows.map((r) => r.location)).toEqual(['Store/Front']);
    expect(soh.totals.onHand).toBe('3');
    const value = await report('inventory_value', { variantId }, scoped.caller);
    expect(value).toMatchObject({ partial: true, totals: { quantity: '3', value: '3' } });
    const mv = await report('movements', { variantId, groupBy: 'location' }, scoped.caller);
    expect(mv.rows.map((r) => r.location)).toEqual(['Store/Front']);
    // Out-of-scope filters return nothing rather than another place's stock.
    const other = await report(
      'stock_on_hand',
      { variantId, warehouseId: shop.warehouseId },
      scoped.caller,
    );
    expect(other.rows).toEqual([]);
    const full = await report('stock_on_hand', { variantId });
    expect(full).toMatchObject({ partial: false, totals: { onHand: '13' } });
  });

  it('leaves out cost columns without costs.read and refuses the cost reports', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '2',
      unitCost: '3',
    });
    const operator = await addMember(shop.shopId, 'inventory_operator');
    const soh = await report('stock_on_hand', { variantId }, operator.caller);
    expect(soh.costVisible).toBe(false);
    expect(soh.columns.map((c) => c.key)).not.toContain('value');
    expect(soh.rows[0]).not.toHaveProperty('value');
    expect(soh.totals).not.toHaveProperty('value');
    await expect(
      report('stock_on_hand', { variantId, sort: '-value' }, operator.caller),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(report('inventory_value', {}, operator.caller)).rejects.toMatchObject({
      status: 403,
    });
    await expect(report('cost_of_goods', {}, operator.caller)).rejects.toMatchObject({
      status: 403,
    });
    const viewer = await addMember(shop.shopId, 'viewer');
    expect((await report('stock_on_hand', { variantId }, viewer.caller)).rows).toHaveLength(1);
  });
});

describe('audit', () => {
  it('records one access event per run with the report and its filters', async () => {
    const variantId = await createVariant(h);
    const before = sink.events.length;
    await report('stock_on_hand', { variantId, groupBy: 'variant' });
    const events = sink.events
      .slice(before)
      .filter((e) => e.action === 'reports.report.run' && e.shop_id === shop.shopId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: 'outcome',
      outcome: 'succeeded',
      target_type: 'report',
      target_id: 'stock_on_hand',
      context: {
        report: 'stock_on_hand',
        filters: { variantId, groupBy: 'variant' },
        rows: 0,
        partial: false,
      },
    });
  });
});

describe('saved reports', () => {
  it('keeps private reports private, shares with reports.manage, and lets managers edit shared ones', async () => {
    const viewer = await addMember(shop.shopId, 'viewer');
    const manager = await addMember(shop.shopId, 'manager');
    const mine = (
      await h.run(ops.saveReport, {
        name: 'My value by category',
        report: 'inventory_value',
        filters: { groupBy: 'category' },
      })
    ).savedReport;
    expect(mine).toMatchObject({ shared: false, mine: true, canEdit: true });
    const listed = async (caller: Caller) =>
      (await h.run(ops.listSavedReports, {}, { caller })).savedReports.map(
        (r: { id: string }) => r.id,
      );
    expect(await listed(viewer.caller)).not.toContain(mine.id);
    await expect(
      h.run(ops.runSavedReport, { savedReportId: mine.id }, { caller: viewer.caller }),
    ).rejects.toMatchObject({ status: 404 });

    // A viewer saves their own, but cannot share it or a cost report.
    await expect(
      h.run(
        ops.saveReport,
        { name: 'Shared', report: 'stock_on_hand', shared: true },
        { caller: viewer.caller },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      h.run(ops.saveReport, { name: 'Value', report: 'cost_of_goods' }, { caller: viewer.caller }),
    ).rejects.toMatchObject({ status: 403 });
    const theirs = (
      await h.run(
        ops.saveReport,
        { name: 'Low stock at the store', report: 'low_stock' },
        { caller: viewer.caller },
      )
    ).savedReport;
    expect(await listed(manager.caller)).not.toContain(theirs.id);

    const shared = (
      await h.run(ops.saveReport, {
        name: 'Stock by location',
        report: 'stock_on_hand',
        filters: { groupBy: 'location' },
        shared: true,
      })
    ).savedReport;
    expect(await listed(viewer.caller)).toContain(shared.id);
    const run = await h.run(
      ops.runSavedReport,
      { savedReportId: shared.id },
      { caller: viewer.caller },
    );
    expect(run).toMatchObject({ report: 'stock_on_hand', groupBy: 'location' });
    expect(run.savedReport).toMatchObject({ mine: false, canEdit: false });
    // Filters given at run time replace the saved ones for that run.
    const byVariant = await h.run(
      ops.runSavedReport,
      { savedReportId: shared.id, groupBy: 'variant' },
      { caller: viewer.caller },
    );
    expect(byVariant.groupBy).toBe('variant');
    await expect(
      h.run(
        ops.saveReport,
        { savedReportId: shared.id, name: 'Renamed', report: 'stock_on_hand', shared: true },
        { caller: viewer.caller },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      h.run(ops.deleteSavedReport, { savedReportId: shared.id }, { caller: viewer.caller }),
    ).rejects.toMatchObject({ status: 403 });
    const renamed = await h.run(
      ops.saveReport,
      {
        savedReportId: shared.id,
        expectedVersion: 1,
        name: 'Stock per location',
        report: 'stock_on_hand',
        filters: { groupBy: 'location' },
        shared: true,
      },
      { caller: manager.caller },
    );
    expect(renamed.savedReport).toMatchObject({ name: 'Stock per location', version: 2 });
    await expect(
      h.run(ops.saveReport, {
        savedReportId: shared.id,
        expectedVersion: 1,
        name: 'Stale',
        report: 'stock_on_hand',
        shared: true,
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await h.run(ops.deleteSavedReport, { savedReportId: shared.id }, { caller: manager.caller });
    expect(await listed(viewer.caller)).not.toContain(shared.id);
    await expect(
      h.run(ops.saveReport, {
        name: 'Bad group',
        report: 'shortages',
        filters: { groupBy: 'lot' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

/** R2 stand-in for export files. */
function memoryFiles(): FileAccess & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, body) {
      store.set(key, body);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

describe('CSV export', () => {
  it('writes every row with a totals line through the export job, and logs the run and the download', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '7',
      unitCost: '1.5',
    });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shelfB,
      quantity: '2',
      unitCost: '1.5',
    });
    const started = await h.run(ops.exportReport, {
      report: 'stock_on_hand',
      filters: { variantId, sort: 'location' },
    });
    expect(started.export).toMatchObject({ status: 'pending', report: 'stock_on_hand' });
    const exportId = started.export.exportId as string;
    const files = memoryFiles();
    const before = sink.events.length;
    expect(await runReportExportJob({ db, audit: sink, files }, shop.shopId, exportId)).toBe(
      'done',
    );
    const csv = [...files.store.values()][0]!;
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe(
      'SKU,Product,Location,Warehouse,Condition,Lot,Expires,On hand,In packs,Reserved,Available,Value (EUR)',
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain(',Main stock,Main stock,sellable,,,7,,0,7,10.5');
    expect(lines[3]).toBe('Total,,,,,,,9,,0,9,13.5');
    const completed = sink.events
      .slice(before)
      .find((e) => e.action === 'reports.export.completed');
    expect(completed).toMatchObject({ target_id: exportId, changes: { rows: 2 } });

    const got = await h.run(ops.getExport, { exportId });
    expect(got.export).toMatchObject({ status: 'completed', rowCount: 2 });
    const listed = await h.run(ops.listReportExports, {});
    expect(listed.exports[0]).toMatchObject({ exportId, title: 'Stock on hand' });
    // Report exports stay out of the catalog's Recent exports.
    const catalog = await h.run(ops.listExports, {});
    expect(catalog.exports.map((e: { exportId: string }) => e.exportId)).not.toContain(exportId);
    const download = await h.run(ops.downloadExport, { exportId });
    expect(download.fileName).toMatch(/^airstock-report-stock_on_hand-/);
    const logged = await ownerQuery(
      `select action from audit_events where shop_id = $1 and target_id = $2 order by occurred_at`,
      [shop.shopId, exportId],
    );
    expect(logged.map((e) => e.action)).toEqual(
      expect.arrayContaining(['reports.export.created', 'catalog.export.downloaded']),
    );
  });

  it('applies the exporter’s scope and cost permission, and fails the job for a bad sort', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: front, quantity: '1', unitCost: '9' });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '4',
      unitCost: '9',
    });
    const editor = await addMember(shop.shopId, 'catalog_editor', [storeWarehouse]);
    const files = memoryFiles();
    const started = await h.run(
      ops.exportReport,
      { report: 'stock_on_hand', filters: { variantId } },
      { caller: editor.caller },
    );
    await runReportExportJob({ db, audit: sink, files }, shop.shopId, started.export.exportId);
    const csv = [...files.store.values()][0]!;
    expect(csv).not.toContain('Value');
    expect(csv).toContain('Total (your locations only)');
    expect(csv).toContain('Store/Front');
    expect(csv).not.toContain('Main stock');
    await expect(
      h.run(ops.exportReport, { report: 'inventory_value' }, { caller: editor.caller }),
    ).rejects.toMatchObject({ status: 403 });

    const bad = await h.run(ops.exportReport, {
      report: 'stock_on_hand',
      filters: { sort: 'nope' },
    });
    await runReportExportJob({ db, audit: sink, files }, shop.shopId, bad.export.exportId);
    const failed = await h.run(ops.getExport, { exportId: bad.export.exportId });
    expect(failed.export).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Sort'),
    });
    const viewer = await addMember(shop.shopId, 'viewer');
    await expect(
      h.run(ops.exportReport, { report: 'stock_on_hand' }, { caller: viewer.caller }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('isolation between shops (A13)', () => {
  it('never shows another shop’s stock, saved reports, or exports', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '5' });
    const saved = (
      await h.run(ops.saveReport, { name: 'Private', report: 'stock_on_hand', shared: true })
    ).savedReport;
    const exported = await h.run(ops.exportReport, { report: 'shortages' });
    const other = await seedShop(db, sink, 'Other reports shop');
    const ho = harness(db, sink, other);
    for (const name of ['stock_on_hand', 'movements', 'inventory_value', 'expiring_lots']) {
      const res = await ho.run(ops.runStandardReport, { report: name, variantId });
      expect(res.rows).toEqual([]);
    }
    const all = await ho.run(ops.runStandardReport, {
      report: 'stock_on_hand',
      groupBy: 'variant',
    });
    expect(all.rows).toEqual([]);
    await expect(ho.run(ops.runSavedReport, { savedReportId: saved.id })).rejects.toMatchObject({
      status: 404,
    });
    expect((await ho.run(ops.listSavedReports, {})).savedReports).toEqual([]);
    await expect(
      ho.run(ops.getExport, { exportId: exported.export.exportId }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await runReportExportJob(
        { db, audit: sink, files: memoryFiles() },
        other.shopId,
        exported.export.exportId,
      ),
    ).toBe('missing');
    // Another shop's warehouse as a filter selects nothing.
    const res = await h.run(ops.runStandardReport, {
      report: 'stock_on_hand',
      warehouseId: other.warehouseId,
    });
    expect(res.rows).toEqual([]);
  });
});
