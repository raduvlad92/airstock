import type { Tx } from '@airstock/db';
import { add, compare, normalize } from '../catalog/decimal.ts';
import { errors } from '../errors.ts';
import type { HandlerContext } from '../registry.ts';
import { exactProduct, expireClaimsAt } from './engine.ts';

// Moving units between positions: the shared step behind transfers, returns, counts,
// adjustments, and condition changes (milestone I2). Every function here expects the caller to
// hold the locks already (ADR 0006: positions by id, then reservations by id, then the rest), so
// they only read and write rows the command has locked or rows it creates.

export interface PositionKey {
  variantId: string;
  locationId: string;
  condition: string;
  lotId: string | null;
  serialId: string | null;
  transferId: string | null;
}

export function keyOf(k: PositionKey): string {
  return [k.variantId, k.locationId, k.condition, k.lotId, k.serialId, k.transferId].join('|');
}

/** A stock position as stock commands read it after locking. */
export interface PositionRow {
  id: string;
  variantId: string;
  locationId: string;
  condition: string;
  lotId: string | null;
  serialId: string | null;
  transferId: string | null;
  onHand: string;
  allocated: string;
  receivedAt: string | null;
  version: number;
}

const POSITION_COLUMNS = `p.id, p.variant_id as "variantId", p.location_id as "locationId",
  p.condition, p.lot_id as "lotId", p.serial_id as "serialId", p.transfer_id as "transferId",
  p.on_hand::text as "onHand", p.allocated::text as "allocated",
  to_char(p.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "receivedAt",
  p.version::int as version`;

export async function readPositions(tx: Tx, ids: string[]): Promise<PositionRow[]> {
  if (ids.length === 0) return [];
  return tx.query<PositionRow>(
    `select ${POSITION_COLUMNS} from inventory_positions p where p.id = any($1::uuid[]) order by p.id`,
    [ids],
  );
}

/** Existing positions with these identities (not locked). */
export async function findPositions(tx: Tx, keys: PositionKey[]): Promise<PositionRow[]> {
  if (keys.length === 0) return [];
  return tx.query<PositionRow>(
    `select ${POSITION_COLUMNS}
     from jsonb_to_recordset($1::jsonb) as k("variantId" uuid, "locationId" uuid, condition text,
       "lotId" uuid, "serialId" uuid, "transferId" uuid)
     join inventory_positions p on p.shop_id = app_shop_id() and p.variant_id = k."variantId"
       and p.location_id = k."locationId" and p.condition = k.condition
       and p.lot_id is not distinct from k."lotId" and p.serial_id is not distinct from k."serialId"
       and p.transfer_id is not distinct from k."transferId"`,
    [JSON.stringify(keys)],
  );
}

/**
 * Locks positions in id order and releases the expired claims on them, locking those
 * reservations and `reservations` together in id order (steps 1 and 2 of the lock order).
 * Returns the locked ids and the expiry events.
 */
export async function lockStock(
  ctx: HandlerContext,
  positionIds: string[],
  reservationIds: string[] = [],
): Promise<{ locked: Set<string>; events: Awaited<ReturnType<typeof expireClaimsAt>> }> {
  const ids = [...new Set(positionIds)];
  const rows =
    ids.length === 0
      ? []
      : await ctx.tx.query<{ id: string }>(
          'select id from inventory_positions where id = any($1::uuid[]) order by id for update',
          [ids],
        );
  const locked = new Set(rows.map((r) => r.id));
  const events = await expireClaimsAt(ctx, [...locked], reservationIds);
  return { locked, events };
}

/**
 * Open shortage reservations of these variants (and their bundle headers), so a command that
 * brings sellable stock can lock them with its other reservations in one ordered statement
 * before `fillShortages` runs (ADR 0021).
 */
export async function openShortageReservations(tx: Tx, variantIds: string[]): Promise<string[]> {
  if (variantIds.length === 0) return [];
  const rows = await tx.query<{ id: string; parent_id: string | null }>(
    `select id, parent_id from reservations
     where variant_id = any($1::uuid[]) and shortage_quantity > 0
       and status in ('active', 'partially_fulfilled')`,
    [variantIds],
  );
  return [...new Set(rows.flatMap((r) => (r.parent_id ? [r.id, r.parent_id] : [r.id])))];
}

export interface EnteredPack {
  packId: string;
  packName: string;
  packVersion: number;
  quantity: string;
  factor: string;
}

/** Converts a quantity entered in a pack into base units, exactly, with the pack's version. */
export async function resolvePack(
  tx: Tx,
  variantId: string,
  packId: string | undefined,
  quantity: string,
): Promise<{ base: string; pack: EnteredPack | null }> {
  if (!packId) return { base: normalize(quantity), pack: null };
  const [row] = await tx.query<{
    id: string;
    name: string;
    version: number;
    base_quantity: string;
    status: string;
  }>(
    `select id, name, version, base_quantity::text, status from packs
     where id = $1 and variant_id = $2`,
    [packId, variantId],
  );
  if (!row) throw errors.notFound('Pack');
  if (row.status !== 'active') throw errors.conflict('pack_archived', 'The pack is archived.');
  const factor = normalize(row.base_quantity);
  return {
    base: normalize(exactProduct(quantity, factor)),
    pack: {
      packId: row.id,
      packName: row.name,
      packVersion: row.version,
      quantity: normalize(quantity),
      factor,
    },
  };
}

export interface StockMove {
  variantId: string;
  /** Base units, greater than zero. */
  quantity: string;
  lotId: string | null;
  serialId: string | null;
  /** Out of this (locked) position; `allocationId` is a claim the move consumes. */
  from: {
    positionId: string;
    locationId: string;
    receivedAt: string | null;
    allocationId?: string | null;
  } | null;
  /** Into the position with this identity (lot and serial from the move). */
  to: { locationId: string; condition: string; transferId: string | null } | null;
  /** The reservation a consumed claim belongs to, recorded on the entries. */
  reservationId?: string | null;
  /** The unit cost the entries record and where it came from (ADR 0022). */
  cost?: { unitCost: string | null; costBasis: string } | null;
  /** The pack the quantity was entered in; recorded on an entry when it divides exactly. */
  pack?: EnteredPack | null;
}

export interface AppliedMove extends StockMove {
  toPositionId: string | null;
}

/**
 * Applies moves: lowers the source positions (and their consumed claims), raises or creates the
 * destination positions, and writes one ledger entry per side. Sources must be locked; a
 * destination that already exists should be locked too, or be one only this command touches.
 * The `allocated <= on_hand` check stays the last defence: a move never takes units another
 * claim holds unless it consumes that claim.
 */
export async function applyMoves(
  ctx: HandlerContext,
  operationId: string,
  moves: StockMove[],
): Promise<AppliedMove[]> {
  const live = moves.filter((m) => compare(m.quantity, '0') > 0);
  if (live.length === 0) return [];

  // 1. Sources: on hand down, consumed claims settled.
  const outs = live.filter((m) => m.from);
  if (outs.length > 0) {
    await ctx.tx.query(
      `with m as (
         select * from jsonb_to_recordset($1::jsonb)
           as x("positionId" uuid, quantity numeric, "allocationId" uuid)),
       alloc as (
         update reservation_allocations a set fulfilled = a.fulfilled + s.quantity
         from (select "allocationId", sum(quantity) as quantity from m
               where "allocationId" is not null group by "allocationId") s
         where a.shop_id = app_shop_id() and a.id = s."allocationId")
       update inventory_positions p
       set on_hand = p.on_hand - s.quantity, allocated = p.allocated - s.consumed,
         version = p.version + 1, updated_at = now()
       from (select "positionId", sum(quantity) as quantity,
               coalesce(sum(quantity) filter (where "allocationId" is not null), 0) as consumed
             from m group by "positionId") s
       where p.shop_id = app_shop_id() and p.id = s."positionId"`,
      [
        JSON.stringify(
          outs.map((m) => ({
            positionId: m.from!.positionId,
            quantity: m.quantity,
            allocationId: m.from!.allocationId ?? null,
          })),
        ),
      ],
    );
  }

  // 2. Destinations: one upsert per identity (a statement may not touch a row twice).
  const ins = new Map<
    string,
    { key: PositionKey; quantity: string; receivedAt: string | null; id: string }
  >();
  for (const m of live) {
    if (!m.to) continue;
    const key: PositionKey = {
      variantId: m.variantId,
      locationId: m.to.locationId,
      condition: m.to.condition,
      lotId: m.lotId,
      serialId: m.serialId,
      transferId: m.to.transferId,
    };
    const k = keyOf(key);
    const at = m.from?.receivedAt ?? null;
    const prev = ins.get(k);
    if (prev) {
      prev.quantity = normalize(add(prev.quantity, m.quantity));
      if (at && (!prev.receivedAt || at < prev.receivedAt)) prev.receivedAt = at;
    } else ins.set(k, { key, quantity: normalize(m.quantity), receivedAt: at, id: ctx.newId() });
  }
  const destIds = new Map<string, string>();
  if (ins.size > 0) {
    const rows = await ctx.tx.query<{ id: string; key: string }>(
      `with x as (
         select * from jsonb_to_recordset($1::jsonb) as x(id uuid, k text, "variantId" uuid,
           "locationId" uuid, condition text, "lotId" uuid, "serialId" uuid, "transferId" uuid,
           quantity numeric, "receivedAt" timestamptz))
       insert into inventory_positions (shop_id, id, variant_id, location_id, condition, lot_id,
         serial_id, transfer_id, on_hand, received_at)
       select app_shop_id(), x.id, x."variantId", x."locationId", x.condition, x."lotId",
         x."serialId", x."transferId", x.quantity, coalesce(x."receivedAt", now())
       from x
       on conflict on constraint inventory_positions_identity
       do update set on_hand = inventory_positions.on_hand + excluded.on_hand,
         received_at = case when inventory_positions.on_hand = 0 then excluded.received_at
           else least(inventory_positions.received_at, excluded.received_at) end,
         version = inventory_positions.version + 1, updated_at = now()
       returning id, (select x.k from x where x."variantId" = inventory_positions.variant_id
         and x."locationId" = inventory_positions.location_id
         and x.condition = inventory_positions.condition
         and x."lotId" is not distinct from inventory_positions.lot_id
         and x."serialId" is not distinct from inventory_positions.serial_id
         and x."transferId" is not distinct from inventory_positions.transfer_id) as key`,
      [
        JSON.stringify(
          [...ins.entries()].map(([k, v]) => ({
            id: v.id,
            k,
            ...v.key,
            quantity: v.quantity,
            receivedAt: v.receivedAt,
          })),
        ),
      ],
    );
    for (const r of rows) destIds.set(r.key, r.id);
  }

  // 3. The ledger: one entry per side of each move.
  const applied: AppliedMove[] = live.map((m) => ({
    ...m,
    toPositionId: m.to
      ? (destIds.get(
          keyOf({
            variantId: m.variantId,
            locationId: m.to.locationId,
            condition: m.to.condition,
            lotId: m.lotId,
            serialId: m.serialId,
            transferId: m.to.transferId,
          }),
        ) ?? null)
      : null,
  }));
  const entries = applied.flatMap((m) => {
    const common = {
      variantId: m.variantId,
      lotId: m.lotId,
      serialId: m.serialId,
      reservationId: m.reservationId ?? null,
      unitCost: m.cost?.unitCost ?? null,
      costBasis: m.cost?.costBasis ?? null,
      packId: m.serialId ? null : (m.pack?.packId ?? null),
      packVersion: m.serialId ? null : (m.pack?.packVersion ?? null),
      factor: m.serialId ? null : (m.pack?.factor ?? null),
    };
    return [
      ...(m.from
        ? [
            {
              ...common,
              id: ctx.newId(),
              positionId: m.from.positionId,
              locationId: m.from.locationId,
              delta: `-${normalize(m.quantity)}`,
            },
          ]
        : []),
      ...(m.to && m.toPositionId
        ? [
            {
              ...common,
              id: ctx.newId(),
              positionId: m.toPositionId,
              locationId: m.to.locationId,
              delta: normalize(m.quantity),
            },
          ]
        : []),
    ];
  });
  if (entries.some((e) => !e.positionId)) throw errors.internal();
  // A pack is recorded on an entry only when the entry is a whole number of packs at 6 places
  // (inventory_entries_pack_quantities); the operation's audit event keeps what was entered.
  await ctx.tx.query(
    `insert into inventory_entries (shop_id, id, operation_id, position_id, variant_id, location_id,
       delta, lot_id, serial_id, reservation_id, unit_cost, cost_basis, pack_id, pack_version,
       entered_quantity, conversion_factor)
     select app_shop_id(), x.id, $2, x."positionId", x."variantId", x."locationId", x.delta,
       x."lotId", x."serialId", x."reservationId", x."unitCost", x."costBasis",
       case when exact then x."packId" end, case when exact then x."packVersion" end,
       case when exact then entered end, case when exact then x.factor end
     from jsonb_to_recordset($1::jsonb) as x(id uuid, "positionId" uuid, "variantId" uuid,
       "locationId" uuid, delta numeric, "lotId" uuid, "serialId" uuid, "reservationId" uuid,
       "unitCost" numeric, "costBasis" text, "packId" uuid, "packVersion" integer, factor numeric)
     cross join lateral (select round(abs(x.delta) / x.factor, 6) as entered) e
     cross join lateral (select x."packId" is not null and x.factor is not null
       and e.entered * x.factor = abs(x.delta) as exact) q`,
    [JSON.stringify(entries), operationId],
  );
  return applied;
}

/**
 * Keeps serial units in step with moves: a serial that lands in a position is there (in stock,
 * or in transit for a transfer position); one that leaves stock gets `outStatus`.
 *
 * Each update is guarded by where the serial is now: a move out of a position needs the serial
 * at that position, and a move from outside stock (a find, a return, a reversal) needs it out of
 * stock. The row update re-checks a concurrently committed change, so one serial can never be on
 * hand twice (serial_in_stock) or leave a position it is not at (serial_not_here).
 */
export async function syncSerials(
  ctx: HandlerContext,
  operationId: string,
  moves: AppliedMove[],
  outStatus: 'sold' | 'written_off' = 'written_off',
): Promise<void> {
  const rows = moves
    .filter((m) => m.serialId)
    .map((m) => ({
      serialId: m.serialId,
      positionId: m.toPositionId,
      fromPositionId: m.from?.positionId ?? null,
      status: m.to ? (m.to.transferId ? 'in_transit' : 'in_stock') : outStatus,
    }))
    .sort((a, b) => (a.serialId! < b.serialId! ? -1 : 1));
  if (rows.length === 0) return;
  const updated = await ctx.tx.query<{ id: string }>(
    `update serial_units s set status = x.status, position_id = x."positionId",
       last_operation_id = $2, updated_at = now(), version = s.version + 1
     from jsonb_to_recordset($1::jsonb)
       as x("serialId" uuid, "positionId" uuid, "fromPositionId" uuid, status text)
     where s.shop_id = app_shop_id() and s.id = x."serialId"
       and case when x."fromPositionId" is null
         then s.status not in ('in_stock', 'in_transit')
         else s.status in ('in_stock', 'in_transit') and s.position_id = x."fromPositionId" end
     returning s.id`,
    [JSON.stringify(rows), operationId],
  );
  if (updated.length === rows.length) return;
  const done = new Set(updated.map((u) => u.id));
  const failed = rows.filter((r) => !done.has(r.serialId!));
  const serials = await ctx.tx.query<{ serial: string }>(
    'select serial from serial_units where id = any($1::uuid[]) order by serial',
    [failed.map((f) => f.serialId)],
  );
  const names = serials.map((x) => x.serial);
  if (failed.some((f) => f.fromPositionId === null)) {
    throw errors.conflict(
      'serial_in_stock',
      `Serial ${names.join(', ')} is already in stock elsewhere; move it instead.`,
      { serials: names },
    );
  }
  throw errors.conflict(
    'serial_not_here',
    `Serial ${names.join(', ')} is no longer at this position.`,
    { serials: names },
  );
}

/** The shop's in-transit system location (migration 0017). */
export async function inTransitLocation(tx: Tx): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    "select id from locations where kind = 'in_transit'",
  );
  if (!row) throw errors.internal();
  return row.id;
}

/** Serial units by their normalized serial, for one variant. */
export async function findSerials(
  tx: Tx,
  variantId: string,
  normalized: string[],
): Promise<
  Array<{
    id: string;
    serial: string;
    normalized: string;
    status: string;
    positionId: string | null;
  }>
> {
  if (normalized.length === 0) return [];
  return tx.query(
    `select id, serial, serial_normalized as normalized, status, position_id as "positionId"
     from serial_units where variant_id = $1 and serial_normalized = any($2::text[])`,
    [variantId, normalized],
  );
}
