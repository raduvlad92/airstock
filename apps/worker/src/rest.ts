import { type AnyOperation, execute, operations } from '@airstock/core';
import type { Env, Handler, Hono } from 'hono';
import { type AppDeps, type AppEnv, fileAccess } from './app.ts';
import { mediaDelivery } from './media.ts';

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
  registerOperationRoutes(app, operations, (op) => async (c) => {
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
      {
        db: c.get('db'),
        audit: c.get('audit'),
        logger: deps.logger,
        ...fileAccess(deps),
        media: mediaDelivery(deps),
      },
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

/**
 * Registers a handler per operation in route order. Hono tries routes in the order they were
 * registered, so registry order must not decide which route takes a request.
 */
export function registerOperationRoutes<E extends Env>(
  app: Hono<E>,
  ops: readonly AnyOperation[],
  handler: (op: AnyOperation) => Handler<E>,
): void {
  for (const op of routeOrder(ops)) app.on(op.http.method, honoPath(op), handler(op));
}

/**
 * Operations sorted by path. At the first segment where two paths differ, a fixed segment
 * comes before a parameter, so `/items/query` is never taken by `/items/{itemId}`.
 */
export function routeOrder(ops: readonly AnyOperation[]): AnyOperation[] {
  return [...ops].sort((a, b) => comparePaths(a.http.path, b.http.path));
}

function comparePaths(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const xParam = x[i]!.startsWith('{');
    const yParam = y[i]!.startsWith('{');
    if (xParam !== yParam) return xParam ? 1 : -1;
    if (!xParam && x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length - y.length;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return INVALID_JSON;
  }
}
