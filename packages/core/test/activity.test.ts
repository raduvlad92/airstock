import {
  type AuditEvent,
  type Caller,
  execute,
  type FileAccess,
  ops,
  runExportJob,
  uuidv7,
} from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
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
import { parseCsv } from '../src/csv.ts';

// I5 (D15): activity filters (PRD 7.4), location-scoped history (A42), the operation lifecycle,
// the ingestion delay, the activity export, and isolation between shops (A13). Assertions name
// only this file's shops: other files write to the same database at the same time.

const db = appDatabase();
const sink = new MemoryAuditSink();
const stored = new Map<string, string>();
const files: FileAccess = {
  get: async (k) => stored.get(k) ?? null,
  put: async (k, body) => {
    stored.set(k, body);
  },
  delete: async (k) => {
    stored.delete(k);
  },
};

let shop: SeededShop;
let other: SeededShop;
let h: Harness;
let hb: Harness;
/** A second warehouse and its location, outside the scoped member's warehouse. */
let farWarehouse: string;
let farLocation: string;
/** A bin inside the shop's first warehouse. */
let bin: string;
let variantId: string;
let scoped: { userId: string; membershipId: string; caller: Caller };
let credential: Caller;
let connection: Caller;
const receipts: Record<'home' | 'bin' | 'far', { operationId: string }> = {} as never;

const run = (op: Parameters<typeof execute>[1], input: unknown, caller = shop.caller) =>
  execute({ db, audit: sink, files }, op, {
    caller,
    shopId: shop.shopId,
    input,
    idempotencyKey: op.idempotency === 'required' ? uuidv7() : null,
  }).then((r) => r.result as never);

interface Page {
  events: Array<{
    eventId: string;
    action: string;
    phase: string;
    outcome: string;
    source: string;
    actorType: string;
    actorId: string | null;
    targetType: string | null;
    targetId: string | null;
    attemptId: string | null;
    operationId: string | null;
    locationIds: string[] | null;
    changes: unknown;
  }>;
  nextCursor: string | null;
  lifecycle: {
    attemptId: string;
    action: string | null;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    events: number;
    problems: number;
  } | null;
  ingestion: { delayed: boolean; pendingRequests: number } | null;
}

/** The activity list as `caller` sees it, after the queue has delivered this file's events. */
async function list(input: Record<string, unknown>, caller = shop.caller): Promise<Page> {
  await sink.drain(db);
  return run(ops.listActivity, { limit: 100, ...input }, caller);
}

const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    return error as { status: number; code: string };
  }
  throw new Error('Expected a rejection.');
};

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Activity shop');
  other = await seedShop(db, sink, 'Activity other shop');
  h = harness(db, sink, shop);
  hb = harness(db, sink, other);
  bin = await createLeafLocation(h, shop.warehouseId, 'Bin A');
  farWarehouse = (await h.run(ops.createWarehouse, { name: 'Far site' })).warehouseId;
  farLocation = await createLeafLocation(h, farWarehouse, 'Far shelf');
  variantId = await createVariant(h);
  receipts.home = await h.run(ops.receiveStock, {
    variantId,
    locationId: shop.locationId,
    quantity: '5',
  });
  receipts.bin = await h.run(ops.receiveStock, { variantId, locationId: bin, quantity: '2' });
  receipts.far = await h.run(ops.receiveStock, {
    variantId,
    locationId: farLocation,
    quantity: '7',
  });
  scoped = await addMember(shop.shopId, 'inventory_operator', [shop.warehouseId]);
  const owner = await boundCaller(shop);
  credential = {
    ...owner,
    kind: 'api_credential',
    id: uuidv7(),
    source: 'api',
    scopes: new Set(['shop:read', 'catalog:read', 'inventory:read', 'activity:read']),
  };
  connection = {
    ...owner,
    kind: 'connection',
    id: uuidv7(),
    clientId: 'activity-test-client',
    grantId: uuidv7(),
    source: 'mcp',
    scopes: new Set(['shop:read', 'catalog:read', 'inventory:read', 'activity:read']),
  };
  await run(ops.getAvailability, { variantId }, credential);
  await run(ops.getAvailability, { variantId }, connection);
  // A refusal: the scoped member may not receive into the far warehouse.
  await rejects(
    run(ops.receiveStock, { variantId, locationId: farLocation, quantity: '1' }, scoped.caller),
  );
  // A validation failure.
  await rejects(run(ops.receiveStock, { variantId, locationId: bin, quantity: 'lots' }));
  // The other shop's history, with the same kinds of events.
  const otherVariant = await createVariant(hb);
  await hb.run(ops.receiveStock, {
    variantId: otherVariant,
    locationId: other.locationId,
    quantity: '9',
  });
});
afterAll(() => db.close());

describe('activity filters (PRD 7.4)', () => {
  it('filters by actor: a member, an API credential, and actor type', async () => {
    const mine = await list({ actorId: scoped.userId }, shop.caller);
    expect(mine.events.length).toBeGreaterThan(0);
    expect(mine.events.every((e) => e.actorId === scoped.userId)).toBe(true);
    const viaKey = await list({ actorId: credential.id });
    expect(viaKey.events.map((e) => e.action)).toEqual(['inventory.availability.viewed']);
    const keys = await list({ actorType: 'api_credential' });
    expect(keys.events.every((e) => e.actorType === 'api_credential')).toBe(true);
    expect(keys.events.some((e) => e.actorId === credential.id)).toBe(true);
  });

  it('filters by integration: by its ID or by the client behind a connection', async () => {
    const byId = await list({ integration: connection.id });
    expect(byId.events.map((e) => e.actorId)).toEqual([connection.id]);
    const byClient = await list({ integration: 'activity-test-client' });
    expect(byClient.events.map((e) => e.actorId)).toEqual([connection.id]);
  });

  it('filters by source', async () => {
    const mcp = await list({ source: 'mcp' });
    expect(mcp.events.map((e) => e.actorId)).toEqual([connection.id]);
    const api = await list({ source: 'api' });
    expect(api.events.every((e) => e.source === 'api')).toBe(true);
    // A source the shop never used finds nothing, without reading its history.
    expect((await list({ source: 'shopify' })).events).toEqual([]);
  });

  it('filters by date range', async () => {
    // Up to now: each list adds its own access event after this.
    const end = new Date(Date.now() + 1).toISOString();
    const all = await list({ to: end });
    const middle = all.events[Math.floor(all.events.length / 2)]!;
    const at = (
      await ownerQuery<{ t: Date }>(
        'select occurred_at as t from audit_events where event_id = $1',
        [middle.eventId],
      )
    )[0]!.t.toISOString();
    const before = await list({ to: at });
    const after = await list({ from: at, to: end });
    expect(before.events.length + after.events.length).toBe(all.events.length);
    expect(after.events.map((e) => e.eventId)).toContain(middle.eventId);
    expect(before.events.map((e) => e.eventId)).not.toContain(middle.eventId);
  });

  it('filters by target', async () => {
    const page = await list({ targetType: 'variant', targetId: variantId });
    expect(page.events.length).toBeGreaterThanOrEqual(4);
    expect(page.events.every((e) => e.targetId === variantId)).toBe(true);
  });

  it('filters by action, several actions, and action groups', async () => {
    const receipts = await list({ action: 'inventory.receipt.created', phase: 'outcome' });
    expect(new Set(receipts.events.map((e) => e.action))).toEqual(
      new Set(['inventory.receipt.created']),
    );
    const two = await list({ action: 'inventory.receipt.created, storage.warehouse.created' });
    expect(new Set(two.events.map((e) => e.action))).toEqual(
      new Set(['inventory.receipt.created', 'storage.warehouse.created']),
    );
    const group = await list({ action: 'storage.*' });
    expect(group.events.length).toBeGreaterThan(0);
    expect(group.events.every((e) => e.action.startsWith('storage.'))).toBe(true);
    expect(group.events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['storage.warehouse.created', 'storage.location.created']),
    );
    // A group the shop has no events in, and every action.
    expect((await list({ action: 'inventory.transfer.*' })).events).toEqual([]);
    const end = new Date(Date.now() + 1).toISOString();
    expect((await list({ action: '*', to: end })).events.length).toBe(
      (await list({ to: end })).events.length,
    );
    expect((await rejects(list({ action: Array(21).fill('a.b').join(',') }))).status).toBe(400);
  });

  it('filters by outcome and phase', async () => {
    const denied = await list({ outcome: 'denied' });
    expect(denied.events.map((e) => e.action)).toEqual(['inventory.receipt.created']);
    expect(denied.events[0]!.actorId).toBe(scoped.userId);
    const failed = await list({ outcome: 'failed', action: 'inventory.*' });
    expect(failed.events).toHaveLength(1);
    const attempts = await list({ phase: 'attempt', action: 'inventory.receipt.created' });
    expect(attempts.events.every((e) => e.phase === 'attempt' && e.outcome === 'received')).toBe(
      true,
    );
  });

  it('filters by warehouse or location, including the warehouse’s own events', async () => {
    const far = await list({ locationId: farWarehouse, action: 'inventory.*,storage.*' });
    const farActions = far.events.map((e) => `${e.action}/${e.outcome}`);
    // The receipt there, the refusal there, the location created there, and the warehouse.
    expect(farActions).toEqual(
      expect.arrayContaining([
        'inventory.receipt.created/succeeded',
        'inventory.receipt.created/denied',
        'storage.location.created/succeeded',
        'storage.warehouse.created/succeeded',
      ]),
    );
    expect(far.events.some((e) => e.operationId === receipts.home.operationId)).toBe(false);
    // The shop's first warehouse covers its bin; the bin alone does not cover the warehouse's
    // default location.
    const home = await list({ locationId: shop.warehouseId, action: 'inventory.receipt.created' });
    const ops_ = home.events.map((e) => e.operationId);
    expect(ops_).toEqual(
      expect.arrayContaining([receipts.home.operationId, receipts.bin.operationId]),
    );
    expect(ops_).not.toContain(receipts.far.operationId);
    const binOnly = await list({ locationId: bin, action: 'inventory.receipt.created' });
    expect(binOnly.events.map((e) => e.operationId).filter(Boolean)).toEqual([
      receipts.bin.operationId,
    ]);
  });

  it('filters by batch (one request) and by inventory operation', async () => {
    const [receipt] = (await list({ operationId: receipts.bin.operationId, phase: 'outcome' }))
      .events;
    expect(receipt?.operationId).toBe(receipts.bin.operationId);
    const batch = await list({ attemptId: receipt!.attemptId! });
    expect(batch.events.map((e) => e.phase).sort()).toEqual(['attempt', 'outcome']);
    expect(batch.events.every((e) => e.attemptId === receipt!.attemptId)).toBe(true);
  });

  it('combines filters, pages with a cursor, and records the filters in the access event', async () => {
    const first = await list({ actorId: shop.userId, from: '2020-01-01T00:00:00Z', limit: 3 });
    expect(first.events).toHaveLength(3);
    expect(first.ingestion).not.toBeNull();
    const second: Page = await run(
      ops.listActivity,
      { actorId: shop.userId, from: '2020-01-01T00:00:00Z', limit: 3, before: first.nextCursor },
      shop.caller,
    );
    expect(second.ingestion).toBeNull();
    const ids = [...first.events, ...second.events].map((e) => e.eventId);
    expect(new Set(ids).size).toBe(6);
    const viewed = sink.events.filter(
      (e) => e.action === 'activity.viewed' && e.shop_id === shop.shopId,
    );
    expect(viewed.at(-1)!.context).toMatchObject({
      filters: { actorId: shop.userId, from: '2020-01-01T00:00:00Z' },
      returned: 3,
    });
  });
});

describe('location-scoped history (A42)', () => {
  it('shows a member limited to one warehouse only history about it or no location', async () => {
    const page = await list({}, scoped.caller);
    const opIds = page.events.map((e) => e.operationId).filter(Boolean);
    expect(opIds).toEqual(
      expect.arrayContaining([receipts.home.operationId, receipts.bin.operationId]),
    );
    expect(opIds).not.toContain(receipts.far.operationId);
    // The far warehouse and its location are not even listed as records.
    expect(page.events.some((e) => e.targetId === farWarehouse)).toBe(false);
    expect(page.events.some((e) => e.targetId === farLocation)).toBe(false);
    // Locations outside the scope are never named.
    for (const e of page.events) {
      for (const id of e.locationIds ?? []) expect([shop.locationId, bin]).toContain(id);
    }
    // Events about no location (catalog work) stay visible.
    expect(page.events.some((e) => e.action === 'catalog.item.created')).toBe(true);
  });

  it('applies the scope to every filter, the warehouse filter and a batch included', async () => {
    expect((await list({ locationId: farWarehouse }, scoped.caller)).events).toEqual([]);
    expect((await list({ operationId: receipts.far.operationId }, scoped.caller)).events).toEqual(
      [],
    );
    const [far] = (await list({ operationId: receipts.far.operationId, phase: 'outcome' })).events;
    const batch = await list({ attemptId: far!.attemptId! }, scoped.caller);
    expect(batch.events).toEqual([]);
    expect(batch.lifecycle).toBeNull();
    // Its own refusal there names the far location, so it is hidden from the member too.
    const denied = await list({ outcome: 'denied' }, scoped.caller);
    expect(denied.events).toEqual([]);
  });

  it('records the locations a command touches on its attempt and outcome', async () => {
    const attempts = sink.events.filter(
      (e) =>
        e.shop_id === shop.shopId &&
        e.action === 'inventory.receipt.created' &&
        e.phase === 'attempt',
    );
    expect(attempts.map((e) => e.location_ids)).toEqual(
      expect.arrayContaining([[shop.locationId], [bin], [farLocation]]),
    );
    // A command whose locations the database names (a release finds them through the
    // reservation): its attempt says "not known yet", the outcome names them.
    const reserved = await h.run(ops.reserveStock, {
      variantId,
      quantity: '1',
      locationId: farLocation,
    });
    await h.run(ops.releaseReservation, { reservationId: reserved.reservationId });
    const release = sink.events.filter(
      (e) => e.shop_id === shop.shopId && e.action === 'inventory.reservation.released',
    );
    const attempt = release.find((e) => e.phase === 'attempt')!;
    expect(attempt.location_ids).toEqual([]);
    const [outcome] = await ownerQuery<{ location_ids: string[] }>(
      `select location_ids from audit_events where shop_id = $1 and attempt_id = $2 and phase = 'outcome'`,
      [shop.shopId, attempt.attempt_id],
    );
    expect(outcome?.location_ids).toEqual([farLocation]);
    // Hidden from the scoped member in the timeline and as a batch.
    expect((await list({ attemptId: attempt.attempt_id! }, scoped.caller)).events).toEqual([]);
    expect(
      (await list({ action: 'inventory.reservation.released' }, scoped.caller)).events,
    ).toEqual([]);
  });

  it('shows a request’s attempt with unknown locations when the request is in scope', async () => {
    const reserved = await h.run(ops.reserveStock, {
      variantId,
      quantity: '1',
      locationId: shop.locationId,
    });
    await h.run(ops.releaseReservation, { reservationId: reserved.reservationId });
    const attempt = sink.events.findLast(
      (e) =>
        e.shop_id === shop.shopId &&
        e.action === 'inventory.reservation.released' &&
        e.phase === 'attempt',
    )!;
    const batch = await list({ attemptId: attempt.attempt_id! }, scoped.caller);
    expect(batch.events.map((e) => e.phase).sort()).toEqual(['attempt', 'outcome']);
    expect(batch.lifecycle).toMatchObject({ status: 'succeeded', events: 2 });
    // In the plain timeline the attempt stays hidden: nothing there says where it was.
    const timeline = await list({ action: 'inventory.reservation.released' }, scoped.caller);
    expect(timeline.events.map((e) => e.phase)).toEqual(['outcome']);
  });
});

describe('operation lifecycle', () => {
  it('follows a request from attempt to outcome', async () => {
    const res = await h.run(ops.receiveStock, { variantId, locationId: bin, quantity: '1' });
    const [outcome] = (await list({ operationId: res.operationId, phase: 'outcome' })).events;
    const page = await list({ attemptId: outcome!.attemptId! });
    expect(page.lifecycle).toMatchObject({
      attemptId: outcome!.attemptId,
      action: 'inventory.receipt.created',
      status: 'succeeded',
      events: 2,
      problems: 0,
    });
    expect(page.lifecycle!.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(page.lifecycle!.finishedAt!)).toBeGreaterThanOrEqual(
      Date.parse(page.lifecycle!.startedAt!),
    );
  });

  it('shows a failed request with its problem, and one still pending', async () => {
    await rejects(run(ops.receiveStock, { variantId, locationId: uuidv7(), quantity: '1' }));
    const failed = sink.events.findLast(
      (e) => e.shop_id === shop.shopId && e.phase === 'outcome' && e.outcome === 'failed',
    )!;
    const page = await list({ attemptId: failed.attempt_id! });
    expect(page.lifecycle).toMatchObject({ status: 'failed', problems: 1, events: 2 });

    // Only the attempt has arrived: the outcome is not recorded yet.
    const attemptId = uuidv7();
    sink.events.push(pendingAttempt(attemptId));
    const pending = await list({ attemptId });
    expect(pending.lifecycle).toMatchObject({ status: 'pending', finishedAt: null, events: 1 });
  });
});

/** An attempt event as the pipeline sends it, for a request whose outcome is not written yet. */
function pendingAttempt(attemptId: string): AuditEvent {
  const template = sink.events.find(
    (e) => e.shop_id === shop.shopId && e.phase === 'attempt' && e.actor_id === shop.userId,
  )!;
  return {
    ...structuredClone(template),
    event_id: uuidv7(),
    occurred_at: new Date().toISOString(),
    attempt_id: attemptId,
    request_id: uuidv7(),
    action: 'catalog.item.updated',
    location_ids: null,
  };
}

describe('ingestion delay (PRD 7.3)', () => {
  it('says the history is behind while a command’s queued attempt has not arrived', async () => {
    const res = await h.run(ops.receiveStock, { variantId, locationId: bin, quantity: '1' });
    // Hold back this command's attempt, as a slow queue would.
    const held = sink.events.findLast(
      (e) => e.shop_id === shop.shopId && e.phase === 'attempt' && e.operation_id === null,
    )!;
    sink.events.splice(sink.events.indexOf(held), 1);
    await ownerQuery(
      `update audit_events set occurred_at = occurred_at - interval '30 seconds'
       where shop_id = $1 and operation_id = $2`,
      [shop.shopId, res.operationId],
    );
    const behind = await list({});
    expect(behind.ingestion).toMatchObject({ delayed: true, pendingRequests: 1 });
    // The queue delivers it.
    sink.events.push(held);
    const caughtUp = await list({});
    expect(caughtUp.ingestion!.pendingRequests).toBe(0);
    // The other shop's backlog is its own.
    expect((await run(ops.listActivity, {}, shop.caller)) as Page).toBeTruthy();
  });

  it('records each delivered batch’s wait, ignoring redelivered events', async () => {
    const event = { ...pendingAttempt(uuidv7()), occurred_at: new Date().toISOString() };
    event.event_id = uuidv7();
    await db.transaction({ shopId: null, userId: null }, (tx) =>
      tx.query('select ingest_audit_events($1)', [JSON.stringify([event])]),
    );
    const [status] = await ownerQuery<{ last_batch_lag_ms: number; last_batch_events: number }>(
      'select last_batch_lag_ms, last_batch_events from audit_ingestion_status',
    );
    expect(status!.last_batch_events).toBeGreaterThanOrEqual(1);
    // Delivering the same event again adds nothing and leaves the status alone.
    const [again] = await db.transaction({ shopId: null, userId: null }, (tx) =>
      tx.query<{ n: number }>('select ingest_audit_events($1) as n', [JSON.stringify([event])]),
    );
    expect(again!.n).toBe(0);
  });
});

describe('activity export', () => {
  it('writes the filtered history as CSV, as a logged job', async () => {
    const created = (await run(ops.createActivityExport, {
      action: 'inventory.receipt.created',
      phase: 'outcome',
    })) as { export: { exportId: string; status: string } };
    expect(created.export.status).toBe('pending');
    await runExportJob({ db, audit: sink, files }, shop.shopId, created.export.exportId);
    const done = (await run(ops.getExport, { exportId: created.export.exportId })) as {
      export: { status: string; rowCount: number; downloadPath: string | null };
    };
    expect(done.export.status).toBe('completed');
    const csv = stored.get(`shops/${shop.shopId}/exports/${created.export.exportId}.csv`)!;
    const rows = parseCsv(csv.replace(/^﻿/, ''));
    expect(rows[0]!.slice(0, 5)).toEqual(['occurred_at', 'event_id', 'action', 'phase', 'outcome']);
    expect(rows.length - 1).toBe(done.export.rowCount);
    expect(
      rows.slice(1).every((r) => r[2] === 'inventory.receipt.created' && r[3] === 'outcome'),
    ).toBe(true);
    const download = (await run(ops.downloadExport, { exportId: created.export.exportId })) as {
      fileName: string;
    };
    expect(download.fileName).toMatch(/^airstock-activity-/);
    // Created, completed, and downloaded: each is in the history.
    await sink.drain(db);
    const logged = await ownerQuery<{ action: string; outcome: string }>(
      `select action, outcome from audit_events
       where shop_id = $1 and target_type = 'export' and target_id = $2 and phase = 'outcome'
       order by occurred_at`,
      [shop.shopId, created.export.exportId],
    );
    expect(logged.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'activity.export.created',
        'activity.export.completed',
        'catalog.export.downloaded',
      ]),
    );
  });

  it('exports what the member may see: their scope', async () => {
    const manager = await addMember(shop.shopId, 'manager', [shop.warehouseId]);
    const created = (await run(
      ops.createActivityExport,
      { action: 'inventory.receipt.created', phase: 'outcome' },
      manager.caller,
    )) as { export: { exportId: string } };
    await runExportJob({ db, audit: sink, files }, shop.shopId, created.export.exportId);
    const csv = stored.get(`shops/${shop.shopId}/exports/${created.export.exportId}.csv`)!;
    expect(csv).toContain(receipts.home.operationId);
    expect(csv).not.toContain(receipts.far.operationId);
    expect(csv).not.toContain(farLocation);
  });

  it('needs the exports permission, and logs a failure when the member has left', async () => {
    // An inventory operator reads the history but does not run exports.
    const refused = await rejects(run(ops.createActivityExport, {}, scoped.caller));
    expect(refused.status).toBe(403);
    const manager = await addMember(shop.shopId, 'manager');
    const created = (await run(ops.createActivityExport, {}, manager.caller)) as {
      export: { exportId: string };
    };
    await ownerQuery(`update memberships set status = 'removed' where shop_id = $1 and id = $2`, [
      shop.shopId,
      manager.membershipId,
    ]);
    await runExportJob({ db, audit: sink, files }, shop.shopId, created.export.exportId);
    const done = (await run(ops.getExport, { exportId: created.export.exportId })) as {
      export: { status: string };
    };
    expect(done.export.status).toBe('failed');
    expect(
      sink.events.some(
        (e) =>
          e.action === 'activity.export.failed' &&
          e.target_id === created.export.exportId &&
          e.outcome === 'denied',
      ),
    ).toBe(true);
  });
});

describe('isolation between shops (A13)', () => {
  it('never lists another shop’s events, even when its IDs are the filters', async () => {
    const theirs = await ownerQuery<{ attempt_id: string; actor_id: string; operation_id: string }>(
      `select attempt_id, actor_id, operation_id from audit_events
       where shop_id = $1 and operation_id is not null limit 1`,
      [other.shopId],
    );
    expect(theirs).toHaveLength(1);
    const t = theirs[0]!;
    for (const filters of [
      { attemptId: t.attempt_id },
      { operationId: t.operation_id },
      { actorId: t.actor_id },
      { locationId: other.warehouseId },
      { targetType: 'shop', targetId: other.shopId },
    ]) {
      const page = await list(filters);
      expect(page.events).toEqual([]);
    }
    const mine = await list({});
    expect(mine.events.length).toBeGreaterThan(0);
    const ids = mine.events.map((e) => e.eventId);
    const [leak] = await ownerQuery<{ n: number }>(
      'select count(*)::int as n from audit_events where event_id = any($1::uuid[]) and shop_id <> $2',
      [ids, shop.shopId],
    );
    expect(leak!.n).toBe(0);
  });

  it('refuses another shop’s history to a member of this one', async () => {
    const res = await rejects(
      execute({ db, audit: sink, files }, ops.listActivity, {
        caller: scoped.caller,
        shopId: other.shopId,
        input: {},
        idempotencyKey: null,
      }),
    );
    expect([403, 404]).toContain(res.status);
  });
});
