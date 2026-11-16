import { readFileSync, writeFileSync } from 'node:fs';
import { execute, ops, uuidv7 } from '@airstock/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  type ExpectedPrompt,
  loadRun,
  loadRunFromApi,
  renderRun,
} from '../../../scripts/chatgpt-run.ts';
import { seedRunShop } from '../../../scripts/chatgpt-run-shop.ts';
import { ownerQuery, type SeededShop, seedShop } from '../../../test/helpers.ts';
import {
  mcpCaller,
  type PromptRun,
  runFullAccessPrompts,
  runReadOnlyPrompt,
} from './chatgpt-run-prompts.ts';
import { connectMcp, grantToken } from './mcp-client.ts';
import { apiToken, type TestApp, testApp } from './setup.ts';

// The Phase 2 ChatGPT run (I7) end to end, in-process: the seed script fills a shop through the
// REST API with an API credential, each prompt's expected calls go through MCP, and the harness
// reads them back through the activity API with the same credential (the way the lead runs it on
// staging, with no database access) and marks every prompt of docs/chatgpt-runs/phase-2.json.

const ALL_SCOPES = [
  'shop:read',
  'catalog:read',
  'catalog:write',
  'storage:read',
  'storage:write',
  'inventory:read',
  'inventory:write',
  'activity:read',
  'webhooks:manage',
];
const MCP_FULL = ALL_SCOPES.filter((s) => s !== 'webhooks:manage');
const MCP_READ = MCP_FULL.filter((s) => s.endsWith(':read'));
const CHATGPT = 'https://chatgpt.com/oauth/client.json';
const EXPECTED = JSON.parse(
  readFileSync(new URL('../../../docs/chatgpt-runs/phase-2.json', import.meta.url), 'utf8'),
) as { prompts: ExpectedPrompt[] };

let t: TestApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(() => t.close());

/** A connection approved on the consent page, then used by ChatGPT (its first call binds it). */
async function connect(shop: SeededShop, scopes: string[]) {
  const created = await execute({ db: t.db, audit: t.sink }, ops.createConnection, {
    caller: shop.caller,
    shopId: shop.shopId,
    input: { scopes },
    idempotencyKey: uuidv7(),
  });
  const { grantId } = created.result as { grantId: string };
  const [user] = await ownerQuery<{ workos_user_id: string }>(
    'select workos_user_id from users where id = $1',
    [shop.userId],
  );
  const token = await grantToken(t, { sub: user!.workos_user_id, clientId: CHATGPT, grantId });
  return { grantId, session: await connectMcp(t, token) };
}

const local = async (request: Request) => t.app.fetch(request);

describe('ChatGPT run 2', () => {
  it('seeds through the API, runs the prompts through MCP, and reads them back through the API', async () => {
    const shop = await seedShop(t.db, t.sink, 'ChatGPT run 2');
    const { token } = await apiToken(t, shop, ALL_SCOPES);
    const target = { base: 'http://airstock.test', shopId: shop.shopId, token, fetch: local };
    const lines: string[] = [];
    const seeded = await seedRunShop(target, 'all', {
      log: (line) => lines.push(line),
      waitForMinute: false,
    });
    expect(seeded.valueMoment?.value).toBe('7415.2 EUR');
    expect(seeded.valueNow).toBe('7634.166672 EUR');
    // Running a phase again repeats nothing (each command's idempotency key names its step).
    expect(await seedRunShop(target, 'all', { log: () => {}, waitForMinute: false })).toMatchObject(
      { valueNow: '7634.166672 EUR' },
    );

    const from = new Date();
    const full = await connect(shop, MCP_FULL);
    const runs: PromptRun[] = await runFullAccessPrompts(mcpCaller(full.session.client), {
      valueMoment: seeded.valueMoment!.at,
      // Events carry millisecond times: a pause keeps each prompt's start after the last call.
      between: () => new Promise((r) => setTimeout(r, 5)),
    });
    await full.session.close();
    const readOnly = await connect(shop, MCP_READ);
    runs.push(await runReadOnlyPrompt(mcpCaller(readOnly.session.client)));
    await readOnly.session.close();
    // Reads and refusals reach the history through the audit queue.
    await t.sink.drain(t.db);
    t.sink.events.length = 0;

    const answer = (n: number) => JSON.parse(runs.find((r) => r.prompt === n)!.answer);
    expect(answer(1).totals).toMatchObject({
      onHand: '16.000000',
      reserved: '2.000000',
      available: '14.000000',
    });
    expect(answer(4).drafts.map((d: { number: string }) => d.number)).toEqual([
      'PO-0001',
      'PO-0002',
    ]);
    expect(answer(5).trace.orders).toEqual([expect.objectContaining({ externalRef: '1003' })]);
    expect(answer(8)).toMatchObject({
      now: { value: '8649.166656' },
      earlier: { value: '7415.2' },
    });
    expect(answer(12).item.productName).toBe('Umbreon VMAX 215/203 Evolving Skies PSA 10');
    expect(answer(15).detail).toBe('This connection was not granted the inventory:write scope.');

    // The harness through the activity API, with the shop's API credential.
    const run = await loadRunFromApi(target, { from, to: null, connection: null });
    expect(run.shopName).toBe('ChatGPT run 2');
    expect(run.connections).toEqual([
      { id: full.grantId, clientId: CHATGPT, scopes: MCP_FULL },
      { id: readOnly.grantId, clientId: CHATGPT, scopes: MCP_READ },
    ]);
    // The same calls as the database mode reads.
    const owner = new pg.Client({ connectionString: inject('databases').ownerUrl });
    await owner.connect();
    const fromDb = await loadRun(owner, {
      shop: shop.shopId,
      from,
      to: null,
      connection: null,
    }).finally(() => owner.end());
    const shape = (c: (typeof run.calls)[number]) => [c.tool, c.action, c.outcome, c.grantId];
    expect(run.calls.map(shape)).toEqual(fromDb.calls.map(shape));
    expect(run.calls.filter((c) => c.grantId === readOnly.grantId).at(-1)).toMatchObject({
      tool: 'adjust_stock',
      action: 'count',
      outcome: 'denied',
      errorCode: 'forbidden',
    });

    // Calls happen within milliseconds here, so each prompt is pinned to when it started.
    const prompts = EXPECTED.prompts.map((p) => {
      const started = runs.find((r) => r.prompt === p.prompt)?.startedAt;
      return started ? { ...p, at: started.toISOString() } : p;
    });
    const markdown = renderRun({ ...run, from, to: null, prompts });
    if (process.env.CHATGPT_RUN_OUT) {
      writeFileSync(process.env.CHATGPT_RUN_OUT, `${lines.join('\n')}\n\n${markdown}`);
    }
    expect(markdown).toContain('**13 of 13 prompts right (2 optional skipped).**');
    expect(markdown).not.toContain('**Wrong**');
  });
});
