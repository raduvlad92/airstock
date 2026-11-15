import type { Tx } from '@airstock/db';
import { z } from 'zod';
import type { AuditEvent } from '../audit.ts';
import { decimalScale, NonNegativeDecimal, PositiveDecimal } from '../decimal.ts';
import { AppError, errors } from '../errors.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id, iso } from '../schemas.ts';

// Stock arithmetic happens in PostgreSQL numeric; quantities cross into TypeScript only as
// strings. See packages/db/migrations/0002_inventory.sql for the lock order.

const Condition = z.enum(['sellable', 'quarantine', 'damaged']);

interface VariantRow {
  quantity_scale: number;
  status: string;
  tracking_mode: string;
}

async function loadStockableVariant(
  tx: Tx,
  variantId: string,
  quantity: string,
): Promise<VariantRow> {
  const [variant] = await tx.query<VariantRow>(
    'select quantity_scale, status, tracking_mode from variants where id = $1',
    [variantId],
  );
  if (!variant) throw errors.notFound('Variant');
  if (variant.status !== 'active')
    throw errors.conflict('variant_archived', 'The variant is archived.');
  if (variant.tracking_mode !== 'none') {
    throw errors.unprocessable(
      'tracking_not_supported_yet',
      'Lot and serial tracked variants arrive in Phase 2.',
    );
  }
  if (decimalScale(quantity) > variant.quantity_scale) {
    throw errors.unprocessable(
      'quantity_precision',
      `This variant allows ${variant.quantity_scale} decimal places in quantities.`,
    );
  }
  return variant;
}

function actorColumns(ctx: HandlerContext) {
  return [ctx.caller.kind, ctx.caller.id, ctx.caller.source, ctx.attemptId] as const;
}

/**
 * Releases allocations on the given (already locked) positions whose reservation has
 * expired, so expiry never depends on the sweeper running on time (PRD 6.3).
 * Allocations at a position only change while that position is locked, so no further
 * locking is needed here. Returns the audit events for reservations that became expired.
 */
export async function expireAllocationsAt(
  ctx: HandlerContext,
  positionIds: string[],
): Promise<AuditEvent[]> {
  if (positionIds.length === 0) return [];
  const released = await ctx.tx.query<{
    reservation_id: string;
    position_id: string;
    outstanding: string;
  }>(
    `with expired as (
       select a.id, a.position_id, a.reservation_id, a.quantity - a.released - a.fulfilled as outstanding
       from reservation_allocations a
       join reservations r on r.shop_id = a.shop_id and r.id = a.reservation_id
       where a.shop_id = app_shop_id() and a.position_id = any($1::uuid[])
         and r.status in ('active', 'partially_fulfilled') and r.expires_at <= now()
         and a.released + a.fulfilled < a.quantity),
     alloc as (
       update reservation_allocations a set released = a.released + e.outstanding
       from expired e where a.shop_id = app_shop_id() and a.id = e.id),
     pos as (
       update inventory_positions p
       set allocated = p.allocated - s.total, version = p.version + 1, updated_at = now()
       from (select position_id, sum(outstanding) as total from expired group by position_id) s
       where p.shop_id = app_shop_id() and p.id = s.position_id)
     select reservation_id, position_id, outstanding::text from expired`,
    [positionIds],
  );
  if (released.length === 0) return [];
  const reservationIds = [...new Set(released.map((r) => r.reservation_id))];
  // Reservations are locked after positions, following the documented lock order.
  const closed = await ctx.tx.query<{ id: string }>(
    `update reservations r set status = 'expired', updated_at = now(), version = r.version + 1
     where r.shop_id = app_shop_id() and r.id = any($1::uuid[])
       and r.status in ('active', 'partially_fulfilled')
       and not exists (
         select 1 from reservation_allocations a
         where a.shop_id = r.shop_id and a.reservation_id = r.id and a.released + a.fulfilled < a.quantity)
     returning r.id`,
    [reservationIds],
  );
  const operationId = ctx.newId();
  await ctx.tx.query(
    `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id)
     values (app_shop_id(), $1, 'expiry', 'system', 'reservation-expiry', $2, $3)`,
    [operationId, ctx.caller.source, ctx.attemptId],
  );
  const closedIds = new Set(closed.map((c) => c.id));
  return reservationIds.map((id) =>
    ctx.event({
      action: 'inventory.reservation.expired',
      outcome: 'succeeded',
      actor_type: 'system',
      actor_id: 'reservation-expiry',
      target_type: 'reservation',
      target_id: id,
      operation_id: operationId,
      changes: {
        released: released
          .filter((r) => r.reservation_id === id)
          .map((r) => ({ positionId: r.position_id, quantity: r.outstanding })),
        status: closedIds.has(id) ? 'expired' : 'partially_released',
      },
      context: { trigger: 'command' },
    }),
  );
}

const PositionSnapshot = z.object({
  positionId: Id,
  variantId: Id,
  locationId: Id,
  condition: Condition,
  onHand: z.string(),
  allocated: z.string(),
});

export const receiveStock = defineOperation({
  id: 'inventory.receipts.create',
  summary: 'Receive stock into a location',
  description:
    'Adds units of a variant to a leaf location in a condition. Also used for opening stock. The quantity is in the variant base unit.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    variantId: Id,
    locationId: Id,
    quantity: PositiveDecimal,
    condition: Condition.default('sellable'),
    unitCost: NonNegativeDecimal.optional(),
    reference: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Supplier or inbound reference.'),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  output: z.object({ operationId: Id, position: PositionSnapshot }),
  permission: 'inventory.receive',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.receipt.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/receipts', status: 201 },
  mcp: { tool: 'receive_stock', readOnly: false, destructive: false },
  locations: (input) => [input.locationId],
  async handler(ctx, input) {
    await loadStockableVariant(ctx.tx, input.variantId, input.quantity);
    // The share lock waits for an archive or move of this location to finish, and holds off
    // one that starts later, so neither can pass its no-stock check while stock arrives.
    const [location] = await ctx.tx.query<{ status: string; has_children: boolean }>(
      `select l.status, exists (select 1 from locations c where c.shop_id = l.shop_id and c.parent_id = l.id) as has_children
       from locations l where l.id = $1 for share`,
      [input.locationId],
    );
    if (!location) throw errors.notFound('Location');
    if (location.status !== 'active')
      throw errors.conflict('location_archived', 'The location is archived.');
    if (location.has_children) {
      throw errors.unprocessable(
        'location_not_leaf',
        'Stock is held only at locations without sub-locations.',
      );
    }
    const operationId = ctx.newId();
    const [position] = await ctx.tx.query<{ id: string; on_hand: string; allocated: string }>(
      `with op as (
         insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
           external_ref, reason)
         values (app_shop_id(), $1, 'receipt', $2, $3, $4, $5, $6, $7)),
       pos as (
         insert into inventory_positions (shop_id, id, variant_id, location_id, condition, on_hand)
         values (app_shop_id(), $8, $9, $10, $11, $12::numeric)
         on conflict on constraint inventory_positions_identity
         do update set on_hand = inventory_positions.on_hand + excluded.on_hand,
           version = inventory_positions.version + 1, updated_at = now()
         returning id, on_hand, allocated),
       entry as (
         insert into inventory_entries (shop_id, id, operation_id, position_id, variant_id, location_id,
           delta, unit_cost)
         select app_shop_id(), $13, $1, pos.id, $9, $10, $12::numeric, $14::numeric from pos)
       select id, on_hand::text, allocated::text from pos`,
      [
        operationId,
        ...actorColumns(ctx),
        input.reference ?? null,
        input.reason ?? null,
        ctx.newId(),
        input.variantId,
        input.locationId,
        input.condition,
        input.quantity,
        ctx.newId(),
        input.unitCost ?? null,
      ],
    );
    if (!position) throw errors.internal();
    return {
      result: {
        operationId,
        position: {
          positionId: position.id,
          variantId: input.variantId,
          locationId: input.locationId,
          condition: input.condition,
          onHand: position.on_hand,
          allocated: position.allocated,
        },
      },
      audit: {
        targetType: 'variant',
        targetId: input.variantId,
        operationId,
        locationIds: [input.locationId],
        externalRef: input.reference ?? null,
        reason: input.reason ?? null,
        changes: {
          positionId: position.id,
          condition: input.condition,
          quantity: input.quantity,
          unitCost: input.unitCost ?? null,
          onHandAfter: position.on_hand,
        },
      },
      outbox:
        input.condition === 'sellable'
          ? [
              {
                topic: 'inventory.availability_changed',
                payload: { variantId: input.variantId, locationIds: [input.locationId] },
              },
            ]
          : [],
    };
  },
});

const Allocation = z.object({ positionId: Id, locationId: Id, quantity: z.string() });

export const reserveStock = defineOperation({
  id: 'inventory.reservations.create',
  summary: 'Reserve sellable stock',
  description:
    'Claims sellable units for an order or other purpose without moving them. Without a location, stock is allocated across fulfillment-eligible locations in location path order. Fails if not enough is available; nothing is partly reserved.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    variantId: Id,
    quantity: PositiveDecimal,
    locationId: Id.optional(),
    purpose: z.enum(['manual', 'external_order']).default('manual'),
    externalRef: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('For example an external order and line ID.'),
    expiresInSeconds: z
      .number()
      .int()
      .min(60)
      .max(60 * 60 * 24 * 90)
      .optional()
      .describe('Release automatically after this many seconds.'),
  }),
  output: z.object({
    reservationId: Id,
    operationId: Id,
    variantId: Id,
    quantity: z.string(),
    status: z.literal('active'),
    expiresAt: z.string().nullable(),
    allocations: z.array(Allocation),
  }),
  permission: 'inventory.reserve',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.reservation.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/reservations', status: 201 },
  mcp: { tool: 'reserve_stock', action: 'reserve', readOnly: false, destructive: false },
  locations: (input) => (input.locationId ? [input.locationId] : []),
  async handler(ctx, input) {
    await loadStockableVariant(ctx.tx, input.variantId, input.quantity);

    // 1. Lock every candidate position in id order.
    const candidates = await ctx.tx.query<{ id: string; location_id: string }>(
      `select p.id, p.location_id
       from inventory_positions p
       join locations l on l.shop_id = p.shop_id and l.id = p.location_id
       where p.variant_id = $1 and p.condition = 'sellable' and l.status = 'active'
         and location_fulfillment_eligible(l.shop_id, l.path_ids)
         and ($2::uuid is null or p.location_id = $2)
         and ($3::uuid[] is null or l.path_ids && $3::uuid[])
       order by p.id
       for update of p`,
      [input.variantId, input.locationId ?? null, ctx.locationScope],
    );
    const positionIds = candidates.map((c) => c.id);

    // 2. Expired claims on those positions stop counting now, not when the sweeper runs.
    const expiryEvents = await expireAllocationsAt(ctx, positionIds);

    // 3. Pick positions greedily in location path order.
    const [pick] = await ctx.tx.query<{
      total_available: string;
      enough: boolean;
      picks: Array<{ positionId: string; locationId: string; quantity: string }>;
    }>(
      `with cand as (
         select p.id, p.location_id, p.on_hand - p.allocated as available,
           row_number() over (order by l.path, p.id) as rn
         from inventory_positions p
         join locations l on l.shop_id = p.shop_id and l.id = p.location_id
         where p.shop_id = app_shop_id() and p.id = any($1::uuid[]) and p.on_hand > p.allocated),
       cum as (select *, sum(available) over (order by rn) as running from cand),
       picks as (
         select id, location_id, least(available, $2::numeric - (running - available)) as take, rn
         from cum where running - available < $2::numeric)
       select coalesce((select sum(available) from cand), 0)::text as total_available,
         coalesce((select sum(take) from picks), 0) >= $2::numeric as enough,
         coalesce((select json_agg(json_build_object('positionId', id, 'locationId', location_id,
           'quantity', take::text) order by rn) from picks), '[]'::json) as picks`,
      [positionIds, input.quantity],
    );
    if (!pick?.enough) {
      throw new AppError(
        409,
        'insufficient_stock',
        'Not enough sellable stock is available.',
        'conflict',
        {
          requested: input.quantity,
          available: pick?.total_available ?? '0',
        },
      );
    }

    // 4. Record the reservation, its allocations, and the position totals in one statement.
    const operationId = ctx.newId();
    const reservationId = ctx.newId();
    const allocations = pick.picks.map((p) => ({ ...p, id: ctx.newId() }));
    const [created] = await ctx.tx.query<{ expires_at: Date | null }>(
      `with op as (
         insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
           external_ref)
         values (app_shop_id(), $1, 'reservation', $2, $3, $4, $5, $6)),
       res as (
         insert into reservations (shop_id, id, variant_id, quantity, purpose, external_ref, expires_at,
           created_operation_id)
         values (app_shop_id(), $7, $8, $9::numeric, $10, $6,
           case when $11::integer is null then null else now() + make_interval(secs => $11::integer) end, $1)
         returning expires_at),
       picks as (
         select * from jsonb_to_recordset($12::jsonb) as x(id uuid, "positionId" uuid, quantity numeric)),
       alloc as (
         insert into reservation_allocations (shop_id, id, reservation_id, position_id, quantity)
         select app_shop_id(), id, $7, "positionId", quantity from picks),
       pos as (
         update inventory_positions p
         set allocated = p.allocated + x.quantity, version = p.version + 1, updated_at = now()
         from picks x where p.shop_id = app_shop_id() and p.id = x."positionId")
       select expires_at from res`,
      [
        operationId,
        ...actorColumns(ctx),
        input.externalRef ?? null,
        reservationId,
        input.variantId,
        input.quantity,
        input.purpose,
        input.expiresInSeconds ?? null,
        JSON.stringify(allocations),
      ],
    );
    const locationIds = [...new Set(allocations.map((a) => a.locationId))];
    const resultAllocations = allocations.map(({ positionId, locationId, quantity }) => ({
      positionId,
      locationId,
      quantity,
    }));
    return {
      result: {
        reservationId,
        operationId,
        variantId: input.variantId,
        quantity: input.quantity,
        status: 'active' as const,
        expiresAt: iso(created?.expires_at ?? null),
        allocations: resultAllocations,
      },
      audit: {
        targetType: 'reservation',
        targetId: reservationId,
        operationId,
        locationIds,
        externalRef: input.externalRef ?? null,
        changes: {
          variantId: input.variantId,
          quantity: input.quantity,
          purpose: input.purpose,
          allocations: resultAllocations,
          expiresAt: iso(created?.expires_at ?? null),
        },
      },
      outbox: [
        {
          topic: 'inventory.availability_changed',
          payload: { variantId: input.variantId, locationIds },
        },
      ],
      events: expiryEvents,
    };
  },
});

export const releaseReservation = defineOperation({
  id: 'inventory.reservations.release',
  summary: 'Release a reservation, fully or partly',
  description:
    'Returns reserved units to availability without moving stock. Without a quantity, everything still reserved is released.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    reservationId: Id,
    quantity: PositiveDecimal.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  output: z.object({
    reservationId: Id,
    operationId: Id,
    released: z.string(),
    status: z.string(),
  }),
  permission: 'inventory.reserve',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.reservation.released' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/reservations/{reservationId}/release' },
  mcp: { tool: 'reserve_stock', action: 'release', readOnly: false, destructive: false },
  locations: async (input, tx) =>
    (
      await tx.query<{ location_id: string }>(
        `select distinct p.location_id from reservation_allocations a
         join inventory_positions p on p.shop_id = a.shop_id and p.id = a.position_id
         where a.reservation_id = $1`,
        [input.reservationId],
      )
    ).map((r) => r.location_id),
  async handler(ctx, input) {
    const positions = await ctx.tx.query<{ position_id: string }>(
      'select distinct position_id from reservation_allocations where reservation_id = $1',
      [input.reservationId],
    );
    // Lock order: positions (by id), then the reservation.
    await ctx.tx.query(
      'select id from inventory_positions where id = any($1::uuid[]) order by id for update',
      [positions.map((p) => p.position_id)],
    );
    const [reservation] = await ctx.tx.query<{
      status: string;
      expired: boolean;
      variant_id: string;
    }>(
      `select status, variant_id, (expires_at is not null and expires_at <= now()) as expired
       from reservations where id = $1 for update`,
      [input.reservationId],
    );
    if (!reservation) throw errors.notFound('Reservation');
    if (reservation.status !== 'active' && reservation.status !== 'partially_fulfilled') {
      throw errors.conflict('reservation_not_open', `The reservation is ${reservation.status}.`, {
        status: reservation.status,
      });
    }
    if (reservation.expired) {
      throw errors.conflict(
        'reservation_expired',
        'The reservation has expired; its units are already available.',
      );
    }
    const [open] = await ctx.tx.query<{ outstanding: string; covers: boolean }>(
      `select coalesce(sum(quantity - released - fulfilled), 0)::text as outstanding,
         coalesce(sum(quantity - released - fulfilled), 0) >= coalesce($2::numeric, 0) as covers
       from reservation_allocations where reservation_id = $1 and released + fulfilled < quantity`,
      [input.reservationId, input.quantity ?? null],
    );
    if (!open?.covers) {
      throw errors.unprocessable(
        'quantity_exceeds_reserved',
        'The quantity is more than is still reserved.',
        {
          outstanding: open?.outstanding ?? '0',
        },
      );
    }
    const quantity = input.quantity ?? open.outstanding;
    const operationId = ctx.newId();
    const released = await ctx.tx.query<{ position_id: string; location_id: string; take: string }>(
      `with open as (
         select a.id, a.position_id, a.quantity - a.released - a.fulfilled as outstanding,
           sum(a.quantity - a.released - a.fulfilled) over (order by a.id desc) as running
         from reservation_allocations a
         where a.shop_id = app_shop_id() and a.reservation_id = $1 and a.released + a.fulfilled < a.quantity),
       picks as (
         select id, position_id, least(outstanding, $2::numeric - (running - outstanding)) as take
         from open where running - outstanding < $2::numeric),
       alloc as (
         update reservation_allocations a set released = a.released + p.take
         from picks p where a.shop_id = app_shop_id() and a.id = p.id),
       pos as (
         update inventory_positions x
         set allocated = x.allocated - s.take, version = x.version + 1, updated_at = now()
         from (select position_id, sum(take) as take from picks group by position_id) s
         where x.shop_id = app_shop_id() and x.id = s.position_id
         returning x.id, x.location_id),
       op as (
         insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id, reason)
         values (app_shop_id(), $3, 'release', $4, $5, $6, $7, $8))
       select p.position_id, pos.location_id, p.take::text from picks p join pos on pos.id = p.position_id`,
      [input.reservationId, quantity, operationId, ...actorColumns(ctx), input.reason ?? null],
    );
    const [status] = await ctx.tx.query<{ status: string }>(
      `update reservations r set
         status = case when exists (
             select 1 from reservation_allocations a
             where a.shop_id = r.shop_id and a.reservation_id = r.id
               and a.released + a.fulfilled < a.quantity) then r.status
           when exists (
             select 1 from reservation_allocations a
             where a.shop_id = r.shop_id and a.reservation_id = r.id and a.fulfilled > 0) then 'fulfilled'
           else 'released' end,
         updated_at = now(), version = r.version + 1
       where r.id = $1 returning status`,
      [input.reservationId],
    );
    const locationIds = [...new Set(released.map((r) => r.location_id))];
    return {
      result: {
        reservationId: input.reservationId,
        operationId,
        released: quantity,
        status: status?.status ?? 'unknown',
      },
      audit: {
        targetType: 'reservation',
        targetId: input.reservationId,
        operationId,
        locationIds,
        reason: input.reason ?? null,
        changes: {
          released: released.map((r) => ({ positionId: r.position_id, quantity: r.take })),
          status: status?.status,
        },
      },
      outbox: [
        {
          topic: 'inventory.availability_changed',
          payload: { variantId: reservation.variant_id, locationIds },
        },
      ],
    };
  },
});

export const getAvailability = defineOperation({
  id: 'inventory.availability.get',
  summary: 'Get stock and availability for a variant',
  description:
    'Shows on-hand, reserved, and available quantities per location and condition, with totals. Totals cover only the locations you can access; `partial` says when that is a subset.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ variantId: Id, locationId: Id.optional() }),
  output: z.object({
    variantId: Id,
    sku: z.string(),
    partial: z.boolean(),
    totals: z.object({
      onHand: z.string(),
      sellableOnHand: z.string(),
      reserved: z.string(),
      available: z.string(),
      quarantined: z.string(),
      damaged: z.string(),
    }),
    positions: z.array(
      z.object({
        positionId: Id,
        locationId: Id,
        locationPath: z.string(),
        warehouseId: Id,
        condition: Condition,
        onHand: z.string(),
        reserved: z.string(),
        available: z.string(),
      }),
    ),
  }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'inventory.availability.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/availability' },
  mcp: { tool: 'get_availability', readOnly: true, destructive: false },
  locations: (input) => (input.locationId ? [input.locationId] : []),
  async handler(ctx, input) {
    const [variant] = await ctx.tx.query<{ sku: string }>(
      'select sku from variants where id = $1',
      [input.variantId],
    );
    if (!variant) throw errors.notFound('Variant');
    const [view] = await ctx.tx.query<{
      totals: {
        onHand: string;
        sellableOnHand: string;
        reserved: string;
        available: string;
        quarantined: string;
        damaged: string;
      };
      positions: Array<{
        positionId: string;
        locationId: string;
        locationPath: string;
        warehouseId: string;
        condition: 'sellable' | 'quarantine' | 'damaged';
        onHand: string;
        reserved: string;
        available: string;
      }>;
    }>(
      `with rows as (
         select p.id, p.location_id, l.path, l.warehouse_id, p.condition, p.on_hand,
           p.allocated - coalesce(x.expired, 0) as reserved,
           case when p.condition = 'sellable' and l.status = 'active'
             and location_fulfillment_eligible(l.shop_id, l.path_ids)
             then p.on_hand - p.allocated + coalesce(x.expired, 0) else 0 end as available
         from inventory_positions p
         join locations l on l.shop_id = p.shop_id and l.id = p.location_id
         left join lateral (
           select sum(a.quantity - a.released - a.fulfilled) as expired
           from reservation_allocations a
           join reservations r on r.shop_id = a.shop_id and r.id = a.reservation_id
           where a.shop_id = p.shop_id and a.position_id = p.id and a.released + a.fulfilled < a.quantity
             and r.status in ('active', 'partially_fulfilled') and r.expires_at <= now()) x on true
         where p.variant_id = $1 and ($2::uuid is null or p.location_id = $2)
           and ($3::uuid[] is null or l.path_ids && $3::uuid[]))
       select
         (select json_build_object(
            'onHand', coalesce(sum(on_hand), 0)::text,
            'sellableOnHand', coalesce(sum(on_hand) filter (where condition = 'sellable'), 0)::text,
            'reserved', coalesce(sum(reserved), 0)::text,
            'available', coalesce(sum(available), 0)::text,
            'quarantined', coalesce(sum(on_hand) filter (where condition = 'quarantine'), 0)::text,
            'damaged', coalesce(sum(on_hand) filter (where condition = 'damaged'), 0)::text)
          from rows) as totals,
         coalesce((select json_agg(json_build_object(
            'positionId', id, 'locationId', location_id, 'locationPath', path,
            'warehouseId', warehouse_id, 'condition', condition, 'onHand', on_hand::text,
            'reserved', reserved::text, 'available', available::text) order by path, condition)
          from rows), '[]'::json) as positions`,
      [input.variantId, input.locationId ?? null, ctx.locationScope],
    );
    if (!view) throw errors.internal();
    return {
      result: {
        variantId: input.variantId,
        sku: variant.sku,
        partial: ctx.locationScope !== null,
        totals: view.totals,
        positions: view.positions,
      },
      audit: {
        targetType: 'variant',
        targetId: input.variantId,
        locationIds: [...new Set(view.positions.map((r) => r.locationId))],
        context: { input },
      },
    };
  },
});
