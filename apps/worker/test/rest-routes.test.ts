import { type AnyOperation, operations } from '@airstock/core';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerOperationRoutes } from '../src/rest.ts';

// Routes are registered the way mountRestRoutes does it, with a handler that names the
// operation, so a route that takes another operation's requests fails here.

const SAMPLE_ID = '019a8f2e-4c1b-7d3a-9e5f-0b6c7d8e9f10';

function samplePath(op: AnyOperation): string {
  return `/api/v1${op.http.path.replace(/\{\w+\}/g, SAMPLE_ID)}`;
}

function router(ops: readonly AnyOperation[]): Hono {
  const app = new Hono();
  registerOperationRoutes(app, ops, (op) => (c) => c.text(op.id));
  return app;
}

async function routedTo(app: Hono, op: AnyOperation): Promise<string> {
  const res = await app.request(samplePath(op), { method: op.http.method });
  return res.status === 200 ? res.text() : `HTTP ${res.status}`;
}

function fakeOperation(id: string, path: string): AnyOperation {
  return { ...operations[0]!, id, http: { method: 'GET', path } };
}

describe('REST routes', () => {
  it("sends each operation's own path to that operation", async () => {
    const app = router(operations);
    for (const op of operations) {
      expect(await routedTo(app, op), `${op.http.method} ${op.http.path}`).toBe(op.id);
    }
  });

  it('registers a fixed segment before a parameter, whatever the registry order', async () => {
    const byId = fakeOperation('items.get', '/shops/{shopId}/items/{itemId}');
    const query = fakeOperation('items.query', '/shops/{shopId}/items/query');
    const nested = fakeOperation('items.notes', '/shops/{shopId}/items/{itemId}/notes');
    for (const order of [
      [byId, query, nested],
      [nested, query, byId],
      [query, byId, nested],
    ]) {
      const app = router(order);
      for (const op of order) expect(await routedTo(app, op)).toBe(op.id);
    }
  });
});
