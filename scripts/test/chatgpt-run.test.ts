import { type AnyOperation, type Caller, execute, ops, uuidv7 } from '@airstock/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  appDatabase,
  MemoryAuditSink,
  ownerQuery,
  type SeededShop,
  seedShop,
} from '../../test/helpers.ts';
import {
  assignPrompts,
  type Call,
  type ExpectedPrompt,
  loadRun,
  promptRight,
  renderRun,
  shorten,
} from '../chatgpt-run.ts';

// The ChatGPT tool-choice harness (Phase 2 plan D16) on synthetic MCP calls in the test database.

const db = appDatabase();
const sink = new MemoryAuditSink();
let shop: SeededShop;
const owner = new pg.Client({ connectionString: inject('databases').ownerUrl });

async function grant(scopes: string[]): Promise<Caller> {
  const [membership] = await ownerQuery<{ id: string }>(
    'select id from memberships where shop_id = $1 and user_id = $2',
    [shop.shopId, shop.userId],
  );
  const grantId = uuidv7();
  await ownerQuery(
    `insert into connection_grants (shop_id, id, membership_id, client_id, scopes, token_subject,
       bound_at)
     values ($1, $2, $3, 'https://chatgpt.com/oauth/client.json', $4, 'user_test', now())`,
    [shop.shopId, grantId, membership!.id, scopes],
  );
  return {
    kind: 'connection',
    id: grantId,
    userId: shop.userId,
    boundShopId: shop.shopId,
    membership: { id: membership!.id, role: 'owner', allLocations: true, locationScopeIds: [] },
    scopes: new Set(scopes) as Caller['scopes'],
    clientId: 'https://chatgpt.com/oauth/client.json',
    grantId,
    source: 'mcp',
  };
}

const base = new Date(Date.now() - 3_600_000);
base.setUTCMilliseconds(0);
const at = (seconds: number) => new Date(base.getTime() + seconds * 1000);

/** Runs an operation as a tool call would, then moves its events to a synthetic time. */
async function call(
  seconds: number,
  caller: Caller,
  op: AnyOperation,
  input: Record<string, unknown>,
): Promise<void> {
  const requestId = uuidv7();
  await execute({ db, audit: sink }, op, {
    caller,
    shopId: shop.shopId,
    input,
    idempotencyKey: op.idempotency === 'required' ? uuidv7() : null,
    requestId,
  }).catch(() => {});
  await sink.drain(db);
  sink.events.length = 0;
  await ownerQuery('update audit_events set occurred_at = $2 where request_id = $1', [
    requestId,
    at(seconds),
  ]);
}

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Harness shop');
  const full = await grant(['shop:read', 'catalog:read', 'catalog:write']);
  const readOnly = await grant(['shop:read', 'catalog:read']);
  // Before the window, and a dashboard read inside it: neither is listed.
  await call(-60, full, ops.getShopContext, {});
  await call(5, shop.caller, ops.getShopContext, {});
  // Prompt 1: a context read, then a search.
  await call(0, full, ops.getShopContext, {});
  await call(3, full, ops.queryItems, { search: 'oak | walnut' });
  // Prompt 2, after a pause: a refused update (no attempt event), then a create.
  await call(60, full, ops.updateItem, {});
  await call(64, full, ops.createItem, { name: 'Oak chair', sku: 'CHAIR-1' });
  // Prompt 3 on the read-only connection: the create is denied.
  await call(130, readOnly, ops.createItem, { name: 'Pine chair', sku: 'CHAIR-2' });
  await owner.connect();
});
afterAll(() => owner.end());

const PROMPTS: ExpectedPrompt[] = [
  { prompt: 1, expect: [{ tool: 'search_catalog', action: 'query' }] },
  { prompt: 2, expect: [{ tool: 'edit_catalog', action: 'create_product' }] },
  { prompt: 3, orNoCall: true, expect: [{ tool: 'edit_catalog', outcome: 'denied' }] },
  { prompt: 4, text: 'Export the spare parts.', expect: [{ tool: 'import_export' }] },
];

describe('chatgpt-run', () => {
  it('lists each MCP call of the shop once, with its tool, action, arguments, and outcome', async () => {
    const run = await loadRun(owner, {
      shop: 'harness SHOP',
      from: at(0),
      to: null,
      connection: null,
    });
    expect(run.shopName).toBe('Harness shop');
    expect(run.connections).toHaveLength(2);
    expect(
      run.calls.map((c) => [
        (c.at.getTime() - base.getTime()) / 1000,
        c.tool,
        c.action,
        c.outcome,
        c.errorCode,
      ]),
    ).toEqual([
      [0, 'get_shop_context', null, 'succeeded', null],
      [3, 'search_catalog', 'query', 'succeeded', null],
      [60, 'edit_catalog', 'update', 'failed', 'validation_failed'],
      [64, 'edit_catalog', 'create_product', 'succeeded', null],
      [130, 'edit_catalog', 'create_product', 'denied', 'forbidden'],
    ]);
    // One connection, and an end time.
    const narrow = await loadRun(owner, {
      shop: shop.shopId,
      from: at(0),
      to: at(100),
      connection: run.calls[0]!.grantId,
    });
    expect(narrow.calls.map((c) => c.tool)).toEqual([
      'get_shop_context',
      'search_catalog',
      'edit_catalog',
      'edit_catalog',
    ]);
  });

  it('prints a Markdown table and marks each expected prompt', async () => {
    const run = await loadRun(owner, {
      shop: shop.shopId,
      from: at(0),
      to: null,
      connection: null,
    });
    const markdown = renderRun({ ...run, from: at(0), to: null, prompts: PROMPTS });
    const lines = markdown.split('\n');
    expect(lines).toContain(
      '| # | Time (UTC) | Prompt | Connection | Tool | Action | Arguments | Outcome |',
    );
    const search = lines.find((l) => l.includes('`search_catalog`'))!;
    // Pipes in arguments are escaped; empty values are left out.
    expect(search).toContain('"search":"oak \\| walnut"');
    expect(search).not.toContain('"sort"');
    // The calls sit an hour back, so in the first hour after midnight UTC they fall on the day
    // before the shop's setup events, and the table then prints each time with its date.
    expect(search).toMatch(/^\| 2 \| (?:\d{4}-\d\d-\d\d )?\d\d:\d\d:\d\d \| 1 \|/);
    expect(lines.find((l) => l.startsWith('| 5 |'))).toMatch(/\| 3 \|.*\| denied: forbidden \|$/);
    expect(lines.filter((l) => /\| (Right|\*\*Wrong\*\*) \|$/.test(l))).toEqual([
      expect.stringMatching(/^\| 1 \| `search_catalog` query \| .* \| Right \|$/),
      expect.stringMatching(
        /^\| 2 \| .* \| `edit_catalog` update \(failed: validation_failed\), `edit_catalog` create_product \| Right \|$/,
      ),
      expect.stringMatching(/^\| 3 \| `edit_catalog` \(denied\), or no call \| .* \| Right \|$/),
      '| 4. Export the spare parts. | `import_export` | no call | **Wrong** |',
    ]);
    expect(markdown).toContain('**3 of 4 prompts right.**');
  });
});

describe('matching calls to prompts', () => {
  const t0 = Date.UTC(2026, 10, 20, 9, 0, 0);
  const c = (
    seconds: number,
    tool: string,
    action: string | null = null,
    outcome = 'succeeded',
  ): Call => ({
    at: new Date(t0 + seconds * 1000),
    tool,
    action,
    kind: 'read',
    outcome,
    errorCode: null,
    args: null,
    grantId: null,
  });

  it('keeps one answer’s calls together and splits at the longest pauses', () => {
    const calls = [
      c(0, 'get_stock'),
      c(4, 'get_stock'),
      c(40, 'receive_stock'),
      c(45, 'get_stock'),
    ];
    const prompts: ExpectedPrompt[] = [
      { prompt: 1, expect: [{ tool: 'get_stock' }] },
      { prompt: 2, expect: [{ tool: 'receive_stock' }] },
    ];
    // The get_stock 5 s after receive_stock belongs to prompt 2's answer.
    expect(assignPrompts(prompts, calls)).toEqual([0, 2]);
    // A prompt with no call of its own is wrong, and does not take another prompt's call.
    const three: ExpectedPrompt[] = [
      prompts[0]!,
      { prompt: 2, expect: [{ tool: 'transfer_stock' }] },
      prompts[1]!,
    ];
    const starts = assignPrompts(three, calls);
    expect(starts[2]).toBe(2);
    // An `at` time pins where a prompt starts.
    const pinned = assignPrompts(
      [prompts[0]!, { ...prompts[1]!, at: new Date(t0 + 4000).toISOString() }],
      calls,
    );
    expect(pinned).toEqual([0, 1]);
  });

  it('matches each expected step to its own call, in order when asked', () => {
    const lotsThenTrace = [c(0, 'get_stock', 'lots'), c(2, 'get_stock', 'lot_trace')];
    const prompt: ExpectedPrompt = {
      prompt: 5,
      expect: [{ tool: 'get_stock' }, { tool: 'get_stock', action: 'lot_trace' }],
    };
    expect(promptRight(prompt, lotsThenTrace)).toBe(true);
    expect(promptRight(prompt, [c(0, 'get_stock', 'lot_trace')])).toBe(false);
    const ordered: ExpectedPrompt = {
      prompt: 4,
      ordered: true,
      expect: [{ tool: 'stock_alerts' }, { tool: 'manage_purchasing' }],
    };
    expect(promptRight(ordered, [c(0, 'stock_alerts'), c(1, 'manage_purchasing')])).toBe(true);
    expect(promptRight(ordered, [c(0, 'manage_purchasing'), c(1, 'stock_alerts')])).toBe(false);
  });

  it('accepts an alternative call for a step', () => {
    const prompt: ExpectedPrompt = {
      prompt: 5,
      expect: [
        { tool: 'get_stock', action: 'lots', or: [{ tool: 'run_report', action: 'run' }] },
        { tool: 'get_stock', action: 'lot_trace' },
      ],
    };
    const trace = c(1, 'get_stock', 'lot_trace');
    expect(promptRight(prompt, [c(0, 'run_report', 'run'), trace])).toBe(true);
    expect(promptRight(prompt, [c(0, 'get_stock', 'lots'), trace])).toBe(true);
    expect(promptRight(prompt, [c(0, 'run_report', 'run')])).toBe(false);
    expect(promptRight(prompt, [c(0, 'search_catalog', 'query'), trace])).toBe(false);
  });

  it('skips an optional prompt without a call and leaves it out of the count', () => {
    const markdown = renderRun({
      shopName: 'Run',
      from: new Date(t0),
      to: null,
      connections: [],
      calls: [c(0, 'get_stock', 'stock'), c(30, 'run_report', 'run'), c(60, 'warehouse_work')],
      prompts: [
        { prompt: 1, expect: [{ tool: 'get_stock' }] },
        {
          prompt: 2,
          expect: [{ tool: 'get_stock', action: 'lots', or: [{ tool: 'run_report' }] }],
        },
        { prompt: 3, optional: true, expect: [{ tool: 'shopify_sync', action: 'health' }] },
        { prompt: 4, expect: [{ tool: 'warehouse_work' }] },
      ],
    });
    expect(markdown).toContain(
      '| 2 | `get_stock` lots or `run_report` | `run_report` run | Right |',
    );
    expect(markdown).toContain('| 3 | `shopify_sync` health | no call | Skipped (optional) |');
    expect(markdown).toContain('**3 of 3 prompts right (1 optional skipped).**');
  });

  it('shortens arguments for a table cell', () => {
    expect(
      shorten(
        {
          productId: '0196f3a0-0000-7000-8000-000000000002',
          filter: [1, 2, 3, 4, 5, 6],
          sort: null,
          fields: [],
          archived: false,
          name: 'x'.repeat(60),
        },
        200,
      ),
    ).toBe(`{"productId":"…00000002","filter":[1,2,3,4,"+2"],"name":"${'x'.repeat(39)}…"}`);
    expect(shorten({ a: 'y'.repeat(200) }, 20)).toHaveLength(20);
    expect(shorten(null)).toBe('');
  });
});
