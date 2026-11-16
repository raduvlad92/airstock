import {
  dispatchOutbox,
  execute,
  handleWebhookOutbox,
  type OutboxMessage,
  ops,
  verifyWebhookSignature,
  WebhookSecretCipher,
} from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedShop } from '../../../test/helpers.ts';
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
    // The real dispatch path: committed outbox rows go to the webhook dispatcher.
    dispatch: (db) =>
      dispatchOutbox(db, async (messages) => {
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

describe('webhooks over REST (D14)', () => {
  it('creates a subscription with an API credential and sends a signed test', async () => {
    const shop = await seedShop(t.db, t.sink, 'REST webhook shop');
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
    await new Promise((r) => setTimeout(r, 50));
    const hit = received.find((r) => JSON.parse(r.body).id === sent.eventId);
    expect(hit?.url).toBe('https://n8n.example.com/webhook/abc');
    expect(
      await verifyWebhookSignature(hit!.headers['airstock-signature'], hit!.body, [created.secret]),
    ).toMatchObject({ ok: true });
    const log = await t.app.request(
      `/api/v1/shops/${shop.shopId}/webhook-deliveries?subscriptionId=${created.subscription.subscriptionId}`,
      { headers },
    );
    expect((await json(log)).deliveries[0]).toMatchObject({
      eventId: sent.eventId,
      status: 'delivered',
      lastStatusCode: 200,
    });
  });

  it('refuses a credential without the webhooks:manage scope', async () => {
    const shop = await seedShop(t.db, t.sink, 'Scope webhook shop');
    const { token } = await apiToken(t, shop, ['shop:read', 'inventory:read']);
    const res = await t.app.request(`/api/v1/shops/${shop.shopId}/webhook-subscriptions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('never offers webhooks to an MCP connection, nor the scope at consent', async () => {
    const shop = await seedShop(t.db, t.sink, 'MCP webhook shop');
    const grant = await connectionGrant(shop, ['shop:read', 'activity:read']);
    const session = await connectMcp(t, await grantToken(t, grant));
    const { tools } = await session.client.listTools();
    await session.close();
    expect(JSON.stringify(tools)).not.toMatch(/webhook/i);
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
