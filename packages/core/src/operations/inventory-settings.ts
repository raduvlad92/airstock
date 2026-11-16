import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { compare } from '../catalog/decimal.ts';
import { NonNegativeDecimal } from '../decimal.ts';
import { AppError, errors } from '../errors.ts';
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

/** The storage locations a rule's list covers: a warehouse counts as every location in it. */
async function ruleLocations(tx: Tx, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  return (
    await tx.query<{ id: string }>(
      `select id from locations where id = any($1::uuid[]) and kind = 'storage'
       union select id from locations where warehouse_id = any($1::uuid[])`,
      [ids],
    )
  ).map((r) => r.id);
}

/** The channel's current list, or null when it has no rule (every location takes part). */
async function currentRule(tx: Tx, channel: string): Promise<string[] | null> {
  const rows = await tx.query<{ scope_id: string | null }>(
    `select l.scope_id from allocation_rules r
     left join allocation_rule_locations l on l.shop_id = r.shop_id and l.rule_id = r.id
     where r.channel = $1 order by l.position`,
    [channel],
  );
  if (rows.length === 0) return null;
  return rows.map((r) => r.scope_id).filter((id): id is string => id !== null);
}

function outOfScope(message: string): AppError {
  return new AppError(403, 'location_out_of_scope', message, 'denied');
}

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
  // locations cannot route stock from the rest. The rule being replaced counts too: replacing
  // it re-routes the stock it named (ADR 0020, update).
  locations: async (input, tx) => [
    ...(await ruleLocations(tx, input.locationIds)),
    ...(await ruleLocations(tx, (await currentRule(tx, input.channel)) ?? [])),
  ],
  async handler(ctx, input) {
    if (new Set(input.locationIds).size !== input.locationIds.length) {
      throw errors.validation([{ path: 'locationIds', message: 'Each ID can appear once.' }]);
    }
    if (ctx.locationScope !== null) {
      // Under the rule's lock, so the list checked is the list replaced.
      await ctx.tx.query('select 1 from allocation_rules where channel = $1 for update', [
        input.channel,
      ]);
      const before = await currentRule(ctx.tx, input.channel);
      // An empty list, or no rule, means every fulfillment-eligible location.
      if (input.locationIds.length === 0 || before === null || before.length === 0) {
        throw outOfScope(
          'A rule that covers every location can be set or replaced only by a member with access to every location.',
        );
      }
      const [row] = await ctx.tx.query<{ ok: boolean }>(
        `select coalesce(bool_and(path_ids && $2::uuid[]), true) as ok
         from locations where id = any($1::uuid[])`,
        [await ruleLocations(ctx.tx, before), ctx.locationScope],
      );
      if (!row?.ok) {
        throw outOfScope('The current rule names locations outside your access.');
      }
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

export const getStockSettings = defineOperation({
  id: 'inventory.settings.get',
  summary: 'Show the shop’s stock settings and allocation rules',
  description:
    'Shows whether receipts fill open shortages, the default reservation expiry, and, per channel, the ordered warehouses and locations its reservations take stock from. A channel without a rule uses every fulfillment-eligible location.',
  kind: 'read',
  scope: 'shop',
  input: z.object({}),
  output: z.object({
    fillShortagesOnReceipt: z.boolean(),
    reservationExpiryMinutes: z.number().nullable().describe('Null: reservations never expire.'),
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
  audit: { action: 'inventory.settings.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/stock-settings' },
  mcp: { tool: 'manage_storage', action: 'get_stock_settings', readOnly: true, destructive: false },
  async handler(ctx) {
    const [shop] = await ctx.tx.query<{ fill: boolean; minutes: number | null }>(
      `select fill_shortages_on_receipt as fill, reservation_expiry_minutes as minutes
       from shops where id = app_shop_id()`,
    );
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
      result: {
        fillShortagesOnReceipt: shop?.fill ?? true,
        reservationExpiryMinutes: shop?.minutes ?? null,
        rules,
      },
      audit: { targetType: 'shop', targetId: ctx.shopId, context: { rules: rules.length } },
    };
  },
});

export const updateStockSettings = defineOperation({
  id: 'inventory.settings.update',
  summary: 'Change how receipts and reservations behave in this shop',
  description:
    'Whether a receipt fills open shortages, oldest first (D6), and the expiry applied to reservations that do not set one (null: never). Connector reservations, such as Shopify orders, never expire.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    fillShortagesOnReceipt: z.boolean().optional(),
    reservationExpiryMinutes: z.number().int().min(1).max(129_600).nullable().optional(),
  }),
  output: z.object({
    fillShortagesOnReceipt: z.boolean(),
    reservationExpiryMinutes: z.number().nullable(),
  }),
  permission: 'shop.manage',
  connectionScope: 'session',
  audit: { action: 'inventory.settings.updated' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/stock-settings' },
  mcp: { exception: 'Shop settings are changed in the dashboard.' },
  async handler(ctx, input) {
    const [before] = await ctx.tx.query<{ fill: boolean; minutes: number | null }>(
      `select fill_shortages_on_receipt as fill, reservation_expiry_minutes as minutes
       from shops where id = app_shop_id() for update`,
    );
    if (!before) throw errors.notFound('Shop');
    const fill = input.fillShortagesOnReceipt ?? before.fill;
    const minutes =
      input.reservationExpiryMinutes === undefined
        ? before.minutes
        : input.reservationExpiryMinutes;
    await ctx.tx.query(
      `update shops set fill_shortages_on_receipt = $1, reservation_expiry_minutes = $2,
         version = version + 1
       where id = app_shop_id()`,
      [fill, minutes],
    );
    const changes: Record<string, unknown> = {};
    if (fill !== before.fill) changes.fillShortagesOnReceipt = { from: before.fill, to: fill };
    if (minutes !== before.minutes)
      changes.reservationExpiryMinutes = { from: before.minutes, to: minutes };
    return {
      result: { fillShortagesOnReceipt: fill, reservationExpiryMinutes: minutes },
      audit: {
        targetType: 'shop',
        targetId: ctx.shopId,
        changes: { fields: changes },
        outcome: Object.keys(changes).length === 0 ? 'no_change' : 'succeeded',
      },
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
  getStockSettings,
  updateStockSettings,
  setStockSettings,
] as const;
