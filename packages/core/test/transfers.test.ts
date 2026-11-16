import { type Caller, ops, sweepShortages, uuidv7, WEBHOOK_EVENT_TYPES } from '@airstock/core';
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
import { reconcileAll } from './documents-helpers.ts';

// Milestone I2 transfers (plan D8, PRD 6.4): A06, A24, A25, the transfer half of A38, lots,
// packs, exceptions, moves within a warehouse, shortages filled by a transfer receipt, location
// scope (A42), and isolation between shops (A13).

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let store: string; // a second warehouse's shelf
let storeWarehouse: string;
let shelfB: string; // a second shelf in the first warehouse

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
  const wh = await h.run(ops.createWarehouse, { name: 'Store' });
  storeWarehouse = wh.warehouseId;
  store = await createLeafLocation(h, storeWarehouse, 'Front');
  shelfB = await createLeafLocation(h, shop.warehouseId, 'Shelf B');
});
afterAll(() => db.close());

async function stocked(quantity: string, locationId = shop.locationId): Promise<string> {
  const variantId = await createVariant(h);
  await h.run(ops.receiveStock, { variantId, locationId, quantity, unitCost: '4' });
  return variantId;
}

async function stock(variantId: string, caller?: Caller) {
  return h.run(ops.getAvailability, { variantId }, caller ? { caller } : {});
}

function at(
  view: {
    positions: Array<{ locationId: string; onHand: string; available: string; inTransit: boolean }>;
  },
  locationId: string,
) {
  const rows = view.positions.filter((p) => p.locationId === locationId && !p.inTransit);
  return {
    onHand: rows.reduce((s, p) => s + Number(p.onHand), 0),
    available: rows.reduce((s, p) => s + Number(p.available), 0),
  };
}

describe('dispatch and partial receipt (A06)', () => {
  it('dispatches ten and receives six: six at the destination, four in transit, none left at the source', async () => {
    const variantId = await stocked('10');
    const created = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: store,
      reference: `TR-${uuidv7().slice(-6)}`,
      lines: [{ variantId, quantity: '10' }],
      ready: true,
    });
    expect(created.transfer).toMatchObject({ status: 'ready', totals: { held: '10.000000' } });
    const transferId = created.transfer.transferId;
    const dispatched = await h.run(ops.dispatchTransfer, { transferId });
    expect(dispatched.transfer).toMatchObject({
      status: 'dispatched',
      totals: { dispatched: '10.000000', inTransit: '10.000000', held: '0.000000' },
    });
    const received = await h.run(ops.receiveTransfer, {
      transferId,
      items: [{ variantId, quantity: '6' }],
    });
    expect(received.transfer).toMatchObject({
      status: 'partially_received',
      totals: { received: '6.000000', inTransit: '4.000000' },
    });
    const view = await stock(variantId);
    expect(at(view, shop.locationId).onHand).toBe(0);
    expect(at(view, store).onHand).toBe(6);
    expect(view.totals).toMatchObject({
      inTransit: '4.000000',
      onHand: '6.000000',
      ownedTotal: '10.000000',
    });
    // Ownership is never doubled: the owned quantity behind the average did not change.
    const [cost] = await ownerQuery<{ quantity: string }>(
      'select quantity::text from variant_costs where variant_id = $1',
      [variantId],
    );
    expect(cost!.quantity).toBe('10.000000');
    await h.run(ops.receiveTransfer, { transferId });
    const done = await h.run(ops.getTransfer, { transferId });
    expect(done).toMatchObject({ status: 'received', totals: { inTransit: '0.000000' } });
    expect(done.closedAt).not.toBeNull();
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});

describe('transfer holds count against every other caller (A24)', () => {
  it('keeps held units from a new reservation until cancel releases them; dispatch consumes them', async () => {
    const variantId = await stocked('10');
    const created = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: store,
      lines: [{ variantId, quantity: '7' }],
    });
    const transferId = created.transfer.transferId;
    expect(created.transfer.status).toBe('draft');
    expect((await stock(variantId)).totals.available).toBe('10.000000');
    await h.run(ops.readyTransfer, { transferId });
    expect((await stock(variantId)).totals).toMatchObject({
      available: '3.000000',
      reserved: '7.000000',
    });
    // Another caller reserving through any pool sees only the three free units.
    await expect(h.run(ops.reserveStock, { variantId, quantity: '4' })).rejects.toMatchObject({
      code: 'insufficient_stock',
    });
    await expect(
      h.run(ops.reserveStock, { variantId, quantity: '4', locationId: shop.locationId }),
    ).rejects.toMatchObject({ code: 'insufficient_stock' });
    const order = await h.run(ops.reserveStock, { variantId, quantity: '3' });
    // The hold is changed only through its transfer.
    const [line] = created.transfer.lines;
    const hold = (await h.run(ops.getTransfer, { transferId })).lines[0].reservationId;
    expect(line.reservationId).toBeNull();
    await expect(h.run(ops.releaseReservation, { reservationId: hold })).rejects.toMatchObject({
      code: 'reservation_is_transfer',
    });
    await expect(h.run(ops.fulfillReservation, { reservationId: hold })).rejects.toMatchObject({
      code: 'reservation_is_transfer',
    });
    // Cancel two: they become available at once; dispatch the rest: on hand and held drop together.
    await h.run(ops.cancelTransfer, { transferId, items: [{ variantId, quantity: '2' }] });
    expect((await stock(variantId)).totals.available).toBe('2.000000');
    await h.run(ops.dispatchTransfer, { transferId });
    const view = await stock(variantId);
    expect(view.totals).toMatchObject({
      onHand: '5.000000',
      reserved: '3.000000',
      available: '2.000000',
      inTransit: '5.000000',
    });
    await h.run(ops.releaseReservation, { reservationId: order.reservationId });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('fails whole when the source cannot hold every line', async () => {
    const a = await stocked('5');
    const b = await stocked('1');
    await expect(
      h.run(ops.createTransfer, {
        fromLocationId: shop.locationId,
        toLocationId: store,
        lines: [
          { variantId: a, quantity: '5' },
          { variantId: b, quantity: '2' },
        ],
        ready: true,
      }),
    ).rejects.toMatchObject({ code: 'insufficient_stock' });
    expect((await stock(a)).totals.available).toBe('5.000000');
  });
});

describe('dispatch four, receive three, cancel the rest (A25)', () => {
  it('leaves six unheld at the source, one in transit, three received, and refuses to exceed the line', async () => {
    const variantId = await stocked('10');
    const { transfer } = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: store,
      lines: [{ variantId, quantity: '10' }],
      ready: true,
    });
    const transferId = transfer.transferId;
    await h.run(ops.dispatchTransfer, { transferId, items: [{ variantId, quantity: '4' }] });
    expect((await h.run(ops.getTransfer, { transferId })).status).toBe('partially_dispatched');
    await h.run(ops.receiveTransfer, { transferId, items: [{ variantId, quantity: '3' }] });
    await expect(
      h.run(ops.receiveTransfer, { transferId, items: [{ variantId, quantity: '2' }] }),
    ).rejects.toMatchObject({ code: 'quantity_exceeds_in_transit' });
    const cancelled = await h.run(ops.cancelTransfer, { transferId });
    expect(cancelled.transfer.lines[0]).toMatchObject({
      planned: '10.000000',
      cancelled: '6.000000',
      dispatched: '4.000000',
      received: '3.000000',
      held: '0.000000',
      inTransit: '1.000000',
    });
    expect(cancelled.transfer.status).toBe('partially_received');
    const view = await stock(variantId);
    expect(at(view, shop.locationId)).toEqual({ onHand: 6, available: 6 });
    expect(at(view, store).onHand).toBe(3);
    expect(view.totals.inTransit).toBe('1.000000');
    await expect(
      h.run(ops.dispatchTransfer, { transferId, items: [{ variantId, quantity: '1' }] }),
    ).rejects.toMatchObject({ code: 'quantity_exceeds_held' });
    await expect(h.run(ops.cancelTransfer, { transferId })).rejects.toMatchObject({
      code: 'nothing_to_cancel',
    });
    // The last unit arrives: the transfer is received, with the cancellation still visible.
    const last = await h.run(ops.receiveTransfer, { transferId });
    expect(last.transfer).toMatchObject({
      status: 'received',
      totals: { cancelled: '6.000000', received: '4.000000' },
    });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('cancels a draft without touching stock, and a ready transfer back to cancelled', async () => {
    const variantId = await stocked('3');
    const draft = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: store,
      lines: [{ variantId, quantity: '3' }],
    });
    const c1 = await h.run(ops.cancelTransfer, { transferId: draft.transfer.transferId });
    expect(c1).toMatchObject({ operationId: null, transfer: { status: 'cancelled' } });
    await expect(
      h.run(ops.readyTransfer, { transferId: draft.transfer.transferId }),
    ).rejects.toMatchObject({ code: 'transfer_not_draft' });
    const ready = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: store,
      lines: [{ variantId, quantity: '3' }],
      ready: true,
    });
    const c2 = await h.run(ops.cancelTransfer, { transferId: ready.transfer.transferId });
    expect(c2.transfer.status).toBe('cancelled');
    expect((await stock(variantId)).totals.available).toBe('3.000000');
    await expect(
      h.run(ops.dispatchTransfer, { transferId: ready.transfer.transferId }),
    ).rejects.toMatchObject({ code: 'transfer_closed' });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});

describe('serials, lots, and packs on transfers (A38 transfer half, G8)', () => {
  it('moves one serial through transit and its history shows each step', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'serial' });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '3',
      serials: ['T-1', 'T-2', 'T-3'],
    });
    const { transfer } = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: store,
      reference: 'TR-SERIAL',
      lines: [{ variantId, quantity: '2' }],
      ready: true,
    });
    // The picker scans T-3, which ready did not hold: it takes the place of a held serial.
    const holds = await h.run(ops.listReservations, {
      reservationId: transfer.lines[0].reservationId,
    });
    const heldSerials = holds.reservations[0].allocations.map((a: { serial: string }) => a.serial);
    const scanned = ['T-1', 'T-2', 'T-3'].find((s) => !heldSerials.includes(s))!;
    await expect(
      h.run(ops.dispatchTransfer, {
        transferId: transfer.transferId,
        items: [{ variantId, serials: ['T-404'] }],
      }),
    ).rejects.toMatchObject({ code: 'serial_not_available' });
    const dispatched = await h.run(ops.dispatchTransfer, {
      transferId: transfer.transferId,
      items: [{ variantId, serials: [scanned.toLowerCase()] }],
    });
    expect(dispatched.transfer.lines[0].inTransitUnits).toEqual([
      { lotCode: null, serial: scanned, quantity: '1.000000' },
    ]);
    const moving = await h.run(ops.serialHistory, { variantId, serial: scanned });
    expect(moving.status).toBe('in_transit');
    await h.run(ops.receiveTransfer, {
      transferId: transfer.transferId,
      items: [{ variantId, serials: [scanned] }],
    });
    const history = await h.run(ops.serialHistory, { variantId, serial: scanned });
    expect(history).toMatchObject({ status: 'in_stock', current: { locationId: store } });
    // Each step in order; within one operation, out of one position and into the next.
    expect(history.movements.map((m: { kind: string }) => m.kind)).toEqual([
      'receipt',
      'transfer_dispatch',
      'transfer_dispatch',
      'transfer_receipt',
      'transfer_receipt',
    ]);
    expect(
      history.movements
        .map((m: { kind: string; quantity: string }) => `${m.kind} ${m.quantity}`)
        .sort(),
    ).toEqual([
      'receipt 1.000000',
      'transfer_dispatch -1.000000',
      'transfer_dispatch 1.000000',
      'transfer_receipt -1.000000',
      'transfer_receipt 1.000000',
    ]);
    expect(history.movements[1].reference).toBe('TR-SERIAL');
    // The one still held stays held; a serial already in transit cannot be named twice.
    await expect(
      h.run(ops.dispatchTransfer, {
        transferId: transfer.transferId,
        items: [{ variantId, serials: [scanned] }],
      }),
    ).rejects.toMatchObject({ code: 'serial_not_available' });
    await h.run(ops.dispatchTransfer, { transferId: transfer.transferId });
    await h.run(ops.receiveTransfer, { transferId: transfer.transferId });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('keeps lots through transit, and records packs on the line and the entries', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'lot_expiry' });
    const packs = await h.run(ops.setPacks, {
      variantId,
      packsVersion: 0,
      packs: [{ name: 'Case', quantity: '6' }],
    });
    const caseId = packs.packaging.packs[0].id;
    for (const [code, expiresOn] of [
      ['LATE', '2031-01-31'],
      ['EARLY', '2030-01-31'],
    ] as const) {
      await h.run(ops.receiveStock, {
        variantId,
        locationId: shop.locationId,
        quantity: '6',
        lotCode: code,
        expiresOn,
      });
    }
    const { transfer } = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: store,
      lines: [{ variantId, quantity: '1', packId: caseId }],
      ready: true,
    });
    expect(transfer.lines[0]).toMatchObject({
      planned: '6.000000',
      entered: { packId: caseId, packName: 'Case', quantity: '1.000000', factor: '6.000000' },
    });
    const d = await h.run(ops.dispatchTransfer, {
      transferId: transfer.transferId,
      items: [{ variantId, quantity: '1', packId: caseId }],
    });
    // Earliest expiry first.
    expect(d.transfer.lines[0].inTransitUnits).toEqual([
      { lotCode: 'EARLY', serial: null, quantity: '6.000000' },
    ]);
    const entries = await ownerQuery<{
      delta: string;
      pack_id: string | null;
      entered: string | null;
      lot: string;
    }>(
      `select e.delta::text, e.pack_id, e.entered_quantity::text as entered, l.code as lot
       from inventory_entries e join lots l on l.id = e.lot_id
       where e.operation_id = $1 order by e.delta`,
      [d.operationId],
    );
    expect(entries).toEqual([
      { delta: '-6.000000', pack_id: caseId, entered: '1.000000', lot: 'EARLY' },
      { delta: '6.000000', pack_id: caseId, entered: '1.000000', lot: 'EARLY' },
    ]);
    await h.run(ops.receiveTransfer, { transferId: transfer.transferId });
    const lots = await h.run(ops.listLots, { variantId });
    const early = lots.lots.filter((l: { code: string }) => l.code === 'EARLY');
    expect(early.length).toBeGreaterThan(0);
    const view = await stock(variantId);
    expect(
      view.positions
        .filter((p: { locationId: string }) => p.locationId === store)
        .map((p: { lotCode: string; onHand: string }) => [p.lotCode, p.onHand]),
    ).toEqual([['EARLY', '6.000000']]);
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});

describe('exceptions', () => {
  it('reports missing units, resolves them as lost at the moving average, and closes', async () => {
    const variantId = await stocked('5');
    const { transfer } = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: store,
      lines: [{ variantId, quantity: '5' }],
      ready: true,
    });
    const transferId = transfer.transferId;
    await h.run(ops.dispatchTransfer, { transferId });
    await h.run(ops.receiveTransfer, { transferId, items: [{ variantId, quantity: '3' }] });
    const reported = await h.run(ops.reportTransferException, {
      transferId,
      note: 'Box arrived with 3 of 5.',
    });
    expect(reported.transfer).toMatchObject({
      status: 'exception',
      exception: { open: true, note: 'Box arrived with 3 of 5.' },
    });
    // One more arrives damaged but still exists: received into damaged condition.
    await h.run(ops.receiveTransfer, {
      transferId,
      items: [{ variantId, quantity: '1' }],
      condition: 'damaged',
    });
    const resolved = await h.run(ops.resolveTransferException, { transferId, resolution: 'lost' });
    expect(resolved).toMatchObject({
      costVisible: true,
      unitCosts: { [variantId]: '4.000000' },
      transfer: {
        status: 'received',
        exception: { open: false, note: null },
        totals: { received: '4.000000', resolved: '1.000000', inTransit: '0.000000' },
      },
    });
    const [op] = await ownerQuery<{ kind: string; reason: string }>(
      'select kind, reason from inventory_operations where id = $1',
      [resolved.operationId],
    );
    expect(op).toEqual({ kind: 'adjustment', reason: 'loss_or_theft' });
    const view = await stock(variantId);
    expect(view.totals).toMatchObject({ ownedTotal: '4.000000', damaged: '1.000000' });
    await expect(
      h.run(ops.resolveTransferException, { transferId, resolution: 'short' }),
    ).rejects.toMatchObject({ code: 'quantity_exceeds_in_transit' });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('writes off a serial lost in transit', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'serial' });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '1',
      serials: ['LOST-1'],
    });
    const { transfer } = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: store,
      lines: [{ variantId, quantity: '1', serials: ['LOST-1'] }],
      ready: true,
    });
    await h.run(ops.dispatchTransfer, { transferId: transfer.transferId });
    await h.run(ops.resolveTransferException, {
      transferId: transfer.transferId,
      resolution: 'lost',
      items: [{ variantId, serials: ['LOST-1'] }],
    });
    const history = await h.run(ops.serialHistory, { variantId, serial: 'LOST-1' });
    expect(history).toMatchObject({ status: 'written_off', current: null });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});

describe('a move within a warehouse (D8)', () => {
  it('holds, dispatches, and receives in one command, recorded as a received move', async () => {
    const variantId = await stocked('5');
    const moved = await h.run(ops.moveStock, {
      fromLocationId: shop.locationId,
      toLocationId: shelfB,
      lines: [{ variantId, quantity: '2' }],
    });
    expect(moved.transfer).toMatchObject({
      kind: 'move',
      status: 'received',
      totals: { dispatched: '2.000000', received: '2.000000', inTransit: '0.000000' },
    });
    const view = await stock(variantId);
    expect(at(view, shop.locationId).onHand).toBe(3);
    expect(at(view, shelfB).onHand).toBe(2);
    await expect(
      h.run(ops.moveStock, {
        fromLocationId: shop.locationId,
        toLocationId: store,
        lines: [{ variantId, quantity: '1' }],
      }),
    ).rejects.toMatchObject({ code: 'move_across_warehouses' });
    await expect(
      h.run(ops.moveStock, {
        fromLocationId: shop.locationId,
        toLocationId: shelfB,
        lines: [{ variantId, quantity: '4' }],
      }),
    ).rejects.toMatchObject({ code: 'insufficient_stock' });
    const moves = await h.run(ops.listTransfers, { status: 'all', kind: 'move', variantId });
    expect(moves.transfers).toHaveLength(1);
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('fills an open order shortage at the destination (D6)', async () => {
    const variantId = await stocked('4', shelfB);
    const [m] = await ownerQuery<{ id: string }>(
      'select id from memberships where shop_id = $1 and user_id = $2',
      [shop.shopId, shop.userId],
    );
    const connector: Caller = {
      kind: 'connector',
      id: uuidv7(),
      userId: null,
      boundShopId: shop.shopId,
      membership: {
        id: m!.id,
        role: 'inventory_operator',
        allLocations: true,
        locationScopeIds: [],
        permissions: new Set(['inventory.read', 'inventory.reserve']),
      },
      scopes: new Set(['inventory:read', 'inventory:write']),
      source: 'shopify',
    };
    // shelfB is in the default warehouse; the order may only use the store's location.
    const order = await h.run(
      ops.reserveStock,
      { variantId, quantity: '3', allowShortage: true, locationId: store },
      { caller: connector },
    );
    expect(order.shortage).toBe('3');
    const { transfer } = await h.run(ops.createTransfer, {
      fromLocationId: shelfB,
      toLocationId: store,
      lines: [{ variantId, quantity: '4' }],
      ready: true,
    });
    await h.run(ops.dispatchTransfer, { transferId: transfer.transferId });
    const received = await h.run(ops.receiveTransfer, { transferId: transfer.transferId });
    expect(received.shortagesFilled).toEqual([
      { reservationId: order.reservationId, quantity: '3' },
    ]);
    expect((await stock(variantId)).totals).toMatchObject({
      shortage: '0.000000',
      available: '1.000000',
    });
    await sweepShortages(db, 50, [shop.shopId]);
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});

describe('location scope (A42)', () => {
  it('lets a member scoped to the source dispatch but not receive, and the destination the reverse', async () => {
    const variantId = await stocked('4');
    const sender = await addMember(shop.shopId, 'inventory_operator', [shop.warehouseId]);
    const receiver = await addMember(shop.shopId, 'inventory_operator', [storeWarehouse]);
    const { transfer } = await h.run(
      ops.createTransfer,
      {
        fromLocationId: shop.locationId,
        toLocationId: store,
        lines: [{ variantId, quantity: '4' }],
        ready: true,
      },
      { caller: sender.caller },
    );
    const transferId = transfer.transferId;
    await expect(
      h.run(ops.dispatchTransfer, { transferId }, { caller: receiver.caller }),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
    await h.run(ops.dispatchTransfer, { transferId }, { caller: sender.caller });
    await expect(
      h.run(ops.receiveTransfer, { transferId }, { caller: sender.caller }),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
    await h.run(ops.receiveTransfer, { transferId }, { caller: receiver.caller });
    // Both see it (it touches each one's warehouse); someone scoped elsewhere does not.
    const other = await h.run(ops.createWarehouse, { name: `Elsewhere ${uuidv7().slice(-4)}` });
    const outsider = await addMember(shop.shopId, 'inventory_operator', [other.warehouseId]);
    await expect(
      h.run(ops.getTransfer, { transferId }, { caller: outsider.caller }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const listed = await h.run(ops.listTransfers, { status: 'all' }, { caller: outsider.caller });
    expect(listed.transfers).toEqual([]);
    await expect(
      h.run(ops.getTransfer, { transferId }, { caller: receiver.caller }),
    ).resolves.toMatchObject({ status: 'received' });
    // A viewer cannot transfer at all.
    const viewer = await addMember(shop.shopId, 'viewer');
    await expect(
      h.run(
        ops.createTransfer,
        {
          fromLocationId: shop.locationId,
          toLocationId: store,
          lines: [{ variantId, quantity: '1' }],
        },
        { caller: viewer.caller },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('isolation between shops (A13)', () => {
  it('never reaches another shop’s transfer, location, or variant', async () => {
    const other = await seedShop(db, sink, 'Other transfers shop');
    const ho = harness(db, sink, other);
    const theirs = await createVariant(ho);
    await ho.run(ops.receiveStock, {
      variantId: theirs,
      locationId: other.locationId,
      quantity: '2',
    });
    const otherShelf = await createLeafLocation(ho, other.warehouseId, 'Theirs');
    const { transfer } = await ho.run(ops.moveStock, {
      fromLocationId: other.locationId,
      toLocationId: otherShelf,
      lines: [{ variantId: theirs, quantity: '1' }],
    });
    await expect(h.run(ops.getTransfer, { transferId: transfer.transferId })).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    );
    await expect(
      h.run(ops.cancelTransfer, { transferId: transfer.transferId }),
    ).rejects.toMatchObject({ status: 404 });
    const mine = await stocked('1');
    await expect(
      h.run(ops.createTransfer, {
        fromLocationId: shop.locationId,
        toLocationId: other.locationId,
        lines: [{ variantId: mine, quantity: '1' }],
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      h.run(ops.createTransfer, {
        fromLocationId: shop.locationId,
        toLocationId: store,
        lines: [{ variantId: theirs, quantity: '1' }],
      }),
    ).rejects.toMatchObject({ status: 404 });
    const [count] = await ownerQuery<{ n: string }>(
      'select count(*)::text as n from transfers where shop_id = $1',
      [other.shopId],
    );
    expect(count!.n).toBe('1');
  });
});

describe('webhooks (D14)', () => {
  it('emits transfer.status_changed with each status change, in the same transaction, for a subscribed shop', async () => {
    const own = await seedShop(db, sink, 'Transfer webhooks shop');
    const ho = harness(db, sink, own);
    const shelf = await createLeafLocation(ho, own.warehouseId, 'W2');
    const wh = await ho.run(ops.createWarehouse, { name: 'Far' });
    const far = await createLeafLocation(ho, wh.warehouseId, 'Far shelf');
    await ownerQuery(
      `insert into webhook_subscriptions (shop_id, id, name, url, event_types, secret_key_id,
         secret_ciphertext, secret_hint)
       values ($1, $2, 'n8n', 'https://hooks.example.test/x', array['transfer.status_changed'],
         'k1', 'x', 'abcd')`,
      [own.shopId, uuidv7()],
    );
    const variantId = await createVariant(ho);
    await ho.run(ops.receiveStock, { variantId, locationId: own.locationId, quantity: '5' });
    const { transfer } = await ho.run(ops.createTransfer, {
      fromLocationId: own.locationId,
      toLocationId: far,
      lines: [{ variantId, quantity: '4' }],
    });
    await ho.run(ops.readyTransfer, { transferId: transfer.transferId });
    await ho.run(ops.dispatchTransfer, {
      transferId: transfer.transferId,
      items: [{ variantId, quantity: '1' }],
    });
    // A second partial dispatch keeps the status: no event.
    await ho.run(ops.dispatchTransfer, {
      transferId: transfer.transferId,
      items: [{ variantId, quantity: '1' }],
    });
    await ho.run(ops.moveStock, {
      fromLocationId: own.locationId,
      toLocationId: shelf,
      lines: [{ variantId, quantity: '1' }],
    });
    // A failed command writes nothing.
    await expect(
      ho.run(ops.receiveTransfer, {
        transferId: transfer.transferId,
        items: [{ variantId, quantity: '9' }],
      }),
    ).rejects.toMatchObject({ code: 'quantity_exceeds_in_transit' });
    const rows = await ownerQuery<{
      payload: { type: string; input: { transferId: string; from: string | null; to: string } };
    }>(
      `select payload from outbox_events where shop_id = $1 and topic = 'webhook.event'
       order by created_at, id`,
      [own.shopId],
    );
    expect(rows.map((r) => [r.payload.type, r.payload.input.from, r.payload.input.to])).toEqual([
      ['transfer.status_changed', null, 'draft'],
      ['transfer.status_changed', 'draft', 'ready'],
      ['transfer.status_changed', 'ready', 'partially_dispatched'],
      ['transfer.status_changed', null, 'received'],
    ]);
    // The snapshot built at send time matches the registered schema.
    const type = WEBHOOK_EVENT_TYPES.find((t) => t.id === 'transfer.status_changed')!;
    const built = await db.transaction({ shopId: own.shopId, userId: null }, (tx) =>
      type.build(tx, rows[2]!.payload.input),
    );
    expect(type.data.safeParse(built?.data).success).toBe(true);
    expect(built).toMatchObject({
      data: { transfer: { status: 'partially_dispatched', totals: { inTransit: '2.000000' } } },
      locationIds: [own.locationId, far],
    });
  });
});
