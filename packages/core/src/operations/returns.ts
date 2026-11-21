import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { add, compare, normalize, subtract } from '../catalog/decimal.ts';
import { PositiveDecimal } from '../decimal.ts';
import { AppError, errors } from '../errors.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id } from '../schemas.ts';
import {
  actorColumns,
  applyStockCost,
  assertScale,
  canSeeCosts,
  loadStockVariant,
  normalizeCode,
} from '../stock/engine.ts';
import {
  type AppliedMove,
  applyMoves,
  type EnteredPack,
  findPositions,
  lockStock,
  openShortageReservations,
  type PositionKey,
  resolvePack,
  type StockMove,
  syncSerials,
} from '../stock/moves.ts';
import { fillShortages } from '../stock/shortages.ts';
import { webhookEvent } from '../webhooks/events.ts';
import { LotCode } from './inventory.ts';

// Returns and inspection (plan D9, PRD 6.5, ADR "Returns"). Requesting and authorizing change no
// stock; receiving puts units in quarantine at the receiving location; inspection splits them
// into sellable, damaged, repair, supplier return, or disposal. No refund is issued here.
//
// Lock order: the return row first (only return commands lock it, always first), then
// variants (key share), positions by id, reservations by id, then variant_costs and serial units.

const TOOL = 'manage_returns';

const Reference = z.string().trim().min(1).max(200);
const Note = z.string().trim().min(1).max(2000);
const Reason = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe('Why, in a few words; kept in the history.');
const Serials = z.array(z.string().trim().min(1).max(100)).min(1).max(500);

const DISPOSITIONS = ['sellable', 'damaged', 'repair', 'supplier_return', 'disposal'] as const;
type Disposition = (typeof DISPOSITIONS)[number];

const DISPOSITION_COLUMN: Record<Disposition, string> = {
  sellable: 'sellable',
  damaged: 'damaged',
  repair: 'repair',
  supplier_return: 'supplier_return',
  disposal: 'disposed',
};

const ReturnStatus = z.enum([
  'requested',
  'authorized',
  'in_transit',
  'received',
  'inspecting',
  'completed',
  'cancelled',
  'exception',
]);

const Quantities = z.object({
  expected: z.string(),
  received: z.string(),
  inspected: z.string(),
  uninspected: z.string().describe('Received, still in quarantine waiting for inspection.'),
  sellable: z.string(),
  damaged: z.string(),
  repair: z.string(),
  supplierReturn: z.string(),
  disposed: z.string(),
});

export const ReturnOut = z.object({
  returnId: Id,
  reference: z.string().nullable(),
  orderRef: z.string().nullable(),
  fulfillmentRef: z.string().nullable(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  trackingReference: z.string().nullable(),
  status: ReturnStatus,
  location: z
    .object({ locationId: Id, path: z.string(), warehouseId: Id.nullable() })
    .nullable()
    .describe('Where the units were received, in quarantine.'),
  exception: z.object({ open: z.boolean(), note: z.string().nullable() }),
  closed: z.boolean(),
  createdAt: z.string(),
  authorizedAt: z.string().nullable(),
  receivedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  version: z.number(),
  totals: Quantities,
  lines: z.array(
    Quantities.extend({
      lineId: Id,
      variantId: Id,
      sku: z.string(),
      name: z.string(),
      entered: z
        .object({ packId: Id, packName: z.string(), quantity: z.string(), factor: z.string() })
        .nullable(),
      units: z.array(
        z.object({
          unitId: Id,
          lotCode: z.string().nullable(),
          serial: z.string().nullable(),
          received: z.string(),
          inspected: z.string(),
          matched: z
            .boolean()
            .nullable()
            .describe('Serials: false when not fulfilled from this shop (needs review).'),
          costSource: z.enum(['fulfillment', 'average']),
          unitCost: z.string().nullable().describe('Needs costs.read.'),
        }),
      ),
    }),
  ),
});
type ReturnView = z.infer<typeof ReturnOut>;

const tsSql = (c: string) => `to_char(${c} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const QTY = (p: string) => `'expected', ${p}expected::text, 'received', ${p}received::text,
  'inspected', (${p}sellable + ${p}damaged + ${p}repair + ${p}supplier_return + ${p}disposed)::text,
  'uninspected', (${p}received - ${p}sellable - ${p}damaged - ${p}repair - ${p}supplier_return - ${p}disposed)::text,
  'sellable', ${p}sellable::text, 'damaged', ${p}damaged::text, 'repair', ${p}repair::text,
  'supplierReturn', ${p}supplier_return::text, 'disposed', ${p}disposed::text`;

const RETURN_SQL = `
  select r.id as "returnId", r.reference, r.order_ref as "orderRef",
    r.fulfillment_ref as "fulfillmentRef", r.reason, r.note,
    r.tracking_reference as "trackingReference", r.status,
    case when l.id is null then null else json_build_object('locationId', l.id, 'path', l.path,
      'warehouseId', l.warehouse_id) end as location,
    json_build_object('open', r.exception_open, 'note', r.exception_note) as exception,
    r.closed, ${tsSql('r.created_at')} as "createdAt", ${tsSql('r.authorized_at')} as "authorizedAt",
    ${tsSql('r.received_at')} as "receivedAt", ${tsSql('r.completed_at')} as "completedAt",
    r.version,
    (select json_build_object(${QTY('t.')}) from (select
       coalesce(sum(x.expected), 0) as expected, coalesce(sum(x.received), 0) as received,
       coalesce(sum(x.sellable), 0) as sellable, coalesce(sum(x.damaged), 0) as damaged,
       coalesce(sum(x.repair), 0) as repair, coalesce(sum(x.supplier_return), 0) as supplier_return,
       coalesce(sum(x.disposed), 0) as disposed
     from return_lines x where x.shop_id = r.shop_id and x.return_id = r.id) t) as totals,
    coalesce((select json_agg(json_build_object('lineId', rl.id, 'variantId', rl.variant_id,
       'sku', v.sku, 'name', p.name, ${QTY('rl.')},
       'entered', case when rl.pack_id is null then null else json_build_object('packId', rl.pack_id,
          'packName', pk.name, 'quantity', rl.entered_quantity::text, 'factor', rl.conversion_factor::text) end,
       'units', coalesce((select json_agg(json_build_object('unitId', u.id, 'lotCode', lt.code,
            'serial', su.serial, 'received', u.received::text, 'inspected', u.inspected::text,
            'matched', u.matched, 'costSource', u.cost_source, 'unitCost', u.unit_cost::text)
            order by lt.code, su.serial, u.id)
          from return_units u
          left join lots lt on lt.shop_id = u.shop_id and lt.id = u.lot_id
          left join serial_units su on su.shop_id = u.shop_id and su.id = u.serial_id
          where u.shop_id = rl.shop_id and u.line_id = rl.id), '[]'::json))
       order by rl.position)
     from return_lines rl
     join variants v on v.shop_id = rl.shop_id and v.id = rl.variant_id
     join products p on p.shop_id = v.shop_id and p.id = v.product_id
     left join packs pk on pk.shop_id = rl.shop_id and pk.id = rl.pack_id
     where rl.shop_id = r.shop_id and rl.return_id = r.id), '[]'::json) as lines
  from returns r
  left join locations l on l.shop_id = r.shop_id and l.id = r.location_id`;

function hideCosts(ctx: HandlerContext, view: ReturnView): ReturnView {
  if (canSeeCosts(ctx)) return view;
  return {
    ...view,
    lines: view.lines.map((l) => ({
      ...l,
      units: l.units.map((u) => ({ ...u, unitCost: null })),
    })),
  };
}

async function loadReturn(ctx: HandlerContext, returnId: string): Promise<ReturnView> {
  const [row] = await ctx.tx.query<ReturnView>(`${RETURN_SQL} where r.id = $1`, [returnId]);
  if (!row) throw errors.notFound('Return');
  return hideCosts(ctx, row);
}

interface ReturnRow {
  id: string;
  status: string;
  reference: string | null;
  order_ref: string | null;
  location_id: string | null;
  authorized_at: Date | null;
  cancelled_at: Date | null;
  closed: boolean;
  exception_open: boolean;
}

interface LineRow {
  id: string;
  variant_id: string;
  expected: string;
  received: string;
  inspected: string;
}

async function lockReturn(ctx: HandlerContext, returnId: string) {
  const [r] = await ctx.tx.query<ReturnRow>(
    `select id, status, reference, order_ref, location_id, authorized_at, cancelled_at, closed,
       exception_open
     from returns where id = $1 for update`,
    [returnId],
  );
  if (!r) throw errors.notFound('Return');
  const lines = await ctx.tx.query<LineRow>(
    `select id, variant_id, expected::text, received::text,
       (sellable + damaged + repair + supplier_return + disposed)::text as inspected
     from return_lines where return_id = $1 order by position`,
    [returnId],
  );
  return { r, lines };
}

/** Recomputes the status from the quantities and the explicit steps (PRD 6.5). */
async function refreshReturn(
  ctx: HandlerContext,
  returnId: string,
): Promise<{ from: string; to: string }> {
  const [row] = await ctx.tx.query<{
    status: string;
    authorized: boolean;
    shipped: boolean;
    cancelled: boolean;
    closed: boolean;
    exception_open: boolean;
    expected: string;
    received: string;
    inspected: string;
  }>(
    `select r.status, r.authorized_at is not null as authorized, r.shipped_at is not null as shipped,
       r.cancelled_at is not null as cancelled, r.closed, r.exception_open,
       coalesce(sum(l.expected), 0)::text as expected, coalesce(sum(l.received), 0)::text as received,
       coalesce(sum(l.sellable + l.damaged + l.repair + l.supplier_return + l.disposed), 0)::text as inspected
     from returns r left join return_lines l on l.shop_id = r.shop_id and l.return_id = r.id
     where r.id = $1 group by r.shop_id, r.id`,
    [returnId],
  );
  if (!row) throw errors.internal();
  const received = compare(row.received, '0') > 0;
  let status: string;
  if (row.cancelled) status = 'cancelled';
  else if (row.exception_open) status = 'exception';
  else if (!received)
    status = row.shipped ? 'in_transit' : row.authorized ? 'authorized' : 'requested';
  else if (compare(row.inspected, '0') === 0) status = 'received';
  else if (
    compare(row.inspected, row.received) === 0 &&
    (row.closed || compare(row.received, row.expected) >= 0)
  )
    status = 'completed';
  else status = 'inspecting';
  await ctx.tx.query(
    `update returns set status = $2,
       completed_at = case when $2 = 'completed' then coalesce(completed_at, now()) end,
       updated_at = now(), version = version + 1
     where id = $1`,
    [returnId, status],
  );
  return { from: row.status, to: status };
}

function statusWebhook(returnId: string, status: { from: string | null; to: string }) {
  return status.from === status.to
    ? []
    : [webhookEvent('return.status_changed', { returnId, from: status.from, to: status.to })];
}

/** A return touches a location once received; a scoped member must have it in scope. */
async function requireReturnInScope(ctx: HandlerContext, r: ReturnRow): Promise<void> {
  if (!r.location_id || ctx.locationScope === null) return;
  const [row] = await ctx.tx.query<{ ok: boolean }>(
    'select path_ids && $2::uuid[] as ok from locations where id = $1',
    [r.location_id, ctx.locationScope],
  );
  if (!row?.ok) {
    throw new AppError(
      403,
      'location_out_of_scope',
      'You do not have access to the location where this return was received.',
      'denied',
    );
  }
}

function assertOpen(r: ReturnRow): void {
  if (r.status === 'cancelled' || r.status === 'completed') {
    throw errors.conflict('return_closed', `The return is ${r.status}.`, {
      currentStatus: r.status,
    });
  }
}

async function returnLocation(tx: Tx, returnId: string): Promise<string[]> {
  const [row] = await tx.query<{ id: string | null }>(
    'select location_id as id from returns where id = $1',
    [returnId],
  );
  return row?.id ? [row.id] : [];
}

const CommandOut = z.object({
  operationId: Id.nullable().describe('The stock operation this step recorded, if any.'),
  return: ReturnOut,
});

// Create --------------------------------------------------------------------------------------

export const createReturn = defineOperation({
  id: 'returns.create',
  summary: 'Create a return for an order',
  description:
    'Use this when a customer wants to send items back, such as "order 1001 came back damaged". Records the return with the order (and fulfillment) reference, the items and quantities expected, and the reason. It changes no stock and issues no refund; set authorize: true to approve it at once. Receive the units when they arrive, then inspect them.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    lines: z
      .array(
        z.object({
          variantId: Id,
          quantity: PositiveDecimal.describe('Base units, or packs when packId is set.'),
          packId: Id.optional(),
        }),
      )
      .min(1)
      .max(200),
    orderRef: Reference.optional().describe('The order in the sales channel, such as 1001.'),
    fulfillmentRef: Reference.optional().describe('The shipment or fulfillment it came from.'),
    reference: Reference.optional().describe('Your RMA number.'),
    reason: Reason.optional(),
    note: Note.optional(),
    authorize: z.boolean().optional().describe('Approve the return now.'),
  }),
  output: CommandOut,
  permission: 'returns.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'return.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/returns', status: 201 },
  mcp: { tool: TOOL, action: 'create', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const seen = new Set<string>();
    const lines: Array<{
      id: string;
      variantId: string;
      expected: string;
      pack: EnteredPack | null;
    }> = [];
    for (const l of input.lines) {
      if (seen.has(l.variantId)) {
        throw errors.unprocessable(
          'duplicate_line',
          'Name each variant once; add the quantities up.',
          {
            variantId: l.variantId,
          },
        );
      }
      seen.add(l.variantId);
    }
    for (const l of [...input.lines].sort((a, b) => (a.variantId < b.variantId ? -1 : 1))) {
      const variant = await loadStockVariant(ctx.tx, l.variantId);
      if (variant.bundleId) {
        throw errors.unprocessable(
          'bundle_holds_no_stock',
          'A bundle holds no stock of its own: return its components.',
          { variantId: l.variantId },
        );
      }
      const { base, pack } = await resolvePack(ctx.tx, l.variantId, l.packId, l.quantity);
      assertScale(base, variant.quantityScale, `Variant ${variant.sku}`);
      lines.push({ id: ctx.newId(), variantId: l.variantId, expected: base, pack });
    }
    const ordered = input.lines.map((l) => lines.find((x) => x.variantId === l.variantId)!);
    const returnId = ctx.newId();
    await ctx.tx.query(
      `insert into returns (shop_id, id, reference, order_ref, fulfillment_ref, reason, note,
         created_by_type, created_by_id, authorized_at)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, case when $9 then now() end)`,
      [
        returnId,
        input.reference ?? null,
        input.orderRef ?? null,
        input.fulfillmentRef ?? null,
        input.reason ?? null,
        input.note ?? null,
        ctx.caller.kind,
        ctx.caller.id,
        input.authorize ?? false,
      ],
    );
    await ctx.tx.query(
      `insert into return_lines (shop_id, id, return_id, variant_id, position, expected, pack_id,
         pack_version, entered_quantity, conversion_factor)
       select app_shop_id(), x.id, $2, x."variantId", x.position, x.expected, x."packId",
         x."packVersion", x.entered, x.factor
       from jsonb_to_recordset($1::jsonb) as x(id uuid, "variantId" uuid, position integer,
         expected numeric, "packId" uuid, "packVersion" integer, entered numeric, factor numeric)`,
      [
        JSON.stringify(
          ordered.map((l, position) => ({
            id: l.id,
            variantId: l.variantId,
            position,
            expected: l.expected,
            packId: l.pack?.packId ?? null,
            packVersion: l.pack?.packVersion ?? null,
            entered: l.pack?.quantity ?? null,
            factor: l.pack?.factor ?? null,
          })),
        ),
        returnId,
      ],
    );
    const status = await refreshReturn(ctx, returnId);
    const view = await loadReturn(ctx, returnId);
    return {
      result: { operationId: null, return: view },
      audit: {
        targetType: 'return',
        targetId: returnId,
        externalRef: input.orderRef ?? null,
        reason: input.reason ?? null,
        changes: {
          lines: ordered.map((l) => ({
            lineId: l.id,
            variantId: l.variantId,
            expected: l.expected,
            entered: l.pack,
          })),
          orderRef: input.orderRef ?? null,
          fulfillmentRef: input.fulfillmentRef ?? null,
          status: { returnId, from: null, to: status.to },
        },
      },
      webhooks: statusWebhook(returnId, { from: null, to: status.to }),
    };
  },
});

// Authorize and in transit ----------------------------------------------------------------------

export const authorizeReturn = defineOperation({
  id: 'returns.authorize',
  summary: 'Authorize a return',
  description:
    'Use this to approve a requested return so the customer can send it. Changes no stock.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ returnId: Id, reason: Reason.optional() }),
  output: CommandOut,
  permission: 'returns.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'return.authorized' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/returns/{returnId}/authorize' },
  mcp: { tool: TOOL, action: 'authorize', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const { r } = await lockReturn(ctx, input.returnId);
    await requireReturnInScope(ctx, r);
    assertOpen(r);
    if (r.authorized_at) {
      throw errors.conflict('return_already_authorized', 'The return is already authorized.');
    }
    await ctx.tx.query('update returns set authorized_at = now() where id = $1', [r.id]);
    const status = await refreshReturn(ctx, r.id);
    return {
      result: { operationId: null, return: await loadReturn(ctx, r.id) },
      audit: {
        targetType: 'return',
        targetId: r.id,
        externalRef: r.order_ref,
        reason: input.reason ?? null,
        changes: { status: { returnId: r.id, ...status } },
      },
      webhooks: statusWebhook(r.id, status),
    };
  },
});

export const markReturnInTransit = defineOperation({
  id: 'returns.in_transit',
  summary: 'Mark a return as on its way',
  description:
    'Use this when the customer has shipped the return, optionally with the carrier tracking number. Changes no stock.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    returnId: Id,
    trackingReference: Reference.optional().describe('The carrier tracking number.'),
    reason: Reason.optional(),
  }),
  output: CommandOut,
  permission: 'returns.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'return.in_transit' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/returns/{returnId}/in-transit' },
  mcp: { tool: TOOL, action: 'in_transit', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const { r, lines } = await lockReturn(ctx, input.returnId);
    await requireReturnInScope(ctx, r);
    assertOpen(r);
    if (!r.authorized_at) {
      throw errors.conflict('return_not_authorized', 'Authorize the return first.');
    }
    if (lines.some((l) => compare(l.received, '0') > 0)) {
      throw errors.conflict('return_received', 'Units of this return have already arrived.');
    }
    await ctx.tx.query(
      `update returns set shipped_at = coalesce(shipped_at, now()),
         tracking_reference = coalesce($2, tracking_reference) where id = $1`,
      [r.id, input.trackingReference ?? null],
    );
    const status = await refreshReturn(ctx, r.id);
    return {
      result: { operationId: null, return: await loadReturn(ctx, r.id) },
      audit: {
        targetType: 'return',
        targetId: r.id,
        externalRef: r.order_ref,
        reason: input.reason ?? null,
        changes: {
          trackingReference: input.trackingReference ?? null,
          status: { returnId: r.id, ...status },
        },
      },
      webhooks: statusWebhook(r.id, status),
    };
  },
});

// Receive ---------------------------------------------------------------------------------------

const ReceiveItem = z.object({
  variantId: Id,
  quantity: PositiveDecimal.optional().describe(
    'Base units, or packs with packId. Leave out for everything still expected.',
  ),
  packId: Id.optional(),
  lotCode: LotCode.optional().describe('Lot-tracked items: the lot on the returned units.'),
  serials: Serials.optional().describe('Serial-tracked items: the serials that came back.'),
});

/** The cost per base unit the units left with, from their fulfillment entries, if traceable. */
async function tracedCost(
  tx: Tx,
  variantId: string,
  orderRef: string | null,
  lotId: string | null,
  serialId: string | null,
): Promise<string | null> {
  if (serialId) {
    const [row] = await tx.query<{ cost: string | null }>(
      `select e.unit_cost::text as cost from inventory_entries e
       join inventory_operations o on o.shop_id = e.shop_id and o.id = e.operation_id
       where e.serial_id = $1 and o.kind = 'fulfillment' and e.delta < 0
       order by o.occurred_at desc, e.id desc limit 1`,
      [serialId],
    );
    return row?.cost ?? null;
  }
  if (!orderRef) return null;
  const [row] = await tx.query<{ cost: string | null }>(
    `select case when count(*) > 0 and bool_and(e.unit_cost is not null)
         then round_half_even(sum(-e.delta * e.unit_cost) / sum(-e.delta), 6)::text end as cost
     from inventory_entries e
     join inventory_operations o on o.shop_id = e.shop_id and o.id = e.operation_id
     join reservations r on r.shop_id = e.shop_id and r.id = e.reservation_id
     left join reservations p on p.shop_id = r.shop_id and p.id = r.parent_id
     where e.variant_id = $1 and o.kind = 'fulfillment' and e.delta < 0
       and coalesce(r.external_ref, p.external_ref) = $2
       and ($3::uuid is null or e.lot_id = $3)`,
    [variantId, orderRef, lotId],
  );
  return row?.cost ?? null;
}

export const receiveReturn = defineOperation({
  id: 'returns.receive',
  summary: 'Receive returned units into quarantine',
  description:
    'Use this when returned items arrive, at any warehouse. Puts the units in quarantine at the location you name (they are not available until inspected). Serialized items must be given by serial: a serial that was not fulfilled from this shop is received but flagged for review. Units re-enter valuation at the cost they were fulfilled at when that can be traced, else at the moving average. Not for supplier deliveries (use receive_stock).',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    returnId: Id,
    locationId: Id.optional().describe(
      'Where the units arrive (a shelf). Needed for the first receipt; later ones use the same.',
    ),
    items: z
      .array(ReceiveItem)
      .min(1)
      .max(200)
      .optional()
      .describe('Per line; leave out to receive everything still expected (untracked items only).'),
    reason: Reason.optional(),
  }),
  output: CommandOut.extend({
    flagged: z
      .array(z.object({ variantId: Id, serial: z.string() }))
      .describe('Serials not fulfilled from this shop: received, and flagged for review.'),
  }),
  permission: 'returns.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'return.received' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/returns/{returnId}/receive' },
  mcp: { tool: TOOL, action: 'receive', readOnly: false, destructive: false },
  locations: async (input, tx) =>
    input.locationId ? [input.locationId] : returnLocation(tx, input.returnId),
  async handler(ctx, input) {
    const { r, lines } = await lockReturn(ctx, input.returnId);
    assertOpen(r);
    if (r.location_id && input.locationId && input.locationId !== r.location_id) {
      throw errors.unprocessable(
        'return_location_fixed',
        'This return is received at another location; receive the rest there and move it later.',
        { locationId: r.location_id },
      );
    }
    const locationId = r.location_id ?? input.locationId;
    if (!locationId) {
      throw errors.unprocessable('location_required', 'Name the location the units arrive at.');
    }
    const [loc] = await ctx.tx.query<{ status: string; leaf: boolean }>(
      `select l.status, not exists (select 1 from locations c where c.shop_id = l.shop_id
         and c.parent_id = l.id) as leaf
       from locations l where l.id = $1 and l.kind = 'storage' for share`,
      [locationId],
    );
    if (!loc) throw errors.notFound('Location');
    if (loc.status !== 'active')
      throw errors.conflict('location_archived', 'The location is archived.');
    if (!loc.leaf) {
      throw errors.unprocessable(
        'location_not_leaf',
        'Stock is held only at locations without sub-locations.',
      );
    }

    // What arrives, per line, with lots and serials checked against the variant's tracking.
    const specs = input.items ?? lines.map((l) => ({ variantId: l.variant_id }));
    const seen = new Set<string>();
    const plans: Array<{
      line: LineRow;
      variant: Awaited<ReturnType<typeof loadStockVariant>>;
      quantity: string;
      pack: EnteredPack | null;
      lotId: string | null;
      serials: string[];
      raw: Map<string, string>;
    }> = [];
    for (const item of [...specs].sort((a, b) => (a.variantId < b.variantId ? -1 : 1))) {
      const line = lines.find((l) => l.variant_id === item.variantId);
      if (!line) {
        throw errors.unprocessable('not_on_return', 'This variant is not on the return.', {
          variantId: item.variantId,
        });
      }
      if (seen.has(line.id)) {
        throw errors.unprocessable('duplicate_line', 'Name each variant once.', {
          variantId: item.variantId,
        });
      }
      seen.add(line.id);
      const variant = await loadStockVariant(ctx.tx, line.variant_id);
      const remaining = normalize(subtract(line.expected, line.received));
      const it = item as z.infer<typeof ReceiveItem>;
      let quantity = remaining;
      let pack: EnteredPack | null = null;
      if (it.quantity !== undefined) {
        const resolved = await resolvePack(ctx.tx, line.variant_id, it.packId, it.quantity);
        quantity = resolved.base;
        pack = resolved.pack;
      }
      const raw = new Map((it.serials ?? []).map((x) => [normalizeCode(x), x]));
      const serials = (it.serials ?? []).map(normalizeCode);
      if (variant.trackingMode === 'serial') {
        if (serials.length === 0) {
          throw errors.unprocessable('serials_required', `Give the serials of ${variant.sku}.`);
        }
        if (new Set(serials).size !== serials.length) {
          throw errors.unprocessable('duplicate_serial', 'The same serial appears twice.');
        }
        if (it.quantity !== undefined && compare(quantity, String(serials.length)) !== 0) {
          throw errors.unprocessable('serial_count_mismatch', 'Give one serial for each unit.');
        }
        quantity = String(serials.length);
      } else if (serials.length > 0) {
        throw errors.unprocessable(
          'not_serial_tracked',
          `${variant.sku} is not tracked by serial.`,
        );
      }
      let lotId: string | null = null;
      if (variant.trackingMode === 'lot' || variant.trackingMode === 'lot_expiry') {
        if (!it.lotCode) {
          throw errors.unprocessable(
            'lot_required',
            `${variant.sku} is tracked by lot: give lotCode.`,
          );
        }
        const [lot] = await ctx.tx.query<{ id: string }>(
          'select id from lots where variant_id = $1 and code_normalized = $2',
          [line.variant_id, normalizeCode(it.lotCode)],
        );
        if (!lot) {
          throw errors.unprocessable('unknown_lot', 'This lot was never received by this shop.', {
            lotCode: it.lotCode,
          });
        }
        lotId = lot.id;
      } else if (it.lotCode) {
        throw errors.unprocessable('not_lot_tracked', `${variant.sku} is not tracked by lot.`);
      }
      assertScale(quantity, variant.quantityScale, `Variant ${variant.sku}`);
      if (compare(quantity, '0') <= 0 || compare(quantity, remaining) > 0) {
        throw errors.conflict(
          'quantity_exceeds_expected',
          'More units than the return still expects; change the return first.',
          { variantId: line.variant_id, requested: quantity, remaining },
        );
      }
      plans.push({ line, variant, quantity, pack, lotId, serials, raw });
    }

    // Serials: back from 'sold' when fulfilled from this shop; otherwise received and flagged.
    const operationId = ctx.newId();
    await ctx.tx.query(
      `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
         external_ref, reason, return_id)
       values (app_shop_id(), $1, 'return', $2, $3, $4, $5, $6, $7, $8)`,
      [operationId, ...actorColumns(ctx), r.order_ref ?? r.reference, input.reason ?? null, r.id],
    );
    const flagged: Array<{ variantId: string; serial: string }> = [];
    const units: Array<{
      plan: (typeof plans)[number];
      serialId: string | null;
      matched: boolean | null;
      quantity: string;
    }> = [];
    for (const plan of plans) {
      if (plan.serials.length === 0) {
        units.push({ plan, serialId: null, matched: null, quantity: plan.quantity });
        continue;
      }
      const known = await ctx.tx.query<{ id: string; normalized: string; status: string }>(
        `select id, serial_normalized as normalized, status from serial_units
         where variant_id = $1 and serial_normalized = any($2::text[])`,
        [plan.line.variant_id, plan.serials],
      );
      for (const s of plan.serials) {
        const unit = known.find((k) => k.normalized === s);
        if (unit && (unit.status === 'in_stock' || unit.status === 'in_transit')) {
          throw errors.conflict(
            'serial_in_stock',
            `Serial ${s} is still in stock here; it cannot also come back. Check the serial.`,
            { serial: s },
          );
        }
        if (unit) {
          const matched = unit.status === 'sold';
          if (!matched) flagged.push({ variantId: plan.line.variant_id, serial: s });
          units.push({ plan, serialId: unit.id, matched, quantity: '1' });
        } else {
          const id = ctx.newId();
          await ctx.tx.query(
            `insert into serial_units (shop_id, id, variant_id, serial, serial_normalized, status,
               position_id, created_operation_id, last_operation_id)
             values (app_shop_id(), $1, $2, $3, $4, 'written_off', null, $5, $5)`,
            [id, plan.line.variant_id, plan.raw.get(s) ?? s, s, operationId],
          );
          flagged.push({ variantId: plan.line.variant_id, serial: s });
          units.push({ plan, serialId: id, matched: false, quantity: '1' });
        }
      }
    }

    // 1. Positions: the quarantine positions these units go to, then shortages are not touched
    // (quarantine is never sellable).
    const keys: PositionKey[] = units.map((u) => ({
      variantId: u.plan.line.variant_id,
      locationId,
      condition: 'quarantine',
      lotId: u.plan.lotId,
      serialId: u.serialId,
      transferId: null,
    }));
    const existing = await findPositions(ctx.tx, keys);
    const lock = await lockStock(
      ctx,
      existing.map((p) => p.id),
    );

    // 3. Costs: each unit re-enters valuation at its traced fulfillment cost, else the average.
    const costs: Array<{
      unitCost: string | null;
      costBasis: string;
      source: 'fulfillment' | 'average';
    }> = [];
    const order = units
      .map((u, i) => ({ u, i }))
      .sort((a, b) => (a.u.plan.line.variant_id < b.u.plan.line.variant_id ? -1 : 1));
    for (const { u, i } of order) {
      const traced = await tracedCost(
        ctx.tx,
        u.plan.line.variant_id,
        r.order_ref,
        u.plan.lotId,
        u.serialId,
      );
      const applied = await applyStockCost(
        ctx,
        u.plan.line.variant_id,
        operationId,
        'return',
        u.quantity,
        traced,
      );
      costs[i] = { ...applied, source: traced === null ? 'average' : 'fulfillment' };
      if (u.plan.variant.oneOfAKind && compare(applied.quantityAfter, '1') > 0) {
        throw errors.conflict(
          'one_of_a_kind',
          'This item is one of a kind and already has a unit in stock.',
        );
      }
    }
    const moves: StockMove[] = units.map((u, i) => ({
      variantId: u.plan.line.variant_id,
      quantity: u.quantity,
      lotId: u.plan.lotId,
      serialId: u.serialId,
      from: null,
      to: { locationId, condition: 'quarantine', transferId: null },
      cost: { unitCost: costs[i]!.unitCost, costBasis: costs[i]!.costBasis },
      pack: u.plan.pack,
    }));
    const applied = await applyMoves(ctx, operationId, moves);
    await syncSerials(ctx, operationId, applied);
    // A one-of-a-kind item that comes back is in stock again (D5).
    const oneOfAKind = [
      ...new Set(plans.filter((p) => p.variant.oneOfAKind).map((p) => p.variant.productId)),
    ];
    if (oneOfAKind.length > 0) {
      await ctx.tx.query(
        `update products set status = 'active', updated_at = now(), version = version + 1
         where id = any($1::uuid[]) and status = 'sold'`,
        [oneOfAKind],
      );
    }

    await ctx.tx.query(
      `insert into return_units (shop_id, id, return_id, line_id, variant_id, lot_id, serial_id,
         received, matched, unit_cost, cost_source)
       select app_shop_id(), x.id, $2, x."lineId", x."variantId", x."lotId", x."serialId",
         x.quantity, x.matched, x."unitCost", x.source
       from jsonb_to_recordset($1::jsonb) as x(id uuid, "lineId" uuid, "variantId" uuid,
         "lotId" uuid, "serialId" uuid, quantity numeric, matched boolean, "unitCost" numeric,
         source text)
       on conflict (shop_id, line_id, lot_id, serial_id)
       do update set received = return_units.received + excluded.received`,
      [
        JSON.stringify(
          units.map((u, i) => ({
            id: ctx.newId(),
            lineId: u.plan.line.id,
            variantId: u.plan.line.variant_id,
            lotId: u.plan.lotId,
            serialId: u.serialId,
            quantity: u.quantity,
            matched: u.matched,
            unitCost: costs[i]!.unitCost,
            source: costs[i]!.source,
          })),
        ),
        r.id,
      ],
    );
    await ctx.tx.query(
      `update return_lines l set received = l.received + x.quantity
       from jsonb_to_recordset($1::jsonb) as x(id uuid, quantity numeric)
       where l.shop_id = app_shop_id() and l.id = x.id`,
      [JSON.stringify(plans.map((p) => ({ id: p.line.id, quantity: p.quantity })))],
    );
    await ctx.tx.query(
      `update returns set location_id = $2, received_at = coalesce(received_at, now()),
         exception_open = exception_open or $3,
         exception_note = case when $3 then $4 else exception_note end
       where id = $1`,
      [
        r.id,
        locationId,
        flagged.length > 0,
        flagged.length > 0
          ? `Not fulfilled from this shop, review: ${flagged.map((f) => f.serial).join(', ')}`.slice(
              0,
              2000,
            )
          : null,
      ],
    );
    const status = await refreshReturn(ctx, r.id);
    return {
      result: { operationId, return: await loadReturn(ctx, r.id), flagged },
      audit: {
        targetType: 'return',
        targetId: r.id,
        operationId,
        locationIds: [locationId],
        externalRef: r.order_ref,
        reason: input.reason ?? null,
        changes: {
          locationId,
          lines: plans.map((p) => ({
            lineId: p.line.id,
            variantId: p.line.variant_id,
            quantity: p.quantity,
            entered: p.pack,
          })),
          units: units.map((u, i) => ({
            variantId: u.plan.line.variant_id,
            lotId: u.plan.lotId,
            serialId: u.serialId,
            quantity: u.quantity,
            matched: u.matched,
            costSource: costs[i]!.source,
          })),
          flagged,
          status: { returnId: r.id, ...status },
          restricted: {
            permission: 'costs.read',
            fields: { unitCosts: costs.map((c) => c.unitCost) },
          },
        },
      },
      webhooks: statusWebhook(r.id, status),
      events: [...lock.events],
    };
  },
});

// Inspect ---------------------------------------------------------------------------------------

const Inspection = z.object({
  variantId: Id,
  disposition: z
    .enum(DISPOSITIONS)
    .describe(
      'sellable: back to stock; damaged, repair, supplier_return: kept in that condition; disposal: written off.',
    ),
  quantity: PositiveDecimal.optional().describe(
    'Leave out for every uninspected unit of the line.',
  ),
  lotCode: LotCode.optional(),
  serials: Serials.optional(),
  note: z.string().trim().min(1).max(500).optional(),
});

export const inspectReturn = defineOperation({
  id: 'returns.inspect',
  summary: 'Inspect returned units: sellable, damaged, repair, supplier return, or disposal',
  description:
    'Use this after receiving a return, to decide what happens to each unit in quarantine. Sellable units go back into available stock (and fill open order shortages); damaged, repair, and supplier-return units stay on hand in that condition and are not available; disposal writes them off with an adjustment at the moving average. For example, "4 sellable, 2 damaged". Issues no refund.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    returnId: Id,
    inspections: z.array(Inspection).min(1).max(200),
    reason: Reason.optional(),
  }),
  output: CommandOut.extend({
    shortagesFilled: z.array(z.object({ reservationId: Id, quantity: z.string() })),
  }),
  permission: 'returns.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'return.inspected' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/returns/{returnId}/inspect' },
  mcp: { tool: TOOL, action: 'inspect', readOnly: false, destructive: true },
  locations: (input, tx) => returnLocation(tx, input.returnId),
  async handler(ctx, input) {
    const { r, lines } = await lockReturn(ctx, input.returnId);
    assertOpen(r);
    if (!r.location_id) {
      throw errors.conflict('return_not_received', 'Nothing of this return has arrived yet.');
    }
    const locationId = r.location_id;
    const unitRows = await ctx.tx.query<{
      id: string;
      line_id: string;
      variant_id: string;
      lot_id: string | null;
      serial_id: string | null;
      serial_normalized: string | null;
      matched: boolean | null;
      remaining: string;
    }>(
      `select u.id, u.line_id, u.variant_id, u.lot_id, u.serial_id, su.serial_normalized, u.matched,
         (u.received - u.inspected)::text as remaining
       from return_units u
       left join lots lt on lt.shop_id = u.shop_id and lt.id = u.lot_id
       left join serial_units su on su.shop_id = u.shop_id and su.id = u.serial_id
       where u.return_id = $1 and u.received > u.inspected
       order by lt.expires_on nulls last, u.id`,
      [r.id],
    );
    const left = new Map(unitRows.map((u) => [u.id, u.remaining]));
    const picks: Array<{
      unit: (typeof unitRows)[number];
      line: LineRow;
      disposition: Disposition;
      quantity: string;
      note: string | null;
    }> = [];
    for (const item of input.inspections) {
      const line = lines.find((l) => l.variant_id === item.variantId);
      if (!line) {
        throw errors.unprocessable('not_on_return', 'This variant is not on the return.', {
          variantId: item.variantId,
        });
      }
      let lotId: string | null = null;
      if (item.lotCode) {
        const [lot] = await ctx.tx.query<{ id: string }>(
          'select id from lots where variant_id = $1 and code_normalized = $2',
          [line.variant_id, normalizeCode(item.lotCode)],
        );
        if (!lot) throw errors.notFound('Lot');
        lotId = lot.id;
      }
      const serials = item.serials?.map(normalizeCode) ?? null;
      const mine = unitRows.filter(
        (u) =>
          u.line_id === line.id &&
          (lotId === null || u.lot_id === lotId) &&
          (serials === null || serials.includes(u.serial_normalized ?? '')),
      );
      const available = mine.reduce((s, u) => add(s, left.get(u.id) ?? '0'), '0');
      let quantity = item.quantity ?? (serials ? String(serials.length) : normalize(available));
      if (
        serials &&
        item.quantity !== undefined &&
        compare(item.quantity, String(serials.length)) !== 0
      ) {
        throw errors.unprocessable('serial_count_mismatch', 'Give one serial for each unit.');
      }
      quantity = normalize(quantity);
      if (compare(quantity, '0') <= 0 || compare(quantity, available) > 0) {
        throw errors.conflict(
          'quantity_exceeds_uninspected',
          'More units than are waiting for inspection on this line.',
          { variantId: line.variant_id, requested: quantity, uninspected: normalize(available) },
        );
      }
      let rest = quantity;
      for (const u of mine) {
        if (compare(rest, '0') <= 0) break;
        const have = left.get(u.id) ?? '0';
        if (compare(have, '0') <= 0) continue;
        const take = compare(have, rest) < 0 ? have : rest;
        picks.push({
          unit: u,
          line,
          disposition: item.disposition,
          quantity: normalize(take),
          note: item.note ?? null,
        });
        left.set(u.id, normalize(subtract(have, take)));
        rest = normalize(subtract(rest, take));
      }
    }

    // A serial that was not fulfilled from this shop goes back on sale only after a person
    // reviewed it and cleared the exception (ADR 0029); other dispositions may go ahead.
    const unreviewed = picks.filter(
      (p) => p.disposition === 'sellable' && p.unit.matched === false && r.exception_open,
    );
    if (unreviewed.length > 0) {
      throw errors.conflict(
        'exception_open',
        'A flagged serial cannot be made sellable before the exception is reviewed and cleared.',
        {
          serials: unreviewed.map((p) => p.unit.serial_normalized),
        },
      );
    }

    // 1–2. The quarantine positions, the sellable ones that receive units, and open shortages.
    const fromKeys: PositionKey[] = picks.map((p) => ({
      variantId: p.unit.variant_id,
      locationId,
      condition: 'quarantine',
      lotId: p.unit.lot_id,
      serialId: p.unit.serial_id,
      transferId: null,
    }));
    const toKeys: PositionKey[] = picks
      .filter((p) => p.disposition !== 'disposal')
      .map((p) => ({
        variantId: p.unit.variant_id,
        locationId,
        condition: p.disposition,
        lotId: p.unit.lot_id,
        serialId: p.unit.serial_id,
        transferId: null,
      }));
    const sources = await findPositions(ctx.tx, fromKeys);
    const targets = await findPositions(ctx.tx, toKeys);
    const sellableVariants = [
      ...new Set(picks.filter((p) => p.disposition === 'sellable').map((p) => p.unit.variant_id)),
    ];
    const lock = await lockStock(
      ctx,
      [...sources.map((s) => s.id), ...targets.map((t) => t.id)],
      await openShortageReservations(ctx.tx, sellableVariants),
    );
    const current = await ctx.tx.query<{
      id: string;
      variant_id: string;
      lot_id: string | null;
      serial_id: string | null;
      free: string;
      received_at: string | null;
    }>(
      `select id, variant_id, lot_id, serial_id, (on_hand - allocated)::text as free,
         to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as received_at
       from inventory_positions where id = any($1::uuid[])`,
      [sources.map((s) => s.id)],
    );
    const sourceOf = (p: (typeof picks)[number]) =>
      current.find(
        (c) =>
          c.variant_id === p.unit.variant_id &&
          c.lot_id === p.unit.lot_id &&
          c.serial_id === p.unit.serial_id,
      );
    const need = new Map<string, string>();
    for (const p of picks) {
      const src = sourceOf(p);
      if (!src || !lock.locked.has(src.id)) {
        throw errors.conflict(
          'quarantine_short',
          'The returned units are no longer in quarantine at the return’s location.',
          { variantId: p.unit.variant_id },
        );
      }
      need.set(src.id, normalize(add(need.get(src.id) ?? '0', p.quantity)));
    }
    for (const [id, q] of need) {
      const src = current.find((c) => c.id === id)!;
      if (compare(src.free, q) < 0) {
        throw errors.conflict(
          'quarantine_short',
          'Fewer returned units are in quarantine than inspected; someone moved or adjusted them.',
          { positionId: id, inQuarantine: src.free, inspected: q },
        );
      }
    }

    // Condition changes (no change to on hand or cost), then disposals (adjustments out).
    const changes = picks.filter((p) => p.disposition !== 'disposal');
    const disposals = picks.filter((p) => p.disposition === 'disposal');
    const operations: Record<string, string> = {};
    const insertOp = async (kind: 'condition_change' | 'adjustment', reason: string | null) => {
      const id = ctx.newId();
      await ctx.tx.query(
        `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source,
           attempt_id, external_ref, reason, return_id)
         values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, kind, ...actorColumns(ctx), r.order_ref ?? r.reference, reason, r.id],
      );
      return id;
    };
    let appliedChanges: AppliedMove[] = [];
    if (changes.length > 0) {
      operations.conditionChange = await insertOp('condition_change', input.reason ?? null);
      appliedChanges = await applyMoves(
        ctx,
        operations.conditionChange,
        changes.map((p) => {
          const src = sourceOf(p)!;
          return {
            variantId: p.unit.variant_id,
            quantity: p.quantity,
            lotId: p.unit.lot_id,
            serialId: p.unit.serial_id,
            from: { positionId: src.id, locationId, receivedAt: src.received_at },
            to: { locationId, condition: p.disposition, transferId: null },
          };
        }),
      );
      await syncSerials(ctx, operations.conditionChange, appliedChanges);
    }
    let appliedDisposals: AppliedMove[] = [];
    if (disposals.length > 0) {
      operations.disposal = await insertOp('adjustment', 'write_off');
      const costs = new Map<string, { unitCost: string | null; costBasis: string }>();
      for (const variantId of [...new Set(disposals.map((d) => d.unit.variant_id))].sort()) {
        const total = disposals
          .filter((d) => d.unit.variant_id === variantId)
          .reduce((s, d) => add(s, d.quantity), '0');
        costs.set(
          variantId,
          await applyStockCost(
            ctx,
            variantId,
            operations.disposal,
            'adjustment',
            `-${normalize(total)}`,
            null,
          ),
        );
      }
      appliedDisposals = await applyMoves(
        ctx,
        operations.disposal,
        disposals.map((p) => {
          const src = sourceOf(p)!;
          return {
            variantId: p.unit.variant_id,
            quantity: p.quantity,
            lotId: p.unit.lot_id,
            serialId: p.unit.serial_id,
            from: { positionId: src.id, locationId, receivedAt: src.received_at },
            to: null,
            cost: costs.get(p.unit.variant_id) ?? null,
          };
        }),
      );
      await syncSerials(ctx, operations.disposal, appliedDisposals, 'written_off');
    }
    await ctx.tx.query(
      `insert into return_inspections (shop_id, id, return_id, line_id, unit_id, operation_id,
         disposition, quantity, note)
       select app_shop_id(), x.id, $2, x."lineId", x."unitId", x."operationId", x.disposition,
         x.quantity, x.note
       from jsonb_to_recordset($1::jsonb) as x(id uuid, "lineId" uuid, "unitId" uuid,
         "operationId" uuid, disposition text, quantity numeric, note text)`,
      [
        JSON.stringify(
          picks.map((p) => ({
            id: ctx.newId(),
            lineId: p.line.id,
            unitId: p.unit.id,
            operationId:
              p.disposition === 'disposal' ? operations.disposal : operations.conditionChange,
            disposition: p.disposition,
            quantity: p.quantity,
            note: p.note,
          })),
        ),
        r.id,
      ],
    );
    await ctx.tx.query(
      `update return_units u set inspected = u.inspected + x.quantity
       from (select "unitId", sum(quantity) as quantity
             from jsonb_to_recordset($1::jsonb) as y("unitId" uuid, quantity numeric)
             group by "unitId") x
       where u.shop_id = app_shop_id() and u.id = x."unitId"`,
      [JSON.stringify(picks.map((p) => ({ unitId: p.unit.id, quantity: p.quantity })))],
    );
    for (const d of DISPOSITIONS) {
      const rows = picks.filter((p) => p.disposition === d);
      if (rows.length === 0) continue;
      await ctx.tx.query(
        `update return_lines l set ${DISPOSITION_COLUMN[d]} = l.${DISPOSITION_COLUMN[d]} + x.quantity
         from (select id, sum(quantity) as quantity
               from jsonb_to_recordset($1::jsonb) as y(id uuid, quantity numeric) group by id) x
         where l.shop_id = app_shop_id() and l.id = x.id`,
        [JSON.stringify(rows.map((p) => ({ id: p.line.id, quantity: p.quantity })))],
      );
    }
    // Units released to sellable fill open order shortages first (D6).
    const shortagesFilled: Array<{ reservationId: string; quantity: string }> = [];
    const events = [...lock.events];
    for (const variantId of sellableVariants) {
      const positions = [
        ...new Set(
          appliedChanges
            .filter((m) => m.variantId === variantId && m.to?.condition === 'sellable')
            .map((m) => m.toPositionId!),
        ),
      ];
      const filled = await fillShortages(ctx, variantId, positions);
      events.push(...filled.events);
      shortagesFilled.push(
        ...filled.fills.map((f) => ({ reservationId: f.reservationId, quantity: f.quantity })),
      );
    }
    const status = await refreshReturn(ctx, r.id);
    const operationId = operations.conditionChange ?? operations.disposal ?? null;
    return {
      result: { operationId, return: await loadReturn(ctx, r.id), shortagesFilled },
      audit: {
        targetType: 'return',
        targetId: r.id,
        operationId,
        locationIds: [locationId],
        externalRef: r.order_ref,
        reason: input.reason ?? null,
        changes: {
          operations,
          inspections: picks.map((p) => ({
            lineId: p.line.id,
            variantId: p.unit.variant_id,
            lotId: p.unit.lot_id,
            serialId: p.unit.serial_id,
            disposition: p.disposition,
            quantity: p.quantity,
            note: p.note,
          })),
          shortagesFilled,
          status: { returnId: r.id, ...status },
        },
      },
      outbox: sellableVariants.map((variantId) => ({
        topic: 'inventory.availability_changed',
        payload: { variantId, locationIds: [locationId] },
      })),
      webhooks: statusWebhook(r.id, status),
      events,
    };
  },
});

// Complete, cancel, exception --------------------------------------------------------------------

export const completeReturn = defineOperation({
  id: 'returns.complete',
  summary: 'Complete a return with what arrived',
  description:
    'Use this to close a return when the rest of the expected units will not come back. Every received unit must be inspected first. Changes no stock.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ returnId: Id, reason: Reason.optional() }),
  output: CommandOut,
  permission: 'returns.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'return.completed' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/returns/{returnId}/complete' },
  mcp: { tool: TOOL, action: 'complete', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const { r, lines } = await lockReturn(ctx, input.returnId);
    await requireReturnInScope(ctx, r);
    assertOpen(r);
    if (!lines.some((l) => compare(l.received, '0') > 0)) {
      throw errors.conflict('return_not_received', 'Nothing arrived; cancel the return instead.');
    }
    if (lines.some((l) => compare(l.inspected, l.received) < 0)) {
      throw errors.conflict('inspection_pending', 'Inspect every received unit first.');
    }
    if (r.exception_open) {
      throw errors.conflict('exception_open', 'Review the open exception first.');
    }
    await ctx.tx.query('update returns set closed = true where id = $1', [r.id]);
    const status = await refreshReturn(ctx, r.id);
    return {
      result: { operationId: null, return: await loadReturn(ctx, r.id) },
      audit: {
        targetType: 'return',
        targetId: r.id,
        externalRef: r.order_ref,
        reason: input.reason ?? null,
        changes: { status: { returnId: r.id, ...status } },
      },
      webhooks: statusWebhook(r.id, status),
    };
  },
});

export const cancelReturn = defineOperation({
  id: 'returns.cancel',
  summary: 'Cancel a return before anything arrives',
  description:
    'Use this when a requested or authorized return will not come back at all. Changes no stock; once units have arrived, inspect them and complete the return instead.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ returnId: Id, reason: Reason.optional() }),
  output: CommandOut,
  permission: 'returns.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'return.cancelled' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/returns/{returnId}/cancel' },
  mcp: { tool: TOOL, action: 'cancel', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const { r, lines } = await lockReturn(ctx, input.returnId);
    await requireReturnInScope(ctx, r);
    assertOpen(r);
    if (lines.some((l) => compare(l.received, '0') > 0)) {
      throw errors.conflict(
        'return_received',
        'Units of this return have arrived; inspect them and complete the return.',
      );
    }
    await ctx.tx.query(
      'update returns set cancelled_at = now(), exception_open = false where id = $1',
      [r.id],
    );
    const status = await refreshReturn(ctx, r.id);
    return {
      result: { operationId: null, return: await loadReturn(ctx, r.id) },
      audit: {
        targetType: 'return',
        targetId: r.id,
        externalRef: r.order_ref,
        reason: input.reason ?? null,
        changes: { status: { returnId: r.id, ...status } },
      },
      webhooks: statusWebhook(r.id, status),
    };
  },
});

export const setReturnException = defineOperation({
  id: 'returns.exception',
  summary: 'Flag a return for review, or clear the flag',
  description:
    'Use this to mark a problem with a return (wrong item, missing parts, a serial that does not match) with a note, or with open: false to clear it once reviewed, for example after checking a flagged serial. Changes no stock.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    returnId: Id,
    note: Note,
    open: z.boolean().default(true).describe('false clears the flag after review.'),
  }),
  output: CommandOut,
  permission: 'returns.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'return.exception_set' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/returns/{returnId}/exception' },
  mcp: { tool: TOOL, action: 'exception', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const { r } = await lockReturn(ctx, input.returnId);
    await requireReturnInScope(ctx, r);
    assertOpen(r);
    await ctx.tx.query(
      'update returns set exception_open = $2, exception_note = case when $2 then $3 end where id = $1',
      [r.id, input.open, input.note],
    );
    const status = await refreshReturn(ctx, r.id);
    return {
      result: { operationId: null, return: await loadReturn(ctx, r.id) },
      audit: {
        targetType: 'return',
        targetId: r.id,
        externalRef: r.order_ref,
        reason: input.note,
        changes: { open: input.open, status: { returnId: r.id, ...status } },
      },
      webhooks: statusWebhook(r.id, status),
    };
  },
});

// Reads -----------------------------------------------------------------------------------------

const SCOPE_FILTER = `($1::uuid[] is null or r.location_id is null or exists (select 1 from locations sl
  where sl.shop_id = r.shop_id and sl.id = r.location_id and sl.path_ids && $1::uuid[]))`;

export const getReturn = defineOperation({
  id: 'returns.get',
  summary: 'Show one return with its lines',
  description:
    'Use this to see a return: expected, received, and inspected units per line, how they were dispositioned, the serials and lots that came back (flagged ones need review), and the status.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ returnId: Id }),
  output: ReturnOut,
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'return.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/returns/{returnId}' },
  mcp: { tool: TOOL, action: 'get', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const [row] = await ctx.tx.query<ReturnView>(
      `${RETURN_SQL} where ${SCOPE_FILTER} and r.id = $2`,
      [ctx.locationScope, input.returnId],
    );
    if (!row) throw errors.notFound('Return');
    return {
      result: hideCosts(ctx, row),
      audit: {
        targetType: 'return',
        targetId: row.returnId,
        locationIds: row.location ? [row.location.locationId] : [],
        context: { input },
      },
    };
  },
});

export const listReturns = defineOperation({
  id: 'returns.list',
  summary: 'List returns',
  description:
    'Use this to find returns: open ones by default (requested to inspecting, and exceptions), newest first. Filter by status, order reference, or variant. Page with `before`.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    status: z.enum(['open', 'closed', 'all', ...ReturnStatus.options]).default('open'),
    orderRef: Reference.optional(),
    variantId: Id.optional(),
    before: Id.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  output: z.object({ returns: z.array(ReturnOut), next: Id.nullable() }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'returns.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/returns' },
  mcp: { tool: TOOL, action: 'list', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const rows = await ctx.tx.query<ReturnView>(
      `${RETURN_SQL}
       where ${SCOPE_FILTER}
         and case $2::text
           when 'open' then r.status not in ('completed', 'cancelled')
           when 'closed' then r.status in ('completed', 'cancelled')
           when 'all' then true
           else r.status = $2::text end
         and ($3::text is null or r.order_ref = $3)
         and ($4::uuid is null or exists (select 1 from return_lines x
           where x.shop_id = r.shop_id and x.return_id = r.id and x.variant_id = $4))
         and ($5::uuid is null or r.id < $5)
       order by r.id desc
       limit $6`,
      [
        ctx.locationScope,
        input.status,
        input.orderRef ?? null,
        input.variantId ?? null,
        input.before ?? null,
        input.limit,
      ],
    );
    return {
      result: {
        returns: rows.map((row) => hideCosts(ctx, row)),
        next: rows.length === input.limit ? (rows.at(-1)?.returnId ?? null) : null,
      },
      audit: {
        targetType: 'shop',
        targetId: ctx.shopId,
        context: { input, count: rows.length },
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const returnsOperations = [
  createReturn,
  authorizeReturn,
  markReturnInTransit,
  receiveReturn,
  inspectReturn,
  completeReturn,
  cancelReturn,
  setReturnException,
  listReturns,
  getReturn,
] as const;
