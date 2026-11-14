import { execute, ops, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appDatabase,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
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
