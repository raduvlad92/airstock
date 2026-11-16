import {
  ALERT_OPENED_TOPIC,
  ALERT_RESOLVED_TOPIC,
  type AuditEvent,
  type AuditSink,
  announceStockChanged,
  attemptWebhookDelivery,
  auditEvent,
  drainOutbox,
  ensureAuditPartitions,
  handleWebhookOutbox,
  ingestAuditEvents,
  type JobDeps,
  type Logger,
  notifyAlertOpened,
  ONBOARDING_RUN_TOPIC,
  type OutboxMessage,
  REPORT_EXPORT_TOPIC,
  reconcileStock,
  recoverWebhookDeliveries,
  runDailyAlertChecks,
  runExportJob,
  runImportJob,
  runReportExportJob,
  SHOPIFY_PUSH_TOPIC,
  sendInvitationEmail,
  sendPurchaseOrderEmail,
  sendWebhookDisabledEmail,
  sweepExpiredReservations,
  sweepExportFiles,
  sweepMediaUploads,
  sweepShortages,
  sweepUnboundConnectionGrants,
  sweepWebhookHistory,
  systemCaller,
  uuidv7,
  type WebhookDeliveryMessage,
  type WebhookDeps,
  WebhookSecretCipher,
} from '@airstock/core';
import { type Database, type DatabaseHooks, PgDatabase } from '@airstock/db';
import type { FontLoader } from '@airstock/pdf';
import {
  httpShopifyAdmin,
  httpShopifyAuth,
  NotConnectedError,
  type PushChange,
  pushChanges,
  reconcileShopify,
  runJob,
  runOnboarding,
  type ShopifyReconcileResult,
  type SyncDeps,
  TokenCipher,
} from '@airstock/shopify';
import { createApp } from './app.ts';
import { packAuditEvents, unpackAuditMessages } from './audit-queue.ts';
import { resendSender } from './email.ts';
import type { Env } from './env.ts';
import { mcpConfigFromEnv } from './mcp.ts';
import { digestStreamHasher, r2MediaStore } from './media.ts';
import { assetFontLoader, purchaseOrderPdf } from './purchasing.ts';
import { bindingLimiter } from './rate-limit.ts';
import { requestScopedSource } from './request-db.ts';
import type { FileStore } from './scan.ts';
import type { JobMessage, ShopifyAppConfig } from './shopify.ts';
import type { WebConfig } from './web.ts';
import { createWorkosClient } from './workos.ts';

const logger: Logger = {
  error: (message, data) => console.error(JSON.stringify({ level: 'error', message, ...data })),
  info: (message, data) => console.log(JSON.stringify({ level: 'info', message, ...data })),
};

/**
 * Awaited send: resolves once Cloudflare Queues has durably accepted the events (PRD 7.3). The
 * events of one send travel in one message, split only to stay under the message size limit, so a
 * batch of client events is one queue write.
 */
function queueSink(env: Env): AuditSink {
  return {
    async send(events: AuditEvent[]) {
      const messages = packAuditEvents(events);
      if (messages.length === 0) return;
      await env.AUDIT_QUEUE.sendBatch(
        messages.map((body) => ({ body, contentType: 'json' as const })),
      );
    },
  };
}

/** Sign-in and connect pages need WorkOS, the session secret, and the MCP settings. */
function webConfigFromEnv(env: Env): WebConfig | null {
  if (
    !env.PUBLIC_URL ||
    !env.WORKOS_CLIENT_ID ||
    !env.WORKOS_API_KEY ||
    !env.SESSION_SECRET ||
    !env.MCP_AUTHORIZATION_SERVER
  )
    return null;
  return {
    publicUrl: env.PUBLIC_URL,
    sessionSecret: env.SESSION_SECRET,
    workos: createWorkosClient({
      apiKey: env.WORKOS_API_KEY,
      clientId: env.WORKOS_CLIENT_ID,
      redirectUri: new URL('/auth/callback', env.PUBLIC_URL).href,
    }),
    authkitOrigin: new URL(env.MCP_AUTHORIZATION_SERVER).origin,
    grantClaim: env.MCP_GRANT_CLAIM ?? 'grant_id',
  };
}

/** Shopify needs the client ID and secret, the token key, and the public URL. */
let shopifyConfig: Promise<ShopifyAppConfig | null> | null = null;
function shopifyConfigFromEnv(env: Env): Promise<ShopifyAppConfig | null> {
  shopifyConfig ??= (async () => {
    if (
      !env.SHOPIFY_CLIENT_ID ||
      !env.SHOPIFY_API_SECRET ||
      !env.SHOPIFY_TOKEN_KEY ||
      !env.PUBLIC_URL
    )
      return null;
    return {
      clientId: env.SHOPIFY_CLIENT_ID,
      apiSecret: env.SHOPIFY_API_SECRET,
      redirectUri: new URL('/shopify/oauth/callback', env.PUBLIC_URL).href,
      webhookUri: new URL('/shopify/webhooks', env.PUBLIC_URL).href,
      cipher: await TokenCipher.fromBase64(env.SHOPIFY_TOKEN_KEY_ID ?? 'k1', env.SHOPIFY_TOKEN_KEY),
      auth: httpShopifyAuth({
        clientId: env.SHOPIFY_CLIENT_ID,
        clientSecret: env.SHOPIFY_API_SECRET,
      }),
      admin: (shopDomain, accessToken, scopes) =>
        httpShopifyAdmin(shopDomain, accessToken, fetch, scopes ?? null),
    };
  })();
  return shopifyConfig;
}

/** Webhook signing secrets are encrypted with WEBHOOK_SECRET_KEY; webhooks are off without it. */
let webhookCipher: Promise<WebhookSecretCipher | null> | null = null;
function webhookCipherFromEnv(env: Env): Promise<WebhookSecretCipher | null> {
  webhookCipher ??= env.WEBHOOK_SECRET_KEY
    ? WebhookSecretCipher.fromBase64(env.WEBHOOK_SECRET_KEY_ID ?? 'w1', env.WEBHOOK_SECRET_KEY)
    : Promise.resolve(null);
  return webhookCipher;
}

/**
 * Webhook deliveries POST from here with the global fetch (no redirects, 10-second timeout, set
 * per request). A failed delivery comes back through the jobs queue with its retry delay.
 */
async function webhookDeps(env: Env, db: Database): Promise<WebhookDeps> {
  return {
    db,
    cipher: await webhookCipherFromEnv(env),
    fetch: (url, init) => fetch(url, init),
    async schedule(message, delaySeconds) {
      await env.JOBS_QUEUE.send(message, { contentType: 'json', delaySeconds });
    },
    logger,
  };
}

function database(env: Env, hooks?: DatabaseHooks) {
  return new PgDatabase(requestScopedSource(env.HYPERDRIVE.connectionString), hooks);
}

/**
 * Delivers committed outbox events right away, here: a Shopify push or an email. Only events
 * that fail go to the jobs queue, which retries them. Used after a request commits, where the
 * fetch handler runs next to the database; the cron sweep uses publishOutbox instead.
 */
function deliverOutbox(env: Env, db: Database): Promise<number> {
  return drainOutbox(db, async (messages) => {
    const outcomes = await runJobsBatch(
      env,
      db,
      messages.map((body) => ({ id: body.id, attempts: 1, body })),
    );
    const retry = new Set(outcomes.filter((o) => o.retryAfter !== null).map((o) => o.id));
    const failed = messages.filter((m) => retry.has(m.id));
    if (failed.length > 0) {
      await env.JOBS_QUEUE.sendBatch(
        failed.map((body) => ({ body, contentType: 'json' as const, delaySeconds: 30 })),
      );
    }
  });
}

function publishOutbox(env: Env, db: Database): Promise<number> {
  return drainOutbox(db, async (messages) => {
    await env.JOBS_QUEUE.sendBatch(
      messages.map((body) => ({ body, contentType: 'json' as const })),
    );
  });
}

/** The EU R2 bucket: scan-test results, import uploads, and export files. */
function filesFor(env: Env): FileStore {
  return {
    async put(key, body, contentType = 'application/json') {
      await env.FILES.put(key, body, { httpMetadata: { contentType } });
    },
    async list(prefix) {
      const listed = await env.FILES.list({ prefix, limit: 1000 });
      return listed.objects.map((o) => o.key);
    },
    async get(key) {
      const object = await env.FILES.get(key);
      return object ? object.text() : null;
    },
    async delete(key) {
      await env.FILES.delete(key);
    },
  };
}

function jobDeps(env: Env, db: Database): JobDeps {
  const files = filesFor(env);
  return {
    db,
    audit: queueSink(env),
    logger,
    files: {
      get: files.get,
      put: (k, b, ct) => files.put(k, b, ct),
      delete: (k) => files.delete!(k),
    },
  };
}

/** One font loader per isolate, so the PDF font library caches each file once. */
let fonts: FontLoader | null = null;
function fontLoader(assets: Fetcher): FontLoader {
  fonts ??= assetFontLoader(assets);
  return fonts;
}

let app: ReturnType<typeof createApp> | null = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/internal/smoke') return smoke(request, env);
    if (url.pathname === '/internal/jobs') return internalJobs(request, env);
    if (url.pathname === '/internal/reconcile') return internalReconcile(request, env);
    app ??= createApp({
      database: (hooks) => database(env, hooks),
      audit: queueSink(env),
      mcp: mcpConfigFromEnv(env),
      web: webConfigFromEnv(env),
      shopify: await shopifyConfigFromEnv(env),
      jobs: {
        async send(message: JobMessage, delaySeconds?: number) {
          await env.JOBS_QUEUE.send(message, {
            contentType: 'json',
            ...(delaySeconds ? { delaySeconds } : {}),
          });
        },
      },
      runJobNow: async (message: JobMessage) => {
        const own = database(env);
        try {
          await runJobsBatch(env, own, [{ id: 'inline', attempts: 1, body: message }]);
        } finally {
          await own.close();
        }
      },
      dispatch: (db) => deliverOutbox(env, db),
      rateLimiter: bindingLimiter({
        session: env.RATE_LIMIT_SESSION,
        api_credential: env.RATE_LIMIT_API,
        connection: env.RATE_LIMIT_MCP,
        client_events: env.RATE_LIMIT_CLIENT_EVENTS,
      }),
      files: filesFor(env),
      ...(env.ASSETS ? { fonts: fontLoader(env.ASSETS) } : {}),
      media: {
        store: r2MediaStore(env.FILES),
        hasher: digestStreamHasher,
        signingKey: env.MEDIA_SIGNING_KEY ?? null,
        publicUrl: env.PUBLIC_URL ?? '',
      },
      webhookSecrets: await webhookCipherFromEnv(env),
      logger,
    });
    return app.fetch(request, env, ctx);
  },

  async queue(batch, env) {
    const db = database(env);
    try {
      if (batch.queue.includes('audit')) {
        // One multi-row insert per batch; redelivered events are ignored by event ID.
        const events = unpackAuditMessages(batch.messages.map((m) => m.body));
        for (let i = 0; i < events.length; i += 1000) {
          await ingestAuditEvents(db, events.slice(i, i + 1000));
        }
        batch.ackAll();
        return;
      }
      // Jobs touch the database many times. Placement moves only fetch handlers next to it, so
      // the consumer hands the batch to this Worker's own fetch handler through a service binding;
      // if that call fails, it runs the batch here.
      const items = batch.messages.map((m) => ({
        id: m.id,
        attempts: m.attempts,
        body: m.body as JobsBody,
      }));
      let outcomes: JobsOutcome[] | null = null;
      if (env.SELF && env.INTERNAL_SECRET) {
        try {
          const res = await env.SELF.fetch('https://airstock.internal/internal/jobs', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-internal-secret': env.INTERNAL_SECRET,
            },
            body: JSON.stringify(items),
          });
          if (res.ok) outcomes = ((await res.json()) as { outcomes: JobsOutcome[] }).outcomes;
          else logger.error('internal_jobs_failed', { status: res.status });
        } catch (error) {
          logger.error('internal_jobs_failed', { error: String(error) });
        }
      }
      outcomes ??= await runJobsBatch(env, db, items);
      const byId = new Map(outcomes.map((o) => [o.id, o]));
      for (const message of batch.messages) {
        const outcome = byId.get(message.id);
        if (outcome?.retryAfter === undefined || outcome.retryAfter === null) message.ack();
        else message.retry({ delaySeconds: outcome.retryAfter });
      }
    } finally {
      await db.close();
    }
  },

  async scheduled(controller, env) {
    const db = database(env);
    try {
      await publishOutbox(env, db);
      // Jobs whose queue message was lost or whose backoff has passed.
      const stale = await requeueStaleJobs(db);
      if (stale.length > 0) {
        await env.JOBS_QUEUE.sendBatch(
          stale.map((body) => ({ body, contentType: 'json' as const })),
        );
      }
      // Webhook retries whose queue message was lost, or whose sender stopped mid-attempt.
      const deliveries = await recoverWebhookDeliveries(db);
      if (deliveries.length > 0) {
        await env.JOBS_QUEUE.sendBatch(
          deliveries.map((body) => ({ body, contentType: 'json' as const })),
        );
      }
      await sweepExpiredReservations(db);
      // Shortages a receipt could not reach in its own transaction (D6).
      await sweepShortages(db);
      await sweepUnboundConnectionGrants(db);
      // Uploads never finalized: expire them and delete their objects (ADR 0015).
      await sweepMediaUploads(db, (keys) => r2MediaStore(env.FILES).delete(keys), { logger });
      // Imports whose job stopped (a lost message, a crash) resume from their checkpoint.
      const stuck = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
        tx.query<{ shop_id: string; id: string }>(
          'select shop_id, id from stale_imports($1)',
          [20],
        ),
      );
      if (stuck.length > 0) {
        await env.JOBS_QUEUE.sendBatch(
          stuck.map((r) => ({
            body: {
              id: crypto.randomUUID(),
              shopId: r.shop_id,
              topic: 'catalog.import.run',
              payload: { importId: r.id },
              createdAt: new Date().toISOString(),
            },
            contentType: 'json' as const,
          })),
        );
      }
      // Shopify onboarding imports whose run stopped resume from their stored state.
      const onboardings = await db.transaction(
        { shopId: null, userId: null, readOnly: true },
        (tx) =>
          tx.query<{ shop_id: string; id: string }>(
            'select shop_id, id from stale_shopify_onboardings($1)',
            [20],
          ),
      );
      if (onboardings.length > 0) {
        await env.JOBS_QUEUE.sendBatch(
          onboardings.map((r) => ({
            body: {
              id: crypto.randomUUID(),
              shopId: r.shop_id,
              topic: ONBOARDING_RUN_TOPIC,
              payload: { onboardingId: r.id },
              createdAt: new Date().toISOString(),
            },
            contentType: 'json' as const,
          })),
        );
      }
      if (controller.cron === '0 3 * * *') {
        // Lots nearing expiry, and every reorder rule and shortage checked again (D12).
        await runDailyAlertChecks(db);
        await publishOutbox(env, db);
        await ensureAuditPartitions(db);
        await sweepExportFiles(db, jobDeps(env, db).files);
        // The webhook delivery log is kept 30 days (plan Section 5.13).
        await sweepWebhookHistory(db);
      }
      // Stock reconciliation (D18): shops with stock activity every 30 minutes, every shop daily.
      await runReconciliation(env, db, controller.cron === '0 3 * * *');
    } finally {
      await db.close();
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Runs the stock reconciliation next to the database: through this Worker's own fetch handler,
 * as the jobs consumer does, or here when the self binding is not configured or the call fails.
 */
async function runReconciliation(env: Env, db: Database, daily: boolean): Promise<void> {
  if (env.SELF && env.INTERNAL_SECRET) {
    try {
      const res = await env.SELF.fetch('https://airstock.internal/internal/reconcile', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': env.INTERNAL_SECRET },
        body: JSON.stringify({ daily }),
      });
      if (res.ok) return;
      logger.error('internal_reconcile_failed', { status: res.status });
    } catch (error) {
      logger.error('internal_reconcile_failed', { error: String(error) });
    }
  }
  try {
    const result = await reconcileStock(db, { daily, logger });
    logger.info?.('stock_reconciliation', { daily, ...result });
    await runShopifyReconciliation(env, db, daily);
    await deliverOutbox(env, db);
  } catch (error) {
    logger.error('stock_reconciliation_failed', { error: String(error) });
  }
}

/**
 * The Shopify reconciler (ADR 0036), after the stock check in the same cron: orders Shopify
 * changed since each connection's cursor, then its levels (all of them daily).
 */
async function runShopifyReconciliation(
  env: Env,
  db: Database,
  daily: boolean,
): Promise<ShopifyReconcileResult | null> {
  const shopify = await shopifyConfigFromEnv(env);
  if (!shopify) return null;
  try {
    const result = await reconcileShopify(
      { db, audit: queueSink(env), logger, shopify },
      { daily, budgetMs: 20_000 },
    );
    logger.info?.('shopify_reconciliation', { daily, ...result });
    return result;
  } catch (error) {
    logger.error('shopify_reconciliation_failed', { error: String(error) });
    return null;
  }
}

/** The reconciliation run the crons hand to the fetch handler; it announces alerts right away. */
async function internalReconcile(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get('x-internal-secret') ?? '';
  if (
    request.method !== 'POST' ||
    !env.INTERNAL_SECRET ||
    !timingSafeEqualText(secret, env.INTERNAL_SECRET)
  ) {
    return new Response('Not found', { status: 404 });
  }
  const body = (await request.json().catch(() => ({}))) as { daily?: unknown };
  const daily = body.daily === true;
  const db = database(env);
  try {
    const result = await reconcileStock(db, { daily, logger });
    logger.info?.('stock_reconciliation', { daily, ...result });
    const shopify = await runShopifyReconciliation(env, db, daily);
    await deliverOutbox(env, db).catch((error) =>
      logger.error('outbox_dispatch_failed', { error: String(error) }),
    );
    return Response.json({ ...result, shopify });
  } finally {
    await db.close();
  }
}

async function requeueStaleJobs(db: Database): Promise<JobMessage[]> {
  const rows = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query<{ shop_id: string; id: string }>('select shop_id, id from stale_jobs($1)', [100]),
  );
  return rows.map((r) => ({ job: { shopId: r.shop_id, jobId: r.id } }));
}

/**
 * Staging measurement route (plan M1): database round trips, R2, and queue latency.
 * Disabled unless SMOKE_SECRET is set; requires the secret in X-Smoke-Secret.
 */
async function smoke(request: Request, env: Env): Promise<Response> {
  if (!env.SMOKE_SECRET || request.headers.get('x-smoke-secret') !== env.SMOKE_SECRET) {
    return new Response('Not found', { status: 404 });
  }
  const timings: Record<string, number[]> = {
    dbConnectAndFirstQuery: [],
    dbRoundTrip: [],
    r2: [],
    queueSend: [],
  };
  const db = database(env);
  try {
    let t = performance.now();
    await db.transaction({ shopId: null, userId: null, readOnly: true }, async (tx) => {
      await tx.query('select 1');
      timings.dbConnectAndFirstQuery!.push(performance.now() - t);
      for (let i = 0; i < 5; i++) {
        t = performance.now();
        await tx.query('select 1');
        timings.dbRoundTrip!.push(performance.now() - t);
      }
    });
    t = performance.now();
    const key = `smoke/${uuidv7()}`;
    await env.FILES.put(key, 'ok');
    await env.FILES.get(key);
    await env.FILES.delete(key);
    timings.r2!.push(performance.now() - t);
    t = performance.now();
    await queueSink(env).send([
      auditEvent(
        {
          shopId: null,
          caller: systemCaller('smoke-test', uuidv7()),
          requestId: uuidv7(),
          attemptId: null,
          idempotencyKey: null,
        },
        { action: 'platform.smoke', phase: 'outcome', outcome: 'succeeded' },
      ),
    ]);
    timings.queueSend!.push(performance.now() - t);
  } finally {
    await db.close();
  }
  return Response.json({
    timings,
    colo: (request as Request & { cf?: { colo?: string } }).cf?.colo ?? null,
  });
}

type JobsBody = OutboxMessage | JobMessage | WebhookDeliveryMessage;

interface JobsItem {
  id: string;
  attempts: number;
  body: JobsBody;
}

/** Null retryAfter means acknowledge; a number means retry after that many seconds. */
interface JobsOutcome {
  id: string;
  retryAfter: number | null;
}

/**
 * Runs a batch from the jobs queue: Shopify order jobs, availability pushes, and emails. Called
 * through the self service binding, so placement runs it next to the database.
 */
async function internalJobs(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get('x-internal-secret') ?? '';
  if (
    request.method !== 'POST' ||
    !env.INTERNAL_SECRET ||
    !timingSafeEqualText(secret, env.INTERNAL_SECRET)
  ) {
    return new Response('Not found', { status: 404 });
  }
  const items = (await request.json()) as JobsItem[];
  const db = database(env);
  try {
    const outcomes = await runJobsBatch(env, db, items);
    // Jobs such as an import chunk write outbox events of their own; deliver them now rather
    // than at the next sweep.
    await deliverOutbox(env, db).catch((error) =>
      logger.error('outbox_dispatch_failed', { error: String(error) }),
    );
    return Response.json({ outcomes });
  } finally {
    await db.close();
  }
}

function timingSafeEqualText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function runJobsBatch(env: Env, db: Database, items: JobsItem[]): Promise<JobsOutcome[]> {
  const shopify = await shopifyConfigFromEnv(env);
  const deps: SyncDeps | null = shopify
    ? {
        db,
        audit: queueSink(env),
        logger,
        shopify,
        files: jobDeps(env, db).files,
        dispatch: () => deliverOutbox(env, db),
      }
    : null;
  const outcomes: JobsOutcome[] = [];
  // Shopify pushes of this batch's stock and map changes run together per shop, after each
  // message's own work: one batched compare-and-set call covers many changes (ADR 0036).
  const pushes = new Map<string, { items: JobsItem[]; changes: PushChange[] }>();
  for (const item of items) {
    outcomes.push({ id: item.id, retryAfter: await runJobsMessage(env, db, deps, item, pushes) });
  }
  for (const [shopId, batch] of pushes) {
    if (!deps) break;
    try {
      await pushChanges(deps, shopId, batch.changes);
    } catch (error) {
      if (error instanceof NotConnectedError) continue;
      logger.error('shopify_push_failed', { shopId, error: String(error) });
      for (const item of batch.items) {
        const outcome = outcomes.find((o) => o.id === item.id);
        if (outcome && outcome.retryAfter === null) {
          outcome.retryAfter = Math.min(300, 30 * Math.max(1, item.attempts));
        }
      }
    }
  }
  return outcomes;
}

async function runJobsMessage(
  env: Env,
  db: Database,
  deps: SyncDeps | null,
  item: JobsItem,
  pushes: Map<string, { items: JobsItem[]; changes: PushChange[] }>,
): Promise<number | null> {
  const queuePush = (shopId: string, change: PushChange) => {
    const batch = pushes.get(shopId) ?? { items: [], changes: [] };
    batch.items.push(item);
    batch.changes.push(change);
    pushes.set(shopId, batch);
  };
  const { body } = item;
  try {
    if ('job' in body) {
      if (!deps) return 300;
      const outcome = await runJob(deps, body.job.shopId, body.job.jobId);
      return outcome.status === 'retry' ? outcome.delaySeconds : null;
    }
    if ('webhookDelivery' in body) {
      // One delivery attempt; the next retry, if any, is queued by the attempt itself.
      const { shopId, deliveryId } = body.webhookDelivery;
      await attemptWebhookDelivery(await webhookDeps(env, db), shopId, deliveryId);
      return null;
    }
    if (await handleWebhookOutbox(await webhookDeps(env, db), body)) return null;
    // Alert announcements: the in-app list reads the alerts table, webhooks get their own outbox
    // rows, and milestone I3 adds email here.
    if (body.topic === ALERT_OPENED_TOPIC || body.topic === ALERT_RESOLVED_TOPIC) return null;
    if (body.topic === 'email.webhook_disabled') {
      if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.PUBLIC_URL) {
        logger.error('email_not_configured', { topic: body.topic });
        return 600;
      }
      await sendWebhookDisabledEmail(
        {
          db,
          email: resendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }),
          publicUrl: env.PUBLIC_URL,
        },
        body.shopId,
        (body.payload as { subscriptionId: string }).subscriptionId,
      );
      return null;
    }
    if (body.topic === 'alert.opened') {
      // Email to members who follow the alert's kind (D12); the app reads alerts directly.
      if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.PUBLIC_URL) {
        logger.error('email_not_configured', { topic: body.topic });
        return 600;
      }
      await notifyAlertOpened(
        {
          db,
          email: resendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }),
          publicUrl: env.PUBLIC_URL,
        },
        body.shopId,
        (body.payload as { alertId: string }).alertId,
      );
      return null;
    }
    // Nothing to send when an alert resolves; webhooks carry it (alert.resolved).
    if (body.topic === 'alert.resolved') return null;
    if (body.topic === 'email.purchase_order') {
      if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.ASSETS) {
        logger.error('email_not_configured', { topic: body.topic });
        return 600;
      }
      const fonts = fontLoader(env.ASSETS);
      await sendPurchaseOrderEmail(
        {
          db,
          audit: queueSink(env),
          email: resendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }),
          renderPdf: (order) => purchaseOrderPdf(fonts, order),
          recipients: env.EMAIL_RECIPIENTS === 'members' ? 'members' : 'any',
        },
        body.shopId,
        (body.payload as { sendId: string }).sendId,
      );
      return null;
    }
    if (body.topic === 'email.member_invitation') {
      if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.PUBLIC_URL) {
        logger.error('email_not_configured', { topic: body.topic });
        return 600;
      }
      await sendInvitationEmail(
        {
          db,
          audit: queueSink(env),
          email: resendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }),
          publicUrl: env.PUBLIC_URL,
        },
        body.shopId,
        (body.payload as { invitationId: string }).invitationId,
      );
      return null;
    }
    if (body.topic === 'catalog.import.run') {
      // Chunks run until the time budget; the rest continues in a new message right away.
      const importId = (body.payload as { importId: string }).importId;
      const outcome = await runImportJob(jobDeps(env, db), body.shopId, importId);
      if (outcome === 'more')
        await env.JOBS_QUEUE.send({ ...body, id: crypto.randomUUID() }, { contentType: 'json' });
      return null;
    }
    if (body.topic === 'catalog.export.run') {
      await runExportJob(
        jobDeps(env, db),
        body.shopId,
        (body.payload as { exportId: string }).exportId,
      );
      return null;
    }
    if (body.topic === SHOPIFY_PUSH_TOPIC) {
      // A mapping or an order changed: push those levels (or all of the connection's), with the
      // batch's other pushes.
      if (!deps) return 300;
      queuePush(body.shopId, { topic: body.topic, payload: body.payload });
      return null;
    }
    if (body.topic === ONBOARDING_RUN_TOPIC) {
      // One step of an onboarding import; it says when to run again (a bulk read in progress,
      // the import job still writing).
      if (!deps) return 300;
      const step = await runOnboarding(
        deps,
        body.shopId,
        (body.payload as { onboardingId: string }).onboardingId,
      );
      if (step.status === 'again') {
        await env.JOBS_QUEUE.send(
          { ...body, id: crypto.randomUUID() },
          { contentType: 'json', delaySeconds: step.delaySeconds },
        );
      }
      return null;
    }
    if (body.topic === REPORT_EXPORT_TOPIC) {
      await runReportExportJob(
        jobDeps(env, db),
        body.shopId,
        (body.payload as { exportId: string }).exportId,
      );
      return null;
    }
    if (body.topic === 'inventory.availability_changed') {
      // stock.changed for webhook subscribers, then the Shopify availability push (plan Section
      // 8.2, step 5). Both are safe to repeat, so a failure in either retries the message.
      let webhookError: unknown = null;
      await announceStockChanged(await webhookDeps(env, db), body).catch((error) => {
        webhookError = error;
      });
      if (deps) queuePush(body.shopId, { topic: body.topic, payload: body.payload });
      if (webhookError) throw webhookError;
      return null;
    }
    logger.error('outbox_event_unhandled', { topic: body.topic, id: body.id });
    return null;
  } catch (error) {
    if (error instanceof NotConnectedError) return null;
    logger.error('jobs_message_failed', { error: String(error) });
    return Math.min(300, 30 * Math.max(1, item.attempts));
  }
}
