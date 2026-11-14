import type { Database } from '@airstock/db';
import type { Caller } from './caller.ts';
import { sha256Hex, timingSafeEqualHex } from './hash.ts';
import { parseApiToken } from './operations/access.ts';
import { CONNECTION_SCOPES, type ConnectionScope, isRole } from './permissions.ts';

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
}

/**
 * Resolves an MCP connection grant on every request, so revocation and membership changes
 * apply to the next tool call even while the access token is unexpired (PRD 9.4).
 *
 * The consent step creates the grant before WorkOS issues a token, so the first verified token
 * that carries it binds the grant to its client and subject. Every later request must match
 * both: a grant can never move to another client or user. Only Airstock chooses the grant ID
 * that WorkOS puts in a token, at the consent step for the signed-in user.
 */
export async function resolveConnectionGrant(
  db: Database,
  grantId: string,
  verified: VerifiedConnectionToken,
): Promise<Caller | null> {
  const [row] = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query<
      ResolvedRow & {
        grant_id: string;
        client_id: string | null;
        token_subject: string | null;
        workos_user_id: string | null;
      }
    >('select * from resolve_connection_grant($1)', [grantId]),
  );
  if (!row || !isRole(row.role)) return null;
  let clientId = row.client_id;
  let subject = row.token_subject;
  if (clientId === null || subject === null) {
    const [bound] = await db.transaction({ shopId: null, userId: null }, (tx) =>
      tx.query<{ client_id: string; token_subject: string }>(
        'select * from bind_connection_grant($1, $2, $3, $4)',
        [grantId, verified.clientId, verified.subject, verified.clientName ?? null],
      ),
    );
    if (!bound) return null;
    clientId = bound.client_id;
    subject = bound.token_subject;
  }
  if (clientId !== verified.clientId || subject !== verified.subject) return null;
  return {
    kind: 'connection',
    id: row.grant_id,
    userId: row.user_id,
    boundShopId: row.shop_id,
    membership: {
      id: row.membership_id,
      role: row.role,
      allLocations: row.all_locations,
      locationScopeIds: row.location_scope_ids,
    },
    scopes: toScopes(row.scopes),
    clientId,
    grantId: row.grant_id,
    source: 'mcp',
  };
}
