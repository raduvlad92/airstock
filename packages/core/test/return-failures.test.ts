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

// The failure contract (PRD 7.3, G17) for every return command: a rollback leaves no stock
// effect (A11), a failed audit write never returns success (A12), a lost acknowledgement leaves a
// durable attempt and no duplicate (A26), and 50 replays of the same key have one effect (A05).

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let owner: Caller;
let dock: string;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
  owner = await boundCaller(shop);
  const wh = await h.run(ops.createWarehouse, { name: 'Returns failures' });
  dock = await createLeafLocation(h, wh.warehouseId, 'Dock');
});
afterAll(() => db.close());

/** Everything a return command can change in this shop. */
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
       (select string_agg(id || ':' || status || ':' || version, ',' order by id) from returns where shop_id = $1),
       (select string_agg(id || ':' || received || ':' || sellable || ':' || damaged || ':' || disposed, ',' order by id) from return_lines where shop_id = $1),
       (select string_agg(id || ':' || received || ':' || inspected, ',' order by id) from return_units where shop_id = $1),
       (select count(*) from return_inspections where shop_id = $1)) as f`,
    [shop.shopId],
  );
  return rows[0]!.f;
}

interface Case {
  label: string;
  setup: () => Promise<{ op: AnyOperation; input: Record<string, unknown> }>;
}

/** A variant with `sold` units fulfilled for an order, and a return for them. */
async function soldAndReturned(
  sold = '4',
  opts: { serial?: boolean; receive?: boolean } = {},
): Promise<{ variantId: string; returnId: string; serials: string[] }> {
  const variantId = await createVariant(h);
  const serials: string[] = [];
  if (opts.serial) {
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'serial' });
    for (let i = 0; i < Number(sold); i++) serials.push(`RF-${uuidv7().slice(-8)}`);
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: sold,
      serials,
      unitCost: '9',
    });
  } else {
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '10',
      unitCost: '2',
    });
  }
  const orderRef = `RF-${uuidv7().slice(-8)}`;
  const r = await h.run(ops.reserveStock, { variantId, quantity: sold, externalRef: orderRef });
  await h.run(ops.fulfillReservation, { reservationId: r.reservationId });
  const ret = await h.run(ops.createReturn, {
    lines: [{ variantId, quantity: sold }],
    orderRef,
    authorize: true,
  });
  const returnId = ret.return.returnId as string;
  if (opts.receive) {
    await h.run(ops.receiveReturn, {
      returnId,
      locationId: dock,
      ...(opts.serial ? { items: [{ variantId, serials }] } : {}),
    });
  }
  return { variantId, returnId, serials };
}

const cases: Case[] = [
  {
    label: 'creating a return',
    setup: async () => {
      const { variantId } = await soldAndReturned();
      return {
        op: ops.createReturn,
        input: { lines: [{ variantId, quantity: '1' }], reason: 'Too small', authorize: true },
      };
    },
  },
  {
    label: 'receiving serials into quarantine',
    setup: async () => {
      const { variantId, returnId, serials } = await soldAndReturned('2', { serial: true });
      return {
        op: ops.receiveReturn,
        input: { returnId, locationId: dock, items: [{ variantId, serials }], reason: 'arrived' },
      };
    },
  },
  {
    label: 'an inspection with a disposal',
    setup: async () => {
      const { variantId, returnId } = await soldAndReturned('4', { receive: true });
      return {
        op: ops.inspectReturn,
        input: {
          returnId,
          inspections: [
            { variantId, disposition: 'sellable', quantity: '2' },
            { variantId, disposition: 'disposal', quantity: '1' },
          ],
          reason: 'checked',
        },
      };
    },
  },
  {
    label: 'cancelling a return',
    setup: async () => {
      const { returnId } = await soldAndReturned();
      return { op: ops.cancelReturn, input: { returnId, reason: 'customer kept it' } };
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
