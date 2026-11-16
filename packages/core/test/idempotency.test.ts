import { execute, ops, sweepIdempotencyRecords, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appDatabase,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
  ownerQuery,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';

const db = appDatabase();
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
});
afterAll(() => db.close());

describe('idempotent commands (A05)', () => {
  it.each([
    ['receipt', 'receive'],
    ['reservation', 'reserve'],
  ])('replays a %s fifty times with one effect and the original result', async (_label, kind) => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '100' });
    const key = uuidv7();
    const op = kind === 'receive' ? ops.receiveStock : ops.reserveStock;
    const input =
      kind === 'receive'
        ? { variantId, locationId: shop.locationId, quantity: '7' }
        : { variantId, quantity: '7' };
    const req = { caller: shop.caller, shopId: shop.shopId, input, idempotencyKey: key };
    const first = await execute({ db, audit: sink }, op, req);
    for (let i = 0; i < 49; i++) {
      const again = await execute({ db, audit: sink }, op, req);
      expect(again.replayed).toBe(true);
      expect(again.result).toEqual(first.result);
    }
    const view = await h.run(ops.getAvailability, { variantId });
    expect(view.totals).toMatchObject(
      kind === 'receive'
        ? { onHand: '107.000000' }
        : { reserved: '7.000000', available: '93.000000' },
    );
    expect(
      sink.events.filter((e) => e.idempotency_key === key && e.outcome === 'replayed'),
    ).toHaveLength(49);
  });

  it('rejects the same key with a different request', async () => {
    const variantId = await createVariant(h);
    const key = uuidv7();
    await h.run(
      ops.receiveStock,
      { variantId, locationId: shop.locationId, quantity: '1' },
      { key },
    );
    await expect(
      h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '2' }, { key }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused', status: 422 });
  });

  it('binds keys to the caller, so another caller reusing a key gets its own effect', async () => {
    const variantId = await createVariant(h);
    const other = await seedShop(db, sink, 'Other');
    const key = 'shared-key';
    await h.run(
      ops.receiveStock,
      { variantId, locationId: shop.locationId, quantity: '1' },
      { key },
    );
    // Same key, different shop and caller: independent.
    const otherH = harness(db, sink, other);
    const otherVariant = await createVariant(otherH);
    const res = await otherH.run(
      ops.receiveStock,
      { variantId: otherVariant, locationId: other.locationId, quantity: '1' },
      { key },
    );
    expect(res.position.onHand).toBe('1.000000');
  });

  it('requires a key for stock commands', async () => {
    const variantId = await createVariant(h);
    await expect(
      h.run(
        ops.receiveStock,
        { variantId, locationId: shop.locationId, quantity: '1' },
        { key: null },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('reports a committed outcome by key, and not_found for keys with no effect', async () => {
    const variantId = await createVariant(h);
    const key = uuidv7();
    const done = await h.run(
      ops.receiveStock,
      { variantId, locationId: shop.locationId, quantity: '3' },
      { key },
    );
    const found = await h.run(ops.getOperationOutcome, {
      operation: 'inventory.receipts.create',
      idempotencyKey: key,
    });
    expect(found).toMatchObject({ status: 'completed', result: done });
    const missing = await h.run(ops.getOperationOutcome, {
      operation: 'inventory.receipts.create',
      idempotencyKey: 'never-used',
    });
    expect(missing).toMatchObject({ status: 'not_found', result: null });
  });
});

describe('idempotency retention (ADR 0006, update for I7)', () => {
  // Other files share the database: count only this shop's records.
  const records = async (shopId: string, old: boolean) => {
    const [row] = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from idempotency_records
       where shop_id = $1 and (created_at < now() - interval '7 days') = $2`,
      [shopId, old],
    );
    return row!.n;
  };

  it('deletes records older than 7 days in batches, keeps recent ones, and replays within the window', async () => {
    const own = await seedShop(db, sink, 'Retention');
    const oh = harness(db, sink, own);
    const variantId = await createVariant(oh);
    const run = (quantity: string, key: string) =>
      execute({ db, audit: sink }, ops.receiveStock, {
        caller: own.caller,
        shopId: own.shopId,
        input: { variantId, locationId: own.locationId, quantity },
        idempotencyKey: key,
      });
    const oldKeys = Array.from({ length: 5 }, () => uuidv7());
    for (const key of oldKeys) await run('1', key);
    const recentKey = uuidv7();
    const recent = await run('2', recentKey);
    // Age the first five past the window.
    await ownerQuery(
      `update idempotency_records set created_at = now() - interval '8 days'
       where shop_id = $1 and key = any($2::text[])`,
      [own.shopId, oldKeys],
    );
    const before = await records(own.shopId, false);
    expect(await records(own.shopId, true)).toBe(5);

    // One bounded batch removes at most its size.
    await sweepIdempotencyRecords(db, { batchSize: 2, maxBatches: 1 });
    expect(await records(own.shopId, true)).toBeGreaterThanOrEqual(3);
    // The full run removes the rest, batch by batch.
    expect(await sweepIdempotencyRecords(db, { batchSize: 2 })).toBeGreaterThanOrEqual(3);
    expect(await records(own.shopId, true)).toBe(0);
    expect(await records(own.shopId, false)).toBe(before);

    // Within the window the original result is replayed, without a second effect.
    const again = await run('2', recentKey);
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(recent.result);
    // After the window the key is forgotten: the same request runs as a new one.
    const late = await run('1', oldKeys[0]!);
    expect(late.replayed).toBe(false);
    const view = await oh.run(ops.getAvailability, { variantId });
    expect(view.totals).toMatchObject({ onHand: '8.000000' });
    const outcome = await oh.run(ops.getOperationOutcome, {
      operation: 'inventory.receipts.create',
      idempotencyKey: oldKeys[1]!,
    });
    expect(outcome).toMatchObject({ status: 'not_found' });
  });
});
