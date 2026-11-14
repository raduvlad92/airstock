import type { ConnectionScope, Permission, Role } from './permissions.ts';

export type CallerKind = 'user' | 'api_credential' | 'connection' | 'connector' | 'system';
export type Source = 'dashboard' | 'api' | 'mcp' | 'import' | 'scheduled' | 'admin' | 'shopify';

export interface Membership {
  id: string;
  role: Role;
  allLocations: boolean;
  /** Warehouse or location IDs the member is limited to when allLocations is false. */
  locationScopeIds: string[];
  /**
   * Set for connectors, which act with a fixed permission set rather than a member's role.
   * Never set for people.
   */
  permissions?: ReadonlySet<Permission>;
}

/**
 * A verified caller. Built only by authentication code from verified credentials, never
 * from request arguments (PRD 7.2, 9.4).
 */
export interface Caller {
  kind: CallerKind;
  /** Stable identity: user, credential, grant, or connector ID. Binds idempotency keys. */
  id: string;
  /** The human the caller acts for, if any. */
  userId: string | null;
  /** Set for credentials bound to one shop (API credentials, MCP grants, connectors). */
  boundShopId: string | null;
  /** Resolved membership for boundShopId. Interactive users are resolved per request. */
  membership: Membership | null;
  /** 'all' for interactive sessions; otherwise the scopes granted to the credential. */
  scopes: ReadonlySet<ConnectionScope> | 'all';
  clientId?: string;
  grantId?: string;
  source: Source;
}

export function callerKey(caller: Caller): string {
  return `${caller.kind}:${caller.id}`;
}
