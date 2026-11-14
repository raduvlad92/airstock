import { z } from 'zod';
import { errors } from '../errors.ts';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../permissions.ts';
import { defineOperation } from '../registry.ts';
import { Id, isTimeZone } from '../schemas.ts';

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
       insert into locations (shop_id, id, warehouse_id, name, path, path_ids)
       values ($1, $8, $7, 'Main stock', 'Main stock', array[$7, $8]::uuid[])`,
      [
        ctx.shopId,
        input.name,
        input.currency,
        input.timezone,
        ctx.caller.userId,
        membershipId,
        warehouseId,
        locationId,
      ],
    );
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
    shop: z.object({ id: Id, name: z.string(), currency: z.string(), timezone: z.string() }),
    role: z.string(),
    permissions: z.array(z.enum(PERMISSIONS)),
    allLocations: z.boolean(),
    locationScopeIds: z.array(Id),
    connectionScopes: z.union([z.literal('all'), z.array(z.string())]),
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
    }>('select id, name, currency, timezone from shops where id = $1', [ctx.shopId]);
    if (!shop || !ctx.membership) throw errors.notFound('Shop');
    return {
      result: {
        shop,
        role: ctx.membership.role,
        permissions: [...ROLE_PERMISSIONS[ctx.membership.role]],
        allLocations: ctx.membership.allLocations,
        locationScopeIds: ctx.membership.locationScopeIds,
        connectionScopes: ctx.caller.scopes === 'all' ? ('all' as const) : [...ctx.caller.scopes],
      },
      audit: { targetType: 'shop', targetId: ctx.shopId },
    };
  },
});
