import { type AnyOperation, type Caller, execute, ops, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appDatabase,
  boundCaller,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
  ownerQuery,
  reconcile,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';

// The failure contract (PRD 7.3) and idempotency for every I1 command: a rollback leaves no stock
// effect (A11), a failed audit write never returns success (A12), a lost acknowledgement leaves a
// durable attempt and no duplicate (A26), and 50 replays have one effect (A05).

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let owner: Caller;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
  owner = await boundCaller(shop);
});
afterAll(() => db.close());

/** A snapshot of everything a stock command can change in this shop. */
async function fingerprint(): Promise<string> {
  const rows = await ownerQuery<{ f: string }>(
    `select concat_ws('|',
       (select string_agg(id || ':' || on_hand || ':' || allocated, ',' order by id) from inventory_positions where shop_id = $1),
       (select string_agg(id || ':' || outstanding || ':' || fulfilled || ':' || moved, ',' order by id) from reservation_allocations where shop_id = $1),
       (select string_agg(id || ':' || status || ':' || shortage_quantity, ',' order by id) from reservations where shop_id = $1),
       (select count(*) from inventory_entries where shop_id = $1),
       (select string_agg(variant_id || ':' || quantity || ':' || coalesce(average_cost::text, '-'), ',' order by variant_id) from variant_costs where shop_id = $1),
       (select string_agg(id || ':' || status, ',' order by id) from serial_units where shop_id = $1),
       (select count(*) from lots where shop_id = $1)) as f`,
    [shop.shopId],
  );
  return rows[0]!.f;
}

/** Builds a fresh setup for each command and returns the operation and its input. */
interface Case {
  label: string;
  setup: () => Promise<{ op: AnyOperation; input: Record<string, unknown> }>;
}

async function stockedVariant(quantity = '20'): Promise<string> {
  const variantId = await createVariant(h);
  await h.run(ops.receiveStock, {
    variantId,
    locationId: shop.locationId,
    quantity,
    unitCost: '3',
  });
  return variantId;
}

const cases: Case[] = [
  {
    label: 'a receipt with a new lot',
    setup: async () => {
      const variantId = await createVariant(h);
      await h.run(ops.setStockSettings, { variantId, trackingMode: 'lot_expiry' });
      return {
        op: ops.receiveStock,
        input: {
          variantId,
          locationId: shop.locationId,
          quantity: '4',
          lotCode: `LOT-${uuidv7().slice(-6)}`,
          expiresOn: '2030-01-31',
        },
      };
    },
  },
  {
    label: 'a receipt of serials',
    setup: async () => {
      const variantId = await createVariant(h);
      await h.run(ops.setStockSettings, { variantId, trackingMode: 'serial' });
      return {
        op: ops.receiveStock,
        input: { variantId, locationId: shop.locationId, quantity: '2', serials: ['S-A', 'S-B'] },
      };
    },
  },
  {
    label: 'a bundle reservation',
    setup: async () => {
      const soap = await stockedVariant();
      const gift = await createVariant(h);
      await h.run(ops.setBundle, {
        variantId: gift,
        bundleVersion: 0,
        components: [{ variantId: soap, quantity: '2' }],
      });
      return { op: ops.reserveStock, input: { variantId: gift, quantity: '3' } };
    },
  },
  {
    label: 'a fulfillment',
    setup: async () => {
      const variantId = await stockedVariant();
      const r = await h.run(ops.reserveStock, { variantId, quantity: '5' });
      return {
        op: ops.fulfillReservation,
        input: { reservationId: r.reservationId, quantity: '3' },
      };
    },
  },
  {
    label: 'a reallocation',
    setup: async () => {
      const variantId = await createVariant(h);
      await h.run(ops.setStockSettings, { variantId, trackingMode: 'lot' });
      for (const code of ['A', 'B']) {
        await h.run(ops.receiveStock, {
          variantId,
          locationId: shop.locationId,
          quantity: '5',
          lotCode: code,
        });
      }
      const r = await h.run(ops.reserveStock, { variantId, quantity: '2', lotCode: 'A' });
      return {
        op: ops.reallocateReservation,
        input: { reservationId: r.reservationId, lotCode: 'B' },
      };
    },
  },
  {
    label: 'a partial release',
    setup: async () => {
      const variantId = await stockedVariant();
      const r = await h.run(ops.reserveStock, { variantId, quantity: '5' });
      return {
        op: ops.releaseReservation,
        input: { reservationId: r.reservationId, quantity: '2' },
      };
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
    if (!('reason' in op.input.shape)) return;
    const before = await fingerprint();
    await expect(h.run(op, { ...input, reason: 'TEST_FAIL_AUDIT_INSERT' })).rejects.toMatchObject({
      status: 500,
    });
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
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('applies one effect for fifty replays with the same key (A05)', async () => {
    const { op, input } = await setup();
    const key = uuidv7();
    const req = { caller: shop.caller, shopId: shop.shopId, input, idempotencyKey: key };
    const first = await execute({ db, audit: sink }, op, req);
    const after = await fingerprint();
    // Sequential: concurrent duplicates are covered in concurrency.test.ts.
    const replays = [];
    for (let i = 0; i < 49; i++) replays.push(await execute({ db, audit: sink }, op, req));
    for (const r of replays) {
      expect(r.replayed).toBe(true);
      expect(r.result).toEqual(first.result);
    }
    expect(await fingerprint()).toBe(after);
    expect(await reconcile(shop.shopId)).toEqual([]);
  });
});
