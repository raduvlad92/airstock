import { ops, uuidv7 } from '@airstock/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  addMember,
  appDatabase,
  connectClient,
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

// Regression tests for the inventory review fixes (review-findings.test.ts holds one test per
// confirmed finding) and for the review's "suspected, not proven" items that turned out real.
// Tests use this file's own shops and never drain the shared outbox.

const db = appDatabase({}, 12);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let store: string; // a shelf in a second warehouse

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Review fixes');
  h = harness(db, sink, shop);
  const wh = await h.run(ops.createWarehouse, { name: 'Store' });
  store = await createLeafLocation(h, wh.warehouseId, 'Front');
});
afterAll(() => db.close());

/** Runs a command and returns 'succeeded' or the error code. */
async function outcomeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'succeeded',
    (e: { code?: string }) => e.code ?? String(e),
  );
}

/** An owner-role connection outside the app, for holding locks like a concurrent command. */
async function rawClient(): Promise<pg.Client> {
  const client = await connectClient(inject('databases').ownerUrl);
  return client;
}

/** Waits until some backend is blocked on a lock while running SQL that matches `like`. */
async function waitForLockWait(like: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const rows = await ownerQuery(
      `select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like $1`,
      [like],
    );
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no backend waited on a lock for ${like}`);
}

/** A position inserted outside the app (on hand without history), as an uncommitted receipt. */
async function insertPosition(
  client: pg.Client,
  shopId: string,
  variantId: string,
  locationId: string,
  onHand: string,
): Promise<void> {
  await client.query(
    `insert into inventory_positions (shop_id, id, variant_id, location_id, condition, on_hand,
       received_at)
     values ($1, $2, $3, $4, 'sellable', $5::numeric, now())`,
    [shopId, uuidv7(), variantId, locationId, onHand],
  );
}

describe('one of a kind (finding 4)', () => {
  it('refuses to reverse a removal once the item was bought back', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, oneOfAKind: true });
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '1' });
    const removed = await h.run(ops.adjustStock, {
      locationId: shop.locationId,
      adjustmentReason: 'damage',
      adjustments: [{ variantId, direction: 'remove', quantity: '1' }],
    });
    await h.run(ops.receiveStock, { variantId, locationId: store, quantity: '1' });
    const reversal = await outcomeOf(
      h.run(ops.reverseOperation, { operationId: removed.operationId }),
    );
    const view = await h.run(ops.getAvailability, { variantId });
    expect({ reversal, owned: view.totals.ownedTotal }).toEqual({
      reversal: 'one_of_a_kind',
      owned: '1.000000',
    });
  });

  it('lets a count move the item to another shelf', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, oneOfAKind: true });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '1',
      unitCost: '80',
    });
    await h.run(ops.quickCount, {
      locationId: shop.locationId,
      counts: [
        { variantId, counted: '0' },
        { variantId, locationId: store, counted: '1' },
      ],
    });
    const view = await h.run(ops.getAvailability, { variantId });
    expect({ owned: view.totals.ownedTotal, average: view.cost.averageCost }).toEqual({
      owned: '1.000000',
      average: '80.000000',
    });
  });
});

describe('moving average (finding 10)', () => {
  it('keeps the average when a count that moved every unit is reversed', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, defaultCost: '1' });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '4',
      unitCost: '7',
    });
    const counted = await h.run(ops.quickCount, {
      locationId: shop.locationId,
      counts: [
        { variantId, counted: '0' },
        { variantId, locationId: store, counted: '4' },
      ],
    });
    await h.run(ops.reverseOperation, { operationId: counted.operationId });
    const view = await h.run(ops.getAvailability, { variantId });
    expect({ owned: view.totals.ownedTotal, average: view.cost.averageCost }).toEqual({
      owned: '4.000000',
      average: '7.000000',
    });
    expect(await reconcile(shop.shopId)).toEqual([]);
  });
});

describe('uninspected return units (finding 9)', () => {
  async function returned(quantity: string) {
    const orderRef = `ORD-${uuidv7().slice(-6)}`;
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '5' });
    const r = await h.run(ops.reserveStock, { variantId, quantity, externalRef: orderRef });
    await h.run(ops.fulfillReservation, { reservationId: r.reservationId });
    const created = await h.run(ops.createReturn, {
      lines: [{ variantId, quantity }],
      orderRef,
      reason: 'Changed mind',
    });
    await h.run(ops.authorizeReturn, { returnId: created.return.returnId });
    await h.run(ops.receiveReturn, { returnId: created.return.returnId, locationId: store });
    return { variantId, returnId: created.return.returnId as string };
  }

  it('refuses adjustments and counts that take them out of quarantine', async () => {
    const { variantId } = await returned('2');
    const removal = await outcomeOf(
      h.run(ops.adjustStock, {
        locationId: store,
        condition: 'quarantine',
        adjustmentReason: 'write_off',
        adjustments: [{ variantId, direction: 'remove', quantity: '1' }],
      }),
    );
    const count = await outcomeOf(
      h.run(ops.quickCount, {
        locationId: store,
        counts: [{ variantId, condition: 'quarantine', counted: '0' }],
      }),
    );
    expect({ removal, count }).toEqual({
      removal: 'return_units_uninspected',
      count: 'return_units_uninspected',
    });
  });

  it('still moves quarantined units beyond what returns hold, and inspection still works', async () => {
    const { variantId, returnId } = await returned('2');
    await h.run(ops.receiveStock, {
      variantId,
      locationId: store,
      quantity: '1',
      condition: 'quarantine',
    });
    await h.run(ops.changeCondition, {
      locationId: store,
      fromCondition: 'quarantine',
      toCondition: 'sellable',
      items: [{ variantId, quantity: '1' }],
    });
    const twoMore = await outcomeOf(
      h.run(ops.changeCondition, {
        locationId: store,
        fromCondition: 'quarantine',
        toCondition: 'sellable',
        items: [{ variantId, quantity: '1' }],
      }),
    );
    expect(twoMore).toBe('return_units_uninspected');
    const inspected = await h.run(ops.inspectReturn, {
      returnId,
      inspections: [{ variantId, disposition: 'sellable' }],
    });
    expect(inspected.return.status).toBe('completed');
    expect(await reconcile(shop.shopId)).toEqual([]);
  });
});

describe('stock check repairs (findings 5 and 19)', () => {
  it('offers no automatic repair for a transfer problem', async () => {
    const own = await seedShop(db, sink, 'Review fixes recon');
    const oh = harness(db, sink, own);
    const wh = await oh.run(ops.createWarehouse, { name: 'Other' });
    const to = await createLeafLocation(oh, wh.warehouseId, 'Bay');
    const variantId = await createVariant(oh);
    await oh.run(ops.receiveStock, { variantId, locationId: own.locationId, quantity: '2' });
    const { transfer } = await oh.run(ops.createTransfer, {
      fromLocationId: own.locationId,
      toLocationId: to,
      lines: [{ variantId, quantity: '2' }],
      ready: true,
    });
    await oh.run(ops.dispatchTransfer, { transferId: transfer.transferId });
    const [line] = await ownerQuery<{ id: string }>(
      'update transfer_lines set received = 1 where shop_id = $1 and transfer_id = $2 returning id',
      [own.shopId, transfer.transferId],
    );
    const check = await oh.run(ops.getStockCheck, {});
    expect(check.current.problems).toEqual([
      expect.objectContaining({
        problem: 'transfer_in_transit_mismatch',
        targetType: 'transfer_line',
        targetId: line!.id,
        variantId,
        repairable: false,
      }),
    ]);
    const preview = await oh.run(ops.previewStockRepair, {
      problem: 'transfer_in_transit_mismatch',
      targetId: line!.id,
    });
    expect(preview).toMatchObject({ reported: true, repair: null });
    expect(preview.guidance).toContain('by hand');
    const repair = await outcomeOf(
      oh.run(ops.repairStockProblem, {
        problem: 'transfer_in_transit_mismatch',
        targetId: line!.id,
        expected: '1',
        actual: '2',
        reason: 'test',
        confirm: true,
      }),
    );
    expect(repair).toBe('repair_not_available');
  });
});

describe('suspected: new destination positions are created in one order', () => {
  it('does not deadlock two receipts creating the same new positions', async () => {
    const own = await seedShop(db, sink, 'Review fixes positions');
    const oh = harness(db, sink, own);
    const wh = await oh.run(ops.createWarehouse, { name: 'Dest' });
    const dest = await createLeafLocation(oh, wh.warehouseId, 'Bay');
    const low = await createVariant(oh);
    const high = await createVariant(oh);
    expect(low < high).toBe(true);
    for (const variantId of [low, high]) {
      await oh.run(ops.receiveStock, { variantId, locationId: own.locationId, quantity: '2' });
    }
    // Lines in descending order, so the receipt's moves list the high variant first.
    const { transfer } = await oh.run(ops.createTransfer, {
      fromLocationId: own.locationId,
      toLocationId: dest,
      lines: [
        { variantId: high, quantity: '2' },
        { variantId: low, quantity: '2' },
      ],
      ready: true,
    });
    await oh.run(ops.dispatchTransfer, { transferId: transfer.transferId });
    // Another command creating the same two positions, in identity order (low first).
    const other = await rawClient();
    try {
      await other.query('begin');
      await other.query(`set local deadlock_timeout = '100ms'`);
      await insertPosition(other, own.shopId, low, dest, '0');
      const receipt = outcomeOf(oh.run(ops.receiveTransfer, { transferId: transfer.transferId }));
      await waitForLockWait('%inventory_positions_identity%');
      const second = await insertPosition(other, own.shopId, high, dest, '0').then(
        () => 'ok',
        (e: { code?: string }) => e.code ?? String(e),
      );
      await other.query(second === 'ok' ? 'commit' : 'rollback');
      expect({ other: second, receipt: await receipt }).toEqual({
        other: 'ok',
        receipt: 'succeeded',
      });
    } finally {
      await other.end();
    }
    expect(await reconcile(own.shopId)).toEqual([]);
  });
});

describe('suspected: a count posted while a receipt creates the counted position', () => {
  it('retries instead of adding the count to the units that just arrived', async () => {
    const own = await seedShop(db, sink, 'Review fixes count race');
    const oh = harness(db, sink, own);
    const variantId = await createVariant(oh);
    const shelf = await createLeafLocation(oh, own.warehouseId, 'Shelf');
    const receipt = await rawClient();
    let outcome: string;
    try {
      await receipt.query('begin');
      await insertPosition(receipt, own.shopId, variantId, shelf, '3');
      const count = outcomeOf(
        oh.run(ops.quickCount, { locationId: shelf, counts: [{ variantId, counted: '5' }] }),
      );
      await waitForLockWait('%inventory_positions_identity%');
      await receipt.query('commit');
      outcome = await count;
    } finally {
      await receipt.end();
    }
    const [pos] = await ownerQuery<{ on_hand: string }>(
      'select on_hand::text from inventory_positions where shop_id = $1 and variant_id = $2',
      [own.shopId, variantId],
    );
    expect({ outcome, onHand: pos!.on_hand }).toEqual({
      outcome: 'retry_conflict',
      onHand: '3.000000',
    });
    // The retry sets the shelf to the number counted.
    await oh.run(ops.quickCount, { locationId: shelf, counts: [{ variantId, counted: '5' }] });
    const view = await oh.run(ops.getAvailability, { variantId });
    expect(view.totals.onHand).toBe('5.000000');
  });
});

describe('suspected: transfer receipts', () => {
  async function lotTransfer() {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'lot' });
    const lots = [`K${uuidv7().slice(-4)}`, `L${uuidv7().slice(-4)}`];
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '2',
      lotCode: lots[0],
    });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '3',
      lotCode: lots[1],
    });
    const { transfer } = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: store,
      lines: [{ variantId, quantity: '5' }],
      ready: true,
    });
    return { variantId, lots: lots as [string, string], transferId: transfer.transferId as string };
  }

  it('dispatches and receives a scanned lot without a quantity', async () => {
    const { variantId, lots, transferId } = await lotTransfer();
    const dispatched = await h.run(ops.dispatchTransfer, {
      transferId,
      items: [{ variantId, lotCode: lots[1] }],
    });
    expect(dispatched.transfer.totals).toMatchObject({ inTransit: '3.000000' });
    await h.run(ops.dispatchTransfer, { transferId });
    const received = await h.run(ops.receiveTransfer, {
      transferId,
      items: [{ variantId, lotCode: lots[0] }],
    });
    expect(received.transfer.totals).toMatchObject({
      received: '2.000000',
      inTransit: '3.000000',
    });
    await h.run(ops.receiveTransfer, { transferId });
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('refuses to make units sellable that were sent in another condition', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '2',
      condition: 'quarantine',
    });
    const { transfer } = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: store,
      lines: [{ variantId, quantity: '2', condition: 'quarantine' }],
      ready: true,
    });
    await h.run(ops.dispatchTransfer, { transferId: transfer.transferId });
    const sellable = await outcomeOf(
      h.run(ops.receiveTransfer, { transferId: transfer.transferId, condition: 'sellable' }),
    );
    expect(sellable).toBe('condition_change_required');
    await h.run(ops.receiveTransfer, { transferId: transfer.transferId, condition: 'damaged' });
    const view = await h.run(ops.getAvailability, { variantId });
    expect(Number(view.totals.available)).toBe(0);
  });
});

describe('suspected: transfer exceptions and archives', () => {
  it('hides an exception report’s attempt from members limited to other locations', async () => {
    const own = await seedShop(db, sink, 'Review fixes exception scope');
    const oh = harness(db, sink, own);
    const wh = await oh.run(ops.createWarehouse, { name: 'Dest' });
    const dest = await createLeafLocation(oh, wh.warehouseId, 'Bay');
    const elsewhere = await oh.run(ops.createWarehouse, { name: 'Elsewhere' });
    const far = await createLeafLocation(oh, elsewhere.warehouseId, 'Far');
    const variantId = await createVariant(oh);
    await oh.run(ops.receiveStock, { variantId, locationId: own.locationId, quantity: '2' });
    const { transfer } = await oh.run(ops.createTransfer, {
      fromLocationId: own.locationId,
      toLocationId: dest,
      lines: [{ variantId, quantity: '2' }],
      ready: true,
    });
    await oh.run(ops.dispatchTransfer, { transferId: transfer.transferId });
    await oh.run(ops.reportTransferException, {
      transferId: transfer.transferId,
      note: 'Box crushed.',
    });
    await oh.run(ops.resolveTransferException, {
      transferId: transfer.transferId,
      resolution: 'damaged',
    });
    // The attempts reach the database through the audit queue.
    await sink.drain(db);
    const scoped = await addMember(own.shopId, 'viewer', [far]);
    for (const action of [
      'inventory.transfer.exception_reported',
      'inventory.transfer.exception_resolved',
    ]) {
      const page = await oh.run(
        ops.listActivity,
        { action, limit: 100 },
        { caller: scoped.caller },
      );
      expect({ action, events: page.events.length }).toEqual({ action, events: 0 });
    }
    const inScope = await addMember(own.shopId, 'viewer', [dest]);
    const visible = await oh.run(
      ops.listActivity,
      { action: 'inventory.transfer.exception_reported', phase: 'outcome', limit: 100 },
      { caller: inScope.caller },
    );
    expect(visible.events.length).toBe(1);
  });

  it('refuses to archive a destination while units are on their way to it', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '2' });
    const wh = await h.run(ops.createWarehouse, { name: `Closing ${uuidv7().slice(-4)}` });
    const dest = await createLeafLocation(h, wh.warehouseId, 'Only shelf');
    const { transfer } = await h.run(ops.createTransfer, {
      fromLocationId: shop.locationId,
      toLocationId: dest,
      lines: [{ variantId, quantity: '2' }],
      ready: true,
    });
    await h.run(ops.dispatchTransfer, { transferId: transfer.transferId });
    const outcomes = [
      await outcomeOf(h.run(ops.archiveLocation, { locationId: dest })),
      await outcomeOf(h.run(ops.archiveWarehouse, { warehouseId: wh.warehouseId })),
    ];
    expect(outcomes).toEqual(['transfers_inbound', 'transfers_inbound']);
    const received = await h.run(ops.receiveTransfer, { transferId: transfer.transferId });
    expect(received.transfer.status).toBe('received');
  });
});

describe('suspected: unmatched return serials', () => {
  it('keeps a flagged serial out of sellable stock until the exception is cleared', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'serial' });
    const created = await h.run(ops.createReturn, { lines: [{ variantId, quantity: '1' }] });
    const returnId = created.return.returnId as string;
    await h.run(ops.authorizeReturn, { returnId });
    const stranger = `RS-${uuidv7().slice(-6)}`;
    const received = await h.run(ops.receiveReturn, {
      returnId,
      locationId: store,
      items: [{ variantId, serials: [stranger] }],
    });
    expect(received.return.status).toBe('exception');
    const early = await outcomeOf(
      h.run(ops.inspectReturn, {
        returnId,
        inspections: [{ variantId, disposition: 'sellable', serials: [stranger] }],
      }),
    );
    expect(early).toBe('exception_open');
    await h.run(ops.setReturnException, {
      returnId,
      note: 'Checked: bought from us at a fair, ours.',
      open: false,
    });
    const inspected = await h.run(ops.inspectReturn, {
      returnId,
      inspections: [{ variantId, disposition: 'sellable', serials: [stranger] }],
    });
    expect(inspected.return.status).toBe('completed');
  });
});

describe('suspected: reallocating an allocation emptied meanwhile', () => {
  it('refuses instead of recording a move of nothing', async () => {
    const own = await seedShop(db, sink, 'Review fixes reallocate');
    const oh = harness(db, sink, own);
    const variantId = await createVariant(oh);
    const other = await createLeafLocation(oh, own.warehouseId, 'Other');
    await oh.run(ops.receiveStock, { variantId, locationId: own.locationId, quantity: '2' });
    await oh.run(ops.receiveStock, { variantId, locationId: other, quantity: '2' });
    const r = await oh.run(ops.reserveStock, { variantId, quantity: '1' });
    const allocationId = r.allocations[0].allocationId as string;
    const positionId = r.allocations[0].positionId as string;
    // A concurrent command holds the position and empties the allocation (as a release would).
    const release = await rawClient();
    let outcome: string;
    try {
      await release.query('begin');
      await release.query('select id from inventory_positions where id = $1 for update', [
        positionId,
      ]);
      const reallocation = outcomeOf(
        oh.run(ops.reallocateReservation, {
          reservationId: r.reservationId,
          allocationId,
          locationId: other,
        }),
      );
      await waitForLockWait('%for update%');
      await release.query(
        'update reservation_allocations set released = released + 1 where id = $1',
        [allocationId],
      );
      await release.query(
        'update inventory_positions set allocated = allocated - 1 where id = $1',
        [positionId],
      );
      await release.query('commit');
      outcome = await reallocation;
    } finally {
      await release.end();
    }
    const [moved] = await ownerQuery<{ moved: string }>(
      'select moved::text from reservation_allocations where id = $1',
      [allocationId],
    );
    expect({ outcome, moved: moved!.moved }).toEqual({
      outcome: 'nothing_allocated',
      moved: '0.000000',
    });
  });
});
