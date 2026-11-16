import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  generateWebhookSecret,
  WEBHOOK_EVENT_TYPES,
  webhookEnvelope,
  webhookSignatureHeader,
} from '@airstock/core';
import { describe, expect, it } from 'vitest';
import { DOC_PATH, withCatalog } from '../../../scripts/webhook-catalog.ts';

const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

async function snippet(name: string): Promise<string> {
  const doc = await readFile(DOC_PATH, 'utf8');
  const block = doc.match(
    new RegExp(`<!-- ${name}:start -->\\n\`\`\`js\\n([\\s\\S]*?)\`\`\`\\n<!-- ${name}:end -->`),
  );
  if (!block) throw new Error(`No ${name} in docs/webhooks.md`);
  return block[1]!;
}

/** A delivery as Airstock sends it, signed at `at` (unix seconds) with these secrets. */
async function delivery(secrets: string[], at = Math.floor(Date.now() / 1000)) {
  const body = webhookEnvelope('0193a1b2-0000-7000-8000-000000000001', {
    id: '0193a1b2-0000-7000-8000-0000000000ff',
    type: 'stock.changed',
    createdAt: new Date(),
    data: WEBHOOK_EVENT_TYPES[0]!.sample,
    test: false,
  });
  return { body, header: await webhookSignatureHeader(secrets, at, body) };
}

/** Runs the n8n Code node snippet as n8n would, with the Webhook node's output as input. */
async function runN8n(
  code: string,
  secrets: string[],
  item: { body: string; header: string; raw: boolean },
) {
  const fn = new AsyncFunction(
    '$input',
    'require',
    code.replace("['whsec_paste_your_secret_here']", JSON.stringify(secrets)),
  );
  const input = {
    json: { headers: { 'airstock-signature': item.header }, body: JSON.parse(item.body) },
    ...(item.raw ? { binary: { data: { mimeType: 'application/json' } } } : {}),
  };
  const context = {
    helpers: { getBinaryDataBuffer: async () => Buffer.from(item.body, 'utf8') },
  };
  return fn.call(context, { all: () => [input] }, require) as Promise<Array<{ json: unknown }>>;
}

describe('docs/webhooks.md', () => {
  it('has the event catalog generated from the registry (run pnpm webhooks:docs)', async () => {
    const doc = await readFile(DOC_PATH, 'utf8');
    expect(withCatalog(doc)).toBe(doc);
    for (const type of WEBHOOK_EVENT_TYPES) expect(doc).toContain(`\`${type.id}\``);
  });

  it('gives an n8n Code node that accepts real deliveries and refuses bad ones', async () => {
    const code = await snippet('n8n-snippet');
    const [current, previous, stranger] = [
      generateWebhookSecret(),
      generateWebhookSecret(),
      generateWebhookSecret(),
    ];
    const ok = await delivery([current]);
    const out = await runN8n(code, [current], { ...ok, raw: true });
    expect(out[0]!.json).toMatchObject({ type: 'stock.changed', api_version: 'v1' });
    // Without Raw Body, re-serializing the parsed body gives the same bytes.
    await expect(runN8n(code, [current], { ...ok, raw: false })).resolves.toHaveLength(1);
    // During a rotation: signed with both, accepted by a receiver holding either.
    const rotating = await delivery([current, previous]);
    await expect(runN8n(code, [previous], { ...rotating, raw: true })).resolves.toHaveLength(1);
    await expect(runN8n(code, [current], { ...rotating, raw: true })).resolves.toHaveLength(1);
    await expect(runN8n(code, [stranger], { ...ok, raw: true })).rejects.toThrow(/does not match/);
    const old = await delivery([current], Math.floor(Date.now() / 1000) - 600);
    await expect(runN8n(code, [current], { ...old, raw: true })).rejects.toThrow(/too old/);
    await expect(
      runN8n(code, [current], { ...ok, body: ok.body.replace('"v1"', '"v2"'), raw: true }),
    ).rejects.toThrow(/does not match/);
  });

  it('gives a Node.js check that agrees with Airstock’s signatures', async () => {
    const code = (await snippet('node-snippet'))
      .replace("import { createHmac, timingSafeEqual } from 'node:crypto';", '')
      .replace('export function', 'function');
    const verify = new Function('createHmac', 'timingSafeEqual', `${code}\nreturn verifyAirstock;`)(
      require('node:crypto').createHmac,
      require('node:crypto').timingSafeEqual,
    ) as (header: string, body: string, secrets: string[]) => boolean;
    const [current, previous] = [generateWebhookSecret(), generateWebhookSecret()];
    const signed = await delivery([current, previous]);
    expect(verify(signed.header, signed.body, [previous])).toBe(true);
    expect(verify(signed.header, `${signed.body} `, [current])).toBe(false);
    const old = await delivery([current], Math.floor(Date.now() / 1000) - 600);
    expect(verify(old.header, old.body, [current])).toBe(false);
  });
});
