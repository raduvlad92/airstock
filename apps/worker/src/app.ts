import {
  AppError,
  type AuditSink,
  authenticateApiToken,
  type Caller,
  errors,
  type Logger,
  sessionCaller,
  uuidv7,
} from '@airstock/core';
import type { Database, DatabaseHooks } from '@airstock/db';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type McpAuthConfig, mountMcp } from './mcp.ts';
import { mountRestRoutes } from './rest.ts';
import { type FileStore, mountScanTest } from './scan.ts';
import { type JobMessage, mountShopify, type ShopifyAppConfig } from './shopify.ts';
import { mountWeb, readSession, sameOrigin, type WebConfig } from './web.ts';

export interface AppDeps {
  /** A database handle for one request; the app closes it when the request ends. */
  database(hooks?: DatabaseHooks): Database;
  audit: AuditSink;
  mcp: McpAuthConfig | null;
  /** Sign-in, connect consent, and dashboard pages; off until WorkOS is configured. */
  web: WebConfig | null;
  /** Shopify install, webhooks, and mapping; off until the app credentials are set. */
  shopify?: ShopifyAppConfig | null;
  /** The jobs queue, for work a request commits and hands off (a Shopify order, say). */
  jobs?: { send(message: JobMessage, delaySeconds?: number): Promise<void> };
  /**
   * Runs a committed job right after the response, on its own database handle, instead of
   * waiting for the queue to deliver it (seconds). The queued copy is the safety net.
   */
  runJobNow?: (message: JobMessage) => Promise<void>;
  /** Publishes committed outbox rows to the jobs queue now instead of at the next sweep. */
  dispatch?: (db: Database) => Promise<number>;
  /** File storage (R2): scan-test results. */
  files?: FileStore;
  logger: Logger;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    db: Database;
    /** The audit sink for this request, timed for the Server-Timing header. */
    audit: AuditSink;
    caller: Caller;
    /** Set when the request committed outbox events. */
    outboxWritten: boolean;
  };
};

export function problem(error: AppError, requestId: string): Response {
  return new Response(JSON.stringify(error.toProblem(requestId)), {
    status: error.status,
    headers: {
      'content-type': 'application/problem+json',
      'x-request-id': requestId,
      ...(error.status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
    },
  });
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const started = performance.now();
    c.set('requestId', uuidv7());
    // Per-request measurements (plan Section 10): transactions, SQL statements, database time,
    // and awaited queue sends, reported in Server-Timing and one log line.
    const stats = { tx: 0, sql: 0, dbMs: 0, sends: 0, events: 0, queueMs: 0 };
    const db = deps.database({
      onTransactionEnd: (t) => {
        stats.tx++;
        stats.sql += t.statements;
        stats.dbMs += t.durationMs;
      },
    });
    c.set('db', db);
    c.set('audit', {
      async send(events) {
        const t = performance.now();
        try {
          await deps.audit.send(events);
        } finally {
          stats.sends++;
          stats.events += events.length;
          stats.queueMs += performance.now() - t;
        }
      },
    });
    try {
      await next();
    } finally {
      await db.close();
    }
    c.header('x-request-id', c.get('requestId'));
    const ms = (n: number) => n.toFixed(1);
    c.header(
      'server-timing',
      [
        `app;dur=${ms(performance.now() - started)}`,
        `db;dur=${ms(stats.dbMs)};desc="tx ${stats.tx}, sql ${stats.sql}"`,
        `queue;dur=${ms(stats.queueMs)};desc="sends ${stats.sends}, events ${stats.events}"`,
      ].join(', '),
    );
    deps.logger.info?.('request_stats', {
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
      ...stats,
      dbMs: Math.round(stats.dbMs),
      queueMs: Math.round(stats.queueMs),
    });
    // Publish committed outbox events now (a Shopify push, say) instead of at the next cron
    // sweep, after the response, on a handle of its own. The sweep still covers failures.
    if (c.get('outboxWritten') && deps.dispatch) {
      const dispatch = deps.dispatch;
      const publish = (async () => {
        const own = deps.database();
        try {
          await dispatch(own);
        } catch (error) {
          deps.logger.error('outbox_dispatch_failed', { error: String(error) });
        } finally {
          await own.close();
        }
      })();
      try {
        c.executionCtx.waitUntil(publish);
      } catch {
        // No execution context outside Workers (tests): the publish simply runs.
      }
    }
  });

  app.use(
    '*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: () =>
        problem(errors.validation([{ path: 'body', message: 'At most 1 MB.' }]), uuidv7()),
    }),
  );

  // Only authenticated callers are served (plan P3). A request without a valid credential is
  // answered here, before anything is written to the audit queue.
  app.use('/api/v1/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    let caller: Caller | null = null;
    if (token) {
      caller = await authenticateApiToken(c.get('db'), token);
    } else if (deps.web && c.req.header('x-airstock-request') === '1' && sameOrigin(c, deps.web)) {
      // The dashboard: a session cookie, plus a custom header that a cross-site page cannot send
      // without a CORS preflight, which Airstock never approves.
      const session = await readSession(c, deps.web);
      if (session) caller = sessionCaller(session.uid);
    }
    if (!caller) return problem(errors.unauthenticated(), c.get('requestId'));
    c.set('caller', caller);
    await next();
  });

  mountRestRoutes(app, deps);
  mountMcp(app, deps);
  mountWeb(app, deps);
  mountShopify(app, deps);
  mountScanTest(app, deps);

  app.notFound((c) => problem(errors.notFound('Route'), c.get('requestId') ?? uuidv7()));
  app.onError((error, c) => {
    const requestId = c.get('requestId') ?? uuidv7();
    if (error instanceof AppError) return problem(error, requestId);
    deps.logger.error('unhandled_error', { requestId, error: String(error) });
    return problem(errors.internal(), requestId);
  });

  return app;
}
