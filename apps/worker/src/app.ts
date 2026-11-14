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
import type { Database } from '@airstock/db';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type McpAuthConfig, mountMcp } from './mcp.ts';
import { mountRestRoutes } from './rest.ts';
import { type JobMessage, mountShopify, type ShopifyAppConfig } from './shopify.ts';
import { mountWeb, readSession, sameOrigin, type WebConfig } from './web.ts';

export interface AppDeps {
  /** A database handle for one request; the app closes it when the request ends. */
  database(): Database;
  audit: AuditSink;
  mcp: McpAuthConfig | null;
  /** Sign-in, connect consent, and dashboard pages; off until WorkOS is configured. */
  web: WebConfig | null;
  /** Shopify install, webhooks, and mapping; off until the app credentials are set. */
  shopify?: ShopifyAppConfig | null;
  /** The jobs queue, for work a request commits and hands off (a Shopify order, say). */
  jobs?: { send(message: JobMessage): Promise<void> };
  /** Publishes committed outbox rows to the jobs queue now instead of at the next sweep. */
  dispatch?: (db: Database) => Promise<number>;
  logger: Logger;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    db: Database;
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
    c.set('requestId', uuidv7());
    const db = deps.database();
    c.set('db', db);
    try {
      await next();
    } finally {
      await db.close();
    }
    c.header('x-request-id', c.get('requestId'));
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

  app.notFound((c) => problem(errors.notFound('Route'), c.get('requestId') ?? uuidv7()));
  app.onError((error, c) => {
    const requestId = c.get('requestId') ?? uuidv7();
    if (error instanceof AppError) return problem(error, requestId);
    deps.logger.error('unhandled_error', { requestId, error: String(error) });
    return problem(errors.internal(), requestId);
  });

  return app;
}
