import { z } from 'zod';
import { errors } from '../errors.ts';
import { sha256Hex } from '../hash.ts';
import { CONNECTION_SCOPES, effectivePermissions } from '../permissions.ts';
import { defineOperation } from '../registry.ts';
import { Id, iso } from '../schemas.ts';

const SESSION_ONLY =
  'Security: credentials and connections are managed only from an interactive session.';

/** Token format: ask_<credential id without dashes>_<base64url secret>. */
export function formatApiToken(credentialId: string, secret: string): string {
  return `ask_${credentialId.replaceAll('-', '')}_${secret}`;
}

export function parseApiToken(token: string): { credentialId: string; secret: string } | null {
  const match = /^ask_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const hex = match[1]!;
  const credentialId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { credentialId, secret: match[2]! };
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export const createApiCredential = defineOperation({
  id: 'credentials.create',
  summary: 'Create an API credential',
  description:
    'Creates a scoped credential that acts for you, never beyond your own permissions and locations. The token is shown once.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(z.enum(CONNECTION_SCOPES)).min(1),
  }),
  output: z.object({
    credentialId: Id,
    name: z.string(),
    scopes: z.array(z.string()),
    token: z.string(),
  }),
  permission: 'credentials.manage',
  connectionScope: 'session',
  audit: { action: 'credential.created' },
  // Not idempotent on purpose: a stored replay would keep the secret in the database.
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/api-credentials', status: 201 },
  mcp: { exception: SESSION_ONLY },
  async handler(ctx, input) {
    if (!ctx.membership) throw errors.forbidden('A shop membership is required.');
    const credentialId = ctx.newId();
    const secret = randomSecret();
    const scopes = [...new Set(input.scopes)];
    await ctx.tx.query(
      `insert into api_credentials (shop_id, id, membership_id, name, secret_hash, scopes)
       values (app_shop_id(), $1, $2, $3, $4, $5)`,
      [credentialId, ctx.membership.id, input.name, await sha256Hex(secret), scopes],
    );
    return {
      result: {
        credentialId,
        name: input.name,
        scopes,
        token: formatApiToken(credentialId, secret),
      },
      audit: {
        targetType: 'api_credential',
        targetId: credentialId,
        changes: { name: input.name, scopes },
      },
    };
  },
});

const CredentialSummary = z.object({
  credentialId: Id,
  name: z.string(),
  scopes: z.array(z.string()),
  status: z.string(),
  membershipId: Id,
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

export const listApiCredentials = defineOperation({
  id: 'credentials.list',
  summary: 'List API credentials',
  kind: 'read',
  scope: 'shop',
  input: z.object({}),
  output: z.object({ credentials: z.array(CredentialSummary) }),
  permission: 'credentials.manage',
  connectionScope: 'session',
  audit: { action: 'credentials.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/api-credentials' },
  mcp: { exception: SESSION_ONLY },
  async handler(ctx) {
    const rows = await ctx.tx.query<{
      id: string;
      name: string;
      scopes: string[];
      status: string;
      membership_id: string;
      created_at: Date;
      last_used_at: Date | null;
    }>(
      `select id, name, scopes, status, membership_id, created_at, last_used_at
       from api_credentials order by created_at desc limit 500`,
    );
    return {
      result: {
        credentials: rows.map((r) => ({
          credentialId: r.id,
          name: r.name,
          scopes: r.scopes,
          status: r.status,
          membershipId: r.membership_id,
          createdAt: iso(r.created_at) as string,
          lastUsedAt: iso(r.last_used_at),
        })),
      },
      audit: { targetType: 'api_credential', targetId: 'list' },
    };
  },
});

export const revokeApiCredential = defineOperation({
  id: 'credentials.revoke',
  summary: 'Revoke an API credential',
  kind: 'command',
  scope: 'shop',
  input: z.object({ credentialId: Id }),
  output: z.object({ credentialId: Id, status: z.literal('revoked') }),
  permission: 'credentials.manage',
  connectionScope: 'session',
  audit: { action: 'credential.revoked' },
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/api-credentials/{credentialId}/revoke' },
  mcp: { exception: SESSION_ONLY },
  async handler(ctx, input) {
    const [row] = await ctx.tx.query<{ status: string }>(
      'select status from api_credentials where id = $1 for update',
      [input.credentialId],
    );
    if (!row) throw errors.notFound('API credential');
    if (row.status === 'revoked')
      throw errors.conflict('already_revoked', 'The credential is already revoked.');
    await ctx.tx.query(
      `update api_credentials set status = 'revoked', revoked_at = now() where id = $1`,
      [input.credentialId],
    );
    return {
      result: { credentialId: input.credentialId, status: 'revoked' as const },
      audit: {
        targetType: 'api_credential',
        targetId: input.credentialId,
        changes: { status: 'revoked' },
      },
    };
  },
});

const ConnectionSummary = z.object({
  grantId: Id,
  /** Null until the first MCP request binds the grant to its OAuth client. */
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  scopes: z.array(z.string()),
  /** `active`, `revoked`, or `expired` (no client used it within the bind window). */
  status: z.string(),
  membershipId: Id,
  createdAt: z.string(),
  /** When the first MCP request bound the grant to its client; null until then. */
  boundAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});

/**
 * A grant's status as callers should see it: an unbound grant past the bind window is expired
 * even before the sweep records it (report P15).
 */
const CURRENT_STATUS = `case when status = 'active' and bound_at is null
    and created_at <= now() - connection_bind_window() then 'expired' else status end`;

export const createConnection = defineOperation({
  id: 'connections.create',
  summary: 'Approve an AI or OAuth connection',
  description:
    'The consent step: binds a new connection to this shop with the chosen scopes. The first request with the issued token binds it to that client (plan Section 7.2); a connection no client uses within 10 minutes expires.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    scopes: z.array(z.enum(CONNECTION_SCOPES)).min(1),
  }),
  output: z.object({ grantId: Id, scopes: z.array(z.string()) }),
  permission: 'shop.read',
  connectionScope: 'session',
  audit: { action: 'connection.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/connections', status: 201 },
  mcp: { exception: SESSION_ONLY },
  async handler(ctx, input) {
    if (!ctx.membership) throw errors.forbidden('A shop membership is required.');
    const grantId = ctx.newId();
    const scopes = CONNECTION_SCOPES.filter((s) => input.scopes.includes(s));
    await ctx.tx.query(
      `insert into connection_grants (shop_id, id, membership_id, scopes)
       values (app_shop_id(), $1, $2, $3)`,
      [grantId, ctx.membership.id, scopes],
    );
    return {
      result: { grantId, scopes },
      audit: { targetType: 'connection_grant', targetId: grantId, changes: { scopes } },
    };
  },
});

export const listConnections = defineOperation({
  id: 'connections.list',
  summary: 'List AI and OAuth connections',
  description:
    'Your own connections, or every connection in the shop with the connections.manage permission.',
  kind: 'read',
  scope: 'shop',
  input: z.object({}),
  output: z.object({ connections: z.array(ConnectionSummary) }),
  permission: 'shop.read',
  connectionScope: 'session',
  audit: { action: 'connections.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/connections' },
  mcp: { exception: SESSION_ONLY },
  async handler(ctx) {
    const all = ctx.membership
      ? effectivePermissions(ctx.membership).has('connections.manage')
      : false;
    const rows = await ctx.tx.query<{
      id: string;
      client_id: string | null;
      client_name: string | null;
      scopes: string[];
      status: string;
      membership_id: string;
      created_at: Date;
      bound_at: Date | null;
      last_used_at: Date | null;
    }>(
      `select id, client_id, client_name, scopes, ${CURRENT_STATUS} as status, membership_id,
         created_at, bound_at, last_used_at
       from connection_grants where ($1 or membership_id = $2) order by created_at desc limit 500`,
      [all, ctx.membership?.id ?? null],
    );
    return {
      result: {
        connections: rows.map((r) => ({
          grantId: r.id,
          clientId: r.client_id,
          clientName: r.client_name,
          scopes: r.scopes,
          status: r.status,
          membershipId: r.membership_id,
          createdAt: iso(r.created_at) as string,
          boundAt: iso(r.bound_at),
          lastUsedAt: iso(r.last_used_at),
        })),
      },
      audit: { targetType: 'connection_grant', targetId: 'list' },
    };
  },
});

export const revokeConnection = defineOperation({
  id: 'connections.revoke',
  summary: 'Revoke an AI or OAuth connection',
  description:
    'Stops the connection on its next request, even if its access token has not expired (PRD 9.4).',
  kind: 'command',
  scope: 'shop',
  input: z.object({ grantId: Id }),
  output: z.object({ grantId: Id, status: z.literal('revoked') }),
  permission: 'shop.read',
  connectionScope: 'session',
  audit: { action: 'connection.revoked' },
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/connections/{grantId}/revoke' },
  mcp: { exception: SESSION_ONLY },
  async handler(ctx, input) {
    const [row] = await ctx.tx.query<{ status: string; membership_id: string }>(
      `select ${CURRENT_STATUS} as status, membership_id from connection_grants
       where id = $1 for update`,
      [input.grantId],
    );
    if (!row) throw errors.notFound('Connection');
    const canManage = ctx.membership
      ? effectivePermissions(ctx.membership).has('connections.manage')
      : false;
    if (!canManage && row.membership_id !== ctx.membership?.id) {
      throw errors.forbidden('You can revoke only your own connections.');
    }
    if (row.status === 'revoked')
      throw errors.conflict('already_revoked', 'The connection is already revoked.');
    if (row.status === 'expired')
      throw errors.conflict('expired', 'The connection expired before any client used it.');
    await ctx.tx.query(
      `update connection_grants set status = 'revoked', revoked_at = now() where id = $1`,
      [input.grantId],
    );
    return {
      result: { grantId: input.grantId, status: 'revoked' as const },
      audit: {
        targetType: 'connection_grant',
        targetId: input.grantId,
        changes: { status: 'revoked' },
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const accessOperations = [
  createApiCredential,
  listApiCredentials,
  revokeApiCredential,
  createConnection,
  listConnections,
  revokeConnection,
] as const;
