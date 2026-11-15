import { z } from 'zod';
import { AppError, errors } from '../errors.ts';
import { defineOperation } from '../registry.ts';
import { Id, iso } from '../schemas.ts';

// Shopify slice (plan Section 8). These operations only touch PostgreSQL; calls to Shopify
// live in packages/shopify, which runs them through the same pipeline.

const SYNC_TOOL_LATER =
  'Temporary: Shopify sync is managed from the dashboard until the sync tool arrives in Phase 3.';

/** A Shopify resource ID, as a GID (gid://shopify/Location/123) or the bare number. */
const ShopifyId = z
  .string()
  .regex(/^(gid:\/\/shopify\/[A-Za-z]+\/)?[0-9]{1,20}$/, 'A Shopify ID or GID.');

export function shopifyNumericId(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

const ShopDomain = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, 'A myshopify.com domain.');

const ShopifyLocation = z.object({ id: z.string(), name: z.string(), active: z.boolean() });

const ConnectionSummary = z.object({
  connectionId: Id,
  shopDomain: z.string(),
  status: z.enum(['active', 'uninstalled']),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  uninstalledAt: z.string().nullable(),
  shopifyLocations: z.array(ShopifyLocation),
  webhooks: z.array(
    z.object({ topic: z.string(), status: z.string(), message: z.string().optional() }),
  ),
  locationMap: z.object({ shopifyLocationId: z.string(), locationId: Id }).nullable(),
  variantsMapped: z.number().int(),
  conflicts: z.number().int(),
  lastWebhookAt: z.string().nullable(),
});

export const listShopifyConnections = defineOperation({
  id: 'shopify.connections.list',
  summary: 'List connected Shopify stores',
  description:
    'Shows each connected Shopify store with its location and variant mappings, webhook status, and unexplained quantity differences.',
  kind: 'read',
  scope: 'shop',
  input: z.object({}),
  output: z.object({ connections: z.array(ConnectionSummary) }),
  permission: 'shop.read',
  connectionScope: 'shop:read',
  audit: { action: 'shopify.connections.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/shopify/connections' },
  mcp: { exception: SYNC_TOOL_LATER },
  async handler(ctx) {
    const rows = await ctx.tx.query<{
      id: string;
      shop_domain: string;
      status: 'active' | 'uninstalled';
      scopes: string[];
      created_at: Date;
      uninstalled_at: Date | null;
      shopify_locations: Array<{ id: string; name: string; active: boolean }>;
      webhooks: Array<{ topic: string; status: string; message?: string }>;
      location_map: { shopifyLocationId: string; locationId: string } | null;
      variants_mapped: number;
      conflicts: number;
      last_webhook_at: Date | null;
    }>(
      `select c.id, c.shop_domain, c.status, c.scopes, c.created_at, c.uninstalled_at,
         c.shopify_locations, c.webhooks,
         (select json_build_object('shopifyLocationId', m.shopify_location_id, 'locationId', m.location_id)
            from shopify_location_maps m where m.shop_id = c.shop_id and m.connection_id = c.id
            limit 1) as location_map,
         (select count(*)::int from shopify_variant_maps v
            where v.shop_id = c.shop_id and v.connection_id = c.id) as variants_mapped,
         (select count(*)::int from shopify_inventory_levels l
            where l.shop_id = c.shop_id and l.connection_id = c.id and l.conflict_at is not null) as conflicts,
         (select max(r.received_at) from webhook_receipts r
            where r.shop_id = c.shop_id and r.connection_id = c.id) as last_webhook_at
       from shopify_connections c
       order by c.created_at desc
       limit 50`,
    );
    return {
      result: {
        connections: rows.map((r) => ({
          connectionId: r.id,
          shopDomain: r.shop_domain,
          status: r.status,
          scopes: r.scopes,
          createdAt: iso(r.created_at) as string,
          uninstalledAt: iso(r.uninstalled_at),
          shopifyLocations: r.shopify_locations,
          webhooks: r.webhooks,
          locationMap: r.location_map,
          variantsMapped: r.variants_mapped,
          conflicts: r.conflicts,
          lastWebhookAt: iso(r.last_webhook_at),
        })),
      },
      audit: { targetType: 'shopify_connection', targetId: 'list' },
    };
  },
});

export const setShopifyMappings = defineOperation({
  id: 'shopify.mappings.set',
  summary: 'Map a Shopify store to a location and variants',
  description:
    'Replaces the mappings of one connected Shopify store: one Shopify location to one location, and the listed Shopify variants to variants. Airstock then sets Shopify’s available quantity at that location to Airstock’s availability, and keeps it in step.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    connectionId: Id,
    locationId: Id,
    shopifyLocationId: ShopifyId,
    variants: z
      .array(
        z.object({
          variantId: Id,
          shopifyVariantId: ShopifyId,
          shopifyInventoryItemId: ShopifyId,
        }),
      )
      .max(1000),
  }),
  output: z.object({
    connectionId: Id,
    locationId: Id,
    shopifyLocationId: z.string(),
    variantsMapped: z.number().int(),
  }),
  permission: 'connections.manage',
  connectionScope: 'session',
  audit: { action: 'shopify.mappings.set' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/shopify/connections/{connectionId}/mappings' },
  mcp: { exception: SYNC_TOOL_LATER },
  locations: (input) => [input.locationId],
  async handler(ctx, input) {
    const [connection] = await ctx.tx.query<{ status: string }>(
      'select status from shopify_connections where id = $1 for update',
      [input.connectionId],
    );
    if (!connection) throw errors.notFound('Shopify connection');
    if (connection.status !== 'active') {
      throw errors.conflict('shopify_not_connected', 'This Shopify store is not connected.');
    }
    const [location] = await ctx.tx.query<{ status: string; has_children: boolean }>(
      `select l.status, exists (select 1 from locations c where c.shop_id = l.shop_id and c.parent_id = l.id) as has_children
       from locations l where l.id = $1 for share`,
      [input.locationId],
    );
    if (!location) throw errors.notFound('Location');
    if (location.status !== 'active' || location.has_children) {
      throw errors.unprocessable(
        'location_not_stockable',
        'Map an active location without sub-locations.',
      );
    }
    const variants = input.variants.map((v) => ({
      variantId: v.variantId,
      shopifyVariantId: shopifyNumericId(v.shopifyVariantId),
      shopifyInventoryItemId: shopifyNumericId(v.shopifyInventoryItemId),
    }));
    const unique = (values: string[]) => new Set(values).size === values.length;
    if (
      !unique(variants.map((v) => v.variantId)) ||
      !unique(variants.map((v) => v.shopifyVariantId))
    ) {
      throw errors.validation([
        { path: 'variants', message: 'Each variant and Shopify variant may appear once.' },
      ]);
    }
    const [known] = await ctx.tx.query<{ count: number }>(
      'select count(*)::int as count from variants where id = any($1::uuid[])',
      [variants.map((v) => v.variantId)],
    );
    if ((known?.count ?? 0) !== variants.length) throw errors.notFound('Variant');

    const shopifyLocationId = shopifyNumericId(input.shopifyLocationId);
    // Two statements: every part of one statement sees the same snapshot, so an insert there
    // would still collide with the rows its own delete removes.
    await ctx.tx.query(
      `with del_loc as (
         delete from shopify_location_maps where connection_id = $1),
       del_var as (
         delete from shopify_variant_maps where connection_id = $1)
       -- Every level is read from Shopify again before the next push.
       update shopify_inventory_levels set expected_available = null, expected_as_of = null,
         conflict_at = null, conflict_shopify_available = null, updated_at = now()
       where connection_id = $1`,
      [input.connectionId],
    );
    await ctx.tx.query(
      `with loc as (
         insert into shopify_location_maps (shop_id, connection_id, shopify_location_id, location_id)
         values (app_shop_id(), $1, $2, $3))
       insert into shopify_variant_maps (shop_id, connection_id, shopify_variant_id,
         shopify_inventory_item_id, variant_id)
       select app_shop_id(), $1, x."shopifyVariantId", x."shopifyInventoryItemId", x."variantId"
       from jsonb_to_recordset($4::jsonb) as x("variantId" uuid, "shopifyVariantId" text,
         "shopifyInventoryItemId" text)`,
      [input.connectionId, shopifyLocationId, input.locationId, JSON.stringify(variants)],
    );
    return {
      result: {
        connectionId: input.connectionId,
        locationId: input.locationId,
        shopifyLocationId,
        variantsMapped: variants.length,
      },
      audit: {
        targetType: 'shopify_connection',
        targetId: input.connectionId,
        locationIds: [input.locationId],
        changes: { shopifyLocationId, locationId: input.locationId, variants },
      },
      // The first push sets Shopify to Airstock's availability at the mapped location.
      outbox: variants.map((v) => ({
        topic: 'inventory.availability_changed',
        payload: { variantId: v.variantId, locationIds: [input.locationId] },
      })),
    };
  },
});

// Integration callbacks ---------------------------------------------------------------------
//
// These run through the pipeline, so they are permission-checked, audited, and transactional
// like every operation. They are not in the registry: they are called by the Shopify install
// callback and by verified webhooks, never by an API client, so they have no REST route or
// MCP tool (plan Section 5.4).

export const connectShopifyStore = defineOperation({
  id: 'shopify.connections.connect',
  summary: 'Connect a Shopify store after the merchant approved the install',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    shopDomain: ShopDomain,
    scopes: z.array(z.string().max(100)).max(50),
    tokenKeyId: z.string().min(1).max(50),
    accessTokenCiphertext: z.string().min(1).max(4000),
    accessTokenExpiresAt: z.string().nullable(),
    refreshTokenCiphertext: z.string().max(4000).nullable(),
    refreshTokenExpiresAt: z.string().nullable(),
  }),
  output: z.object({ connectionId: Id, shopDomain: z.string(), reconnected: z.boolean() }),
  permission: 'connections.manage',
  connectionScope: 'session',
  audit: { action: 'shopify.connection.connected' },
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/shopify/connections' },
  mcp: { exception: 'Integration callback: runs only from the Shopify install flow.' },
  async handler(ctx, input) {
    if (!ctx.membership) throw errors.forbidden('A shop membership is required.');
    const [existing] = await ctx.tx.query<{ id: string }>(
      `select id from shopify_connections where shop_domain = $1 and status = 'active' for update`,
      [input.shopDomain],
    );
    const connectionId = existing?.id ?? ctx.newId();
    try {
      await ctx.tx.query(
        `insert into shopify_connections (shop_id, id, shop_domain, scopes, token_key_id,
           access_token_ciphertext, access_token_expires_at, refresh_token_ciphertext,
           refresh_token_expires_at, installed_by_membership_id)
         values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (shop_id, id) do update set
           scopes = excluded.scopes, token_key_id = excluded.token_key_id,
           access_token_ciphertext = excluded.access_token_ciphertext,
           access_token_expires_at = excluded.access_token_expires_at,
           refresh_token_ciphertext = excluded.refresh_token_ciphertext,
           refresh_token_expires_at = excluded.refresh_token_expires_at,
           updated_at = now(), version = shopify_connections.version + 1`,
        [
          connectionId,
          input.shopDomain,
          input.scopes,
          input.tokenKeyId,
          input.accessTokenCiphertext,
          input.accessTokenExpiresAt,
          input.refreshTokenCiphertext,
          input.refreshTokenExpiresAt,
          ctx.membership.id,
        ],
      );
    } catch (error) {
      if (
        (error as { constraint?: string }).constraint === 'shopify_connections_active_domain_idx'
      ) {
        throw new AppError(
          409,
          'shopify_store_in_use',
          'This Shopify store is already connected to another shop. Disconnect it there first.',
          'conflict',
        );
      }
      throw error;
    }
    return {
      result: { connectionId, shopDomain: input.shopDomain, reconnected: Boolean(existing) },
      audit: {
        targetType: 'shopify_connection',
        targetId: connectionId,
        changes: {
          shopDomain: input.shopDomain,
          scopes: input.scopes,
          reconnected: Boolean(existing),
        },
      },
    };
  },
});

/** Records install details learned after the token exchange (locations, webhook status). */
export const updateShopifyConnectionDetails = defineOperation({
  id: 'shopify.connections.details',
  summary: 'Record a connected store’s locations and webhook subscriptions',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    connectionId: Id,
    shopifyLocations: z.array(ShopifyLocation).max(200).optional(),
    webhooks: z
      .array(z.object({ topic: z.string(), status: z.string(), message: z.string().optional() }))
      .max(20)
      .optional(),
  }),
  output: z.object({ connectionId: Id }),
  permission: 'connections.manage',
  connectionScope: 'session',
  audit: { action: 'shopify.connection.updated' },
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/shopify/connections/{connectionId}/details' },
  mcp: { exception: 'Integration callback: runs only from the Shopify install flow.' },
  async handler(ctx, input) {
    const [row] = await ctx.tx.query<{ id: string }>(
      `update shopify_connections set
         shopify_locations = coalesce($2::jsonb, shopify_locations),
         webhooks = coalesce($3::jsonb, webhooks), updated_at = now()
       where id = $1 returning id`,
      [
        input.connectionId,
        input.shopifyLocations ? JSON.stringify(input.shopifyLocations) : null,
        input.webhooks ? JSON.stringify(input.webhooks) : null,
      ],
    );
    if (!row) throw errors.notFound('Shopify connection');
    return {
      result: { connectionId: input.connectionId },
      audit: {
        targetType: 'shopify_connection',
        targetId: input.connectionId,
        changes: { shopifyLocations: input.shopifyLocations, webhooks: input.webhooks },
      },
    };
  },
});

export const recordShopifyWebhook = defineOperation({
  id: 'shopify.webhooks.receive',
  summary: 'Record a verified Shopify webhook and queue its job',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    connectionId: Id,
    topic: z.string().min(1).max(100),
    eventId: z.string().min(1).max(200),
    webhookId: z.string().max(200).nullable(),
    triggeredAt: z.string().nullable(),
    job: z.object({ kind: z.string().min(1).max(100), payload: z.unknown() }).nullable(),
  }),
  output: z.object({
    receiptId: Id.nullable(),
    jobId: Id.nullable(),
    duplicate: z.boolean(),
  }),
  permission: 'integrations.sync',
  connectionScope: 'inventory:write',
  audit: { action: 'shopify.webhook.received' },
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/shopify/webhook-receipts' },
  mcp: { exception: 'Integration callback: runs only for a webhook whose HMAC verified.' },
  async handler(ctx, input) {
    const receiptId = ctx.newId();
    const jobId = input.job ? ctx.newId() : null;
    const [row] = await ctx.tx.query<{ inserted: boolean }>(
      `with receipt as (
         insert into webhook_receipts (shop_id, id, connection_id, topic, event_id, webhook_id,
           triggered_at, job_id)
         values (app_shop_id(), $1, $2, $3, $4, $5, $6::timestamptz, $7)
         on conflict (shop_id, connection_id, topic, event_id) do nothing
         returning id),
       job as (
         insert into jobs (shop_id, id, kind, payload)
         select app_shop_id(), $7, $8, $9::jsonb from receipt where $7::uuid is not null)
       select exists (select 1 from receipt) as inserted`,
      [
        receiptId,
        input.connectionId,
        input.topic,
        input.eventId,
        input.webhookId,
        input.triggeredAt,
        jobId,
        input.job?.kind ?? null,
        JSON.stringify(input.job?.payload ?? null),
      ],
    );
    const duplicate = !row?.inserted;
    return {
      result: {
        receiptId: duplicate ? null : receiptId,
        jobId: duplicate ? null : jobId,
        duplicate,
      },
      audit: {
        targetType: 'shopify_connection',
        targetId: input.connectionId,
        outcome: duplicate ? 'no_change' : 'succeeded',
        context: { topic: input.topic, eventId: input.eventId, webhookId: input.webhookId },
        changes: duplicate ? null : { receiptId, jobId },
      },
    };
  },
});

export const markShopifyUninstalled = defineOperation({
  id: 'shopify.connections.uninstalled',
  summary: 'Mark a Shopify store as uninstalled and forget its tokens',
  kind: 'command',
  scope: 'shop',
  input: z.object({ connectionId: Id }),
  output: z.object({ connectionId: Id, status: z.literal('uninstalled') }),
  permission: 'integrations.sync',
  connectionScope: 'inventory:write',
  audit: { action: 'shopify.connection.uninstalled' },
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/shopify/connections/{connectionId}/uninstalled' },
  mcp: { exception: 'Integration callback: runs only for a verified app/uninstalled webhook.' },
  async handler(ctx, input) {
    const changed = await ctx.tx.query<{ id: string }>(
      `update shopify_connections set status = 'uninstalled', uninstalled_at = now(),
         access_token_ciphertext = null, refresh_token_ciphertext = null,
         updated_at = now(), version = version + 1
       where id = $1 and status = 'active' returning id`,
      [input.connectionId],
    );
    return {
      result: { connectionId: input.connectionId, status: 'uninstalled' as const },
      audit: {
        targetType: 'shopify_connection',
        targetId: input.connectionId,
        outcome: changed.length > 0 ? 'succeeded' : 'no_change',
        changes: { status: 'uninstalled' },
      },
    };
  },
});
