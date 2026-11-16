import type { Database, Tx } from '@airstock/db';
import { auditEvent, INSERT_AUDIT_EVENTS_SQL } from './audit.ts';
import type { Caller } from './caller.ts';
import { sha256Hex, timingSafeEqualHex } from './hash.ts';
import { uuidv7 } from './ids.ts';
import { parseApiToken } from './operations/access.ts';
import { CONNECTION_SCOPES, type ConnectionScope, isRole, type Role } from './permissions.ts';

interface ResolvedRow {
  shop_id: string;
  membership_id: string;
  user_id: string;
  role: string;
  all_locations: boolean;
  location_scope_ids: string[];
  scopes: string[];
}

function toScopes(values: string[]): ReadonlySet<ConnectionScope> {
  return new Set(
    values.filter((s): s is ConnectionScope =>
      (CONNECTION_SCOPES as readonly string[]).includes(s),
    ),
  );
}

/** Verifies an API token. Returns null for anything that does not verify (caller answers 401). */
export async function authenticateApiToken(db: Database, token: string): Promise<Caller | null> {
  const parsed = parseApiToken(token);
  if (!parsed) return null;
  const [row] = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query<ResolvedRow & { credential_id: string; secret_hash: string }>(
      'select * from authenticate_api_credential($1)',
      [parsed.credentialId],
    ),
  );
  const presented = await sha256Hex(parsed.secret);
  // Compare even when the row is missing, so timing does not reveal valid credential IDs.
  const ok = timingSafeEqualHex(presented, row?.secret_hash ?? '0'.repeat(64));
  if (!row || !ok || !isRole(row.role)) return null;
  return {
    kind: 'api_credential',
    id: row.credential_id,
    userId: row.user_id,
    boundShopId: row.shop_id,
    membership: {
      id: row.membership_id,
      role: row.role,
      allLocations: row.all_locations,
      locationScopeIds: row.location_scope_ids,
    },
    scopes: toScopes(row.scopes),
    source: 'api',
  };
}

export interface VerifiedConnectionToken {
  /** `sub` of the verified access token. */
  subject: string;
  /** OAuth client the token was issued to (`client_id` or `azp`). */
  clientId: string;
  clientName?: string | null;
  /** The request that presented the token, named in the events a first binding records. */
  requestId?: string;
}

interface GrantRow extends ResolvedRow {
  grant_id: string;
  client_id: string | null;
  token_subject: string | null;
  workos_user_id: string | null;
}

function connectionCaller(row: GrantRow, clientId: string): Caller {
  return {
    kind: 'connection',
    id: row.grant_id,
    userId: row.user_id,
    boundShopId: row.shop_id,
    membership: {
      id: row.membership_id,
      role: row.role as Role,
      allLocations: row.all_locations,
      locationScopeIds: row.location_scope_ids,
    },
    scopes: toScopes(row.scopes),
    clientId,
    grantId: row.grant_id,
    source: 'mcp',
  };
}

export const RECONSENT_REASON = 'Replaced by a new consent from the same person and client.';

/**
 * Binds an unbound grant to the first verified token that carries it (first writer wins) and,
 * when the binding matches that token, revokes the same person's earlier active connections from
 * the same OAuth client in this shop, in the same transaction (plan D20). The client is unknown
 * until this moment: the consent step runs before WorkOS issues a token. Each revoked grant gets
 * its own `connection.revoked` event naming its replacement. If a newer consent from the same
 * client is already bound, this grant is the one replaced, and the request is refused.
 */
async function bindGrant(
  db: Database,
  row: GrantRow,
  verified: VerifiedConnectionToken,
): Promise<{ client_id: string; token_subject: string } | null> {
  return db.transaction({ shopId: row.shop_id, userId: row.user_id }, async (tx) => {
    // One binding at a time per person and client, so two new consents cannot both survive.
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `connection-bind:${row.membership_id}:${verified.clientId}`,
    ]);
    const [bound] = await tx.query<{ client_id: string; token_subject: string }>(
      'select * from bind_connection_grant($1, $2, $3, $4)',
      [row.grant_id, verified.clientId, verified.subject, verified.clientName ?? null],
    );
    if (!bound) return null;
    if (bound.client_id !== verified.clientId || bound.token_subject !== verified.subject) {
      return bound;
    }
    const replacedBy = await revokeEarlierConsents(tx, row, bound.client_id, verified.requestId);
    return replacedBy ? null : bound;
  });
}

/**
 * Revokes every active bound grant of this member and client except the newest. Returns the ID
 * of the newer grant that replaced `row`'s grant, or null when `row`'s grant is the newest.
 */
async function revokeEarlierConsents(
  tx: Tx,
  row: GrantRow,
  clientId: string,
  requestId = uuidv7(),
): Promise<string | null> {
  const grants = await tx.query<{ id: string }>(
    `select id from connection_grants
     where membership_id = $1 and client_id = $2 and status = 'active' and bound_at is not null
     order by created_at, id`,
    [row.membership_id, clientId],
  );
  const newest = grants.at(-1)?.id;
  const replaced = grants.slice(0, -1).map((g) => g.id);
  if (!newest || replaced.length === 0) return null;
  await tx.query(
    `update connection_grants set status = 'revoked', revoked_at = now(), replaced_by = $1
     where id = any($2::uuid[])`,
    [newest, replaced],
  );
  const base = {
    shopId: row.shop_id,
    caller: connectionCaller(row, clientId),
    requestId,
    attemptId: null,
    idempotencyKey: null,
  };
  const events = replaced.map((id) =>
    auditEvent(base, {
      action: 'connection.revoked',
      phase: 'outcome',
      outcome: 'succeeded',
      target_type: 'connection_grant',
      target_id: id,
      reason: RECONSENT_REASON,
      changes: { status: 'revoked', replacedBy: newest },
      context: { trigger: 'reconsent', replacedBy: newest, clientId },
    }),
  );
  await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify(events)]);
  return newest === row.grant_id ? null : newest;
}

/**
 * Resolves an MCP connection grant on every request, so revocation and membership changes
 * apply to the next tool call even while the access token is unexpired (PRD 9.4).
 *
 * The consent step creates the grant before WorkOS issues a token, so the first verified token
 * that carries it binds the grant to its client and subject. Every later request must match
 * both: a grant can never move to another client or user. Only Airstock chooses the grant ID
 * that WorkOS puts in a token, at the consent step for the signed-in user. Binding also revokes
 * the same person's earlier connections from the same client in the shop (D20).
 */
export async function resolveConnectionGrant(
  db: Database,
  grantId: string,
  verified: VerifiedConnectionToken,
): Promise<Caller | null> {
  const [row] = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query<GrantRow>('select * from resolve_connection_grant($1)', [grantId]),
  );
  if (!row || !isRole(row.role)) return null;
  let clientId = row.client_id;
  let subject = row.token_subject;
  if (clientId === null || subject === null) {
    const bound = await bindGrant(db, row, verified);
    if (!bound) return null;
    clientId = bound.client_id;
    subject = bound.token_subject;
  }
  if (clientId !== verified.clientId || subject !== verified.subject) return null;
  return connectionCaller(row, clientId);
}
