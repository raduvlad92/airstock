import { z } from 'zod';
import { applyAlertChanges, type RuleState, reorderRuleStates } from '../alerts/check.ts';
import { compare, normalize, subtract } from '../catalog/decimal.ts';
import { NonNegativeDecimal, PositiveDecimal } from '../decimal.ts';
import { errors } from '../errors.ts';
import { destinationInScope, destinationLocationIds } from '../purchasing/orders.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id } from '../schemas.ts';
import { canSeeCosts, exactProduct, loadStockVariant } from '../stock/engine.ts';

// Reorder rules and drafting purchase orders from low stock (plan Section 5.9, D12, PRD 6.8 and
// 6.9). A rule per variant and warehouse (optionally per location) has a reorder point and either
// a reorder quantity or a maximum level, and an optional preferred supplier.

const TOOL = 'manage_purchasing';

const RuleOut = z.object({
  id: Id,
  variantId: Id,
  sku: z.string(),
  productName: z.string(),
  warehouseId: Id,
  warehouseName: z.string(),
  locationId: Id.nullable(),
  locationPath: z.string().nullable(),
  reorderPoint: z.string(),
  reorderQuantity: z.string().nullable(),
  maximumLevel: z.string().nullable(),
  preferredSupplierId: Id.nullable(),
  preferredSupplierName: z.string().nullable(),
  available: z.string().describe('Sellable and unreserved in the rule’s warehouse or location.'),
  onOrder: z.string().describe('Still expected on sent purchase orders there.'),
  low: z.boolean().describe('Available plus on order is at or below the reorder point.'),
  alertId: Id.nullable().describe('The open low-stock alert, if any.'),
  version: z.number(),
});
type RuleView = z.infer<typeof RuleOut>;

/** Whether the caller's scope covers a rule: its warehouse, or its location's path. */
function ruleInScope(scope: string[] | null, s: Pick<RuleState, 'scopeIds'>): boolean {
  return scope === null || s.scopeIds.some((id) => scope.includes(id));
}

async function ruleViews(ctx: HandlerContext, states: RuleState[]): Promise<RuleView[]> {
  if (states.length === 0) return [];
  const meta = await ctx.tx.query<{ id: string; version: number; supplier_name: string | null }>(
    `select r.id, r.version, s.name as supplier_name from reorder_rules r
     left join suppliers s on s.shop_id = r.shop_id and s.id = r.preferred_supplier_id
     where r.id = any($1::uuid[])`,
    [states.map((s) => s.ruleId)],
  );
  const byId = new Map(meta.map((m) => [m.id, m]));
  return states.map((s) => ({
    id: s.ruleId,
    variantId: s.variantId,
    sku: s.sku,
    productName: s.productName,
    warehouseId: s.warehouseId,
    warehouseName: s.warehouseName,
    locationId: s.locationId,
    locationPath: s.locationPath,
    reorderPoint: normalize(s.reorderPoint),
    reorderQuantity: s.reorderQuantity === null ? null : normalize(s.reorderQuantity),
    maximumLevel: s.maximumLevel === null ? null : normalize(s.maximumLevel),
    preferredSupplierId: s.preferredSupplierId,
    preferredSupplierName: byId.get(s.ruleId)?.supplier_name ?? null,
    available: normalize(s.available),
    onOrder: normalize(s.onOrder),
    low: s.low,
    alertId: s.alertId,
    version: byId.get(s.ruleId)?.version ?? 1,
  }));
}

export const listReorderRules = defineOperation({
  id: 'purchasing.reorder_rules.list',
  summary: 'List reorder rules',
  description:
    'Use this to see reorder rules and which variants are low: each rule with its reorder point, reorder quantity or maximum level, preferred supplier, and what is available and on order now. lowOnly lists only rules at or below their point. Not for changing a rule (use set_rule).',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    variantId: Id.optional().describe('Only this variant’s rules.'),
    warehouseId: Id.optional().describe('Only rules for this warehouse.'),
    lowOnly: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .optional()
      .describe('Only rules whose stock is at or below the reorder point.'),
  }),
  output: z.object({ rules: z.array(RuleOut) }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'purchasing.reorder_rules.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/reorder-rules' },
  mcp: { tool: TOOL, action: 'list_rules', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const lowOnly = input.lowOnly === true || input.lowOnly === 'true';
    const states = (await reorderRuleStates(ctx.tx, input.variantId ? [input.variantId] : null))
      .filter((s) => !input.warehouseId || s.warehouseId === input.warehouseId)
      .filter((s) => !lowOnly || s.low)
      .filter((s) => ruleInScope(ctx.locationScope, s))
      .slice(0, 1000);
    return {
      result: { rules: await ruleViews(ctx, states) },
      audit: {
        targetType: 'reorder_rule',
        targetId: input.variantId ?? 'list',
        context: { input },
      },
    };
  },
});

interface RuleRow {
  id: string;
  variant_id: string;
  warehouse_id: string;
  location_id: string | null;
  reorder_point: string;
  reorder_quantity: string | null;
  maximum_level: string | null;
  preferred_supplier_id: string | null;
  version: number;
  status: string;
}

export const setReorderRule = defineOperation({
  id: 'purchasing.reorder_rules.set',
  summary: 'Add or change a reorder rule',
  description:
    'Use this to set when a variant should be reordered. Without ruleId, adds a rule for a variant at a warehouse (or one location in it); with ruleId and expectedVersion, changes it. Give a reorderPoint and either reorderQuantity (order this much) or maximumLevel (order up to this level); preferredSupplierId picks who drafts from low stock go to. A low-stock alert opens when available plus on order falls to or below the point.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    ruleId: Id.optional().describe('An existing rule, to change it.'),
    variantId: Id.optional(),
    warehouseId: Id.optional(),
    locationId: Id.optional().describe(
      'A rule for one location inside the warehouse; omitted means the whole warehouse.',
    ),
    reorderPoint: NonNegativeDecimal.optional().describe(
      'Alert and reorder when available plus on order is at or below this, in base units.',
    ),
    reorderQuantity: PositiveDecimal.nullable()
      .optional()
      .describe('Base units to order each time (instead of maximumLevel).'),
    maximumLevel: PositiveDecimal.nullable()
      .optional()
      .describe('Order up to this many base units (instead of reorderQuantity).'),
    preferredSupplierId: Id.nullable().optional(),
    expectedVersion: z.number().int().min(1).optional().describe('The rule version you read.'),
  }),
  output: z.object({ rule: RuleOut }),
  permission: 'purchasing.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'purchasing.reorder_rule.saved' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/reorder-rules' },
  mcp: { tool: TOOL, action: 'set_rule', readOnly: false, destructive: false },
  async handler(ctx, input) {
    let before: RuleRow | null = null;
    if (input.ruleId) {
      const [row] = await ctx.tx.query<RuleRow>(
        `select id, variant_id, warehouse_id, location_id, reorder_point::text,
           reorder_quantity::text, maximum_level::text, preferred_supplier_id, version, status
         from reorder_rules where id = $1 for update`,
        [input.ruleId],
      );
      if (!row || row.status !== 'active') throw errors.notFound('Reorder rule');
      before = row;
      if (input.expectedVersion === undefined) {
        throw errors.validation([
          { path: 'expectedVersion', message: 'Give the rule version you read.' },
        ]);
      }
      if (row.version !== input.expectedVersion) {
        throw errors.conflict('version_conflict', 'The rule changed since you read it.', {
          currentVersion: row.version,
        });
      }
      if (
        (input.variantId && input.variantId !== row.variant_id) ||
        (input.warehouseId && input.warehouseId !== row.warehouse_id) ||
        (input.locationId && input.locationId !== row.location_id)
      ) {
        throw errors.validation([
          { path: 'ruleId', message: 'Remove the rule and add a new one to move it.' },
        ]);
      }
    } else if (!input.variantId || !input.warehouseId || input.reorderPoint === undefined) {
      throw errors.validation([
        {
          path: 'variantId',
          message: 'A new rule needs a variantId, a warehouseId, and a reorderPoint.',
        },
      ]);
    }
    const variantId = before?.variant_id ?? input.variantId!;
    const warehouseId = before?.warehouse_id ?? input.warehouseId!;
    const locationId = before ? before.location_id : (input.locationId ?? null);
    const variant = await loadStockVariant(ctx.tx, variantId);
    if (variant.bundleId) {
      throw errors.unprocessable(
        'bundle_holds_no_stock',
        'A bundle holds no stock of its own: set reorder rules on its components.',
      );
    }
    if (!before) {
      const [warehouse] = await ctx.tx.query('select 1 from warehouses where id = $1', [
        warehouseId,
      ]);
      if (!warehouse) throw errors.notFound('Warehouse');
      if (locationId) {
        const [loc] = await ctx.tx.query<{ warehouse_id: string | null }>(
          `select warehouse_id from locations where id = $1 and kind = 'storage'`,
          [locationId],
        );
        if (!loc) throw errors.notFound('Location');
        if (loc.warehouse_id !== warehouseId) {
          throw errors.unprocessable(
            'location_not_in_warehouse',
            'The location must be inside the warehouse.',
          );
        }
      }
    }
    if (!(await destinationInScope(ctx.tx, ctx.locationScope, warehouseId, locationId))) {
      throw errors.forbidden('This rule’s warehouse or location is outside your locations.');
    }
    const preferredSupplierId =
      input.preferredSupplierId === undefined
        ? (before?.preferred_supplier_id ?? null)
        : input.preferredSupplierId;
    if (preferredSupplierId && preferredSupplierId !== before?.preferred_supplier_id) {
      const [supplier] = await ctx.tx.query<{ status: string }>(
        'select status from suppliers where id = $1',
        [preferredSupplierId],
      );
      if (!supplier) throw errors.notFound('Supplier');
      if (supplier.status !== 'active')
        throw errors.conflict('supplier_archived', 'The supplier is archived.');
    }
    const reorderPoint = normalize(input.reorderPoint ?? before!.reorder_point);
    // Giving one of quantity or maximum clears the other.
    let reorderQuantity =
      input.reorderQuantity === undefined
        ? (before?.reorder_quantity ?? null)
        : input.reorderQuantity;
    let maximumLevel =
      input.maximumLevel === undefined ? (before?.maximum_level ?? null) : input.maximumLevel;
    if (input.reorderQuantity && input.maximumLevel === undefined) maximumLevel = null;
    if (input.maximumLevel && input.reorderQuantity === undefined) reorderQuantity = null;
    if ((reorderQuantity === null) === (maximumLevel === null)) {
      throw errors.validation([
        {
          path: 'reorderQuantity',
          message: 'Give either a reorder quantity or a maximum level, not both.',
        },
      ]);
    }
    if (maximumLevel !== null && compare(maximumLevel, reorderPoint) <= 0) {
      throw errors.validation([
        { path: 'maximumLevel', message: 'The maximum level must be above the reorder point.' },
      ]);
    }
    const id = before?.id ?? ctx.newId();
    if (before) {
      await ctx.tx.query(
        `update reorder_rules set reorder_point = $2, reorder_quantity = $3, maximum_level = $4,
           preferred_supplier_id = $5, version = version + 1, updated_at = now()
         where id = $1`,
        [id, reorderPoint, reorderQuantity, maximumLevel, preferredSupplierId],
      );
    } else {
      const [taken] = await ctx.tx.query<{ id: string }>(
        `select id from reorder_rules where status = 'active' and variant_id = $1
           and warehouse_id = $2 and location_id is not distinct from $3`,
        [variantId, warehouseId, locationId],
      );
      if (taken) {
        throw errors.conflict(
          'reorder_rule_exists',
          'This variant already has a rule there. Change that rule instead.',
          { ruleId: taken.id },
        );
      }
      await ctx.tx.query(
        `insert into reorder_rules (shop_id, id, variant_id, warehouse_id, location_id,
           reorder_point, reorder_quantity, maximum_level, preferred_supplier_id)
         values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          variantId,
          warehouseId,
          locationId,
          reorderPoint,
          reorderQuantity,
          maximumLevel,
          preferredSupplierId,
        ],
      );
    }
    const after = { reorderPoint, reorderQuantity, maximumLevel, preferredSupplierId };
    const [state] = await reorderRuleStates(ctx.tx, null, [id]);
    const [rule] = await ruleViews(ctx, state ? [state] : []);
    return {
      result: { rule: rule! },
      audit: {
        targetType: 'reorder_rule',
        targetId: id,
        locationIds: locationId ? [locationId] : [],
        changes: before
          ? {
              from: {
                reorderPoint: normalize(before.reorder_point),
                reorderQuantity: before.reorder_quantity && normalize(before.reorder_quantity),
                maximumLevel: before.maximum_level && normalize(before.maximum_level),
                preferredSupplierId: before.preferred_supplier_id,
              },
              to: after,
            }
          : { created: { variantId, warehouseId, locationId, ...after } },
      },
      // A new or changed point may make the variant low, or no longer low, right away.
      alertCheck: { variantIds: [variantId] },
    };
  },
});

export const removeReorderRule = defineOperation({
  id: 'purchasing.reorder_rules.remove',
  summary: 'Remove a reorder rule',
  description:
    'Use this when a variant should no longer be reordered at a warehouse or location. Its open low-stock alert resolves. History keeps the rule.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    ruleId: Id.describe('The rule to remove.'),
    expectedVersion: z.number().int().min(1).optional().describe('The rule version you read.'),
  }),
  output: z.object({ ruleId: Id, removed: z.boolean() }),
  permission: 'purchasing.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'purchasing.reorder_rule.removed' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/reorder-rules/{ruleId}/remove' },
  mcp: { tool: TOOL, action: 'remove_rule', readOnly: false, destructive: true },
  async handler(ctx, input) {
    const [rule] = await ctx.tx.query<{
      id: string;
      warehouse_id: string;
      location_id: string | null;
      version: number;
      status: string;
    }>(
      `select id, warehouse_id, location_id, version, status from reorder_rules
       where id = $1 for update`,
      [input.ruleId],
    );
    if (!rule) throw errors.notFound('Reorder rule');
    if (
      !(await destinationInScope(ctx.tx, ctx.locationScope, rule.warehouse_id, rule.location_id))
    ) {
      throw errors.forbidden('This rule’s warehouse or location is outside your locations.');
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== rule.version) {
      throw errors.conflict('version_conflict', 'The rule changed since you read it.', {
        currentVersion: rule.version,
      });
    }
    if (rule.status !== 'active') {
      return {
        result: { ruleId: rule.id, removed: false },
        audit: { targetType: 'reorder_rule', targetId: rule.id, outcome: 'no_change' },
      };
    }
    await ctx.tx.query(
      `update reorder_rules set status = 'archived', version = version + 1, updated_at = now()
       where id = $1`,
      [rule.id],
    );
    const open = await ctx.tx.query<{ id: string }>(
      `select id from alerts where dedupe_key = $1 and status <> 'resolved' for update`,
      [`low_stock:${rule.id}`],
    );
    const locationIds = await destinationLocationIds(ctx.tx, rule.warehouse_id, rule.location_id);
    const effects = await applyAlertChanges(
      ctx.tx,
      ctx.event,
      [],
      open.map((a) => ({
        id: a.id,
        kind: 'low_stock' as const,
        resolution: 'rule_removed',
        webhookLocationIds: locationIds,
        details: {},
      })),
      'rule_removed',
    );
    return {
      result: { ruleId: rule.id, removed: true },
      audit: {
        targetType: 'reorder_rule',
        targetId: rule.id,
        locationIds: rule.location_id ? [rule.location_id] : [],
        changes: { status: { from: 'active', to: 'archived' } },
      },
      events: effects.events,
      outbox: effects.outbox,
      webhooks: effects.webhooks,
    };
  },
});

// Drafting from low stock ---------------------------------------------------------------------

/** Rounds a non-negative decimal string up to `scale` decimal places. */
export function ceilDecimal(value: string, scale: number): string {
  const v = normalize(value);
  const [whole = '0', fraction = ''] = v.split('.');
  if (fraction.length <= scale) return v;
  const kept = fraction.slice(0, scale);
  const units = BigInt(whole + kept) + (/[1-9]/.test(fraction.slice(scale)) ? 1n : 0n);
  const text = units.toString().padStart(scale + 1, '0');
  return normalize(scale > 0 ? `${text.slice(0, -scale)}.${text.slice(-scale)}` : text);
}

const max = (a: string, b: string) => (compare(a, b) >= 0 ? a : b);

const SuggestedLine = z.object({
  ruleId: Id,
  variantId: Id,
  sku: z.string(),
  productName: z.string(),
  available: z.string(),
  onOrder: z.string(),
  reorderPoint: z.string(),
  need: z.string().describe('Base units the rule asks for, minus what is already on order.'),
  supplierItemId: Id.nullable(),
  supplierSku: z.string().nullable(),
  packId: Id.nullable(),
  packName: z.string().nullable(),
  packFactor: z.string().nullable(),
  minimumOrderQuantity: z.string().nullable(),
  quantity: z
    .string()
    .describe('Suggested quantity: packs when packId is set, else base units, after rounding.'),
  ordered: z.string().describe('The suggested quantity in base units.'),
  unitCost: z.string().nullable().describe('The supplier’s last cost; needs costs.read.'),
});

export const suggestFromLowStock = defineOperation({
  id: 'purchasing.low_stock.suggest',
  summary: 'Suggest purchase orders from low stock',
  description:
    'Use this when someone asks what to reorder, or to draft purchase orders for what is running low. Proposes one purchase order per preferred supplier and warehouse for every rule at or below its reorder point: the reorder quantity, or the amount up to the maximum level, minus what is already on order, rounded up to the supplier’s pack and minimum order quantity. It saves nothing: show the proposal, then call draft for each order the person approves.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    warehouseId: Id.optional().describe('Only rules for this warehouse.'),
    supplierId: Id.optional().describe('Only lines for this supplier.'),
    ruleIds: z
      .array(Id)
      .max(500)
      .optional()
      .describe('Only these low-stock rules (the lines the person selected).'),
  }),
  output: z.object({
    drafts: z.array(
      z.object({
        supplierId: Id,
        supplierName: z.string(),
        warehouseId: Id,
        warehouseName: z.string(),
        lines: z.array(SuggestedLine),
      }),
    ),
    withoutSupplier: z
      .array(
        SuggestedLine.pick({
          ruleId: true,
          variantId: true,
          sku: true,
          productName: true,
          need: true,
        }),
      )
      .describe('Low rules with no preferred supplier or supplier item: set one to include them.'),
    costVisible: z.boolean(),
  }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'purchasing.low_stock.suggested' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/purchase-orders/suggestions' },
  mcp: { tool: TOOL, action: 'suggest_from_low_stock', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const costs = canSeeCosts(ctx);
    let states = (await reorderRuleStates(ctx.tx, null))
      .filter((s) => s.low)
      .filter((s) => ruleInScope(ctx.locationScope, s))
      .filter((s) => !input.warehouseId || s.warehouseId === input.warehouseId)
      .filter((s) => !input.ruleIds || input.ruleIds.includes(s.ruleId));
    // A warehouse rule covers the warehouse: location rules for the same variant there would
    // order the same units twice.
    const warehouseRules = new Set(
      states.filter((s) => !s.locationId).map((s) => `${s.variantId}:${s.warehouseId}`),
    );
    states = states.filter(
      (s) => !s.locationId || !warehouseRules.has(`${s.variantId}:${s.warehouseId}`),
    );
    if (states.length === 0) {
      return {
        result: { drafts: [], withoutSupplier: [], costVisible: costs },
        audit: { targetType: 'purchase_order', targetId: 'suggestions', context: { input } },
      };
    }
    // The supplier item: the rule's preferred supplier's item for the variant, else the variant's
    // preferred supplier item.
    const items = await ctx.tx.query<{
      variant_id: string;
      supplier_id: string;
      supplier_name: string;
      id: string;
      supplier_sku: string | null;
      pack_id: string | null;
      pack_name: string | null;
      pack_factor: string | null;
      minimum_order_quantity: string | null;
      last_cost: string | null;
      preferred: boolean;
      quantity_scale: number;
    }>(
      `select i.variant_id, i.supplier_id, s.name as supplier_name, i.id, i.supplier_sku, i.pack_id,
         k.name as pack_name, k.base_quantity::text as pack_factor,
         i.minimum_order_quantity::text, i.last_cost::text, i.preferred, v.quantity_scale
       from supplier_items i
       join suppliers s on s.shop_id = i.shop_id and s.id = i.supplier_id and s.status = 'active'
       join variants v on v.shop_id = i.shop_id and v.id = i.variant_id
       left join packs k on k.shop_id = i.shop_id and k.id = i.pack_id and k.status = 'active'
       where i.status = 'active' and i.variant_id = any($1::uuid[])
       order by i.preferred desc, i.id`,
      [[...new Set(states.map((s) => s.variantId))]],
    );
    const suppliers = await ctx.tx.query<{ id: string; name: string }>(
      `select id, name from suppliers where id = any($1::uuid[]) and status = 'active'`,
      [states.map((s) => s.preferredSupplierId).filter((id): id is string => id !== null)],
    );
    const [scales] = await ctx.tx.query<{ scales: Record<string, number> }>(
      `select coalesce(jsonb_object_agg(id, quantity_scale), '{}'::jsonb) as scales
       from variants where id = any($1::uuid[])`,
      [[...new Set(states.map((s) => s.variantId))]],
    );
    const drafts = new Map<
      string,
      {
        supplierId: string;
        supplierName: string;
        warehouseId: string;
        warehouseName: string;
        lines: z.infer<typeof SuggestedLine>[];
      }
    >();
    const withoutSupplier: Array<{
      ruleId: string;
      variantId: string;
      sku: string;
      productName: string;
      need: string;
    }> = [];
    for (const s of states) {
      const wanted = s.reorderQuantity ? s.reorderQuantity : subtract(s.maximumLevel!, s.available);
      const need = normalize(subtract(wanted, s.onOrder));
      if (compare(need, '0') <= 0) continue;
      const item = s.preferredSupplierId
        ? items.find((i) => i.variant_id === s.variantId && i.supplier_id === s.preferredSupplierId)
        : items.find((i) => i.variant_id === s.variantId && i.preferred);
      const supplierId = s.preferredSupplierId ?? item?.supplier_id ?? null;
      const supplierName =
        suppliers.find((x) => x.id === supplierId)?.name ?? item?.supplier_name ?? null;
      if (!supplierId || !supplierName) {
        withoutSupplier.push({
          ruleId: s.ruleId,
          variantId: s.variantId,
          sku: s.sku,
          productName: s.productName,
          need,
        });
        continue;
      }
      if (input.supplierId && supplierId !== input.supplierId) continue;
      const factor = item?.pack_id && item.pack_factor ? normalize(item.pack_factor) : null;
      const scale = scales?.scales[s.variantId] ?? 0;
      // Whole packs; base units rounded up to the variant's decimal places; then the minimum.
      let quantity = factor
        ? ceilDecimal(normalize(divideExact(need, factor)), 0)
        : ceilDecimal(need, scale);
      if (item?.minimum_order_quantity)
        quantity = max(quantity, normalize(item.minimum_order_quantity));
      const key = `${supplierId}:${s.warehouseId}`;
      const draft = drafts.get(key) ?? {
        supplierId,
        supplierName,
        warehouseId: s.warehouseId,
        warehouseName: s.warehouseName,
        lines: [],
      };
      draft.lines.push({
        ruleId: s.ruleId,
        variantId: s.variantId,
        sku: s.sku,
        productName: s.productName,
        available: normalize(s.available),
        onOrder: normalize(s.onOrder),
        reorderPoint: normalize(s.reorderPoint),
        need,
        supplierItemId: item?.id ?? null,
        supplierSku: item?.supplier_sku ?? null,
        packId: factor ? item!.pack_id : null,
        packName: factor ? item!.pack_name : null,
        packFactor: factor,
        minimumOrderQuantity: item?.minimum_order_quantity
          ? normalize(item.minimum_order_quantity)
          : null,
        quantity,
        ordered: normalize(factor ? exactProduct(quantity, factor) : quantity),
        unitCost: costs && item?.last_cost ? item.last_cost : null,
      });
      drafts.set(key, draft);
    }
    return {
      result: {
        drafts: [...drafts.values()].sort((a, b) => a.supplierName.localeCompare(b.supplierName)),
        withoutSupplier,
        costVisible: costs,
      },
      audit: { targetType: 'purchase_order', targetId: 'suggestions', context: { input } },
    };
  },
});

/**
 * a ÷ b for rounding up to whole packs: the whole quotient, plus a small fraction when there is a
 * remainder, so `ceilDecimal(…, 0)` rounds up exactly.
 */
function divideExact(a: string, b: string): string {
  const [wa = '0', fa = ''] = a.split('.');
  const [wb = '0', fb = ''] = b.split('.');
  const scale = Math.max(fa.length, fb.length);
  const x = BigInt(wa + fa.padEnd(scale, '0'));
  const y = BigInt(wb + fb.padEnd(scale, '0'));
  const q = x / y;
  return x % y === 0n ? q.toString() : `${q}.000001`;
}

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const reorderOperations = [
  listReorderRules,
  setReorderRule,
  removeReorderRule,
  suggestFromLowStock,
] as const;
