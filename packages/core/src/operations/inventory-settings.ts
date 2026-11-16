import { z } from 'zod';
import { compare } from '../catalog/decimal.ts';
import { NonNegativeDecimal } from '../decimal.ts';
import { errors } from '../errors.ts';
import { defineOperation } from '../registry.ts';
import { Id } from '../schemas.ts';
import { canSeeCosts, requireCosts } from '../stock/engine.ts';

// Stock settings: allocation rules per channel (D3) and a variant's tracking, one-of-a-kind,
// sell-by margin, and default cost (D4, D5, D7).

const Channel = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe('"default", or a sales channel such as "shopify:<connection>".');

export const setAllocationRule = defineOperation({
  id: 'inventory.allocation_rules.set',
  summary: 'Set where a channel’s reservations take stock from',
  description:
    'Replaces the ordered list of warehouses or locations that reservations for a channel take stock from, first to last. Within each, lots that expire first and the oldest stock go first. An empty list lets every fulfillment-eligible location take part.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    channel: Channel,
    locationIds: z
      .array(Id)
      .max(100)
      .describe('Warehouse or location IDs in priority order; a warehouse covers its locations.'),
  }),
  output: z.object({
    channel: z.string(),
    version: z.number(),
    locationIds: z.array(Id),
  }),
  permission: 'storage.manage',
  connectionScope: 'storage:write',
  audit: { action: 'inventory.allocation_rule.set' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/allocation-rules' },
  mcp: {
    tool: 'manage_storage',
    action: 'set_allocation_rule',
    readOnly: false,
    destructive: false,
  },
  // A warehouse in the list counts as every location in it, so a member limited to some
  // locations cannot route stock from the rest.
  locations: async (input, tx) =>
    (
      await tx.query<{ id: string }>(
        `select id from locations where id = any($1::uuid[]) and kind = 'storage'
         union select id from locations where warehouse_id = any($1::uuid[])`,
        [input.locationIds],
      )
    ).map((r) => r.id),
  async handler(ctx, input) {
    if (new Set(input.locationIds).size !== input.locationIds.length) {
      throw errors.validation([{ path: 'locationIds', message: 'Each ID can appear once.' }]);
    }
    const known = await ctx.tx.query<{ id: string }>(
      `select id from warehouses where id = any($1::uuid[])
       union select id from locations where id = any($1::uuid[]) and kind = 'storage'`,
      [input.locationIds],
    );
    if (known.length !== input.locationIds.length) throw errors.notFound('Warehouse or location');
    const [rule] = await ctx.tx.query<{ id: string; version: number; before: string[] | null }>(
      `with before as (
         select array_agg(l.scope_id order by l.position) as ids
         from allocation_rules r join allocation_rule_locations l on l.shop_id = r.shop_id and l.rule_id = r.id
         where r.channel = $2)
       insert into allocation_rules (shop_id, id, channel) values (app_shop_id(), $1, $2)
       on conflict (shop_id, channel) do update set version = allocation_rules.version + 1,
         updated_at = now()
       returning id, version, (select ids from before) as before`,
      [ctx.newId(), input.channel],
    );
    if (!rule) throw errors.internal();
    await ctx.tx.query('delete from allocation_rule_locations where rule_id = $1', [rule.id]);
    await ctx.tx.query(
      `insert into allocation_rule_locations (shop_id, rule_id, position, scope_id)
       select app_shop_id(), $1, x.i - 1, x.id from unnest($2::uuid[]) with ordinality as x(id, i)`,
      [rule.id, input.locationIds],
    );
    return {
      result: { channel: input.channel, version: rule.version, locationIds: input.locationIds },
      audit: {
        targetType: 'allocation_rule',
        targetId: rule.id,
        locationIds: input.locationIds,
        changes: {
          channel: input.channel,
          locationIds: { from: rule.before ?? [], to: input.locationIds },
        },
      },
    };
  },
});

export const listAllocationRules = defineOperation({
  id: 'inventory.allocation_rules.list',
  summary: 'List allocation rules',
  description:
    'Shows, per channel, the ordered warehouses and locations its reservations take stock from. A channel without a rule uses every fulfillment-eligible location.',
  kind: 'read',
  scope: 'shop',
  input: z.object({}),
  output: z.object({
    rules: z.array(
      z.object({
        channel: z.string(),
        version: z.number(),
        locations: z.array(
          z.object({ id: Id, kind: z.enum(['warehouse', 'location']), name: z.string() }),
        ),
      }),
    ),
  }),
  permission: 'storage.read',
  connectionScope: 'storage:read',
  audit: { action: 'inventory.allocation_rules.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/allocation-rules' },
  mcp: {
    tool: 'manage_storage',
    action: 'list_allocation_rules',
    readOnly: true,
    destructive: false,
  },
  async handler(ctx) {
    const rules = await ctx.tx.query<{
      channel: string;
      version: number;
      locations: Array<{ id: string; kind: 'warehouse' | 'location'; name: string }>;
    }>(
      `select r.channel, r.version,
         coalesce((select json_agg(json_build_object('id', l.scope_id,
             'kind', case when w.id is not null then 'warehouse' else 'location' end,
             'name', coalesce(w.name, loc.path, '(removed)')) order by l.position)
           from allocation_rule_locations l
           left join warehouses w on w.shop_id = l.shop_id and w.id = l.scope_id
           left join locations loc on loc.shop_id = l.shop_id and loc.id = l.scope_id
           where l.shop_id = r.shop_id and l.rule_id = r.id), '[]'::json) as locations
       from allocation_rules r order by r.channel`,
    );
    return {
      result: { rules },
      audit: { targetType: 'shop', targetId: ctx.shopId, context: { count: rules.length } },
    };
  },
});

export const setStockSettings = defineOperation({
  id: 'catalog.variants.stock_settings.set',
  summary: 'Set a variant’s tracking, one-of-a-kind, sell-by margin, and default cost',
  description:
    'Use this to track a variant by lot, lot with expiry, or serial (only while it has no stock and no open reservations); to mark it one of a kind (at most one unit in stock, "sold" once fulfilled); to set a sell-by margin in days before lot expiry; or to set the default cost used for receipts without a cost (needs costs.read). Send only what changes.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    variantId: Id,
    expectedVersion: z.number().int().min(1).optional(),
    trackingMode: z.enum(['none', 'lot', 'lot_expiry', 'serial']).optional(),
    oneOfAKind: z.boolean().optional(),
    sellByMarginDays: z.number().int().min(0).max(3650).optional(),
    defaultCost: NonNegativeDecimal.nullable().optional().describe('Null clears it.'),
  }),
  output: z.object({
    variantId: Id,
    version: z.number(),
    trackingMode: z.string(),
    oneOfAKind: z.boolean(),
    sellByMarginDays: z.number(),
    costVisible: z.boolean(),
    defaultCost: z.string().nullable(),
  }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.variant.stock_settings_set' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/variants/{variantId}/stock-settings' },
  mcp: { tool: 'edit_catalog', action: 'set_stock_settings', readOnly: false, destructive: false },
  async handler(ctx, input) {
    if (input.defaultCost !== undefined) requireCosts(ctx);
    // FOR UPDATE conflicts with the key-share lock every stock command takes on the variant.
    const [v] = await ctx.tx.query<{
      version: number;
      tracking_mode: string;
      one_of_a_kind: boolean;
      sell_by_margin_days: number;
      is_bundle: boolean;
    }>(
      `select version, tracking_mode, one_of_a_kind, sell_by_margin_days,
         exists (select 1 from bundles b where b.shop_id = v.shop_id and b.variant_id = v.id and b.active) as is_bundle
       from variants v where id = $1 for update`,
      [input.variantId],
    );
    if (!v) throw errors.notFound('Variant');
    if (input.expectedVersion !== undefined && input.expectedVersion !== v.version) {
      throw errors.conflict('version_conflict', 'The variant changed since you read it.', {
        currentVersion: v.version,
      });
    }
    const tracking = input.trackingMode ?? v.tracking_mode;
    const oneOfAKind = input.oneOfAKind ?? v.one_of_a_kind;
    const [stock] = await ctx.tx.query<{ owned: string; open: number }>(
      `select coalesce((select sum(on_hand) from inventory_positions where variant_id = $1), 0)::text as owned,
         (select count(*)::int from reservations where variant_id = $1
           and status in ('active', 'partially_fulfilled')) as open`,
      [input.variantId],
    );
    if (tracking !== v.tracking_mode) {
      if (v.is_bundle) {
        throw errors.unprocessable('bundle_holds_no_stock', 'A bundle is not tracked itself.');
      }
      if (compare(stock?.owned ?? '0', '0') > 0 || (stock?.open ?? 0) > 0) {
        throw errors.conflict(
          'variant_has_stock',
          'Tracking can change only while the variant has no stock and no open reservations.',
          { owned: stock?.owned, openReservations: stock?.open },
        );
      }
    }
    if (oneOfAKind && tracking !== 'none') {
      throw errors.unprocessable(
        'one_of_a_kind_untracked',
        'A one-of-a-kind item is a single unit: it is not tracked by lot or serial. Use a serialized shared variant for units that share a price.',
      );
    }
    if (oneOfAKind && !v.one_of_a_kind && compare(stock?.owned ?? '0', '1') > 0) {
      throw errors.conflict('one_of_a_kind', 'The variant has more than one unit in stock.', {
        owned: stock?.owned,
      });
    }
    const [after] = await ctx.tx.query<{ version: number }>(
      `update variants set tracking_mode = $2, one_of_a_kind = $3, sell_by_margin_days = $4,
         version = version + 1, updated_at = now()
       where id = $1 returning version`,
      [input.variantId, tracking, oneOfAKind, input.sellByMarginDays ?? v.sell_by_margin_days],
    );
    let defaultCost: { from: string | null; to: string | null } | null = null;
    if (input.defaultCost !== undefined) {
      const [cost] = await ctx.tx.query<{ before: string | null; after: string | null }>(
        `with before as (select default_cost from variant_costs where variant_id = $1)
         insert into variant_costs (shop_id, variant_id, default_cost) values (app_shop_id(), $1, $2::numeric)
         on conflict (shop_id, variant_id) do update set default_cost = excluded.default_cost,
           version = variant_costs.version + 1, updated_at = now()
         returning (select default_cost::text from before) as before, default_cost::text as after`,
        [input.variantId, input.defaultCost],
      );
      defaultCost = { from: cost?.before ?? null, to: cost?.after ?? null };
    }
    const visible = canSeeCosts(ctx);
    const [current] = visible
      ? await ctx.tx.query<{ default_cost: string | null }>(
          'select default_cost::text from variant_costs where variant_id = $1',
          [input.variantId],
        )
      : [];
    const changes: Record<string, unknown> = {};
    if (tracking !== v.tracking_mode)
      changes.trackingMode = { from: v.tracking_mode, to: tracking };
    if (oneOfAKind !== v.one_of_a_kind)
      changes.oneOfAKind = { from: v.one_of_a_kind, to: oneOfAKind };
    if (input.sellByMarginDays !== undefined && input.sellByMarginDays !== v.sell_by_margin_days) {
      changes.sellByMarginDays = { from: v.sell_by_margin_days, to: input.sellByMarginDays };
    }
    if (defaultCost) {
      changes.restricted = { permission: 'costs.read', fields: { defaultCost } };
    }
    return {
      result: {
        variantId: input.variantId,
        version: after!.version,
        trackingMode: tracking,
        oneOfAKind,
        sellByMarginDays: input.sellByMarginDays ?? v.sell_by_margin_days,
        costVisible: visible,
        defaultCost: visible ? (current?.default_cost ?? null) : null,
      },
      audit: {
        targetType: 'variant',
        targetId: input.variantId,
        changes: { fields: changes },
        outcome: Object.keys(changes).length === 0 ? 'no_change' : 'succeeded',
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const inventorySettingsOperations = [
  setAllocationRule,
  listAllocationRules,
  setStockSettings,
] as const;
