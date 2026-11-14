import { z } from 'zod';
import { AppError, errors } from '../errors.ts';
import { defineOperation } from '../registry.ts';
import { Id } from '../schemas.ts';

export const createWarehouse = defineOperation({
  id: 'storage.warehouses.create',
  summary: 'Create a warehouse or storage site',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    name: z.string().trim().min(1).max(200),
    ownership: z.enum(['owned', 'rented', 'third_party']).default('owned'),
    operatorName: z.string().trim().max(200).optional(),
  }),
  output: z.object({ warehouseId: Id }),
  permission: 'storage.manage',
  connectionScope: 'storage:write',
  audit: { action: 'storage.warehouse.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/warehouses', status: 201 },
  mcp: {
    tool: 'manage_locations',
    action: 'create_warehouse',
    readOnly: false,
    destructive: false,
  },
  async handler(ctx, input) {
    if (ctx.locationScope !== null) {
      throw new AppError(
        403,
        'location_out_of_scope',
        'Members limited to specific locations cannot create warehouses.',
        'denied',
      );
    }
    const warehouseId = ctx.newId();
    await ctx.tx.query(
      `insert into warehouses (shop_id, id, name, ownership, operator_name)
       values (app_shop_id(), $1, $2, $3, $4)`,
      [warehouseId, input.name, input.ownership, input.operatorName ?? null],
    );
    return {
      result: { warehouseId },
      audit: { targetType: 'warehouse', targetId: warehouseId, changes: input },
    };
  },
});

export const createLocation = defineOperation({
  id: 'storage.locations.create',
  summary: 'Create a storage location',
  description:
    'Creates a location in a warehouse, optionally under a parent location. Stock is held only at locations without children, so a parent that holds stock cannot gain children.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    warehouseId: Id,
    parentId: Id.optional(),
    name: z.string().trim().min(1).max(200),
    code: z.string().trim().min(1).max(50).optional(),
    fulfillmentEligible: z.boolean().default(true),
  }),
  output: z.object({ locationId: Id, path: z.string() }),
  permission: 'storage.manage',
  connectionScope: 'storage:write',
  audit: { action: 'storage.location.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/locations', status: 201 },
  mcp: { tool: 'manage_locations', action: 'create_location', readOnly: false, destructive: false },
  locations: (input) => (input.parentId ? [input.parentId] : []),
  async handler(ctx, input) {
    const [warehouse] = await ctx.tx.query<{ name: string; status: string }>(
      'select name, status from warehouses where id = $1',
      [input.warehouseId],
    );
    if (!warehouse) throw errors.notFound('Warehouse');
    if (warehouse.status !== 'active')
      throw errors.conflict('warehouse_archived', 'The warehouse is archived.');
    if (
      !input.parentId &&
      ctx.locationScope !== null &&
      !ctx.locationScope.includes(input.warehouseId)
    ) {
      throw new AppError(
        403,
        'location_out_of_scope',
        'You do not have access to this warehouse.',
        'denied',
      );
    }
    const id = ctx.newId();
    const label = input.code ?? input.name;
    let path = `${warehouse.name}/${label}`;
    let pathIds = [input.warehouseId, id];
    if (input.parentId) {
      const [parent] = await ctx.tx.query<{
        warehouse_id: string;
        path: string;
        path_ids: string[];
        holds_stock: boolean;
      }>(
        `select l.warehouse_id, l.path, l.path_ids,
           exists (select 1 from inventory_positions p
             where p.shop_id = l.shop_id and p.location_id = l.id
               and (p.on_hand > 0 or p.allocated > 0)) as holds_stock
         from locations l where l.id = $1 for update`,
        [input.parentId],
      );
      if (!parent) throw errors.notFound('Parent location');
      if (parent.warehouse_id !== input.warehouseId) {
        throw errors.unprocessable(
          'parent_in_other_warehouse',
          'The parent location is in another warehouse.',
        );
      }
      if (parent.holds_stock) {
        throw errors.conflict(
          'location_holds_stock',
          'Move the stock out of this location before adding locations inside it.',
        );
      }
      path = `${parent.path}/${label}`;
      pathIds = [...parent.path_ids, id];
    }
    await ctx.tx.query(
      `insert into locations (shop_id, id, warehouse_id, parent_id, name, code, path, path_ids, fulfillment_eligible)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7::uuid[], $8)`,
      [
        id,
        input.warehouseId,
        input.parentId ?? null,
        input.name,
        input.code ?? null,
        path,
        pathIds,
        input.fulfillmentEligible,
      ],
    );
    return {
      result: { locationId: id, path },
      audit: { targetType: 'location', targetId: id, changes: input, locationIds: [id] },
    };
  },
});

export const listLocations = defineOperation({
  id: 'storage.locations.list',
  summary: 'List warehouses and their locations',
  kind: 'read',
  scope: 'shop',
  input: z.object({ warehouseId: Id.optional() }),
  output: z.object({
    partial: z.boolean().describe('True when your access is limited to some locations.'),
    locations: z.array(
      z.object({
        locationId: Id,
        warehouseId: Id,
        warehouseName: z.string(),
        ownership: z.string(),
        parentId: Id.nullable(),
        name: z.string(),
        code: z.string().nullable(),
        path: z.string(),
        holdsStockAllowed: z.boolean().describe('True for locations without children.'),
        fulfillmentEligible: z.boolean(),
        status: z.string(),
      }),
    ),
  }),
  permission: 'storage.read',
  connectionScope: 'storage:read',
  audit: { action: 'storage.locations.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/locations' },
  mcp: { tool: 'manage_locations', action: 'list', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const rows = await ctx.tx.query<{
      id: string;
      warehouse_id: string;
      warehouse_name: string;
      ownership: string;
      parent_id: string | null;
      name: string;
      code: string | null;
      path: string;
      is_leaf: boolean;
      fulfillment_eligible: boolean;
      status: string;
    }>(
      `select l.id, l.warehouse_id, w.name as warehouse_name, w.ownership, l.parent_id, l.name,
         l.code, l.path, l.fulfillment_eligible, l.status,
         not exists (select 1 from locations c where c.shop_id = l.shop_id and c.parent_id = l.id) as is_leaf
       from locations l
       join warehouses w on w.shop_id = l.shop_id and w.id = l.warehouse_id
       where ($1::uuid is null or l.warehouse_id = $1)
         and ($2::uuid[] is null or l.path_ids && $2::uuid[])
       order by l.path
       limit 1000`,
      [input.warehouseId ?? null, ctx.locationScope],
    );
    return {
      result: {
        partial: ctx.locationScope !== null,
        locations: rows.map((r) => ({
          locationId: r.id,
          warehouseId: r.warehouse_id,
          warehouseName: r.warehouse_name,
          ownership: r.ownership,
          parentId: r.parent_id,
          name: r.name,
          code: r.code,
          path: r.path,
          holdsStockAllowed: r.is_leaf,
          fulfillmentEligible: r.fulfillment_eligible,
          status: r.status,
        })),
      },
      audit: {
        targetType: 'location',
        targetId: 'list',
        locationIds: rows.map((r) => r.id).slice(0, 100),
      },
    };
  },
});
