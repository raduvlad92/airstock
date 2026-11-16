import { AppError, errors, execute, ops, sessionCaller, uuidv7 } from '@airstock/core';
import {
  authorizeUrl,
  completeInstall,
  connectedStore,
  isShopDomain,
  matchBySku,
  NotConnectedError,
  normalizeShopDomain,
  ORDER_TOPICS,
  PRODUCT_TOPICS,
  receiveWebhook,
  releaseRedactedStore,
  type ShopifyConfig,
  type SyncDeps,
  verifyQueryHmac,
  verifyWebhookHmac,
} from '@airstock/shopify';
import type { Context, Hono } from 'hono';
import { type AppDeps, type AppEnv, problem } from './app.ts';
import { messagePage } from './html.ts';
import {
  clearCookie,
  constantTimeEqual,
  cookie,
  nowSeconds,
  readCookie,
  seal,
  unseal,
} from './session.ts';
import { readSession, sameOrigin, type WebConfig } from './web.ts';

/** Shopify app settings (plan Section 8). Off until the client ID, secret, and token key are set. */
export interface ShopifyAppConfig extends ShopifyConfig {
  clientId: string;
  /** App client secret: verifies webhooks and the OAuth redirect. */
  apiSecret: string;
  /** https://…/shopify/oauth/callback, registered in the app settings. */
  redirectUri: string;
}

/** A job row to run, sent to the jobs queue after the row commits. */
export interface JobMessage {
  job: { shopId: string; jobId: string };
}

const INSTALL_COOKIE = '__Host-airstock_shopify';
const INSTALL_TTL_SECONDS = 10 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Topics Airstock subscribes to. Others are acknowledged and ignored. */
const HANDLED_TOPICS = new Set([...ORDER_TOPICS, ...PRODUCT_TOPICS, 'app/uninstalled']);
/**
 * Shopify's mandatory privacy webhooks. Airstock stores no customer data (order and line
 * references only), so a data request or customer redaction has nothing to return or erase;
 * shop/redact arrives after an uninstall, when the tokens are already gone. Each is verified,
 * logged, and acknowledged.
 */
const PRIVACY_TOPICS = new Set(['customers/data_request', 'customers/redact', 'shop/redact']);
// shop/redact also releases what an uninstalled store's orders still hold (packages/shopify).

interface InstallFlow {
  state: string;
  shopId: string;
  shopDomain: string;
  uid: string;
  exp: number;
}

function redirect(location: string, cookies: string[] = [], status = 302): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status, headers });
}

export function mountShopify(app: Hono<AppEnv>, deps: AppDeps): void {
  const shopify = deps.shopify;
  if (!shopify) return;
  const syncDeps = (c: Context<AppEnv>): SyncDeps => ({
    db: c.get('db'),
    audit: c.get('audit'),
    logger: deps.logger,
    shopify,
    dispatch: deps.dispatch ? () => deps.dispatch!(c.get('db')) : undefined,
  });

  // Webhooks are authenticated by their HMAC alone. One that fails is answered 401 before
  // anything is recorded or queued (plan P3).
  app.post('/shopify/webhooks', async (c) => {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const verified = await verifyWebhookHmac(
      raw,
      c.req.header('x-shopify-hmac-sha256'),
      shopify.apiSecret,
    );
    if (!verified) return problem(errors.unauthenticated(), c.get('requestId'));
    const topic = c.req.header('x-shopify-topic') ?? '';
    const shopDomain = c.req.header('x-shopify-shop-domain') ?? '';
    const webhookId = c.req.header('x-shopify-webhook-id') ?? null;
    const eventId = c.req.header('x-shopify-event-id') ?? webhookId;
    if (PRIVACY_TOPICS.has(topic)) {
      deps.logger.info?.('shopify_privacy_webhook', { topic, shopDomain });
      // The store is gone for good: what its orders still hold here is released (Shopify
      // retries the webhook if this fails; releasing twice changes nothing).
      if (topic === 'shop/redact' && isShopDomain(shopDomain)) {
        await releaseRedactedStore(syncDeps(c), { shopDomain, requestId: c.get('requestId') });
      }
      return c.body(null, 200);
    }
    if (!HANDLED_TOPICS.has(topic)) return c.body(null, 200);
    if (!isShopDomain(shopDomain) || !eventId || eventId.length > 200) {
      return problem(
        errors.validation([{ path: 'headers', message: 'Missing Shopify webhook headers.' }]),
        c.get('requestId'),
      );
    }
    const outcome = await receiveWebhook(syncDeps(c), {
      shopDomain,
      topic,
      eventId,
      webhookId,
      triggeredAt: c.req.header('x-shopify-triggered-at') ?? null,
      body: new TextDecoder().decode(raw),
      requestId: c.get('requestId'),
    });
    if (outcome.status === 'unknown_store') {
      deps.logger.error('shopify_webhook_unknown_store', { topic });
    } else if (outcome.jobId) {
      const message: JobMessage = { job: { shopId: outcome.shopId, jobId: outcome.jobId } };
      // The job row is committed. Run it right after answering Shopify; the queued copy, delayed
      // a minute, finds it done. If both fail, the scheduled sweep sends it again.
      await deps.jobs
        ?.send(message, deps.runJobNow ? 60 : undefined)
        .catch((error) => deps.logger.error('job_enqueue_failed', { error: String(error) }));
      if (deps.runJobNow) {
        const run = deps
          .runJobNow(message)
          .catch((error) => deps.logger.error('job_inline_failed', { error: String(error) }));
        try {
          c.executionCtx.waitUntil(run);
        } catch {
          // No execution context outside Workers (tests): the run simply continues.
        }
      }
    }
    return c.body(null, 200);
  });

  // The app URL Shopify opens from its admin. Airstock is not embedded: go to the dashboard.
  app.get('/shopify/app', (_c) => redirect('/app'));

  const web: WebConfig | null = deps.web;
  if (!web) return;

  // Install starts from the dashboard, for one shop. The flow cookie ties Shopify's redirect to
  // this browser and this user, so an install link cannot connect someone else's store to the
  // shop of whoever made the link.
  app.get('/shopify/install', async (c) => {
    const session = await readSession(c, web);
    const self = `/shopify/install?${new URL(c.req.url).searchParams.toString()}`;
    if (!session) return redirect(`/auth/login?return_to=${encodeURIComponent(self)}`);
    const shopId = c.req.query('shop_id') ?? '';
    const shopDomain = normalizeShopDomain(c.req.query('shop') ?? '');
    if (!UUID.test(shopId) || !shopDomain) {
      return messagePage(
        'Check the store address',
        'Enter a store such as my-store.myshopify.com.',
      );
    }
    const flow: InstallFlow = {
      state: crypto.randomUUID(),
      shopId,
      shopDomain,
      uid: session.uid,
      exp: nowSeconds() + INSTALL_TTL_SECONDS,
    };
    return redirect(
      authorizeUrl({
        shopDomain,
        clientId: shopify.clientId,
        redirectUri: shopify.redirectUri,
        state: flow.state,
      }),
      [
        cookie(
          INSTALL_COOKIE,
          await seal(web.sessionSecret, 'shopify-install', flow),
          INSTALL_TTL_SECONDS,
        ),
      ],
    );
  });

  app.get('/shopify/oauth/callback', async (c) => {
    const params = new URL(c.req.url).searchParams;
    const timestamp = Number(params.get('timestamp'));
    if (
      !(await verifyQueryHmac(params, shopify.apiSecret)) ||
      !Number.isFinite(timestamp) ||
      Math.abs(nowSeconds() - timestamp) > 600
    ) {
      return messagePage('Install not verified', 'Start the connection again from the dashboard.');
    }
    const flow = await unseal<InstallFlow>(
      web.sessionSecret,
      'shopify-install',
      readCookie(c.req.header('cookie'), INSTALL_COOKIE),
    );
    const session = await readSession(c, web);
    const state = params.get('state') ?? '';
    const code = params.get('code') ?? '';
    if (
      !flow ||
      !session ||
      flow.uid !== session.uid ||
      !constantTimeEqual(flow.state, state) ||
      params.get('shop') !== flow.shopDomain ||
      !code
    ) {
      return messagePage('Install expired', 'Start the connection again from the dashboard.');
    }
    try {
      const done = await completeInstall(syncDeps(c), {
        caller: sessionCaller(session.uid),
        shopId: flow.shopId,
        shopDomain: flow.shopDomain,
        code,
        requestId: c.get('requestId'),
      });
      const failed = done.webhooks.filter((w) => w.status === 'failed');
      if (failed.length > 0 || done.missingScopes.length > 0) {
        deps.logger.error('shopify_install_incomplete', {
          webhooks: failed.map((w) => `${w.topic}: ${w.message ?? ''}`),
          missingScopes: done.missingScopes,
        });
      }
      return redirect(
        `/app/shops/${flow.shopId}/integrations/shopify?connected=${done.connectionId}`,
        [clearCookie(INSTALL_COOKIE)],
        303,
      );
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        return messagePage('Store not connected', error.message, error.status);
      }
      throw error;
    }
  });

  // Map by SKU from the dashboard: reads the store's variants, matches SKUs, and runs
  // shopify.mappings.set as the signed-in user.
  app.post('/shopify/connections/:connectionId/map', async (c) => {
    const requestId = c.get('requestId');
    if (c.req.header('x-airstock-request') !== '1' || !sameOrigin(c, web)) {
      return problem(errors.unauthenticated(), requestId);
    }
    const session = await readSession(c, web);
    if (!session) return problem(errors.unauthenticated(), requestId);
    const connectionId = c.req.param('connectionId');
    const body = (await c.req.json().catch(() => null)) as {
      shopId?: unknown;
      locationId?: unknown;
      shopifyLocationId?: unknown;
    } | null;
    const shopId = typeof body?.shopId === 'string' ? body.shopId : '';
    if (!UUID.test(connectionId) || !UUID.test(shopId)) throw errors.notFound('Shopify connection');
    const caller = sessionCaller(session.uid);
    const pipeline = syncDeps(c);
    // Check the permission before reading the store, not only when the mapping is written.
    const context = await execute(pipeline, ops.getShopContext, {
      caller,
      shopId,
      input: {},
      requestId,
    });
    const { permissions } = context.result as { permissions: string[] };
    if (!permissions.includes('connections.manage')) {
      throw errors.forbidden('Requires the connections.manage permission.');
    }
    let store: Awaited<ReturnType<typeof connectedStore>>;
    try {
      store = await connectedStore(pipeline, shopId, connectionId);
    } catch (error) {
      if (error instanceof NotConnectedError) {
        throw errors.conflict('shopify_not_connected', 'This Shopify store is not connected.');
      }
      throw error;
    }
    const match = await matchBySku(pipeline, store);
    if (body?.locationId === undefined) {
      // Variants only: the location maps stay as they are (several Shopify locations).
      const mapped =
        match.variants.length > 0
          ? await execute(pipeline, ops.mapShopifyVariants, {
              caller,
              shopId,
              idempotencyKey: uuidv7(),
              requestId,
              input: {
                connectionId,
                variants: match.variants.map((v) => ({ ...v, source: 'sku' })),
              },
            })
          : null;
      await pipeline.dispatch?.().catch(() => {});
      return c.json({
        variantsMapped: (mapped?.result as { set?: number } | undefined)?.set ?? 0,
        unmatchedShopify: match.unmatchedShopify,
        untrackedShopify: match.untrackedShopify,
      });
    }
    const mapped = await execute(pipeline, ops.setShopifyMappings, {
      caller,
      shopId,
      idempotencyKey: uuidv7(),
      requestId,
      input: {
        connectionId,
        locationId: body?.locationId,
        shopifyLocationId: body?.shopifyLocationId,
        variants: match.variants,
      },
    });
    await pipeline.dispatch?.().catch(() => {});
    return c.json({
      ...(mapped.result as object),
      unmatchedShopify: match.unmatchedShopify,
      untrackedShopify: match.untrackedShopify,
    });
  });
}
