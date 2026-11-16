import type { Tx } from '@airstock/db';
import type { AuditEvent } from '../audit.ts';
import { add, compare, normalize, subtract } from '../catalog/decimal.ts';
import { errors } from '../errors.ts';
import type { HandlerContext } from '../registry.ts';
import {
  allocate,
  applyStockCost,
  choosePositions,
  loadRuleScopes,
  normalizeCode,
  refreshStatuses,
  shortfall,
} from './engine.ts';
import {
  type AppliedMove,
  applyMoves,
  type EnteredPack,
  findPositions,
  keyOf,
  lockStock,
  openShortageReservations,
  type PositionKey,
  type StockMove,
  syncSerials,
} from './moves.ts';
import { fillShortages } from './shortages.ts';

// Adjusting stock at positions: the shared step behind counts, adjustments, and reversals
// (milestone I2, PRD 6.6). A change that takes units below what is reserved at a position needs
// an explicit choice per claim, release or reallocate; nothing is released silently and
// availability never goes below zero.

export interface StockChange {
  key: PositionKey;
  /** Signed base units. */
  delta?: string;
  /** Or: set on hand to this (a count); the delta is computed once the position is locked. */
  target?: string;
  pack?: EnteredPack | null;
  /** For units added back by a reversal: the cost they left with. */
  unitCost?: string | null;
}

export interface ClaimChoice {
  allocationId: string;
  action: 'release' | 'reallocate';
  quantity?: string | undefined;
}

export interface ClaimProblem {
  positionId: string;
  variantId: string;
  locationId: string;
  onHandAfter: string;
  reserved: string;
  toResolve: string;
  allocations: Array<{
    allocationId: string;
    reservationId: string;
    purpose: string;
    externalRef: string | null;
    outstanding: string;
  }>;
}

export interface AppliedChanges {
  /** The changes made, with deltas resolved (zero changes left out). */
  changes: Array<{ key: PositionKey; delta: string }>;
  moves: AppliedMove[];
  events: AuditEvent[];
  released: Array<{ allocationId: string; reservationId: string; quantity: string }>;
  reallocated: Array<{
    allocationId: string;
    reservationId: string;
    quantity: string;
    to: string[];
  }>;
  shortagesFilled: Array<{ reservationId: string; quantity: string }>;
  costs: Record<string, string | null>;
}

const positive = (q: string) => compare(q, '0') > 0;

/** Positions a reallocation may move claims to: sellable stock of the variants, anywhere. */
async function reallocationCandidates(
  tx: Tx,
  variantIds: string[],
  exclude: string[],
): Promise<string[]> {
  if (variantIds.length === 0) return [];
  const rows = await tx.query<{ id: string }>(
    `select p.id from inventory_positions p
     join locations l on l.shop_id = p.shop_id and l.id = p.location_id
     where p.variant_id = any($1::uuid[]) and p.transfer_id is null and p.on_hand > p.allocated
       and l.kind = 'storage' and l.status = 'active' and not (p.id = any($2::uuid[]))`,
    [variantIds, exclude],
  );
  return rows.map((r) => r.id);
}

/**
 * Applies signed changes at positions in one operation: lowers or raises on hand, settles the
 * claims that a lowering would leave uncovered (only as the caller chose), applies costs, writes
 * the ledger, keeps serials in step, and fills shortages from units that became sellable.
 * `prelocked` positions are already held (a count session locked them).
 */
export async function applyChanges(
  ctx: HandlerContext,
  operationId: string,
  kind: 'adjustment' | 'count' | 'reversal',
  keys: PositionKey[],
  resolve: () => Promise<StockChange[]>,
  choices: ClaimChoice[],
): Promise<AppliedChanges> {
  const existing = await findPositions(ctx.tx, keys);
  const variants = [...new Set(keys.map((k) => k.variantId))];
  const candidates = choices.some((c) => c.action === 'reallocate')
    ? await reallocationCandidates(
        ctx.tx,
        variants,
        existing.map((p) => p.id),
      )
    : [];
  // Reservations holding these positions, and open shortages that raised stock may fill.
  const holders = await ctx.tx.query<{ reservation_id: string; parent_id: string | null }>(
    `select distinct a.reservation_id, r.parent_id from reservation_allocations a
     join reservations r on r.shop_id = a.shop_id and r.id = a.reservation_id
     where a.position_id = any($1::uuid[]) and a.outstanding > 0`,
    [existing.map((p) => p.id)],
  );
  const sellable = [
    ...new Set(keys.filter((k) => k.condition === 'sellable').map((k) => k.variantId)),
  ];
  // 1–2. Every position in one ordered statement, then the reservations, in one.
  const lock = await lockStock(
    ctx,
    [...existing.map((p) => p.id), ...candidates],
    [
      ...holders.flatMap((h) =>
        h.parent_id ? [h.reservation_id, h.parent_id] : [h.reservation_id],
      ),
      ...(await openShortageReservations(ctx.tx, sellable)),
    ],
  );
  const events = [...lock.events];
  const requested = await resolve();

  // After the locks and lazy expiry: what each lowered position would keep against its claims.
  const now = await ctx.tx.query<{
    id: string;
    variant_id: string;
    location_id: string;
    on_hand: string;
    allocated: string;
    received_at: string | null;
  }>(
    `select id, variant_id, location_id, on_hand::text, allocated::text,
       to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as received_at
     from inventory_positions where id = any($1::uuid[])`,
    [existing.map((p) => p.id)],
  );
  const byKey = new Map(existing.map((p) => [keyOf(p), now.find((n) => n.id === p.id)!]));
  const live: Array<StockChange & { delta: string }> = [];
  for (const c of requested) {
    const delta =
      c.target !== undefined
        ? normalize(subtract(c.target, byKey.get(keyOf(c.key))?.on_hand ?? '0'))
        : normalize(c.delta ?? '0');
    if (compare(delta, '0') !== 0) live.push({ ...c, delta });
  }
  const lowering = live.filter((c) => !positive(c.delta));
  const raisedSellable = [
    ...new Set(
      live
        .filter((c) => positive(c.delta) && c.key.condition === 'sellable')
        .map((c) => c.key.variantId),
    ),
  ];
  const problems: ClaimProblem[] = [];
  const released: AppliedChanges['released'] = [];
  const reallocated: AppliedChanges['reallocated'] = [];
  const used = new Set<string>();
  for (const c of lowering) {
    const pos = byKey.get(keyOf(c.key));
    const out = normalize(c.delta.replace(/^-/, ''));
    if (!pos || compare(pos.on_hand, out) < 0) {
      throw errors.conflict('below_zero', 'This would take more units than the position holds.', {
        variantId: c.key.variantId,
        locationId: c.key.locationId,
        onHand: pos?.on_hand ?? '0',
      });
    }
    const after = normalize(subtract(pos.on_hand, out));
    if (compare(pos.allocated, after) <= 0) continue;
    const toResolve = normalize(subtract(pos.allocated, after));
    const allocations = await ctx.tx.query<{
      allocationId: string;
      reservationId: string;
      purpose: string;
      externalRef: string | null;
      outstanding: string;
      locationLimit: string | null;
      lotLimit: string | null;
      channel: string;
      variantId: string;
    }>(
      `select a.id as "allocationId", a.reservation_id as "reservationId", r.purpose,
         coalesce(r.external_ref, p.external_ref) as "externalRef", a.outstanding::text as outstanding,
         r.location_id as "locationLimit", r.lot_id as "lotLimit", r.channel, r.variant_id as "variantId"
       from reservation_allocations a
       join reservations r on r.shop_id = a.shop_id and r.id = a.reservation_id
       left join reservations p on p.shop_id = r.shop_id and p.id = r.parent_id
       where a.position_id = $1 and a.outstanding > 0
       order by a.id desc`,
      [pos.id],
    );
    let covered = '0';
    for (const a of allocations) {
      const choice = choices.find((x) => x.allocationId === a.allocationId);
      if (!choice) continue;
      used.add(a.allocationId);
      const q = normalize(choice.quantity ?? a.outstanding);
      if (!positive(q) || compare(q, a.outstanding) > 0) {
        throw errors.unprocessable(
          'choice_exceeds_claim',
          'A choice names more units than the claim holds.',
          { allocationId: a.allocationId, outstanding: a.outstanding },
        );
      }
      if (choice.action === 'release') {
        if (a.purpose === 'transfer') {
          throw errors.unprocessable(
            'reservation_is_transfer',
            'A transfer hold cannot be released here: cancel that quantity on the transfer, or reallocate the hold.',
            { allocationId: a.allocationId },
          );
        }
        await ctx.tx.query(
          `with alloc as (
             update reservation_allocations set released = released + $2::numeric where id = $1
             returning position_id)
           update inventory_positions p set allocated = p.allocated - $2::numeric,
             version = p.version + 1, updated_at = now()
           from alloc where p.shop_id = app_shop_id() and p.id = alloc.position_id`,
          [a.allocationId, q],
        );
        pos.allocated = normalize(subtract(pos.allocated, q));
        released.push({
          allocationId: a.allocationId,
          reservationId: a.reservationId,
          quantity: q,
        });
      } else {
        // Reallocate within the claim's own limits: its location (a transfer's source), lot, and
        // channel rule, among the locked candidates.
        const allowed = await ctx.tx.query<{ id: string }>(
          `select p.id from inventory_positions p
           join locations l on l.shop_id = p.shop_id and l.id = p.location_id
           where p.id = any($1::uuid[]) and p.variant_id = $2
             and ($3::uuid is null or l.path_ids @> array[$3::uuid])
             and ($4::uuid is null or p.lot_id = $4)
             and p.condition = (select condition from inventory_positions where id = $5)`,
          [
            [...lock.locked].filter((id) => id !== pos.id),
            a.variantId,
            a.locationLimit,
            a.lotLimit,
            pos.id,
          ],
        );
        const transfer = a.purpose === 'transfer';
        const ruleScopes = transfer ? null : await loadRuleScopes(ctx.tx, a.channel);
        let picks: Awaited<ReturnType<typeof choosePositions>>['picks'];
        if (transfer) {
          // Transfer holds may sit on stock that is not for sale; take any free units.
          const free = await ctx.tx.query<{
            id: string;
            location_id: string;
            lot_id: string | null;
            serial_id: string | null;
            free: string;
          }>(
            `select id, location_id, lot_id, serial_id, (on_hand - allocated)::text as free
             from inventory_positions where id = any($1::uuid[]) and on_hand > allocated
             order by received_at nulls last, id`,
            [allowed.map((x) => x.id)],
          );
          picks = [];
          let rest = q;
          for (const f of free) {
            if (!positive(rest)) break;
            const take = compare(f.free, rest) < 0 ? normalize(f.free) : rest;
            picks.push({
              variantId: a.variantId,
              positionId: f.id,
              locationId: f.location_id,
              lotId: f.lot_id,
              serialId: f.serial_id,
              quantity: take,
            });
            rest = normalize(subtract(rest, take));
          }
        } else {
          picks = (
            await choosePositions(
              ctx.tx,
              [{ variantId: a.variantId, quantity: q }],
              allowed.map((x) => x.id),
              ruleScopes,
            )
          ).picks;
        }
        if (shortfall(q, picks, a.variantId) !== '0') {
          throw errors.conflict(
            'insufficient_stock',
            'Not enough free stock elsewhere to move this claim to; release it instead.',
            { allocationId: a.allocationId, requested: q },
          );
        }
        await ctx.tx.query(
          `with src as (
             update reservation_allocations set moved = moved + $2::numeric where id = $1
             returning position_id)
           update inventory_positions p set allocated = p.allocated - $2::numeric,
             version = p.version + 1, updated_at = now()
           from src where p.shop_id = app_shop_id() and p.id = src.position_id`,
          [a.allocationId, q],
        );
        const made = await allocate(
          ctx,
          new Map([[a.variantId, a.reservationId]]),
          picks,
          a.allocationId,
        );
        pos.allocated = normalize(subtract(pos.allocated, q));
        reallocated.push({
          allocationId: a.allocationId,
          reservationId: a.reservationId,
          quantity: q,
          to: made.map((m) => m.positionId),
        });
      }
      covered = normalize(add(covered, q));
    }
    if (compare(pos.allocated, after) > 0) {
      problems.push({
        positionId: pos.id,
        variantId: pos.variant_id,
        locationId: pos.location_id,
        onHandAfter: after,
        reserved: pos.allocated,
        toResolve: normalize(subtract(pos.allocated, after)),
        allocations: allocations.map((a) => ({
          allocationId: a.allocationId,
          reservationId: a.reservationId,
          purpose: a.purpose,
          externalRef: a.externalRef,
          outstanding: a.outstanding,
        })),
      });
    }
    void toResolve;
  }
  if (problems.length > 0) {
    throw errors.conflict(
      'below_reserved',
      'This leaves fewer units than are reserved. Choose, per claim, to release it or reallocate it to other stock (reservationChoices).',
      { positions: problems },
    );
  }
  const unused = choices.filter((c) => !used.has(c.allocationId));
  if (unused.length > 0) {
    throw errors.unprocessable(
      'choice_not_needed',
      'A choice names a claim this change does not affect.',
      { allocationIds: unused.map((c) => c.allocationId) },
    );
  }
  const touched = [...new Set([...released, ...reallocated].map((r) => r.reservationId))];
  if (touched.length > 0) await refreshStatuses(ctx.tx, touched);

  // 3. Costs per variant in id order: units out at the average; units in at the average (or the
  // default cost without stock), or at the cost a reversal brings back.
  const costs = new Map<string, { unitCost: string | null; costBasis: string }>();
  const costOf = new Map<
    StockChange & { delta: string },
    { unitCost: string | null; costBasis: string }
  >();
  const costKind = kind === 'count' ? 'count' : 'adjustment';
  for (const variantId of [...new Set(live.map((c) => c.key.variantId))].sort()) {
    const mine = live.filter((c) => c.key.variantId === variantId);
    const outs = mine.filter((c) => !positive(c.delta));
    if (outs.length > 0) {
      const total = outs.reduce((s, c) => add(s, c.delta.replace(/^-/, '')), '0');
      const cost = await applyStockCost(
        ctx,
        variantId,
        operationId,
        costKind,
        `-${normalize(total)}`,
        null,
      );
      for (const c of outs) costOf.set(c, cost);
      costs.set(variantId, cost);
    }
    const ins = mine.filter((c) => positive(c.delta));
    const groups = new Map<string, Array<StockChange & { delta: string }>>();
    for (const c of ins) {
      const k = c.unitCost ?? '';
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    for (const [k, group] of groups) {
      const total = group.reduce((s, c) => add(s, c.delta), '0');
      const cost = await applyStockCost(
        ctx,
        variantId,
        operationId,
        costKind,
        normalize(total),
        k === '' ? null : k,
      );
      for (const c of group) costOf.set(c, cost);
      if (!costs.has(variantId)) costs.set(variantId, cost);
    }
  }

  await checkSerials(ctx, live, byKey);

  const moves: StockMove[] = live.map((c) => {
    const pos = byKey.get(keyOf(c.key));
    const q = normalize(c.delta.replace(/^-/, ''));
    return positive(c.delta)
      ? {
          variantId: c.key.variantId,
          quantity: q,
          lotId: c.key.lotId,
          serialId: c.key.serialId,
          from: null,
          to: { locationId: c.key.locationId, condition: c.key.condition, transferId: null },
          cost: costOf.get(c) ?? null,
          pack: c.pack ?? null,
        }
      : {
          variantId: c.key.variantId,
          quantity: q,
          lotId: c.key.lotId,
          serialId: c.key.serialId,
          from: { positionId: pos!.id, locationId: c.key.locationId, receivedAt: pos!.received_at },
          to: null,
          cost: costOf.get(c) ?? null,
          pack: c.pack ?? null,
        };
  });
  const applied = await applyMoves(ctx, operationId, moves);
  await syncSerials(ctx, operationId, applied, 'written_off');

  const shortagesFilled: AppliedChanges['shortagesFilled'] = [];
  for (const variantId of raisedSellable) {
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
  return {
    changes: live.map((c) => ({ key: c.key, delta: c.delta })),
    moves: applied,
    events,
    released,
    reallocated,
    shortagesFilled,
    costs: Object.fromEntries([...costs].map(([v, c]) => [v, c.unitCost])),
  };
}

/**
 * Locks the serial units the changes move (step 3 of the lock order, after the cost rows, as
 * fulfillments and return receipts take them) and checks them again now that the positions are
 * held: the checks before the locks were plain reads. A serial added must be out of stock (not on
 * hand anywhere, not in transit); a serial removed must be on hand at that position. Without this
 * a concurrent find, return, or the reversal of a removal could put one serial in two places.
 */
async function checkSerials(
  ctx: HandlerContext,
  live: Array<StockChange & { delta: string }>,
  byKey: Map<string, { id: string }>,
): Promise<void> {
  const changes = live.filter((c) => c.key.serialId);
  if (changes.length === 0) return;
  const units = await ctx.tx.query<{
    id: string;
    serial: string;
    status: string;
    position_id: string | null;
  }>(
    `select id, serial, status, position_id from serial_units
     where id = any($1::uuid[]) order by id for update`,
    [[...new Set(changes.map((c) => c.key.serialId!))]],
  );
  for (const c of changes) {
    const unit = units.find((u) => u.id === c.key.serialId);
    if (!unit) throw errors.notFound('Serial');
    const held = unit.status === 'in_stock' || unit.status === 'in_transit';
    if (positive(c.delta)) {
      if (held) {
        throw errors.conflict(
          'serial_in_stock',
          `Serial ${unit.serial} is already in stock elsewhere; move it instead.`,
          { serial: unit.serial },
        );
      }
    } else if (!held || unit.position_id !== byKey.get(keyOf(c.key))?.id) {
      throw errors.conflict(
        'serial_not_here',
        `Serial ${unit.serial} is not at this location in this condition.`,
        { serial: unit.serial },
      );
    }
  }
}

/** Serial units by serial for a variant; unknown ones are created (not in stock) to be found. */
export async function serialsFor(
  ctx: HandlerContext,
  variantId: string,
  serials: string[],
  operationId: string,
): Promise<
  Array<{
    id: string;
    serial: string;
    normalized: string;
    status: string;
    positionId: string | null;
  }>
> {
  const normalized = serials.map(normalizeCode);
  const known = await ctx.tx.query<{
    id: string;
    serial: string;
    normalized: string;
    status: string;
    positionId: string | null;
  }>(
    `select id, serial, serial_normalized as normalized, status, position_id as "positionId"
     from serial_units where variant_id = $1 and serial_normalized = any($2::text[])`,
    [variantId, normalized],
  );
  const out = [...known];
  for (let i = 0; i < serials.length; i++) {
    if (known.some((k) => k.normalized === normalized[i])) continue;
    const id = ctx.newId();
    await ctx.tx.query(
      `insert into serial_units (shop_id, id, variant_id, serial, serial_normalized, status,
         position_id, created_operation_id, last_operation_id)
       values (app_shop_id(), $1, $2, $3, $4, 'written_off', null, $5, $5)`,
      [id, variantId, serials[i]!.trim(), normalized[i], operationId],
    );
    out.push({
      id,
      serial: serials[i]!.trim(),
      normalized: normalized[i]!,
      status: 'written_off',
      positionId: null,
    });
  }
  return out;
}
