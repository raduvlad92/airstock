import { type AnyOperation, type Caller, execute, ops, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appDatabase,
  boundCaller,
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

// The failure contract (PRD 7.3, G17) for every count and adjustment command: a rollback leaves no stock
// effect (A11), a failed audit write never returns success (A12), a lost acknowledgement leaves a
// durable attempt and no duplicate (A26), and 50 replays of the same key have one effect (A05).

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let owner: Caller;
let shelf: string;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
  owner = await boundCaller(shop);
  shelf = await createLeafLocation(h, shop.warehouseId, 'Count failures shelf');
});
afterAll(() => db.close());

/** Everything a count or adjustment command can change in this shop. */
async function fingerprint(): Promise<string> {
  const rows = await ownerQuery<{ f: string }>(
    `select concat_ws('|',
       (select string_agg(id || ':' || on_hand || ':' || allocated, ',' order by id) from inventory_positions where shop_id = $1),
       (select string_agg(id || ':' || outstanding || ':' || fulfilled || ':' || released || ':' || moved, ',' order by id) from reservation_allocations where shop_id = $1),
       (select string_agg(id || ':' || status, ',' order by id) from reservations where shop_id = $1),
       (select count(*) from inventory_entries where shop_id = $1),
       (select count(*) from inventory_operations where shop_id = $1),
       (select string_agg(variant_id || ':' || quantity, ',' order by variant_id) from variant_costs where shop_id = $1),
       (select string_agg(id || ':' || status, ',' order by id) from serial_units where shop_id = $1),
       (select string_agg(id || ':' || status || ':' || version, ',' order by id) from count_sessions where shop_id = $1),
       (select string_agg(id || ':' || status || ':' || coalesce(counted::text, '-'), ',' order by id) from count_lines where shop_id = $1)) as f`,
    [shop.shopId],
  );
  return rows[0]!.f;
}

interface Case {
  label: string;
  setup: () => Promise<{ op: AnyOperation; input: Record<string, unknown> }>;
}

async function stocked(quantity = '10'): Promise<string> {
  const variantId = await createVariant(h);
  await h.run(ops.receiveStock, { variantId, locationId: shelf, quantity, unitCost: '2' });
  return variantId;
}

const cases: Case[] = [
  {
    label: 'a quick count with a released claim',
    setup: async () => {
      const variantId = await stocked('5');
      const r = await h.run(ops.reserveStock, { variantId, quantity: '3', locationId: shelf });
      return {
        op: ops.quickCount,
        input: {
          locationId: shelf,
          counts: [{ variantId, counted: '2' }],
          reservationChoices: [
            { allocationId: r.allocations[0].allocationId, action: 'release', quantity: '1' },
          ],
          note: 'shelf check',
        },
      };
    },
  },
  {
    label: 'starting a count session',
    setup: async () => {
      await stocked('2');
      return { op: ops.startCount, input: { locationId: shelf, blind: true, note: 'weekly' } };
    },
  },
  {
    label: 'recording counts',
    setup: async () => {
      const variantId = await stocked('4');
      const s = await h.run(ops.startCount, { locationId: shelf, variantIds: [variantId] });
      return {
        op: ops.recordCount,
        input: { sessionId: s.sessionId, counts: [{ variantId, counted: '3' }], note: 'aisle 1' },
      };
    },
  },
  {
    label: 'submitting a count',
    setup: async () => {
      const variantId = await stocked('4');
      const s = await h.run(ops.startCount, { locationId: shelf, variantIds: [variantId] });
      await h.run(ops.recordCount, {
        sessionId: s.sessionId,
        counts: [{ variantId, counted: '6' }],
      });
      return { op: ops.submitCount, input: { sessionId: s.sessionId, note: 'done' } };
    },
  },
  {
    label: 'an adjustment of serials',
    setup: async () => {
      const variantId = await createVariant(h);
      await h.run(ops.setStockSettings, { variantId, trackingMode: 'serial' });
      const serials = [`AF-${uuidv7().slice(-8)}`, `AG-${uuidv7().slice(-8)}`];
      await h.run(ops.receiveStock, {
        variantId,
        locationId: shelf,
        quantity: '2',
        serials,
        unitCost: '7',
      });
      return {
        op: ops.adjustStock,
        input: {
          locationId: shelf,
          adjustmentReason: 'damage',
          adjustments: [{ variantId, direction: 'remove', serials: [serials[0]] }],
          note: 'dropped',
        },
      };
    },
  },
  {
    label: 'a condition change',
    setup: async () => {
      const variantId = await stocked('4');
      return {
        op: ops.changeCondition,
        input: {
          locationId: shelf,
          fromCondition: 'sellable',
          toCondition: 'repair',
          items: [{ variantId, quantity: '2' }],
          note: 'loose part',
        },
      };
    },
  },
  {
    label: 'a reversal',
    setup: async () => {
      const variantId = await stocked('4');
      const a = await h.run(ops.adjustStock, {
        locationId: shelf,
        adjustmentReason: 'write_off',
        adjustments: [{ variantId, direction: 'remove', quantity: '1' }],
      });
      return { op: ops.reverseOperation, input: { operationId: a.operationId, note: 'mistake' } };
    },
  },
];

describe.each(cases)('$label', ({ setup }) => {
  it('rolls back completely when the transaction fails, and records the failure (A11)', async () => {
    const { op, input } = await setup();
    const before = await fingerprint();
    const faulty = appDatabase({
      beforeCommit: () => {
        throw new Error('simulated crash after the stock update');
      },
    });
    const key = uuidv7();
    await expect(
      execute({ db: faulty, audit: sink }, op, {
        caller: owner,
        shopId: shop.shopId,
        input,
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    await faulty.close();
    expect(await fingerprint()).toBe(before);
    expect(sink.events.filter((e) => e.idempotency_key === key).map((e) => e.outcome)).toEqual([
      'received',
      'failed',
    ]);
  });

  it('never returns success when the audit write fails (A12)', async () => {
    const { op, input } = await setup();
    const before = await fingerprint();
    const failing =
      'note' in input
        ? { ...input, note: 'TEST_FAIL_AUDIT_INSERT' }
        : { ...input, reason: 'TEST_FAIL_AUDIT_INSERT' };
    await expect(h.run(op, failing)).rejects.toMatchObject({ status: 500 });
    expect(await fingerprint()).toBe(before);
  });

  it('keeps a durable attempt when the acknowledgement is lost, and a retry has no second effect (A26)', async () => {
    const { op, input } = await setup();
    const lossy = appDatabase({
      afterCommit: () => {
        throw new Error('connection reset after COMMIT');
      },
    });
    const key = uuidv7();
    const req = { caller: owner, shopId: shop.shopId, input, idempotencyKey: key };
    await expect(execute({ db: lossy, audit: sink }, op, req)).rejects.toMatchObject({
      code: 'outcome_unknown',
    });
    await lossy.close();
    const committed = await fingerprint();
    const outcome = await h.run(ops.getOperationOutcome, { operation: op.id, idempotencyKey: key });
    expect(outcome.status).toBe('completed');
    const retry = await execute({ db, audit: sink }, op, req);
    expect(retry.replayed).toBe(true);
    expect(await fingerprint()).toBe(committed);
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });

  it('applies one effect for fifty replays with the same key (A05)', async () => {
    const { op, input } = await setup();
    const key = uuidv7();
    const req = { caller: shop.caller, shopId: shop.shopId, input, idempotencyKey: key };
    const first = await execute({ db, audit: sink }, op, req);
    const after = await fingerprint();
    for (let i = 0; i < 49; i++) {
      const r = await execute({ db, audit: sink }, op, req);
      expect(r.replayed).toBe(true);
      expect(r.result).toEqual(first.result);
    }
    expect(await fingerprint()).toBe(after);
    expect(await reconcileAll(shop.shopId)).toEqual([]);
  });
});
