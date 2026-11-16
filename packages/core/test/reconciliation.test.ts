import { ops, reconcileShop, reconcileStock } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  appDatabase,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
  ownerQuery,
  reconcile,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';

// The scheduled stock reconciliation and its reviewed repair (D18, A21). Other test files share
// the database and the outbox, so every assertion looks only at this file's shops.

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();

beforeAll(() => undefined);
afterAll(() => db.close());

async function shopWithStock(name: string, quantity = '10') {
  const shop = await seedShop(db, sink, name);
  const h = harness(db, sink, shop);
  const variantId = await createVariant(h);
  await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity });
  const [position] = await ownerQuery<{ id: string }>(
    'select id from inventory_positions where variant_id = $1',
    [variantId],
  );
  return { shop, h, variantId, positionId: position!.id };
}

async function checks(shopId: string) {
  return ownerQuery<{ trigger: string; problems: number }>(
    'select trigger, problems from stock_reconciliations where shop_id = $1 order by checked_at, id',
    [shopId],
  );
}

async function alerts(shopId: string) {
  return ownerQuery<{ id: string; kind: string; status: string; occurrences: number }>(
    `select id, kind, status, occurrences from alerts
     where shop_id = $1 and dedupe_key = 'reconciliation' order by opened_at`,
    [shopId],
  );
}

async function auditActions(shopId: string) {
  return ownerQuery<{ action: string; actor_type: string; actor_id: string; changes: unknown }>(
    `select action, actor_type, actor_id, changes from audit_events
     where shop_id = $1 and action like 'inventory.reconciliation.alert_%' order by event_id`,
    [shopId],
  );
}

async function alertOutbox(shopId: string) {
  return ownerQuery<{ topic: string; payload: { alertId: string; kind: string } }>(
    `select topic, payload from outbox_events
     where shop_id = $1 and topic like 'alert.%' order by created_at, id`,
    [shopId],
  );
}

/** Everything a check could change by mistake: balances, ledger, claims, and cost rows. */
async function stockState(shopId: string) {
  return ownerQuery(
    `select
       (select json_agg(json_build_object('id', id, 'on_hand', on_hand, 'allocated', allocated,
          'version', version) order by id) from inventory_positions where shop_id = $1) as positions,
       (select count(*)::int from inventory_entries where shop_id = $1) as entries,
       (select count(*)::int from inventory_operations where shop_id = $1) as operations,
       (select json_agg(json_build_object('variant', variant_id, 'quantity', quantity,
          'version', version) order by variant_id) from variant_costs where shop_id = $1) as costs,
       (select count(*)::int from variant_cost_history where shop_id = $1) as cost_history`,
    [shopId],
  );
}

describe('scheduled stock reconciliation (D18)', () => {
  it('records a clean check for a shop whose stock adds up, without an alert', async () => {
    const { shop } = await shopWithStock('Clean');
    const result = await reconcileShop(db, shop.shopId, 'scheduled');
    expect(result).toMatchObject({ problems: 0, alert: null, alertId: null });
    expect(await checks(shop.shopId)).toEqual([{ trigger: 'scheduled', problems: 0 }]);
    expect(await alerts(shop.shopId)).toEqual([]);
    expect(await auditActions(shop.shopId)).toEqual([]);
    expect(await alertOutbox(shop.shopId)).toEqual([]);
  });

  it('opens one alert for a corrupted balance, keeps it on repeat runs, and edits nothing', async () => {
    const { shop, positionId, variantId } = await shopWithStock('Corrupted');
    await ownerQuery('update inventory_positions set on_hand = on_hand + 3 where id = $1', [
      positionId,
    ]);
    const before = await stockState(shop.shopId);

    const first = await reconcileShop(db, shop.shopId, 'scheduled');
    expect(first).toMatchObject({ problems: 2, alert: 'opened' });
    const opened = await alerts(shop.shopId);
    expect(opened).toEqual([
      { id: first.alertId, kind: 'reconciliation_mismatch', status: 'open', occurrences: 1 },
    ]);
    const audit = await auditActions(shop.shopId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'inventory.reconciliation.alert_opened',
      actor_type: 'system',
      actor_id: 'reconciliation',
    });
    // The event lists each problem with its figures.
    const listed = (audit[0]!.changes as { problems: Array<Record<string, string>> }).problems;
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          problem: 'on_hand_mismatch',
          targetId: positionId,
          expected: '10.000000',
          actual: '13.000000',
        }),
        expect.objectContaining({ problem: 'cost_quantity_mismatch', targetId: variantId }),
      ]),
    );
    expect(await alertOutbox(shop.shopId)).toEqual([
      {
        topic: 'alert.opened',
        payload: { alertId: first.alertId, kind: 'reconciliation_mismatch' },
      },
    ]);

    // The same problems again: no second alert, event, or announcement, only a count.
    const second = await reconcileShop(db, shop.shopId, 'daily');
    expect(second).toMatchObject({ problems: 2, alert: 'unchanged', alertId: first.alertId });
    expect(await alerts(shop.shopId)).toEqual([{ ...opened[0], occurrences: 2 }]);
    expect(await auditActions(shop.shopId)).toHaveLength(1);
    expect(await alertOutbox(shop.shopId)).toHaveLength(1);
    expect(await checks(shop.shopId)).toEqual([
      { trigger: 'scheduled', problems: 2 },
      { trigger: 'daily', problems: 2 },
    ]);

    // Nothing was edited: the check only reads stock.
    expect(await stockState(shop.shopId)).toEqual(before);
  });

  it('repairs through a reviewed preview and commit, and the next check resolves the alert', async () => {
    const { shop, h, positionId, variantId } = await shopWithStock('Repaired');
    await ownerQuery('update inventory_positions set on_hand = on_hand + 3 where id = $1', [
      positionId,
    ]);
    const { alertId } = await reconcileShop(db, shop.shopId, 'scheduled');

    const status = await h.run(ops.getStockCheck, {});
    expect(status.lastCheck).toMatchObject({ trigger: 'scheduled', problemCount: 2 });
    expect(status.alert).toMatchObject({ id: alertId, status: 'open', resolvedAt: null });
    expect(status.current.problemCount).toBe(2);
    expect(status.current.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          problem: 'on_hand_mismatch',
          targetId: positionId,
          expected: '10',
          actual: '13',
          variantId,
          locationPath: expect.any(String),
          repairable: true,
        }),
      ]),
    );

    // Preview: the history gets +3; on hand stays 13.
    const preview = await h.run(ops.previewStockRepair, {
      problem: 'on_hand_mismatch',
      targetId: positionId,
    });
    expect(preview).toMatchObject({
      reported: true,
      problem: { expected: '10', actual: '13' },
      repair: { field: 'history', from: '10', to: '13', delta: '3' },
    });
    expect(preview.repair.summary).toContain('+3');

    // A commit needs the confirmation, a reason, and the previewed figures.
    const commit = {
      problem: 'on_hand_mismatch',
      targetId: positionId,
      expected: preview.problem.expected,
      actual: preview.problem.actual,
      reason: 'Counted the shelf: 13 units are there.',
      confirm: true,
    };
    await expect(
      h.run(ops.repairStockProblem, { ...commit, confirm: undefined }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      h.run(ops.repairStockProblem, { ...commit, reason: undefined }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(h.run(ops.repairStockProblem, { ...commit, actual: '12' })).rejects.toMatchObject({
      code: 'problem_changed',
    });

    const repaired = await h.run(ops.repairStockProblem, commit);
    expect(repaired.repair).toMatchObject({ field: 'history', delta: '3' });
    const [entry] = await ownerQuery<{ delta: string; kind: string; reason: string }>(
      `select e.delta::text, o.kind, o.reason from inventory_entries e
       join inventory_operations o on o.shop_id = e.shop_id and o.id = e.operation_id
       where e.operation_id = $1`,
      [repaired.operationId],
    );
    expect(entry).toEqual({ delta: '3.000000', kind: 'adjustment', reason: 'reconciliation' });
    const [onHand] = await ownerQuery<{ on_hand: string }>(
      'select on_hand::text from inventory_positions where id = $1',
      [positionId],
    );
    expect(onHand!.on_hand).toBe('13.000000');
    const [event] = await ownerQuery<{ reason: string; operation_id: string }>(
      `select reason, operation_id from audit_events
       where shop_id = $1 and action = 'inventory.reconciliation.repaired'`,
      [shop.shopId],
    );
    expect(event).toEqual({ reason: commit.reason, operation_id: repaired.operationId });

    // Repeating the commit finds nothing left to repair.
    await expect(h.run(ops.repairStockProblem, commit)).rejects.toMatchObject({
      code: 'problem_resolved',
    });

    // The owned quantity behind the average cost is its own problem, with its own repair.
    const costPreview = await h.run(ops.previewStockRepair, {
      problem: 'cost_quantity_mismatch',
      targetId: variantId,
    });
    expect(costPreview.repair).toMatchObject({
      field: 'owned_quantity',
      from: '10',
      to: '13',
      delta: '3',
    });
    await h.run(ops.repairStockProblem, {
      problem: 'cost_quantity_mismatch',
      targetId: variantId,
      expected: costPreview.problem.expected,
      actual: costPreview.problem.actual,
      reason: 'The cost row follows the counted stock.',
      confirm: true,
    });
    expect(await reconcile(shop.shopId)).toEqual([]);

    // The repair does not resolve the alert; the next scheduled check does.
    expect((await alerts(shop.shopId))[0]!.status).toBe('open');
    const next = await reconcileShop(db, shop.shopId, 'scheduled');
    expect(next).toMatchObject({ problems: 0, alert: 'resolved', alertId });
    expect(await alerts(shop.shopId)).toEqual([
      expect.objectContaining({ id: alertId, status: 'resolved' }),
    ]);
    expect((await auditActions(shop.shopId)).map((e) => e.action)).toEqual([
      'inventory.reconciliation.alert_opened',
      'inventory.reconciliation.alert_resolved',
    ]);
    expect((await alertOutbox(shop.shopId)).map((o) => o.topic)).toEqual([
      'alert.opened',
      'alert.resolved',
    ]);
    // A later clean check changes nothing more.
    expect(await reconcileShop(db, shop.shopId, 'scheduled')).toMatchObject({ alert: null });
    expect(await auditActions(shop.shopId)).toHaveLength(2);
  });

  it('repairs reserved from the open allocations and refuses problems it cannot repair', async () => {
    const { shop, h, positionId, variantId } = await shopWithStock('Allocated');
    await h.run(ops.reserveStock, { variantId, quantity: '4' });
    await ownerQuery('update inventory_positions set allocated = 1 where id = $1', [positionId]);
    const preview = await h.run(ops.previewStockRepair, {
      problem: 'allocated_mismatch',
      targetId: positionId,
    });
    expect(preview.repair).toMatchObject({ field: 'allocated', from: '1', to: '4' });
    await h.run(ops.repairStockProblem, {
      problem: 'allocated_mismatch',
      targetId: positionId,
      expected: preview.problem.expected,
      actual: preview.problem.actual,
      reason: 'Reserved follows the open reservations.',
      confirm: true,
    });
    expect(await reconcile(shop.shopId)).toEqual([]);

    const [reservation] = await ownerQuery<{ id: string }>(
      'select id from reservations where variant_id = $1',
      [variantId],
    );
    await ownerQuery(`update reservations set status = 'released' where id = $1`, [
      reservation!.id,
    ]);
    const odd = await h.run(ops.previewStockRepair, {
      problem: 'reservation_status_mismatch',
      targetId: reservation!.id,
    });
    expect(odd).toMatchObject({ reported: true, repair: null, guidance: expect.any(String) });
    await expect(
      h.run(ops.repairStockProblem, {
        problem: 'reservation_status_mismatch',
        targetId: reservation!.id,
        expected: 'open',
        actual: 'released',
        reason: 'Trying anyway.',
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: 'repair_not_available' });
  });

  it('needs inventory.adjust to repair, and keeps each shop to itself', async () => {
    const corrupted = await shopWithStock('Isolation A');
    const clean = await shopWithStock('Isolation B');
    await ownerQuery('update inventory_positions set on_hand = on_hand + 1 where id = $1', [
      corrupted.positionId,
    ]);
    expect(await reconcileShop(db, clean.shop.shopId, 'scheduled')).toMatchObject({
      problems: 0,
      alert: null,
    });
    expect(await alerts(clean.shop.shopId)).toEqual([]);
    const cleanStatus = await clean.h.run(ops.getStockCheck, {});
    expect(cleanStatus.current).toEqual({ problemCount: 0, problems: [] });

    // Shop B cannot see or repair shop A's position.
    await expect(
      clean.h.run(ops.previewStockRepair, {
        problem: 'on_hand_mismatch',
        targetId: corrupted.positionId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      clean.h.run(ops.repairStockProblem, {
        problem: 'on_hand_mismatch',
        targetId: corrupted.positionId,
        expected: '10',
        actual: '11',
        reason: 'Not my shop.',
        confirm: true,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    // A viewer sees the problems but cannot repair them; an inventory operator can.
    const viewer = await addMember(corrupted.shop.shopId, 'viewer');
    const seen = await corrupted.h.run(ops.getStockCheck, {}, { caller: viewer.caller });
    expect(seen.current.problemCount).toBe(2);
    await expect(
      corrupted.h.run(
        ops.previewStockRepair,
        { problem: 'on_hand_mismatch', targetId: corrupted.positionId },
        { caller: viewer.caller },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const operator = await addMember(corrupted.shop.shopId, 'inventory_operator');
    const preview = await corrupted.h.run(
      ops.previewStockRepair,
      { problem: 'on_hand_mismatch', targetId: corrupted.positionId },
      { caller: operator.caller },
    );
    expect(preview.repair).toMatchObject({ delta: '1' });
  });

  it('checks due shops from the cron in bounded runs', async () => {
    const { shop, h, variantId } = await shopWithStock('Due');
    // Other files' shops are due too; a few bounded runs reach this one.
    for (let i = 0; i < 20 && (await checks(shop.shopId)).length === 0; i++) {
      const run = await reconcileStock(db, { maxShops: 50 });
      expect(run.checked).toBeLessThanOrEqual(50);
    }
    expect(await checks(shop.shopId)).toEqual([{ trigger: 'scheduled', problems: 0 }]);

    // Not due again until stock moves.
    const due = async () =>
      (
        await ownerQuery<{ s: string }>(
          'select s from shops_due_stock_reconciliation(false, 500) s where s = $1',
          [shop.shopId],
        )
      ).length;
    expect(await due()).toBe(0);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '1' });
    expect(await due()).toBe(1);
  });
});
