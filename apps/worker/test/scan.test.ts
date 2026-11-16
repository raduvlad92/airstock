import { uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, PUBLIC_URL, signInAs, type TestApp, testApp } from './setup.ts';

let t: TestApp;
const stored = new Map<string, string>();

beforeAll(async () => {
  t = await testApp({
    files: {
      async put(key, body) {
        stored.set(key, body);
      },
      async list(prefix) {
        return [...stored.keys()].filter((k) => k.startsWith(prefix)).sort();
      },
      async get(key) {
        return stored.get(key) ?? null;
      },
    },
  });
});
afterAll(() => t.close());

describe('scan test', () => {
  it('needs a signed-in user and stores each batch of attempts with the device', async () => {
    const anonymous = await t.app.request('/scan-test');
    expect(anonymous.status).toBe(302);
    const refused = await t.app.request('/scan-test/results', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-airstock-request': '1',
        origin: PUBLIC_URL,
      },
      body: JSON.stringify({ attempts: [] }),
    });
    expect(refused.status).toBe(401);
    expect(stored.size).toBe(0);

    const { cookie } = await signInAs(t, {
      id: `user_${uuidv7().replace(/-/g, '')}`,
      email: 'scanner@example.com',
      firstName: null,
      lastName: null,
    });
    const page = await t.app.request('/scan-test', { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("'wasm-unsafe-eval'");
    const dashboard = await t.app.request('/app', { headers: { cookie } });
    // The dashboard allows WebAssembly too since the scanner moved into it (plan D13).
    expect(dashboard.headers.get('content-security-policy')).toContain("'wasm-unsafe-eval'");

    const attempt = { target: 'qr', decoder: 'zxing', success: true, correct: true, ms: 420 };
    const saved = await t.app.request('/scan-test/results', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-airstock-request': '1',
        origin: PUBLIC_URL,
      },
      body: JSON.stringify({ device: { standalone: true }, attempts: [attempt] }),
    });
    expect(saved.status).toBe(201);
    const listed = await json(
      await t.app.request('/scan-test/results', { headers: { cookie, 'x-airstock-request': '1' } }),
    );
    expect(listed.batches).toHaveLength(1);
    expect(listed.batches[0]).toMatchObject({ device: { standalone: true }, attempts: [attempt] });
  });
});
