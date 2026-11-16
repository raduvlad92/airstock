import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { compare } from '../catalog/decimal.ts';
import { PositiveDecimal } from '../decimal.ts';
import { AppError, errors } from '../errors.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id } from '../schemas.ts';
import { actorColumns, canSeeCosts } from '../stock/engine.ts';
import {
  type AppliedMove,
  inTransitLocation,
  lockStock,
  openShortageReservations,
} from '../stock/moves.ts';
import {
  cancelItems,
  destinationLeaf,
  dispatchItems,
  held,
  inScope,
  insertLines,
  insertOperation,
  inTransit,
  type LineRow,
  loadLocation,
  lockTransfer,
  placeHolds,
  prepareLines,
  RESOLUTION_REASON,
  readLines,
  readyCandidates,
  receiveItems,
  refreshTransfer,
  requireEitherInScope,
  resolveItems,
  settleItems,
  type TransferRow,
} from '../stock/transfers.ts';
import { webhookEvent } from '../webhooks/events.ts';
import { LotCode, StockCondition } from './inventory.ts';

// Transfers (plan D8, PRD 6.4, ADR "Transfers"): draft, ready (typed transfer holds), dispatch
// into transit, receipt at the destination, cancellation of the undispatched remainder, exception
// reports and resolutions, and a move within a warehouse in one command. The engine and the lock
// order are in stock/transfers.ts.

const TOOL = 'transfer_stock';

const Reference = z.string().trim().min(1).max(200);
const Note = z.string().trim().min(1).max(2000);
const Reason = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe('Why, in a few words; kept in the history.');
const Serials = z.array(z.string().trim().min(1).max(100)).min(1).max(500);

const LineInput = z.object({
  variantId: Id,
  quantity: PositiveDecimal.describe('Base units, or packs when packId is set.'),
  packId: Id.optional().describe('Enter the quantity in one of the variant’s packs.'),
  lotCode: LotCode.optional().describe('Move only this lot.'),
  serials: Serials.optional().describe('Serial-tracked variants: exactly these serials.'),
  condition: StockCondition.default('sellable').describe(
    'Which stock to move; transfers keep the condition.',
  ),
});

const ItemInput = z.object({
  variantId: Id.describe('The line’s variant; a transfer has one line per variant.'),
  quantity: PositiveDecimal.optional().describe(
    'Base units, or packs with packId. Leave out for everything this step allows.',
  ),
  packId: Id.optional(),
  lotCode: LotCode.optional().describe('Only units of this lot.'),
  serials: Serials.optional().describe('Exactly these serials (scanned or typed).'),
});

const Lines = z.array(LineInput).min(1).max(200);
const Items = z
  .array(ItemInput)
  .min(1)
  .max(200)
  .optional()
  .describe('Per line; leave out to act on every line in full.');

const Quantities = z.object({
  planned: z.string(),
  cancelled: z.string(),
  dispatched: z.string(),
  received: z.string(),
  resolved: z.string().describe('Settled by an exception resolution (lost, damaged, short).'),
  held: z.string().describe('Still held at the source, waiting for dispatch.'),
  inTransit: z.string(),
});

const LocationOut = z.object({ locationId: Id, path: z.string(), warehouseId: Id.nullable() });

export const TransferOut = z.object({
  transferId: Id,
  kind: z.enum(['transfer', 'move']),
  reference: z.string().nullable(),
  trackingReference: z.string().nullable(),
  note: z.string().nullable(),
  status: z.enum([
    'draft',
    'ready',
    'partially_dispatched',
    'dispatched',
    'partially_received',
    'received',
    'cancelled',
    'exception',
  ]),
  from: LocationOut,
  to: LocationOut,
  exception: z.object({ open: z.boolean(), note: z.string().nullable() }),
  createdAt: z.string(),
  readyAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  version: z.number(),
  totals: Quantities,
  lines: z.array(
    Quantities.extend({
      lineId: Id,
      variantId: Id,
      sku: z.string(),
      name: z.string(),
      condition: StockCondition,
      lotCode: z.string().nullable(),
      serials: z.array(z.string()).nullable().describe('Serials named when the line was made.'),
      entered: z
        .object({ packId: Id, packName: z.string(), quantity: z.string(), factor: z.string() })
        .nullable(),
      reservationId: Id.nullable().describe('The transfer hold at the source.'),
      inTransitUnits: z.array(
        z.object({
          lotCode: z.string().nullable(),
          serial: z.string().nullable(),
          quantity: z.string(),
        }),
      ),
    }),
  ),
});
type Transfer = z.infer<typeof TransferOut>;

const tsSql = (c: string) => `to_char(${c} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** One transfer with its lines, as every transfer command and read returns it. */
const TRANSFER_SQL = `
  select t.id as "transferId", t.kind, t.reference, t.tracking_reference as "trackingReference",
    t.note, t.status,
    json_build_object('locationId', fl.id, 'path', fl.path, 'warehouseId', fl.warehouse_id) as "from",
    json_build_object('locationId', tl.id, 'path', tl.path, 'warehouseId', tl.warehouse_id) as "to",
    json_build_object('open', t.exception_open, 'note', t.exception_note) as exception,
    ${tsSql('t.created_at')} as "createdAt", ${tsSql('t.ready_at')} as "readyAt",
    ${tsSql('t.closed_at')} as "closedAt", t.version,
    (select json_build_object(
       'planned', coalesce(sum(l.planned), 0)::text, 'cancelled', coalesce(sum(l.cancelled), 0)::text,
       'dispatched', coalesce(sum(l.dispatched), 0)::text, 'received', coalesce(sum(l.received), 0)::text,
       'resolved', coalesce(sum(l.resolved), 0)::text,
       'held', coalesce(sum(case when t.ready_at is null then 0 else l.planned - l.cancelled - l.dispatched end), 0)::text,
       'inTransit', coalesce(sum(l.dispatched - l.received - l.resolved), 0)::text)
     from transfer_lines l where l.shop_id = t.shop_id and l.transfer_id = t.id) as totals,
    coalesce((select json_agg(json_build_object(
       'lineId', l.id, 'variantId', l.variant_id, 'sku', v.sku, 'name', p.name,
       'condition', l.condition, 'lotCode', lt.code,
       'serials', (select json_agg(su.serial order by su.serial) from serial_units su
          where su.shop_id = l.shop_id and su.id = any(l.serial_ids)),
       'entered', case when l.pack_id is null then null else json_build_object('packId', l.pack_id,
          'packName', pk.name, 'quantity', l.entered_quantity::text, 'factor', l.conversion_factor::text) end,
       'reservationId', l.reservation_id,
       'planned', l.planned::text, 'cancelled', l.cancelled::text, 'dispatched', l.dispatched::text,
       'received', l.received::text, 'resolved', l.resolved::text,
       'held', (case when t.ready_at is null then 0 else l.planned - l.cancelled - l.dispatched end)::text,
       'inTransit', (l.dispatched - l.received - l.resolved)::text,
       'inTransitUnits', coalesce((select json_agg(json_build_object('lotCode', ilt.code,
            'serial', isu.serial, 'quantity', ip.on_hand::text) order by ilt.code, isu.serial)
          from inventory_positions ip
          left join lots ilt on ilt.shop_id = ip.shop_id and ilt.id = ip.lot_id
          left join serial_units isu on isu.shop_id = ip.shop_id and isu.id = ip.serial_id
          where ip.shop_id = l.shop_id and ip.transfer_id = l.transfer_id
            and ip.variant_id = l.variant_id and ip.on_hand > 0), '[]'::json))
       order by l.position)
     from transfer_lines l
     join variants v on v.shop_id = l.shop_id and v.id = l.variant_id
     join products p on p.shop_id = v.shop_id and p.id = v.product_id
     left join lots lt on lt.shop_id = l.shop_id and lt.id = l.lot_id
     left join packs pk on pk.shop_id = l.shop_id and pk.id = l.pack_id
     where l.shop_id = t.shop_id and l.transfer_id = t.id), '[]'::json) as lines
  from transfers t
  join locations fl on fl.shop_id = t.shop_id and fl.id = t.from_location_id
  join locations tl on tl.shop_id = t.shop_id and tl.id = t.to_location_id`;

export async function loadTransfer(tx: Tx, transferId: string): Promise<Transfer> {
  const [row] = await tx.query<Transfer>(`${TRANSFER_SQL} where t.id = $1`, [transferId]);
  if (!row) throw errors.notFound('Transfer');
  return row;
}

const CommandOut = z.object({
  operationId: Id.nullable().describe('The stock operation this step recorded, if it moved stock.'),
  transfer: TransferOut,
});

/** The transfer's source, for the pipeline's location-scope check (empty when unknown). */
async function sourceOf(tx: Tx, transferId: string): Promise<string[]> {
  const [row] = await tx.query<{ id: string }>(
    'select from_location_id as id from transfers where id = $1',
    [transferId],
  );
  return row ? [row.id] : [];
}

function assertReadied(t: TransferRow): void {
  if (!t.ready_at) {
    throw errors.conflict(
      'transfer_not_ready',
      'Make the transfer ready first: that holds the stock.',
      {
        status: t.status,
      },
    );
  }
}

function assertNotClosed(t: TransferRow): void {
  if (t.status === 'cancelled' || t.status === 'received') {
    throw errors.conflict('transfer_closed', `The transfer is ${t.status}.`, { status: t.status });
  }
}

function moveLocations(moves: AppliedMove[]): string[] {
  return [
    ...new Set(
      moves.flatMap((m) => [
        ...(m.from ? [m.from.locationId] : []),
        ...(m.to ? [m.to.locationId] : []),
      ]),
    ),
  ];
}

function availabilityOutbox(moves: AppliedMove[], transitId: string) {
  const byVariant = new Map<string, Set<string>>();
  for (const m of moves) {
    const set = byVariant.get(m.variantId) ?? new Set<string>();
    for (const l of [m.from?.locationId, m.to?.locationId]) if (l && l !== transitId) set.add(l);
    byVariant.set(m.variantId, set);
  }
  return [...byVariant]
    .filter(([, locations]) => locations.size > 0)
    .map(([variantId, locations]) => ({
      topic: 'inventory.availability_changed',
      payload: { variantId, locationIds: [...locations] },
    }));
}

function movedOut(moves: AppliedMove[]) {
  return moves.map((m) => ({
    variantId: m.variantId,
    quantity: m.quantity,
    lotId: m.lotId,
    serialId: m.serialId,
    fromPositionId: m.from?.positionId ?? null,
    toPositionId: m.toPositionId,
  }));
}

function statusChange(transferId: string, status: { from: string; to: string }) {
  return { transferId, from: status.from, to: status.to };
}

/** transfer.status_changed, written with the change when the summary status moved (D14). */
function statusWebhook(transferId: string, status: { from: string | null; to: string }) {
  return status.from === status.to
    ? []
    : [webhookEvent('transfer.status_changed', { transferId, from: status.from, to: status.to })];
}

async function checkPair(ctx: HandlerContext, fromId: string, toId: string) {
  if (fromId === toId) {
    throw errors.unprocessable('same_location', 'The source and destination are the same.');
  }
  const from = await loadLocation(ctx.tx, fromId);
  const to = await loadLocation(ctx.tx, toId);
  if (from.status !== 'active' || to.status !== 'active') {
    throw errors.conflict('location_archived', 'The source or destination is archived.');
  }
  if (from.path_ids.includes(to.id) || to.path_ids.includes(from.id)) {
    throw errors.unprocessable(
      'locations_overlap',
      'The source and destination contain each other; pick two separate locations.',
    );
  }
  return { from, to };
}

// Create ----------------------------------------------------------------------------------------

export const createTransfer = defineOperation({
  id: 'inventory.transfers.create',
  summary: 'Create a transfer between locations',
  description:
    'Use this to plan sending stock from one location or warehouse to another, such as restocking a store from the warehouse. Creates a draft with one line per variant (quantities in base units or packs, optionally a lot or exact serials); a draft holds no stock. Set ready: true to hold the stock at the source at once. Not for a shelf-to-shelf move inside one warehouse that happens right now (use action "move"), and not for orders (use manage_reservations).',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    fromLocationId: Id.describe('Stock is taken from this location and its sub-locations.'),
    toLocationId: Id.describe('Units arrive here, or at a shelf inside it.'),
    lines: Lines,
    reference: Reference.optional().describe('Your transfer number or another reference.'),
    trackingReference: Reference.optional().describe('A carrier tracking number.'),
    note: Note.optional(),
    ready: z.boolean().optional().describe('Also hold the stock at the source now.'),
  }),
  output: CommandOut,
  permission: 'inventory.transfer',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.transfer.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/transfers', status: 201 },
  mcp: { tool: TOOL, action: 'create', readOnly: false, destructive: false },
  // Ready holds stock at the source, so it needs the source in scope (PRD 2.4).
  locations: (input) => (input.ready ? [input.fromLocationId] : []),
  async handler(ctx, input) {
    const { from, to } = await checkPair(ctx, input.fromLocationId, input.toLocationId);
    const ok = await inScope(ctx.tx, ctx.locationScope, [from.id, to.id]);
    if (!ok.some(Boolean)) {
      throw new AppError(
        403,
        'location_out_of_scope',
        'You do not have access to the source or the destination.',
        'denied',
      );
    }
    const prepared = await prepareLines(ctx, input.lines);
    const transferId = ctx.newId();
    await ctx.tx.query(
      `insert into transfers (shop_id, id, kind, reference, tracking_reference, note,
         from_location_id, to_location_id, created_by_type, created_by_id)
       values (app_shop_id(), $1, 'transfer', $2, $3, $4, $5, $6, $7, $8)`,
      [
        transferId,
        input.reference ?? null,
        input.trackingReference ?? null,
        input.note ?? null,
        from.id,
        to.id,
        ctx.caller.kind,
        ctx.caller.id,
      ],
    );
    await insertLines(ctx, transferId, prepared);
    let operationId: string | null = null;
    let events: Awaited<ReturnType<typeof lockStock>>['events'] = [];
    let holds: Awaited<ReturnType<typeof placeHolds>> = [];
    if (input.ready) {
      const { t, lines } = await lockTransfer(ctx.tx, transferId);
      const lock = await lockStock(ctx, await readyCandidates(ctx.tx, t, lines));
      events = lock.events;
      operationId = await insertOperation(ctx, 'reservation', t, null);
      holds = await placeHolds(ctx, t, lines, lock.locked, operationId);
    }
    const status = await refreshTransfer(ctx, transferId);
    const transfer = await loadTransfer(ctx.tx, transferId);
    const locationIds = [...new Set([from.id, to.id, ...holds.map((h) => h.locationId)])];
    return {
      webhooks: statusWebhook(transferId, { from: null, to: status.to }),
      result: { operationId, transfer },
      audit: {
        targetType: 'transfer',
        targetId: transferId,
        operationId,
        locationIds,
        externalRef: input.reference ?? null,
        reason: input.note ?? null,
        changes: {
          from: from.id,
          to: to.id,
          lines: prepared.map((l) => ({
            lineId: l.id,
            variantId: l.variantId,
            planned: l.planned,
            condition: l.condition,
            lotId: l.lotId,
            serialIds: l.serialIds,
            entered: l.pack,
          })),
          holds,
          status: statusChange(transferId, { from: 'new', to: status.to }),
        },
      },
      outbox:
        holds.length > 0
          ? [...new Set(holds.map((h) => h.variantId))].map((variantId) => ({
              topic: 'inventory.availability_changed',
              payload: {
                variantId,
                locationIds: [
                  ...new Set(
                    holds.filter((h) => h.variantId === variantId).map((h) => h.locationId),
                  ),
                ],
              },
            }))
          : [],
      events,
    };
  },
});

// Ready -----------------------------------------------------------------------------------------

const TransferRef = z.object({ transferId: Id });

export const readyTransfer = defineOperation({
  id: 'inventory.transfers.ready',
  summary: 'Make a transfer ready: hold its stock at the source',
  description:
    'Use this when a draft transfer should go ahead. Places transfer holds on concrete source positions (earliest expiry, then oldest stock first; expired lots only when the line names them), so the units are unavailable to every other caller until they are dispatched or the transfer is cancelled. Fails whole if the source lacks free stock for any line.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ transferId: Id, reason: Reason.optional() }),
  output: CommandOut,
  permission: 'inventory.transfer',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.transfer.readied' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/transfers/{transferId}/ready' },
  mcp: { tool: TOOL, action: 'ready', readOnly: false, destructive: false },
  locations: (input, tx) => sourceOf(tx, input.transferId),
  async handler(ctx, input) {
    const { t, lines } = await lockTransfer(ctx.tx, input.transferId);
    if (t.status !== 'draft') {
      throw errors.conflict('transfer_not_draft', `The transfer is already ${t.status}.`, {
        status: t.status,
      });
    }
    // Variants first (key share), as every stock command does; archived variants cannot move.
    await prepareCheck(ctx, lines);
    const lock = await lockStock(ctx, await readyCandidates(ctx.tx, t, lines));
    const operationId = await insertOperation(ctx, 'reservation', t, input.reason ?? null);
    const holds = await placeHolds(ctx, t, lines, lock.locked, operationId);
    const status = await refreshTransfer(ctx, t.id);
    const transfer = await loadTransfer(ctx.tx, t.id);
    const locationIds = [...new Set(holds.map((h) => h.locationId))];
    return {
      webhooks: statusWebhook(t.id, status),
      result: { operationId, transfer },
      audit: {
        targetType: 'transfer',
        targetId: t.id,
        operationId,
        locationIds,
        externalRef: t.reference,
        reason: input.reason ?? null,
        changes: {
          holds: holds.map((h) => ({
            reservationId: h.reservationId,
            allocationId: h.allocationId,
            positionId: h.positionId,
            lotId: h.lotId,
            serialId: h.serialId,
            quantity: h.quantity,
          })),
          status: statusChange(t.id, status),
        },
      },
      outbox: [...new Set(holds.map((h) => h.variantId))].map((variantId) => ({
        topic: 'inventory.availability_changed',
        payload: {
          variantId,
          locationIds: [
            ...new Set(holds.filter((h) => h.variantId === variantId).map((h) => h.locationId)),
          ],
        },
      })),
      events: lock.events,
    };
  },
});

/** Key-share locks on the lines' variants, in id order, refusing archived ones. */
async function prepareCheck(ctx: HandlerContext, lines: LineRow[]): Promise<void> {
  const ids = [...new Set(lines.map((l) => l.variant_id))].sort();
  const rows = await ctx.tx.query<{ id: string; status: string }>(
    'select id, status from variants where id = any($1::uuid[]) order by id for key share',
    [ids],
  );
  const archived = rows.filter((r) => r.status !== 'active').map((r) => r.id);
  if (archived.length > 0) {
    throw errors.conflict('variant_archived', 'A variant on the transfer is archived.', {
      variantIds: archived,
    });
  }
}

// Dispatch --------------------------------------------------------------------------------------

export const dispatchTransfer = defineOperation({
  id: 'inventory.transfers.dispatch',
  summary: 'Dispatch transfer units: take them out of the source into transit',
  description:
    'Use this when units physically leave the source. Consumes the transfer hold, removes the units from the source, and puts them in transit under this transfer, recording their lots and serials. Dispatch part of a line with items (quantity, or the scanned serials or lot); without items everything held is dispatched. Dispatch never exceeds what is held. Needs the source in your location scope.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    transferId: Id,
    items: Items,
    trackingReference: Reference.optional().describe('A carrier tracking number.'),
    reason: Reason.optional(),
  }),
  output: CommandOut,
  permission: 'inventory.transfer',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.transfer.dispatched' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/transfers/{transferId}/dispatch' },
  mcp: { tool: TOOL, action: 'dispatch', readOnly: false, destructive: false },
  locations: (input, tx) => sourceOf(tx, input.transferId),
  async handler(ctx, input) {
    const { t, lines } = await lockTransfer(ctx.tx, input.transferId);
    assertReadied(t);
    assertNotClosed(t);
    const items = await resolveItems(ctx, lines, input.items, (l) => (t.ready_at ? held(l) : '0'), {
      code: 'quantity_exceeds_held',
      message: 'Dispatch cannot exceed what the transfer still holds at the source.',
    });
    const operationId = await insertOperation(ctx, 'transfer_dispatch', t, input.reason ?? null);
    const { moves, events } = await dispatchItems(ctx, t, items, operationId, null);
    if (input.trackingReference) {
      await ctx.tx.query('update transfers set tracking_reference = $2 where id = $1', [
        t.id,
        input.trackingReference,
      ]);
    }
    const status = await refreshTransfer(ctx, t.id);
    const transfer = await loadTransfer(ctx.tx, t.id);
    const transit = await inTransitLocation(ctx.tx);
    return {
      webhooks: statusWebhook(t.id, status),
      result: { operationId, transfer },
      audit: {
        targetType: 'transfer',
        targetId: t.id,
        operationId,
        locationIds: moveLocations(moves),
        externalRef: t.reference,
        reason: input.reason ?? null,
        changes: {
          lines: items.map((i) => ({
            lineId: i.line.id,
            variantId: i.line.variant_id,
            quantity: i.quantity,
            entered: i.pack,
          })),
          moved: movedOut(moves),
          status: statusChange(t.id, status),
        },
      },
      outbox: availabilityOutbox(moves, transit),
      events,
    };
  },
});

// Receive ---------------------------------------------------------------------------------------

export const receiveTransfer = defineOperation({
  id: 'inventory.transfers.receive',
  summary: 'Receive transfer units at the destination',
  description:
    'Use this when dispatched units arrive. Moves the actual quantities out of transit into the destination (or the shelf named by locationId inside it); partial receipts leave the rest in transit. Units that arrived damaged can be received with condition "damaged". Received sellable units fill open order shortages first. If units are missing, report an exception and resolve it. Needs the destination in your location scope.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    transferId: Id,
    items: Items,
    locationId: Id.optional().describe(
      'The shelf to put the units on, inside the destination; needed when the destination has sub-locations.',
    ),
    condition: StockCondition.optional().describe(
      'Receive in this condition instead of the line’s, for example damaged.',
    ),
    reason: Reason.optional(),
  }),
  output: CommandOut.extend({
    shortagesFilled: z.array(z.object({ reservationId: Id, quantity: z.string() })),
  }),
  permission: 'inventory.transfer',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.transfer.received' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/transfers/{transferId}/receive' },
  mcp: { tool: TOOL, action: 'receive', readOnly: false, destructive: false },
  locations: async (input, tx) => {
    if (input.locationId) return [input.locationId];
    const [row] = await tx.query<{ id: string }>(
      'select to_location_id as id from transfers where id = $1',
      [input.transferId],
    );
    return row ? [row.id] : [];
  },
  async handler(ctx, input) {
    const { t, lines } = await lockTransfer(ctx.tx, input.transferId);
    assertReadied(t);
    const dest = await destinationLeaf(ctx.tx, t, input.locationId);
    const items = await resolveItems(ctx, lines, input.items, inTransit, {
      code: 'quantity_exceeds_in_transit',
      message: 'Receipt cannot exceed what is in transit on this transfer.',
    });
    const operationId = await insertOperation(ctx, 'transfer_receipt', t, input.reason ?? null);
    const { moves, events, shortagesFilled } = await receiveItems(
      ctx,
      t,
      items,
      dest,
      input.condition,
      operationId,
      null,
    );
    const status = await refreshTransfer(ctx, t.id);
    const transfer = await loadTransfer(ctx.tx, t.id);
    const transit = await inTransitLocation(ctx.tx);
    return {
      webhooks: statusWebhook(t.id, status),
      result: { operationId, transfer, shortagesFilled },
      audit: {
        targetType: 'transfer',
        targetId: t.id,
        operationId,
        locationIds: moveLocations(moves),
        externalRef: t.reference,
        reason: input.reason ?? null,
        changes: {
          locationId: dest.id,
          condition: input.condition ?? null,
          lines: items.map((i) => ({
            lineId: i.line.id,
            variantId: i.line.variant_id,
            quantity: i.quantity,
            entered: i.pack,
          })),
          moved: movedOut(moves),
          shortagesFilled,
          status: statusChange(t.id, status),
        },
      },
      outbox: availabilityOutbox(moves, transit),
      events,
    };
  },
});

// Cancel ----------------------------------------------------------------------------------------

export const cancelTransfer = defineOperation({
  id: 'inventory.transfers.cancel',
  summary: 'Cancel what a transfer has not dispatched',
  description:
    'Use this to call off a transfer, or part of a line, before it leaves. Releases the transfer hold on the undispatched remainder, so those units are available again. Units already dispatched stay in transit until they are received or resolved. Without items, every line’s remainder is cancelled. Needs the source in your location scope.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ transferId: Id, items: Items, reason: Reason.optional() }),
  output: CommandOut,
  permission: 'inventory.transfer',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.transfer.cancelled' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/transfers/{transferId}/cancel' },
  mcp: { tool: TOOL, action: 'cancel', readOnly: false, destructive: false },
  locations: (input, tx) => sourceOf(tx, input.transferId),
  async handler(ctx, input) {
    const { t, lines } = await lockTransfer(ctx.tx, input.transferId);
    assertNotClosed(t);
    for (const i of input.items ?? []) {
      if (i.lotCode || i.serials) {
        throw errors.unprocessable(
          'cancel_by_quantity',
          'Cancel by quantity; lots and serials are chosen when units are dispatched.',
        );
      }
    }
    const items = await resolveItems(ctx, lines, input.items, held, {
      code: 'nothing_to_cancel',
      message:
        'Nothing on this transfer is left to cancel; dispatched units must be received or resolved.',
    });
    let operationId: string | null = null;
    if (t.ready_at) operationId = await insertOperation(ctx, 'release', t, input.reason ?? null);
    const { released, events } = await cancelItems(ctx, items);
    const status = await refreshTransfer(ctx, t.id);
    const transfer = await loadTransfer(ctx.tx, t.id);
    const locationIds = [...new Set(released.map((r) => r.locationId))];
    return {
      webhooks: statusWebhook(t.id, status),
      result: { operationId, transfer },
      audit: {
        targetType: 'transfer',
        targetId: t.id,
        operationId,
        locationIds,
        externalRef: t.reference,
        reason: input.reason ?? null,
        changes: {
          lines: items.map((i) => ({
            lineId: i.line.id,
            variantId: i.line.variant_id,
            quantity: i.quantity,
          })),
          released,
          status: statusChange(t.id, status),
        },
      },
      outbox: [...new Set(items.map((i) => i.line.variant_id))]
        .filter(() => released.length > 0)
        .map((variantId) => ({
          topic: 'inventory.availability_changed',
          payload: { variantId, locationIds },
        })),
      events,
    };
  },
});

// Exceptions ------------------------------------------------------------------------------------

export const reportTransferException = defineOperation({
  id: 'inventory.transfers.exception.report',
  summary: 'Report a transfer exception: units missing or damaged in transit',
  description:
    'Use this when a delivery does not match: units missing, short, or damaged. Marks the transfer as an exception with your note until everything in transit is received or resolved. Changes no stock.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ transferId: Id, note: Note }),
  output: CommandOut,
  permission: 'inventory.transfer',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.transfer.exception_reported' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/transfers/{transferId}/exception' },
  mcp: { tool: TOOL, action: 'report_exception', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const { t, lines } = await lockTransfer(ctx.tx, input.transferId);
    await requireEitherInScope(ctx, t);
    if (!lines.some((l) => compare(inTransit(l), '0') > 0)) {
      throw errors.conflict(
        'nothing_in_transit',
        'Nothing is in transit on this transfer; an exception is about dispatched units.',
      );
    }
    await ctx.tx.query(
      'update transfers set exception_open = true, exception_note = $2 where id = $1',
      [t.id, input.note],
    );
    const status = await refreshTransfer(ctx, t.id);
    const transfer = await loadTransfer(ctx.tx, t.id);
    return {
      webhooks: statusWebhook(t.id, status),
      result: { operationId: null, transfer },
      audit: {
        targetType: 'transfer',
        targetId: t.id,
        locationIds: [t.from_location_id, t.to_location_id],
        externalRef: t.reference,
        reason: input.note,
        changes: { note: input.note, status: statusChange(t.id, status) },
      },
    };
  },
});

export const resolveTransferException = defineOperation({
  id: 'inventory.transfers.exception.resolve',
  summary: 'Resolve in-transit units that will not arrive: lost, damaged, or short',
  description:
    'Use this to settle dispatched units that were lost, destroyed, or never shipped. Records an adjustment out of transit at the moving average (reason loss or theft, or damage) and writes off their serials. For units that arrived damaged but still exist, receive them with condition "damaged" instead. Without items, everything still in transit is resolved.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    transferId: Id,
    resolution: z
      .enum(['lost', 'damaged', 'short'])
      .describe('lost: gone in transit; damaged: destroyed in transit; short: never shipped.'),
    items: Items,
    reason: Reason.optional(),
  }),
  output: CommandOut.extend({
    costVisible: z.boolean(),
    unitCosts: z
      .record(z.string(), z.string().nullable())
      .nullable()
      .describe('Per variant, the cost the write-off used; needs costs.read.'),
  }),
  permission: 'inventory.adjust',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.transfer.exception_resolved' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/transfers/{transferId}/resolve' },
  mcp: { tool: TOOL, action: 'resolve', readOnly: false, destructive: true },
  async handler(ctx, input) {
    const { t, lines } = await lockTransfer(ctx.tx, input.transferId);
    assertReadied(t);
    await requireEitherInScope(ctx, t);
    const items = await resolveItems(ctx, lines, input.items, inTransit, {
      code: 'quantity_exceeds_in_transit',
      message: 'A resolution cannot exceed what is in transit on this transfer.',
    });
    const operationId = ctx.newId();
    await ctx.tx.query(
      `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
         external_ref, reason, transfer_id)
       values (app_shop_id(), $1, 'adjustment', $2, $3, $4, $5, $6, $7, $8)`,
      [operationId, ...actorColumns(ctx), t.reference, RESOLUTION_REASON[input.resolution], t.id],
    );
    const { moves, events, costs } = await settleItems(ctx, t, items, operationId);
    const status = await refreshTransfer(ctx, t.id);
    const transfer = await loadTransfer(ctx.tx, t.id);
    const visible = canSeeCosts(ctx);
    return {
      webhooks: statusWebhook(t.id, status),
      result: {
        operationId,
        transfer,
        costVisible: visible,
        unitCosts: visible ? Object.fromEntries(costs) : null,
      },
      audit: {
        targetType: 'transfer',
        targetId: t.id,
        operationId,
        locationIds: [t.from_location_id, t.to_location_id],
        externalRef: t.reference,
        reason: input.reason ?? null,
        changes: {
          resolution: input.resolution,
          adjustmentReason: RESOLUTION_REASON[input.resolution],
          lines: items.map((i) => ({
            lineId: i.line.id,
            variantId: i.line.variant_id,
            quantity: i.quantity,
          })),
          moved: movedOut(moves),
          status: statusChange(t.id, status),
          restricted: {
            permission: 'costs.read',
            fields: { unitCosts: Object.fromEntries(costs) },
          },
        },
      },
      events,
    };
  },
});

// Move within a warehouse -----------------------------------------------------------------------

export const moveStock = defineOperation({
  id: 'inventory.moves.create',
  summary: 'Move stock from one shelf to another inside a warehouse, now',
  description:
    'Use this for "move 2 of X from shelf A1 to B2": one command that holds, dispatches, and receives together, recorded as a completed transfer. Both locations must be in the same warehouse and in your location scope; the destination must be a shelf without sub-locations. Not for sending stock to another warehouse (create a transfer) or for changing a condition (use adjust_stock).',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    fromLocationId: Id.describe('Stock is taken from this location and its sub-locations.'),
    toLocationId: Id.describe('The shelf the units go to.'),
    lines: Lines,
    reference: Reference.optional(),
    reason: Reason.optional(),
  }),
  output: CommandOut.extend({
    shortagesFilled: z.array(z.object({ reservationId: Id, quantity: z.string() })),
  }),
  permission: 'inventory.transfer',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.move.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/moves', status: 201 },
  mcp: { tool: TOOL, action: 'move', readOnly: false, destructive: false },
  locations: (input) => [input.fromLocationId, input.toLocationId],
  async handler(ctx, input) {
    const { from, to } = await checkPair(ctx, input.fromLocationId, input.toLocationId);
    if (from.warehouse_id !== to.warehouse_id) {
      throw errors.unprocessable(
        'move_across_warehouses',
        'A move stays inside one warehouse; create a transfer to send stock to another.',
      );
    }
    const prepared = await prepareLines(ctx, input.lines);
    const transferId = ctx.newId();
    await ctx.tx.query(
      `insert into transfers (shop_id, id, kind, reference, from_location_id, to_location_id,
         created_by_type, created_by_id)
       values (app_shop_id(), $1, 'move', $2, $3, $4, $5, $6)`,
      [transferId, input.reference ?? null, from.id, to.id, ctx.caller.kind, ctx.caller.id],
    );
    await insertLines(ctx, transferId, prepared);
    const { t, lines } = await lockTransfer(ctx.tx, transferId);
    const dest = await destinationLeaf(ctx.tx, t, undefined);
    // Every position the move can touch, locked in one ordered statement: the source candidates
    // and the destination's existing positions for these variants (new ones are this command's).
    const candidates = await readyCandidates(ctx.tx, t, lines);
    const destination = await ctx.tx.query<{ id: string }>(
      `select id from inventory_positions where location_id = $1 and variant_id = any($2::uuid[])
         and transfer_id is null`,
      [dest.id, lines.map((l) => l.variant_id)],
    );
    const sellable = lines.filter((l) => l.condition === 'sellable').map((l) => l.variant_id);
    const lock = await lockStock(
      ctx,
      [...candidates, ...destination.map((d) => d.id)],
      await openShortageReservations(ctx.tx, sellable),
    );
    const readyOp = await insertOperation(ctx, 'reservation', t, input.reason ?? null);
    await placeHolds(ctx, t, lines, lock.locked, readyOp);
    const readied = await readLines(ctx.tx, t.id);
    const tReady = { ...t, ready_at: new Date() };
    const all = readied.map((line) => ({
      line,
      quantity: held(line),
      pack: prepared.find((p) => p.id === line.id)?.pack ?? null,
      lotId: null,
      serials: null,
    }));
    const dispatchOp = await insertOperation(
      ctx,
      'transfer_dispatch',
      tReady,
      input.reason ?? null,
    );
    const dispatched = await dispatchItems(ctx, tReady, all, dispatchOp, lock.locked);
    const moving = (await readLines(ctx.tx, t.id)).map((line) => ({
      line,
      quantity: inTransit(line),
      pack: prepared.find((p) => p.id === line.id)?.pack ?? null,
      lotId: null,
      serials: null,
    }));
    const receiptOp = await insertOperation(ctx, 'transfer_receipt', tReady, input.reason ?? null);
    const received = await receiveItems(
      ctx,
      tReady,
      moving,
      dest,
      undefined,
      receiptOp,
      lock.locked,
    );
    const status = await refreshTransfer(ctx, t.id);
    const transfer = await loadTransfer(ctx.tx, t.id);
    const transit = await inTransitLocation(ctx.tx);
    const moves = [...dispatched.moves, ...received.moves];
    return {
      webhooks: statusWebhook(t.id, { from: null, to: status.to }),
      result: { operationId: receiptOp, transfer, shortagesFilled: received.shortagesFilled },
      audit: {
        targetType: 'transfer',
        targetId: t.id,
        operationId: receiptOp,
        locationIds: moveLocations(moves).filter((l) => l !== transit),
        externalRef: input.reference ?? null,
        reason: input.reason ?? null,
        changes: {
          from: from.id,
          to: dest.id,
          operations: { ready: readyOp, dispatch: dispatchOp, receipt: receiptOp },
          lines: prepared.map((l) => ({
            lineId: l.id,
            variantId: l.variantId,
            quantity: l.planned,
            entered: l.pack,
          })),
          moved: movedOut(moves),
          shortagesFilled: received.shortagesFilled,
          status: statusChange(t.id, { from: 'new', to: status.to }),
        },
      },
      outbox: availabilityOutbox(moves, transit),
      events: [...lock.events, ...dispatched.events, ...received.events],
    };
  },
});

// Reads -----------------------------------------------------------------------------------------

const SCOPE_FILTER = `($1::uuid[] is null or exists (select 1 from locations sl
  where sl.shop_id = t.shop_id and sl.id in (t.from_location_id, t.to_location_id)
    and sl.path_ids && $1::uuid[]))`;

export const getTransfer = defineOperation({
  id: 'inventory.transfers.get',
  summary: 'Show one transfer with its lines',
  description:
    'Use this to see a transfer’s state: per line the planned, cancelled, dispatched, received, and resolved quantities, what is still held or in transit (with lots and serials), and the summary status.',
  kind: 'read',
  scope: 'shop',
  input: TransferRef,
  output: TransferOut,
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'inventory.transfer.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/transfers/{transferId}' },
  mcp: { tool: TOOL, action: 'get', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const [row] = await ctx.tx.query<Transfer>(
      `${TRANSFER_SQL} where ${SCOPE_FILTER} and t.id = $2`,
      [ctx.locationScope, input.transferId],
    );
    if (!row) throw errors.notFound('Transfer');
    return {
      result: row,
      audit: {
        targetType: 'transfer',
        targetId: row.transferId,
        locationIds: [row.from.locationId, row.to.locationId],
        context: { input },
      },
    };
  },
});

export const listTransfers = defineOperation({
  id: 'inventory.transfers.list',
  summary: 'List transfers',
  description:
    'Use this to see transfers and moves: open ones by default (draft to partially received, and exceptions), newest first. Filter by status, a location (as source or destination, with its sub-locations), or a variant. Page with `before`.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    status: z
      .enum([
        'open',
        'closed',
        'all',
        'draft',
        'ready',
        'partially_dispatched',
        'dispatched',
        'partially_received',
        'received',
        'cancelled',
        'exception',
      ])
      .default('open'),
    locationId: Id.optional(),
    variantId: Id.optional(),
    kind: z.enum(['transfer', 'move']).optional(),
    before: Id.optional().describe('Transfers created before this one (paging).'),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({ transfers: z.array(TransferOut), next: Id.nullable() }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'inventory.transfers.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/transfers' },
  mcp: { tool: TOOL, action: 'list', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const rows = await ctx.tx.query<Transfer>(
      `${TRANSFER_SQL}
       where ${SCOPE_FILTER}
         and case $2::text
           when 'open' then t.status not in ('received', 'cancelled')
           when 'closed' then t.status in ('received', 'cancelled')
           when 'all' then true
           else t.status = $2::text end
         and ($3::uuid is null or exists (select 1 from locations fl2 where fl2.shop_id = t.shop_id
           and fl2.id in (t.from_location_id, t.to_location_id) and fl2.path_ids @> array[$3::uuid]))
         and ($4::uuid is null or exists (select 1 from transfer_lines l2
           where l2.shop_id = t.shop_id and l2.transfer_id = t.id and l2.variant_id = $4))
         and ($5::text is null or t.kind = $5)
         and ($6::uuid is null or t.id < $6)
       order by t.id desc
       limit $7`,
      [
        ctx.locationScope,
        input.status,
        input.locationId ?? null,
        input.variantId ?? null,
        input.kind ?? null,
        input.before ?? null,
        input.limit,
      ],
    );
    return {
      result: {
        transfers: rows,
        next: rows.length === input.limit ? (rows.at(-1)?.transferId ?? null) : null,
      },
      audit: {
        targetType: 'shop',
        targetId: ctx.shopId,
        locationIds: [...new Set(rows.flatMap((r) => [r.from.locationId, r.to.locationId]))].slice(
          0,
          100,
        ),
        context: { input, count: rows.length },
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const inventoryTransfersOperations = [
  createTransfer,
  readyTransfer,
  dispatchTransfer,
  receiveTransfer,
  cancelTransfer,
  reportTransferException,
  resolveTransferException,
  moveStock,
  listTransfers,
  getTransfer,
] as const;
