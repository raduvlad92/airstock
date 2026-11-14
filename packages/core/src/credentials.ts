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

/**
 * Resolves an MCP connection grant on every request, so revocation and membership changes
 * apply to the next tool call even while the access token is unexpired (PRD 9.4).
 */
export async function resolveConnectionGrant(
  db: Database,
  grantId: string,
  verified: { providerUserId: string; clientId: string },
): Promise<Caller | null> {
  const [row] = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query<ResolvedRow & { grant_id: string; client_id: string; workos_user_id: string | null }>(
      'select * from resolve_connection_grant($1)',
      [grantId],
    ),
  );
  if (!row || !isRole(row.role)) return null;
  // The grant must belong to the user and client the token was issued to: a token for one
  // user can never use another user's grant, whatever the grant ID claims.
  if (row.workos_user_id !== verified.providerUserId || row.client_id !== verified.clientId)
    return null;
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
    clientId: row.client_id,
    grantId: row.grant_id,
    source: 'mcp',
  };
}
