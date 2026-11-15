import { type AnyOperation, execute, operations } from '@airstock/core';
import type { Hono } from 'hono';
import { type AppDeps, type AppEnv, fileAccess } from './app.ts';

const INVALID_JSON = Symbol('invalid-json');

/** `/shops/{shopId}/x` → `/api/v1/shops/:shopId/x` */
export function honoPath(op: AnyOperation): string {
  return `/api/v1${op.http.path.replace(/\{(\w+)\}/g, ':$1')}`;
}

/**
 * Registers one REST route per registry operation. Path parameters (other than shopId)
 * and the query string or JSON body together form the operation input, which the pipeline
 * validates. The route never decides permissions itself.
 */
export function mountRestRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  for (const op of operations) {
    app.on(op.http.method, honoPath(op), async (c) => {
      const { shopId, ...pathParams } = c.req.param() as Record<string, string>;
      let body: unknown;
      if (op.http.method === 'GET') {
        body = c.req.query();
      } else {
        const text = await c.req.text();
        body = text.trim() === '' ? {} : safeJson(text);
      }
      const input =
        body && typeof body === 'object' && !Array.isArray(body)
          ? { ...(body as Record<string, unknown>), ...pathParams }
          : body === INVALID_JSON
            ? undefined
            : body;
      const result = await execute(
        { db: c.get('db'), audit: c.get('audit'), logger: deps.logger, ...fileAccess(deps) },
        op,
        {
          caller: c.get('caller'),
          shopId: shopId ?? null,
          input,
          idempotencyKey: c.req.header('idempotency-key') ?? null,
          requestId: c.get('requestId'),
        },
      );
      if (result.outbox > 0) c.set('outboxWritten', true);
      if (result.replayed) c.header('idempotent-replayed', 'true');
      return c.json(result.result as object, result.replayed ? 200 : (op.http.status ?? 200));
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return INVALID_JSON;
  }
}
