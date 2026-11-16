import type { Database } from '@airstock/db';
import type { Caller, Source } from './caller.ts';
import { uuidv7 } from './ids.ts';

export interface VerifiedIdentity {
  /** Provider user ID from a verified token or callback (WorkOS). */
  providerUserId: string;
  email: string;
  displayName?: string | null;
}

/** Finds or creates the platform user for a verified sign-in. */
export async function ensureUser(db: Database, identity: VerifiedIdentity): Promise<string> {
  const rows = await db.transaction({ shopId: null, userId: null }, (tx) =>
    tx.query<{ id: string }>('select upsert_user_by_workos_id($1, $2, $3, $4) as id', [
      uuidv7(),
      identity.providerUserId,
      identity.email,
      identity.displayName ?? null,
    ]),
  );
  return rows[0]!.id;
}

/** An interactive dashboard user. Membership is resolved per shop by the pipeline. */
export function sessionCaller(userId: string, source: Source = 'dashboard'): Caller {
  return {
    kind: 'user',
    id: userId,
    userId,
    boundShopId: null,
    membership: null,
    scopes: 'all',
    source,
  };
}

export function systemCaller(id: string, shopId: string): Caller {
  return {
    kind: 'system',
    id,
    userId: null,
    boundShopId: shopId,
    membership: null,
    scopes: 'all',
    source: 'scheduled',
  };
}

/**
 * The Shopify connector acting for one connected store. It is bound to the connection's shop
 * and acts with a fixed permission set: it reads stock and reserves it for orders, and records
 * what the store reports. It never acts for a person (PRD 8.5).
 */
export function shopifyConnectorCaller(
  shopId: string,
  connectionId: string,
  installedByMembershipId: string,
): Caller {
  return {
    kind: 'connector',
    id: connectionId,
    userId: null,
    boundShopId: shopId,
    membership: {
      id: installedByMembershipId,
      role: 'inventory_operator',
      allLocations: true,
      locationScopeIds: [],
      permissions: new Set([
        'shop.read',
        'catalog.read',
        'storage.read',
        'inventory.read',
        'inventory.reserve',
        // Shopify reports fulfillments and returns; the order sync applies them (I6).
        'inventory.fulfill',
        'returns.manage',
        'integrations.sync',
      ]),
    },
    scopes: new Set(['shop:read', 'catalog:read', 'inventory:read', 'inventory:write']),
    clientId: 'shopify',
    source: 'shopify',
  };
}
