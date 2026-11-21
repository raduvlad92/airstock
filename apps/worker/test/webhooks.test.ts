import {
  execute,
  handleWebhookOutbox,
  type OutboxMessage,
  ops,
  verifyWebhookSignature,
  WebhookSecretCipher,
} from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery, type SeededShop, seedShop } from '../../../test/helpers.ts';
import { connectMcp, grantToken } from './mcp-client.ts';
import { apiToken, connectionGrant, json, type TestApp, testApp } from './setup.ts';

let t: TestApp;
const outbox: OutboxMessage[] = [];
const received: Array<{ url: string; headers: Record<string, string>; body: string }> = [];

beforeAll(async () => {
  const cipher = await WebhookSecretCipher.fromBase64(
    'test',
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
  );
  t = await testApp({
    webhookSecrets: cipher,
    // The real dispatch path: committed outbox rows go to the webhook dispatcher. Test files
    // run in parallel against one outbox, so only this file's shops are drained: draining
    // everything would take other files' rows, which they assert on themselves.
    dispatch: (db) =>
      drainOwnShops(async (messages) => {
        outbox.push(...messages);
        for (const m of messages) {
          await handleWebhookOutbox(
            {
              db,
              cipher,
              fetch: async (url, init) => {
                received.push({
                  url,
                  headers: init.headers as Record<string, string>,
                  body: String(init.body),
                });
                return new Response('ok', { status: 200 });
              },
              schedule: async () => {},
            },
            m,
          );
        }
      }),
  });
});
afterAll(() => t.close());

/** Shops seeded by this file; only their outbox rows are dispatched here. */
const ownShops = new Set<string>();
async function ownShop(name: string): Promise<SeededShop> {
  const shop = await seedShop(t.db, t.sink, name);
  ownShops.add(shop.shopId);
  return shop;
}

// Rows this file has handled. Selecting by this set, not by dispatched_at, keeps the file
// immune to another file's global drain marking its rows dispatched first.
const handled = new Set<string>();

async function drainOwnShops(publish: (messages: OutboxMessage[]) => Promise<void>) {
  let total = 0;
  for (;;) {
    const rows = await ownerQuery<{
      shop_id: string;
      id: string;
      topic: string;
      payload: unknown;
      created_at: Date;
    }>(
      `select shop_id, id, topic, payload, created_at from outbox_events
       where shop_id = any($1::uuid[]) and not (id = any($2::uuid[]))
       order by created_at, id limit 100`,
      [[...ownShops], [...handled]],
    );
    if (rows.length === 0) return total;
    await publish(
      rows.map((r) => ({
        shopId: r.shop_id,
        id: r.id,
        topic: r.topic,
        payload: r.payload,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    );
    for (const r of rows) handled.add(r.id);
    await ownerQuery('select mark_outbox_dispatched($1::uuid[])', [rows.map((r) => r.id)]);
    total += rows.length;
  }
}

describe('webhooks over REST (D14)', () => {
  it('creates a subscription with an API credential and sends a signed test', async () => {
    const shop = await ownShop('REST webhook shop');
    const { token } = await apiToken(t, shop, ['webhooks:manage']);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const types = await t.app.request(`/api/v1/shops/${shop.shopId}/webhook-event-types`, {
      headers,
    });
    expect(types.status).toBe(200);
    const listed = await json(types);
    expect(listed.eventTypes.map((e: { type: string }) => e.type)).toContain('stock.changed');
    const res = await t.app.request(`/api/v1/shops/${shop.shopId}/webhook-subscriptions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'n8n',
        url: 'https://n8n.example.com/webhook/abc',
        eventTypes: ['webhook.test'],
      }),
    });
    expect(res.status).toBe(201);
    const created = await json(res);
    const test = await t.app.request(
      `/api/v1/shops/${shop.shopId}/webhook-subscriptions/${created.subscription.subscriptionId}/test`,
      { method: 'POST', headers, body: '{}' },
    );
    expect(test.status).toBe(200);
    const sent = await json(test);
    await expect
      .poll(() => received.find((r) => JSON.parse(r.body).id === sent.eventId)?.url, {
        timeout: 10_000,
      })
      .toBe('https://n8n.example.com/webhook/abc');
    const hit = received.find((r) => JSON.parse(r.body).id === sent.eventId);
    expect(
      await verifyWebhookSignature(hit!.headers['airstock-signature'], hit!.body, [created.secret]),
    ).toMatchObject({ ok: true });
    // The receiver has the request before the sender records the answer, so the log can still say
    // "sending" for a moment.
    await expect
      .poll(
        async () => {
          const log = await t.app.request(
            `/api/v1/shops/${shop.shopId}/webhook-deliveries?subscriptionId=${created.subscription.subscriptionId}`,
            { headers },
          );
          return (await json(log)).deliveries[0];
        },
        { timeout: 10_000 },
      )
      .toMatchObject({ eventId: sent.eventId, status: 'delivered', lastStatusCode: 200 });
  });

  it('refuses a credential without the webhooks:manage scope', async () => {
    const shop = await ownShop('Scope webhook shop');
    const { token } = await apiToken(t, shop, ['shop:read', 'inventory:read']);
    const res = await t.app.request(`/api/v1/shops/${shop.shopId}/webhook-subscriptions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('never offers webhooks to an MCP connection, nor the scope at consent', async () => {
    const shop = await ownShop('MCP webhook shop');
    const grant = await connectionGrant(shop, ['shop:read', 'activity:read']);
    const session = await connectMcp(t, await grantToken(t, grant));
    const { tools } = await session.client.listTools();
    await session.close();
    // No tool or action manages webhooks (the activity filter may name the `webhooks` source).
    expect(tools.map((tool) => tool.name).join(' ')).not.toMatch(/webhook/i);
    for (const tool of tools) {
      const action = (tool.inputSchema.properties as Record<string, { enum?: string[] }>)?.action;
      expect((action?.enum ?? []).join(' '), tool.name).not.toMatch(/webhook/i);
    }
    await expect(
      execute({ db: t.db, audit: t.sink }, ops.createConnection, {
        caller: shop.caller,
        shopId: shop.shopId,
        input: { scopes: ['webhooks:manage'] },
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
