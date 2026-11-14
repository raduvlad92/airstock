import {
  type AuditEvent,
  type AuditSink,
  auditEvent,
  dispatchOutbox,
  ensureAuditPartitions,
  ingestAuditEvents,
  type Logger,
  type OutboxMessage,
  sendInvitationEmail,
  sweepExpiredReservations,
  systemCaller,
  uuidv7,
} from '@airstock/core';
import { type Database, type DatabaseHooks, PgDatabase } from '@airstock/db';
import {
  type AvailabilityChanged,
  httpShopifyAdmin,
  httpShopifyAuth,
  NotConnectedError,
  pushAvailability,
  runJob,
  type SyncDeps,
  TokenCipher,
} from '@airstock/shopify';
import { createApp } from './app.ts';
import { resendSender } from './email.ts';
import type { Env } from './env.ts';
import { mcpConfigFromEnv } from './mcp.ts';
import { requestScopedSource } from './request-db.ts';
import type { JobMessage, ShopifyAppConfig } from './shopify.ts';
import type { WebConfig } from './web.ts';
import { createWorkosClient } from './workos.ts';

const logger: Logger = {
  error: (message, data) => console.error(JSON.stringify({ level: 'error', message, ...data })),
  info: (message, data) => console.log(JSON.stringify({ level: 'info', message, ...data })),
};

/** Awaited send: resolves once Cloudflare Queues has durably accepted the events (PRD 7.3). */
function queueSink(env: Env): AuditSink {
  return {
    async send(events: AuditEvent[]) {
      await env.AUDIT_QUEUE.sendBatch(
        events.map((body) => ({ body, contentType: 'json' as const })),
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
      admin: (shopDomain, accessToken) => httpShopifyAdmin(shopDomain, accessToken),
    };
  })();
  return shopifyConfig;
}

function database(env: Env, hooks?: DatabaseHooks) {
  return new PgDatabase(requestScopedSource(env.HYPERDRIVE.connectionString), hooks);
}

function publishOutbox(env: Env, db: Database): Promise<number> {
  return dispatchOutbox(db, async (messages) => {
    await env.JOBS_QUEUE.sendBatch(
      messages.map((body) => ({ body, contentType: 'json' as const })),
    );
  });
}

let app: ReturnType<typeof createApp> | null = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/internal/smoke') return smoke(request, env);
    if (url.pathname === '/internal/jobs') return internalJobs(request, env);
    app ??= createApp({
      database: (hooks) => database(env, hooks),
      audit: queueSink(env),
      mcp: mcpConfigFromEnv(env),
      web: webConfigFromEnv(env),
      shopify: await shopifyConfigFromEnv(env),
      jobs: {
        async send(message: JobMessage) {
          await env.JOBS_QUEUE.send(message, { contentType: 'json' });
        },
      },
      dispatch: (db) => publishOutbox(env, db),
      files: {
        async put(key, body) {
          await env.FILES.put(key, body, { httpMetadata: { contentType: 'application/json' } });
        },
        async list(prefix) {
          const listed = await env.FILES.list({ prefix, limit: 1000 });
          return listed.objects.map((o) => o.key);
        },
        async get(key) {
          const object = await env.FILES.get(key);
          return object ? object.text() : null;
        },
      },
      logger,
    });
    return app.fetch(request, env, ctx);
  },

  async queue(batch, env) {
    const db = database(env);
    try {
      if (batch.queue.includes('audit')) {
        // One multi-row insert per batch; redelivered events are ignored by event ID.
        await ingestAuditEvents(
          db,
          batch.messages.map((m) => m.body as AuditEvent),
        );
        batch.ackAll();
        return;
      }
      // Jobs touch the database many times. Placement moves only fetch handlers next to it, so
      // the consumer hands the batch to this Worker's own fetch handler through a service binding;
      // if that call fails, it runs the batch here.
      const items = batch.messages.map((m) => ({
        id: m.id,
        attempts: m.attempts,
        body: m.body as OutboxMessage | JobMessage,
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
      await sweepExpiredReservations(db);
      if (controller.cron === '0 3 * * *') await ensureAuditPartitions(db);
    } finally {
      await db.close();
    }
  },
} satisfies ExportedHandler<Env>;

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

interface JobsItem {
  id: string;
  attempts: number;
  body: OutboxMessage | JobMessage;
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
    return Response.json({ outcomes: await runJobsBatch(env, db, items) });
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
    ? { db, audit: queueSink(env), logger, shopify, dispatch: () => publishOutbox(env, db) }
    : null;
  const outcomes: JobsOutcome[] = [];
  for (const item of items) {
    outcomes.push({ id: item.id, retryAfter: await runJobsMessage(env, db, deps, item) });
  }
  return outcomes;
}

async function runJobsMessage(
  env: Env,
  db: Database,
  deps: SyncDeps | null,
  item: JobsItem,
): Promise<number | null> {
  const { body } = item;
  try {
    if ('job' in body) {
      if (!deps) return 300;
      const outcome = await runJob(deps, body.job.shopId, body.job.jobId);
      return outcome.status === 'retry' ? outcome.delaySeconds : null;
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
    if (body.topic === 'inventory.availability_changed') {
      // The Shopify availability push (plan Section 8.2, step 5).
      if (deps) await pushAvailability(deps, body.shopId, body.payload as AvailabilityChanged);
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
