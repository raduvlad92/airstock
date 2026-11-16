import {
  type AnyOperation,
  announceStockChanged,
  attemptWebhookDelivery,
  type Caller,
  catalogChangeEmit,
  checkWebhookUrl,
  execute,
  generateWebhookSecret,
  handleWebhookOutbox,
  type OutboxMessage,
  ops,
  recoverWebhookDeliveries,
  runExportJob,
  sampleEnvelope,
  sendWebhookDisabledEmail,
  sweepWebhookHistory,
  uuidv7,
  verifyWebhookSignature,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_RETRY_SCHEDULE_SECONDS,
  type WebhookDeliveryMessage,
  type WebhookDeps,
  WebhookSecretCipher,
  webhookEvent,
  webhookSignatureHeader,
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

// biome-ignore lint/suspicious/noExplicitAny: tests read many different result shapes
type Any = any;

const db = appDatabase();
const sink = new MemoryAuditSink();
let cipher: WebhookSecretCipher;

const DAY = 24 * 60 * 60 * 1000;

/** A receiving endpoint: records every request and answers with the configured status. */
class Endpoint {
  readonly requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  status = 200;
  body = 'ok';
  error: Error | null = null;
  readonly inits: RequestInit[] = [];

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    this.inits.push(init);
    this.requests.push({
      url,
      headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>)),
      body: String(init.body),
    });
    if (this.error) throw this.error;
    return new Response(this.body, { status: this.status });
  };

  forUrl(url: string) {
    return this.requests.filter((r) => r.url === url);
  }
}

interface Rig {
  shop: SeededShop;
  h: Harness;
  endpoint: Endpoint;
  scheduled: Array<{ message: WebhookDeliveryMessage; delaySeconds: number }>;
  /** Null runs on real time; a number freezes the dispatcher's clock there. */
  clock: { now: number | null };
  deps: WebhookDeps;
  run(op: AnyOperation, input: unknown, caller?: Caller): Promise<Any>;
  /** Hands this shop's new outbox rows to the webhook dispatcher, as the jobs consumer does. */
  dispatch(): Promise<void>;
}

async function rig(name: string): Promise<Rig> {
  const shop = await seedShop(db, sink, name);
  const h = harness(db, sink, shop);
  const endpoint = new Endpoint();
  const scheduled: Rig['scheduled'] = [];
  const clock: Rig['clock'] = { now: null };
  const deps: WebhookDeps = {
    db,
    cipher,
    fetch: endpoint.fetch,
    schedule: async (message, delaySeconds) => {
      scheduled.push({ message, delaySeconds });
    },
    now: () => clock.now ?? Date.now(),
  };
  const handled = new Set<string>();
  return {
    shop,
    h,
    endpoint,
    scheduled,
    clock,
    deps,
    async run(op, input, caller = shop.caller) {
      const res = await execute({ db, audit: sink, webhookSecrets: cipher }, op, {
        caller,
        shopId: shop.shopId,
        input,
        idempotencyKey: op.idempotency === 'required' ? uuidv7() : null,
      });
      return res.result;
    },
    async dispatch() {
      // Other test files dispatch the outbox in parallel, so read rows whether or not someone
      // marked them dispatched, and remember which ones this rig handled.
      const rows = await ownerQuery<{
        id: string;
        topic: string;
        payload: unknown;
        created_at: Date;
      }>(
        'select id, topic, payload, created_at from outbox_events where shop_id = $1 order by created_at, id',
        [shop.shopId],
      );
      for (const r of rows) {
        if (handled.has(r.id)) continue;
        handled.add(r.id);
        const message: OutboxMessage = {
          shopId: shop.shopId,
          id: r.id,
          topic: r.topic,
          payload: r.payload,
          createdAt: new Date(r.created_at).toISOString(),
        };
        if (!(await handleWebhookOutbox(deps, message))) {
          if (r.topic === 'inventory.availability_changed')
            await announceStockChanged(deps, message);
        }
      }
    },
  };
}

async function deliveries(shopId: string) {
  return ownerQuery<{
    id: string;
    subscription_id: string;
    event_id: string;
    status: string;
    attempts: number;
    next_attempt_at: Date | null;
    last_status_code: number | null;
    last_error: string | null;
    last_response: string | null;
    replay_of: string | null;
  }>('select * from webhook_deliveries where shop_id = $1 order by created_at, id', [shopId]);
}

beforeAll(async () => {
  cipher = await WebhookSecretCipher.fromBase64(
    'test',
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
  );
});
afterAll(() => db.close());

describe('webhook signing (plan 7.1, webhook signing)', () => {
  const body = JSON.stringify({ id: 'e1', type: 'webhook.test', data: {} });

  it('signs "<t>.<body>" with HMAC-SHA256 and verifies within the tolerance', async () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const header = await webhookSignatureHeader([secret], t, body);
    expect(header).toMatch(new RegExp(`^t=${t},v1=[0-9a-f]{64}$`));
    // The same computation a consumer does with Node's crypto (docs/webhooks.md).
    const { createHmac } = await import('node:crypto');
    const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    expect(header).toBe(`t=${t},v1=${expected}`);
    expect(await verifyWebhookSignature(header, body, [secret], { now })).toEqual({
      ok: true,
      timestamp: t,
    });
    expect(await verifyWebhookSignature(header, `${body} `, [secret], { now })).toMatchObject({
      ok: false,
      reason: 'no_match',
    });
    expect(await verifyWebhookSignature(header, body, [generateWebhookSecret()], { now })).toEqual({
      ok: false,
      reason: 'no_match',
    });
  });

  it('rejects timestamps outside the tolerance, both ways', async () => {
    const secret = generateWebhookSecret();
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const header = await webhookSignatureHeader([secret], t, body);
    expect(
      await verifyWebhookSignature(header, body, [secret], { now: now + 301_000 }),
    ).toMatchObject({ ok: false, reason: 'too_old' });
    expect(
      await verifyWebhookSignature(header, body, [secret], { now: now - 301_000 }),
    ).toMatchObject({ ok: false, reason: 'too_new' });
    expect(
      await verifyWebhookSignature(header, body, [secret], { now: now + 299_000 }),
    ).toMatchObject({ ok: true });
    expect(await verifyWebhookSignature('v1=abc', body, [secret], { now })).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });

  it('carries both signatures during a rotation, so either secret verifies', async () => {
    const [current, previous] = [generateWebhookSecret(), generateWebhookSecret()];
    const now = Date.now();
    const header = await webhookSignatureHeader([current, previous], Math.floor(now / 1000), body);
    expect(header.split(',').filter((p) => p.startsWith('v1='))).toHaveLength(2);
    expect(await verifyWebhookSignature(header, body, [current], { now })).toMatchObject({
      ok: true,
    });
    expect(await verifyWebhookSignature(header, body, [previous], { now })).toMatchObject({
      ok: true,
    });
  });

  it('encrypts secrets bound to their shop and subscription', async () => {
    const sealed = await cipher.encrypt('whsec_x', 'airstock:webhook-secret:v1:a:b');
    expect(await cipher.decrypt(sealed, 'airstock:webhook-secret:v1:a:b')).toBe('whsec_x');
    await expect(cipher.decrypt(sealed, 'airstock:webhook-secret:v1:a:c')).rejects.toThrow();
  });
});

describe('webhook URLs (plan 5.13, safety)', () => {
  it.each([
    ['http://hooks.example.com/x', 'HTTPS'],
    ['ftp://hooks.example.com/x', 'HTTPS'],
    ['not a url', 'full URL'],
    ['https://user:pass@hooks.example.com/x', 'credentials'],
    ['https://localhost/x', 'internal'],
    ['https://LOCALHOST./x', 'internal'],
    ['https://api.localhost/x', 'internal'],
    ['https://n8n.local/x', 'internal'],
    ['https://metadata.google.internal/x', 'internal'],
    ['https://router.home.arpa/x', 'internal'],
    ['https://intranet/x', 'internal'],
    ['https://127.0.0.1/x', 'private'],
    ['https://2130706433/x', 'private'],
    ['https://0x7f.1/x', 'private'],
    ['https://10.1.2.3/x', 'private'],
    ['https://172.16.0.1/x', 'private'],
    ['https://172.31.255.255/x', 'private'],
    ['https://192.168.1.10:8443/x', 'private'],
    ['https://169.254.169.254/latest', 'private'],
    ['https://100.64.0.1/x', 'private'],
    ['https://0.0.0.0/x', 'private'],
    ['https://198.18.0.1/x', 'private'],
    ['https://203.0.113.5/x', 'private'],
    ['https://224.0.0.1/x', 'private'],
    ['https://255.255.255.255/x', 'private'],
    ['https://[::1]/x', 'private'],
    ['https://[::]/x', 'private'],
    ['https://[::ffff:127.0.0.1]/x', 'private'],
    ['https://[::ffff:10.0.0.1]/x', 'private'],
    ['https://[fe80::1]/x', 'private'],
    ['https://[fd00::1]/x', 'private'],
    ['https://[fc00::1]/x', 'private'],
    ['https://[2001:db8::1]/x', 'private'],
    ['https://[ff02::1]/x', 'private'],
    ['https://[64:ff9b::a00:1]/x', 'private'],
  ])('refuses %s', (url, why) => {
    const checked = checkWebhookUrl(url);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toMatch(new RegExp(why, 'i'));
  });

  it.each([
    'https://hooks.example.com/webhook/abc',
    'https://n8n.example.org:5678/webhook/8c1e',
    'https://8.8.8.8/x',
    'https://172.32.0.1/x',
    'https://[2606:4700::1111]/x',
    'https://[::ffff:8.8.8.8]/x',
  ])('accepts %s', (url) => {
    expect(checkWebhookUrl(url).ok).toBe(true);
  });
});

describe('event-type registry (plan 7.1, webhook settings)', () => {
  it('gives every type a description, a permission, and a sample that matches its schema', () => {
    const ids = WEBHOOK_EVENT_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'stock.changed',
        'catalog.item.changed',
        'job.completed',
        'webhook.test',
        'alert.opened',
        'alert.resolved',
        'reservation.shortage',
        'transfer.status_changed',
        'purchase_order.status_changed',
        'return.status_changed',
        'shopify.sync_conflict',
      ]),
    );
    for (const type of WEBHOOK_EVENT_TYPES) {
      expect(type.description.length, type.id).toBeGreaterThan(20);
      expect(type.data.safeParse(type.sample).success, type.id).toBe(true);
      expect(sampleEnvelope(type)).toMatchObject({ type: type.id, api_version: 'v1' });
    }
    expect(WEBHOOK_EVENT_TYPES.filter((t) => t.status === 'available').map((t) => t.id)).toEqual([
      'stock.changed',
      'catalog.item.changed',
      'job.completed',
      'webhook.test',
      'purchase_order.status_changed',
    ]);
    expect(() => webhookEvent('stock.change', {})).toThrow(/Unknown webhook event type/);
  });

  it('derives catalog.item.changed from a catalog command’s committed events', () => {
    const event = (action: string, target_type: string, target_id: string) =>
      ({ action, target_type, target_id, phase: 'outcome', outcome: 'succeeded' }) as Any;
    const p = uuidv7();
    const v = uuidv7();
    expect(catalogChangeEmit('inventory.receipts.create', [event('x', 'variant', v)])).toBeNull();
    expect(
      catalogChangeEmit('catalog.items.create', [
        event('catalog.item.created', 'variant', v),
        event('catalog.item.updated', 'variant', v),
        event('catalog.item.created', 'product', p),
        event('catalog.media.reordered', 'media', uuidv7()),
      ]),
    ).toEqual({
      type: 'catalog.item.changed',
      input: {
        operation: 'catalog.items.create',
        items: [
          { type: 'variant', id: v, change: 'created' },
          { type: 'product', id: p, change: 'created' },
        ],
        truncated: false,
      },
    });
  });
});

describe('subscriptions, fan-out, and delivery', () => {
  let r: Rig;
  let secondLocation: string;

  beforeAll(async () => {
    r = await rig('Webhook shop');
    secondLocation = await createLeafLocation(r.h, r.shop.warehouseId, 'Back room');
  });

  it('creates a subscription, shows the secret once, and records the change without it', async () => {
    const created = await r.run(ops.createWebhookSubscription, {
      name: 'All stock',
      url: 'https://hooks.example.com/all/8c1e-secret-path',
      eventTypes: ['stock.changed', 'webhook.test'],
    });
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.subscription).toMatchObject({
      name: 'All stock',
      eventTypes: ['stock.changed', 'webhook.test'],
      status: 'active',
      secretHint: created.secret.slice(-4),
      filters: { locationIds: [], alertKinds: [] },
    });
    const list = await r.run(ops.listWebhookSubscriptions, {});
    expect(JSON.stringify(list)).not.toContain(created.secret);
    const [row] = await ownerQuery<{ secret_ciphertext: string }>(
      'select secret_ciphertext from webhook_subscriptions where id = $1',
      [created.subscription.subscriptionId],
    );
    expect(row!.secret_ciphertext).not.toContain(created.secret);
    await sink.drain(db);
    const [event] = await ownerQuery<{ changes: Any }>(
      `select changes from audit_events where shop_id = $1 and action = 'webhook.subscription.created'`,
      [r.shop.shopId],
    );
    expect(event!.changes.url).toBe('https://hooks.example.com/all/…');
    expect(JSON.stringify(event)).not.toContain(created.secret);
    expect(JSON.stringify(sink.events)).not.toContain(created.secret);
  });

  it('refuses unsafe URLs, unknown or coming types, and types the person cannot see', async () => {
    await expect(
      r.run(ops.createWebhookSubscription, {
        name: 'x',
        url: 'https://192.168.0.5/hook',
        eventTypes: ['stock.changed'],
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      r.run(ops.createWebhookSubscription, {
        name: 'x',
        url: 'https://hooks.example.com/x',
        eventTypes: ['alert.opened'],
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      extra: { errors: [{ path: 'eventTypes.0', message: 'alert.opened is not available yet.' }] },
    });
    await expect(
      r.run(ops.createWebhookSubscription, {
        name: 'x',
        url: 'https://hooks.example.com/x',
        eventTypes: ['nope'],
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const editor = await addMember(r.shop.shopId, 'catalog_editor');
    await expect(
      r.run(
        ops.createWebhookSubscription,
        { name: 'x', url: 'https://hooks.example.com/x', eventTypes: ['catalog.item.changed'] },
        editor.caller,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('sends each subscription only its chosen types and filters, signed', async () => {
    const all = (await r.run(ops.listWebhookSubscriptions, {})).subscriptions[0];
    const backRoom = await r.run(ops.createWebhookSubscription, {
      name: 'Back room only',
      url: 'https://hooks.example.com/back',
      eventTypes: ['stock.changed'],
      filters: { locationIds: [secondLocation] },
    });
    const warehouse = await r.run(ops.createWebhookSubscription, {
      name: 'Whole warehouse',
      url: 'https://hooks.example.com/warehouse',
      eventTypes: ['stock.changed'],
      filters: { locationIds: [r.shop.warehouseId] },
    });
    const catalog = await r.run(ops.createWebhookSubscription, {
      name: 'Catalog',
      url: 'https://hooks.example.com/catalog',
      eventTypes: ['catalog.item.changed'],
    });
    const variantId = await createVariant(r.h, 'WH-SKU-1');
    await r.dispatch();
    // The catalog subscription got the new item; stock subscriptions got nothing.
    const catalogHits = r.endpoint.forUrl('https://hooks.example.com/catalog');
    expect(catalogHits).toHaveLength(1);
    const catalogBody = JSON.parse(catalogHits[0]!.body);
    expect(catalogBody).toMatchObject({
      type: 'catalog.item.changed',
      shop_id: r.shop.shopId,
      api_version: 'v1',
      data: {
        operation: 'catalog.items.create',
        items: expect.arrayContaining([
          expect.objectContaining({
            change: 'created',
            variant: expect.objectContaining({ id: variantId, sku: 'WH-SKU-1' }),
          }),
        ]),
      },
    });
    expect(
      await verifyWebhookSignature(
        catalogHits[0]!.headers['airstock-signature'],
        catalogHits[0]!.body,
        [catalog.secret],
      ),
    ).toMatchObject({ ok: true });
    expect(catalogHits[0]!.headers['airstock-event-id']).toBe(catalogBody.id);
    expect(r.endpoint.inits.at(-1)).toMatchObject({ method: 'POST', redirect: 'manual' });

    await r.h.run(ops.receiveStock, { variantId, locationId: r.shop.locationId, quantity: '7' });
    await r.dispatch();
    expect(r.endpoint.forUrl(all.url)).toHaveLength(1);
    expect(r.endpoint.forUrl('https://hooks.example.com/back')).toHaveLength(0);
    expect(r.endpoint.forUrl('https://hooks.example.com/warehouse')).toHaveLength(1);
    const stock = JSON.parse(r.endpoint.forUrl(all.url)[0]!.body);
    expect(stock).toMatchObject({
      type: 'stock.changed',
      data: {
        truncated: false,
        positions: [
          expect.objectContaining({
            variantId,
            sku: 'WH-SKU-1',
            onHand: '7.000000',
            reserved: '0.000000',
            available: '7.000000',
            condition: 'sellable',
            location: expect.objectContaining({ id: r.shop.locationId }),
            version: expect.any(Number),
          }),
        ],
      },
    });

    await r.h.run(ops.receiveStock, { variantId, locationId: secondLocation, quantity: '2' });
    await r.dispatch();
    expect(r.endpoint.forUrl(all.url)).toHaveLength(2);
    expect(r.endpoint.forUrl('https://hooks.example.com/back')).toHaveLength(1);
    expect(r.endpoint.forUrl('https://hooks.example.com/warehouse')).toHaveLength(2);
    const back = r.endpoint.forUrl('https://hooks.example.com/back')[0]!;
    expect(
      await verifyWebhookSignature(back.headers['airstock-signature'], back.body, [
        backRoom.secret,
      ]),
    ).toMatchObject({ ok: true });
    expect(
      await verifyWebhookSignature(back.headers['airstock-signature'], back.body, [
        warehouse.secret,
      ]),
    ).toMatchObject({ ok: false });
    expect(r.endpoint.forUrl('https://hooks.example.com/catalog')).toHaveLength(1);

    // A redelivered outbox message fans out once.
    const before = (await deliveries(r.shop.shopId)).length;
    const [row] = await ownerQuery<{ id: string; payload: unknown; created_at: Date }>(
      `select id, payload, created_at from outbox_events
       where shop_id = $1 and topic = 'inventory.availability_changed' order by created_at desc limit 1`,
      [r.shop.shopId],
    );
    await announceStockChanged(r.deps, {
      shopId: r.shop.shopId,
      id: row!.id,
      payload: row!.payload,
      createdAt: new Date(row!.created_at).toISOString(),
    });
    expect(await deliveries(r.shop.shopId)).toHaveLength(before);

    // Each outcome is one audit event, by the system, from webhooks.
    const outcomes = await ownerQuery<{ outcome: string; actor_type: string; source: string }>(
      `select outcome, actor_type, source from audit_events
       where shop_id = $1 and action = 'webhook.delivery'`,
      [r.shop.shopId],
    );
    expect(outcomes.length).toBe((await deliveries(r.shop.shopId)).length);
    expect(outcomes.every((o) => o.outcome === 'succeeded' && o.actor_type === 'system')).toBe(
      true,
    );
    expect(outcomes.every((o) => o.source === 'webhooks')).toBe(true);
  });

  it('writes no webhook outbox row for a type nobody subscribes to', async () => {
    const quiet = await rig('Quiet webhook shop');
    await createVariant(quiet.h, 'QUIET-1');
    const rows = await ownerQuery(
      `select 1 from outbox_events where shop_id = $1 and topic = 'webhook.event'`,
      [quiet.shop.shopId],
    );
    expect(rows).toHaveLength(0);
  });

  it('sends nothing for a rolled-back transaction (A11)', async () => {
    const owner = await boundCaller(r.shop);
    const variantId = await createVariant(r.h, 'WH-ROLLBACK');
    await r.dispatch();
    const sent = r.endpoint.requests.length;
    const faulty = appDatabase({
      beforeCommit: () => {
        throw new Error('simulated crash before commit');
      },
    });
    await expect(
      execute({ db: faulty, audit: sink }, ops.receiveStock, {
        caller: owner,
        shopId: r.shop.shopId,
        input: { variantId, locationId: r.shop.locationId, quantity: '5' },
        idempotencyKey: uuidv7(),
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    await expect(
      execute({ db: faulty, audit: sink }, ops.createItem, {
        caller: owner,
        shopId: r.shop.shopId,
        input: { name: 'Never committed', sku: 'WH-NEVER' },
        idempotencyKey: uuidv7(),
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    await faulty.close();
    await r.dispatch();
    expect(r.endpoint.requests.length).toBe(sent);
  });
});

describe('retries, replays, and auto-disable', () => {
  let r: Rig;
  let sub: Any;
  let variantId: string;

  beforeAll(async () => {
    r = await rig('Failing webhook shop');
    sub = await r.run(ops.createWebhookSubscription, {
      name: 'Flaky',
      url: 'https://hooks.example.com/flaky',
      eventTypes: ['stock.changed', 'webhook.test'],
    });
    variantId = await createVariant(r.h, 'RETRY-1');
  });

  it('retries after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, and 24 h, with the same event ID, then fails', async () => {
    r.endpoint.status = 503;
    r.endpoint.body = 'x'.repeat(5000);
    await r.h.run(ops.receiveStock, { variantId, locationId: r.shop.locationId, quantity: '1' });
    const start = Date.now();
    r.clock.now = start;
    await r.dispatch();
    const [delivery] = await deliveries(r.shop.shopId);
    expect(delivery).toMatchObject({ status: 'retrying', attempts: 1, last_status_code: 503 });
    expect(delivery!.last_response).toHaveLength(1024);
    let elapsed = 0;
    for (const [i, delay] of WEBHOOK_RETRY_SCHEDULE_SECONDS.entries()) {
      // Each failure queued the next attempt with its delay (capped at the queue's 12 hours).
      expect(r.scheduled.at(-1)).toEqual({
        message: { webhookDelivery: { shopId: r.shop.shopId, deliveryId: delivery!.id } },
        delaySeconds: Math.min(delay, 43_200),
      });
      const [row] = await deliveries(r.shop.shopId);
      elapsed += delay;
      expect(new Date(row!.next_attempt_at!).getTime()).toBe(start + elapsed * 1000);
      // Too early: not sent, queued again for the rest of the wait.
      r.clock.now = start + (elapsed - delay / 2) * 1000;
      expect(await attemptWebhookDelivery(r.deps, r.shop.shopId, delivery!.id)).toBe('not_due');
      r.clock.now = start + elapsed * 1000;
      const result = await attemptWebhookDelivery(r.deps, r.shop.shopId, delivery!.id);
      expect(result).toBe(i === WEBHOOK_RETRY_SCHEDULE_SECONDS.length - 1 ? 'failed' : 'retrying');
    }
    const [done] = await deliveries(r.shop.shopId);
    expect(done).toMatchObject({ status: 'failed', attempts: 8, next_attempt_at: null });
    const sent = r.endpoint.forUrl(sub.subscription.url);
    expect(sent).toHaveLength(8);
    expect(new Set(sent.map((s) => s.headers['airstock-event-id'])).size).toBe(1);
    expect(new Set(sent.map((s) => JSON.parse(s.body).id))).toEqual(new Set([done!.event_id]));
    // A finished delivery is not sent again by a late message.
    expect(await attemptWebhookDelivery(r.deps, r.shop.shopId, delivery!.id)).toBe('done');
    const events = await ownerQuery<{ outcome: string; context: Any }>(
      `select outcome, context from audit_events where shop_id = $1 and action = 'webhook.delivery'
       and target_id = $2 order by occurred_at`,
      [r.shop.shopId, delivery!.id],
    );
    expect(events.map((e) => e.outcome)).toEqual(Array(8).fill('failed'));
    expect(events.at(-1)!.context).toMatchObject({ attempt: 8, final: true, statusCode: 503 });
  });

  it('replays with the same event ID as a new delivery (A19)', async () => {
    r.clock.now = null;
    r.endpoint.status = 200;
    const [original] = await deliveries(r.shop.shopId);
    const replay = await r.run(ops.replayWebhookDelivery, { deliveryId: original!.id });
    expect(replay.delivery).toMatchObject({
      replayOf: original!.id,
      eventId: original!.event_id,
      status: 'pending',
    });
    await r.dispatch();
    const last = r.endpoint.requests.at(-1)!;
    expect(last.headers['airstock-event-id']).toBe(original!.event_id);
    expect(last.headers['airstock-delivery-id']).toBe(replay.delivery.deliveryId);
    const log = await r.run(ops.listWebhookDeliveries, {
      subscriptionId: sub.subscription.subscriptionId,
    });
    expect(log.deliveries[0]).toMatchObject({
      deliveryId: replay.delivery.deliveryId,
      status: 'delivered',
      attempts: 1,
      lastStatusCode: 200,
    });
    // Consumers deduplicate by event ID: the original and the replay are one effect.
    const seen = new Set(r.endpoint.forUrl(sub.subscription.url).map((s) => JSON.parse(s.body).id));
    expect(seen.size).toBe(1);
    const detail = await r.run(ops.getWebhookDelivery, { deliveryId: replay.delivery.deliveryId });
    expect(detail.payload).toMatchObject({ id: original!.event_id, type: 'stock.changed' });
  });

  it('sends a test once, flagged, without touching the failure streak', async () => {
    r.endpoint.status = 500;
    const before = await r.run(ops.listWebhookSubscriptions, {});
    const test = await r.run(ops.testWebhookSubscription, {
      subscriptionId: sub.subscription.subscriptionId,
    });
    await r.dispatch();
    const last = r.endpoint.requests.at(-1)!;
    expect(last.headers['airstock-test']).toBe('1');
    expect(JSON.parse(last.body)).toMatchObject({
      id: test.eventId,
      type: 'webhook.test',
      test: true,
      data: { subscription: { id: sub.subscription.subscriptionId, name: 'Flaky' } },
    });
    const [row] = (await deliveries(r.shop.shopId)).filter(
      (d) => d.id === test.delivery.deliveryId,
    );
    expect(row).toMatchObject({ status: 'failed', attempts: 1, next_attempt_at: null });
    const after = await r.run(ops.listWebhookSubscriptions, {});
    expect(after.subscriptions[0].failingSince).toBe(before.subscriptions[0].failingSince);
    // A sample of another type, on request.
    const sample = await r.run(ops.testWebhookSubscription, {
      subscriptionId: sub.subscription.subscriptionId,
      eventType: 'catalog.item.changed',
    });
    await r.dispatch();
    expect(JSON.parse(r.endpoint.requests.at(-1)!.body)).toMatchObject({
      id: sample.eventId,
      type: 'catalog.item.changed',
      test: true,
      data: { operation: 'catalog.items.update' },
    });
  });

  it('signs with both secrets during a rotation, then only the new one', async () => {
    r.endpoint.status = 200;
    const rotated = await r.run(ops.rotateWebhookSecret, {
      subscriptionId: sub.subscription.subscriptionId,
      overlapHours: 24,
    });
    expect(rotated.secret).not.toBe(sub.secret);
    expect(rotated.subscription.previousSecretExpiresAt).not.toBeNull();
    await r.run(ops.testWebhookSubscription, { subscriptionId: sub.subscription.subscriptionId });
    await r.dispatch();
    const during = r.endpoint.requests.at(-1)!;
    const sig = during.headers['airstock-signature']!;
    expect(sig.split(',').filter((p) => p.startsWith('v1='))).toHaveLength(2);
    expect(await verifyWebhookSignature(sig, during.body, [sub.secret])).toMatchObject({
      ok: true,
    });
    expect(await verifyWebhookSignature(sig, during.body, [rotated.secret])).toMatchObject({
      ok: true,
    });
    const again = await r.run(ops.rotateWebhookSecret, {
      subscriptionId: sub.subscription.subscriptionId,
      overlapHours: 0,
    });
    await r.run(ops.testWebhookSubscription, { subscriptionId: sub.subscription.subscriptionId });
    await r.dispatch();
    const after = r.endpoint.requests.at(-1)!;
    const only = after.headers['airstock-signature']!;
    expect(only.split(',').filter((p) => p.startsWith('v1='))).toHaveLength(1);
    expect(await verifyWebhookSignature(only, after.body, [again.secret])).toMatchObject({
      ok: true,
    });
    expect(await verifyWebhookSignature(only, after.body, [rotated.secret])).toMatchObject({
      ok: false,
    });
  });

  it('records timeouts, refused redirects, and lost connections as failures', async () => {
    const cases: Array<[() => void, RegExp]> = [
      [
        () => {
          r.endpoint.error = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        },
        /No response within 10 seconds/,
      ],
      [
        () => {
          r.endpoint.error = new TypeError('fetch failed');
        },
        /Could not connect/,
      ],
      [
        () => {
          r.endpoint.error = null;
          r.endpoint.status = 302;
        },
        /Redirects are not followed \(HTTP 302\)/,
      ],
    ];
    for (const [arrange, message] of cases) {
      arrange();
      const test = await r.run(ops.testWebhookSubscription, {
        subscriptionId: sub.subscription.subscriptionId,
      });
      await r.dispatch();
      const [row] = (await deliveries(r.shop.shopId)).filter(
        (d) => d.id === test.delivery.deliveryId,
      );
      expect(row!.status).toBe('failed');
      expect(row!.last_error).toMatch(message);
    }
    r.endpoint.status = 200;
  });

  it('disables a subscription failing for 3 days and queues the owner email', async () => {
    r.endpoint.status = 500;
    await r.h.run(ops.receiveStock, { variantId, locationId: r.shop.locationId, quantity: '1' });
    r.clock.now = Date.now();
    await r.dispatch();
    let subs = await r.run(ops.listWebhookSubscriptions, {});
    expect(subs.subscriptions[0]).toMatchObject({ status: 'active' });
    expect(subs.subscriptions[0].failingSince).not.toBeNull();
    await r.h.run(ops.receiveStock, { variantId, locationId: r.shop.locationId, quantity: '1' });
    r.clock.now = Date.now() + 3 * DAY + 1000;
    await r.dispatch();
    subs = await r.run(ops.listWebhookSubscriptions, {});
    expect(subs.subscriptions[0]).toMatchObject({ status: 'disabled', disabledReason: 'failing' });
    const queued = await ownerQuery<{ payload: Any }>(
      `select payload from outbox_events where shop_id = $1 and topic = 'email.webhook_disabled'`,
      [r.shop.shopId],
    );
    expect(queued).toEqual([{ payload: { subscriptionId: sub.subscription.subscriptionId } }]);
    const [audit] = await ownerQuery<{ actor_type: string; source: string }>(
      `select actor_type, source from audit_events where shop_id = $1 and action = 'webhook.subscription.disabled'`,
      [r.shop.shopId],
    );
    expect(audit).toEqual({ actor_type: 'system', source: 'webhooks' });
    const sent: Any[] = [];
    expect(
      await sendWebhookDisabledEmail(
        {
          db,
          email: {
            send: async (email) => {
              sent.push(email);
              return { id: `msg-${sent.length}` };
            },
          },
          publicUrl: 'https://airstock.test',
        },
        r.shop.shopId,
        sub.subscription.subscriptionId,
      ),
    ).toBe(1);
    expect(sent[0]).toMatchObject({
      subject: expect.stringContaining('Flaky'),
      idempotencyKey: expect.stringContaining(
        `webhook-disabled/${sub.subscription.subscriptionId}/`,
      ),
    });
    // Pending retries of a disabled subscription are cancelled when they come due; a replay is
    // refused until it is turned on again.
    const open = (await deliveries(r.shop.shopId)).filter((d) => d.status === 'retrying');
    expect(open).toHaveLength(2);
    r.clock.now = Date.now() + 5 * DAY;
    for (const d of open) {
      expect(await attemptWebhookDelivery(r.deps, r.shop.shopId, d.id)).toBe('cancelled');
    }
    await expect(
      r.run(ops.replayWebhookDelivery, { deliveryId: open[0]!.id }),
    ).rejects.toMatchObject({ code: 'webhook_disabled' });
    const enabled = await r.run(ops.setWebhookSubscriptionStatus, {
      subscriptionId: sub.subscription.subscriptionId,
      status: 'active',
    });
    expect(enabled.subscription).toMatchObject({ status: 'active', failingSince: null });
  });

  it('recovers lost retries and sweeps history older than 30 days', async () => {
    r.clock.now = null;
    const test = await r.run(ops.testWebhookSubscription, {
      subscriptionId: sub.subscription.subscriptionId,
    });
    // As if the sender stopped mid-attempt: the lease ran out.
    await ownerQuery(
      `update webhook_deliveries set status = 'sending', lease_until = now() - interval '1 minute'
       where id = $1`,
      [test.delivery.deliveryId],
    );
    const recovered = await recoverWebhookDeliveries(db, 500);
    expect(recovered).toContainEqual({
      webhookDelivery: { shopId: r.shop.shopId, deliveryId: test.delivery.deliveryId },
    });
    await ownerQuery(
      `update webhook_deliveries set created_at = now() - interval '31 days', status = 'delivered'
       where id = $1`,
      [test.delivery.deliveryId],
    );
    await ownerQuery(
      `update webhook_events set created_at = now() - interval '31 days' where id = $1`,
      [test.eventId],
    );
    expect(await sweepWebhookHistory(db)).toBeGreaterThanOrEqual(1);
    expect(
      await ownerQuery('select 1 from webhook_deliveries where id = $1', [
        test.delivery.deliveryId,
      ]),
    ).toHaveLength(0);
    expect(
      await ownerQuery('select 1 from webhook_events where id = $1', [test.eventId]),
    ).toHaveLength(0);
  });
});

describe('job.completed', () => {
  it('announces a finished export to subscribers', async () => {
    const r = await rig('Job webhook shop');
    await r.run(ops.createWebhookSubscription, {
      name: 'Jobs',
      url: 'https://hooks.example.com/jobs',
      eventTypes: ['job.completed'],
    });
    await createVariant(r.h, 'JOB-1');
    const created = await r.run(ops.createExport, { mode: 'variants' });
    const files = new Map<string, string>();
    await runExportJob(
      {
        db,
        audit: sink,
        files: {
          get: async (k) => files.get(k) ?? null,
          put: async (k, b) => {
            files.set(k, b);
          },
          delete: async (k) => {
            files.delete(k);
          },
        },
      },
      r.shop.shopId,
      created.export.exportId,
    );
    await r.dispatch();
    const hits = r.endpoint.forUrl('https://hooks.example.com/jobs');
    expect(hits).toHaveLength(1);
    expect(JSON.parse(hits[0]!.body)).toMatchObject({
      type: 'job.completed',
      data: { job: { kind: 'export', id: created.export.exportId, status: 'completed', rows: 1 } },
    });
  });
});

describe('isolation and location scope', () => {
  it('keeps subscriptions and deliveries inside their shop (A13)', async () => {
    const a = await rig('Webhook shop A');
    const b = await rig('Webhook shop B');
    const sub = await a.run(ops.createWebhookSubscription, {
      name: 'A only',
      url: 'https://hooks.example.com/a',
      eventTypes: ['webhook.test'],
    });
    const test = await a.run(ops.testWebhookSubscription, {
      subscriptionId: sub.subscription.subscriptionId,
    });
    // B's owner names A's records inside B: nothing is found, nothing changes.
    const id = sub.subscription.subscriptionId;
    for (const [op, input] of [
      [ops.updateWebhookSubscription, { subscriptionId: id, name: 'taken' }],
      [ops.rotateWebhookSecret, { subscriptionId: id }],
      [ops.setWebhookSubscriptionStatus, { subscriptionId: id, status: 'disabled' }],
      [ops.deleteWebhookSubscription, { subscriptionId: id }],
      [ops.testWebhookSubscription, { subscriptionId: id }],
      [ops.replayWebhookDelivery, { deliveryId: test.delivery.deliveryId }],
      [ops.getWebhookDelivery, { deliveryId: test.delivery.deliveryId }],
    ] as const) {
      await expect(b.run(op, input)).rejects.toMatchObject({ code: 'not_found' });
    }
    expect((await b.run(ops.listWebhookSubscriptions, {})).subscriptions).toEqual([]);
    expect((await b.run(ops.listWebhookDeliveries, {})).deliveries).toEqual([]);
    // B's owner naming A's shop is refused outright.
    await expect(
      execute({ db, audit: sink, webhookSecrets: cipher }, ops.listWebhookSubscriptions, {
        caller: b.shop.caller,
        shopId: a.shop.shopId,
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // Row-level security: B's transaction sees none of A's rows.
    const seen = await db.transaction({ shopId: b.shop.shopId, userId: null }, async (tx) => [
      ...(await tx.query('select 1 from webhook_subscriptions where id = $1', [id])),
      ...(await tx.query('select 1 from webhook_events where id = $1', [test.eventId])),
      ...(await tx.query('select 1 from webhook_deliveries where id = $1', [
        test.delivery.deliveryId,
      ])),
    ]);
    expect(seen).toEqual([]);
    const after = await a.run(ops.listWebhookSubscriptions, {});
    expect(after.subscriptions[0]).toMatchObject({ name: 'A only', status: 'active' });
  });

  it('lets a location-scoped manager manage only webhooks filtered to their locations (A42)', async () => {
    const r = await rig('Scoped webhook shop');
    const store = await createLeafLocation(r.h, r.shop.warehouseId, 'Store');
    const other = await createLeafLocation(r.h, r.shop.warehouseId, 'Other');
    const manager = await addMember(r.shop.shopId, 'manager', [store]);
    const unfiltered = await r.run(ops.createWebhookSubscription, {
      name: 'Everything',
      url: 'https://hooks.example.com/everything',
      eventTypes: ['stock.changed'],
    });
    await expect(
      r.run(
        ops.createWebhookSubscription,
        { name: 'Mine', url: 'https://hooks.example.com/mine', eventTypes: ['stock.changed'] },
        manager.caller,
      ),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
    await expect(
      r.run(
        ops.createWebhookSubscription,
        {
          name: 'Other',
          url: 'https://hooks.example.com/other',
          eventTypes: ['stock.changed'],
          filters: { locationIds: [other] },
        },
        manager.caller,
      ),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
    const mine = await r.run(
      ops.createWebhookSubscription,
      {
        name: 'Mine',
        url: 'https://hooks.example.com/mine',
        eventTypes: ['stock.changed'],
        filters: { locationIds: [store] },
      },
      manager.caller,
    );
    const listed = await r.run(ops.listWebhookSubscriptions, {}, manager.caller);
    expect(listed.subscriptions.map((s: Any) => s.subscriptionId)).toEqual([
      mine.subscription.subscriptionId,
    ]);
    await expect(
      r.run(
        ops.setWebhookSubscriptionStatus,
        { subscriptionId: unfiltered.subscription.subscriptionId, status: 'disabled' },
        manager.caller,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    // Viewers do not hold webhooks.manage.
    const viewer = await addMember(r.shop.shopId, 'viewer');
    await expect(r.run(ops.listWebhookSubscriptions, {}, viewer.caller)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
