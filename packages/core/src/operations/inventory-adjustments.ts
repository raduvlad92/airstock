import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { add, compare, normalize, subtract } from '../catalog/decimal.ts';
import { PositiveDecimal } from '../decimal.ts';
import { errors } from '../errors.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id } from '../schemas.ts';
import {
  type AppliedChanges,
  applyChanges,
  type StockChange,
  serialsFor,
} from '../stock/adjust.ts';
import {
  actorColumns,
  assertScale,
  canSeeCosts,
  loadStockVariant,
  normalizeCode,
  type StockVariant,
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
  syncSerials,
} from '../stock/moves.ts';
import { fillShortages } from '../stock/shortages.ts';
import { LotCode, StockCondition } from './inventory.ts';

// Adjustments with reasons, condition changes, and reversals (plan D10, Section 5.6, PRD 6.6,
// ADR "Counts and adjustments"). Every adjustment has a reason; a change below reserved stock
// needs an explicit choice per claim; a reversal is a new operation linked to the original.

export const TOOL = 'adjust_stock';

export const Note = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .describe('Anything worth keeping with the change; kept in the history.');
export const Serials = z.array(z.string().trim().min(1).max(100)).min(1).max(500);

export const ADJUSTMENT_REASONS = [
  'count_correction',
  'damage',
  'loss_or_theft',
  'found',
  'write_off',
  'sample',
  'supplier_return',
  'other',
] as const;

export const ReservationChoices = z
  .array(
    z.object({
      allocationId: Id,
      action: z
        .enum(['release', 'reallocate'])
        .describe('release frees the claim; reallocate moves it to other free stock.'),
      quantity: PositiveDecimal.optional().describe('Leave out for the whole claim.'),
    }),
  )
  .max(200)
  .optional()
  .describe(
    'When a change leaves fewer units than are reserved: per claim, release it or move it elsewhere. The error below_reserved lists the claims.',
  );

export const ChangesOut = z.object({
  changes: z.array(
    z.object({
      variantId: Id,
      locationId: Id,
      condition: z.string(),
      lotId: Id.nullable(),
      serialId: Id.nullable(),
      delta: z.string().describe('Signed base units.'),
    }),
  ),
  released: z.array(z.object({ allocationId: Id, reservationId: Id, quantity: z.string() })),
  reallocated: z.array(
    z.object({ allocationId: Id, reservationId: Id, quantity: z.string(), to: z.array(Id) }),
  ),
  shortagesFilled: z.array(z.object({ reservationId: Id, quantity: z.string() })),
  costVisible: z.boolean(),
  unitCosts: z
    .record(z.string(), z.string().nullable())
    .nullable()
    .describe('Per variant, the cost the change used; needs costs.read.'),
});

export function changesOut(ctx: HandlerContext, applied: AppliedChanges) {
  const visible = canSeeCosts(ctx);
  return {
    changes: applied.changes.map((c) => ({
      variantId: c.key.variantId,
      locationId: c.key.locationId,
      condition: c.key.condition,
      lotId: c.key.lotId,
      serialId: c.key.serialId,
      delta: c.delta,
    })),
    released: applied.released,
    reallocated: applied.reallocated,
    shortagesFilled: applied.shortagesFilled,
    costVisible: visible,
    unitCosts: visible ? applied.costs : null,
  };
}

export function availabilityOutbox(moves: AppliedMove[]) {
  const byVariant = new Map<string, Set<string>>();
  for (const m of moves) {
    const set = byVariant.get(m.variantId) ?? new Set<string>();
    for (const l of [m.from?.locationId, m.to?.locationId]) if (l) set.add(l);
    byVariant.set(m.variantId, set);
  }
  return [...byVariant].map(([variantId, locations]) => ({
    topic: 'inventory.availability_changed',
    payload: { variantId, locationIds: [...locations] },
  }));
}

/** A leaf storage location that can hold stock, share-locked against archive or move. */
export async function stockLocation(tx: Tx, locationId: string): Promise<void> {
  const [loc] = await tx.query<{ status: string; leaf: boolean }>(
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
      'Stock is held only at locations without sub-locations: name the shelf.',
    );
  }
}

export async function lotId(
  tx: Tx,
  variant: StockVariant,
  lotCode: string | undefined,
  required: boolean,
): Promise<string | null> {
  const tracked = variant.trackingMode === 'lot' || variant.trackingMode === 'lot_expiry';
  if (!tracked) {
    if (lotCode)
      throw errors.unprocessable('not_lot_tracked', `${variant.sku} is not tracked by lot.`);
    return null;
  }
  if (!lotCode) {
    if (!required) return null;
    throw errors.unprocessable('lot_required', `${variant.sku} is tracked by lot: give lotCode.`);
  }
  const [lot] = await tx.query<{ id: string }>(
    'select id from lots where variant_id = $1 and code_normalized = $2',
    [variant.id, normalizeCode(lotCode)],
  );
  if (!lot) {
    throw errors.unprocessable(
      'unknown_lot',
      'This lot was never received; receive new stock with receive_stock.',
      { lotCode },
    );
  }
  return lot.id;
}

// Adjust ----------------------------------------------------------------------------------------

const Adjustment = z.object({
  variantId: Id,
  direction: z.enum(['add', 'remove']),
  quantity: PositiveDecimal.optional().describe(
    'Base units, or packs with packId. Serial-tracked items give serials instead.',
  ),
  packId: Id.optional(),
  lotCode: LotCode.optional(),
  serials: Serials.optional(),
});

export const adjustStock = defineOperation({
  id: 'inventory.adjustments.create',
  summary: 'Adjust stock up or down with a reason',
  description:
    'Use this to correct stock at one location with a reason: damage, loss or theft, found, write-off, sample, supplier return, count correction, or other (with a note). Units removed leave valuation at the moving average; units added come in at the average. Lot-tracked items name the lot; serial-tracked items name the serials. If a removal leaves fewer units than are reserved, the error lists the claims: retry with reservationChoices. Not for counted totals (use action "count"), receiving deliveries (receive_stock), or moving stock (transfer_stock).',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    locationId: Id.describe('The shelf (a location without sub-locations).'),
    condition: StockCondition.default('sellable'),
    adjustmentReason: z.enum(ADJUSTMENT_REASONS),
    adjustments: z.array(Adjustment).min(1).max(200),
    note: Note.optional(),
    reservationChoices: ReservationChoices,
  }),
  output: ChangesOut.extend({ operationId: Id }),
  permission: 'inventory.adjust',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.adjustment.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/adjustments', status: 201 },
  mcp: { tool: TOOL, action: 'adjust', readOnly: false, destructive: true },
  locations: (input) => [input.locationId],
  async handler(ctx, input) {
    if (input.adjustmentReason === 'other' && !input.note) {
      throw errors.unprocessable(
        'note_required',
        'Say what happened in a note for reason "other".',
      );
    }
    await stockLocation(ctx.tx, input.locationId);
    const operationId = ctx.newId();
    await ctx.tx.query(
      `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
         reason)
       values (app_shop_id(), $1, 'adjustment', $2, $3, $4, $5, $6)`,
      [operationId, ...actorColumns(ctx), input.adjustmentReason],
    );
    const changes: StockChange[] = [];
    const seen = new Set<string>();
    for (const a of [...input.adjustments].sort((x, y) => (x.variantId < y.variantId ? -1 : 1))) {
      const variant = await loadStockVariant(ctx.tx, a.variantId);
      if (variant.bundleId) {
        throw errors.unprocessable('bundle_holds_no_stock', 'A bundle holds no stock of its own.');
      }
      const sign = a.direction === 'add' ? '' : '-';
      let pack: EnteredPack | null = null;
      if (variant.trackingMode === 'serial') {
        if (!a.serials)
          throw errors.unprocessable('serials_required', `Give the serials of ${variant.sku}.`);
        if (a.quantity !== undefined && compare(a.quantity, String(a.serials.length)) !== 0) {
          throw errors.unprocessable('serial_count_mismatch', 'Give one serial for each unit.');
        }
        const units = await serialsFor(ctx, variant.id, a.serials, operationId);
        for (const u of units) {
          if (seen.has(u.id))
            throw errors.unprocessable('duplicate_serial', 'The same serial appears twice.');
          seen.add(u.id);
          if (a.direction === 'add') {
            if (u.status === 'in_stock' || u.status === 'in_transit') {
              throw errors.conflict(
                'serial_in_stock',
                `Serial ${u.serial} is already in stock; move it instead.`,
                { serial: u.serial },
              );
            }
          } else {
            const [pos] = await ctx.tx.query<{ ok: boolean }>(
              `select (location_id = $2 and condition = $3 and on_hand = 1) as ok
               from inventory_positions where serial_id = $1 and on_hand > 0 and transfer_id is null`,
              [u.id, input.locationId, input.condition],
            );
            if (!pos?.ok) {
              throw errors.conflict(
                'serial_not_here',
                `Serial ${u.serial} is not at this location in this condition.`,
                { serial: u.serial },
              );
            }
          }
          changes.push({
            key: {
              variantId: variant.id,
              locationId: input.locationId,
              condition: input.condition,
              lotId: null,
              serialId: u.id,
              transferId: null,
            },
            delta: `${sign}1`,
          });
        }
        continue;
      }
      if (a.serials)
        throw errors.unprocessable(
          'not_serial_tracked',
          `${variant.sku} is not tracked by serial.`,
        );
      if (a.quantity === undefined)
        throw errors.unprocessable('quantity_required', 'Give a quantity.');
      const resolved = await resolvePack(ctx.tx, variant.id, a.packId, a.quantity);
      pack = resolved.pack;
      assertScale(resolved.base, variant.quantityScale, `Variant ${variant.sku}`);
      const lot = await lotId(ctx.tx, variant, a.lotCode, true);
      const key: PositionKey = {
        variantId: variant.id,
        locationId: input.locationId,
        condition: input.condition,
        lotId: lot,
        serialId: null,
        transferId: null,
      };
      const k = JSON.stringify(key);
      if (seen.has(k)) throw errors.unprocessable('duplicate_line', 'Name each item once.');
      seen.add(k);
      if (variant.oneOfAKind && a.direction === 'add' && compare(resolved.base, '1') > 0) {
        throw errors.conflict('one_of_a_kind', 'This item is one of a kind.');
      }
      changes.push({ key, delta: `${sign}${resolved.base}`, pack });
    }
    const applied = await applyChanges(
      ctx,
      operationId,
      'adjustment',
      changes.map((c) => c.key),
      async () => changes,
      input.reservationChoices ?? [],
    );
    // One of a kind: at most one unit across the shop (D5).
    const ones = await ctx.tx.query<{ id: string }>(
      `select v.id from variants v join variant_costs c on c.shop_id = v.shop_id and c.variant_id = v.id
       where v.id = any($1::uuid[]) and v.one_of_a_kind and c.quantity > 1`,
      [changes.map((c) => c.key.variantId)],
    );
    if (ones.length > 0) throw errors.conflict('one_of_a_kind', 'This item is one of a kind.');
    return {
      result: { operationId, ...changesOut(ctx, applied) },
      audit: {
        targetType: 'location',
        targetId: input.locationId,
        operationId,
        locationIds: [input.locationId],
        reason: input.note ?? input.adjustmentReason,
        changes: {
          adjustmentReason: input.adjustmentReason,
          note: input.note ?? null,
          condition: input.condition,
          changes: applied.changes,
          entered: changes
            .filter((c) => c.pack)
            .map((c) => ({ variantId: c.key.variantId, pack: c.pack })),
          released: applied.released,
          reallocated: applied.reallocated,
          shortagesFilled: applied.shortagesFilled,
          restricted: { permission: 'costs.read', fields: { unitCosts: applied.costs } },
        },
      },
      outbox: availabilityOutbox(applied.moves),
      events: applied.events,
    };
  },
});

// Condition change ------------------------------------------------------------------------------

export const changeCondition = defineOperation({
  id: 'inventory.condition_changes.create',
  summary: 'Move units between conditions at one location',
  description:
    'Use this to change the condition of units without changing on hand, for example quarantine to sellable after a check, or sellable to damaged. Only free units move (reserved ones must be released or reallocated first). Units moved to sellable fill open order shortages first. Lot-tracked items name the lot; serial-tracked items name the serials. Leave out quantity to move every free unit of the item in that condition.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    locationId: Id,
    fromCondition: StockCondition,
    toCondition: StockCondition,
    items: z
      .array(
        z.object({
          variantId: Id,
          quantity: PositiveDecimal.optional(),
          packId: Id.optional(),
          lotCode: LotCode.optional(),
          serials: Serials.optional(),
        }),
      )
      .min(1)
      .max(200),
    note: Note.optional(),
  }),
  output: z.object({
    operationId: Id,
    moved: z.array(
      z.object({
        variantId: Id,
        lotId: Id.nullable(),
        serialId: Id.nullable(),
        quantity: z.string(),
      }),
    ),
    shortagesFilled: z.array(z.object({ reservationId: Id, quantity: z.string() })),
  }),
  permission: 'inventory.adjust',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.condition.changed' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/condition-changes', status: 201 },
  mcp: { tool: TOOL, action: 'change_condition', readOnly: false, destructive: false },
  locations: (input) => [input.locationId],
  async handler(ctx, input) {
    if (input.fromCondition === input.toCondition) {
      throw errors.unprocessable('same_condition', 'The two conditions are the same.');
    }
    await stockLocation(ctx.tx, input.locationId);
    // Which source positions, per item (not locked yet).
    const plans: Array<{
      variant: StockVariant;
      quantity: string | null;
      pack: EnteredPack | null;
      lot: string | null;
      serials: string[] | null;
    }> = [];
    for (const item of [...input.items].sort((a, b) => (a.variantId < b.variantId ? -1 : 1))) {
      const variant = await loadStockVariant(ctx.tx, item.variantId);
      let quantity: string | null = null;
      let pack: EnteredPack | null = null;
      if (item.quantity !== undefined) {
        const r = await resolvePack(ctx.tx, variant.id, item.packId, item.quantity);
        quantity = r.base;
        pack = r.pack;
        assertScale(quantity, variant.quantityScale, `Variant ${variant.sku}`);
      }
      const lot = await lotId(ctx.tx, variant, item.lotCode, false);
      const serials = item.serials ? item.serials.map(normalizeCode) : null;
      if (serials && variant.trackingMode !== 'serial') {
        throw errors.unprocessable(
          'not_serial_tracked',
          `${variant.sku} is not tracked by serial.`,
        );
      }
      plans.push({ variant, quantity, pack, lot, serials });
    }
    const sources = await ctx.tx.query<{
      id: string;
      variant_id: string;
      lot_id: string | null;
      serial_id: string | null;
      serial: string | null;
    }>(
      `select p.id, p.variant_id, p.lot_id, p.serial_id, su.serial_normalized as serial
       from inventory_positions p left join serial_units su on su.shop_id = p.shop_id and su.id = p.serial_id
       where p.location_id = $1 and p.condition = $2 and p.transfer_id is null and p.on_hand > 0
         and p.variant_id = any($3::uuid[])`,
      [input.locationId, input.fromCondition, plans.map((p) => p.variant.id)],
    );
    const targets = await findPositions(
      ctx.tx,
      sources.map((s) => ({
        variantId: s.variant_id,
        locationId: input.locationId,
        condition: input.toCondition,
        lotId: s.lot_id,
        serialId: s.serial_id,
        transferId: null,
      })),
    );
    const sellable = input.toCondition === 'sellable' ? plans.map((p) => p.variant.id) : [];
    const lock = await lockStock(
      ctx,
      [...sources.map((s) => s.id), ...targets.map((t) => t.id)],
      await openShortageReservations(ctx.tx, sellable),
    );
    const now = await ctx.tx.query<{
      id: string;
      variant_id: string;
      lot_id: string | null;
      serial_id: string | null;
      free: string;
      received_at: string | null;
      expires_on: string | null;
    }>(
      `select p.id, p.variant_id, p.lot_id, p.serial_id, (p.on_hand - p.allocated)::text as free,
         to_char(p.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as received_at,
         lt.expires_on::text
       from inventory_positions p left join lots lt on lt.shop_id = p.shop_id and lt.id = p.lot_id
       where p.id = any($1::uuid[]) order by lt.expires_on nulls last, p.received_at nulls last, p.id`,
      [sources.map((s) => s.id)],
    );
    const operationId = ctx.newId();
    await ctx.tx.query(
      `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
         reason)
       values (app_shop_id(), $1, 'condition_change', $2, $3, $4, $5, $6)`,
      [operationId, ...actorColumns(ctx), `${input.fromCondition}_to_${input.toCondition}`],
    );
    const moves = [];
    for (const plan of plans) {
      const mine = now.filter(
        (p) =>
          p.variant_id === plan.variant.id &&
          lock.locked.has(p.id) &&
          (plan.lot === null || p.lot_id === plan.lot) &&
          (plan.serials === null ||
            plan.serials.includes(sources.find((s) => s.id === p.id)?.serial ?? '')),
      );
      const free = mine.reduce((s, p) => add(s, p.free), '0');
      const want = plan.quantity ?? (plan.serials ? String(plan.serials.length) : normalize(free));
      if (compare(want, '0') <= 0 || compare(want, free) > 0) {
        throw errors.conflict(
          'units_reserved',
          'Not enough free units in that condition here; reserved units must be released or reallocated first.',
          { variantId: plan.variant.id, requested: want, free: normalize(free) },
        );
      }
      let rest = normalize(want);
      for (const p of mine) {
        if (compare(rest, '0') <= 0) break;
        if (compare(p.free, '0') <= 0) continue;
        const take = compare(p.free, rest) < 0 ? normalize(p.free) : rest;
        moves.push({
          variantId: plan.variant.id,
          quantity: take,
          lotId: p.lot_id,
          serialId: p.serial_id,
          from: { positionId: p.id, locationId: input.locationId, receivedAt: p.received_at },
          to: { locationId: input.locationId, condition: input.toCondition, transferId: null },
          pack: plan.pack,
        });
        rest = normalize(subtract(rest, take));
      }
    }
    const applied = await applyMoves(ctx, operationId, moves);
    await syncSerials(ctx, operationId, applied);
    const events = [...lock.events];
    const shortagesFilled: Array<{ reservationId: string; quantity: string }> = [];
    for (const variantId of sellable) {
      const positions = [
        ...new Set(applied.filter((m) => m.variantId === variantId).map((m) => m.toPositionId!)),
      ];
      const filled = await fillShortages(ctx, variantId, positions);
      events.push(...filled.events);
      shortagesFilled.push(
        ...filled.fills.map((f) => ({ reservationId: f.reservationId, quantity: f.quantity })),
      );
    }
    const moved = applied.map((m) => ({
      variantId: m.variantId,
      lotId: m.lotId,
      serialId: m.serialId,
      quantity: m.quantity,
    }));
    return {
      result: { operationId, moved, shortagesFilled },
      audit: {
        targetType: 'location',
        targetId: input.locationId,
        operationId,
        locationIds: [input.locationId],
        reason: input.note ?? null,
        changes: {
          from: input.fromCondition,
          to: input.toCondition,
          moved,
          entered: plans
            .filter((p) => p.pack)
            .map((p) => ({ variantId: p.variant.id, pack: p.pack })),
          shortagesFilled,
        },
      },
      outbox: availabilityOutbox(applied),
      events,
    };
  },
});

// Reverse ---------------------------------------------------------------------------------------

export const reverseOperation = defineOperation({
  id: 'inventory.operations.reverse',
  summary: 'Reverse an adjustment, count, or condition change',
  description:
    'Use this to undo a stock correction made by mistake. Records a new operation linked to the original that puts every position back (units removed come back at the cost they left with; units added leave at the moving average). An operation can be reversed once. Receipts, fulfillments, transfers, and returns have their own steps and cannot be reversed here.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    operationId: Id.describe('The adjustment, count, or condition change to reverse.'),
    note: Note.optional(),
    reservationChoices: ReservationChoices,
  }),
  output: ChangesOut.extend({ operationId: Id, reverses: Id }),
  permission: 'inventory.adjust',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.operation.reversed' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/operations/{operationId}/reverse', status: 201 },
  mcp: { tool: TOOL, action: 'reverse', readOnly: false, destructive: true },
  locations: async (input, tx) =>
    (
      await tx.query<{ location_id: string }>(
        'select distinct location_id from inventory_entries where operation_id = $1',
        [input.operationId],
      )
    ).map((r) => r.location_id),
  async handler(ctx, input) {
    const [op] = await ctx.tx.query<{
      kind: string;
      reason: string | null;
      transfer_id: string | null;
      return_id: string | null;
    }>('select kind, reason, transfer_id, return_id from inventory_operations where id = $1', [
      input.operationId,
    ]);
    if (!op) throw errors.notFound('Operation');
    // A stock-check repair is a ledger-only entry: the balance already held those units, so
    // reversing it would change real stock. A wrong repair is corrected with a count.
    if (op.reason === 'reconciliation') {
      throw errors.unprocessable(
        'not_reversible',
        'A stock check repair only explains the balance in the history and cannot be reversed. Count the shelf to correct the stock.',
        { kind: op.kind, reason: op.reason },
      );
    }
    if (
      !['adjustment', 'count', 'condition_change'].includes(op.kind) ||
      op.transfer_id ||
      op.return_id
    ) {
      throw errors.unprocessable(
        'not_reversible',
        'Only adjustments, counts, and condition changes are reversed here; transfers, returns, receipts, and fulfillments have their own steps.',
        { kind: op.kind },
      );
    }
    const [done] = await ctx.tx.query<{ id: string }>(
      'select id from inventory_operations where reverses_operation_id = $1',
      [input.operationId],
    );
    if (done) {
      throw errors.conflict('already_reversed', 'This operation was already reversed.', {
        reversalId: done.id,
      });
    }
    const entries = await ctx.tx.query<{
      position_id: string;
      variant_id: string;
      location_id: string;
      condition: string;
      lot_id: string | null;
      serial_id: string | null;
      delta: string;
      unit_cost: string | null;
    }>(
      `select e.position_id, e.variant_id, e.location_id, p.condition, e.lot_id, e.serial_id,
         e.delta::text, e.unit_cost::text
       from inventory_entries e join inventory_positions p on p.shop_id = e.shop_id and p.id = e.position_id
       where e.operation_id = $1 order by e.variant_id, e.id`,
      [input.operationId],
    );
    // Variants first (key share), as every stock command does.
    for (const v of [...new Set(entries.map((e) => e.variant_id))].sort()) {
      await ctx.tx.query('select 1 from variants where id = $1 for key share', [v]);
    }
    const operationId = ctx.newId();
    await ctx.tx.query(
      `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
         reason, reverses_operation_id)
       values (app_shop_id(), $1, 'reversal', $2, $3, $4, $5, $6, $7)`,
      [operationId, ...actorColumns(ctx), `reverses_${op.kind}`, input.operationId],
    );
    const keyOfEntry = (e: (typeof entries)[number]): PositionKey => ({
      variantId: e.variant_id,
      locationId: e.location_id,
      condition: e.condition,
      lotId: e.lot_id,
      serialId: e.serial_id,
      transferId: null,
    });
    let applied: AppliedChanges;
    if (op.kind === 'condition_change') {
      // Move the units back: out of each target, into its source.
      applied = await reverseConditionChange(
        ctx,
        operationId,
        entries.map((e) => ({ ...e, key: keyOfEntry(e) })),
      );
    } else {
      const changes: StockChange[] = entries.map((e) => ({
        key: keyOfEntry(e),
        delta:
          compare(e.delta, '0') > 0
            ? `-${normalize(e.delta)}`
            : normalize(e.delta.replace(/^-/, '')),
        // Units removed come back at the cost they left with, so value is restored exactly.
        unitCost: compare(e.delta, '0') < 0 ? e.unit_cost : null,
      }));
      applied = await applyChanges(
        ctx,
        operationId,
        'reversal',
        changes.map((c) => c.key),
        async () => changes,
        input.reservationChoices ?? [],
      );
    }
    const locationIds = [...new Set(entries.map((e) => e.location_id))];
    return {
      result: { operationId, reverses: input.operationId, ...changesOut(ctx, applied) },
      audit: {
        targetType: 'inventory_operation',
        targetId: input.operationId,
        operationId,
        locationIds,
        reason: input.note ?? null,
        changes: {
          reverses: input.operationId,
          kind: op.kind,
          changes: applied.changes,
          released: applied.released,
          reallocated: applied.reallocated,
          restricted: { permission: 'costs.read', fields: { unitCosts: applied.costs } },
        },
      },
      outbox: availabilityOutbox(applied.moves),
      events: applied.events,
    };
  },
});

async function reverseConditionChange(
  ctx: HandlerContext,
  operationId: string,
  entries: Array<{ position_id: string; delta: string; key: PositionKey }>,
): Promise<AppliedChanges> {
  const backTo = await findPositions(
    ctx.tx,
    entries.filter((e) => compare(e.delta, '0') < 0).map((e) => e.key),
  );
  const lock = await lockStock(ctx, [
    ...entries.map((e) => e.position_id),
    ...backTo.map((p) => p.id),
  ]);
  const outs = entries.filter((e) => compare(e.delta, '0') < 0);
  const ins = entries.filter((e) => compare(e.delta, '0') > 0);
  const free = await ctx.tx.query<{ id: string; free: string; received_at: string | null }>(
    `select id, (on_hand - allocated)::text as free,
       to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as received_at
     from inventory_positions where id = any($1::uuid[])`,
    [ins.map((e) => e.position_id)],
  );
  // Pair each unit that arrived with the source it came from (same item, lot, and serial).
  const moves = [];
  const taken = new Map<string, string>();
  for (const i of ins) {
    let rest = normalize(i.delta);
    const f = free.find((x) => x.id === i.position_id);
    const avail = normalize(subtract(f?.free ?? '0', taken.get(i.position_id) ?? '0'));
    if (compare(avail, rest) < 0) {
      throw errors.conflict(
        'units_reserved',
        'Some of these units are reserved or gone; release or adjust them first.',
        { positionId: i.position_id, free: avail, needed: rest },
      );
    }
    taken.set(i.position_id, normalize(add(taken.get(i.position_id) ?? '0', rest)));
    for (const o of outs) {
      if (compare(rest, '0') <= 0) break;
      if (
        o.key.variantId !== i.key.variantId ||
        o.key.lotId !== i.key.lotId ||
        o.key.serialId !== i.key.serialId
      )
        continue;
      const left = normalize(
        subtract(o.delta.replace(/^-/, ''), taken.get(`o:${o.position_id}`) ?? '0'),
      );
      if (compare(left, '0') <= 0) continue;
      const take = compare(left, rest) < 0 ? left : rest;
      taken.set(`o:${o.position_id}`, normalize(add(taken.get(`o:${o.position_id}`) ?? '0', take)));
      moves.push({
        variantId: i.key.variantId,
        quantity: take,
        lotId: i.key.lotId,
        serialId: i.key.serialId,
        from: {
          positionId: i.position_id,
          locationId: i.key.locationId,
          receivedAt: f?.received_at ?? null,
        },
        to: { locationId: o.key.locationId, condition: o.key.condition, transferId: null },
      });
      rest = normalize(subtract(rest, take));
    }
  }
  const applied = await applyMoves(ctx, operationId, moves);
  await syncSerials(ctx, operationId, applied);
  return {
    changes: applied.flatMap((m) => [
      {
        key: { ...ins.find((x) => x.position_id === m.from!.positionId)!.key },
        delta: `-${m.quantity}`,
      },
      {
        key: {
          variantId: m.variantId,
          locationId: m.to!.locationId,
          condition: m.to!.condition,
          lotId: m.lotId,
          serialId: m.serialId,
          transferId: null,
        },
        delta: m.quantity,
      },
    ]),
    moves: applied,
    events: lock.events,
    released: [],
    reallocated: [],
    shortagesFilled: [],
    costs: {},
  };
}

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const inventoryAdjustmentsOperations = [
  adjustStock,
  changeCondition,
  reverseOperation,
] as const;
