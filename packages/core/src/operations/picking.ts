import type { Tx } from '@airstock/db';
import { z } from 'zod';
import type { AuditEvent } from '../audit.ts';
import { compare, divide, multiply, normalize, subtract } from '../catalog/decimal.ts';
import { PositiveDecimal } from '../decimal.ts';
import { errors } from '../errors.ts';
import { effectivePermissions } from '../permissions.ts';
import { defineOperation, type HandlerContext, type HandlerResult } from '../registry.ts';
import { Id } from '../schemas.ts';
import { assertScale, lockPositions, normalizeCode, OPEN_STATUSES } from '../stock/engine.ts';
import { DateOnly, LotCode } from './inventory.ts';
import { fulfillReservation, reallocateReservation } from './inventory-reservations.ts';
import { WAREHOUSE_TOOL } from './warehouse-scan.ts';

// Pick lists (plan 5.11, PRD 6.10, decision recorded in the picking ADR). A list is built from
// open reservations: one line per outstanding allocation, walked in location-path order. Picks
// record what was picked and never change stock. Scanning another lot or position reallocates
// through the reservation's own command first. A short pick records what was found and flags the
// line for a count. Completing the list fulfills manual and API reservations through the fulfill
// command; Shopify orders are fulfilled from Shopify, so their picks are only recorded.
//
// Lock order: a pick list's row, then its lines, are locked before anything else, like a session
// row. Stock commands never wait on pick lists or lines, so the order of ADR 0006 (positions,
// then reservations) still holds inside the reallocate and fulfill commands these call.
// Completion locks every position and reservation it will fulfill up front, in that order, so
// fulfilling line after line never takes a position or reservation out of id order.

const Reference = z.string().trim().min(1).max(200);

const LINE_ACTIVE = ['open', 'picked', 'short'] as const;

const PackCount = z.object({ packId: Id, name: z.string(), count: z.string() });

const PickLineOut = z.object({
  lineId: Id,
  sequence: z.number().int(),
  status: z
    .enum(['open', 'picked', 'short', 'moved', 'done', 'cancelled'])
    .describe(
      'open: still to pick; picked; short: flagged, some units were not found; moved: taken from another position (see the new line); done: the list was completed.',
    ),
  locationId: Id,
  locationPath: z.string(),
  variantId: Id,
  productName: z.string(),
  variantName: z.string().nullable(),
  sku: z.string(),
  quantity: z.string().describe('Base units to pick.'),
  inPacks: z
    .object({ packs: z.array(PackCount), looseUnits: z.string() })
    .describe('The quantity in the variant’s packs, largest first, and the units left over.'),
  picked: z.string(),
  short: z.string(),
  moved: z.string(),
  remaining: z.string(),
  lotId: Id.nullable(),
  lotCode: z.string().nullable(),
  expiresOn: z.string().nullable(),
  serialId: Id.nullable(),
  serial: z.string().nullable(),
  reservationId: Id.describe('The order-level reservation.'),
  allocationId: Id,
  positionId: Id,
  externalRef: z.string().nullable(),
  fulfillOnComplete: z
    .boolean()
    .describe('False for Shopify orders, which are fulfilled from Shopify.'),
});

const PickListSummary = z.object({
  pickListId: Id,
  number: z.number().int(),
  status: z.enum(['open', 'completed', 'cancelled']),
  filters: z.record(z.string(), z.unknown()),
  note: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  lines: z.number().int(),
  openLines: z.number().int(),
  shortLines: z.number().int(),
  orders: z.number().int().describe('Distinct order-level reservations.'),
  version: z.number().int(),
});

const PickListOut = PickListSummary.extend({
  partial: z.boolean().describe('True when your location access hides some lines.'),
  pickLines: z.array(PickLineOut),
});

type LineView = z.infer<typeof PickLineOut>;

interface LineRow {
  id: string;
  pick_list_id: string;
  list_status: string;
  list_number: number;
  sequence: number;
  reservation_id: string;
  root_reservation_id: string;
  allocation_id: string;
  variant_id: string;
  position_id: string;
  location_id: string;
  lot_id: string | null;
  serial_id: string | null;
  quantity: string;
  picked: string;
  short: string;
  moved: string;
  status: string;
  fulfill_on_complete: boolean;
  external_ref: string | null;
}

/** A sub-operation's audit details, recorded as its own event in the same transaction. */
function subEvent(
  ctx: HandlerContext,
  action: string,
  handled: HandlerResult<unknown>,
  via: string,
): AuditEvent {
  const a = handled.audit;
  return ctx.event({
    action,
    outcome: 'succeeded',
    target_type: a.targetType,
    target_id: a.targetId,
    operation_id: a.operationId ?? null,
    location_ids: a.locationIds ?? null,
    external_ref: a.externalRef ?? null,
    reason: a.reason ?? null,
    changes: a.changes ?? null,
    context: { via },
  });
}

function remainingOf(r: { quantity: string; picked: string; short: string; moved: string }) {
  return normalize(subtract(subtract(subtract(r.quantity, r.picked), r.short), r.moved));
}

/** The status a line has from its quantities. */
function statusOf(r: { quantity: string; picked: string; short: string; moved: string }) {
  if (compare(remainingOf(r), '0') > 0) return 'open';
  if (compare(r.short, '0') > 0) return 'short';
  if (compare(r.picked, '0') > 0) return 'picked';
  return 'moved';
}

/** A base quantity in whole packs, largest first, and the units left over. */
export function inPacks(
  quantity: string,
  packs: Array<{ packId: string; name: string; baseQuantity: string }>,
): { packs: Array<{ packId: string; name: string; count: string }>; looseUnits: string } {
  let left = normalize(quantity);
  const out: Array<{ packId: string; name: string; count: string }> = [];
  const sorted = [...packs]
    .filter((p) => compare(p.baseQuantity, '1') > 0)
    .sort((a, b) => compare(b.baseQuantity, a.baseQuantity));
  for (const p of sorted) {
    const whole = divide(left, p.baseQuantity).split('.')[0]!;
    if (compare(whole, '0') <= 0) continue;
    out.push({ packId: p.packId, name: p.name, count: whole });
    left = normalize(subtract(left, multiply(whole, p.baseQuantity)));
  }
  return { packs: out, looseUnits: left };
}

async function loadLines(
  tx: Tx,
  pickListId: string,
  scope: string[] | null,
): Promise<{ lines: LineView[]; hidden: number }> {
  const rows = await tx.query<{
    id: string;
    sequence: number;
    status: LineView['status'];
    location_id: string;
    location_path: string;
    variant_id: string;
    product_name: string;
    variant_name: string | null;
    sku: string;
    quantity: string;
    picked: string;
    short: string;
    moved: string;
    lot_id: string | null;
    lot_code: string | null;
    expires_on: string | null;
    serial_id: string | null;
    serial: string | null;
    root_reservation_id: string;
    allocation_id: string;
    position_id: string;
    external_ref: string | null;
    fulfill_on_complete: boolean;
    in_scope: boolean;
    packs: Array<{ packId: string; name: string; baseQuantity: string }>;
  }>(
    `select pl.id, pl.sequence, pl.status, pl.location_id, l.path as location_path, pl.variant_id,
       p.name as product_name, v.name as variant_name, v.sku,
       pl.quantity::text, pl.picked::text, pl.short::text, pl.moved::text,
       pl.lot_id, lt.code as lot_code, to_char(lt.expires_on, 'YYYY-MM-DD') as expires_on,
       pl.serial_id, su.serial, pl.root_reservation_id, pl.allocation_id, pl.position_id,
       pl.external_ref, pl.fulfill_on_complete,
       ($2::uuid[] is null or l.path_ids && $2::uuid[]) as in_scope,
       coalesce((select json_agg(json_build_object('packId', k.id, 'name', k.name,
           'baseQuantity', trim_scale(k.base_quantity)::text))
         from packs k where k.shop_id = pl.shop_id and k.variant_id = pl.variant_id
           and k.status = 'active'), '[]'::json) as packs
     from pick_lines pl
     join locations l on l.shop_id = pl.shop_id and l.id = pl.location_id
     join variants v on v.shop_id = pl.shop_id and v.id = pl.variant_id
     join products p on p.shop_id = v.shop_id and p.id = v.product_id
     left join lots lt on lt.shop_id = pl.shop_id and lt.id = pl.lot_id
     left join serial_units su on su.shop_id = pl.shop_id and su.id = pl.serial_id
     where pl.pick_list_id = $1
     order by pl.sequence, pl.id`,
    [pickListId, scope],
  );
  const visible = rows.filter((r) => r.in_scope);
  return {
    hidden: rows.length - visible.length,
    lines: visible.map((r) => ({
      lineId: r.id,
      sequence: r.sequence,
      status: r.status,
      locationId: r.location_id,
      locationPath: r.location_path,
      variantId: r.variant_id,
      productName: r.product_name,
      variantName: r.variant_name,
      sku: r.sku,
      quantity: normalize(r.quantity),
      inPacks: inPacks(r.quantity, r.packs),
      picked: normalize(r.picked),
      short: normalize(r.short),
      moved: normalize(r.moved),
      remaining: remainingOf(r),
      lotId: r.lot_id,
      lotCode: r.lot_code,
      expiresOn: r.expires_on,
      serialId: r.serial_id,
      serial: r.serial,
      reservationId: r.root_reservation_id,
      allocationId: r.allocation_id,
      positionId: r.position_id,
      externalRef: r.external_ref,
      fulfillOnComplete: r.fulfill_on_complete,
    })),
  };
}

async function loadList(ctx: HandlerContext, pickListId: string) {
  const [list] = await ctx.tx.query<{
    id: string;
    number: number;
    status: 'open' | 'completed' | 'cancelled';
    filters: Record<string, unknown>;
    note: string | null;
    created_at: Date;
    completed_at: Date | null;
    version: number;
  }>(
    `select id, number, status, filters, note, created_at, completed_at, version
     from pick_lists where id = $1`,
    [pickListId],
  );
  if (!list) throw errors.notFound('Pick list');
  const { lines, hidden } = await loadLines(ctx.tx, pickListId, ctx.locationScope);
  // A list whose every line is outside the caller's locations does not exist for them.
  if (lines.length === 0 && hidden > 0) throw errors.notFound('Pick list');
  return {
    pickListId: list.id,
    number: list.number,
    status: list.status,
    filters: list.filters,
    note: list.note,
    createdAt: new Date(list.created_at).toISOString(),
    completedAt: list.completed_at ? new Date(list.completed_at).toISOString() : null,
    lines: lines.length,
    openLines: lines.filter((l) => l.status === 'open').length,
    shortLines: lines.filter((l) => l.status === 'short').length,
    orders: new Set(lines.map((l) => l.reservationId)).size,
    version: list.version,
    partial: hidden > 0,
    pickLines: lines,
  };
}

async function listLocations(tx: Tx, pickListId: string, lineId?: string): Promise<string[]> {
  return (
    await tx.query<{ location_id: string }>(
      `select distinct location_id from pick_lines
       where pick_list_id = $1 and ($2::uuid is null or id = $2)`,
      [pickListId, lineId ?? null],
    )
  ).map((r) => r.location_id);
}

/**
 * Locks the list row, then the line: the first locks any picking command takes. Completing and
 * cancelling lock the list and then its lines, and a pick updates the list row too, so the list
 * row always comes first; the other way round a pick and a completion deadlock.
 */
async function lockLine(tx: Tx, pickListId: string, lineId: string): Promise<LineRow> {
  await tx.query('select 1 from pick_lists where id = $1 for update', [pickListId]);
  const [row] = await tx.query<LineRow>(
    `select pl.id, pl.pick_list_id, l.status as list_status, l.number as list_number, pl.sequence,
       pl.reservation_id, pl.root_reservation_id, pl.allocation_id, pl.variant_id, pl.position_id,
       pl.location_id, pl.lot_id, pl.serial_id, pl.quantity::text, pl.picked::text,
       pl.short::text, pl.moved::text, pl.status, pl.fulfill_on_complete, pl.external_ref
     from pick_lines pl join pick_lists l on l.shop_id = pl.shop_id and l.id = pl.pick_list_id
     where pl.id = $1 and pl.pick_list_id = $2
     for update of pl`,
    [lineId, pickListId],
  );
  if (!row) throw errors.notFound('Pick line');
  if (row.list_status !== 'open') {
    throw errors.conflict('pick_list_closed', `The pick list is ${row.list_status}.`);
  }
  return row;
}

/** The decimal places a variant allows in quantities (whole units: 0). */
async function quantityScale(tx: Tx, variantId: string): Promise<number> {
  const [v] = await tx.query<{ quantity_scale: number }>(
    'select quantity_scale from variants where id = $1',
    [variantId],
  );
  return v?.quantity_scale ?? 0;
}

async function updateLine(
  tx: Tx,
  lineId: string,
  next: { picked: string; short: string; moved: string; quantity: string },
): Promise<void> {
  await tx.query(
    `update pick_lines set picked = $2, short = $3, moved = $4, status = $5, updated_at = now(),
       version = version + 1
     where id = $1`,
    [lineId, next.picked, next.short, next.moved, statusOf(next)],
  );
}

async function touchList(tx: Tx, pickListId: string): Promise<void> {
  await tx.query('update pick_lists set updated_at = now(), version = version + 1 where id = $1', [
    pickListId,
  ]);
}

// Create ------------------------------------------------------------------------------------

export const createPickList = defineOperation({
  id: 'picking.lists.create',
  summary: 'Build a pick list from open reservations',
  description:
    'Use this when someone is about to collect orders in the warehouse. Takes the outstanding allocations of open reservations, filtered by channel, warehouse, the date the reservation was made, or orders (an external reference or its prefix, such as shopify:order/123 for every line of that order), and makes one line per allocation, sorted by location path for a short walk. Allocations already on an open list are left out. Lines outside your locations are left out. Picking never changes stock. Not for reserving stock (use manage_reservations).',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    channel: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Only reservations of this channel, such as "default".'),
    warehouseId: Id.optional().describe('Only allocations in this warehouse.'),
    createdFrom: DateOnly.optional().describe('Reserved on or after this day (shop time zone).'),
    createdTo: DateOnly.optional().describe('Reserved on or before this day (shop time zone).'),
    orders: z
      .array(Reference)
      .min(1)
      .max(200)
      .optional()
      .describe(
        'External references of orders; a reference also matches the ones that continue it after /, : or #.',
      ),
    reservationIds: z.array(Id).min(1).max(500).optional(),
    note: z.string().trim().min(1).max(500).optional(),
  }),
  output: PickListOut,
  permission: 'picking.run',
  connectionScope: 'inventory:write',
  audit: { action: 'picking.list.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/pick-lists', status: 201 },
  mcp: { tool: WAREHOUSE_TOOL, action: 'create_pick_list', readOnly: false, destructive: false },
  async handler(ctx, input) {
    if (input.warehouseId) {
      const [w] = await ctx.tx.query('select 1 from warehouses where id = $1', [input.warehouseId]);
      if (!w) throw errors.notFound('Warehouse');
    }
    // One list number at a time per shop.
    await ctx.tx.query(`select pg_advisory_xact_lock(hashtext('pick_lists:' || app_shop_id()))`);
    const candidates = await ctx.tx.query<{
      allocation_id: string;
      reservation_id: string;
      root_reservation_id: string;
      variant_id: string;
      position_id: string;
      location_id: string;
      location_path: string;
      lot_id: string | null;
      serial_id: string | null;
      outstanding: string;
      external_ref: string | null;
      from_shopify: boolean;
      sku: string;
    }>(
      `select a.id as allocation_id, r.id as reservation_id, coalesce(r.parent_id, r.id) as root_reservation_id,
         r.variant_id, a.position_id, pos.location_id, l.path as location_path, pos.lot_id,
         pos.serial_id, a.outstanding::text, root.external_ref,
         (o.source = 'shopify' or root.channel like 'shopify:%' or coalesce(root.external_ref, '') like 'shopify:%') as from_shopify,
         v.sku
       from reservation_allocations a
       join reservations r on r.shop_id = a.shop_id and r.id = a.reservation_id
       join reservations root on root.shop_id = r.shop_id and root.id = coalesce(r.parent_id, r.id)
       join inventory_operations o on o.shop_id = root.shop_id and o.id = root.created_operation_id
       join inventory_positions pos on pos.shop_id = a.shop_id and pos.id = a.position_id
       join locations l on l.shop_id = pos.shop_id and l.id = pos.location_id
       join variants v on v.shop_id = r.shop_id and v.id = r.variant_id
       join shops s on s.id = root.shop_id
       where a.outstanding > 0
         and root.status = any($1::text[]) and root.purpose in ('manual', 'external_order')
         and (root.expires_at is null or root.expires_at > now())
         and pos.transfer_id is null
         and not exists (select 1 from pick_lines pl where pl.shop_id = a.shop_id
           and pl.allocation_id = a.id and pl.status = any($2::text[]))
         and ($3::text is null or root.channel = $3)
         and ($4::uuid is null or l.warehouse_id = $4)
         and ($5::date is null or root.created_at >= ($5::date)::timestamp at time zone s.timezone)
         and ($6::date is null or root.created_at < ($6::date + 1)::timestamp at time zone s.timezone)
         and ($7::text[] is null or exists (select 1 from unnest($7::text[]) ref
           where root.external_ref = ref or left(root.external_ref, length(ref) + 1) in
             (ref || '/', ref || ':', ref || '#')))
         and ($8::uuid[] is null or root.id = any($8::uuid[]))
         and ($9::uuid[] is null or l.path_ids && $9::uuid[])
       order by l.path, v.sku, root.created_at, a.id
       limit 2001`,
      [
        OPEN_STATUSES,
        LINE_ACTIVE,
        input.channel ?? null,
        input.warehouseId ?? null,
        input.createdFrom ?? null,
        input.createdTo ?? null,
        input.orders ?? null,
        input.reservationIds ?? null,
        ctx.locationScope,
      ],
    );
    if (candidates.length === 0) {
      throw errors.unprocessable(
        'nothing_to_pick',
        'No open reservation with stock to pick matches these filters.',
      );
    }
    if (candidates.length > 2000) {
      throw errors.unprocessable(
        'pick_list_too_long',
        'More than 2,000 lines match. Narrow the filters (warehouse, dates, or orders).',
      );
    }
    const pickListId = ctx.newId();
    const filters = Object.fromEntries(
      Object.entries({
        channel: input.channel,
        warehouseId: input.warehouseId,
        createdFrom: input.createdFrom,
        createdTo: input.createdTo,
        orders: input.orders,
        reservationIds: input.reservationIds,
      }).filter(([, v]) => v !== undefined),
    );
    await ctx.tx.query(
      `insert into pick_lists (shop_id, id, number, filters, note, created_by_actor_type,
         created_by_actor_id)
       select app_shop_id(), $1, coalesce(max(number), 0) + 1, $2, $3, $4, $5
       from pick_lists`,
      [pickListId, JSON.stringify(filters), input.note ?? null, ctx.caller.kind, ctx.caller.id],
    );
    await ctx.tx.query(
      `insert into pick_lines (shop_id, id, pick_list_id, sequence, reservation_id,
         root_reservation_id, allocation_id, variant_id, position_id, location_id, location_path,
         lot_id, serial_id, external_ref, fulfill_on_complete, quantity)
       select app_shop_id(), x.id, $2, x.sequence, x.reservation_id, x.root_reservation_id,
         x.allocation_id, x.variant_id, x.position_id, x.location_id, x.location_path, x.lot_id,
         x.serial_id, x.external_ref, x.fulfill, x.quantity
       from jsonb_to_recordset($1::jsonb) as x(id uuid, sequence integer, reservation_id uuid,
         root_reservation_id uuid, allocation_id uuid, variant_id uuid, position_id uuid,
         location_id uuid, location_path text, lot_id uuid, serial_id uuid, external_ref text,
         fulfill boolean, quantity numeric)`,
      [
        JSON.stringify(
          candidates.map((c, i) => ({
            id: ctx.newId(),
            sequence: i + 1,
            reservation_id: c.reservation_id,
            root_reservation_id: c.root_reservation_id,
            allocation_id: c.allocation_id,
            variant_id: c.variant_id,
            position_id: c.position_id,
            location_id: c.location_id,
            location_path: c.location_path,
            lot_id: c.lot_id,
            serial_id: c.serial_id,
            external_ref: c.external_ref,
            fulfill: !c.from_shopify,
            quantity: c.outstanding,
          })),
        ),
        pickListId,
      ],
    );
    const list = await loadList(ctx, pickListId);
    return {
      result: list,
      audit: {
        targetType: 'pick_list',
        targetId: pickListId,
        locationIds: [...new Set(candidates.map((c) => c.location_id))].slice(0, 100),
        changes: {
          number: list.number,
          filters,
          lines: candidates.length,
          reservations: [...new Set(candidates.map((c) => c.root_reservation_id))].slice(0, 200),
        },
      },
    };
  },
});

// Reads -------------------------------------------------------------------------------------

export const listPickLists = defineOperation({
  id: 'picking.lists.list',
  summary: 'List pick lists',
  description:
    'Use this to find pick lists to work on or to check on: open ones by default, newest first, with how many lines are still open or short. Counts cover only the locations you can access.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    status: z.enum(['open', 'completed', 'cancelled', 'all']).default('open'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  }),
  output: z.object({ pickLists: z.array(PickListSummary) }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'picking.lists.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/pick-lists' },
  mcp: { tool: WAREHOUSE_TOOL, action: 'list_pick_lists', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const rows = await ctx.tx.query<{
      id: string;
      number: number;
      status: 'open' | 'completed' | 'cancelled';
      filters: Record<string, unknown>;
      note: string | null;
      created_at: Date;
      completed_at: Date | null;
      version: number;
      lines: number;
      open_lines: number;
      short_lines: number;
      orders: number;
    }>(
      `select pk.id, pk.number, pk.status, pk.filters, pk.note, pk.created_at, pk.completed_at,
         pk.version, c.lines, c.open_lines, c.short_lines, c.orders
       from pick_lists pk
       cross join lateral (
         select count(*)::int as lines,
           count(*) filter (where pl.status = 'open')::int as open_lines,
           count(*) filter (where pl.status = 'short')::int as short_lines,
           count(distinct pl.root_reservation_id)::int as orders
         from pick_lines pl join locations l on l.shop_id = pl.shop_id and l.id = pl.location_id
         where pl.pick_list_id = pk.id and ($2::uuid[] is null or l.path_ids && $2::uuid[])) c
       where ($1::text = 'all' or pk.status = $1) and c.lines > 0
       order by pk.created_at desc, pk.id desc
       limit $3`,
      [input.status, ctx.locationScope, input.limit],
    );
    return {
      result: {
        pickLists: rows.map((r) => ({
          pickListId: r.id,
          number: r.number,
          status: r.status,
          filters: r.filters,
          note: r.note,
          createdAt: new Date(r.created_at).toISOString(),
          completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
          lines: r.lines,
          openLines: r.open_lines,
          shortLines: r.short_lines,
          orders: r.orders,
          version: r.version,
        })),
      },
      audit: { targetType: 'pick_list', targetId: 'list', context: { status: input.status } },
    };
  },
});

export const getPickList = defineOperation({
  id: 'picking.lists.get',
  summary: 'Get a pick list with its lines',
  description:
    'Use this to walk or print a pick list: every line in walk order (location path) with the variant, the quantity in base units and in packs, the allocated lot or serial, the order reference, and what was picked or found short. Lines outside your locations are left out.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ pickListId: Id }),
  output: PickListOut,
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'picking.list.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/pick-lists/{pickListId}' },
  mcp: { tool: WAREHOUSE_TOOL, action: 'get_pick_list', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const list = await loadList(ctx, input.pickListId);
    return {
      result: list,
      audit: {
        targetType: 'pick_list',
        targetId: list.pickListId,
        locationIds: [...new Set(list.pickLines.map((l) => l.locationId))].slice(0, 100),
      },
    };
  },
});

// Pick --------------------------------------------------------------------------------------

const PickResult = z.object({
  pickListId: Id,
  line: PickLineOut,
  newLines: z
    .array(PickLineOut)
    .describe('Lines for units taken from another lot or position, already picked.'),
  reallocated: z
    .object({ operationId: Id, quantity: z.string() })
    .nullable()
    .describe('Set when the scan named another lot or position and the allocation moved first.'),
  openLines: z.number().int(),
});

async function pickResult(
  ctx: HandlerContext,
  pickListId: string,
  lineId: string,
  newLineIds: string[],
  reallocated: z.infer<typeof PickResult>['reallocated'],
) {
  const { lines } = await loadLines(ctx.tx, pickListId, null);
  const line = lines.find((l) => l.lineId === lineId);
  if (!line) throw errors.internal();
  return {
    pickListId,
    line,
    newLines: lines.filter((l) => newLineIds.includes(l.lineId)),
    reallocated,
    openLines: lines.filter((l) => l.status === 'open').length,
  };
}

export const recordPick = defineOperation({
  id: 'picking.picks.record',
  summary: 'Record a pick on a pick list line',
  description:
    'Use this when the picker has taken units for a line: records the quantity picked (default: everything left on the line). Stock does not change until the reservation is fulfilled. If the units came from another lot, serial, or location than the line names, give lotCode, serial, or locationId (or positionId): the allocation is moved there first, and a new line records the pick. Not for units that are missing (use short_pick).',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    pickListId: Id,
    lineId: Id,
    quantity: PositiveDecimal.optional().describe('Base units picked; default what is left.'),
    locationId: Id.optional().describe('Where the units were taken, when not the line’s location.'),
    lotCode: LotCode.optional().describe('The lot taken, when not the line’s lot.'),
    serial: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('The serial taken, when not the line’s serial.'),
    positionId: Id.optional(),
  }),
  output: PickResult,
  permission: 'picking.run',
  connectionScope: 'inventory:write',
  audit: { action: 'picking.pick.recorded' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/pick-lists/{pickListId}/picks' },
  mcp: { tool: WAREHOUSE_TOOL, action: 'record_pick', readOnly: false, destructive: false },
  locations: async (input, tx) => [
    ...(await listLocations(tx, input.pickListId, input.lineId)),
    ...(input.locationId ? [input.locationId] : []),
  ],
  async handler(ctx, input) {
    const line = await lockLine(ctx.tx, input.pickListId, input.lineId);
    const remaining = remainingOf(line);
    if (compare(remaining, '0') <= 0) {
      throw errors.conflict('line_complete', 'Nothing is left to pick on this line.', {
        status: line.status,
      });
    }
    const quantity = normalize(input.quantity ?? remaining);
    if (compare(quantity, remaining) > 0) {
      throw errors.unprocessable(
        'quantity_exceeds_line',
        'That is more than is left to pick on this line.',
        { remaining },
      );
    }
    assertScale(quantity, await quantityScale(ctx.tx, line.variant_id));
    // Does the scan name the line's own position?
    const [current] = await ctx.tx.query<{ lot_code: string | null; serial: string | null }>(
      `select lt.code_normalized as lot_code, su.serial_normalized as serial
       from inventory_positions pos
       left join lots lt on lt.shop_id = pos.shop_id and lt.id = pos.lot_id
       left join serial_units su on su.shop_id = pos.shop_id and su.id = pos.serial_id
       where pos.id = $1`,
      [line.position_id],
    );
    const differs =
      (input.positionId !== undefined && input.positionId !== line.position_id) ||
      (input.locationId !== undefined && input.locationId !== line.location_id) ||
      (input.lotCode !== undefined && normalizeCode(input.lotCode) !== current?.lot_code) ||
      (input.serial !== undefined && normalizeCode(input.serial) !== current?.serial);

    const events: AuditEvent[] = [];
    const outbox: Array<{ topic: string; payload: unknown }> = [];
    const newLineIds: string[] = [];
    let reallocated: z.infer<typeof PickResult>['reallocated'] = null;
    if (differs) {
      // A scan of another lot or serial alone was taken where the picker stands: the line's
      // location. Without it, the allocation rule could move the reservation to another bin
      // that nobody picked from.
      const locationId = input.positionId
        ? input.locationId
        : (input.locationId ?? line.location_id);
      const moved = await reallocateReservation.handler(
        ctx,
        reallocateReservation.input.parse({
          reservationId: line.root_reservation_id,
          allocationId: line.allocation_id,
          quantity,
          ...(input.positionId ? { positionId: input.positionId } : {}),
          ...(locationId ? { locationId } : {}),
          ...(input.lotCode ? { lotCode: input.lotCode } : {}),
          ...(input.serial ? { serial: input.serial } : {}),
          reason: `Pick list ${line.list_number}: picked from another position`,
        }),
      );
      events.push(
        subEvent(ctx, reallocateReservation.audit.action, moved, 'picking.picks.record'),
        ...(moved.events ?? []),
      );
      outbox.push(...(moved.outbox ?? []));
      reallocated = { operationId: moved.result.operationId, quantity };
      await updateLine(ctx.tx, line.id, {
        quantity: line.quantity,
        picked: line.picked,
        short: line.short,
        moved: normalize(subtract(line.moved, `-${quantity}`)),
      });
      for (const to of moved.result.to) {
        const newId = ctx.newId();
        newLineIds.push(newId);
        await ctx.tx.query(
          `insert into pick_lines (shop_id, id, pick_list_id, sequence, reservation_id,
             root_reservation_id, allocation_id, variant_id, position_id, location_id,
             location_path, lot_id, serial_id, external_ref, fulfill_on_complete, quantity, picked,
             status)
           select app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, l.path, $10, $11, $12, $13,
             $14, $14, 'picked'
           from locations l where l.id = $9`,
          [
            newId,
            line.pick_list_id,
            line.sequence,
            line.reservation_id,
            line.root_reservation_id,
            to.allocationId,
            line.variant_id,
            to.positionId,
            to.locationId,
            to.lotId,
            to.serialId,
            line.external_ref,
            line.fulfill_on_complete,
            to.quantity,
          ],
        );
        await ctx.tx.query(
          `insert into picks (shop_id, id, pick_list_id, pick_line_id, kind, quantity, position_id,
             location_id, lot_id, serial_id, reallocation_operation_id, actor_type, actor_id)
           values (app_shop_id(), $1, $2, $3, 'pick', $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            ctx.newId(),
            line.pick_list_id,
            newId,
            to.quantity,
            to.positionId,
            to.locationId,
            to.lotId,
            to.serialId,
            moved.result.operationId,
            ctx.caller.kind,
            ctx.caller.id,
          ],
        );
      }
    } else {
      await updateLine(ctx.tx, line.id, {
        quantity: line.quantity,
        picked: normalize(subtract(line.picked, `-${quantity}`)),
        short: line.short,
        moved: line.moved,
      });
      await ctx.tx.query(
        `insert into picks (shop_id, id, pick_list_id, pick_line_id, kind, quantity, position_id,
           location_id, lot_id, serial_id, actor_type, actor_id)
         values (app_shop_id(), $1, $2, $3, 'pick', $4, $5, $6, $7, $8, $9, $10)`,
        [
          ctx.newId(),
          line.pick_list_id,
          line.id,
          quantity,
          line.position_id,
          line.location_id,
          line.lot_id,
          line.serial_id,
          ctx.caller.kind,
          ctx.caller.id,
        ],
      );
    }
    await touchList(ctx.tx, line.pick_list_id);
    const result = await pickResult(ctx, line.pick_list_id, line.id, newLineIds, reallocated);
    return {
      result,
      audit: {
        targetType: 'pick_line',
        targetId: line.id,
        operationId: reallocated?.operationId ?? null,
        locationIds: [...new Set([line.location_id, ...result.newLines.map((l) => l.locationId)])],
        externalRef: line.external_ref,
        changes: {
          pickListId: line.pick_list_id,
          quantity,
          reallocated: reallocated !== null,
          newLines: newLineIds,
        },
      },
      events,
      outbox,
    };
  },
});

export const recordShortPick = defineOperation({
  id: 'picking.picks.short',
  summary: 'Record a short pick: fewer units found than the line needs',
  description:
    'Use this when the picker cannot find everything a line asks for at its position. Records what was found (it counts as picked) and flags the line short; the missing units stay reserved at that position until a count settles it and they are reallocated. Returns the position to count, with the units already picked from it on open lists, which the count adds to what is on the shelf. Stock does not change. Not for units taken from another lot or position (use record_pick with lotCode, serial, or locationId).',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    pickListId: Id,
    lineId: Id,
    found: z
      .string()
      .regex(/^\d+(\.\d{1,6})?$/, 'A quantity such as 0 or 2.')
      .describe('Base units found at the position (0 when none).'),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  output: PickResult.extend({
    count: z
      .object({
        positionId: Id,
        locationId: Id,
        variantId: Id,
        lotId: Id.nullable(),
        serialId: Id.nullable(),
        missing: z.string(),
        picked: z
          .string()
          .describe(
            'Units already picked from this position on open pick lists, this one included: off the shelf but on record here until their list is finished. A count of the shelf adds them to what is counted, or it would take them off the books.',
          ),
      })
      .describe('The position to count: where the count that settles the difference starts.'),
  }),
  permission: 'picking.run',
  connectionScope: 'inventory:write',
  audit: { action: 'picking.pick.short' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/pick-lists/{pickListId}/short-picks' },
  mcp: { tool: WAREHOUSE_TOOL, action: 'short_pick', readOnly: false, destructive: false },
  locations: (input, tx) => listLocations(tx, input.pickListId, input.lineId),
  async handler(ctx, input) {
    const line = await lockLine(ctx.tx, input.pickListId, input.lineId);
    const remaining = remainingOf(line);
    const found = normalize(input.found);
    if (compare(remaining, '0') <= 0) {
      throw errors.conflict('line_complete', 'Nothing is left to pick on this line.', {
        status: line.status,
      });
    }
    if (compare(found, remaining) >= 0) {
      throw errors.unprocessable(
        'not_short',
        'That is everything the line needs: record it as a pick instead.',
        { remaining },
      );
    }
    assertScale(found, await quantityScale(ctx.tx, line.variant_id));
    const missing = normalize(subtract(remaining, found));
    await updateLine(ctx.tx, line.id, {
      quantity: line.quantity,
      picked: normalize(subtract(line.picked, `-${found}`)),
      short: normalize(subtract(line.short, `-${missing}`)),
      moved: line.moved,
    });
    await ctx.tx.query(
      `insert into picks (shop_id, id, pick_list_id, pick_line_id, kind, quantity, missing,
         position_id, location_id, lot_id, serial_id, actor_type, actor_id)
       values (app_shop_id(), $1, $2, $3, 'short', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        ctx.newId(),
        line.pick_list_id,
        line.id,
        found,
        missing,
        line.position_id,
        line.location_id,
        line.lot_id,
        line.serial_id,
        ctx.caller.kind,
        ctx.caller.id,
      ],
    );
    await touchList(ctx.tx, line.pick_list_id);
    const result = await pickResult(ctx, line.pick_list_id, line.id, [], null);
    // Picks never change stock: units picked from this position on open lists are in totes but
    // still on record here, so the count of the shelf must add them back.
    const [tote] = await ctx.tx.query<{ picked: string }>(
      `select coalesce(sum(pl.picked), 0)::text as picked
       from pick_lists l
       join pick_lines pl on pl.shop_id = l.shop_id and pl.pick_list_id = l.id
       where l.status = 'open' and pl.position_id = $1`,
      [line.position_id],
    );
    // I4b: the count of this position (milestone I2's count) starts from here.
    const count = {
      positionId: line.position_id,
      locationId: line.location_id,
      variantId: line.variant_id,
      lotId: line.lot_id,
      serialId: line.serial_id,
      missing,
      picked: normalize(tote?.picked ?? '0'),
    };
    return {
      result: { ...result, count },
      audit: {
        targetType: 'pick_line',
        targetId: line.id,
        locationIds: [line.location_id],
        externalRef: line.external_ref,
        reason: input.reason ?? null,
        changes: { pickListId: line.pick_list_id, found, missing, count },
      },
    };
  },
});

// Complete and cancel -----------------------------------------------------------------------

const RECORDED_REASONS = [
  'shopify',
  'not_fulfilling',
  'bundle_incomplete',
  'expired',
  'not_open',
] as const;
type RecordedReason = (typeof RECORDED_REASONS)[number];

export const completePickList = defineOperation({
  id: 'picking.lists.complete',
  summary: 'Complete a pick list and fulfill what was picked',
  description:
    'Use this when the picker is done: fulfills the picked units of manual and API reservations through the fulfill command (stock goes down now), and records Shopify orders’ picks only, because Shopify reports their fulfillment. A bundle is fulfilled only when every component it still holds is on this list and picked in full. Reservations that expired or closed in the meantime are skipped and reported. Short units stay reserved. Lines still open block completion unless leaveOpen is true, which leaves them reserved and unpicked. fulfill false records the picks without fulfilling anything. Needs inventory.fulfill to fulfill.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    pickListId: Id,
    fulfill: z.boolean().default(true),
    leaveOpen: z.boolean().default(false).describe('Complete even with lines still to pick.'),
    reference: Reference.optional().describe('A shipment or batch reference for the fulfillments.'),
  }),
  output: z.object({
    pickListId: Id,
    status: z.literal('completed'),
    fulfilled: z.array(
      z.object({
        reservationId: Id,
        operationId: Id,
        quantity: z.string(),
        externalRef: z.string().nullable(),
      }),
    ),
    recordedOnly: z
      .array(
        z.object({
          reservationId: Id,
          externalRef: z.string().nullable(),
          reason: z
            .enum(RECORDED_REASONS)
            .describe(
              'shopify: fulfilled from Shopify; not_fulfilling: completed with fulfill false; bundle_incomplete: some of the bundle’s components are not on this list or not picked in full, so fulfill it once they are; expired: the reservation expired before completion and its units are available again; not_open: the reservation was released or fulfilled in the meantime.',
            ),
        }),
      )
      .describe('Reservations whose picks were recorded but not fulfilled here, and why.'),
    leftOpen: z.number().int().describe('Lines that were still to pick and stay reserved.'),
    short: z.number().int(),
  }),
  permission: 'picking.run',
  connectionScope: 'inventory:write',
  audit: { action: 'picking.list.completed' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/pick-lists/{pickListId}/complete' },
  mcp: { tool: WAREHOUSE_TOOL, action: 'complete_pick_list', readOnly: false, destructive: false },
  locations: (input, tx) => listLocations(tx, input.pickListId),
  async handler(ctx, input) {
    const [list] = await ctx.tx.query<{ status: string; number: number }>(
      'select status, number from pick_lists where id = $1 for update',
      [input.pickListId],
    );
    if (!list) throw errors.notFound('Pick list');
    if (list.status !== 'open') {
      throw errors.conflict('pick_list_closed', `The pick list is ${list.status}.`);
    }
    if (
      input.fulfill &&
      !(ctx.membership && effectivePermissions(ctx.membership).has('inventory.fulfill'))
    ) {
      throw errors.forbidden(
        'Fulfilling needs the inventory.fulfill permission; complete with fulfill false to record the picks only.',
      );
    }
    const lines = await ctx.tx.query<LineRow>(
      `select pl.id, pl.pick_list_id, pl.sequence, pl.reservation_id, pl.root_reservation_id,
         pl.allocation_id, pl.variant_id, pl.position_id, pl.location_id, pl.lot_id, pl.serial_id,
         pl.quantity::text, pl.picked::text, pl.short::text, pl.moved::text, pl.status,
         pl.fulfill_on_complete, pl.external_ref
       from pick_lines pl
       where pl.pick_list_id = $1
       order by pl.id
       for update of pl`,
      [input.pickListId],
    );
    const open = lines.filter((l) => l.status === 'open');
    if (open.length > 0 && !input.leaveOpen) {
      throw errors.conflict(
        'lines_open',
        `${open.length} line(s) still to pick. Pick or short them, or complete with leaveOpen.`,
        { openLines: open.map((l) => l.id).slice(0, 50) },
      );
    }
    const events: AuditEvent[] = [];
    const outbox: Array<{ topic: string; payload: unknown }> = [];
    const fulfilled: Array<{
      reservationId: string;
      operationId: string;
      quantity: string;
      externalRef: string | null;
    }> = [];
    const recordedOnly = new Map<string, { externalRef: string | null; reason: RecordedReason }>();

    // The lines of each order-level reservation; an order with nothing picked is left alone.
    const byRoot = new Map<string, LineRow[]>();
    for (const l of lines) {
      byRoot.set(l.root_reservation_id, [...(byRoot.get(l.root_reservation_id) ?? []), l]);
    }
    const toFulfill: string[] = [];
    for (const [rootId, rootLines] of [...byRoot].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!rootLines.some((l) => compare(l.picked, '0') > 0)) continue;
      const first = rootLines[0]!;
      if (!first.fulfill_on_complete) {
        recordedOnly.set(rootId, { externalRef: first.external_ref, reason: 'shopify' });
      } else if (!input.fulfill) {
        recordedOnly.set(rootId, { externalRef: first.external_ref, reason: 'not_fulfilling' });
      } else {
        toFulfill.push(rootId);
      }
    }

    if (toFulfill.length > 0) {
      // ADR 0006 across the whole completion: every position these reservations (and their bundle
      // components) hold, in id order, then the reservations in id order. The fulfill commands
      // below then only take locks this transaction already holds.
      const openPositions = async () =>
        (
          await ctx.tx.query<{ position_id: string }>(
            `select distinct a.position_id from reservation_allocations a
             join reservations r on r.shop_id = a.shop_id and r.id = a.reservation_id
             where (r.id = any($1::uuid[]) or r.parent_id = any($1::uuid[])) and a.outstanding > 0`,
            [toFulfill],
          )
        ).map((r) => r.position_id);
      const held = new Set(await lockPositions(ctx.tx, await openPositions()));
      const roots = await ctx.tx.query<{
        id: string;
        parent_id: string | null;
        status: string;
        expired: boolean;
        quantity_scale: number;
      }>(
        `select r.id, r.parent_id, r.status,
           (r.expires_at is not null and r.expires_at <= now()) as expired, v.quantity_scale
         from reservations r join variants v on v.shop_id = r.shop_id and v.id = r.variant_id
         where r.id = any($1::uuid[]) or r.parent_id = any($1::uuid[])
         order by r.id for update of r`,
        [toFulfill],
      );
      if ((await openPositions()).some((p) => !held.has(p))) {
        throw errors.conflict(
          'retry_conflict',
          'A reservation on this list changed while it was being read. Retry the request.',
        );
      }
      // What each reservation and bundle component still holds, read under those locks.
      const allocations = await ctx.tx.query<{
        id: string;
        reservation_id: string;
        parent_id: string | null;
        outstanding: string;
      }>(
        `select a.id, a.reservation_id, r.parent_id, a.outstanding::text
         from reservation_allocations a
         join reservations r on r.shop_id = a.shop_id and r.id = a.reservation_id
         where (r.id = any($1::uuid[]) or r.parent_id = any($1::uuid[])) and a.outstanding > 0`,
        [toFulfill],
      );
      const outstanding = new Map(allocations.map((a) => [a.id, a.outstanding]));
      const fulfill = async (rootId: string, args: Record<string, unknown>) => {
        const done = await fulfillReservation.handler(
          ctx,
          fulfillReservation.input.parse({
            reservationId: rootId,
            ...args,
            ...(input.reference ? { reference: input.reference } : {}),
            reason: `Pick list ${list.number}`,
          }),
        );
        events.push(
          subEvent(ctx, fulfillReservation.audit.action, done, 'picking.lists.complete'),
          ...(done.events ?? []),
        );
        outbox.push(...(done.outbox ?? []));
        return done;
      };

      for (const rootId of toFulfill) {
        const rootLines = byRoot.get(rootId)!;
        const externalRef = rootLines[0]!.external_ref;
        const root = roots.find((r) => r.id === rootId);
        if (!root || !(OPEN_STATUSES as readonly string[]).includes(root.status)) {
          recordedOnly.set(rootId, { externalRef, reason: 'not_open' });
          continue;
        }
        // An expired reservation's units are already available again: fulfilling it would fail
        // and roll back every other order on the list, so it is skipped and reported.
        if (root.expired) {
          recordedOnly.set(rootId, { externalRef, reason: 'expired' });
          continue;
        }
        if (rootLines[0]!.reservation_id === rootId) {
          // One fulfillment per picked allocation. Something else (a person, or a release) may
          // have settled part of the allocation since it was picked: fulfill what is still held.
          for (const l of [...rootLines].sort((a, b) =>
            a.allocation_id < b.allocation_id ? -1 : 1,
          )) {
            const still = outstanding.get(l.allocation_id) ?? '0';
            const quantity = compare(l.picked, still) <= 0 ? normalize(l.picked) : normalize(still);
            if (compare(quantity, '0') <= 0) continue;
            const done = await fulfill(rootId, { allocationId: l.allocation_id, quantity });
            outstanding.set(l.allocation_id, normalize(subtract(still, quantity)));
            await ctx.tx.query('update pick_lines set fulfilled_operation_id = $2 where id = $1', [
              l.id,
              done.result.operationId,
            ]);
            fulfilled.push({
              reservationId: rootId,
              operationId: done.result.operationId,
              quantity,
              externalRef,
            });
          }
          continue;
        }
        // A bundle ships whole: it is fulfilled only when every unit its components still hold
        // is on this list and picked in full (nothing left, nothing short). Fulfilling the bundle
        // otherwise takes components from positions nobody picked (another warehouse, another
        // list), and fulfilling some components alone would leave the rest stranded, since a
        // bundle is released and fulfilled in whole bundles (ADR 0026, update).
        const onList = new Set(rootLines.map((l) => l.allocation_id));
        const coveredLines = rootLines.every(
          (l) => compare(remainingOf(l), '0') === 0 && compare(l.short, '0') === 0,
        );
        const held = allocations.filter((a) => a.parent_id === rootId);
        const components = roots.filter((r) => r.parent_id === rootId);
        if (
          !coveredLines ||
          held.length === 0 ||
          held.some((a) => !onList.has(a.id)) ||
          components.some((c) => !held.some((a) => a.reservation_id === c.id))
        ) {
          recordedOnly.set(rootId, { externalRef, reason: 'bundle_incomplete' });
          continue;
        }
        // Whole bundles the allocations cover (a component may be short of stock).
        const [covered] = await ctx.tx.query<{ bundles: string }>(
          `select coalesce(trunc(min(x.held / r.component_base_quantity), $2::int), 0)::text as bundles
           from reservations r
           cross join lateral (select coalesce(sum(a.outstanding), 0) as held
             from reservation_allocations a
             where a.shop_id = r.shop_id and a.reservation_id = r.id) x
           where r.parent_id = $1`,
          [rootId, root.quantity_scale],
        );
        const bundles = normalize(covered?.bundles ?? '0');
        if (compare(bundles, '0') <= 0) {
          recordedOnly.set(rootId, { externalRef, reason: 'bundle_incomplete' });
          continue;
        }
        const done = await fulfill(rootId, { quantity: bundles });
        await ctx.tx.query(
          'update pick_lines set fulfilled_operation_id = $2 where id = any($1::uuid[])',
          [
            rootLines.filter((l) => compare(l.picked, '0') > 0).map((l) => l.id),
            done.result.operationId,
          ],
        );
        fulfilled.push({
          reservationId: rootId,
          operationId: done.result.operationId,
          quantity: done.result.fulfilled,
          externalRef,
        });
      }
    }
    const leftOpen = open.length;
    await ctx.tx.query(
      `with lines as (
         update pick_lines set status = case when status = 'open' then 'cancelled' else 'done' end,
           updated_at = now(), version = version + 1
         where pick_list_id = $1 and status in ('open', 'picked', 'short'))
       update pick_lists set status = 'completed', completed_at = now(), updated_at = now(),
         version = version + 1
       where id = $1`,
      [input.pickListId],
    );
    const short = lines.filter((l) => l.status === 'short').length;
    const recorded = [...recordedOnly].map(([reservationId, r]) => ({
      reservationId,
      externalRef: r.externalRef,
      reason: r.reason,
    }));
    return {
      result: {
        pickListId: input.pickListId,
        status: 'completed' as const,
        fulfilled,
        recordedOnly: recorded,
        leftOpen,
        short,
      },
      audit: {
        targetType: 'pick_list',
        targetId: input.pickListId,
        locationIds: [...new Set(lines.map((l) => l.location_id))].slice(0, 100),
        externalRef: input.reference ?? null,
        changes: {
          number: list.number,
          fulfilled: fulfilled.map((f) => ({
            reservationId: f.reservationId,
            quantity: f.quantity,
          })),
          recordedOnly: recorded.map((r) => ({ reservationId: r.reservationId, reason: r.reason })),
          leftOpen,
          short,
        },
      },
      events,
      outbox,
    };
  },
});

export const cancelPickList = defineOperation({
  id: 'picking.lists.cancel',
  summary: 'Cancel a pick list',
  description:
    'Use this when a pick list will not be worked: its lines are closed and their reservations stay as they are, so they can go on another list. Picks already recorded stay in the history. Nothing is fulfilled and stock does not change.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ pickListId: Id, reason: z.string().trim().min(1).max(500).optional() }),
  output: z.object({ pickListId: Id, status: z.literal('cancelled'), lines: z.number().int() }),
  permission: 'picking.run',
  connectionScope: 'inventory:write',
  audit: { action: 'picking.list.cancelled' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/pick-lists/{pickListId}/cancel' },
  mcp: { tool: WAREHOUSE_TOOL, action: 'cancel_pick_list', readOnly: false, destructive: true },
  locations: (input, tx) => listLocations(tx, input.pickListId),
  async handler(ctx, input) {
    const [list] = await ctx.tx.query<{ status: string; number: number }>(
      'select status, number from pick_lists where id = $1 for update',
      [input.pickListId],
    );
    if (!list) throw errors.notFound('Pick list');
    if (list.status !== 'open') {
      throw errors.conflict('pick_list_closed', `The pick list is ${list.status}.`);
    }
    const lines = await ctx.tx.query<{ location_id: string }>(
      `update pick_lines set status = 'cancelled', updated_at = now(), version = version + 1
       where pick_list_id = $1 and status in ('open', 'picked', 'short')
       returning location_id`,
      [input.pickListId],
    );
    await ctx.tx.query(
      `update pick_lists set status = 'cancelled', completed_at = now(), updated_at = now(),
         version = version + 1 where id = $1`,
      [input.pickListId],
    );
    return {
      result: { pickListId: input.pickListId, status: 'cancelled' as const, lines: lines.length },
      audit: {
        targetType: 'pick_list',
        targetId: input.pickListId,
        reason: input.reason ?? null,
        locationIds: [...new Set(lines.map((l) => l.location_id))].slice(0, 100),
        changes: { number: list.number, lines: lines.length },
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const pickingOperations = [
  createPickList,
  listPickLists,
  getPickList,
  recordPick,
  recordShortPick,
  completePickList,
  cancelPickList,
] as const;
