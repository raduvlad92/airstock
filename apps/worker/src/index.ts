import {
  type AuditEvent,
  type AuditSink,
  auditEvent,
  dispatchOutbox,
  ensureAuditPartitions,
  ingestAuditEvents,
  type Logger,
  type OutboxMessage,
  sweepExpiredReservations,
  systemCaller,
  uuidv7,
} from '@airstock/core';
import { PgDatabase } from '@airstock/db';
import { createApp } from './app.ts';
import type { Env } from './env.ts';
import { mcpConfigFromEnv } from './mcp.ts';
import { requestScopedSource } from './request-db.ts';

const logger: Logger = {
  error: (message, data) => console.error(JSON.stringify({ level: 'error', message, ...data })),
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

function database(env: Env) {
  return new PgDatabase(requestScopedSource(env.HYPERDRIVE.connectionString));
}

let app: ReturnType<typeof createApp> | null = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/internal/smoke') return smoke(request, env);
    app ??= createApp({
      database: () => database(env),
      audit: queueSink(env),
      mcp: mcpConfigFromEnv(env),
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
      for (const message of batch.messages) {
        const event = message.body as OutboxMessage;
        // Phase 0 has no subscribers yet; the Shopify availability push subscribes in M6.
        logger.error('outbox_event_unhandled', { topic: event.topic, id: event.id });
        message.ack();
      }
    } finally {
      await db.close();
    }
  },

  async scheduled(controller, env) {
    const db = database(env);
    try {
      await dispatchOutbox(db, async (messages) => {
        await env.JOBS_QUEUE.sendBatch(
          messages.map((body) => ({ body, contentType: 'json' as const })),
        );
      });
      await sweepExpiredReservations(db);
      if (controller.cron === '0 3 * * *') await ensureAuditPartitions(db);
    } finally {
      await db.close();
    }
  },
} satisfies ExportedHandler<Env>;

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
