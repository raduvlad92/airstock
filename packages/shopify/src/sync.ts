import {
  AppError,
  type AuditEvent,
  auditEvent,
  type Caller,
  execute,
  INSERT_AUDIT_EVENTS_SQL,
  normalizeSku,
  ops,
  type PipelineDeps,
  shopifyConnectorCaller,
} from '@airstock/core';
import type { Tx } from '@airstock/db';
import {
  type ShopifyAdmin,
  ShopifyApiError,
  type ShopifyOrder,
  type ShopifyOrderLine,
  type WebhookStatus,
} from './admin.ts';
import { type TokenCipher, tokenContext } from './crypto.ts';
import { SHOPIFY_SCOPES, type ShopifyAuth } from './oauth.ts';

// The Shopify slice end to end (plan Section 8.2): install, webhook intake, order lines to
// reservations, and the compare-and-set availability push with the P1 mismatch handling.

export interface ShopifyConfig {
  cipher: TokenCipher;
  auth: ShopifyAuth;
  /** Builds an Admin API client for one store; tests pass a fake store. */
  admin(shopDomain: string, accessToken: string): ShopifyAdmin;
  /** Where Shopify sends webhooks, such as https://airstock.example/shopify/webhooks. */
  webhookUri: string;
}

export interface SyncDeps extends PipelineDeps {
  shopify: ShopifyConfig;
  /** Publishes committed outbox rows now; the cron sweeper covers anything missed. */
  dispatch?: () => Promise<unknown>;
}

export const ORDER_JOB = 'shopify.order_created';
/** Order topics bring a job that syncs the order's state (orders/create carries its lines). */
export const ORDER_TOPICS = [
  'orders/create',
  'orders/edited',
  'orders/cancelled',
  'fulfillments/create',
  'fulfillments/update',
  'refunds/create',
];
export const WEBHOOK_TOPICS = [
  'ORDERS_CREATE',
  'ORDERS_EDITED',
  'ORDERS_CANCELLED',
  'FULFILLMENTS_CREATE',
  'FULFILLMENTS_UPDATE',
  'REFUNDS_CREATE',
  'APP_UNINSTALLED',
];
/** Refresh the one-hour access token when less than this is left. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface ConnectionRow {
  id: string;
  shop_domain: string;
  status: string;
  token_key_id: string;
  access_token_ciphertext: string | null;
  access_token_expires_at: Date | null;
  refresh_token_ciphertext: string | null;
  installed_by_membership_id: string;
  created_at: Date;
}

const CONNECTION_COLUMNS = `id, shop_domain, status, token_key_id, access_token_ciphertext,
  access_token_expires_at, refresh_token_ciphertext, installed_by_membership_id, created_at`;

export class NotConnectedError extends Error {
  constructor() {
    super('The Shopify store is not connected.');
    this.name = 'NotConnectedError';
  }
}

// Install ---------------------------------------------------------------------------------

/** Granted scopes cover the requested ones; a write scope implies its read scope. */
export function missingScopes(granted: string[]): string[] {
  const have = new Set(granted);
  for (const scope of granted) {
    if (scope.startsWith('write_')) have.add(`read_${scope.slice(6)}`);
  }
  return SHOPIFY_SCOPES.filter((s) => !have.has(s));
}

/**
 * Finishes an install the merchant approved: exchanges the code, stores the tokens encrypted,
 * records the store's locations, and subscribes to the webhooks Phase 0 needs.
 */
export async function completeInstall(
  deps: SyncDeps,
  input: { caller: Caller; shopId: string; shopDomain: string; code: string; requestId: string },
): Promise<{ connectionId: string; webhooks: WebhookStatus[]; missingScopes: string[] }> {
  const { cipher, auth } = deps.shopify;
  const tokens = await auth.exchangeCode(input.shopDomain, input.code);
  const connected = await execute(deps, ops.connectShopifyStore, {
    caller: input.caller,
    shopId: input.shopId,
    requestId: input.requestId,
    input: {
      shopDomain: input.shopDomain,
      scopes: tokens.scopes,
      tokenKeyId: cipher.keyId,
      accessTokenCiphertext: await cipher.encrypt(
        tokens.accessToken,
        tokenContext(input.shopId, input.shopDomain, 'access'),
      ),
      accessTokenExpiresAt: tokens.accessTokenExpiresAt?.toISOString() ?? null,
      refreshTokenCiphertext: tokens.refreshToken
        ? await cipher.encrypt(
            tokens.refreshToken,
            tokenContext(input.shopId, input.shopDomain, 'refresh'),
          )
        : null,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt?.toISOString() ?? null,
    },
  });
  const { connectionId } = connected.result as { connectionId: string };
  const admin = deps.shopify.admin(input.shopDomain, tokens.accessToken);
  let locations: Array<{ id: string; name: string; active: boolean }> | undefined;
  try {
    locations = await admin.locations();
  } catch (error) {
    deps.logger?.error('shopify_locations_failed', { error: String(error) });
  }
  let webhooks: WebhookStatus[];
  try {
    webhooks = await admin.ensureWebhooks(deps.shopify.webhookUri, WEBHOOK_TOPICS);
  } catch (error) {
    webhooks = [{ topic: '*', status: 'failed', message: String((error as Error).message) }];
  }
  await execute(deps, ops.updateShopifyConnectionDetails, {
    caller: input.caller,
    shopId: input.shopId,
    requestId: input.requestId,
    input: { connectionId, shopifyLocations: locations, webhooks },
  });
  return { connectionId, webhooks, missingScopes: missingScopes(tokens.scopes) };
}

// Admin access with expiring tokens --------------------------------------------------------

export interface ConnectedStore {
  shopId: string;
  connectionId: string;
  shopDomain: string;
  createdAt: Date;
  caller: Caller;
  admin: ShopifyAdmin;
}

/**
 * An Admin API client for a connection, refreshing the access token first when it is about to
 * expire. The refresh runs under a row lock so two workers never rotate the same token pair at
 * once (Shopify retires the older pair when the newer one is used).
 */
export async function connectedStore(
  deps: SyncDeps,
  shopId: string,
  connectionId: string,
): Promise<ConnectedStore> {
  const { cipher, auth } = deps.shopify;
  const [row] = await deps.db.transaction({ shopId, userId: null, readOnly: true }, (tx) =>
    tx.query<ConnectionRow>(`select ${CONNECTION_COLUMNS} from shopify_connections where id = $1`, [
      connectionId,
    ]),
  );
  if (row?.status !== 'active' || !row.access_token_ciphertext) {
    throw new NotConnectedError();
  }
  if (row.token_key_id !== cipher.keyId) {
    throw new Error(`Shopify token key ${row.token_key_id} is not loaded.`);
  }
  const access = (kind: 'access' | 'refresh') => tokenContext(shopId, row.shop_domain, kind);
  const needsRefresh = (r: ConnectionRow) =>
    r.access_token_expires_at !== null &&
    new Date(r.access_token_expires_at).getTime() - Date.now() < REFRESH_MARGIN_MS;

  let accessToken: string;
  if (!needsRefresh(row)) {
    accessToken = await cipher.decrypt(row.access_token_ciphertext, access('access'));
  } else {
    accessToken = await deps.db.transaction({ shopId, userId: null }, async (tx) => {
      const [locked] = await tx.query<ConnectionRow>(
        `select ${CONNECTION_COLUMNS} from shopify_connections where id = $1 for update`,
        [connectionId],
      );
      if (locked?.status !== 'active' || !locked.access_token_ciphertext) {
        throw new NotConnectedError();
      }
      if (!needsRefresh(locked)) {
        return cipher.decrypt(locked.access_token_ciphertext, access('access'));
      }
      if (!locked.refresh_token_ciphertext) throw new NotConnectedError();
      const refreshed = await auth.refresh(
        locked.shop_domain,
        await cipher.decrypt(locked.refresh_token_ciphertext, access('refresh')),
      );
      await tx.query(
        `update shopify_connections set access_token_ciphertext = $2, access_token_expires_at = $3,
           refresh_token_ciphertext = coalesce($4, refresh_token_ciphertext),
           refresh_token_expires_at = coalesce($5, refresh_token_expires_at), updated_at = now()
         where id = $1`,
        [
          connectionId,
          await cipher.encrypt(refreshed.accessToken, access('access')),
          refreshed.accessTokenExpiresAt?.toISOString() ?? null,
          refreshed.refreshToken
            ? await cipher.encrypt(refreshed.refreshToken, access('refresh'))
            : null,
          refreshed.refreshTokenExpiresAt?.toISOString() ?? null,
        ],
      );
      return refreshed.accessToken;
    });
  }
  return {
    shopId,
    connectionId,
    shopDomain: row.shop_domain,
    createdAt: new Date(row.created_at),
    caller: shopifyConnectorCaller(shopId, connectionId, row.installed_by_membership_id),
    admin: deps.shopify.admin(row.shop_domain, accessToken),
  };
}

// Webhooks --------------------------------------------------------------------------------

/** The minimal order a reservation needs, taken from an orders/create payload. */
export function parseOrderWebhook(body: string): ShopifyOrder {
  const raw = JSON.parse(body) as {
    id?: unknown;
    admin_graphql_api_id?: unknown;
    created_at?: unknown;
    line_items?: Array<{ id?: unknown; variant_id?: unknown; quantity?: unknown }>;
  };
  const idOf = (value: unknown): string | null => {
    if (typeof value === 'string' && /^(gid:\/\/shopify\/\w+\/)?\d+$/.test(value)) {
      return value.slice(value.lastIndexOf('/') + 1);
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    return null;
  };
  const orderId = idOf(raw.admin_graphql_api_id) ?? idOf(raw.id);
  if (!orderId || typeof raw.created_at !== 'string' || !Array.isArray(raw.line_items)) {
    throw new Error('Unexpected orders/create payload.');
  }
  const lines: ShopifyOrderLine[] = raw.line_items.slice(0, 500).flatMap((line) => {
    const lineId = idOf(line.id);
    const quantity = Number(line.quantity);
    if (!lineId || !Number.isInteger(quantity)) return [];
    return [{ lineId, variantId: idOf(line.variant_id), quantity }];
  });
  return { orderId, createdAt: raw.created_at, lines };
}

/** The order a webhook is about; its state is then read from the Admin API. */
export function orderIdOf(topic: string, body: string): string | null {
  const raw = JSON.parse(body) as {
    id?: unknown;
    admin_graphql_api_id?: unknown;
    order_id?: unknown;
    order_edit?: { order_id?: unknown };
  };
  const value =
    topic === 'orders/edited'
      ? raw.order_edit?.order_id
      : topic.startsWith('orders/')
        ? (raw.admin_graphql_api_id ?? raw.id)
        : raw.order_id;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^(gid:\/\/shopify\/Order\/)?\d+$/.test(value)) {
    return value.slice(value.lastIndexOf('/') + 1);
  }
  return null;
}

export type WebhookOutcome =
  | { status: 'unknown_store' }
  | { status: 'recorded'; shopId: string; jobId: string | null; duplicate: boolean };

/**
 * Records a webhook whose HMAC already verified. The receipt and its job commit together, so
 * a duplicate delivery finds the receipt and changes nothing (A30); the caller then hands the
 * job to the queue.
 */
export async function receiveWebhook(
  deps: SyncDeps,
  input: {
    shopDomain: string;
    topic: string;
    eventId: string;
    webhookId: string | null;
    triggeredAt: string | null;
    body: string;
    requestId?: string;
  },
): Promise<WebhookOutcome> {
  const [connection] = await deps.db.transaction(
    { shopId: null, userId: null, readOnly: true },
    (tx) =>
      tx.query<{ shop_id: string; connection_id: string; installed_by_membership_id: string }>(
        'select * from shopify_connection_for_domain($1)',
        [input.shopDomain],
      ),
  );
  if (!connection) return { status: 'unknown_store' };
  const shopId = connection.shop_id;
  const connectionId = connection.connection_id;
  const caller = shopifyConnectorCaller(
    shopId,
    connectionId,
    connection.installed_by_membership_id,
  );
  let job: { kind: string; payload: unknown } | null = null;
  if (input.topic === 'orders/create') {
    job = { kind: ORDER_JOB, payload: { connectionId, order: parseOrderWebhook(input.body) } };
  } else if (ORDER_TOPICS.includes(input.topic)) {
    const orderId = orderIdOf(input.topic, input.body);
    if (orderId) job = { kind: ORDER_JOB, payload: { connectionId, orderId } };
  }
  const triggeredAt =
    input.triggeredAt && !Number.isNaN(Date.parse(input.triggeredAt)) ? input.triggeredAt : null;
  const recorded = await execute(deps, ops.recordShopifyWebhook, {
    caller,
    shopId,
    requestId: input.requestId,
    input: {
      connectionId,
      topic: input.topic,
      eventId: input.eventId,
      webhookId: input.webhookId,
      triggeredAt,
      job,
    },
  });
  const result = recorded.result as { jobId: string | null; duplicate: boolean };
  if (input.topic === 'app/uninstalled' && !result.duplicate) {
    await execute(deps, ops.markShopifyUninstalled, {
      caller,
      shopId,
      requestId: input.requestId,
      input: { connectionId },
    });
  }
  return { status: 'recorded', shopId, jobId: result.jobId, duplicate: result.duplicate };
}

// Jobs ------------------------------------------------------------------------------------

export type JobOutcome =
  | { status: 'done' | 'missing' | 'failed' }
  | { status: 'retry'; delaySeconds: number };

function retryable(error: unknown): boolean {
  if (error instanceof NotConnectedError) return false;
  if (error instanceof AppError) return error.status >= 500 || error.code === 'retry_conflict';
  if (error instanceof ShopifyApiError) return error.retryable;
  return true;
}

/**
 * Runs one job row. Another runner takes over a running job only after five minutes, so the
 * immediate run and its queued safety copy do not both work on it; every effect is idempotent
 * in any case.
 */
export async function runJob(deps: SyncDeps, shopId: string, jobId: string): Promise<JobOutcome> {
  const [job] = await deps.db.transaction({ shopId, userId: null }, (tx) =>
    tx.query<{
      kind: string;
      payload: { connectionId: string; order?: ShopifyOrder; orderId?: string };
      attempts: number;
    }>(
      `update jobs set status = 'running', attempts = attempts + 1, updated_at = now()
       where id = $1 and (status = 'pending'
         or (status = 'running' and updated_at <= now() - interval '5 minutes'))
       returning kind, payload, attempts`,
      [jobId],
    ),
  );
  if (!job) return { status: 'missing' };
  try {
    if (job.kind !== ORDER_JOB) throw new Error(`Unknown job kind ${job.kind}.`);
    let order = job.payload.order ?? null;
    if (!order && job.payload.orderId) {
      const store = await connectedStore(deps, shopId, job.payload.connectionId);
      order = await store.admin.order(job.payload.orderId);
    }
    const result = order
      ? await processOrder(deps, shopId, job.payload.connectionId, order)
      : { deleted: true };
    await deps.db.transaction({ shopId, userId: null }, (tx) =>
      tx.query(
        `update jobs set status = 'succeeded', last_error = null, updated_at = now(),
           payload = payload || jsonb_build_object('result', $2::jsonb)
         where id = $1`,
        [jobId, JSON.stringify(result)],
      ),
    );
    await deps.dispatch?.().catch((error) => {
      deps.logger?.error('outbox_dispatch_failed', { error: String(error) });
    });
    return { status: 'done' };
  } catch (error) {
    const again = job.attempts < 10 && retryable(error);
    const delaySeconds = Math.min(600, 15 * 2 ** (job.attempts - 1));
    deps.logger?.error('job_failed', { jobId, kind: job.kind, error: String(error), again });
    await deps.db.transaction({ shopId, userId: null }, (tx) =>
      tx.query(
        `update jobs set status = $2, last_error = $3, updated_at = now(),
           run_after = now() + make_interval(secs => $4::integer)
         where id = $1`,
        [jobId, again ? 'pending' : 'failed', String(error).slice(0, 1000), delaySeconds],
      ),
    );
    return again ? { status: 'retry', delaySeconds } : { status: 'failed' };
  }
}

export interface OrderResult {
  reserved: number;
  shortage: number;
  unmapped: number;
  alreadyProcessed: number;
  released?: number;
  fulfilled?: number;
  fulfillmentsReversed?: number;
  returns?: string[];
  skipped?: string | null;
}

/**
 * Applies an order's state as the Shopify connector, in one transaction (core's
 * `shopify.orders.sync`): reservations per line by the connection's allocation rule with
 * shortages, edits, cancellation, fulfillments, and refunds (PRD 8.5). The rows it keeps make a
 * repeated webhook, job, reconciler run, or catch-up change nothing (A30). With several mapped
 * Shopify locations, the lines' locations are read first, so the right record of Shopify's
 * quantity is lowered.
 */
export async function processOrder(
  deps: SyncDeps,
  shopId: string,
  connectionId: string,
  order: ShopifyOrder,
): Promise<OrderResult> {
  const state = await deps.db.transaction({ shopId, userId: null, readOnly: true }, async (tx) => {
    const [connection] = await tx.query<{ status: string; installed_by_membership_id: string }>(
      'select status, installed_by_membership_id from shopify_connections where id = $1',
      [connectionId],
    );
    const [maps] = await tx.query<{ count: number }>(
      'select count(*)::int as count from shopify_location_maps where connection_id = $1',
      [connectionId],
    );
    return { connection, locationMaps: maps?.count ?? 0 };
  });
  if (state.connection?.status !== 'active') throw new NotConnectedError();
  const caller = shopifyConnectorCaller(
    shopId,
    connectionId,
    state.connection.installed_by_membership_id,
  );
  let withLocations = order;
  if (state.locationMaps > 1 && order.lines.some((l) => !l.locationId)) {
    const store = await connectedStore(deps, shopId, connectionId);
    const at = await store.admin.lineLocations(order.orderId);
    withLocations = {
      ...order,
      lines: order.lines.map((l) => ({
        ...l,
        locationId: l.locationId ?? at.get(l.lineId) ?? null,
      })),
    };
  }
  const synced = await execute(deps, ops.syncShopifyOrder, {
    caller,
    shopId,
    input: { connectionId, order: withLocations },
  });
  return synced.result as OrderResult;
}

/** Processes orders Shopify created since `since` that Airstock has not seen. */
export async function catchUpOrders(
  deps: SyncDeps,
  store: ConnectedStore,
  since: Date,
): Promise<number> {
  const orders = await store.admin.ordersSince(since.toISOString());
  let processed = 0;
  for (const order of [...orders].reverse()) {
    if (Date.parse(order.createdAt) < store.createdAt.getTime()) continue;
    const result = await processOrder(deps, store.shopId, store.connectionId, order);
    processed += result.reserved + result.shortage;
  }
  return processed;
}

// Mapping by SKU --------------------------------------------------------------------------

export interface SkuMatch {
  variants: Array<{ variantId: string; shopifyVariantId: string; shopifyInventoryItemId: string }>;
  unmatchedShopify: string[];
  untrackedShopify: string[];
}

/** Matches the store's variants to the shop's variants by normalized SKU (plan 8.2, step 2). */
export async function matchBySku(deps: SyncDeps, store: ConnectedStore): Promise<SkuMatch> {
  const shopify = await store.admin.variantsWithSku();
  const ours = await deps.db.transaction(
    { shopId: store.shopId, userId: null, readOnly: true },
    (tx) =>
      tx.query<{ id: string; sku_normalized: string }>(
        `select id, sku_normalized from variants where status = 'active'
         and sku_normalized = any($1::text[])`,
        [shopify.map((v) => normalizeSku(v.sku))],
      ),
  );
  const bySku = new Map(ours.map((v) => [v.sku_normalized, v.id]));
  const result: SkuMatch = { variants: [], unmatchedShopify: [], untrackedShopify: [] };
  const used = new Set<string>();
  for (const v of shopify) {
    const variantId = bySku.get(normalizeSku(v.sku));
    if (!variantId || used.has(variantId)) {
      result.unmatchedShopify.push(v.sku);
    } else if (!v.tracked) {
      result.untrackedShopify.push(v.sku);
    } else {
      used.add(variantId);
      result.variants.push({
        variantId,
        shopifyVariantId: v.variantId,
        shopifyInventoryItemId: v.inventoryItemId,
      });
    }
  }
  return result;
}
