import { ops, uuidv7Time } from '@airstock/core';
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

describe('activity history (PRD 7)', () => {
  it('links the queued attempt to the success event written with the change', async () => {
    const variantId = await createVariant(h);
    const res = await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '3',
    });
    const attempt = sink.events.find(
      (e) =>
        e.phase === 'attempt' &&
        e.action === 'inventory.receipt.created' &&
        e.target_id === null &&
        sink.events.indexOf(e) === sink.events.length - 2,
    );
    const [success] = await ownerQuery<{
      attempt_id: string;
      outcome: string;
      operation_id: string;
      target_id: string;
      changes: { quantity: string };
    }>(
      `select attempt_id, outcome, operation_id, target_id, changes from audit_events where operation_id = $1`,
      [res.operationId],
    );
    expect(success).toMatchObject({
      outcome: 'succeeded',
      target_id: variantId,
      changes: { quantity: '3' },
    });
    expect(
      sink.events.some((e) => e.phase === 'attempt' && e.attempt_id === success!.attempt_id),
    ).toBe(true);
    expect(attempt === undefined || attempt.attempt_id === success!.attempt_id).toBe(true);
  });

  it('records each read as one access event with its target', async () => {
    const variantId = await createVariant(h);
    const before = sink.events.length;
    await h.run(ops.getAvailability, { variantId });
    const added = sink.events.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      action: 'inventory.availability.viewed',
      phase: 'outcome',
      outcome: 'succeeded',
      target_type: 'variant',
      target_id: variantId,
      actor_type: 'user',
      actor_id: shop.userId,
    });
  });

  it('derives the partition time from the event ID', async () => {
    for (const e of sink.events.slice(-5)) {
      expect(uuidv7Time(e.event_id)).toBe(Date.parse(e.occurred_at));
    }
  });

  it('lists history newest first, filtered by target, after queued events are ingested', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '1' });
    await h.run(ops.getAvailability, { variantId });
    await sink.drain(db);
    const page = await h.run(ops.listActivity, {
      targetType: 'variant',
      targetId: variantId,
      limit: 2,
    });
    expect(
      page.events.map((e: { action: string; phase: string }) => `${e.action}/${e.phase}`),
    ).toEqual(['inventory.availability.viewed/outcome', 'inventory.receipt.created/outcome']);
    expect(page.nextCursor).not.toBeNull();
    const next = await h.run(ops.listActivity, {
      targetType: 'variant',
      targetId: variantId,
      before: page.nextCursor,
    });
    expect(next.events.map((e: { action: string }) => e.action)).toContain('catalog.item.created');
  });

  it('has monthly partitions only, months ahead, and no default partition', async () => {
    const rows = await ownerQuery<{ name: string; is_default: boolean }>(
      `select c.relname as name, pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT' as is_default
       from pg_inherits i join pg_class c on c.oid = i.inhrelid
       where i.inhparent = 'audit_events'::regclass`,
    );
    expect(rows.some((r) => r.is_default)).toBe(false);
    const inThreeMonths = new Date();
    inThreeMonths.setUTCMonth(inThreeMonths.getUTCMonth() + 3, 1);
    const name = `audit_events_${inThreeMonths.getUTCFullYear()}_${String(inThreeMonths.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(rows.map((r) => r.name)).toContain(name);
  });
});
