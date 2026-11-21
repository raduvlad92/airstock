import { AppError, type Caller, execute, ops, uuidv7 } from '@airstock/core';
import { type Database, PgDatabase } from '@airstock/db';
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

const db = appDatabase();
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let variantId: string;
let owner: Caller;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
  variantId = await createVariant(h);
  await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '10' });
  owner = await boundCaller(shop);
});
afterAll(() => db.close());

async function onHand(): Promise<string> {
  return (await h.run(ops.getAvailability, { variantId })).totals.onHand;
}

describe('failure contract (PRD 7.3)', () => {
  it('keeps a problem’s own members when an error adds extras of the same name (RFC 9457)', () => {
    const error = new AppError(409, 'return_closed', 'The return is completed.', 'conflict', {
      status: 'completed',
      code: 'other',
      currentStatus: 'completed',
    });
    expect(error.toProblem('req-1')).toEqual({
      type: 'urn:airstock:problem:return_closed',
      title: 'The return is completed.',
      status: 409,
      code: 'return_closed',
      requestId: 'req-1',
      currentStatus: 'completed',
    });
  });

  it('rolls back a failed stock transaction and records the failure separately (A11)', async () => {
    const faulty = appDatabase({
      beforeCommit: () => {
        throw new Error('simulated crash after the balance update');
      },
    });
    const key = uuidv7();
    await expect(
      execute({ db: faulty, audit: sink }, ops.receiveStock, {
        caller: owner,
        shopId: shop.shopId,
        input: { variantId, locationId: shop.locationId, quantity: '5' },
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    await faulty.close();
    expect(await onHand()).toBe('10.000000');
    const trail = sink.events.filter((e) => e.idempotency_key === key);
    expect(trail.map((e) => [e.phase, e.outcome])).toEqual([
      ['attempt', 'received'],
      ['outcome', 'failed'],
    ]);
    expect(trail[0]!.attempt_id).toBe(trail[1]!.attempt_id);
    const persisted = await ownerQuery('select 1 from inventory_operations where attempt_id = $1', [
      trail[0]!.attempt_id,
    ]);
    expect(persisted).toHaveLength(0);
  });

  it('never returns success when the in-transaction audit write fails (A12)', async () => {
    const key = uuidv7();
    await expect(
      h.run(
        ops.receiveStock,
        { variantId, locationId: shop.locationId, quantity: '5', reason: 'TEST_FAIL_AUDIT_INSERT' },
        { key },
      ),
    ).rejects.toMatchObject({ status: 500 });
    expect(await onHand()).toBe('10.000000');
    expect(sink.events.filter((e) => e.idempotency_key === key).map((e) => e.outcome)).toEqual([
      'received',
      'failed',
    ]);
  });

  it('refuses a command when the attempt cannot be recorded', async () => {
    sink.failing = true;
    try {
      await expect(
        h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '5' }),
      ).rejects.toMatchObject({ code: 'audit_unavailable', status: 503 });
    } finally {
      sink.failing = false;
    }
    expect(await onHand()).toBe('10.000000');
  });

  it('returns no data when a read cannot be recorded (A31)', async () => {
    sink.failing = true;
    try {
      await expect(h.run(ops.getAvailability, { variantId })).rejects.toMatchObject({
        code: 'audit_unavailable',
        status: 503,
      });
    } finally {
      sink.failing = false;
    }
  });

  it('reports an unknown outcome when the commit acknowledgement is lost, and retries safely (A26)', async () => {
    const lossy = appDatabase({
      afterCommit: () => {
        throw new Error('connection reset after COMMIT');
      },
    });
    const key = uuidv7();
    const req = {
      caller: owner,
      shopId: shop.shopId,
      input: { variantId, locationId: shop.locationId, quantity: '5' },
      idempotencyKey: key,
    };
    await expect(execute({ db: lossy, audit: sink }, ops.receiveStock, req)).rejects.toMatchObject({
      code: 'outcome_unknown',
      status: 503,
    });
    await lossy.close();
    expect(sink.events.filter((e) => e.idempotency_key === key).map((e) => e.outcome)).toEqual([
      'received',
      'unknown',
    ]);
    // The commit did land: the lookup finds it, and a retry replays instead of repeating.
    const outcome = await h.run(ops.getOperationOutcome, {
      operation: 'inventory.receipts.create',
      idempotencyKey: key,
    });
    expect(outcome.status).toBe('completed');
    const retry = await execute({ db, audit: sink }, ops.receiveStock, req);
    expect(retry.replayed).toBe(true);
    expect(await onHand()).toBe('15.000000');
  });

  it('fails a session request cleanly, with a failure event, when the database is down', async () => {
    const down: Database = new PgDatabase({
      acquire: () =>
        Promise.reject(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })),
      close: async () => {},
    });
    const outage = new MemoryAuditSink();
    await expect(
      execute({ db: down, audit: outage }, ops.getAvailability, {
        caller: shop.caller,
        shopId: shop.shopId,
        input: { variantId },
      }),
    ).rejects.toMatchObject({ status: 503, code: 'service_unavailable' });
    expect(outage.events.map((e) => [e.phase, e.outcome])).toEqual([['outcome', 'failed']]);
  });

  it('writes queued attempts and failures exactly once after a database outage (A27)', async () => {
    const down: Database = new PgDatabase({
      acquire: () =>
        Promise.reject(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })),
      close: async () => {},
    });
    const outage = new MemoryAuditSink();
    const keys = [uuidv7(), uuidv7(), uuidv7()];
    for (const key of keys) {
      await expect(
        execute({ db: down, audit: outage }, ops.receiveStock, {
          caller: owner,
          shopId: shop.shopId,
          input: { variantId, locationId: shop.locationId, quantity: '1' },
          idempotencyKey: key,
        }),
      ).rejects.toMatchObject({ status: 503, code: 'service_unavailable' });
    }
    expect(outage.events).toHaveLength(6);
    // The queue redelivers the batch: each event is stored once.
    expect(await outage.drain(db)).toBe(6);
    expect(await outage.drain(db)).toBe(0);
    const stored = await ownerQuery<{ n: string }>(
      'select count(*)::text as n from audit_events where idempotency_key = any($1)',
      [keys],
    );
    expect(stored[0]?.n).toBe('6');
    expect(await onHand()).toBe('15.000000');
    expect(await reconcile(shop.shopId)).toEqual([]);
  });
});
