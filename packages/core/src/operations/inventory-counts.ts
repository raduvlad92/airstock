import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { compare, normalize, subtract } from '../catalog/decimal.ts';
import { NonNegativeDecimal } from '../decimal.ts';
import { AppError, errors } from '../errors.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id } from '../schemas.ts';
import {
  type AppliedChanges,
  applyChanges,
  type StockChange,
  serialsFor,
} from '../stock/adjust.ts';
import { actorColumns, assertScale, loadStockVariant, normalizeCode } from '../stock/engine.ts';
import {
  type EnteredPack,
  findPositions,
  keyOf,
  type PositionKey,
  resolvePack,
} from '../stock/moves.ts';
import { LotCode, StockCondition } from './inventory.ts';
import {
  availabilityOutbox,
  ChangesOut,
  changesOut,
  lotId,
  Note,
  ReservationChoices,
  Serials,
  stockLocation,
  TOOL,
} from './inventory-adjustments.ts';

// Counts (plan D10, PRD 6.6): sessions over chosen positions or a location, optionally blind;
// each counted line keeps the position's version, on hand, and ledger length when counted, so a
// movement before submit is seen and must be reviewed; submit posts count corrections; a count
// below reserved stock needs an explicit choice per claim. A quick count does it all in one
// command (the grid, the scanner, an assistant).

const CountItem = z.object({
  variantId: Id,
  counted: NonNegativeDecimal.optional().describe(
    'Units counted: base units, or packs with packId. Serial-tracked items list serials instead.',
  ),
  packId: Id.optional(),
  locationId: Id.optional().describe('The shelf, when it is not the count’s own location.'),
  condition: StockCondition.default('sellable'),
  lotCode: LotCode.optional().describe('Lot-tracked items: the lot counted.'),
  serials: Serials.optional().describe(
    'Serial-tracked items: every serial present on the shelf; missing ones count as 0.',
  ),
});
type CountItemInput = z.infer<typeof CountItem>;

/**
 * A quick count item, with what the count was based on (G5): a quantity typed in the grid or the
 * stock panel sends the position's version and on hand as it read them.
 */
const QuickCountItem = CountItem.extend({
  read: z
    .object({
      version: z
        .number()
        .int()
        .min(0)
        .nullable()
        .describe('The position version read; null when there was no position.'),
      onHand: NonNegativeDecimal.describe('The units on hand read, in base units.'),
    })
    .optional()
    .describe(
      'What the count was based on, for one position (give the lot for lot-tracked items). If units moved there since (the version and on hand both changed), the count is refused with moved_since_read for review; a version changed only by reservations passes.',
    ),
});

/** A quick count based on a read whose position moved since: what was read and what is there now. */
interface MovedSinceRead {
  variantId: string;
  locationId: string;
  condition: string;
  lotId: string | null;
  read: { version: number | null; onHand: string };
  now: { version: number | null; onHand: string };
}

interface Counted {
  key: PositionKey;
  counted: string;
  pack: EnteredPack | null;
}

/** Turns what a person counted into a quantity per position identity. */
async function expandCount(
  ctx: HandlerContext,
  item: CountItemInput,
  locationId: string,
  operationId: string | null,
): Promise<Counted[]> {
  const variant = await loadStockVariant(ctx.tx, item.variantId);
  if (variant.bundleId) {
    throw errors.unprocessable('bundle_holds_no_stock', 'A bundle holds no stock of its own.');
  }
  const base = (k: Omit<PositionKey, 'variantId' | 'locationId' | 'condition' | 'transferId'>) => ({
    variantId: variant.id,
    locationId,
    condition: item.condition,
    transferId: null,
    ...k,
  });
  const here = await ctx.tx.query<{
    lot_id: string | null;
    serial_id: string | null;
    serial: string | null;
  }>(
    `select p.lot_id, p.serial_id, su.serial_normalized as serial from inventory_positions p
     left join serial_units su on su.shop_id = p.shop_id and su.id = p.serial_id
     where p.variant_id = $1 and p.location_id = $2 and p.condition = $3 and p.transfer_id is null
       and p.on_hand > 0`,
    [variant.id, locationId, item.condition],
  );
  if (variant.trackingMode === 'serial') {
    if (item.serials) {
      if (item.counted !== undefined && compare(item.counted, String(item.serials.length)) !== 0) {
        throw errors.unprocessable('serial_count_mismatch', 'The count and the serials differ.');
      }
      const listed = item.serials.map(normalizeCode);
      if (new Set(listed).size !== listed.length) {
        throw errors.unprocessable('duplicate_serial', 'The same serial appears twice.');
      }
      const out: Counted[] = here.map((p) => ({
        key: base({ lotId: null, serialId: p.serial_id }),
        counted: listed.includes(p.serial ?? '') ? '1' : '0',
        pack: null,
      }));
      const extra = item.serials.filter((s) => !here.some((p) => p.serial === normalizeCode(s)));
      if (extra.length > 0) {
        let units: Array<{ id: string; serial: string; status: string; positionId: string | null }>;
        if (operationId) units = await serialsFor(ctx, variant.id, extra, operationId);
        else {
          units = await ctx.tx.query(
            `select id, serial, status, position_id as "positionId" from serial_units
             where variant_id = $1 and serial_normalized = any($2::text[])`,
            [variant.id, extra.map(normalizeCode)],
          );
          if (units.length !== extra.length) {
            throw errors.unprocessable(
              'unknown_serial',
              'A serial is not known here; add it with a found adjustment, or count it with a quick count.',
              { serials: extra },
            );
          }
        }
        for (const u of units) {
          if (u.status === 'in_stock' || u.status === 'in_transit') {
            throw errors.conflict(
              'serial_elsewhere',
              `Serial ${u.serial} is recorded at another place; move it there instead of counting it here.`,
              { serial: u.serial },
            );
          }
          out.push({ key: base({ lotId: null, serialId: u.id }), counted: '1', pack: null });
        }
      }
      return out;
    }
    if (item.counted !== undefined && compare(item.counted, '0') === 0) {
      return here.map((p) => ({
        key: base({ lotId: null, serialId: p.serial_id }),
        counted: '0',
        pack: null,
      }));
    }
    throw errors.unprocessable(
      'serials_required',
      `List the serials of ${variant.sku} on the shelf.`,
    );
  }
  if (item.serials)
    throw errors.unprocessable('not_serial_tracked', `${variant.sku} is not tracked by serial.`);
  if (item.counted === undefined)
    throw errors.unprocessable('counted_required', 'Give the number counted.');
  const { base: counted, pack } = await resolvePack(ctx.tx, variant.id, item.packId, item.counted);
  assertScale(counted, variant.quantityScale, `Variant ${variant.sku}`);
  if (variant.trackingMode === 'lot' || variant.trackingMode === 'lot_expiry') {
    if (item.lotCode) {
      const lot = await lotId(ctx.tx, variant, item.lotCode, true);
      return [{ key: base({ lotId: lot, serialId: null }), counted, pack }];
    }
    if (compare(counted, '0') === 0) {
      return here.map((p) => ({
        key: base({ lotId: p.lot_id, serialId: null }),
        counted: '0',
        pack,
      }));
    }
    if (here.length === 1)
      return [{ key: base({ lotId: here[0]!.lot_id, serialId: null }), counted, pack }];
    throw errors.unprocessable(
      'lot_required',
      `${variant.sku} is tracked by lot: say which lot you counted.`,
    );
  }
  return [{ key: base({ lotId: null, serialId: null }), counted, pack }];
}

/** The location a count item is at: its own shelf, or the count's location (a shelf). */
async function itemLocation(
  ctx: HandlerContext,
  item: CountItemInput,
  fallback: string | null,
  within: string | null,
): Promise<string> {
  const locationId = item.locationId ?? fallback;
  if (!locationId) throw errors.unprocessable('location_required', 'Name the shelf counted.');
  await stockLocation(ctx.tx, locationId);
  if (within) {
    const [row] = await ctx.tx.query<{ ok: boolean }>(
      'select path_ids @> array[$2::uuid] as ok from locations where id = $1',
      [locationId, within],
    );
    if (!row?.ok) {
      throw errors.unprocessable('outside_count', 'This shelf is outside the count’s location.');
    }
  }
  if (ctx.locationScope !== null) {
    const [row] = await ctx.tx.query<{ ok: boolean }>(
      'select path_ids && $2::uuid[] as ok from locations where id = $1',
      [locationId, ctx.locationScope],
    );
    if (!row?.ok) {
      throw new AppError(
        403,
        'location_out_of_scope',
        'You do not have access to this location.',
        'denied',
      );
    }
  }
  return locationId;
}

// Quick count -----------------------------------------------------------------------------------

export const quickCount = defineOperation({
  id: 'inventory.counts.quick',
  summary: 'Record what was counted on a shelf and correct stock now',
  description:
    'Use this for "I counted shelf B2: 4 of SKU X and none of SKU Y", or a quantity typed for a location in the grid: sets each counted item to the number counted and posts the differences as adjustments with the reason count correction, in one step. Serial-tracked items list the serials present; lot-tracked items name the lot. If a count is below what is reserved, the error lists the claims: retry with reservationChoices. A count of a quantity read on screen sends read (the position version and on hand read); if units moved since, it fails with moved_since_read, and the person decides whether the count stands. For a counting round over many shelves that is entered over time, start a count session instead.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    locationId: Id.describe('The shelf counted (a location without sub-locations).'),
    counts: z.array(QuickCountItem).min(1).max(500),
    note: Note.optional(),
    reservationChoices: ReservationChoices,
  }),
  output: ChangesOut.extend({ operationId: Id, sessionId: Id }),
  permission: 'inventory.count',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.count.quick' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/counts/quick', status: 201 },
  mcp: { tool: TOOL, action: 'count', readOnly: false, destructive: true },
  locations: (input) => [
    input.locationId,
    ...input.counts.flatMap((c) => (c.locationId ? [c.locationId] : [])),
  ],
  async handler(ctx, input) {
    const sessionId = ctx.newId();
    await ctx.tx.query(
      `insert into count_sessions (shop_id, id, location_id, quick, note, created_by_type, created_by_id)
       values (app_shop_id(), $1, $2, true, $3, $4, $5)`,
      [sessionId, input.locationId, input.note ?? null, ctx.caller.kind, ctx.caller.id],
    );
    const operationId = ctx.newId();
    await ctx.tx.query(
      `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
         reason, count_session_id)
       values (app_shop_id(), $1, 'count', $2, $3, $4, $5, 'count_correction', $6)`,
      [operationId, ...actorColumns(ctx), sessionId],
    );
    const counted: Counted[] = [];
    const reads: Array<{ key: PositionKey; read: { version: number | null; onHand: string } }> = [];
    for (const item of [...input.counts].sort((a, b) => (a.variantId < b.variantId ? -1 : 1))) {
      const at = await itemLocation(ctx, item, input.locationId, null);
      const expanded = await expandCount(ctx, item, at, operationId);
      if (item.read) {
        if (expanded.length !== 1) {
          throw errors.unprocessable(
            'read_needs_one_position',
            'A read version applies to one position: give the lot, and leave it out for serials.',
            { variantId: item.variantId },
          );
        }
        reads.push({ key: expanded[0]!.key, read: item.read });
      }
      counted.push(...expanded);
    }
    const seen = new Set<string>();
    for (const c of counted) {
      if (seen.has(keyOf(c.key)))
        throw errors.unprocessable('duplicate_line', 'The same item is counted twice.');
      seen.add(keyOf(c.key));
    }
    let before = new Map<string, string>();
    const applied = await applyChanges(
      ctx,
      operationId,
      'count',
      counted.map((c) => c.key),
      async () => {
        // The positions are locked: compare what each count was based on with what is there now.
        const positions = await findPositions(
          ctx.tx,
          counted.map((c) => c.key),
        );
        before = new Map(positions.map((p) => [keyOf(p), p.onHand]));
        const moved: MovedSinceRead[] = [];
        for (const r of reads) {
          const p = positions.find((x) => keyOf(x) === keyOf(r.key));
          const now = { version: p?.version ?? null, onHand: normalize(p?.onHand ?? '0') };
          if (now.version !== r.read.version && compare(now.onHand, r.read.onHand) !== 0) {
            moved.push({
              variantId: r.key.variantId,
              locationId: r.key.locationId,
              condition: r.key.condition,
              lotId: r.key.lotId,
              read: { version: r.read.version, onHand: normalize(r.read.onHand) },
              now,
            });
          }
        }
        if (moved.length > 0) {
          throw errors.conflict(
            'moved_since_read',
            'Units moved since this was read. Review the count: keep it as the number on the shelf now, or add the movements since.',
            { positions: moved },
          );
        }
        return counted.map((c) => ({ key: c.key, target: c.counted, pack: c.pack }));
      },
      input.reservationChoices ?? [],
    );
    await insertLines(ctx, sessionId, counted, before, 'posted', applied);
    await ctx.tx.query(
      `update count_sessions set status = 'submitted', submitted_at = now(), operation_id = $2 where id = $1`,
      [sessionId, operationId],
    );
    const locationIds = [...new Set(counted.map((c) => c.key.locationId))];
    return {
      result: { operationId, sessionId, ...changesOut(ctx, applied) },
      audit: {
        targetType: 'count_session',
        targetId: sessionId,
        operationId,
        locationIds,
        reason: input.note ?? 'count_correction',
        changes: {
          counted: counted.map((c) => ({ ...c.key, counted: c.counted, entered: c.pack })),
          changes: applied.changes,
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

async function insertLines(
  ctx: HandlerContext,
  sessionId: string,
  counted: Counted[],
  before: Map<string, string>,
  status: 'counted' | 'posted',
  applied: AppliedChanges | null,
): Promise<void> {
  const delta = (k: PositionKey) =>
    applied?.changes.find((c) => keyOf(c.key) === keyOf(k))?.delta ?? (applied ? '0' : null);
  await ctx.tx.query(
    `insert into count_lines (shop_id, id, session_id, variant_id, location_id, condition, lot_id,
       serial_id, position_id, expected, counted, counted_version, counted_on_hand, counted_entries,
       counted_at, counted_by, pack_id, pack_version, entered_quantity, conversion_factor, status,
       posted_delta)
     select app_shop_id(), x.id, $2, x."variantId", x."locationId", x.condition, x."lotId",
       x."serialId", p.id, x.expected, x.counted, p.version, coalesce(p.on_hand, 0),
       (select count(*) from inventory_entries e where e.shop_id = app_shop_id() and e.position_id = p.id),
       now(), $3, x."packId", x."packVersion", x.entered, x.factor, $4, x.delta
     from jsonb_to_recordset($1::jsonb) as x(id uuid, "variantId" uuid, "locationId" uuid,
       condition text, "lotId" uuid, "serialId" uuid, expected numeric, counted numeric,
       "packId" uuid, "packVersion" integer, entered numeric, factor numeric, delta numeric)
     left join inventory_positions p on p.shop_id = app_shop_id() and p.variant_id = x."variantId"
       and p.location_id = x."locationId" and p.condition = x.condition
       and p.lot_id is not distinct from x."lotId" and p.serial_id is not distinct from x."serialId"
       and p.transfer_id is null`,
    [
      JSON.stringify(
        counted.map((c) => ({
          id: ctx.newId(),
          ...c.key,
          expected: before.get(keyOf(c.key)) ?? '0',
          counted: c.counted,
          packId: c.pack?.packId ?? null,
          packVersion: c.pack?.packVersion ?? null,
          entered: c.pack?.quantity ?? null,
          factor: c.pack?.factor ?? null,
          delta: delta(c.key),
        })),
      ),
      sessionId,
      `${ctx.caller.kind}:${ctx.caller.id}`,
      status,
    ],
  );
}

// Sessions --------------------------------------------------------------------------------------

const LineOut = z.object({
  lineId: Id,
  variantId: Id,
  sku: z.string(),
  name: z.string(),
  locationId: Id,
  locationPath: z.string(),
  condition: z.string(),
  lotCode: z.string().nullable(),
  serial: z.string().nullable(),
  expected: z.string().nullable().describe('Hidden (null) in a blind count until it is submitted.'),
  counted: z.string().nullable(),
  status: z.enum(['pending', 'counted', 'posted']),
  countedAt: z.string().nullable(),
  countedVersion: z.number().nullable().describe('The position version when counted.'),
  postedDelta: z.string().nullable(),
  needsReview: z.boolean().describe('The position moved after it was counted.'),
  movementsSince: z
    .array(z.object({ operationId: Id, kind: z.string(), quantity: z.string(), at: z.string() }))
    .describe('Movements at the position after it was counted (shown when it needs review).'),
});

export const CountSessionOut = z.object({
  sessionId: Id,
  name: z.string().nullable(),
  status: z.enum(['open', 'submitted', 'cancelled']),
  blind: z.boolean(),
  quick: z.boolean(),
  location: z.object({ locationId: Id, path: z.string() }).nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  submittedAt: z.string().nullable(),
  operationId: Id.nullable(),
  totals: z.object({ lines: z.number(), counted: z.number(), needsReview: z.number() }),
  lines: z.array(LineOut),
});
type Session = z.infer<typeof CountSessionOut>;

const tsSql = (c: string) => `to_char(${c} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const SESSION_SQL = `
  select s.id as "sessionId", s.name, s.status, s.blind, s.quick, s.note,
    case when l.id is null then null else json_build_object('locationId', l.id, 'path', l.path) end as location,
    ${tsSql('s.created_at')} as "createdAt", ${tsSql('s.submitted_at')} as "submittedAt",
    s.operation_id as "operationId",
    coalesce((select json_agg(json_build_object('lineId', c.id, 'variantId', c.variant_id,
        'sku', v.sku, 'name', pr.name, 'locationId', c.location_id, 'locationPath', cl.path,
        'condition', c.condition, 'lotCode', lt.code, 'serial', su.serial,
        'expected', case when s.blind and s.status = 'open' then null else c.expected::text end,
        'counted', c.counted::text, 'status', c.status, 'countedAt', ${tsSql('c.counted_at')},
        'countedVersion', c.counted_version, 'postedDelta', c.posted_delta::text,
        'needsReview', c.status = 'counted' and m.moved,
        'movementsSince', case when c.status = 'counted' and m.moved then m.list else '[]'::json end)
        order by cl.path, v.sku, lt.code, su.serial)
      from count_lines c
      join variants v on v.shop_id = c.shop_id and v.id = c.variant_id
      join products pr on pr.shop_id = v.shop_id and pr.id = v.product_id
      join locations cl on cl.shop_id = c.shop_id and cl.id = c.location_id
      left join lots lt on lt.shop_id = c.shop_id and lt.id = c.lot_id
      left join serial_units su on su.shop_id = c.shop_id and su.id = c.serial_id
      left join inventory_positions ip on ip.shop_id = c.shop_id and ip.variant_id = c.variant_id
        and ip.location_id = c.location_id and ip.condition = c.condition
        and ip.lot_id is not distinct from c.lot_id and ip.serial_id is not distinct from c.serial_id
        and ip.transfer_id is null
      cross join lateral (
        select coalesce((select count(*) from inventory_entries e where e.shop_id = c.shop_id
            and e.position_id = ip.id), 0) <> coalesce(c.counted_entries, 0) as moved,
          coalesce((select json_agg(json_build_object('operationId', x.operation_id, 'kind', x.kind,
              'quantity', x.delta::text, 'at', ${tsSql('x.created_at')}) order by x.created_at, x.id)
            from (select e.id, e.operation_id, o.kind, e.delta, e.created_at
                  from inventory_entries e
                  join inventory_operations o on o.shop_id = e.shop_id and o.id = e.operation_id
                  where e.shop_id = c.shop_id and e.position_id = ip.id
                  order by e.created_at, e.id offset coalesce(c.counted_entries, 0)) x), '[]'::json) as list) m
      where c.shop_id = s.shop_id and c.session_id = s.id), '[]'::json) as lines
  from count_sessions s
  left join locations l on l.shop_id = s.shop_id and l.id = s.location_id`;

/**
 * A count exists for a member limited to some locations only when its location and every line's
 * shelf are in their scope (PRD 2.4). A count started from positions has no location of its
 * own, so its lines decide. `scope` is the SQL parameter holding the scope ids.
 */
const inScope = (scope: string) => `(${scope}::uuid[] is null or not exists (
    select 1 from locations sl
    where sl.shop_id = s.shop_id
      and (sl.id = s.location_id or sl.id in (select c.location_id from count_lines c
        where c.shop_id = s.shop_id and c.session_id = s.id))
      and not sl.path_ids && ${scope}::uuid[]))`;

async function loadSession(tx: Tx, sessionId: string, scope: string[] | null): Promise<Session> {
  const [row] = await tx.query<Omit<Session, 'totals'>>(
    `${SESSION_SQL} where s.id = $1 and ${inScope('$2')}`,
    [sessionId, scope],
  );
  if (!row) throw errors.notFound('Count');
  return withTotals(row);
}

function withTotals(row: Omit<Session, 'totals'>): Session {
  return {
    ...row,
    totals: {
      lines: row.lines.length,
      counted: row.lines.filter((l) => l.status !== 'pending').length,
      needsReview: row.lines.filter((l) => l.needsReview).length,
    },
  };
}

async function lockSession(ctx: HandlerContext, sessionId: string) {
  const [s] = await ctx.tx.query<{
    id: string;
    status: string;
    location_id: string | null;
    quick: boolean;
  }>('select id, status, location_id, quick from count_sessions where id = $1 for update', [
    sessionId,
  ]);
  if (!s) throw errors.notFound('Count');
  if (s.status !== 'open') {
    throw errors.conflict('count_closed', `The count is ${s.status}.`, { status: s.status });
  }
  return s;
}

/**
 * Every location a count touches, for the scope check (PRD 2.4): its own location and each
 * line's shelf. A count started from positions has no location of its own, only lines.
 */
async function sessionLocation(tx: Tx, sessionId: string): Promise<string[]> {
  const rows = await tx.query<{ id: string }>(
    `select location_id as id from count_sessions where id = $1 and location_id is not null
     union
     select location_id from count_lines where session_id = $1`,
    [sessionId],
  );
  return rows.map((r) => r.id);
}

const SessionRef = z.object({ sessionId: Id });

export const startCount = defineOperation({
  id: 'inventory.counts.start',
  summary: 'Start a count session',
  description:
    'Use this to plan a counting round entered over time: every stocked position under a location (with its sub-locations), chosen variants there, or chosen positions. A blind count hides the expected quantities from counters. Changes no stock until it is submitted. For a quick count of one shelf, use action "count".',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    locationId: Id.optional().describe('Count everything stocked under this location.'),
    variantIds: z.array(Id).min(1).max(500).optional().describe('Only these variants.'),
    positionIds: z.array(Id).min(1).max(500).optional().describe('Or exactly these positions.'),
    blind: z.boolean().default(false),
    name: z.string().trim().min(1).max(200).optional(),
    note: Note.optional(),
  }),
  output: CountSessionOut,
  permission: 'inventory.count',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.count.started' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/counts', status: 201 },
  mcp: { tool: TOOL, action: 'start_count', readOnly: false, destructive: false },
  locations: async (input, tx) => {
    if (input.locationId) return [input.locationId];
    if (!input.positionIds) return [];
    return (
      await tx.query<{ location_id: string }>(
        'select distinct location_id from inventory_positions where id = any($1::uuid[])',
        [input.positionIds],
      )
    ).map((r) => r.location_id);
  },
  async handler(ctx, input) {
    if (!input.locationId && !input.positionIds) {
      throw errors.unprocessable('scope_required', 'Name a location or the positions to count.');
    }
    if (input.locationId) {
      const [loc] = await ctx.tx.query(
        "select 1 from locations where id = $1 and kind = 'storage'",
        [input.locationId],
      );
      if (!loc) throw errors.notFound('Location');
    }
    const positions = await ctx.tx.query<{
      id: string;
      variant_id: string;
      location_id: string;
      condition: string;
      lot_id: string | null;
      serial_id: string | null;
      on_hand: string;
    }>(
      `select p.id, p.variant_id, p.location_id, p.condition, p.lot_id, p.serial_id, p.on_hand::text
       from inventory_positions p join locations l on l.shop_id = p.shop_id and l.id = p.location_id
       where p.transfer_id is null and l.kind = 'storage'
         and ($1::uuid is null or l.path_ids @> array[$1::uuid])
         and ($2::uuid[] is null or p.variant_id = any($2::uuid[]))
         and ($3::uuid[] is null or p.id = any($3::uuid[]))
         and ($3::uuid[] is not null or p.on_hand > 0)
         and ($4::uuid[] is null or l.path_ids && $4::uuid[])
       order by l.path, p.id limit 5001`,
      [
        input.locationId ?? null,
        input.variantIds ?? null,
        input.positionIds ?? null,
        ctx.locationScope,
      ],
    );
    if (input.positionIds && positions.length !== new Set(input.positionIds).size) {
      throw errors.notFound('Position');
    }
    if (positions.length > 5000) {
      throw errors.unprocessable(
        'count_too_large',
        'Count at most 5,000 positions at once; pick a smaller location.',
      );
    }
    const sessionId = ctx.newId();
    await ctx.tx.query(
      `insert into count_sessions (shop_id, id, name, location_id, blind, note, created_by_type, created_by_id)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7)`,
      [
        sessionId,
        input.name ?? null,
        input.locationId ?? null,
        input.blind,
        input.note ?? null,
        ctx.caller.kind,
        ctx.caller.id,
      ],
    );
    await ctx.tx.query(
      `insert into count_lines (shop_id, id, session_id, variant_id, location_id, condition, lot_id,
         serial_id, position_id, expected)
       select app_shop_id(), x.id, $2, x.variant_id, x.location_id, x.condition, x.lot_id, x.serial_id,
         x.position_id, x.on_hand
       from jsonb_to_recordset($1::jsonb) as x(id uuid, variant_id uuid, location_id uuid,
         condition text, lot_id uuid, serial_id uuid, position_id uuid, on_hand numeric)`,
      [
        JSON.stringify(positions.map((p) => ({ ...p, id: ctx.newId(), position_id: p.id }))),
        sessionId,
      ],
    );
    const session = await loadSession(ctx.tx, sessionId, null);
    return {
      result: session,
      audit: {
        targetType: 'count_session',
        targetId: sessionId,
        locationIds: [...new Set(positions.map((p) => p.location_id))].slice(0, 100),
        reason: input.note ?? null,
        changes: {
          locationId: input.locationId ?? null,
          blind: input.blind,
          lines: positions.length,
        },
      },
    };
  },
});

export const recordCount = defineOperation({
  id: 'inventory.counts.record',
  summary: 'Enter counted quantities into a count session',
  description:
    'Use this while counting: give what was counted per item (and shelf). Each line keeps the position’s version, on hand, and ledger length at this moment; recounting a line replaces it. An item found that the session did not list becomes a new line. Changes no stock until the count is submitted.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    sessionId: Id,
    counts: z.array(CountItem).min(1).max(500),
    note: Note.optional(),
  }),
  output: CountSessionOut,
  permission: 'inventory.count',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.count.recorded' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/counts/{sessionId}/record' },
  mcp: { tool: TOOL, action: 'record_count', readOnly: false, destructive: false },
  locations: (input, tx) => sessionLocation(tx, input.sessionId),
  async handler(ctx, input) {
    const s = await lockSession(ctx, input.sessionId);
    const counted: Counted[] = [];
    for (const item of input.counts) {
      const at = await itemLocation(ctx, item, s.location_id, s.location_id);
      counted.push(...(await expandCount(ctx, item, at, null)));
    }
    const seen = new Set<string>();
    for (const c of counted) {
      if (seen.has(keyOf(c.key)))
        throw errors.unprocessable('duplicate_line', 'The same item is counted twice.');
      seen.add(keyOf(c.key));
    }
    // Counting reads the position as it is now; a later movement shows up as needing review.
    await ctx.tx.query(
      `insert into count_lines (shop_id, id, session_id, variant_id, location_id, condition, lot_id,
         serial_id, position_id, expected, counted, counted_version, counted_on_hand, counted_entries,
         counted_at, counted_by, pack_id, pack_version, entered_quantity, conversion_factor, status)
       select app_shop_id(), x.id, $2, x."variantId", x."locationId", x.condition, x."lotId",
         x."serialId", p.id, coalesce(p.on_hand, 0), x.counted, p.version, coalesce(p.on_hand, 0),
         (select count(*) from inventory_entries e where e.shop_id = app_shop_id() and e.position_id = p.id),
         now(), $3, x."packId", x."packVersion", x.entered, x.factor, 'counted'
       from jsonb_to_recordset($1::jsonb) as x(id uuid, "variantId" uuid, "locationId" uuid,
         condition text, "lotId" uuid, "serialId" uuid, counted numeric, "packId" uuid,
         "packVersion" integer, entered numeric, factor numeric)
       left join inventory_positions p on p.shop_id = app_shop_id() and p.variant_id = x."variantId"
         and p.location_id = x."locationId" and p.condition = x.condition
         and p.lot_id is not distinct from x."lotId" and p.serial_id is not distinct from x."serialId"
         and p.transfer_id is null
       on conflict on constraint count_lines_identity do update set
         position_id = excluded.position_id, counted = excluded.counted,
         counted_version = excluded.counted_version, counted_on_hand = excluded.counted_on_hand,
         counted_entries = excluded.counted_entries, counted_at = excluded.counted_at,
         counted_by = excluded.counted_by, pack_id = excluded.pack_id,
         pack_version = excluded.pack_version, entered_quantity = excluded.entered_quantity,
         conversion_factor = excluded.conversion_factor, status = 'counted'`,
      [
        JSON.stringify(
          counted.map((c) => ({
            id: ctx.newId(),
            ...c.key,
            counted: c.counted,
            packId: c.pack?.packId ?? null,
            packVersion: c.pack?.packVersion ?? null,
            entered: c.pack?.quantity ?? null,
            factor: c.pack?.factor ?? null,
          })),
        ),
        s.id,
        `${ctx.caller.kind}:${ctx.caller.id}`,
      ],
    );
    await ctx.tx.query(
      'update count_sessions set updated_at = now(), version = version + 1 where id = $1',
      [s.id],
    );
    const session = await loadSession(ctx.tx, s.id, null);
    return {
      result: session,
      audit: {
        targetType: 'count_session',
        targetId: s.id,
        locationIds: [...new Set(counted.map((c) => c.key.locationId))],
        reason: input.note ?? null,
        changes: {
          counted: counted.map((c) => ({ ...c.key, counted: c.counted, entered: c.pack })),
        },
      },
    };
  },
});

export const submitCount = defineOperation({
  id: 'inventory.counts.submit',
  summary: 'Submit a count session: post the differences as count corrections',
  description:
    'Use this when counting is done. Each counted line sets its position to the number counted, posted as adjustments with the reason count correction; uncounted lines change nothing. A line whose position moved after it was counted needs review (the error count_needs_review lists the movements): say per line keep_count (the count is right now) or apply_movements (the count was right then, so add what moved since), or recount it. A count below reserved stock needs reservationChoices.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    sessionId: Id,
    reviews: z
      .array(
        z.object({
          lineId: Id,
          resolution: z.enum(['keep_count', 'apply_movements']),
        }),
      )
      .max(5000)
      .optional(),
    reservationChoices: ReservationChoices,
    note: Note.optional(),
  }),
  output: ChangesOut.extend({ operationId: Id.nullable(), session: CountSessionOut }),
  permission: 'inventory.count',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.count.submitted' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/counts/{sessionId}/submit' },
  mcp: { tool: TOOL, action: 'submit_count', readOnly: false, destructive: true },
  locations: (input, tx) => sessionLocation(tx, input.sessionId),
  async handler(ctx, input) {
    const s = await lockSession(ctx, input.sessionId);
    const lines = await ctx.tx.query<{
      id: string;
      variant_id: string;
      location_id: string;
      condition: string;
      lot_id: string | null;
      serial_id: string | null;
      counted: string;
      counted_on_hand: string;
      counted_entries: number;
      pack_id: string | null;
      pack_version: number | null;
      entered_quantity: string | null;
      conversion_factor: string | null;
    }>(
      `select id, variant_id, location_id, condition, lot_id, serial_id, counted::text,
         counted_on_hand::text, counted_entries, pack_id, pack_version, entered_quantity::text,
         conversion_factor::text
       from count_lines where session_id = $1 and status = 'counted' order by variant_id, id`,
      [s.id],
    );
    for (const v of [...new Set(lines.map((l) => l.variant_id))]) {
      await ctx.tx.query('select 1 from variants where id = $1 for key share', [v]);
    }
    const operationId = ctx.newId();
    await ctx.tx.query(
      `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
         reason, count_session_id)
       values (app_shop_id(), $1, 'count', $2, $3, $4, $5, 'count_correction', $6)`,
      [operationId, ...actorColumns(ctx), s.id],
    );
    const keys = lines.map((l) => ({
      variantId: l.variant_id,
      locationId: l.location_id,
      condition: l.condition,
      lotId: l.lot_id,
      serialId: l.serial_id,
      transferId: null,
    }));
    const reviews = new Map((input.reviews ?? []).map((r) => [r.lineId, r.resolution]));
    const applied = await applyChanges(
      ctx,
      operationId,
      'count',
      keys,
      // After the positions are locked: has anything moved since each line was counted?
      async () => {
        const state = await ctx.tx.query<{ id: string; entries: number; on_hand: string }>(
          `select c.id, (select count(*)::int from inventory_entries e where e.shop_id = c.shop_id
               and e.position_id = p.id) as entries, coalesce(p.on_hand, 0)::text as on_hand
           from count_lines c
           left join inventory_positions p on p.shop_id = c.shop_id and p.variant_id = c.variant_id
             and p.location_id = c.location_id and p.condition = c.condition
             and p.lot_id is not distinct from c.lot_id and p.serial_id is not distinct from c.serial_id
             and p.transfer_id is null
           where c.session_id = $1 and c.status = 'counted'`,
          [s.id],
        );
        const pending: Array<{ lineId: string; countedOnHand: string; onHandNow: string }> = [];
        const changes: StockChange[] = lines.map((l, i) => {
          const now = state.find((x) => x.id === l.id)!;
          const moved = now.entries !== l.counted_entries;
          let target = l.counted;
          if (moved) {
            const resolution = reviews.get(l.id);
            if (!resolution) {
              pending.push({
                lineId: l.id,
                countedOnHand: l.counted_on_hand,
                onHandNow: now.on_hand,
              });
            } else if (resolution === 'apply_movements') {
              target = normalize(subtract(l.counted, subtract(l.counted_on_hand, now.on_hand)));
              if (compare(target, '0') < 0) target = '0';
            }
          }
          return {
            key: keys[i]!,
            target,
            pack: l.pack_id
              ? {
                  packId: l.pack_id,
                  packName: '',
                  packVersion: l.pack_version ?? 0,
                  quantity: l.entered_quantity ?? '0',
                  factor: l.conversion_factor ?? '1',
                }
              : null,
          };
        });
        if (pending.length > 0) {
          throw errors.conflict(
            'count_needs_review',
            'Some positions moved after they were counted. Review them: recount, or say keep_count or apply_movements per line (reviews).',
            { lines: pending },
          );
        }
        return changes;
      },
      input.reservationChoices ?? [],
    );
    const deltas = applied.changes;
    await ctx.tx.query(
      `update count_lines c set status = 'posted', posted_delta = coalesce(x.delta, 0)
       from (select l.id, d.delta from count_lines l
             left join jsonb_to_recordset($2::jsonb) as d("variantId" uuid, "locationId" uuid,
               condition text, "lotId" uuid, "serialId" uuid, delta numeric)
               on d."variantId" = l.variant_id and d."locationId" = l.location_id
               and d.condition = l.condition and d."lotId" is not distinct from l.lot_id
               and d."serialId" is not distinct from l.serial_id
             where l.session_id = $1 and l.status = 'counted') x
       where c.shop_id = app_shop_id() and c.id = x.id`,
      [s.id, JSON.stringify(deltas.map((d) => ({ ...d.key, delta: d.delta })))],
    );
    await ctx.tx.query(
      `update count_sessions set status = 'submitted', submitted_at = now(), operation_id = $2,
         updated_at = now(), version = version + 1 where id = $1`,
      [s.id, operationId],
    );
    const session = await loadSession(ctx.tx, s.id, null);
    const locationIds = [...new Set(lines.map((l) => l.location_id))];
    return {
      result: { operationId, session, ...changesOut(ctx, applied) },
      audit: {
        targetType: 'count_session',
        targetId: s.id,
        operationId,
        locationIds,
        reason: input.note ?? 'count_correction',
        changes: {
          changes: deltas,
          reviews: input.reviews ?? [],
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

export const cancelCount = defineOperation({
  id: 'inventory.counts.cancel',
  summary: 'Cancel a count session',
  description: 'Use this to drop a count session that will not be submitted. Changes no stock.',
  kind: 'command',
  scope: 'shop',
  input: SessionRef.extend({ note: Note.optional() }),
  output: CountSessionOut,
  permission: 'inventory.count',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.count.cancelled' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/counts/{sessionId}/cancel' },
  mcp: { tool: TOOL, action: 'cancel_count', readOnly: false, destructive: false },
  locations: (input, tx) => sessionLocation(tx, input.sessionId),
  async handler(ctx, input) {
    const s = await lockSession(ctx, input.sessionId);
    await ctx.tx.query(
      `update count_sessions set status = 'cancelled', cancelled_at = now(), updated_at = now(),
         version = version + 1 where id = $1`,
      [s.id],
    );
    return {
      result: await loadSession(ctx.tx, s.id, null),
      audit: {
        targetType: 'count_session',
        targetId: s.id,
        reason: input.note ?? null,
        changes: { status: 'cancelled' },
      },
    };
  },
});

export const getCount = defineOperation({
  id: 'inventory.counts.get',
  summary: 'Show a count session with its lines',
  description:
    'Use this to see a count: each line’s expected (unless blind), counted quantity, status, and whether its position moved since it was counted, with the movements.',
  kind: 'read',
  scope: 'shop',
  input: SessionRef,
  output: CountSessionOut,
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'inventory.count.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/counts/{sessionId}' },
  mcp: { tool: TOOL, action: 'get_count', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const session = await loadSession(ctx.tx, input.sessionId, ctx.locationScope);
    return {
      result: session,
      audit: {
        targetType: 'count_session',
        targetId: session.sessionId,
        locationIds: session.location ? [session.location.locationId] : [],
        context: { input },
      },
    };
  },
});

export const listCounts = defineOperation({
  id: 'inventory.counts.list',
  summary: 'List count sessions',
  description:
    'Use this to find count sessions: open ones by default, newest first. Page with `before`.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    status: z.enum(['open', 'submitted', 'cancelled', 'all']).default('open'),
    before: Id.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  output: z.object({
    counts: z.array(CountSessionOut.omit({ lines: true })),
    next: Id.nullable(),
  }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'inventory.counts.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/counts' },
  mcp: { tool: TOOL, action: 'list_counts', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const rows = await ctx.tx.query<{
      sessionId: string;
      name: string | null;
      status: 'open' | 'submitted' | 'cancelled';
      blind: boolean;
      quick: boolean;
      note: string | null;
      location: { locationId: string; path: string } | null;
      createdAt: string;
      submittedAt: string | null;
      operationId: string | null;
      lines: number;
      counted: number;
    }>(
      `select s.id as "sessionId", s.name, s.status, s.blind, s.quick, s.note,
         case when l.id is null then null else json_build_object('locationId', l.id, 'path', l.path) end as location,
         ${tsSql('s.created_at')} as "createdAt", ${tsSql('s.submitted_at')} as "submittedAt",
         s.operation_id as "operationId",
         (select count(*)::int from count_lines c where c.shop_id = s.shop_id and c.session_id = s.id) as lines,
         (select count(*)::int from count_lines c where c.shop_id = s.shop_id and c.session_id = s.id
            and c.status <> 'pending') as counted
       from count_sessions s left join locations l on l.shop_id = s.shop_id and l.id = s.location_id
       where ($1 = 'all' or s.status = $1)
         and ($2::uuid is null or s.id < $2)
         and ${inScope('$3')}
       order by s.id desc limit $4`,
      [input.status, input.before ?? null, ctx.locationScope, input.limit],
    );
    return {
      result: {
        counts: rows.map(({ lines, counted, ...r }) => ({
          ...r,
          totals: { lines, counted, needsReview: 0 },
        })),
        next: rows.length === input.limit ? (rows.at(-1)?.sessionId ?? null) : null,
      },
      audit: { targetType: 'shop', targetId: ctx.shopId, context: { input, count: rows.length } },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const inventoryCountsOperations = [
  quickCount,
  startCount,
  recordCount,
  submitCount,
  cancelCount,
  listCounts,
  getCount,
] as const;
