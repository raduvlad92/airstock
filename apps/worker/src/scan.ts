import { errors, uuidv7 } from '@airstock/core';
import type { Context, Hono } from 'hono';
import { type AppDeps, type AppEnv, problem } from './app.ts';
import { scanTestPage } from './html.ts';
import { readSession, sameOrigin } from './web.ts';

/** Where scan-test results are kept: the EU R2 bucket on staging (plan M7). */
export interface FileStore {
  put(key: string, body: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  get(key: string): Promise<string | null>;
}

const MAX_RESULTS = 200;

/**
 * The camera decode spike (plan M7, E8): a test page, an endpoint that stores each batch of
 * attempts with the device details, and a summary for the Phase 0 report. Signed-in users only.
 */
export function mountScanTest(app: Hono<AppEnv>, deps: AppDeps): void {
  const web = deps.web;
  const files = deps.files;
  if (!web || !files) return;

  const signedIn = async (c: Context<AppEnv>) => readSession(c, web);

  app.get('/scan-test', async (c) => {
    const session = await signedIn(c);
    if (!session) {
      return new Response(null, {
        status: 302,
        headers: { location: `/auth/login?return_to=${encodeURIComponent('/scan-test')}` },
      });
    }
    return scanTestPage({ email: session.email });
  });

  app.post('/scan-test/results', async (c) => {
    const session = await signedIn(c);
    if (!session || c.req.header('x-airstock-request') !== '1' || !sameOrigin(c, web)) {
      return problem(errors.unauthenticated(), c.get('requestId'));
    }
    const body = (await c.req.json().catch(() => null)) as {
      device?: unknown;
      attempts?: unknown;
    } | null;
    if (!body || !Array.isArray(body.attempts) || body.attempts.length > MAX_RESULTS) {
      return problem(
        errors.validation([{ path: 'attempts', message: `Up to ${MAX_RESULTS} attempts.` }]),
        c.get('requestId'),
      );
    }
    const now = new Date();
    const key = `scan-tests/${now.toISOString().slice(0, 10)}/${uuidv7()}.json`;
    await files.put(
      key,
      JSON.stringify({
        receivedAt: now.toISOString(),
        userId: session.uid,
        userAgent: c.req.header('user-agent') ?? null,
        device: body.device ?? null,
        attempts: body.attempts,
      }),
    );
    return c.json({ saved: key }, 201);
  });

  app.get('/scan-test/results', async (c) => {
    const session = await signedIn(c);
    if (!session || c.req.header('x-airstock-request') !== '1') {
      return problem(errors.unauthenticated(), c.get('requestId'));
    }
    const keys = (await files.list('scan-tests/')).slice(-500);
    const batches = [];
    for (const key of keys) {
      const text = await files.get(key);
      if (text) batches.push(JSON.parse(text));
    }
    return c.json({ batches });
  });
}
