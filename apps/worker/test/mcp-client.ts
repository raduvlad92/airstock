import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { SeededShop } from '../../../test/helpers.ts';
import {
  connectionGrant,
  GRANT_CLAIM,
  type GrantMember,
  type Json,
  type TestApp,
} from './setup.ts';

/**
 * MCP test helpers shared by every area's tests. An area's MCP tests live with its other
 * tests (catalog.test.ts, storage.test.ts, ...); mcp-tools.test.ts holds the tool list.
 */

/** A tool's JSON answer, and whether the call was a tool error. */
export interface ToolResult {
  error: boolean;
  body: Json;
}

export interface McpSession {
  client: Client;
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

/** Signs an access token for a grant, as the authorization server does after consent. */
export function grantToken(
  t: TestApp,
  grant: { sub: string; clientId: string; grantId: string },
): Promise<string> {
  return t.sign({ sub: grant.sub, client_id: grant.clientId, [GRANT_CLAIM]: grant.grantId });
}

export function toolResult(res: unknown): ToolResult {
  const { isError, content } = res as { isError?: boolean; content?: Array<{ text?: string }> };
  return { error: isError === true, body: JSON.parse(content?.[0]?.text ?? 'null') };
}

/** Connects an MCP client to the test app's `/mcp` endpoint with a bearer token. */
export async function connectMcp(t: TestApp, token: string): Promise<McpSession> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://airstock.test/mcp'), {
      fetch: async (url, init) => t.app.fetch(new Request(url, init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return {
    client,
    call: async (tool, args = {}) =>
      toolResult(await client.callTool({ name: tool, arguments: args })),
    close: () => client.close(),
  };
}

/** A REST client for one shop with an API credential, to compare MCP answers with REST's. */
export function restClient(t: TestApp, shopId: string, token: string) {
  async function send(method: 'GET' | 'POST', path: string, body?: unknown, key?: string) {
    const headers = new Headers({ authorization: `Bearer ${token}` });
    if (method === 'POST') {
      headers.set('content-type', 'application/json');
      headers.set('idempotency-key', key ?? crypto.randomUUID());
    }
    const res = await t.app.request(`/api/v1/shops/${shopId}${path}`, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Json };
  }
  return {
    get: (path: string, query: Record<string, string> = {}) =>
      send('GET', Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path),
    post: (path: string, body: unknown = {}, key?: string) => send('POST', path, body, key),
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

/**
 * An answer with its IDs numbered in order of appearance, times blanked, and the given strings
 * (such as SKUs) replaced, so one request over MCP and over REST on twin records compare equal.
 */
export function anonymized(value: unknown, names: string[] = []): unknown {
  const ids = new Map<string, string>();
  let text = JSON.stringify(value);
  for (const [i, name] of names.entries()) text = text.split(name).join(`<name ${i}>`);
  text = text
    .replace(UUID, (id) => {
      if (!ids.has(id)) ids.set(id, `<id ${ids.size}>`);
      return ids.get(id)!;
    })
    .replace(TIME, '<time>');
  return JSON.parse(text);
}

/** Grants the shop's owner (or `member`) these scopes and connects an MCP client with them. */
export async function mcpSession(
  t: TestApp,
  shop: SeededShop,
  scopes: string[],
  member?: GrantMember,
): Promise<McpSession & { grantId: string }> {
  const grant = await connectionGrant(shop, scopes, { member });
  return { ...(await connectMcp(t, await grantToken(t, grant))), grantId: grant.grantId };
}
