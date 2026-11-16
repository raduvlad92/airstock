/**
 * ChatGPT tool-choice harness (Phase 2 plan D16, Section 7.4): lists the MCP calls a shop's
 * connections made in a time window as a Markdown table ready to paste into a status document.
 * With an expected list, it also marks each prompt right or wrong.
 *
 * Two ways to read the calls:
 *
 *   # API mode: an API credential of the shop with activity:read (every scope is fine).
 *   AIRSTOCK_TOKEN=ask_… pnpm chatgpt-run --shop <shop ID> --from 2026-11-20T09:00Z \
 *     [--base https://airstock.deletecookies.dev] [--to …] [--connection <grant ID>] \
 *     [--expect docs/chatgpt-runs/phase-2.json] [--gap 8] [--width 90] [--out run.md]
 *
 *   # Database mode: the owner connection string.
 *   DATABASE_OWNER_URL=postgres://… pnpm chatgpt-run --db --shop "ChatGPT run" --from … [same options]
 *
 * - API mode reads the shop's activity history (`GET /activity`, PRD 7.4) with the filters
 *   source mcp and actor type connection, page by page. It is the mode used when AIRSTOCK_TOKEN is
 *   set; `--db` picks the database instead. The token is read from the environment and never
 *   printed. `--shop` is the shop's ID (in the dashboard address, /app/shops/<ID>/…).
 * - Database mode reads `audit_events` and `connection_grants`; `--shop` takes a name or an ID.
 * - Times are ISO 8601; without a zone they are UTC.
 * - `--connection` keeps one connection (grant ID); by default every connection of the shop counts.
 * - A call is one tool call: the outcome event of its operation (a command's attempt event is
 *   skipped). Arguments come from the event: in database mode a read's input or its recorded
 *   filters, a command's changes, or the problem a refused call was told about. The activity API
 *   does not return a read's input or a refusal's details, so in API mode a read shows the record
 *   it was about (`{"variant":"…"}`) and a refusal only its code. A call refused before it reached
 *   an operation (an unknown action, say) leaves no event and is not listed.
 * - A connection's scopes come from `connection_grants` in database mode, and from the event that
 *   created it (`connection.created`) in API mode.
 * - `--expect` reads `{ "prompts": [{ "prompt": 1, "text": "…", "expect": [{ "tool": "get_stock",
 *   "action": "lot_trace" }] }] }`. An expected step may name an `outcome` (such as `denied`), and
 *   `or` lists other calls that also do (a report instead of a per-item read, say);
 *   `ordered: true` needs the steps in that order; `orNoCall: true` also counts a prompt right when
 *   none of its expected tools was called (a refusal before any call); `optional: true` marks a
 *   prompt the owner may skip: with no call it is listed as skipped and not counted. Prompts take the calls in
 *   time order, split only where `--gap` seconds or more passed between two calls (default 8): the
 *   split that makes the most prompts right wins, then the one that gives the most calls to a
 *   prompt expecting their tool, then the one that cuts at the longest pauses.
 *   When a split is off, give the prompt an `at` time (its first call is at or after it).
 * - Read-only in both modes: it never writes (its own API reads are in the shop's history, as
 *   source api). It prints shop data (tool arguments) to the terminal.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildMcpTools, operations } from '@airstock/core';
import pg from 'pg';

export interface AuditRow {
  event_id: string;
  occurred_at: Date;
  action: string;
  phase: 'attempt' | 'outcome';
  outcome: string;
  grant_id: string | null;
  request_id: string | null;
  attempt_id: string | null;
  changes: unknown;
  context: unknown;
  error: unknown;
  /** The record the event is about; the API mode shows it for a read. */
  target_type?: string | null;
  target_id?: string | null;
}

export interface Call {
  at: Date;
  tool: string;
  action: string | null;
  /** The operation's kind; null for an action no current operation records. */
  kind: 'read' | 'command' | null;
  outcome: string;
  errorCode: string | null;
  args: unknown;
  grantId: string | null;
}

export interface ExpectedCall {
  tool: string;
  action?: string | string[];
  outcome?: string;
}

export interface ExpectedStep extends ExpectedCall {
  /** Other calls that satisfy this step as well. */
  or?: ExpectedCall[];
}

export interface ExpectedPrompt {
  prompt: number;
  text?: string;
  expect: ExpectedStep[];
  ordered?: boolean;
  orNoCall?: boolean;
  /** A prompt the owner may skip; with no call of its own it is skipped, not wrong. */
  optional?: boolean;
  at?: string;
}

interface ToolAction {
  tool: string;
  action: string | null;
  kind: 'read' | 'command';
}

/** Audit action → MCP tool and action, from the operation registry as it is now. */
export function toolActions(): Map<string, ToolAction> {
  const map = new Map<string, ToolAction>();
  for (const tool of buildMcpTools(operations)) {
    for (const { action, operation } of tool.actions) {
      map.set(operation.audit.action, { tool: tool.name, action, kind: operation.kind });
    }
  }
  return map;
}

/** Audit actions of operations that are not MCP tools (dashboard-only, sign-in, and so on). */
function nonToolActions(map: Map<string, ToolAction>): Set<string> {
  return new Set(operations.map((o) => o.audit.action).filter((a) => !map.has(a)));
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The record an event is about, when it names one (a variant, a report). */
function targetOf(row: AuditRow): Record<string, string> | null {
  return row.target_type && row.target_id ? { [row.target_type]: row.target_id } : null;
}

/** What best shows the arguments of a call, from what its event recorded. */
function argsOf(row: AuditRow): unknown {
  const context = record(row.context);
  if (row.error) return context?.problem ?? null;
  if (context && 'input' in context) return context.input;
  return row.changes ?? row.context ?? targetOf(row);
}

/**
 * Turns audit events into tool calls, in time order. A request carries one tool call: for a
 * command, the outcome event that shares the attempt's action; otherwise the outcome event of a
 * tool's operation. Events from handlers (one per changed item, say) are not calls.
 */
export function callsFrom(rows: AuditRow[], map = toolActions()): Call[] {
  const skip = nonToolActions(map);
  const groups = new Map<string, AuditRow[]>();
  for (const row of rows) {
    const key = row.request_id ?? row.event_id;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const calls: Call[] = [];
  for (const group of groups.values()) {
    const attempt = group.find((r) => r.phase === 'attempt');
    const outcomes = group.filter(
      (r) => r.phase === 'outcome' && (!attempt || r.action === attempt.action),
    );
    const known = outcomes.filter((r) => map.has(r.action));
    // An action unknown to the registry (a tool renamed since the run) is listed, not dropped.
    const unknown = outcomes.filter((r) => !map.has(r.action) && !skip.has(r.action));
    const picked = attempt ? (known[0] ?? unknown[0] ?? attempt) : (known[0] ?? unknown[0] ?? null);
    if (!picked) continue;
    const entry = map.get(picked.action);
    const error = record(picked.error);
    calls.push({
      at: new Date(picked.occurred_at),
      tool: entry?.tool ?? '?',
      action: entry ? entry.action : picked.action,
      kind: entry?.kind ?? null,
      outcome: picked.phase === 'attempt' ? 'no outcome' : picked.outcome,
      errorCode: typeof error?.code === 'string' ? error.code : null,
      args: argsOf(picked),
      grantId: picked.grant_id,
    });
  }
  return calls.sort((a, b) => a.at.getTime() - b.at.getTime());
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The random end of an ID: UUIDv7s from one run share their first characters (the time). */
const shortId = (id: string) => `…${id.slice(-8)}`;

/** Compact JSON: IDs shortened, empty values dropped, long strings and lists cut. */
export function shorten(value: unknown, width = 90): string {
  const trim = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (UUID.test(v)) return shortId(v);
      return v.length > 40 ? `${v.slice(0, 39)}…` : v;
    }
    if (Array.isArray(v)) {
      const head = v.slice(0, 4).map(trim);
      return v.length > 4 ? [...head, `+${v.length - 4}`] : head;
    }
    const obj = record(v);
    if (obj) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(obj)) {
        if (x === null || x === undefined || x === false || x === '') continue;
        if (Array.isArray(x) && x.length === 0) continue;
        out[k] = trim(x);
      }
      return out;
    }
    return v;
  };
  if (value === null || value === undefined) return '';
  const text = JSON.stringify(trim(value));
  if (text === '{}' || text === '[]') return '';
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

const callMatches = (step: ExpectedCall, call: Call) =>
  step.tool === call.tool &&
  (step.action === undefined ||
    (Array.isArray(step.action) ? step.action : [step.action]).includes(call.action ?? '')) &&
  (step.outcome === undefined || step.outcome === call.outcome);

const actionMatches = (step: ExpectedStep, call: Call) =>
  callMatches(step, call) || (step.or ?? []).some((alt) => callMatches(alt, call));

/** Every tool a prompt expects, alternatives included. */
const toolsOf = (prompt: ExpectedPrompt) =>
  new Set(prompt.expect.flatMap((s) => [s.tool, ...(s.or ?? []).map((a) => a.tool)]));

/**
 * Whether these calls satisfy a prompt: each expected step needs its own call, in order when the
 * prompt says so. Steps naming an action are matched first, so a general step cannot take the call
 * a specific one needs.
 */
export function promptRight(prompt: ExpectedPrompt, calls: Call[]): boolean {
  const tools = toolsOf(prompt);
  if (prompt.orNoCall && !calls.some((c) => tools.has(c.tool))) return true;
  if (prompt.ordered) {
    let at = 0;
    for (const step of prompt.expect) {
      while (at < calls.length && !actionMatches(step, calls[at]!)) at++;
      if (at === calls.length) return false;
      at++;
    }
    return true;
  }
  const used = new Set<number>();
  const steps = [...prompt.expect].sort(
    (a, b) =>
      Number(b.action !== undefined) +
      Number(b.outcome !== undefined) -
      Number(a.action !== undefined) -
      Number(a.outcome !== undefined),
  );
  for (const step of steps) {
    const index = calls.findIndex((c, i) => !used.has(i) && actionMatches(step, c));
    if (index < 0) return false;
    used.add(index);
  }
  return true;
}

/**
 * Splits the calls, in time order, into one run of calls per prompt (possibly empty). A split
 * falls only where at least `gapSeconds` passed between two calls, or at a prompt's `at` time, so
 * one answer's calls stay together. The split that makes the most prompts right wins; among
 * those, the one that puts the most calls with a prompt that expects their tool, then the one that
 * cuts at the longest pauses. Returns each prompt's first call index (the next prompt's start ends
 * it).
 */
export function assignPrompts(prompts: ExpectedPrompt[], calls: Call[], gapSeconds = 8): number[] {
  const n = calls.length;
  const m = prompts.length;
  const seconds = (k: number) => (calls[k]!.at.getTime() - calls[k - 1]!.at.getTime()) / 1000;
  const pause = (k: number) => (k <= 0 || k >= n ? 0 : Math.log1p(seconds(k)));
  const fixedStart = prompts.map((p) => {
    if (!p.at) return null;
    const at = parseTime(p.at).getTime();
    const index = calls.findIndex((c) => c.at.getTime() >= at);
    return index < 0 ? n : index;
  });
  const cuts = new Set<number>([0, n]);
  for (let k = 1; k < n; k++) if (seconds(k) >= gapSeconds) cuts.add(k);
  for (const k of fixedStart) if (k !== null) cuts.add(k);
  const positions = [...cuts].sort((a, b) => a - b);
  // A right prompt outweighs everything else; then each call that uses one of its prompt's
  // expected tools; then the pauses where prompts start (a few per prompt at most).
  const RIGHT = 1e6;
  const OWN_TOOL = 1e3;
  const EARLY = 1e-3;
  const ownTools = (p: number, i: number, j: number) => {
    const tools = toolsOf(prompts[p]!);
    let count = 0;
    for (let k = i; k < j; k++) if (tools.has(calls[k]!.tool)) count++;
    return count;
  };
  const best: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(-Infinity));
  const from: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(-1));
  best[0]![0] = 0;
  for (let p = 0; p < m; p++) {
    for (const i of positions) {
      const base = best[p]![i]!;
      if (base === -Infinity) continue;
      // The first prompt also takes any calls before it; a fixed start pins where a prompt begins.
      if (fixedStart[p] !== null && i !== fixedStart[p] && p > 0) continue;
      for (const j of positions) {
        if (j < i) continue;
        const own = calls.slice(i, j);
        const score =
          base +
          (promptRight(prompts[p]!, own) ? RIGHT : 0) +
          OWN_TOOL * ownTools(p, i, j) +
          // Calls no prompt claims go to the earliest prompts rather than the last.
          (j > i ? pause(i) + EARLY * (m - p) : 0);
        if (score > best[p + 1]![j]!) {
          best[p + 1]![j] = score;
          from[p + 1]![j] = i;
        }
      }
    }
  }
  const starts = new Array<number>(m);
  let j = n;
  for (let p = m; p > 0; p--) {
    const i = from[p]![j]!;
    starts[p - 1] = i < 0 ? j : i;
    j = starts[p - 1]!;
  }
  return starts;
}

/** ISO 8601; a time without a zone is UTC. */
export function parseTime(text: string): Date {
  const zoned = /(Z|[+-]\d\d:?\d\d)$/i.test(text) ? text : `${text}Z`;
  const date = new Date(zoned);
  if (Number.isNaN(date.getTime())) throw new Error(`Not a time: ${text}`);
  return date;
}

const cell = (text: string) => text.replaceAll('|', '\\|').replace(/\s+/g, ' ');
const code = (text: string) => (text ? `\`${cell(text)}\`` : '');

function toolLabel(tool: string, action: string | string[] | null | undefined): string {
  const actions = action === null || action === undefined ? '' : [action].flat().join(' or ');
  return actions ? `${code(tool)} ${actions}` : code(tool);
}

function stepLabel(step: ExpectedStep): string {
  const one = (c: ExpectedCall) =>
    `${toolLabel(c.tool, c.action)}${c.outcome ? ` (${c.outcome})` : ''}`;
  return [step, ...(step.or ?? [])].map(one).join(' or ');
}

function outcomeLabel(call: Call): string {
  return call.errorCode ? `${call.outcome}: ${call.errorCode}` : call.outcome;
}

export interface RenderInput {
  shopName: string;
  from: Date;
  to: Date | null;
  calls: Call[];
  connections: Array<{ id: string; clientId: string | null; scopes: string[] }>;
  prompts?: ExpectedPrompt[];
  width?: number;
  /** Seconds between two calls where a prompt may end (see assignPrompts). */
  gapSeconds?: number;
}

/** The Markdown for a status document: the calls, then the verdict per prompt when expected. */
export function renderRun(input: RenderInput): string {
  const { calls, prompts } = input;
  const width = input.width ?? 90;
  const days = new Set(calls.map((c) => c.at.toISOString().slice(0, 10)));
  const time = (d: Date) =>
    days.size > 1 ? d.toISOString().slice(0, 19).replace('T', ' ') : d.toISOString().slice(11, 19);
  const manyConnections = new Set(calls.map((c) => c.grantId)).size > 1;
  const starts = prompts ? assignPrompts(prompts, calls, input.gapSeconds) : null;
  const promptOf = (index: number) => {
    if (!starts || !prompts) return null;
    let found = 0;
    for (let p = 0; p < starts.length; p++) if (starts[p]! <= index) found = p;
    return prompts[found]!.prompt;
  };
  const lines: string[] = [];
  const window = `${input.from.toISOString().slice(0, 16).replace('T', ' ')} to ${
    input.to ? input.to.toISOString().slice(0, 16).replace('T', ' ') : 'now'
  } UTC`;
  lines.push(`**Shop:** ${input.shopName}, ${window}. ${calls.length} calls.`, '');
  if (input.connections.length > 0) {
    lines.push(
      ...input.connections.map(
        (c) =>
          `- Connection ${code(shortId(c.id))}: ${c.clientId ?? 'not bound'}, ${c.scopes.join(', ')}`,
      ),
      '',
    );
  }
  const header = [
    '#',
    'Time (UTC)',
    ...(starts ? ['Prompt'] : []),
    ...(manyConnections ? ['Connection'] : []),
    'Tool',
    'Action',
    'Arguments',
    'Outcome',
  ];
  lines.push(`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`);
  calls.forEach((c, i) => {
    const row = [
      String(i + 1),
      time(c.at),
      ...(starts ? [String(promptOf(i))] : []),
      ...(manyConnections ? [code(c.grantId ? shortId(c.grantId) : '')] : []),
      code(c.tool),
      c.action ?? '',
      code(shorten(c.args, width)),
      outcomeLabel(c),
    ];
    lines.push(`| ${row.join(' | ')} |`);
  });
  if (prompts && starts) {
    let right = 0;
    let skipped = 0;
    lines.push('', '| Prompt | Expected | Called | Result |', '| --- | --- | --- | --- |');
    prompts.forEach((prompt, p) => {
      const own = calls.slice(starts[p], p + 1 < starts.length ? starts[p + 1] : calls.length);
      const skip = prompt.optional === true && own.length === 0;
      const ok = !skip && promptRight(prompt, own);
      if (ok) right++;
      if (skip) skipped++;
      const expected =
        prompt.expect.map(stepLabel).join(prompt.ordered ? ', then ' : ', ') +
        (prompt.orNoCall ? ', or no call' : '');
      const called =
        own
          .map(
            (c) =>
              `${toolLabel(c.tool, c.action)}${c.outcome === 'succeeded' ? '' : ` (${outcomeLabel(c)})`}`,
          )
          .join(', ') || 'no call';
      const label = prompt.text ? `${prompt.prompt}. ${cell(prompt.text)}` : String(prompt.prompt);
      const result = skip ? 'Skipped (optional)' : ok ? 'Right' : '**Wrong**';
      lines.push(`| ${label} | ${expected} | ${called} | ${result} |`);
    });
    const skippedNote = skipped > 0 ? ` (${skipped} optional skipped)` : '';
    lines.push(
      '',
      `**${right} of ${prompts.length - skipped} prompts right${skippedNote}.** Calls were matched to prompts in time order; check the Prompt column above, and give a prompt an \`at\` time in the expected file if a split is off.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Loads the shop, its MCP audit events in the window, and the connections that made them. */
export async function loadRun(
  client: pg.Client,
  options: { shop: string; from: Date; to: Date | null; connection: string | null },
): Promise<{ shopName: string; calls: Call[]; connections: RenderInput['connections'] }> {
  const shops = await client.query<{ id: string; name: string }>(
    UUID.test(options.shop)
      ? 'select id, name from shops where id = $1'
      : 'select id, name from shops where lower(name) = lower($1) order by created_at',
    [options.shop],
  );
  if (shops.rows.length === 0) throw new Error(`No shop named ${options.shop}.`);
  if (shops.rows.length > 1) {
    throw new Error(
      `Several shops are named ${options.shop}; give an ID: ${shops.rows.map((s) => s.id).join(', ')}`,
    );
  }
  const shop = shops.rows[0]!;
  const events = await client.query<AuditRow>(
    `select event_id, occurred_at, action, phase, outcome, grant_id, request_id, attempt_id,
       changes, context, error
     from audit_events
     where shop_id = $1 and source = 'mcp' and actor_type = 'connection'
       and occurred_at >= $2 and ($3::timestamptz is null or occurred_at < $3)
       and ($4::uuid is null or grant_id = $4)
     order by occurred_at, event_id`,
    [shop.id, options.from, options.to, options.connection],
  );
  const calls = callsFrom(events.rows);
  const grantIds = [...new Set(calls.map((c) => c.grantId).filter((g): g is string => !!g))];
  const grants = await client.query<{ id: string; client_id: string | null; scopes: string[] }>(
    'select id, client_id, scopes from connection_grants where shop_id = $1 and id = any($2::uuid[]) order by created_at',
    [shop.id, grantIds],
  );
  return {
    shopName: shop.name,
    calls,
    connections: grants.rows.map((g) => ({ id: g.id, clientId: g.client_id, scopes: g.scopes })),
  };
}

/** Where API mode reads from: an Airstock base URL, the shop, and an API credential's token. */
export interface ApiSource {
  base: string;
  shopId: string;
  token: string;
  /** Defaults to the global fetch; tests pass the app's own handler. */
  fetch?: (request: Request) => Promise<Response>;
}

/** An event as `GET /shops/{shopId}/activity` returns it (activity.list). */
export interface ActivityEvent {
  eventId: string;
  occurredAt: string;
  action: string;
  phase: 'attempt' | 'outcome';
  outcome: string;
  source: string;
  actorType: string;
  actorId: string | null;
  clientId: string | null;
  targetType: string | null;
  targetId: string | null;
  attemptId: string | null;
  requestId: string | null;
  changes: unknown;
  error: unknown;
}

interface ActivityPage {
  events: ActivityEvent[];
  nextCursor: string | null;
  ingestion: { delayed: boolean; pendingRequests: number } | null;
}

/** An activity event in the shape `callsFrom` reads; a connection's actor ID is its grant ID. */
export function rowFromEvent(e: ActivityEvent): AuditRow {
  return {
    event_id: e.eventId,
    occurred_at: new Date(e.occurredAt),
    action: e.action,
    phase: e.phase,
    outcome: e.outcome,
    grant_id: e.actorType === 'connection' ? e.actorId : null,
    request_id: e.requestId,
    attempt_id: e.attemptId,
    changes: e.changes,
    context: null,
    error: e.error,
    target_type: e.targetType,
    target_id: e.targetId,
  };
}

/** One GET under /api/v1/shops/{shopId}, waiting out rate limits (429) and brief outages. */
async function apiGet<T>(
  source: ApiSource,
  path: string,
  params: Record<string, string | null | undefined> = {},
): Promise<T> {
  const url = new URL(`${source.base.replace(/\/$/, '')}/api/v1/shops/${source.shopId}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  const send = source.fetch ?? ((request: Request) => fetch(request));
  for (let attempt = 0; ; attempt++) {
    const res = await send(
      new Request(url, { headers: { authorization: `Bearer ${source.token}` } }),
    );
    if ((res.status === 429 || res.status === 503) && attempt < 8) {
      const wait = Number(res.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, (wait > 0 ? wait : attempt + 1) * 1000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      // The problem body says why (unauthenticated, forbidden scope, invalid filter); the token
      // is never part of it.
      throw new Error(`GET ${url.pathname}${url.search}: ${res.status} ${text.slice(0, 500)}`);
    }
    return JSON.parse(text) as T;
  }
}

/**
 * Loads the shop, its MCP calls in the window, and the connections that made them, through the
 * activity API (PRD 7.4) with an API credential: newest first, 100 events a page, keyset cursor.
 * `delayed` is true when the history said recent events may still be on their way.
 */
export async function loadRunFromApi(
  source: ApiSource,
  options: { from: Date; to: Date | null; connection: string | null },
): Promise<{
  shopName: string;
  calls: Call[];
  connections: RenderInput['connections'];
  delayed: boolean;
}> {
  if (!UUID.test(source.shopId)) {
    throw new Error(
      "In API mode --shop is the shop's ID, as in the dashboard address /app/shops/<ID>/…",
    );
  }
  const { shop } = await apiGet<{ shop: { name: string } }>(source, '');
  const events: ActivityEvent[] = [];
  let delayed = false;
  let cursor: string | null = null;
  do {
    const page: ActivityPage = await apiGet<ActivityPage>(source, '/activity', {
      source: 'mcp',
      actorType: 'connection',
      actorId: options.connection,
      from: options.from.toISOString(),
      to: options.to?.toISOString(),
      limit: '100',
      before: cursor,
    });
    if (page.ingestion?.delayed) delayed = true;
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  // The API lists newest first; calls are built in time order.
  const rows = events.reverse().map(rowFromEvent);
  const calls = callsFrom(rows);
  const grantIds = [...new Set(calls.map((c) => c.grantId).filter((g): g is string => !!g))];
  const connections: Array<RenderInput['connections'][number] & { createdAt: string }> = [];
  for (const id of grantIds) {
    const { events: created } = await apiGet<ActivityPage>(source, '/activity', {
      action: 'connection.created',
      targetType: 'connection_grant',
      targetId: id,
      phase: 'outcome',
      limit: '1',
    });
    const scopes = record(created[0]?.changes)?.scopes;
    const clientId = events.find((e) => e.actorId === id && e.clientId)?.clientId ?? null;
    connections.push({
      id,
      clientId,
      scopes: Array.isArray(scopes) ? scopes.map(String) : [],
      createdAt: created[0]?.occurredAt ?? '',
    });
  }
  connections.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    shopName: shop.name,
    calls,
    connections: connections.map(({ createdAt: _, ...c }) => c),
    delayed,
  };
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      shop: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      connection: { type: 'string' },
      expect: { type: 'string' },
      width: { type: 'string', default: '90' },
      gap: { type: 'string', default: '8' },
      out: { type: 'string' },
      base: { type: 'string', default: 'https://airstock.deletecookies.dev' },
      db: { type: 'boolean', default: false },
    },
  });
  if (!args.shop || !args.from) throw new Error('Give --shop and --from (ISO time).');
  const token = process.env.AIRSTOCK_TOKEN;
  const url = process.env.DATABASE_OWNER_URL;
  if (args.db ? !url : !token) {
    throw new Error(
      args.db
        ? 'Set DATABASE_OWNER_URL for --db.'
        : 'Set AIRSTOCK_TOKEN (an API credential of the shop), or use --db with DATABASE_OWNER_URL.',
    );
  }
  const prompts = args.expect
    ? (JSON.parse(await readFile(args.expect, 'utf8')) as { prompts: ExpectedPrompt[] }).prompts
    : undefined;
  const from = parseTime(args.from);
  const to = args.to ? parseTime(args.to) : null;
  const connection = args.connection ?? null;
  let run: Awaited<ReturnType<typeof loadRun>>;
  if (args.db) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('set default_transaction_read_only = on');
      run = await loadRun(client, { shop: args.shop, from, to, connection });
    } finally {
      await client.end();
    }
  } else {
    const loaded = await loadRunFromApi(
      { base: args.base!, shopId: args.shop, token: token! },
      { from, to, connection },
    );
    if (loaded.delayed) {
      console.error(
        'The activity history says recent events may still be on their way; run again in a minute for the last calls.',
      );
    }
    run = loaded;
  }
  const markdown = renderRun({
    ...run,
    from,
    to,
    prompts,
    width: Number(args.width),
    gapSeconds: Number(args.gap),
  });
  if (args.out) await writeFile(args.out, markdown);
  process.stdout.write(markdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
