import {
  dispatchOutbox,
  drainOutbox,
  ensureAuditPartitions,
  type OutboxMessage,
  ops,
  uuidv7,
} from '@airstock/core';
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

  it('drains a burst in batches, including events written while delivering', async () => {
    // A burst larger than one batch, as an import or an outage backlog leaves.
    await ownerQuery(
      `insert into outbox_events (shop_id, id, topic, payload)
       select $1, gen_random_uuid(), 'test.burst', jsonb_build_object('n', g) from generate_series(1, 250) g`,
      [shop.shopId],
    );
    const delivered: OutboxMessage[] = [];
    let wroteMore = false;
    await drainOutbox(
      db,
      async (messages) => {
        delivered.push(...messages);
        // Delivering a job (an import chunk) writes new events; the next round takes them.
        if (!wroteMore && messages.some((m) => m.topic === 'test.burst')) {
          wroteMore = true;
          await ownerQuery(
            `insert into outbox_events (shop_id, id, topic, payload) values ($1, $2, 'test.followup', '{}')`,
            [shop.shopId, uuidv7()],
          );
        }
      },
      { batch: 100 },
    );
    const mine = delivered.filter((m) => m.shopId === shop.shopId);
    expect(mine.filter((m) => m.topic === 'test.burst')).toHaveLength(250);
    expect(mine.filter((m) => m.topic === 'test.followup')).toHaveLength(1);
    const left = await ownerQuery(
      'select 1 from outbox_events where shop_id = $1 and dispatched_at is null',
      [shop.shopId],
    );
    expect(left).toHaveLength(0);
  });

  it('stops at its time budget', async () => {
    await ownerQuery(
      `insert into outbox_events (shop_id, id, topic, payload)
       select $1, gen_random_uuid(), 'test.budget', '{}' from generate_series(1, 30) g`,
      [shop.shopId],
    );
    let clock = 0;
    let rounds = 0;
    await drainOutbox(
      db,
      async () => {
        rounds++;
        clock += 1000;
      },
      { batch: 10, budgetMs: 1500, now: () => clock },
    );
    expect(rounds).toBe(2);
    // The rest waits for the next drain.
    await drainOutbox(db, async () => {}, { batch: 500 });
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
