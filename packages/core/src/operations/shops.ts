import { z } from 'zod';
import { errors } from '../errors.ts';
import { RATE_LIMITS } from '../limits.ts';
import { effectivePermissions, PERMISSIONS, ROLES } from '../permissions.ts';
import { defineOperation } from '../registry.ts';
import { Id, isTimeZone } from '../schemas.ts';
import { createSystemFields } from './catalog-schema.ts';

export const createShop = defineOperation({
  id: 'shops.create',
  summary: 'Create a shop',
  description:
    'Creates a shop owned by the signed-in user, with one default warehouse and location named Main stock (PRD 3.1).',
  kind: 'command',
  scope: 'account',
  input: z.object({
    name: z.string().trim().min(1).max(200),
    currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code such as EUR.'),
    timezone: z.string().min(1).max(64).refine(isTimeZone, 'Unknown IANA time zone.'),
  }),
  output: z.object({
    shopId: Id,
    membershipId: Id,
    defaultWarehouseId: Id,
    defaultLocationId: Id,
  }),
  permission: 'authenticated',
  connectionScope: 'session',
  audit: { action: 'shop.created' },
  // Idempotency records belong to a shop, which does not exist before this command.
  idempotency: 'none',
  http: { method: 'POST', path: '/shops', status: 201 },
  mcp: { exception: 'Account-level: an MCP connection is bound to one existing shop.' },
  async handler(ctx, input) {
    if (!ctx.caller.userId) throw errors.forbidden('Only a signed-in user can create a shop.');
    const membershipId = ctx.newId();
    const warehouseId = ctx.newId();
    const locationId = ctx.newId();
    await ctx.tx.query(
      `with shop as (
         insert into shops (id, name, currency, timezone, created_by) values ($1, $2, $3, $4, $5)),
       member as (
         insert into memberships (shop_id, id, user_id, role) values ($1, $6, $5, 'owner')),
       wh as (
         insert into warehouses (shop_id, id, name, ownership) values ($1, $7, 'Main stock', 'owned'))
       -- The default location, and the system location that holds stock in transit (D1).
       insert into locations (shop_id, id, warehouse_id, name, path, path_ids, fulfillment_eligible, kind)
       values ($1, $8, $7, 'Main stock', 'Main stock', array[$7, $8]::uuid[], true, 'storage'),
         ($1, $9, null, 'In transit', 'In transit', array[$9]::uuid[], false, 'in_transit')`,
      [
        ctx.shopId,
        input.name,
        input.currency,
        input.timezone,
        ctx.caller.userId,
        membershipId,
        warehouseId,
        locationId,
        ctx.newId(),
      ],
    );
    await createSystemFields(ctx);
    return {
      result: {
        shopId: ctx.shopId,
        membershipId,
        defaultWarehouseId: warehouseId,
        defaultLocationId: locationId,
      },
      audit: {
        targetType: 'shop',
        targetId: ctx.shopId,
        changes: { name: input.name, currency: input.currency, timezone: input.timezone },
      },
    };
  },
});

export const getShopContext = defineOperation({
  id: 'shops.context.get',
  summary: 'Get the current shop and your access',
  description:
    'Returns the shop, your role and permissions, any location limits, and the scopes this connection was granted.',
  kind: 'read',
  scope: 'shop',
  input: z.object({}),
  output: z.object({
    shop: z.object({
      id: Id,
      name: z.string(),
      currency: z.string(),
      timezone: z.string(),
      displayUnits: z.enum(['metric', 'imperial']),
    }),
    role: z.string(),
    permissions: z.array(z.enum(PERMISSIONS)),
    allLocations: z.boolean(),
    locationScopeIds: z.array(Id),
    connectionScopes: z.union([z.literal('all'), z.array(z.string())]),
    rateLimits: z
      .array(z.object({ kind: z.string(), label: z.string(), perSecond: z.number() }))
      .describe('Requests allowed per second; more are refused with 429 and Retry-After.'),
  }),
  permission: 'shop.read',
  connectionScope: 'shop:read',
  audit: { action: 'shop.context.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}' },
  mcp: { tool: 'get_shop_context', readOnly: true, destructive: false },
  async handler(ctx) {
    const [shop] = await ctx.tx.query<{
      id: string;
      name: string;
      currency: string;
      timezone: string;
      displayUnits: 'metric' | 'imperial';
    }>(
      'select id, name, currency, timezone, display_units as "displayUnits" from shops where id = $1',
      [ctx.shopId],
    );
    if (!shop || !ctx.membership) throw errors.notFound('Shop');
    return {
      result: {
        shop,
        role: ctx.membership.role,
        permissions: [...effectivePermissions(ctx.membership)],
        allLocations: ctx.membership.allLocations,
        locationScopeIds: ctx.membership.locationScopeIds,
        connectionScopes: ctx.caller.scopes === 'all' ? ('all' as const) : [...ctx.caller.scopes],
        rateLimits: Object.entries(RATE_LIMITS).map(([kind, l]) => ({
          kind,
          label: l.label,
          perSecond: l.perSecond,
        })),
      },
      audit: { targetType: 'shop', targetId: ctx.shopId },
    };
  },
});

export const listShops = defineOperation({
  id: 'shops.list',
  summary: 'List your shops',
  description: 'The shops where you are an active member, with your role in each.',
  kind: 'read',
  scope: 'account',
  input: z.object({}),
  output: z.object({
    shops: z.array(
      z.object({
        id: Id,
        name: z.string(),
        currency: z.string(),
        timezone: z.string(),
        role: z.enum(ROLES),
      }),
    ),
  }),
  permission: 'authenticated',
  connectionScope: 'session',
  audit: { action: 'shops.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops' },
  mcp: { exception: 'Account-level: an MCP connection is bound to one existing shop.' },
  async handler(ctx) {
    if (!ctx.caller.userId) throw errors.forbidden('Only a signed-in user can list shops.');
    const shops = await ctx.tx.query<{
      id: string;
      name: string;
      currency: string;
      timezone: string;
      role: (typeof ROLES)[number];
    }>(
      `select s.id, s.name, s.currency, s.timezone, m.role
       from memberships m join shops s on s.id = m.shop_id
       where m.user_id = $1 and m.status = 'active'
       order by s.name, s.id limit 200`,
      [ctx.caller.userId],
    );
    return { result: { shops }, audit: { targetType: 'shop', targetId: 'list' } };
  },
});

export const updateShopSettings = defineOperation({
  id: 'shops.settings.update',
  summary: 'Change the shop name, time zone, or display units',
  description:
    'Display units choose metric or imperial in the dashboard (PRD 3.1). Stored values keep the unit they were entered in. The currency cannot change once set.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().min(1).max(64).refine(isTimeZone, 'Unknown IANA time zone.').optional(),
    displayUnits: z.enum(['metric', 'imperial']).optional(),
  }),
  output: z.object({
    name: z.string(),
    timezone: z.string(),
    displayUnits: z.string(),
    version: z.number(),
  }),
  permission: 'shop.manage',
  connectionScope: 'session',
  audit: { action: 'shop.settings.updated' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/settings' },
  mcp: { exception: 'Shop settings are changed in the dashboard.' },
  async handler(ctx, input) {
    const [before] = await ctx.tx.query<{ name: string; timezone: string; display_units: string }>(
      'select name, timezone, display_units from shops where id = $1 for update',
      [ctx.shopId],
    );
    if (!before) throw errors.notFound('Shop');
    const [after] = await ctx.tx.query<{
      name: string;
      timezone: string;
      display_units: string;
      version: number;
    }>(
      `update shops set name = coalesce($2, name), timezone = coalesce($3, timezone),
         display_units = coalesce($4, display_units), version = version + 1
       where id = $1 returning name, timezone, display_units, version`,
      [ctx.shopId, input.name ?? null, input.timezone ?? null, input.displayUnits ?? null],
    );
    return {
      result: {
        name: after!.name,
        timezone: after!.timezone,
        displayUnits: after!.display_units,
        version: after!.version,
      },
      audit: {
        targetType: 'shop',
        targetId: ctx.shopId,
        changes: {
          fields: Object.fromEntries(
            (['name', 'timezone', 'display_units'] as const)
              .filter((k) => before[k] !== after![k])
              .map((k) => [k, { from: before[k], to: after![k] }]),
          ),
        },
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const shopsOperations = [createShop, listShops, getShopContext, updateShopSettings] as const;
