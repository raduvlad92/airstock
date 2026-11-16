import type { Tx } from '@airstock/db';
import type { AuditEvent } from '../audit.ts';
import { add, compare, fitsScale, multiply, normalize, subtract } from '../catalog/decimal.ts';
import { AppError, errors } from '../errors.ts';
import { effectivePermissions } from '../permissions.ts';
import type { HandlerContext } from '../registry.ts';

// The stock engine shared by every inventory command (ADR 0020, ADR 0006).
//
// Lock order, always:
//   1. inventory_positions, ascending id      (lockPositions, lockCandidates)
//   2. reservations, ascending id             (lockReservations, expireClaimsAt)
//   3. everything else: variant_costs (applyStockCost), serial_units, lots, products
// Quantities stay decimal strings; arithmetic is exact (catalog/decimal.ts) or in PostgreSQL.

export const OPEN_STATUSES = ['active', 'partially_fulfilled'] as const;

/** Lot codes and serials compare trimmed, with inner spaces collapsed, in upper case (D4). */
export function normalizeCode(code: string): string {
  return code.trim().replace(/\s+/g, ' ').toUpperCase();
}

export type TrackingMode = 'none' | 'lot' | 'lot_expiry' | 'serial';

export interface StockVariant {
  id: string;
  productId: string;
  productStatus: string;
  sku: string;
  status: string;
  quantityScale: number;
  trackingMode: TrackingMode;
  oneOfAKind: boolean;
  bundleId: string | null;
}

/**
 * Loads a variant for a stock command and takes a key-share lock on it, so a change of tracking
 * mode (which takes FOR UPDATE) cannot pass its no-stock check while stock arrives (ADR 0020).
 */
export async function loadStockVariant(tx: Tx, variantId: string): Promise<StockVariant> {
  const [row] = await tx.query<{
    id: string;
    product_id: string;
    product_status: string;
    sku: string;
    status: string;
    quantity_scale: number;
    tracking_mode: TrackingMode;
    one_of_a_kind: boolean;
    bundle_id: string | null;
  }>(
    `select v.id, v.product_id, p.status as product_status, v.sku, v.status, v.quantity_scale,
       v.tracking_mode, v.one_of_a_kind,
       (select b.id from bundles b where b.shop_id = v.shop_id and b.variant_id = v.id and b.active) as bundle_id
     from variants v join products p on p.shop_id = v.shop_id and p.id = v.product_id
     where v.id = $1
     for key share of v`,
    [variantId],
  );
  if (!row) throw errors.notFound('Variant');
  if (row.status !== 'active')
    throw errors.conflict('variant_archived', 'The variant is archived.');
  return {
    id: row.id,
    productId: row.product_id,
    productStatus: row.product_status,
    sku: row.sku,
    status: row.status,
    quantityScale: row.quantity_scale,
    trackingMode: row.tracking_mode,
    oneOfAKind: row.one_of_a_kind,
    bundleId: row.bundle_id,
  };
}

export function assertScale(quantity: string, scale: number, what = 'This variant'): void {
  if (!fitsScale(quantity, scale)) {
    throw errors.unprocessable(
      'quantity_precision',
      `${what} allows ${scale} decimal places in quantities.`,
      { quantity: normalize(quantity), quantityScale: scale },
    );
  }
}

export function actorColumns(ctx: HandlerContext) {
  return [ctx.caller.kind, ctx.caller.id, ctx.caller.source, ctx.attemptId] as const;
}

/** Whether the caller may see and set costs (PRD 6.11). */
export function canSeeCosts(ctx: HandlerContext): boolean {
  return ctx.membership ? effectivePermissions(ctx.membership).has('costs.read') : false;
}

export function requireCosts(ctx: HandlerContext): void {
  if (!canSeeCosts(ctx))
    throw errors.forbidden('Entering a cost requires the costs.read permission.');
}

export function insufficientStock(requested: string, available: string, extra = {}): AppError {
  return new AppError(
    409,
    'insufficient_stock',
    'Not enough sellable stock is available.',
    'conflict',
    {
      requested: normalize(requested),
      available,
      ...extra,
    },
  );
}

// Locks -------------------------------------------------------------------------------------

/** Locks positions in id order. Returns the ids that exist. */
export async function lockPositions(tx: Tx, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx.query<{ id: string }>(
    'select id from inventory_positions where id = any($1::uuid[]) order by id for update',
    [[...new Set(ids)]],
  );
  return rows.map((r) => r.id);
}

export interface CandidateSpec {
  variantIds: string[];
  /** Limit to this location and its sub-locations. */
  locationId?: string | null;
  lotId?: string | null;
  serialId?: string | null;
  /** Also limit to this location and its sub-locations (a reservation's own location limit). */
  within?: string | null;
  /** The channel's allocation rule: warehouses or locations in order; null takes every one. */
  ruleScopes: string[] | null;
  /** The caller's location scope. */
  scope: string[] | null;
  exclude?: string[];
  /** Only these positions. */
  only?: string[] | null;
  /**
   * Also lock empty positions, so a reservation that may record a shortage waits for a receipt
   * already in progress there instead of missing its units (D6).
   */
  includeEmpty?: boolean;
}

/**
 * Locks every position that could give sellable stock for the spec, in id order (step 1 of the
 * lock order). Availability itself is computed afterwards with `stock_positions`.
 */
export async function lockCandidates(tx: Tx, spec: CandidateSpec, lock = true): Promise<string[]> {
  const rows = await tx.query<{ id: string }>(
    `select p.id
     from inventory_positions p
     join locations l on l.shop_id = p.shop_id and l.id = p.location_id
     where p.variant_id = any($1::uuid[]) and p.condition = 'sellable' and p.transfer_id is null
       and (p.on_hand > 0 or $9) and l.kind = 'storage' and l.status = 'active'
       and not (l.path_ids && (select fulfillment_ineligible_ids()))
       and ($2::uuid is null or l.path_ids @> array[$2::uuid])
       and ($3::uuid[] is null or l.path_ids && $3::uuid[])
       and ($4::uuid is null or p.lot_id = $4)
       and ($5::uuid is null or p.serial_id = $5)
       and ($6::uuid[] is null or l.path_ids && $6::uuid[])
       and not (p.id = any($7::uuid[]))
       and ($8::uuid[] is null or p.id = any($8::uuid[]))
       and ($10::uuid is null or l.path_ids @> array[$10::uuid])
     order by p.id${lock ? ' for update of p' : ''}`,
    [
      spec.variantIds,
      spec.locationId ?? null,
      spec.scope,
      spec.lotId ?? null,
      spec.serialId ?? null,
      spec.ruleScopes,
      spec.exclude ?? [],
      spec.only ?? null,
      spec.includeEmpty ?? false,
      spec.within ?? null,
    ],
  );
  return rows.map((r) => r.id);
}

/** Locks reservations in id order (step 2). Returns the ids found. */
export async function lockReservations(tx: Tx, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx.query<{ id: string }>(
    'select id from reservations where id = any($1::uuid[]) order by id for update',
    [[...new Set(ids)]],
  );
  return rows.map((r) => r.id);
}

// Lazy expiry (ADR 0006) --------------------------------------------------------------------

/**
 * Releases allocations on the given (already locked) positions whose reservation has expired, so
 * expiry never depends on the sweeper running on time (PRD 6.3). The expired reservations, and
 * any in `alsoLock`, are locked together in id order. Returns the audit events for reservations
 * that changed; a bundle header closes with its last component.
 */
export async function expireClaimsAt(
  ctx: HandlerContext,
  positionIds: string[],
  alsoLock: string[] = [],
): Promise<AuditEvent[]> {
  if (positionIds.length === 0 && alsoLock.length === 0) return [];
  const due = await ctx.tx.query<{ id: string; parent_id: string | null }>(
    `select r.id, r.parent_id from reservations r
     where r.shop_id = app_shop_id() and r.status in ('active', 'partially_fulfilled')
       and r.expires_at <= now()
       and exists (select 1 from reservation_allocations a
         where a.shop_id = r.shop_id and a.reservation_id = r.id and a.position_id = any($1::uuid[])
           and a.outstanding > 0)`,
    [positionIds],
  );
  const parents = due.map((d) => d.parent_id).filter((p): p is string => p !== null);
  await lockReservations(ctx.tx, [...due.map((d) => d.id), ...parents, ...alsoLock]);
  if (due.length === 0) return [];
  const released = await ctx.tx.query<{
    reservation_id: string;
    position_id: string;
    location_id: string;
    outstanding: string;
  }>(
    `with expired as (
       select a.id, a.position_id, a.reservation_id, a.outstanding
       from reservation_allocations a
       where a.shop_id = app_shop_id() and a.position_id = any($1::uuid[])
         and a.reservation_id = any($2::uuid[]) and a.outstanding > 0),
     alloc as (
       update reservation_allocations a set released = a.released + e.outstanding
       from expired e where a.shop_id = app_shop_id() and a.id = e.id),
     pos as (
       update inventory_positions p
       set allocated = p.allocated - s.total, version = p.version + 1, updated_at = now()
       from (select position_id, sum(outstanding) as total from expired group by position_id) s
       where p.shop_id = app_shop_id() and p.id = s.position_id)
     select e.reservation_id, e.position_id, p.location_id, e.outstanding::text
     from expired e join inventory_positions p on p.shop_id = app_shop_id() and p.id = e.position_id`,
    [positionIds, due.map((d) => d.id)],
  );
  if (released.length === 0) return [];
  const reservationIds = [...new Set(released.map((r) => r.reservation_id))];
  // An expired reservation's shortage is released with it (connector reservations never expire).
  await ctx.tx.query(
    `update reservations set shortage_released = shortage_released + shortage_quantity,
       shortage_quantity = 0
     where id = any($1::uuid[]) and shortage_quantity > 0`,
    [reservationIds],
  );
  const statuses = await refreshStatuses(ctx.tx, reservationIds, 'expired');
  const operationId = ctx.newId();
  await ctx.tx.query(
    `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id)
     values (app_shop_id(), $1, 'expiry', 'system', 'reservation-expiry', $2, $3)`,
    [operationId, ctx.caller.source, ctx.attemptId],
  );
  return reservationIds.map((id) =>
    ctx.event({
      action: 'inventory.reservation.expired',
      outcome: 'succeeded',
      actor_type: 'system',
      actor_id: 'reservation-expiry',
      target_type: 'reservation',
      target_id: id,
      operation_id: operationId,
      // The locations of the released claims, so location scopes apply to the event.
      location_ids: [
        ...new Set(released.filter((r) => r.reservation_id === id).map((r) => r.location_id)),
      ],
      changes: {
        released: released
          .filter((r) => r.reservation_id === id)
          .map((r) => ({ positionId: r.position_id, quantity: r.outstanding })),
        status: statuses.get(id) === 'expired' ? 'expired' : 'partially_released',
      },
      context: { trigger: 'command' },
    }),
  );
}

// Reservation state ---------------------------------------------------------------------------

/**
 * Recomputes the status of the given reservations from what is still outstanding, then of their
 * bundle headers. `closedAs` names how a reservation that closes now ends; otherwise it is
 * fulfilled when anything was fulfilled, else released.
 */
export async function refreshStatuses(
  tx: Tx,
  ids: string[],
  closedAs: 'expired' | null = null,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.query<{ id: string; status: string; parent_id: string | null }>(
    `with o as (
       select r.id, r.shortage_quantity + coalesce(sum(a.outstanding), 0) as open,
         coalesce(sum(a.fulfilled), 0) as fulfilled
       from reservations r
       left join reservation_allocations a on a.shop_id = r.shop_id and a.reservation_id = r.id
       where r.id = any($1::uuid[]) and r.status in ('active', 'partially_fulfilled')
       group by r.id, r.shortage_quantity)
     update reservations r set
       status = case
         when o.open > 0 then case when o.fulfilled > 0 then 'partially_fulfilled' else 'active' end
         when $2::text is not null then $2::text
         when o.fulfilled > 0 then 'fulfilled'
         else 'released' end,
       updated_at = now(), version = r.version + 1
     from o where r.shop_id = app_shop_id() and r.id = o.id
     returning r.id, r.status, r.parent_id`,
    [ids, closedAs],
  );
  const out = new Map(rows.map((r) => [r.id, r.status]));
  const parents = [...new Set(rows.map((r) => r.parent_id).filter((p): p is string => !!p))];
  if (parents.length > 0) {
    const headers = await tx.query<{ id: string; status: string }>(
      `with c as (
         select c.parent_id as id,
           bool_or(c.status in ('active', 'partially_fulfilled')) as open,
           bool_or(c.status in ('partially_fulfilled', 'fulfilled')) as fulfilled,
           bool_or(c.status = 'expired') as expired
         from reservations c where c.parent_id = any($1::uuid[]) group by c.parent_id)
       update reservations p set
         status = case
           when c.open then case when c.fulfilled then 'partially_fulfilled' else 'active' end
           when c.expired then 'expired'
           when c.fulfilled then 'fulfilled'
           else 'released' end,
         updated_at = now(), version = p.version + 1
       from c where p.shop_id = app_shop_id() and p.id = c.id
       returning p.id, p.status`,
      [parents],
    );
    for (const h of headers) out.set(h.id, h.status);
  }
  return out;
}

// Allocation (D3) ---------------------------------------------------------------------------

/** The ordered warehouses and locations of a channel's allocation rule, or null for "all". */
export async function loadRuleScopes(tx: Tx, channel: string): Promise<string[] | null> {
  const rows = await tx.query<{ scope_id: string }>(
    `select l.scope_id from allocation_rules r
     join allocation_rule_locations l on l.shop_id = r.shop_id and l.rule_id = r.id
     where r.channel = $1 order by l.position`,
    [channel],
  );
  return rows.length > 0 ? rows.map((r) => r.scope_id) : null;
}

export interface Pick {
  variantId: string;
  positionId: string;
  locationId: string;
  lotId: string | null;
  serialId: string | null;
  quantity: string;
}

/**
 * Chooses positions for each need among locked candidates, in the allocation rule's order: the
 * rule's warehouses and locations in order, then earliest lot expiry, then oldest stock, then
 * location path and position id (D3). Picks are greedy and exact; `available` is per variant.
 */
export async function choosePositions(
  tx: Tx,
  needs: Array<{ variantId: string; quantity: string }>,
  positionIds: string[],
  ruleScopes: string[] | null,
): Promise<{ picks: Pick[]; available: Map<string, string> }> {
  if (needs.length === 0) return { picks: [], available: new Map() };
  const [row] = await tx.query<{
    picks: Array<{
      variantId: string;
      positionId: string;
      locationId: string;
      lotId: string | null;
      serialId: string | null;
      quantity: string;
    }>;
    available: Array<{ variantId: string; available: string }>;
  }>(
    `with need as (
       select * from jsonb_to_recordset($1::jsonb) as x("variantId" uuid, quantity numeric)),
     cand as (
       select sp.*, row_number() over (partition by sp.variant_id order by
           (select min(r.i) from unnest($3::uuid[]) with ordinality as r(id, i)
             where r.id = any(sp.path_ids)) nulls last,
           sp.expires_on nulls last, sp.received_at nulls last, sp.location_path, sp.position_id) as rn
       from stock_positions(array(select "variantId" from need)) sp
       where sp.position_id = any($2::uuid[]) and sp.available > 0),
     cum as (
       select c.*, n.quantity as wanted,
         sum(c.available) over (partition by c.variant_id order by c.rn) as running
       from cand c join need n on n."variantId" = c.variant_id),
     picks as (
       select variant_id, position_id, location_id, lot_id, serial_id, rn,
         least(available, wanted - (running - available)) as take
       from cum where running - available < wanted)
     select
       coalesce((select json_agg(json_build_object('variantId', variant_id, 'positionId', position_id,
         'locationId', location_id, 'lotId', lot_id, 'serialId', serial_id, 'quantity', take::text)
         order by variant_id, rn) from picks), '[]'::json) as picks,
       coalesce((select json_agg(json_build_object('variantId', n."variantId",
         'available', coalesce((select sum(c.available) from cand c where c.variant_id = n."variantId"), 0)::text))
         from need n), '[]'::json) as available`,
    [JSON.stringify(needs), positionIds, ruleScopes],
  );
  return {
    picks: row?.picks ?? [],
    available: new Map((row?.available ?? []).map((a) => [a.variantId, a.available])),
  };
}

export function sumQuantities(values: string[]): string {
  return values.reduce((total, v) => add(total, v), '0');
}

/** What the picks did not cover for a need, or '0'. */
export function shortfall(wanted: string, picks: Pick[], variantId: string): string {
  const got = sumQuantities(picks.filter((p) => p.variantId === variantId).map((p) => p.quantity));
  const rest = subtract(wanted, got);
  return compare(rest, '0') > 0 ? normalize(rest) : '0';
}

/** Writes allocations for picks and raises the positions' allocated totals in one statement. */
export async function allocate(
  ctx: HandlerContext,
  reservationByVariant: Map<string, string>,
  picks: Pick[],
  sourceAllocationId: string | null = null,
): Promise<Array<Pick & { allocationId: string; reservationId: string }>> {
  const rows = picks.map((p) => ({
    ...p,
    allocationId: ctx.newId(),
    reservationId: reservationByVariant.get(p.variantId)!,
  }));
  if (rows.length === 0) return [];
  await ctx.tx.query(
    `with picks as (
       select * from jsonb_to_recordset($1::jsonb)
         as x("allocationId" uuid, "reservationId" uuid, "positionId" uuid, quantity numeric)),
     alloc as (
       insert into reservation_allocations (shop_id, id, reservation_id, position_id, quantity,
         source_allocation_id)
       select app_shop_id(), "allocationId", "reservationId", "positionId", quantity, $2 from picks)
     update inventory_positions p
     set allocated = p.allocated + s.quantity, version = p.version + 1, updated_at = now()
     from (select "positionId", sum(quantity) as quantity from picks group by "positionId") s
     where p.shop_id = app_shop_id() and p.id = s."positionId"`,
    [JSON.stringify(rows), sourceAllocationId],
  );
  return rows;
}

// Costs (D7) --------------------------------------------------------------------------------

/**
 * Applies a stock change to the variant's owned quantity and moving average through the shared
 * SQL function, which locks the variant's cost row (step 3 of the lock order). Returns the unit
 * cost the entries record.
 */
export async function applyStockCost(
  ctx: HandlerContext,
  variantId: string,
  operationId: string,
  kind: 'receipt' | 'fulfillment' | 'adjustment' | 'transfer' | 'return' | 'count',
  delta: string,
  unitCost: string | null,
): Promise<{
  unitCost: string | null;
  costBasis: string;
  averageAfter: string | null;
  quantityAfter: string;
}> {
  const [row] = await ctx.tx.query<{
    unit_cost: string | null;
    cost_basis: string;
    average_after: string | null;
    quantity_after: string;
  }>(
    `select unit_cost::text, cost_basis, average_after::text, quantity_after::text
     from apply_stock_cost($1, $2, $3, $4, $5::numeric, $6::numeric)`,
    [ctx.newId(), variantId, operationId, kind, delta, unitCost],
  );
  if (!row) throw errors.internal();
  return {
    unitCost: row.unit_cost,
    costBasis: row.cost_basis,
    averageAfter: row.average_after,
    quantityAfter: row.quantity_after,
  };
}

/** a × b exactly (up to 12 places), for pack and bundle conversions. */
export function exactProduct(a: string, b: string): string {
  return multiply(a, b, 12);
}
