import { ops, uuidv7 } from '@airstock/core';
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

// Milestone I2 counts and adjustments (plan D10, PRD 6.6, G5): quick counts, sessions (blind,
// review after a movement), counts below reserved stock, adjustments with reasons, condition
// changes, reversals, lots, serials, packs, location scope (A42), and shop isolation (A13).

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let shelfB: string;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
  shelfB = await createLeafLocation(h, shop.warehouseId, 'Counts B2');
});
afterAll(() => db.close());

async function stocked(quantity: string, locationId = shelfB, cost = '5'): Promise<string> {
  const variantId = await createVariant(h);
  await h.run(ops.receiveStock, { variantId, locationId, quantity, unitCost: cost });
  return variantId;
}

async function stock(variantId: string) {
  return (await h.run(ops.getAvailability, { variantId })).totals;
}

describe('quick counts (a quantity typed for a location; "I counted shelf B2")', () => {
  it('sets each counted item and posts the differences as count corrections', async () => {
    const x = await stocked('6');
    const y = await stocked('2');
    const res = await h.run(ops.quickCount, {
      locationId: shelfB,
      counts: [
        { variantId: x, counted: '4' },
        { variantId: y, counted: '0' },
      ],
    });
    expect(
      res.changes.map((c: { variantId: string; delta: string }) => [c.variantId, c.delta]).sort(),
    ).toEqual(
      [
        [x, '-2'],
        [y, '-2'],
      ].sort(),
    );
    expect((await stock(x)).onHand).toBe('4.000000');
    expect((await stock(y)).onHand).toBe('0.000000');
    const [op] = await ownerQuery<{ kind: string; reason: string; count_session_id: string }>(
      'select kind, reason, count_session_id from inventory_operations where id = $1',
      [res.operationId],
    );
    expect(op).toMatchObject({
      kind: 'count',
      reason: 'count_correction',
      count_session_id: res.sessionId,
    });
    // Counting what is there changes nothing; counting more adds found units at the average.
    const same = await h.run(ops.quickCount, {
      locationId: shelfB,
      counts: [{ variantId: x, counted: '4' }],
    });
    expect(same.changes).toEqual([]);
    const more = await h.run(ops.quickCount, {
      locationId: shelfB,
      counts: [{ variantId: x, counted: '5' }],
    });
    expect(more).toMatchObject({ changes: [{ delta: '1' }], unitCosts: { [x]: '5.000000' } });
    const session = await h.run(ops.getCount, { sessionId: more.sessionId });
    expect(session).toMatchObject({
      status: 'submitted',
      quick: true,
      lines: [
        { expected: '4.000000', counted: '5.000000', status: 'posted', postedDelta: '1.000000' },
      ],
    });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('counts in packs, by lot, and by serial', async () => {
    const boxed = await createVariant(h);
    const packs = await h.run(ops.setPacks, {
      variantId: boxed,
      packsVersion: 0,
      packs: [{ name: 'Case', quantity: '12' }],
    });
    const caseId = packs.packaging.packs[0].id;
    await h.run(ops.receiveStock, { variantId: boxed, locationId: shelfB, quantity: '30' });
    const packed = await h.run(ops.quickCount, {
      locationId: shelfB,
      counts: [{ variantId: boxed, counted: '2', packId: caseId }],
    });
    expect(packed.changes[0].delta).toBe('-6');
    const [line] = await ownerQuery<{ entered_quantity: string; conversion_factor: string }>(
      'select entered_quantity::text, conversion_factor::text from count_lines where session_id = $1',
      [packed.sessionId],
    );
    expect(line).toEqual({ entered_quantity: '2.000000', conversion_factor: '12.000000' });

    const lotted = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId: lotted, trackingMode: 'lot' });
    for (const code of ['L1', 'L2']) {
      await h.run(ops.receiveStock, {
        variantId: lotted,
        locationId: shelfB,
        quantity: '3',
        lotCode: code,
      });
    }
    await expect(
      h.run(ops.quickCount, { locationId: shelfB, counts: [{ variantId: lotted, counted: '2' }] }),
    ).rejects.toMatchObject({ code: 'lot_required' });
    await h.run(ops.quickCount, {
      locationId: shelfB,
      counts: [{ variantId: lotted, counted: '1', lotCode: 'L2' }],
    });
    expect((await stock(lotted)).onHand).toBe('4.000000');

    const serial = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId: serial, trackingMode: 'serial' });
    await h.run(ops.receiveStock, {
      variantId: serial,
      locationId: shelfB,
      quantity: '3',
      serials: ['C-1', 'C-2', 'C-3'],
    });
    // C-2 is missing, C-9 turns up.
    const res = await h.run(ops.quickCount, {
      locationId: shelfB,
      counts: [{ variantId: serial, serials: ['C-1', 'c-3', 'C-9'] }],
    });
    expect(res.changes).toHaveLength(2);
    expect((await h.run(ops.serialHistory, { variantId: serial, serial: 'C-2' })).status).toBe(
      'written_off',
    );
    expect((await h.run(ops.serialHistory, { variantId: serial, serial: 'C-9' })).status).toBe(
      'in_stock',
    );
    expect((await stock(serial)).onHand).toBe('3.000000');
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});

describe('a count below reserved stock needs an explicit choice (G5)', () => {
  it('refuses to drop below reserved, then releases or reallocates exactly as chosen', async () => {
    const variantId = await stocked('5');
    const other = await createLeafLocation(h, shop.warehouseId, `Spare ${uuidv7().slice(-4)}`);
    await h.run(ops.receiveStock, { variantId, locationId: other, quantity: '2', unitCost: '5' });
    const a = await h.run(ops.reserveStock, {
      variantId,
      quantity: '2',
      locationId: shelfB,
      externalRef: 'A',
    });
    // B may come from any location; it sits on shelf B now (oldest stock first).
    const b = await h.run(ops.reserveStock, { variantId, quantity: '2', externalRef: 'B' });
    expect(b.allocations.map((x: { locationId: string }) => x.locationId)).toEqual([shelfB]);
    // Only 1 is on the shelf, 4 reserved there: 3 must be resolved.
    const refused = await h
      .run(ops.quickCount, { locationId: shelfB, counts: [{ variantId, counted: '1' }] })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({
      code: 'below_reserved',
      extra: { positions: [{ toResolve: '3', reserved: '4.000000' }] },
    });
    expect((await stock(variantId)).onHand).toBe('7.000000');
    // Reservations are never silently released.
    const allocA = a.allocations[0].allocationId;
    const allocB = b.allocations[0].allocationId;
    await expect(
      h.run(ops.quickCount, {
        locationId: shelfB,
        counts: [{ variantId, counted: '1' }],
        reservationChoices: [{ allocationId: allocA, action: 'release' }],
      }),
    ).rejects.toMatchObject({ code: 'below_reserved' });
    const res = await h.run(ops.quickCount, {
      locationId: shelfB,
      counts: [{ variantId, counted: '1' }],
      reservationChoices: [
        { allocationId: allocA, action: 'release', quantity: '1' },
        { allocationId: allocB, action: 'reallocate' },
      ],
    });
    expect(res.released).toEqual([
      { allocationId: allocA, reservationId: a.reservationId, quantity: '1' },
    ]);
    expect(res.reallocated[0]).toMatchObject({ allocationId: allocB, quantity: '2' });
    const view = await h.run(ops.getAvailability, { variantId });
    expect(view.totals).toMatchObject({
      onHand: '3.000000',
      reserved: '3.000000',
      available: '0.000000',
    });
    const listed = await h.run(ops.listReservations, { reservationId: b.reservationId });
    expect(
      listed.reservations[0].allocations
        .filter((x: { outstanding: string }) => Number(x.outstanding) > 0)
        .map((x: { locationId: string }) => x.locationId),
    ).toEqual([other]);
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('moves a transfer hold within the transfer’s source, and never releases it here', async () => {
    const variantId = await stocked('3');
    const twin = await createLeafLocation(h, shop.warehouseId, `Twin ${uuidv7().slice(-4)}`);
    await h.run(ops.receiveStock, { variantId, locationId: twin, quantity: '3' });
    const wh = await h.run(ops.createWarehouse, { name: `Far ${uuidv7().slice(-4)}` });
    const far = await createLeafLocation(h, wh.warehouseId, 'Far');
    const { transfer } = await h.run(ops.createTransfer, {
      fromLocationId: shelfB,
      toLocationId: far,
      lines: [{ variantId, quantity: '2' }],
      ready: true,
    });
    const hold = (
      await h.run(ops.listReservations, { reservationId: transfer.lines[0].reservationId })
    ).reservations[0].allocations[0].allocationId;
    await expect(
      h.run(ops.quickCount, {
        locationId: shelfB,
        counts: [{ variantId, counted: '0' }],
        reservationChoices: [{ allocationId: hold, action: 'release' }],
      }),
    ).rejects.toMatchObject({ code: 'reservation_is_transfer' });
    // The transfer's source is shelf B only: no other position there to move the hold to.
    await expect(
      h.run(ops.quickCount, {
        locationId: shelfB,
        counts: [{ variantId, counted: '0' }],
        reservationChoices: [{ allocationId: hold, action: 'reallocate' }],
      }),
    ).rejects.toMatchObject({ code: 'insufficient_stock' });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});

describe('count sessions (D10, G5)', () => {
  it('runs a blind count over a location, and needs review when a position moved after counting', async () => {
    const area = await createLeafLocation(h, shop.warehouseId, `Aisle ${uuidv7().slice(-4)}`);
    const x = await stocked('10', area);
    const y = await stocked('4', area);
    const session = await h.run(ops.startCount, {
      locationId: area,
      blind: true,
      name: 'Aisle check',
    });
    expect(session.lines).toHaveLength(2);
    expect(session.lines.every((l: { expected: string | null }) => l.expected === null)).toBe(true);
    await h.run(ops.recordCount, {
      sessionId: session.sessionId,
      counts: [
        { variantId: x, counted: '9' },
        { variantId: y, counted: '4' },
      ],
    });
    // A movement after x was counted: 3 sold.
    const r = await h.run(ops.reserveStock, { variantId: x, quantity: '3' });
    await h.run(ops.fulfillReservation, { reservationId: r.reservationId });
    const view = await h.run(ops.getCount, { sessionId: session.sessionId });
    const lineX = view.lines.find((l: { variantId: string }) => l.variantId === x);
    expect(lineX).toMatchObject({
      needsReview: true,
      movementsSince: [{ kind: 'fulfillment', quantity: '-3.000000' }],
    });
    expect(view.totals).toMatchObject({ lines: 2, counted: 2, needsReview: 1 });
    const blocked = await h
      .run(ops.submitCount, { sessionId: session.sessionId })
      .catch((e: unknown) => e);
    expect(blocked).toMatchObject({
      code: 'count_needs_review',
      extra: {
        lines: [{ lineId: lineX.lineId, countedOnHand: '10.000000', onHandNow: '7.000000' }],
      },
    });
    // The count was right when taken (one missing), so apply the sale on top: 9 - 3 = 6.
    const submitted = await h.run(ops.submitCount, {
      sessionId: session.sessionId,
      reviews: [{ lineId: lineX.lineId, resolution: 'apply_movements' }],
    });
    expect(submitted.changes).toEqual([expect.objectContaining({ variantId: x, delta: '-1' })]);
    expect(submitted.session).toMatchObject({ status: 'submitted' });
    expect((await stock(x)).onHand).toBe('6.000000');
    expect((await stock(y)).onHand).toBe('4.000000');
    await expect(h.run(ops.submitCount, { sessionId: session.sessionId })).rejects.toMatchObject({
      code: 'count_closed',
    });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('keeps the count when told to, skips uncounted lines, and adds found items', async () => {
    const area = await createLeafLocation(h, shop.warehouseId, `Bay ${uuidv7().slice(-4)}`);
    const x = await stocked('5', area);
    const z = await stocked('7', area);
    const found = await createVariant(h);
    const session = await h.run(ops.startCount, { locationId: area });
    expect(session.lines.map((l: { expected: string }) => l.expected).sort()).toEqual([
      '5.000000',
      '7.000000',
    ]);
    await h.run(ops.recordCount, {
      sessionId: session.sessionId,
      counts: [
        { variantId: x, counted: '2' },
        { variantId: found, counted: '1' },
      ],
    });
    await h.run(ops.receiveStock, { variantId: x, locationId: area, quantity: '1' });
    // Recount after the delivery replaces the line and its basis.
    await h.run(ops.recordCount, {
      sessionId: session.sessionId,
      counts: [{ variantId: x, counted: '3' }],
    });
    const res = await h.run(ops.submitCount, { sessionId: session.sessionId });
    expect(
      res.changes.map((c: { variantId: string; delta: string }) => [c.variantId, c.delta]).sort(),
    ).toEqual(
      [
        [x, '-3'],
        [found, '1'],
      ].sort(),
    );
    expect((await stock(z)).onHand).toBe('7.000000');
    expect(res.session.lines.find((l: { variantId: string }) => l.variantId === z).status).toBe(
      'pending',
    );
    // keep_count after a movement: the count is the truth now.
    const second = await h.run(ops.startCount, { locationId: area, variantIds: [z] });
    await h.run(ops.recordCount, {
      sessionId: second.sessionId,
      counts: [{ variantId: z, counted: '7' }],
    });
    await h.run(ops.adjustStock, {
      locationId: area,
      adjustmentReason: 'damage',
      adjustments: [{ variantId: z, direction: 'remove', quantity: '2' }],
    });
    const lineZ = (await h.run(ops.getCount, { sessionId: second.sessionId })).lines[0];
    expect(lineZ.needsReview).toBe(true);
    await h.run(ops.submitCount, {
      sessionId: second.sessionId,
      reviews: [{ lineId: lineZ.lineId, resolution: 'keep_count' }],
    });
    expect((await stock(z)).onHand).toBe('7.000000');
    const cancelled = await h.run(ops.startCount, { locationId: area });
    await h.run(ops.cancelCount, { sessionId: cancelled.sessionId });
    const open = await h.run(ops.listCounts, {});
    expect(
      open.counts.some((c: { sessionId: string }) => c.sessionId === cancelled.sessionId),
    ).toBe(false);
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});

describe('adjustments, condition changes, and reversals (PRD 6.6)', () => {
  it('adjusts with a reason, needs a note for "other", and costs units out at the average', async () => {
    const variantId = await stocked('10', shelfB, '3');
    await expect(
      h.run(ops.adjustStock, {
        locationId: shelfB,
        adjustmentReason: 'other',
        adjustments: [{ variantId, direction: 'remove', quantity: '1' }],
      }),
    ).rejects.toMatchObject({ code: 'note_required' });
    const res = await h.run(ops.adjustStock, {
      locationId: shelfB,
      adjustmentReason: 'loss_or_theft',
      adjustments: [{ variantId, direction: 'remove', quantity: '2' }],
      note: 'Missing after the fair',
    });
    expect(res).toMatchObject({
      changes: [{ delta: '-2' }],
      unitCosts: { [variantId]: '3.000000' },
    });
    const [op] = await ownerQuery<{ kind: string; reason: string }>(
      'select kind, reason from inventory_operations where id = $1',
      [res.operationId],
    );
    expect(op).toEqual({ kind: 'adjustment', reason: 'loss_or_theft' });
    await expect(
      h.run(ops.adjustStock, {
        locationId: shelfB,
        adjustmentReason: 'write_off',
        adjustments: [{ variantId, direction: 'remove', quantity: '9' }],
      }),
    ).rejects.toMatchObject({ code: 'below_zero' });
    // Reverse it: a new operation linked to the original; once only.
    const reversed = await h.run(ops.reverseOperation, { operationId: res.operationId });
    expect(reversed).toMatchObject({ reverses: res.operationId, changes: [{ delta: '2' }] });
    const [rev] = await ownerQuery<{ kind: string; reverses_operation_id: string }>(
      'select kind, reverses_operation_id from inventory_operations where id = $1',
      [reversed.operationId],
    );
    expect(rev).toEqual({ kind: 'reversal', reverses_operation_id: res.operationId });
    expect((await stock(variantId)).onHand).toBe('10.000000');
    const [cost] = await ownerQuery<{ average_cost: string; quantity: string }>(
      'select average_cost::text, quantity::text from variant_costs where variant_id = $1',
      [variantId],
    );
    expect(cost).toEqual({ average_cost: '3.000000', quantity: '10.000000' });
    await expect(
      h.run(ops.reverseOperation, { operationId: res.operationId }),
    ).rejects.toMatchObject({
      code: 'already_reversed',
    });
    await expect(
      h.run(ops.reverseOperation, { operationId: reversed.operationId }),
    ).rejects.toMatchObject({
      code: 'not_reversible',
    });
    const receipt = await ownerQuery<{ id: string }>(
      `select o.id from inventory_operations o join inventory_entries e on e.operation_id = o.id
       where e.variant_id = $1 and o.kind = 'receipt'`,
      [variantId],
    );
    await expect(
      h.run(ops.reverseOperation, { operationId: receipt[0]!.id }),
    ).rejects.toMatchObject({
      code: 'not_reversible',
    });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('moves units between conditions without changing on hand, and reverses that too', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shelfB,
      quantity: '5',
      condition: 'quarantine',
      unitCost: '2',
    });
    const res = await h.run(ops.changeCondition, {
      locationId: shelfB,
      fromCondition: 'quarantine',
      toCondition: 'sellable',
      items: [{ variantId, quantity: '3' }],
    });
    expect(res.moved).toEqual([expect.objectContaining({ quantity: '3' })]);
    expect(await stock(variantId)).toMatchObject({
      onHand: '5.000000',
      quarantined: '2.000000',
      available: '3.000000',
    });
    const r = await h.run(ops.reserveStock, { variantId, quantity: '3' });
    await expect(
      h.run(ops.changeCondition, {
        locationId: shelfB,
        fromCondition: 'sellable',
        toCondition: 'damaged',
        items: [{ variantId, quantity: '1' }],
      }),
    ).rejects.toMatchObject({ code: 'units_reserved' });
    await expect(
      h.run(ops.reverseOperation, { operationId: res.operationId }),
    ).rejects.toMatchObject({
      code: 'units_reserved',
    });
    await h.run(ops.releaseReservation, { reservationId: r.reservationId });
    await h.run(ops.reverseOperation, { operationId: res.operationId });
    expect(await stock(variantId)).toMatchObject({
      quarantined: '5.000000',
      available: '0.000000',
    });
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});

describe('permissions, location scope (A42), and isolation (A13)', () => {
  it('counts and adjusts only within scope and with the permissions', async () => {
    const variantId = await stocked('3');
    const wh = await h.run(ops.createWarehouse, { name: `Scoped ${uuidv7().slice(-4)}` });
    const elsewhere = await createLeafLocation(h, wh.warehouseId, 'Elsewhere');
    const scoped = await addMember(shop.shopId, 'inventory_operator', [wh.warehouseId]);
    await expect(
      h.run(
        ops.quickCount,
        { locationId: shelfB, counts: [{ variantId, counted: '2' }] },
        { caller: scoped.caller },
      ),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
    await expect(
      h.run(
        ops.adjustStock,
        {
          locationId: shelfB,
          adjustmentReason: 'found',
          adjustments: [{ variantId, direction: 'add', quantity: '1' }],
        },
        { caller: scoped.caller },
      ),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
    await h.run(
      ops.adjustStock,
      {
        locationId: elsewhere,
        adjustmentReason: 'found',
        adjustments: [{ variantId, direction: 'add', quantity: '1' }],
      },
      { caller: scoped.caller },
    );
    const session = await h.run(ops.startCount, { locationId: shelfB });
    await expect(
      h.run(ops.getCount, { sessionId: session.sessionId }, { caller: scoped.caller }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const viewer = await addMember(shop.shopId, 'viewer');
    await expect(
      h.run(
        ops.quickCount,
        { locationId: shelfB, counts: [{ variantId, counted: '1' }] },
        { caller: viewer.caller },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('never reaches another shop’s count, position, or operation', async () => {
    const other = await seedShop(db, sink, 'Other counts shop');
    const ho = harness(db, sink, other);
    const theirs = await createVariant(ho);
    await ho.run(ops.receiveStock, {
      variantId: theirs,
      locationId: other.locationId,
      quantity: '2',
    });
    const session = await ho.run(ops.startCount, { locationId: other.locationId });
    const adj = await ho.run(ops.adjustStock, {
      locationId: other.locationId,
      adjustmentReason: 'sample',
      adjustments: [{ variantId: theirs, direction: 'remove', quantity: '1' }],
    });
    await expect(h.run(ops.getCount, { sessionId: session.sessionId })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(h.run(ops.submitCount, { sessionId: session.sessionId })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      h.run(ops.reverseOperation, { operationId: adj.operationId }),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      h.run(ops.quickCount, { locationId: shelfB, counts: [{ variantId: theirs, counted: '1' }] }),
    ).rejects.toMatchObject({ status: 404 });
    const [count] = await ownerQuery<{ n: string }>(
      'select count(*)::text as n from count_lines where shop_id = $1',
      [other.shopId],
    );
    expect(count!.n).toBe('1');
  });
});
