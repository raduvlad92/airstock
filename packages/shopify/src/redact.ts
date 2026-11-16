import { execute, ops, shopifyConnectorCaller } from '@airstock/core';
import type { SyncDeps } from './sync.ts';

// shop/redact (one of Shopify's mandatory privacy webhooks) arrives 48 hours after a store
// uninstalled the app, when it is gone for good. Airstock keeps no customer data, but the orders
// of an uninstalled store may still hold stock: they are released now. Until then the holds stay,
// because the store may be installed again and its new connection continues those orders.

/** Releases what the uninstalled connections of a store still hold, in every shop. */
export async function releaseRedactedStore(
  deps: SyncDeps,
  input: { shopDomain: string; requestId?: string },
): Promise<{ connections: number; released: number }> {
  const connections = await deps.db.transaction(
    { shopId: null, userId: null, readOnly: true },
    (tx) =>
      tx.query<{ shop_id: string; connection_id: string; installed_by_membership_id: string }>(
        'select * from shopify_uninstalled_connections_for_domain($1)',
        [input.shopDomain],
      ),
  );
  let released = 0;
  for (const c of connections) {
    const done = await execute(deps, ops.releaseUninstalledShopifyHolds, {
      caller: shopifyConnectorCaller(c.shop_id, c.connection_id, c.installed_by_membership_id),
      shopId: c.shop_id,
      requestId: input.requestId,
      input: { connectionId: c.connection_id },
    });
    released += (done.result as { released: number }).released;
  }
  return { connections: connections.length, released };
}
