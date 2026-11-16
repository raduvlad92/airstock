import { type Caller, ops, reconcileShop, sweepShortages, uuidv7 } from '@airstock/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
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

// Review findings for the inventory engine (review/inventory-findings). Each test demonstrates one
// confirmed defect and is marked `it.fails` so CI stays green until the fix lands: when a fix
// makes the assertion pass, `it.fails` turns red and the marker comes off. No fixes here.
//
// Tests only assert on this file's own shops and never drain the shared outbox.

const db = appDatabase({}, 12);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let store: string; // a shelf in a second warehouse

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Review findings');
  h = harness(db, sink, shop);
  const wh = await h.run(ops.createWarehouse, { name: 'Store' });
  store = await createLeafLocation(h, wh.warehouseId, 'Front');
});
afterAll(() => db.close());

/** A shop-bound connector caller (a sales channel), which may reserve with a shortage. */
async function connector(s: SeededShop = shop): Promise<Caller> {
  const [m] = await ownerQuery<{ id: string }>(
    'select id from memberships where shop_id = $1 and user_id = $2',
    [s.shopId, s.userId],
  );
  return {
    kind: 'connector',
    id: uuidv7(),
    userId: null,
    boundShopId: s.shopId,
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
}

/** An owner-role connection outside the app, for holding row locks like a concurrent command. */
async function rawClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: inject('databases').ownerUrl });
  await client.connect();
  return client;
}

/** transfer_ and return_reconciliation_problems() in one shop, as the runtime role (RLS on). */
async function documentProblems(shopId: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: inject('databases').appUrl });
  await client.connect();
  try {
    await client.query('begin read only');
    await client.query(`select set_config('app.shop_id', $1, true)`, [shopId]);
    const out: string[] = [];
    for (const fn of ['transfer_reconciliation_problems', 'return_reconciliation_problems']) {
      const { rows } = await client.query<{ problem: string; target_id: string }>(
        `select problem, target_id from ${fn}()`,
      );
      out.push(...rows.map((r) => `${r.problem} at ${r.target_id}`));
    }
    await client.query('commit');
    return out;
  } finally {
    await client.end();
  }
}

/** Waits until some backend is blocked on a row lock while running SQL that matches `like`. */
async function waitForLockWait(like: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const rows = await ownerQuery(
      `select 1 from pg_stat_activity
       where wait_event_type = 'Lock' and query like $1`,
      [like],
    );
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no backend waited on a lock for ${like}`);
}

// ---------------------------------------------------------------------------------------------
// F-SWEEP-LOCK-ORDER (deadlock). background.ts sweepShortages locks each variant's candidate
// positions in its own statement, variant by variant (ordered by variant id), and fillShortages
// locks that variant's shortage reservations before the next variant's positions are locked. The
// positions of a sweep run are therefore not locked in ascending id order across variants, and
// reservations are locked before later positions: both break ADR 0006. Any command that locks
// the same two positions in the documented ascending order (a two-line transfer dispatch, a
// bundle reservation, a count of both) deadlocks with the sweep; PostgreSQL aborts one side.
// ---------------------------------------------------------------------------------------------
describe('F-SWEEP-LOCK-ORDER: sweepShortages locks positions out of ascending id order', () => {
  it.fails('does not deadlock with a command that locks the same positions in id order', async () => {
    // Variant A sorts first by variant id; its position is created after B's, so pA > pB.
    const variantA = await createVariant(h);
    const variantB = await createVariant(h);
    await h.run(ops.receiveStock, {
      variantId: variantB,
      locationId: shop.locationId,
      quantity: '1',
    });
    await h.run(ops.receiveStock, {
      variantId: variantA,
      locationId: shop.locationId,
      quantity: '1',
    });
    const c = await connector();
    // Both variants get an open shortage, so the sweep visits both (A first, by variant id).
    for (const variantId of [variantA, variantB]) {
      await h.run(
        ops.reserveStock,
        { variantId, quantity: '3', allowShortage: true },
        { caller: c },
      );
    }
    const [pA] = await ownerQuery<{ id: string }>(
      'select id from inventory_positions where shop_id = $1 and variant_id = $2',
      [shop.shopId, variantA],
    );
    const [pB] = await ownerQuery<{ id: string }>(
      'select id from inventory_positions where shop_id = $1 and variant_id = $2',
      [shop.shopId, variantB],
    );
    expect(pB!.id < pA!.id).toBe(true);
    expect(variantA < variantB).toBe(true);

    // A command following ADR 0006 locks pB, then pA (ascending ids).
    const command = await rawClient();
    try {
      await command.query('begin');
      await command.query('select id from inventory_positions where id = $1 for update', [pB!.id]);
      const sweep = sweepShortages(db, 50, [shop.shopId]).then(
        () => 'ok',
        (e: { code?: string }) => e.code ?? String(e),
      );
      // The sweep has locked pA (variant A) and now waits for pB (variant B).
      await waitForLockWait('%p.on_hand > 0 or $9%');
      const second = command
        .query('select id from inventory_positions where id = $1 for update', [pA!.id])
        .then(
          () => 'ok',
          (e: { code?: string }) => e.code ?? String(e),
        );
      const commandOutcome = await second;
      await command.query(commandOutcome === 'ok' ? 'commit' : 'rollback');
      const sweepOutcome = await sweep;
      // Neither side may be chosen as a deadlock victim (40P01).
      expect({ command: commandOutcome, sweep: sweepOutcome }).toEqual({
        command: 'ok',
        sweep: 'ok',
      });
    } finally {
      await command.end();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// F-RECON-SKIPS-DOCUMENTS (audit gap). The scheduled reconciliation (stock/reconciliation.ts
// readStockProblems) runs only stock_reconciliation_problems(). transfer_reconciliation_problems()
// (migration 0030) and return_reconciliation_problems() (0031) are called by tests only, so a
// transfer hold or in-transit mismatch never opens the reconciliation alert (ADR 0028 relies on
// that check for conservation of in-transit stock).
// ---------------------------------------------------------------------------------------------
describe('F-RECON-SKIPS-DOCUMENTS: the scheduled check ignores transfer and return invariants', () => {
  it.fails('reports a transfer whose in-transit stock no longer matches its line', async () => {
    const own = await seedShop(db, sink, 'Review recon');
    const oh = harness(db, sink, own);
    const wh = await oh.run(ops.createWarehouse, { name: 'Other' });
    const to = await createLeafLocation(oh, wh.warehouseId, 'Bay');
    const variantId = await createVariant(oh);
    await oh.run(ops.receiveStock, { variantId, locationId: own.locationId, quantity: '5' });
    const { transfer } = await oh.run(ops.createTransfer, {
      fromLocationId: own.locationId,
      toLocationId: to,
      lines: [{ variantId, quantity: '5' }],
      ready: true,
    });
    await oh.run(ops.dispatchTransfer, { transferId: transfer.transferId });
    // The line now claims one more dispatched unit than transit holds (a corrupted line).
    await ownerQuery(
      'update transfer_lines set dispatched = dispatched + 1, planned = planned + 1 where shop_id = $1 and transfer_id = $2',
      [own.shopId, transfer.transferId],
    );
    const direct = await documentProblems(own.shopId);
    expect(direct.length).toBeGreaterThan(0);
    const checked = await reconcileShop(db, own.shopId, 'scheduled');
    expect(checked.problems).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// F-SCOPE-LOT-SERIAL-HISTORY (scope leak). operations/inventory-lots.ts traceLot and
// serialHistory have no `locations` hook and never read ctx.locationScope: a member limited to
// one warehouse sees every movement of a lot or serial (locations, quantities, orders) and the
// serial's current out-of-scope position. PRD 2.4: the scope covers positions, movements, and
// history entries about those locations; out-of-scope stock figures and history are hidden.
// ---------------------------------------------------------------------------------------------
describe('F-SCOPE-LOT-SERIAL-HISTORY: lot trace and serial history ignore location scope', () => {
  it.fails('hides out-of-scope lot movements from a member limited to another warehouse', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'lot' });
    const received = await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '7',
      lotCode: `LOT-${uuidv7().slice(-6)}`,
    });
    const [lot] = await ownerQuery<{ id: string }>(
      'select id from lots where shop_id = $1 and variant_id = $2',
      [shop.shopId, variantId],
    );
    expect(received).toBeTruthy();
    const scoped = await addMember(shop.shopId, 'viewer', [store]);
    const trace = await h.run(ops.traceLot, { lotId: lot!.id }, { caller: scoped.caller });
    const outOfScope = trace.movements.filter(
      (m: { locationId: string }) => m.locationId === shop.locationId,
    );
    expect({ movements: outOfScope.length, onHand: trace.totals.onHand }).toEqual({
      movements: 0,
      onHand: '0',
    });
  });

  it.fails('hides an out-of-scope serial’s position and movements', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'serial' });
    const serial = `SN-${uuidv7().slice(-6)}`;
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '1',
      serials: [serial],
    });
    const scoped = await addMember(shop.shopId, 'viewer', [store]);
    const history = await h.run(
      ops.serialHistory,
      { variantId, serial },
      { caller: scoped.caller },
    );
    expect({
      current: history.current?.locationId ?? null,
      movements: history.movements.length,
    }).toEqual({ current: null, movements: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// F-SCOPE-ALLOCATION-RULE (scope bypass). operations/inventory-settings.ts setAllocationRule's
// `locations` hook returns only the locations in the NEW list. A member limited to some locations
// can send an empty list (which means "every fulfillment-eligible location") or replace a rule
// that names warehouses outside their scope, so they re-route a channel's reservations to or from
// stock they may not touch. The hook's own comment says this must not be possible.
// ---------------------------------------------------------------------------------------------
describe('F-SCOPE-ALLOCATION-RULE: a scoped member can widen or rewrite a channel rule', () => {
  it.fails('refuses to replace a rule naming an out-of-scope warehouse with "every location"', async () => {
    const channel = `shopify:${uuidv7().slice(-8)}`;
    await h.run(ops.setAllocationRule, { channel, locationIds: [shop.warehouseId] });
    const scoped = await addMember(shop.shopId, 'manager', [store]);
    const outcome = await h
      .run(ops.setAllocationRule, { channel, locationIds: [] }, { caller: scoped.caller })
      .then(
        () => 'succeeded',
        (e: { code?: string }) => e.code,
      );
    expect(outcome).toBe('location_out_of_scope');
  });
});
