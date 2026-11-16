import type { Tx } from '@airstock/db';
import type { AuditEvent } from '../audit.ts';
import { compare } from '../catalog/decimal.ts';
import { uuidv7 } from '../ids.ts';
import { destinationLocationIds } from '../purchasing/orders.ts';
import type { HandlerContext, HandlerResult } from '../registry.ts';
import { type WebhookEmit, webhookEvent } from '../webhooks/events.ts';

// Alerts checked inside the transaction that changes stock or on order (D12, PRD 6.9): a cheap
// comparison after the command's own locks (alerts are last in the lock order, ADR 0006). The
// notification goes through the outbox, so an alert never fires for stock that did not commit.

export const ALERT_KINDS = [
  'low_stock',
  'lot_expiring',
  'shortage',
  'shopify_sync',
  'reconciliation_mismatch',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Outbox topics the alert notifier reads (also written by the stock check, I1). */
export const ALERT_OPENED = 'alert.opened';
export const ALERT_RESOLVED = 'alert.resolved';

export interface AlertEffects {
  events: AuditEvent[];
  outbox: Array<{ topic: string; payload: unknown }>;
  webhooks: WebhookEmit[];
}

const none = (): AlertEffects => ({ events: [], outbox: [], webhooks: [] });

function merge(a: AlertEffects, b: AlertEffects): AlertEffects {
  return {
    events: [...a.events, ...b.events],
    outbox: [...a.outbox, ...b.outbox],
    webhooks: [...a.webhooks, ...b.webhooks],
  };
}

interface Opened {
  id: string;
  kind: AlertKind;
  dedupeKey: string;
  targetType: string;
  targetId: string;
  ruleId?: string | null;
  variantId?: string | null;
  warehouseId?: string | null;
  lotId?: string | null;
  /** The scope path the alert is about; null is shop-wide. */
  scopeIds: string[] | null;
  /** Locations a webhook's location filter matches. */
  webhookLocationIds: string[];
  details: Record<string, unknown>;
}

interface Resolved {
  id: string;
  kind: AlertKind;
  resolution: string;
  webhookLocationIds: string[];
  details: Record<string, unknown>;
}

/**
 * Opens and resolves alerts in one statement and returns the events for those that changed. An
 * open alert that a concurrent transaction opened first is left alone: the open-key index makes
 * this insert wait, then do nothing (one open alert per key, D12).
 */
export async function applyAlertChanges(
  tx: Tx,
  event: HandlerContext['event'],
  opened: Opened[],
  resolved: Resolved[],
  trigger: string,
): Promise<AlertEffects> {
  if (opened.length === 0 && resolved.length === 0) return none();
  const rows = await tx.query<{
    change: 'opened' | 'resolved';
    id: string;
    opened_at: Date;
    resolved_at: Date | null;
  }>(
    `with opened as (
       insert into alerts (shop_id, id, kind, dedupe_key, target_type, target_id, rule_id, variant_id,
         warehouse_id, lot_id, location_ids, details)
       select app_shop_id(), x.id, x.kind, x."dedupeKey", x."targetType", x."targetId", x."ruleId",
         x."variantId", x."warehouseId", x."lotId", x."scopeIds", x.details
       from jsonb_to_recordset($1::jsonb) as x(id uuid, kind text, "dedupeKey" text,
         "targetType" text, "targetId" uuid, "ruleId" uuid, "variantId" uuid, "warehouseId" uuid,
         "lotId" uuid, "scopeIds" uuid[], details jsonb)
       on conflict (shop_id, dedupe_key) where status <> 'resolved' do nothing
       returning id, opened_at),
     resolved as (
       update alerts a set status = 'resolved', resolved_at = now(), last_seen_at = now(),
         resolution = x.resolution, details = a.details || x.details, version = a.version + 1
       from jsonb_to_recordset($2::jsonb) as x(id uuid, resolution text, details jsonb)
       where a.id = x.id and a.status <> 'resolved'
       returning a.id, a.opened_at, a.resolved_at)
     select 'opened' as change, id, opened_at, null::timestamptz as resolved_at from opened
     union all
     select 'resolved', id, opened_at, resolved_at from resolved`,
    [
      JSON.stringify(opened.map((o) => ({ ...o, webhookLocationIds: undefined }))),
      JSON.stringify(
        resolved.map((r) => ({ id: r.id, resolution: r.resolution, details: r.details })),
      ),
    ],
  );
  const effects = none();
  for (const row of rows) {
    if (row.change === 'opened') {
      const o = opened.find((x) => x.id === row.id)!;
      const alert = {
        id: o.id,
        kind: o.kind,
        status: 'open',
        variantId: o.variantId ?? null,
        warehouseId: o.warehouseId ?? null,
        ...o.details,
        openedAt: new Date(row.opened_at).toISOString(),
      };
      effects.events.push(
        event({
          action: 'alert.opened',
          outcome: 'succeeded',
          actor_type: 'system',
          actor_id: 'alerts',
          target_type: 'alert',
          target_id: o.id,
          location_ids: o.webhookLocationIds.length > 0 ? o.webhookLocationIds : null,
          changes: { status: 'open', kind: o.kind, details: o.details },
          context: { trigger, dedupeKey: o.dedupeKey },
        }),
      );
      effects.outbox.push({ topic: ALERT_OPENED, payload: { alertId: o.id, kind: o.kind } });
      effects.webhooks.push(
        webhookEvent('alert.opened', {
          data: { alert },
          locationIds: o.webhookLocationIds,
          alertKind: o.kind,
        }),
      );
    } else {
      const r = resolved.find((x) => x.id === row.id)!;
      effects.events.push(
        event({
          action: 'alert.resolved',
          outcome: 'succeeded',
          actor_type: 'system',
          actor_id: 'alerts',
          target_type: 'alert',
          target_id: r.id,
          location_ids: r.webhookLocationIds.length > 0 ? r.webhookLocationIds : null,
          changes: { status: { to: 'resolved' }, resolution: r.resolution, details: r.details },
          context: { trigger },
        }),
      );
      effects.outbox.push({ topic: ALERT_RESOLVED, payload: { alertId: r.id, kind: r.kind } });
      effects.webhooks.push(
        webhookEvent('alert.resolved', {
          data: {
            alert: {
              id: r.id,
              kind: r.kind,
              resolution: r.resolution,
              ...r.details,
              openedAt: new Date(row.opened_at).toISOString(),
              resolvedAt: new Date(row.resolved_at!).toISOString(),
            },
          },
          locationIds: r.webhookLocationIds,
          alertKind: r.kind,
        }),
      );
    }
  }
  return effects;
}

/** A rule's state now: available and on order in its warehouse (or location). */
export interface RuleState {
  ruleId: string;
  variantId: string;
  sku: string;
  productName: string;
  warehouseId: string;
  warehouseName: string;
  locationId: string | null;
  locationPath: string | null;
  scopeIds: string[];
  reorderPoint: string;
  reorderQuantity: string | null;
  maximumLevel: string | null;
  preferredSupplierId: string | null;
  available: string;
  onOrder: string;
  low: boolean;
  alertId: string | null;
  alertStatus: string | null;
}

/**
 * Every active rule for these variants (or all rules, with null), with available stock (the shared
 * `stock_positions` rule) and on order in its warehouse or location, and its open alert.
 */
export async function reorderRuleStates(
  tx: Tx,
  variantIds: string[] | null,
  ruleIds: string[] | null = null,
): Promise<RuleState[]> {
  const rows = await tx.query<{
    rule_id: string;
    variant_id: string;
    sku: string;
    product_name: string;
    warehouse_id: string;
    warehouse_name: string;
    location_id: string | null;
    location_path: string | null;
    scope_ids: string[];
    reorder_point: string;
    reorder_quantity: string | null;
    maximum_level: string | null;
    preferred_supplier_id: string | null;
    available: string;
    on_order: string;
    low: boolean;
    alert_id: string | null;
    alert_status: string | null;
  }>(
    `with r as (
       select r.id, r.variant_id, r.warehouse_id, r.location_id, r.reorder_point,
         r.reorder_quantity, r.maximum_level, r.preferred_supplier_id,
         case when r.location_id is null then array[r.warehouse_id] else lp.path_ids end as scope_ids,
         lp.path as location_path
       from reorder_rules r
       left join locations lp on lp.shop_id = r.shop_id and lp.id = r.location_id
       where r.status = 'active'
         and ($1::uuid[] is null or r.variant_id = any($1::uuid[]))
         and ($2::uuid[] is null or r.id = any($2::uuid[]))),
     sp as (select * from stock_positions(array(select distinct variant_id from r))),
     oo as (
       select o.variant_id, o.warehouse_id, o.quantity, ol.path_ids
       from purchase_on_order(array(select distinct variant_id from r)) o
       left join locations ol on ol.shop_id = app_shop_id() and ol.id = o.location_id),
     s as (
       select r.*,
         coalesce((select sum(sp.available) from sp where sp.variant_id = r.variant_id
           and sp.warehouse_id = r.warehouse_id
           and (r.location_id is null or sp.path_ids @> array[r.location_id])), 0) as available,
         coalesce((select sum(oo.quantity) from oo where oo.variant_id = r.variant_id
           and oo.warehouse_id = r.warehouse_id
           and (r.location_id is null or oo.path_ids @> array[r.location_id])), 0) as on_order
       from r)
     select s.id as rule_id, s.variant_id, v.sku, p.name as product_name, s.warehouse_id,
       w.name as warehouse_name, s.location_id, s.location_path, s.scope_ids,
       s.reorder_point::text, s.reorder_quantity::text, s.maximum_level::text,
       s.preferred_supplier_id, s.available::text, s.on_order::text,
       s.available + s.on_order <= s.reorder_point as low,
       a.id as alert_id, a.status as alert_status
     from s
     join variants v on v.shop_id = app_shop_id() and v.id = s.variant_id
     join products p on p.shop_id = v.shop_id and p.id = v.product_id
     join warehouses w on w.shop_id = app_shop_id() and w.id = s.warehouse_id
     left join alerts a on a.shop_id = app_shop_id() and a.dedupe_key = 'low_stock:' || s.id
       and a.status <> 'resolved'
     order by v.sku, w.name, s.location_path nulls first`,
    [variantIds, ruleIds],
  );
  return rows.map((r) => ({
    ruleId: r.rule_id,
    variantId: r.variant_id,
    sku: r.sku,
    productName: r.product_name,
    warehouseId: r.warehouse_id,
    warehouseName: r.warehouse_name,
    locationId: r.location_id,
    locationPath: r.location_path,
    scopeIds: r.scope_ids,
    reorderPoint: r.reorder_point,
    reorderQuantity: r.reorder_quantity,
    maximumLevel: r.maximum_level,
    preferredSupplierId: r.preferred_supplier_id,
    available: r.available,
    onOrder: r.on_order,
    low: r.low,
    alertId: r.alert_id,
    alertStatus: r.alert_status,
  }));
}

/**
 * Low stock (PRD 6.9): opens an alert when available plus on order falls to or below a rule's
 * reorder point, and resolves it when stock recovers above. One open alert per rule.
 */
export async function checkReorderRules(
  ctx: Pick<HandlerContext, 'tx' | 'event'>,
  variantIds: string[] | null,
  trigger = 'stock_change',
): Promise<AlertEffects> {
  if (variantIds !== null && variantIds.length === 0) return none();
  const states = await reorderRuleStates(ctx.tx, variantIds);
  const opened: Opened[] = [];
  const resolved: Resolved[] = [];
  for (const s of states) {
    const figures = {
      sku: s.sku,
      productName: s.productName,
      warehouseName: s.warehouseName,
      locationPath: s.locationPath,
      available: s.available,
      onOrder: s.onOrder,
      reorderPoint: s.reorderPoint,
    };
    if (s.low && !s.alertId) {
      opened.push({
        id: uuidv7(),
        kind: 'low_stock',
        dedupeKey: `low_stock:${s.ruleId}`,
        targetType: 'reorder_rule',
        targetId: s.ruleId,
        ruleId: s.ruleId,
        variantId: s.variantId,
        warehouseId: s.warehouseId,
        scopeIds: s.scopeIds,
        webhookLocationIds: await destinationLocationIds(ctx.tx, s.warehouseId, s.locationId),
        details: {
          ...figures,
          ruleId: s.ruleId,
          reorderQuantity: s.reorderQuantity,
          maximumLevel: s.maximumLevel,
        },
      });
    } else if (!s.low && s.alertId) {
      resolved.push({
        id: s.alertId,
        kind: 'low_stock',
        resolution: 'recovered',
        webhookLocationIds: await destinationLocationIds(ctx.tx, s.warehouseId, s.locationId),
        details: { recovered: { available: s.available, onOrder: s.onOrder } },
      });
    }
  }
  return applyAlertChanges(ctx.tx, ctx.event, opened, resolved, trigger);
}

/**
 * Shortages (D6): one open alert per variant while connector orders wait for stock no position
 * covers; resolved when the variant has no open shortage left.
 */
export async function checkShortages(
  ctx: Pick<HandlerContext, 'tx' | 'event'>,
  opening: string[],
  touched: string[] | null,
  trigger = 'stock_change',
): Promise<AlertEffects> {
  const ids = touched === null ? null : [...new Set([...opening, ...touched])];
  if (ids !== null && ids.length === 0) return none();
  const rows = await ctx.tx.query<{
    variant_id: string;
    sku: string;
    product_name: string;
    shortage: string;
    reservations: number;
    alert_id: string | null;
  }>(
    `with v as (
       select distinct x as variant_id from unnest($1::uuid[]) x
       union
       select variant_id from alerts where kind = 'shortage' and status <> 'resolved'
         and ($2::uuid[] is null or variant_id = any($2::uuid[]))),
     s as (
       select v.variant_id,
         coalesce((select sum(r.shortage_quantity) from reservations r
           where r.shop_id = app_shop_id() and r.variant_id = v.variant_id and r.shortage_quantity > 0
             and r.status in ('active', 'partially_fulfilled')), 0) as shortage,
         (select count(*)::int from reservations r
           where r.shop_id = app_shop_id() and r.variant_id = v.variant_id and r.shortage_quantity > 0
             and r.status in ('active', 'partially_fulfilled')) as reservations
       from v)
     select s.variant_id, vv.sku, p.name as product_name, s.shortage::text, s.reservations,
       a.id as alert_id
     from s
     join variants vv on vv.shop_id = app_shop_id() and vv.id = s.variant_id
     join products p on p.shop_id = vv.shop_id and p.id = vv.product_id
     left join alerts a on a.shop_id = app_shop_id() and a.dedupe_key = 'shortage:' || s.variant_id
       and a.status <> 'resolved'`,
    [opening, ids],
  );
  const opened: Opened[] = [];
  const resolved: Resolved[] = [];
  for (const r of rows) {
    const short = compare(r.shortage, '0') > 0;
    if (short && !r.alert_id && opening.includes(r.variant_id)) {
      opened.push({
        id: uuidv7(),
        kind: 'shortage',
        dedupeKey: `shortage:${r.variant_id}`,
        targetType: 'variant',
        targetId: r.variant_id,
        variantId: r.variant_id,
        scopeIds: null,
        webhookLocationIds: [],
        details: {
          sku: r.sku,
          productName: r.product_name,
          shortage: r.shortage,
          reservations: r.reservations,
        },
      });
    } else if (!short && r.alert_id) {
      resolved.push({
        id: r.alert_id,
        kind: 'shortage',
        resolution: 'filled',
        webhookLocationIds: [],
        details: {},
      });
    }
  }
  return applyAlertChanges(ctx.tx, ctx.event, opened, resolved, trigger);
}

/**
 * The pipeline's check after a command (D12): variants whose availability changed (the
 * `inventory.availability_changed` outbox rows every stock command writes), variants whose on
 * order changed (`alertCheck`), and new shortages. Adds the alert events, outbox rows, and
 * webhook events to the command's own, so they commit or roll back with it.
 */
/** The probe's columns, `rules` and `shortage_alerts`, for the variants in $1. */
export const STOCK_ALERT_PROBE = `exists (select 1 from reorder_rules where status = 'active'
         and variant_id = any($1::uuid[])) as rules,
       exists (select 1 from alerts where kind = 'shortage' and status <> 'resolved'
         and variant_id = any($1::uuid[])) as shortage_alerts`;

/**
 * Whether any of the variants has an active reorder rule or an open shortage alert: when neither,
 * a stock change has no alert to check.
 */
export async function probeStockAlerts(
  tx: Tx,
  variantIds: string[],
): Promise<{ variantIds: string[]; rules: boolean; shortageAlerts: boolean }> {
  const [row] = await tx.query<{ rules: boolean; shortage_alerts: boolean }>(
    `select ${STOCK_ALERT_PROBE}`,
    [variantIds],
  );
  return { variantIds, rules: row?.rules ?? false, shortageAlerts: row?.shortage_alerts ?? false };
}

export async function applyStockAlerts(
  ctx: HandlerContext,
  handled: HandlerResult<unknown>,
): Promise<void> {
  const variants = new Set<string>(handled.alertCheck?.variantIds ?? []);
  const positions: string[] = [];
  const shortages = new Set<string>();
  for (const o of handled.outbox ?? []) {
    const p = (o.payload ?? {}) as {
      variantId?: string;
      positionIds?: string[];
      shortages?: Array<{ variantId?: string }>;
    };
    if (o.topic === 'inventory.availability_changed') {
      if (p.variantId) variants.add(p.variantId);
      else positions.push(...(p.positionIds ?? []));
    } else if (o.topic === 'inventory.shortage_opened') {
      for (const s of p.shortages ?? []) if (s.variantId) shortages.add(s.variantId);
    }
  }
  if (positions.length > 0) {
    const rows = await ctx.tx.query<{ variant_id: string }>(
      'select distinct variant_id from inventory_positions where id = any($1::uuid[])',
      [positions],
    );
    for (const r of rows) variants.add(r.variant_id);
  }
  if (variants.size === 0 && shortages.size === 0) return;
  // Shops without rules or open shortage alerts pay one probe each. A handler may have run it
  // before taking its locks (a reservation, I7), for the same variants.
  const hint = handled.alertProbe;
  const any =
    hint && [...variants].every((v) => hint.variantIds.includes(v))
      ? hint
      : await probeStockAlerts(ctx.tx, [...variants]);
  let effects = none();
  if (any.rules) effects = merge(effects, await checkReorderRules(ctx, [...variants]));
  if (shortages.size > 0 || any.shortageAlerts) {
    effects = merge(effects, await checkShortages(ctx, [...shortages], [...variants]));
  }
  if (effects.events.length === 0) return;
  handled.events = [...(handled.events ?? []), ...effects.events];
  handled.outbox = [...(handled.outbox ?? []), ...effects.outbox];
  handled.webhooks = [...(handled.webhooks ?? []), ...effects.webhooks];
}
