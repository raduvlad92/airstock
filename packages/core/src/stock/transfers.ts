import type { Tx } from '@airstock/db';
import type { AuditEvent } from '../audit.ts';
import { add, compare, normalize, subtract } from '../catalog/decimal.ts';
import { AppError, errors } from '../errors.ts';
import type { HandlerContext } from '../registry.ts';
import {
  actorColumns,
  allocate,
  applyStockCost,
  assertScale,
  insufficientStock,
  loadStockVariant,
  normalizeCode,
  type Pick,
  refreshStatuses,
  sumQuantities,
} from './engine.ts';
import {
  type AppliedMove,
  applyMoves,
  type EnteredPack,
  findPositions,
  findSerials,
  inTransitLocation,
  lockStock,
  openShortageReservations,
  type PositionKey,
  resolvePack,
  type StockMove,
  syncSerials,
} from './moves.ts';
import { fillShortages } from './shortages.ts';

// The transfer engine (plan D8, PRD 6.4, ADR "Transfers"). Commands lock in this order:
//   0. the transfer row (a document lock only transfer commands take, always first)
//   1. inventory_positions by id   2. reservations by id   3. variant_costs, serial_units, ...
// Quantities per line are authoritative: held = planned - cancelled - dispatched, in transit =
// dispatched - received - resolved.

export interface TransferRow {
  id: string;
  kind: 'transfer' | 'move';
  status: string;
  reference: string | null;
  from_location_id: string;
  to_location_id: string;
  exception_open: boolean;
  ready_at: Date | null;
}

export interface LineRow {
  id: string;
  variant_id: string;
  condition: string;
  lot_id: string | null;
  serial_ids: string[] | null;
  planned: string;
  cancelled: string;
  dispatched: string;
  received: string;
  resolved: string;
  reservation_id: string | null;
}

export function held(l: LineRow): string {
  return normalize(subtract(subtract(l.planned, l.cancelled), l.dispatched));
}

export function inTransit(l: LineRow): string {
  return normalize(subtract(subtract(l.dispatched, l.received), l.resolved));
}

const positive = (q: string) => compare(q, '0') > 0;

/** Step 0: the transfer row, then its lines (only transfer commands change them). */
export async function lockTransfer(
  tx: Tx,
  transferId: string,
): Promise<{ t: TransferRow; lines: LineRow[] }> {
  const [t] = await tx.query<TransferRow>(
    `select id, kind, status, reference, from_location_id, to_location_id, exception_open, ready_at
     from transfers where id = $1 for update`,
    [transferId],
  );
  if (!t) throw errors.notFound('Transfer');
  return { t, lines: await readLines(tx, transferId) };
}

export async function readLines(tx: Tx, transferId: string): Promise<LineRow[]> {
  return tx.query<LineRow>(
    `select id, variant_id, condition, lot_id, serial_ids, planned::text, cancelled::text,
       dispatched::text, received::text, resolved::text, reservation_id
     from transfer_lines where transfer_id = $1 order by position`,
    [transferId],
  );
}

/** Recomputes the summary status from the line quantities (PRD 6.4: quantities are authoritative). */
export async function refreshTransfer(
  ctx: HandlerContext,
  transferId: string,
): Promise<{ from: string; to: string }> {
  const [row] = await ctx.tx.query<{
    status: string;
    readied: boolean;
    exception_open: boolean;
    held: string;
    transit: string;
    dispatched: string;
    settled: string;
  }>(
    `select t.status, t.ready_at is not null as readied, t.exception_open,
       coalesce(sum(l.planned - l.cancelled - l.dispatched), 0)::text as held,
       coalesce(sum(l.dispatched - l.received - l.resolved), 0)::text as transit,
       coalesce(sum(l.dispatched), 0)::text as dispatched,
       coalesce(sum(l.received + l.resolved), 0)::text as settled
     from transfers t left join transfer_lines l on l.shop_id = t.shop_id and l.transfer_id = t.id
     where t.id = $1 group by t.shop_id, t.id`,
    [transferId],
  );
  if (!row) throw errors.internal();
  const exceptionOpen = row.exception_open && positive(row.transit);
  let status: string;
  if (!row.readied) status = positive(row.held) ? 'draft' : 'cancelled';
  else if (exceptionOpen) status = 'exception';
  else if (!positive(row.dispatched)) status = positive(row.held) ? 'ready' : 'cancelled';
  else if (!positive(row.settled))
    status = positive(row.held) ? 'partially_dispatched' : 'dispatched';
  else if (positive(row.transit) || positive(row.held)) status = 'partially_received';
  else status = 'received';
  await ctx.tx.query(
    `update transfers set status = $2, exception_open = $3,
       exception_note = case when $3 then exception_note end,
       closed_at = case when $2 in ('received', 'cancelled') then coalesce(closed_at, now()) end,
       updated_at = now(), version = version + 1
     where id = $1`,
    [transferId, status, exceptionOpen],
  );
  return { from: row.status, to: status };
}

export async function insertOperation(
  ctx: HandlerContext,
  kind: 'reservation' | 'transfer_dispatch' | 'transfer_receipt' | 'adjustment' | 'release',
  t: TransferRow,
  reason: string | null,
): Promise<string> {
  const id = ctx.newId();
  await ctx.tx.query(
    `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
       external_ref, reason, transfer_id)
     values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, kind, ...actorColumns(ctx), t.reference, reason, t.id],
  );
  return id;
}

// Lines ---------------------------------------------------------------------------------------

export interface LineSpec {
  variantId: string;
  quantity: string;
  packId?: string | undefined;
  lotCode?: string | undefined;
  serials?: string[] | undefined;
  condition: string;
}

export interface PreparedLine {
  id: string;
  variantId: string;
  sku: string;
  condition: string;
  lotId: string | null;
  serialIds: string[] | null;
  planned: string;
  pack: EnteredPack | null;
}

/** Validates new lines: stock-holding variants, exact pack conversion, lots, and serials. */
export async function prepareLines(
  ctx: HandlerContext,
  specs: LineSpec[],
): Promise<PreparedLine[]> {
  const seen = new Set<string>();
  const out: PreparedLine[] = [];
  // Variants in id order: their key-share locks come before any position lock (ADR 0020).
  const order = [...specs]
    .map((s, i) => ({ s, i }))
    .sort((a, b) =>
      a.s.variantId < b.s.variantId ? -1 : a.s.variantId > b.s.variantId ? 1 : a.i - b.i,
    );
  const byIndex = new Map<number, PreparedLine>();
  for (const { s, i } of order) {
    if (seen.has(s.variantId)) {
      throw errors.unprocessable(
        'duplicate_line',
        'A transfer has one line per variant; add the quantities up.',
        { variantId: s.variantId },
      );
    }
    seen.add(s.variantId);
    const variant = await loadStockVariant(ctx.tx, s.variantId);
    if (variant.bundleId) {
      throw errors.unprocessable(
        'bundle_holds_no_stock',
        'This variant is a bundle, which holds no stock of its own. Transfer its components.',
        { variantId: s.variantId },
      );
    }
    const { base, pack } = await resolvePack(ctx.tx, s.variantId, s.packId, s.quantity);
    assertScale(base, variant.quantityScale, `Variant ${variant.sku}`);
    let lotId: string | null = null;
    if (s.lotCode) {
      if (variant.trackingMode !== 'lot' && variant.trackingMode !== 'lot_expiry') {
        throw errors.unprocessable('not_lot_tracked', `${variant.sku} is not tracked by lot.`);
      }
      const [lot] = await ctx.tx.query<{ id: string }>(
        'select id from lots where variant_id = $1 and code_normalized = $2',
        [s.variantId, normalizeCode(s.lotCode)],
      );
      if (!lot) throw errors.notFound('Lot');
      lotId = lot.id;
    }
    let serialIds: string[] | null = null;
    if (s.serials) {
      if (variant.trackingMode !== 'serial') {
        throw errors.unprocessable(
          'not_serial_tracked',
          `${variant.sku} is not tracked by serial.`,
        );
      }
      const wanted = [...new Set(s.serials.map(normalizeCode))];
      if (wanted.length !== s.serials.length) {
        throw errors.unprocessable('duplicate_serial', 'The same serial appears twice.');
      }
      if (compare(base, String(wanted.length)) !== 0) {
        throw errors.unprocessable('serial_count_mismatch', 'Give one serial for each unit.', {
          quantity: base,
          serials: wanted.length,
        });
      }
      const found = await findSerials(ctx.tx, s.variantId, wanted);
      const missing = wanted.filter((w) => !found.some((f) => f.normalized === w));
      if (missing.length > 0) {
        throw errors.unprocessable(
          'unknown_serial',
          'These serials are not known for this variant.',
          {
            serials: missing,
          },
        );
      }
      serialIds = found.map((f) => f.id);
    }
    byIndex.set(i, {
      id: ctx.newId(),
      variantId: s.variantId,
      sku: variant.sku,
      condition: s.condition,
      lotId,
      serialIds,
      planned: base,
      pack,
    });
  }
  for (let i = 0; i < specs.length; i++) out.push(byIndex.get(i)!);
  return out;
}

export async function insertLines(
  ctx: HandlerContext,
  transferId: string,
  lines: PreparedLine[],
): Promise<void> {
  await ctx.tx.query(
    `insert into transfer_lines (shop_id, id, transfer_id, variant_id, position, condition, lot_id,
       serial_ids, pack_id, pack_version, entered_quantity, conversion_factor, planned)
     select app_shop_id(), x.id, $2, x."variantId", x.position, x.condition, x."lotId",
       x."serialIds", x."packId", x."packVersion", x.entered, x.factor, x.planned
     from jsonb_to_recordset($1::jsonb) as x(id uuid, "variantId" uuid, position integer,
       condition text, "lotId" uuid, "serialIds" uuid[], "packId" uuid, "packVersion" integer,
       entered numeric, factor numeric, planned numeric)`,
    [
      JSON.stringify(
        lines.map((l, position) => ({
          id: l.id,
          variantId: l.variantId,
          position,
          condition: l.condition,
          lotId: l.lotId,
          serialIds: l.serialIds,
          packId: l.pack?.packId ?? null,
          packVersion: l.pack?.packVersion ?? null,
          entered: l.pack?.quantity ?? null,
          factor: l.pack?.factor ?? null,
          planned: l.planned,
        })),
      ),
      transferId,
    ],
  );
}

// Locations -----------------------------------------------------------------------------------

export interface LocationInfo {
  id: string;
  warehouse_id: string | null;
  path: string;
  path_ids: string[];
  status: string;
  kind: string;
  leaf: boolean;
}

/**
 * A storage location. With `share`, the row is share-locked like every command that brings stock
 * in (stockLocation), so an archive, which locks it FOR UPDATE and then checks it holds no
 * stock, waits for this command instead of passing that check while units land.
 */
export async function loadLocation(tx: Tx, id: string, share = false): Promise<LocationInfo> {
  const [row] = await tx.query<LocationInfo>(
    `select l.id, l.warehouse_id, l.path, l.path_ids, l.status, l.kind,
       not exists (select 1 from locations c where c.shop_id = l.shop_id and c.parent_id = l.id) as leaf
     from locations l where l.id = $1${share ? ' for share of l' : ''}`,
    [id],
  );
  if (row?.kind !== 'storage') throw errors.notFound('Location');
  return row;
}

/** Whether the caller's location scope covers each location (null scope covers all). */
export async function inScope(
  tx: Tx,
  scope: string[] | null,
  locationIds: string[],
): Promise<boolean[]> {
  if (scope === null) return locationIds.map(() => true);
  const rows = await tx.query<{ id: string; ok: boolean }>(
    'select id, path_ids && $2::uuid[] as ok from locations where id = any($1::uuid[])',
    [locationIds, scope],
  );
  return locationIds.map((id) => rows.find((r) => r.id === id)?.ok ?? false);
}

export async function requireEitherInScope(ctx: HandlerContext, t: TransferRow): Promise<void> {
  const ok = await inScope(ctx.tx, ctx.locationScope, [t.from_location_id, t.to_location_id]);
  if (!ok.some(Boolean)) {
    throw new AppError(
      403,
      'location_out_of_scope',
      'You do not have access to the source or the destination of this transfer.',
      'denied',
    );
  }
}

/** The destination leaf for a receipt: the destination itself, or a leaf inside it. */
export async function destinationLeaf(
  tx: Tx,
  t: TransferRow,
  locationId: string | undefined,
): Promise<LocationInfo> {
  const loc = await loadLocation(tx, locationId ?? t.to_location_id, true);
  if (!loc.path_ids.includes(t.to_location_id)) {
    throw errors.unprocessable(
      'outside_destination',
      'Receive the units at the destination or a location inside it.',
    );
  }
  if (loc.status !== 'active')
    throw errors.conflict('location_archived', 'The location is archived.');
  if (!loc.leaf) {
    throw errors.unprocessable(
      'location_not_leaf',
      'Stock is held only at locations without sub-locations: name the shelf with locationId.',
    );
  }
  return loc;
}

// Ready ---------------------------------------------------------------------------------------

/** Positions that could give stock for the lines (not locked). */
export async function readyCandidates(tx: Tx, t: TransferRow, lines: LineRow[]): Promise<string[]> {
  const open = lines.filter((l) => positive(subtract(l.planned, l.cancelled)));
  if (open.length === 0) return [];
  const rows = await tx.query<{ id: string }>(
    `select p.id
     from jsonb_to_recordset($1::jsonb) as x("variantId" uuid, condition text, "lotId" uuid,
       "serialIds" uuid[])
     join inventory_positions p on p.shop_id = app_shop_id() and p.variant_id = x."variantId"
       and p.condition = x.condition and p.transfer_id is null and p.on_hand > 0
       and (x."lotId" is null or p.lot_id = x."lotId")
       and (x."serialIds" is null or p.serial_id = any(x."serialIds"))
     join locations l on l.shop_id = p.shop_id and l.id = p.location_id
     where l.kind = 'storage' and l.status = 'active' and l.path_ids @> array[$2::uuid]`,
    [
      JSON.stringify(
        open.map((l) => ({
          variantId: l.variant_id,
          condition: l.condition,
          lotId: l.lot_id,
          serialIds: l.serial_ids,
        })),
      ),
      t.from_location_id,
    ],
  );
  return rows.map((r) => r.id);
}

/**
 * Places the transfer holds: one reservation (purpose 'transfer') per line, allocated to concrete
 * source positions, earliest expiry and oldest stock first. Expired lots are skipped unless the
 * line names the lot. Positions must be locked and their expired claims released. Fails whole.
 */
export async function placeHolds(
  ctx: HandlerContext,
  t: TransferRow,
  lines: LineRow[],
  locked: Set<string>,
  operationId: string,
): Promise<Array<Pick & { allocationId: string; reservationId: string }>> {
  const open = lines.filter((l) => positive(subtract(l.planned, l.cancelled)));
  if (open.length === 0) {
    throw errors.conflict('nothing_to_transfer', 'Every line of this transfer is cancelled.');
  }
  const picks: Pick[] = [];
  const short: Array<{ variantId: string; requested: string; available: string }> = [];
  for (const l of open) {
    const want = normalize(subtract(l.planned, l.cancelled));
    const rows = await ctx.tx.query<{
      position_id: string;
      location_id: string;
      lot_id: string | null;
      serial_id: string | null;
      free: string;
    }>(
      `select sp.position_id, sp.location_id, sp.lot_id, sp.serial_id,
         (sp.on_hand - sp.reserved)::text as free
       from stock_positions(array[$1::uuid]) sp
       where sp.position_id = any($2::uuid[]) and sp.condition = $3 and sp.transfer_id is null
         and sp.path_ids @> array[$4::uuid]
         and ($5::uuid is null or sp.lot_id = $5) and ($6::uuid[] is null or sp.serial_id = any($6))
         and ($5::uuid is not null or not sp.lot_expired)
         and sp.on_hand - sp.reserved > 0
       order by sp.expires_on nulls last, sp.received_at nulls last, sp.location_path, sp.position_id`,
      [l.variant_id, [...locked], l.condition, t.from_location_id, l.lot_id, l.serial_ids],
    );
    let rest = want;
    for (const r of rows) {
      if (!positive(rest)) break;
      const take = compare(r.free, rest) < 0 ? normalize(r.free) : rest;
      picks.push({
        variantId: l.variant_id,
        positionId: r.position_id,
        locationId: r.location_id,
        lotId: r.lot_id,
        serialId: r.serial_id,
        quantity: take,
      });
      rest = normalize(subtract(rest, take));
    }
    if (positive(rest)) {
      short.push({
        variantId: l.variant_id,
        requested: want,
        available: normalize(sumQuantities(rows.map((r) => r.free))),
      });
    }
  }
  if (short.length > 0) {
    throw insufficientStock(
      sumQuantities(short.map((s) => s.requested)),
      sumQuantities(short.map((s) => s.available)),
      { lines: short, detail: 'The source does not have enough free stock for these lines.' },
    );
  }
  const reservations = open.map((l) => ({
    id: ctx.newId(),
    lineId: l.id,
    variantId: l.variant_id,
    quantity: normalize(subtract(l.planned, l.cancelled)),
    lotId: l.lot_id,
  }));
  await ctx.tx.query(
    `with rows as (
       select * from jsonb_to_recordset($1::jsonb)
         as x(id uuid, "lineId" uuid, "variantId" uuid, quantity numeric, "lotId" uuid)),
     res as (
       insert into reservations (shop_id, id, variant_id, quantity, purpose, external_ref,
         expires_at, created_operation_id, channel, location_id, lot_id)
       select app_shop_id(), r.id, r."variantId", r.quantity, 'transfer', $2, null, $3, 'default',
         $4, r."lotId"
       from rows r)
     update transfer_lines l set reservation_id = r.id
     from rows r where l.shop_id = app_shop_id() and l.id = r."lineId"`,
    [JSON.stringify(reservations), t.reference, operationId, t.from_location_id],
  );
  await ctx.tx.query('update transfers set ready_at = now() where id = $1', [t.id]);
  return allocate(ctx, new Map(reservations.map((r) => [r.variantId, r.id])), picks);
}

// Items for dispatch, receipt, cancellation, and resolution -------------------------------------

export interface ItemSpec {
  variantId: string;
  quantity?: string | undefined;
  packId?: string | undefined;
  lotCode?: string | undefined;
  serials?: string[] | undefined;
}

export interface ResolvedItem {
  line: LineRow;
  quantity: string;
  pack: EnteredPack | null;
  lotId: string | null;
  serials: string[] | null;
}

/**
 * Turns items into per-line quantities, each at most `limit(line)`. Without items, every line
 * with something left takes all of it.
 */
export async function resolveItems(
  ctx: HandlerContext,
  lines: LineRow[],
  items: ItemSpec[] | undefined,
  limit: (l: LineRow) => string,
  what: { code: string; message: string },
): Promise<ResolvedItem[]> {
  if (!items || items.length === 0) {
    const all = lines
      .filter((l) => positive(limit(l)))
      .map((line) => ({ line, quantity: limit(line), pack: null, lotId: null, serials: null }));
    if (all.length === 0) throw errors.conflict(what.code, what.message);
    return all;
  }
  const seen = new Set<string>();
  const out: ResolvedItem[] = [];
  for (const item of items) {
    const line = lines.find((l) => l.variant_id === item.variantId);
    if (!line) {
      throw errors.unprocessable('not_on_transfer', 'This variant is not on the transfer.', {
        variantId: item.variantId,
      });
    }
    if (seen.has(line.id)) {
      throw errors.unprocessable(
        'duplicate_line',
        'Name each variant once; add the quantities up.',
        {
          variantId: item.variantId,
        },
      );
    }
    seen.add(line.id);
    const max = limit(line);
    let quantity = max;
    let pack: EnteredPack | null = null;
    if (item.quantity !== undefined) {
      const resolved = await resolvePack(ctx.tx, line.variant_id, item.packId, item.quantity);
      quantity = resolved.base;
      pack = resolved.pack;
    } else if (item.packId) {
      throw errors.unprocessable('quantity_required', 'A pack needs a quantity of packs.');
    }
    let serials: string[] | null = null;
    if (item.serials) {
      serials = [...new Set(item.serials.map(normalizeCode))];
      if (serials.length !== item.serials.length) {
        throw errors.unprocessable('duplicate_serial', 'The same serial appears twice.');
      }
      if (item.quantity !== undefined && compare(quantity, String(serials.length)) !== 0) {
        throw errors.unprocessable('serial_count_mismatch', 'Give one serial for each unit.', {
          quantity,
          serials: serials.length,
        });
      }
      quantity = String(serials.length);
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
    const [v] = await ctx.tx.query<{ scale: number }>(
      'select quantity_scale as scale from variants where id = $1',
      [line.variant_id],
    );
    assertScale(quantity, v?.scale ?? 0);
    if (!positive(quantity)) throw errors.unprocessable(what.code, what.message);
    if (compare(quantity, max) > 0) {
      throw errors.conflict(what.code, what.message, {
        variantId: line.variant_id,
        requested: quantity,
        remaining: max,
      });
    }
    out.push({ line, quantity, pack, lotId, serials });
  }
  return out;
}

// Dispatch ------------------------------------------------------------------------------------

interface OpenAllocation {
  id: string;
  reservation_id: string;
  position_id: string;
  location_id: string;
  outstanding: string;
  lot_id: string | null;
  serial_id: string | null;
  serial_normalized: string | null;
  received_at: string | null;
}

async function openAllocations(tx: Tx, reservationIds: string[]): Promise<OpenAllocation[]> {
  if (reservationIds.length === 0) return [];
  return tx.query<OpenAllocation>(
    `select a.id, a.reservation_id, a.position_id, p.location_id, a.outstanding::text,
       p.lot_id, p.serial_id, su.serial_normalized,
       to_char(p.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as received_at
     from reservation_allocations a
     join inventory_positions p on p.shop_id = a.shop_id and p.id = a.position_id
     left join lots lt on lt.shop_id = p.shop_id and lt.id = p.lot_id
     left join serial_units su on su.shop_id = p.shop_id and su.id = p.serial_id
     where a.reservation_id = any($1::uuid[]) and a.outstanding > 0
     order by lt.expires_on nulls last, p.received_at nulls last, a.id`,
    [reservationIds],
  );
}

function retryConflict(): AppError {
  return errors.conflict(
    'retry_conflict',
    'The transfer’s stock changed while it was being read. Retry the request.',
  );
}

/**
 * Dispatches resolved items: consumes the transfer holds, takes the units out of the source, and
 * puts them in in-transit positions that name the transfer (with their lots and serials). A named
 * serial that is free at the source takes the place of a held one. Locks positions and line
 * reservations unless `prelocked` is given (a move locks everything up front).
 */
export async function dispatchItems(
  ctx: HandlerContext,
  t: TransferRow,
  items: ResolvedItem[],
  operationId: string,
  prelocked: Set<string> | null,
): Promise<{ moves: AppliedMove[]; events: AuditEvent[] }> {
  const transit = await inTransitLocation(ctx.tx);
  const reservationIds = items
    .map((i) => i.line.reservation_id)
    .filter((r): r is string => r !== null);
  if (reservationIds.length !== items.length) throw errors.internal();

  // Named serials that are not held yet: swap them in for held ones.
  const swaps: Array<{ item: ResolvedItem; serialId: string; positionId: string }> = [];
  let before = await openAllocations(ctx.tx, reservationIds);
  for (const item of items) {
    if (!item.serials) continue;
    const heldSerials = new Set(
      before
        .filter((a) => a.reservation_id === item.line.reservation_id)
        .map((a) => a.serial_normalized),
    );
    const extra = item.serials.filter((s) => !heldSerials.has(s));
    const units = await findSerials(ctx.tx, item.line.variant_id, extra);
    for (const s of extra) {
      const u = units.find((x) => x.normalized === s);
      if (u?.status !== 'in_stock' || !u.positionId) {
        throw errors.unprocessable('serial_not_available', `Serial ${s} is not in stock.`, {
          serial: s,
        });
      }
      swaps.push({ item, serialId: u.id, positionId: u.positionId });
    }
  }

  let events: AuditEvent[] = [];
  let locked = prelocked;
  if (!locked) {
    const transitPositions = await ctx.tx.query<{ id: string }>(
      'select id from inventory_positions where transfer_id = $1',
      [t.id],
    );
    const lock = await lockStock(
      ctx,
      [
        ...before.map((a) => a.position_id),
        ...swaps.map((s) => s.positionId),
        ...transitPositions.map((p) => p.id),
      ],
      reservationIds,
    );
    locked = lock.locked;
    events = lock.events;
    before = await openAllocations(ctx.tx, reservationIds);
    if (before.some((a) => !locked!.has(a.position_id))) throw retryConflict();
  }

  // Swaps: the named serial must be free at the source in the line's condition.
  for (const swap of swaps) {
    const [pos] = await ctx.tx.query<{ ok: boolean; location_id: string }>(
      `select (sp.condition = $3 and sp.transfer_id is null and sp.on_hand = 1 and sp.reserved = 0
           and sp.path_ids @> array[$4::uuid]) as ok, sp.location_id
       from stock_positions(array[$1::uuid]) sp where sp.position_id = $2`,
      [swap.item.line.variant_id, swap.positionId, swap.item.line.condition, t.from_location_id],
    );
    if (!pos?.ok || !locked.has(swap.positionId)) {
      throw errors.unprocessable(
        'serial_not_available',
        'A named serial is not free at the transfer’s source in the line’s condition.',
        { positionId: swap.positionId },
      );
    }
    const named = new Set(swap.item.serials);
    const victim = before.find(
      (a) =>
        a.reservation_id === swap.item.line.reservation_id &&
        positive(a.outstanding) &&
        !named.has(a.serial_normalized ?? ''),
    );
    if (!victim) {
      throw errors.conflict('quantity_exceeds_held', 'More serials were named than are held.');
    }
    await ctx.tx.query(
      `with src as (
         update reservation_allocations set moved = moved + 1 where id = $1 returning position_id)
       update inventory_positions p set allocated = p.allocated - 1, version = p.version + 1,
         updated_at = now()
       from src where p.shop_id = app_shop_id() and p.id = src.position_id`,
      [victim.id],
    );
    victim.outstanding = normalize(subtract(victim.outstanding, '1'));
    await allocate(
      ctx,
      new Map([[swap.item.line.variant_id, swap.item.line.reservation_id!]]),
      [
        {
          variantId: swap.item.line.variant_id,
          positionId: swap.positionId,
          locationId: pos.location_id,
          lotId: null,
          serialId: swap.serialId,
          quantity: '1',
        },
      ],
      victim.id,
    );
  }
  if (swaps.length > 0) before = await openAllocations(ctx.tx, reservationIds);

  const moves: StockMove[] = [];
  for (const item of items) {
    let rest = item.quantity;
    const mine = before.filter(
      (a) =>
        a.reservation_id === item.line.reservation_id &&
        (item.lotId === null || a.lot_id === item.lotId) &&
        (item.serials === null || item.serials.includes(a.serial_normalized ?? '')),
    );
    for (const a of mine) {
      if (!positive(rest)) break;
      const take = compare(a.outstanding, rest) < 0 ? normalize(a.outstanding) : rest;
      moves.push({
        variantId: item.line.variant_id,
        quantity: take,
        lotId: a.lot_id,
        serialId: a.serial_id,
        from: {
          positionId: a.position_id,
          locationId: a.location_id,
          receivedAt: a.received_at,
          allocationId: a.id,
        },
        to: { locationId: transit, condition: item.line.condition, transferId: t.id },
        reservationId: a.reservation_id,
        pack: item.pack,
      });
      rest = normalize(subtract(rest, take));
    }
    if (positive(rest)) {
      throw errors.conflict(
        'quantity_exceeds_held',
        'The transfer holds fewer units of this lot or these serials.',
        { variantId: item.line.variant_id, requested: item.quantity },
      );
    }
  }
  const applied = await applyMoves(ctx, operationId, moves);
  await syncSerials(ctx, operationId, applied);
  await bumpLines(ctx, items, 'dispatched');
  await refreshStatuses(ctx.tx, reservationIds);
  return { moves: applied, events };
}

async function bumpLines(
  ctx: HandlerContext,
  items: ResolvedItem[],
  column: 'cancelled' | 'dispatched' | 'received' | 'resolved',
): Promise<void> {
  await ctx.tx.query(
    `update transfer_lines l set ${column} = l.${column} + x.quantity
     from jsonb_to_recordset($1::jsonb) as x(id uuid, quantity numeric)
     where l.shop_id = app_shop_id() and l.id = x.id`,
    [JSON.stringify(items.map((i) => ({ id: i.line.id, quantity: i.quantity })))],
  );
}

// Receipt and resolution: out of transit ----------------------------------------------------------

interface TransitPosition {
  id: string;
  variant_id: string;
  location_id: string;
  condition: string;
  lot_id: string | null;
  serial_id: string | null;
  serial_normalized: string | null;
  on_hand: string;
  received_at: string | null;
}

export async function transitPositions(tx: Tx, transferId: string): Promise<TransitPosition[]> {
  return tx.query<TransitPosition>(
    `select p.id, p.variant_id, p.location_id, p.condition, p.lot_id, p.serial_id,
       su.serial_normalized, p.on_hand::text,
       to_char(p.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as received_at
     from inventory_positions p
     left join lots lt on lt.shop_id = p.shop_id and lt.id = p.lot_id
     left join serial_units su on su.shop_id = p.shop_id and su.id = p.serial_id
     where p.transfer_id = $1 and p.on_hand > 0
     order by lt.expires_on nulls last, p.received_at nulls last, p.id`,
    [transferId],
  );
}

/** Which in-transit units each item takes: its lot and serials if named, else earliest expiry. */
export function pickFromTransit(
  items: ResolvedItem[],
  positions: TransitPosition[],
): Array<{ item: ResolvedItem; position: TransitPosition; quantity: string }> {
  const out: Array<{ item: ResolvedItem; position: TransitPosition; quantity: string }> = [];
  for (const item of items) {
    let rest = item.quantity;
    for (const p of positions) {
      if (!positive(rest)) break;
      if (p.variant_id !== item.line.variant_id) continue;
      if (item.lotId !== null && p.lot_id !== item.lotId) continue;
      if (item.serials !== null && !item.serials.includes(p.serial_normalized ?? '')) continue;
      const take = compare(p.on_hand, rest) < 0 ? normalize(p.on_hand) : rest;
      out.push({ item, position: p, quantity: take });
      rest = normalize(subtract(rest, take));
    }
    if (positive(rest)) {
      throw errors.conflict(
        'quantity_exceeds_in_transit',
        'Fewer units of this lot or these serials are in transit.',
        { variantId: item.line.variant_id, requested: item.quantity },
      );
    }
  }
  return out;
}

/**
 * Receives resolved items at a destination leaf: in-transit units move into destination
 * positions (in `condition`, or the line's), and sellable units fill open shortages (D6).
 */
export async function receiveItems(
  ctx: HandlerContext,
  t: TransferRow,
  items: ResolvedItem[],
  dest: LocationInfo,
  condition: string | undefined,
  operationId: string,
  prelocked: Set<string> | null,
): Promise<{
  moves: AppliedMove[];
  events: AuditEvent[];
  shortagesFilled: Array<{ reservationId: string; quantity: string }>;
}> {
  const transit = await transitPositions(ctx.tx, t.id);
  const picks = pickFromTransit(items, transit);
  const keys: PositionKey[] = picks.map((p) => ({
    variantId: p.position.variant_id,
    locationId: dest.id,
    condition: condition ?? p.item.line.condition,
    lotId: p.position.lot_id,
    serialId: p.position.serial_id,
    transferId: null,
  }));
  const sellableVariants = [
    ...new Set(keys.filter((k) => k.condition === 'sellable').map((k) => k.variantId)),
  ];
  let events: AuditEvent[] = [];
  if (!prelocked) {
    const existing = await findPositions(ctx.tx, keys);
    const lock = await lockStock(
      ctx,
      [...transit.map((p) => p.id), ...existing.map((p) => p.id)],
      await openShortageReservations(ctx.tx, sellableVariants),
    );
    events = lock.events;
    // In-transit positions change only under the transfer lock, which this command took first,
    // so the picks made above still hold.
  }
  const moves: StockMove[] = picks.map((p, i) => ({
    variantId: p.position.variant_id,
    quantity: p.quantity,
    lotId: p.position.lot_id,
    serialId: p.position.serial_id,
    from: {
      positionId: p.position.id,
      locationId: p.position.location_id,
      receivedAt: p.position.received_at,
    },
    to: { locationId: dest.id, condition: keys[i]!.condition, transferId: null },
    pack: p.item.pack,
  }));
  const applied = await applyMoves(ctx, operationId, moves);
  await syncSerials(ctx, operationId, applied);
  await bumpLines(ctx, items, 'received');
  const shortagesFilled: Array<{ reservationId: string; quantity: string }> = [];
  for (const variantId of sellableVariants) {
    const positions = [
      ...new Set(
        applied
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
  return { moves: applied, events, shortagesFilled };
}

export const RESOLUTION_REASON = {
  lost: 'loss_or_theft',
  short: 'loss_or_theft',
  damaged: 'damage',
} as const;

/**
 * Settles in-transit units that will not arrive (lost, short) or arrived destroyed (damaged): an
 * adjustment out of transit at the moving average, serials written off.
 */
export async function settleItems(
  ctx: HandlerContext,
  t: TransferRow,
  items: ResolvedItem[],
  operationId: string,
): Promise<{ moves: AppliedMove[]; events: AuditEvent[]; costs: Map<string, string | null> }> {
  const transit = await transitPositions(ctx.tx, t.id);
  const lock = await lockStock(
    ctx,
    transit.map((p) => p.id),
  );
  const picks = pickFromTransit(items, await transitPositions(ctx.tx, t.id));
  // 3. Costs per variant, in id order: units leave owned stock at the moving average (ADR 0022).
  const costs = new Map<string, { unitCost: string | null; costBasis: string }>();
  const variants = [...new Set(picks.map((p) => p.position.variant_id))].sort();
  for (const variantId of variants) {
    const total = sumQuantities(
      picks.filter((p) => p.position.variant_id === variantId).map((p) => p.quantity),
    );
    costs.set(
      variantId,
      await applyStockCost(ctx, variantId, operationId, 'adjustment', `-${normalize(total)}`, null),
    );
  }
  const applied = await applyMoves(
    ctx,
    operationId,
    picks.map((p) => ({
      variantId: p.position.variant_id,
      quantity: p.quantity,
      lotId: p.position.lot_id,
      serialId: p.position.serial_id,
      from: {
        positionId: p.position.id,
        locationId: p.position.location_id,
        receivedAt: p.position.received_at,
      },
      to: null,
      cost: costs.get(p.position.variant_id) ?? null,
      pack: p.item.pack,
    })),
  );
  await syncSerials(ctx, operationId, applied, 'written_off');
  await bumpLines(ctx, items, 'resolved');
  return {
    moves: applied,
    events: lock.events,
    costs: new Map([...costs].map(([v, c]) => [v, c.unitCost])),
  };
}

// Cancel ---------------------------------------------------------------------------------------

/** Cancels undispatched quantities: draft lines simply shrink; ready lines release their holds. */
export async function cancelItems(
  ctx: HandlerContext,
  items: ResolvedItem[],
): Promise<{
  released: Array<{
    allocationId: string;
    positionId: string;
    locationId: string;
    quantity: string;
  }>;
  events: AuditEvent[];
}> {
  const reservationIds = items
    .map((i) => i.line.reservation_id)
    .filter((r): r is string => r !== null);
  const released: Array<{
    allocationId: string;
    positionId: string;
    locationId: string;
    quantity: string;
  }> = [];
  let events: AuditEvent[] = [];
  if (reservationIds.length > 0) {
    const before = await openAllocations(ctx.tx, reservationIds);
    const lock = await lockStock(
      ctx,
      before.map((a) => a.position_id),
      reservationIds,
    );
    events = lock.events;
    const after = await openAllocations(ctx.tx, reservationIds);
    if (after.some((a) => !lock.locked.has(a.position_id))) throw retryConflict();
    for (const item of items) {
      if (!item.line.reservation_id) continue;
      const rows = await ctx.tx.query<{
        allocation_id: string;
        position_id: string;
        location_id: string;
        take: string;
      }>(
        `with open as (
           select a.id, a.position_id, a.outstanding,
             sum(a.outstanding) over (order by a.id desc) as running
           from reservation_allocations a
           where a.shop_id = app_shop_id() and a.reservation_id = $1 and a.outstanding > 0),
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
           returning x.id, x.location_id)
         select p.id as allocation_id, p.position_id, pos.location_id, p.take::text
         from picks p join pos on pos.id = p.position_id order by p.id desc`,
        [item.line.reservation_id, item.quantity],
      );
      const total = sumQuantities(rows.map((r) => r.take));
      if (compare(total, item.quantity) !== 0) throw retryConflict();
      released.push(
        ...rows.map((r) => ({
          allocationId: r.allocation_id,
          positionId: r.position_id,
          locationId: r.location_id,
          quantity: r.take,
        })),
      );
    }
    await refreshStatuses(ctx.tx, reservationIds);
  }
  await bumpLines(ctx, items, 'cancelled');
  return { released, events };
}

export function addAll(values: string[]): string {
  return normalize(values.reduce((a, b) => add(a, b), '0'));
}
