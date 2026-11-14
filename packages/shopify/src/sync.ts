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
  uuidv7,
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
export const WEBHOOK_TOPICS = ['ORDERS_CREATE', 'APP_UNINSTALLED'];
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
  const job =
    input.topic === 'orders/create'
      ? { kind: ORDER_JOB, payload: { connectionId, order: parseOrderWebhook(input.body) } }
      : null;
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
      payload: { connectionId: string; order: ShopifyOrder };
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
    const result = await processOrder(deps, shopId, job.payload.connectionId, job.payload.order);
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
}

/**
 * Turns an order's lines into reservations as the Shopify connector (plan Section 8.2, step 4).
 * The idempotency key comes from the connection and the line, so a repeated webhook, job, or
 * catch-up reserves once. Each line also lowers Airstock's record of Shopify's quantity once,
 * because Shopify lowered its own quantity when it accepted the order.
 */
export async function processOrder(
  deps: SyncDeps,
  shopId: string,
  connectionId: string,
  order: ShopifyOrder,
): Promise<OrderResult> {
  const lineIds = order.lines.map((l) => l.lineId);
  const variantIds = order.lines.flatMap((l) => (l.variantId ? [l.variantId] : []));
  const state = await deps.db.transaction({ shopId, userId: null, readOnly: true }, async (tx) => {
    const [connection] = await tx.query<{ status: string; installed_by_membership_id: string }>(
      'select status, installed_by_membership_id from shopify_connections where id = $1',
      [connectionId],
    );
    const [locationMap] = await tx.query<{ shopify_location_id: string; location_id: string }>(
      'select shopify_location_id, location_id from shopify_location_maps where connection_id = $1 limit 1',
      [connectionId],
    );
    const variantMaps = await tx.query<{
      shopify_variant_id: string;
      shopify_inventory_item_id: string;
      variant_id: string;
    }>(
      `select shopify_variant_id, shopify_inventory_item_id, variant_id from shopify_variant_maps
       where connection_id = $1 and shopify_variant_id = any($2::text[])`,
      [connectionId, variantIds],
    );
    const done = await tx.query<{ shopify_line_id: string }>(
      `select shopify_line_id from shopify_order_lines
       where connection_id = $1 and shopify_line_id = any($2::text[])`,
      [connectionId, lineIds],
    );
    return { connection, locationMap, variantMaps, done };
  });
  if (state.connection?.status !== 'active') throw new NotConnectedError();
  const caller = shopifyConnectorCaller(
    shopId,
    connectionId,
    state.connection.installed_by_membership_id,
  );
  const maps = new Map(state.variantMaps.map((m) => [m.shopify_variant_id, m]));
  const done = new Set(state.done.map((d) => d.shopify_line_id));
  const result: OrderResult = { reserved: 0, shortage: 0, unmapped: 0, alreadyProcessed: 0 };

  for (const line of order.lines) {
    if (done.has(line.lineId)) {
      result.alreadyProcessed++;
      continue;
    }
    const map = line.variantId ? maps.get(line.variantId) : undefined;
    const location = state.locationMap;
    let outcome: 'reserved' | 'shortage' | 'unmapped' = 'unmapped';
    let reservationId: string | null = null;
    if (map && location && line.quantity > 0) {
      try {
        const reserved = await execute(deps, ops.reserveStock, {
          caller,
          shopId,
          idempotencyKey: `shopify:${connectionId}:line:${line.lineId}`,
          input: {
            variantId: map.variant_id,
            quantity: String(line.quantity),
            locationId: location.location_id,
            purpose: 'external_order',
            externalRef: `shopify:order/${order.orderId}/line/${line.lineId}`,
          },
        });
        outcome = 'reserved';
        reservationId = (reserved.result as { reservationId: string }).reservationId;
      } catch (error) {
        // Shopify already accepted the order. The shortage is recorded on the line and in the
        // failed reservation's audit event; shortage reservations (A29) arrive in Phase 3.
        if (!(error instanceof AppError) || error.code !== 'insufficient_stock') throw error;
        outcome = 'shortage';
      }
    }
    const [inserted] = await deps.db.transaction({ shopId, userId: null }, (tx) =>
      tx.query<{ inserted: boolean }>(
        `with line as (
           insert into shopify_order_lines (shop_id, connection_id, shopify_order_id, shopify_line_id,
             shopify_variant_id, quantity, outcome, reservation_id)
           values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7)
           on conflict do nothing
           returning 1),
         level as (
           update shopify_inventory_levels set expected_available = expected_available - $5,
             updated_at = now()
           where connection_id = $1 and shopify_inventory_item_id = $8 and shopify_location_id = $9
             and expected_available is not null and expected_as_of < $10::timestamptz
             and exists (select 1 from line))
         select exists (select 1 from line) as inserted`,
        [
          connectionId,
          order.orderId,
          line.lineId,
          line.variantId,
          line.quantity,
          outcome,
          reservationId,
          map?.shopify_inventory_item_id ?? null,
          outcome === 'unmapped' ? null : (location?.shopify_location_id ?? null),
          order.createdAt,
        ],
      ),
    );
    if (inserted?.inserted) result[outcome]++;
    else result.alreadyProcessed++;
  }
  return result;
}

// Availability push -----------------------------------------------------------------------

interface PushPair {
  connectionId: string;
  variantId: string;
  locationId: string;
  inventoryItemId: string;
  shopifyLocationId: string;
}

export type PushOutcome = 'pushed' | 'unchanged' | 'conflict' | 'not_stocked';

/** Payloads of `inventory.availability_changed` outbox events. */
export interface AvailabilityChanged {
  variantId?: string;
  locationIds?: string[];
  positionIds?: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Pushes Airstock's availability to every mapped Shopify level an outbox event touches
 * (plan Section 8.2, step 5). Shops without a Shopify connection cost one query.
 */
export async function pushAvailability(
  deps: SyncDeps,
  shopId: string,
  payload: AvailabilityChanged,
): Promise<Array<PushPair & { outcome: PushOutcome }>> {
  const variantId = payload.variantId && UUID.test(payload.variantId) ? payload.variantId : null;
  const locationIds = (payload.locationIds ?? []).filter((id) => UUID.test(id));
  const positionIds = (payload.positionIds ?? []).filter((id) => UUID.test(id));
  const pairs = await deps.db.transaction({ shopId, userId: null, readOnly: true }, (tx) =>
    tx.query<{
      connection_id: string;
      variant_id: string;
      location_id: string;
      shopify_inventory_item_id: string;
      shopify_location_id: string;
    }>(
      `with targets as (
         select $1::uuid as variant_id, l as location_id from unnest($2::uuid[]) l where $1::uuid is not null
         union
         select p.variant_id, p.location_id from inventory_positions p where p.id = any($3::uuid[]))
       select distinct vm.connection_id, vm.variant_id, lm.location_id, vm.shopify_inventory_item_id,
         lm.shopify_location_id
       from targets t
       join shopify_variant_maps vm on vm.variant_id = t.variant_id
       join shopify_location_maps lm on lm.shop_id = vm.shop_id and lm.connection_id = vm.connection_id
         and lm.location_id = t.location_id
       join shopify_connections c on c.shop_id = vm.shop_id and c.id = vm.connection_id
         and c.status = 'active'
       order by vm.connection_id, vm.variant_id`,
      [variantId, locationIds, positionIds],
    ),
  );
  const out: Array<PushPair & { outcome: PushOutcome }> = [];
  const stores = new Map<string, ConnectedStore>();
  for (const row of pairs) {
    let store = stores.get(row.connection_id);
    if (!store) {
      store = await connectedStore(deps, shopId, row.connection_id);
      stores.set(row.connection_id, store);
    }
    const pair: PushPair = {
      connectionId: row.connection_id,
      variantId: row.variant_id,
      locationId: row.location_id,
      inventoryItemId: row.shopify_inventory_item_id,
      shopifyLocationId: row.shopify_location_id,
    };
    out.push({ ...pair, outcome: await pushLevel(deps, store, pair) });
  }
  return out;
}

/** Airstock's sellable availability for a variant at one location, as Shopify's integer. */
async function availableAt(tx: Tx, variantId: string, locationId: string): Promise<number> {
  const [row] = await tx.query<{ available: string }>(
    `select coalesce(sum(case when l.status = 'active' and l.fulfillment_eligible
         then p.on_hand - p.allocated + coalesce(x.expired, 0) else 0 end), 0)::text as available
     from inventory_positions p
     join locations l on l.shop_id = p.shop_id and l.id = p.location_id
     left join lateral (
       select sum(a.quantity - a.released - a.fulfilled) as expired
       from reservation_allocations a
       join reservations r on r.shop_id = a.shop_id and r.id = a.reservation_id
       where a.shop_id = p.shop_id and a.position_id = p.id and a.released + a.fulfilled < a.quantity
         and r.status in ('active', 'partially_fulfilled') and r.expires_at <= now()) x on true
     where p.variant_id = $1 and p.location_id = $2 and p.condition = 'sellable'`,
    [variantId, locationId],
  );
  return Math.min(1_000_000_000, Math.max(0, Math.floor(Number(row?.available ?? '0'))));
}

const LEVEL_KEY = `connection_id = $1 and shopify_inventory_item_id = $2 and shopify_location_id = $3`;

function syncEvent(
  store: ConnectedStore,
  pair: PushPair,
  fields: Pick<AuditEvent, 'action' | 'outcome'> & Partial<AuditEvent>,
): AuditEvent {
  return auditEvent(
    {
      shopId: store.shopId,
      caller: store.caller,
      requestId: uuidv7(),
      attemptId: null,
      idempotencyKey: null,
    },
    {
      phase: 'outcome',
      target_type: 'variant',
      target_id: pair.variantId,
      location_ids: [pair.locationId],
      external_ref: `shopify:inventory_item/${pair.inventoryItemId}/location/${pair.shopifyLocationId}`,
      ...fields,
    },
  );
}

/**
 * Sets Shopify's available quantity for one item at one location with compare-and-set.
 *
 * Shopify lowers its own quantity when it accepts an order, so a refused write usually means an
 * order Airstock has not processed yet, not an edit. Before calling it a conflict, the push
 * processes any such orders and tries again; only a difference that remains unexplained is
 * recorded as a conflict, and Shopify is left untouched (plan P1).
 */
export async function pushLevel(
  deps: SyncDeps,
  store: ConnectedStore,
  pair: PushPair,
): Promise<PushOutcome> {
  const key = [pair.connectionId, pair.inventoryItemId, pair.shopifyLocationId];
  const { shopId } = store;
  // Recorded on the push event, so the P1 path is visible in the activity history.
  let refusedWrites = 0;
  let ordersCaughtUp = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    // The level row stays locked while Shopify is called, so pushes and order lines for the
    // same level apply one at a time.
    const step = await deps.db.transaction({ shopId, userId: null }, async (tx) => {
      await tx.query(
        `insert into shopify_inventory_levels (shop_id, connection_id, shopify_inventory_item_id,
           shopify_location_id) values (app_shop_id(), $1, $2, $3) on conflict do nothing`,
        key,
      );
      const [level] = await tx.query<{
        expected_available: number | null;
        expected_as_of: Date | null;
      }>(
        `select expected_available, expected_as_of from shopify_inventory_levels where ${LEVEL_KEY} for update`,
        key,
      );
      if (!level || level.expected_available === null) return { kind: 'init' as const };
      const from = level.expected_available;
      const target = await availableAt(tx, pair.variantId, pair.locationId);
      if (target === from) return { kind: 'unchanged' as const };
      const set = await store.admin.setAvailable({
        inventoryItemId: pair.inventoryItemId,
        locationId: pair.shopifyLocationId,
        quantity: target,
        from,
        idempotencyKey: uuidv7(),
        reference: `airstock://shops/${shopId}/shopify-connections/${pair.connectionId}`,
      });
      if (set.kind === 'stale') {
        return { kind: 'stale' as const, from, target, asOf: level.expected_as_of };
      }
      // now() is when this transaction began, before Shopify accepted the write: an order that
      // Shopify created after it is not in `target` and still lowers the record.
      await tx.query(
        `update shopify_inventory_levels set expected_available = $4, expected_as_of = now(),
           last_pushed_available = $4, last_pushed_at = now(), conflict_at = null,
           conflict_shopify_available = null, updated_at = now()
         where ${LEVEL_KEY}`,
        [...key, target],
      );
      await tx.query(INSERT_AUDIT_EVENTS_SQL, [
        JSON.stringify([
          syncEvent(store, pair, {
            action: 'shopify.inventory.pushed',
            outcome: 'succeeded',
            changes: {
              available: { from, to: target },
              ...(refusedWrites > 0 ? { refusedWrites, ordersCaughtUp } : {}),
            },
          }),
        ]),
      ]);
      return { kind: 'pushed' as const };
    });

    if (step.kind === 'pushed' || step.kind === 'unchanged') return step.kind;

    if (step.kind === 'init') {
      // First push for this level: process orders Shopify already counted, then read Shopify's
      // quantity as the starting point.
      ordersCaughtUp += await catchUpOrders(deps, store, store.createdAt);
      const readAt = new Date();
      const actual = await store.admin.getAvailable(pair.inventoryItemId, pair.shopifyLocationId);
      if (actual === null) {
        deps.logger?.error('shopify_item_not_stocked', { ...pair });
        return 'not_stocked';
      }
      await deps.db.transaction({ shopId, userId: null }, (tx) =>
        tx.query(
          `update shopify_inventory_levels set expected_available = $4, expected_as_of = $5,
             updated_at = now()
           where ${LEVEL_KEY} and expected_available is null`,
          [...key, actual, readAt.toISOString()],
        ),
      );
      continue;
    }

    // Stale: explain the difference with orders Airstock has not processed yet (plan P1).
    const since = new Date(
      Math.max(store.createdAt.getTime(), (step.asOf ? new Date(step.asOf).getTime() : 0) - 60_000),
    );
    refusedWrites++;
    const processed = await catchUpOrders(deps, store, since);
    ordersCaughtUp += processed;
    if (processed > 0) continue;
    const actual = await store.admin.getAvailable(pair.inventoryItemId, pair.shopifyLocationId);
    await recordConflict(deps, store, pair, { expected: step.from, airstock: step.target, actual });
    return 'conflict';
  }
  return 'conflict';
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

async function recordConflict(
  deps: SyncDeps,
  store: ConnectedStore,
  pair: PushPair,
  values: { expected: number; airstock: number; actual: number | null },
): Promise<void> {
  const key = [pair.connectionId, pair.inventoryItemId, pair.shopifyLocationId];
  await deps.db.transaction({ shopId: store.shopId, userId: null }, async (tx) => {
    const changed = await tx.query(
      `update shopify_inventory_levels set conflict_shopify_available = $4,
         conflict_at = now(), updated_at = now()
       where ${LEVEL_KEY} and (conflict_at is null or conflict_shopify_available is distinct from $4)
       returning 1`,
      [...key, values.actual],
    );
    // One event per new difference, not one per retry.
    if (changed.length === 0) return;
    await tx.query(INSERT_AUDIT_EVENTS_SQL, [
      JSON.stringify([
        syncEvent(store, pair, {
          action: 'shopify.inventory.conflict',
          outcome: 'conflict',
          changes: values,
          reason: 'Shopify’s quantity differs from Airstock’s record and no order explains it.',
        }),
      ]),
    ]);
  });
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
