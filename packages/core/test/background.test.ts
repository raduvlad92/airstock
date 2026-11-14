import { dispatchOutbox, ensureAuditPartitions, type OutboxMessage, ops } from '@airstock/core';
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

describe('transactional outbox (PRD 10.5)', () => {
  it('announces committed stock changes once delivered, and retries undelivered ones', async () => {
    // Other test files write outbox rows in parallel, so assertions look only at this shop.
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '5' });
    const pending = async () =>
      (
        await ownerQuery(
          'select id from outbox_events where shop_id = $1 and dispatched_at is null',
          [shop.shopId],
        )
      ).length;
    expect(await pending()).toBe(1);

    await expect(
      dispatchOutbox(
        db,
        async () => {
          throw new Error('queue unavailable');
        },
        500,
      ),
    ).rejects.toThrow('queue unavailable');
    expect(await pending()).toBe(1);

    const delivered: OutboxMessage[] = [];
    for (let i = 0; i < 20 && (await pending()) > 0; i++) {
      await dispatchOutbox(
        db,
        async (messages) => {
          delivered.push(...messages);
        },
        500,
      );
    }
    const mine = delivered.filter((m) => m.shopId === shop.shopId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      topic: 'inventory.availability_changed',
      payload: { variantId, locationIds: [shop.locationId] },
    });
    const again: OutboxMessage[] = [];
    await dispatchOutbox(
      db,
      async (messages) => {
        again.push(...messages);
      },
      500,
    );
    expect(again.filter((m) => m.shopId === shop.shopId)).toHaveLength(0);
  });

  it('writes no outbox row when the command rolls back', async () => {
    const variantId = await createVariant(h);
    await expect(h.run(ops.reserveStock, { variantId, quantity: '1' })).rejects.toMatchObject({
      code: 'insufficient_stock',
    });
    const rows = await ownerQuery(
      `select 1 from outbox_events where shop_id = $1 and payload->>'variantId' = $2`,
      [shop.shopId, variantId],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('audit partitions', () => {
  it('creates future partitions idempotently', async () => {
    expect(await ensureAuditPartitions(db, 6)).toBeGreaterThanOrEqual(0);
    expect(await ensureAuditPartitions(db, 6)).toBe(0);
  });
});
