import { z } from 'zod';
import { normalize, subtract } from '../catalog/decimal.ts';
import { errors } from '../errors.ts';
import { defineOperation } from '../registry.ts';
import { Id } from '../schemas.ts';
import { normalizeCode } from '../stock/engine.ts';
import { Flag, isSet, LotCode } from './inventory.ts';

// Lots, lot trace, and serial history (plan Section 5.7, D4). All three are queries over the
// ledger: entries name the lot, serial, and reservation they moved.

const TOOL = 'get_stock';

const iso = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const listLots = defineOperation({
  id: 'inventory.lots.list',
  summary: 'List a variant’s lots with expiry and stock',
  description:
    'Use this for lot and expiry questions about one variant: each lot’s code, expiry date, when it stops being sellable (after the sell-by margin), and its on-hand, reserved, and available units. Earliest expiry first. Lots without stock are left out unless includeEmpty is true.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    variantId: Id,
    includeEmpty: Flag.optional(),
    expiringWithinDays: z.coerce
      .number()
      .int()
      .min(0)
      .max(3650)
      .optional()
      .describe('Only lots that stop being sellable within this many days.'),
  }),
  output: z.object({
    variantId: Id,
    sellByMarginDays: z.number(),
    partial: z.boolean(),
    lots: z.array(
      z.object({
        lotId: Id,
        code: z.string(),
        expiresOn: z.string().nullable(),
        producedOn: z.string().nullable(),
        sellableUntil: z.string().nullable(),
        expired: z.boolean(),
        supplierId: Id.nullable(),
        purchaseOrderRef: z.string().nullable(),
        onHand: z.string(),
        reserved: z.string(),
        available: z.string(),
      }),
    ),
  }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'inventory.lots.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/lots' },
  mcp: { tool: TOOL, action: 'lots', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const [variant] = await ctx.tx.query<{ margin: number }>(
      'select sell_by_margin_days as margin from variants where id = $1',
      [input.variantId],
    );
    if (!variant) throw errors.notFound('Variant');
    const lots = await ctx.tx.query<{
      lotId: string;
      code: string;
      expiresOn: string | null;
      producedOn: string | null;
      sellableUntil: string | null;
      expired: boolean;
      supplierId: string | null;
      purchaseOrderRef: string | null;
      onHand: string;
      reserved: string;
      available: string;
    }>(
      `with stock as (
         select sp.lot_id, sum(sp.on_hand) as on_hand, sum(sp.reserved) as reserved,
           sum(sp.available) as available
         from stock_positions(array[$1::uuid]) sp
         where sp.lot_id is not null and ($2::uuid[] is null or sp.path_ids && $2::uuid[])
         group by sp.lot_id),
       lots_until as (
         select lt.*, lot_sellable_until(lt.expires_on, $3,
           (select timezone from shops where id = app_shop_id())) as until
         from lots lt where lt.variant_id = $1)
       select lt.id as "lotId", lt.code, to_char(lt.expires_on, 'YYYY-MM-DD') as "expiresOn",
         to_char(lt.produced_on, 'YYYY-MM-DD') as "producedOn",
         ${iso('lt.until')} as "sellableUntil", coalesce(now() >= lt.until, false) as expired,
         lt.supplier_id as "supplierId", lt.purchase_order_ref as "purchaseOrderRef",
         coalesce(s.on_hand, 0)::text as "onHand", coalesce(s.reserved, 0)::text as reserved,
         coalesce(s.available, 0)::text as available
       from lots_until lt left join stock s on s.lot_id = lt.id
       where ($4 or coalesce(s.on_hand, 0) > 0 or coalesce(s.reserved, 0) > 0)
         and ($5::integer is null or lt.until <= now() + make_interval(days => $5::integer))
       order by lt.expires_on nulls last, lt.code_normalized
       limit 1000`,
      [
        input.variantId,
        ctx.locationScope,
        variant.margin,
        isSet(input.includeEmpty),
        input.expiringWithinDays ?? null,
      ],
    );
    return {
      result: {
        variantId: input.variantId,
        sellByMarginDays: variant.margin,
        partial: ctx.locationScope !== null,
        lots,
      },
      audit: { targetType: 'variant', targetId: input.variantId, context: { input } },
    };
  },
});

const Movement = z.object({
  operationId: Id,
  kind: z.string(),
  occurredAt: z.string(),
  quantity: z.string().describe('Positive into stock, negative out of it.'),
  locationId: Id,
  locationPath: z.string(),
  condition: z.string(),
  reservationId: Id.nullable(),
  externalRef: z.string().nullable(),
  reference: z.string().nullable().describe('The operation’s own reference.'),
  supplierId: Id.nullable(),
  actorType: z.string(),
  source: z.string(),
});

/** Movements matching `filter` ($1), at locations in the caller's scope ($2, null: all). */
const MOVEMENTS_SQL = (filter: string) => `
  select o.id as "operationId", o.kind, ${iso('o.occurred_at')} as "occurredAt",
    e.delta::text as quantity, e.location_id as "locationId", l.path as "locationPath",
    p.condition, e.reservation_id as "reservationId",
    coalesce(r.external_ref, rp.external_ref) as "externalRef", o.external_ref as reference,
    o.supplier_id as "supplierId", o.actor_type as "actorType", o.source
  from inventory_entries e
  join inventory_operations o on o.shop_id = e.shop_id and o.id = e.operation_id
  join inventory_positions p on p.shop_id = e.shop_id and p.id = e.position_id
  join locations l on l.shop_id = e.shop_id and l.id = e.location_id
  left join reservations r on r.shop_id = e.shop_id and r.id = e.reservation_id
  left join reservations rp on rp.shop_id = r.shop_id and rp.id = r.parent_id
  where ${filter} and ($2::uuid[] is null or l.path_ids && $2::uuid[])
  order by o.occurred_at, e.id
  limit 5000`;

export const traceLot = defineOperation({
  id: 'inventory.lots.trace',
  summary: 'Trace a lot from receipt to every order',
  description:
    'Use this for recalls and "which orders got lot X": where the lot came from (supplier, receipts) and every movement since, including each fulfillment with its order reference. Give lotId, or variantId with lotCode. Movements and totals cover only the locations you can access (partial).',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    lotId: Id.optional(),
    variantId: Id.optional(),
    lotCode: LotCode.optional(),
  }),
  output: z.object({
    lot: z.object({
      lotId: Id,
      variantId: Id,
      sku: z.string(),
      code: z.string(),
      expiresOn: z.string().nullable(),
      producedOn: z.string().nullable(),
      supplierId: Id.nullable(),
      supplierName: z.string().nullable(),
      purchaseOrderRef: z.string().nullable(),
    }),
    totals: z.object({ received: z.string(), fulfilled: z.string(), onHand: z.string() }),
    partial: z
      .boolean()
      .describe('True when your location access limits the movements and totals.'),
    orders: z
      .array(
        z.object({ externalRef: z.string().nullable(), reservationId: Id, quantity: z.string() }),
      )
      .describe('Every reservation that received units of the lot.'),
    movements: z.array(Movement),
  }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'inventory.lot.traced' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/lots/trace' },
  mcp: { tool: TOOL, action: 'lot_trace', readOnly: true, destructive: false },
  async handler(ctx, input) {
    if (!input.lotId && !(input.variantId && input.lotCode)) {
      throw errors.validation([
        { path: 'lotId', message: 'Give lotId, or variantId and lotCode.' },
      ]);
    }
    const [lot] = await ctx.tx.query<{
      lotId: string;
      variantId: string;
      sku: string;
      code: string;
      expiresOn: string | null;
      producedOn: string | null;
      supplierId: string | null;
      supplierName: string | null;
      purchaseOrderRef: string | null;
    }>(
      `select lt.id as "lotId", lt.variant_id as "variantId", v.sku, lt.code,
         to_char(lt.expires_on, 'YYYY-MM-DD') as "expiresOn",
         to_char(lt.produced_on, 'YYYY-MM-DD') as "producedOn", lt.supplier_id as "supplierId",
         s.name as "supplierName", lt.purchase_order_ref as "purchaseOrderRef"
       from lots lt join variants v on v.shop_id = lt.shop_id and v.id = lt.variant_id
       left join suppliers s on s.shop_id = lt.shop_id and s.id = lt.supplier_id
       where ($1::uuid is null or lt.id = $1)
         and ($2::uuid is null or (lt.variant_id = $2 and lt.code_normalized = $3))`,
      [
        input.lotId ?? null,
        input.lotId ? null : (input.variantId ?? null),
        input.lotCode ? normalizeCode(input.lotCode) : null,
      ],
    );
    if (!lot) throw errors.notFound('Lot');
    // Location scope (PRD 2.4): movements and figures at other locations are hidden.
    const movements = await ctx.tx.query<z.infer<typeof Movement>>(MOVEMENTS_SQL('e.lot_id = $1'), [
      lot.lotId,
      ctx.locationScope,
    ]);
    const [totals] = await ctx.tx.query<{ received: string; fulfilled: string; onHand: string }>(
      `select coalesce(sum(e.delta) filter (where o.kind = 'receipt'), 0)::text as received,
         coalesce(-sum(e.delta) filter (where o.kind = 'fulfillment'), 0)::text as fulfilled,
         coalesce(sum(e.delta), 0)::text as "onHand"
       from inventory_entries e join inventory_operations o on o.shop_id = e.shop_id and o.id = e.operation_id
       join locations l on l.shop_id = e.shop_id and l.id = e.location_id
       where e.lot_id = $1 and ($2::uuid[] is null or l.path_ids && $2::uuid[])`,
      [lot.lotId, ctx.locationScope],
    );
    const orders = new Map<
      string,
      { externalRef: string | null; reservationId: string; quantity: string }
    >();
    for (const m of movements) {
      if (m.kind !== 'fulfillment' || !m.reservationId) continue;
      const o = orders.get(m.reservationId) ?? {
        externalRef: m.externalRef,
        reservationId: m.reservationId,
        quantity: '0',
      };
      o.quantity = normalize(subtract(o.quantity, m.quantity));
      orders.set(m.reservationId, o);
    }
    return {
      result: {
        lot,
        totals: totals ?? { received: '0', fulfilled: '0', onHand: '0' },
        partial: ctx.locationScope !== null,
        orders: [...orders.values()].map((o) => ({
          externalRef: o.externalRef,
          reservationId: o.reservationId,
          quantity: o.quantity,
        })),
        movements,
      },
      audit: {
        targetType: 'lot',
        targetId: lot.lotId,
        locationIds: [...new Set(movements.map((m) => m.locationId))].slice(0, 100),
        context: { input },
      },
    };
  },
});

export const serialHistory = defineOperation({
  id: 'inventory.serials.history',
  summary: 'Show a serial’s history',
  description:
    'Use this for one serialized unit (a serial or certificate number): its status, where it is now, and every step since it was received, including the order it was fulfilled for. Positions and movements at locations you cannot access are left out (partial).',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    variantId: Id,
    serial: z.string().trim().min(1).max(100),
  }),
  output: z.object({
    serialId: Id,
    serial: z.string(),
    variantId: Id,
    sku: z.string(),
    status: z.string(),
    current: z
      .object({ positionId: Id, locationId: Id, locationPath: z.string(), condition: z.string() })
      .nullable()
      .describe('Null when the unit is not in stock, or is at a location you cannot access.'),
    partial: z.boolean().describe('True when your location access limits what is shown.'),
    movements: z.array(Movement),
  }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'inventory.serial.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/serials/history' },
  mcp: { tool: TOOL, action: 'serial_history', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const [unit] = await ctx.tx.query<{
      id: string;
      serial: string;
      sku: string;
      status: string;
      position_id: string | null;
      location_id: string | null;
      path: string | null;
      condition: string | null;
      in_scope: boolean;
    }>(
      `select s.id, s.serial, v.sku, s.status, s.position_id, p.location_id, l.path, p.condition,
         ($3::uuid[] is null or coalesce(l.path_ids && $3::uuid[], false)) as in_scope
       from serial_units s join variants v on v.shop_id = s.shop_id and v.id = s.variant_id
       left join inventory_positions p on p.shop_id = s.shop_id and p.id = s.position_id
       left join locations l on l.shop_id = p.shop_id and l.id = p.location_id
       where s.variant_id = $1 and s.serial_normalized = $2`,
      [input.variantId, normalizeCode(input.serial), ctx.locationScope],
    );
    if (!unit) throw errors.notFound('Serial');
    // Location scope (PRD 2.4): the position and movements at other locations are hidden.
    const movements = await ctx.tx.query<z.infer<typeof Movement>>(
      MOVEMENTS_SQL('e.serial_id = $1'),
      [unit.id, ctx.locationScope],
    );
    return {
      result: {
        serialId: unit.id,
        serial: unit.serial,
        variantId: input.variantId,
        sku: unit.sku,
        status: unit.status,
        current:
          unit.position_id && unit.location_id && unit.in_scope
            ? {
                positionId: unit.position_id,
                locationId: unit.location_id,
                locationPath: unit.path ?? '',
                condition: unit.condition ?? '',
              }
            : null,
        partial: ctx.locationScope !== null,
        movements,
      },
      audit: {
        targetType: 'serial_unit',
        targetId: unit.id,
        locationIds: [...new Set(movements.map((m) => m.locationId))],
        context: { input },
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const inventoryLotsOperations = [listLots, traceLot, serialHistory] as const;
