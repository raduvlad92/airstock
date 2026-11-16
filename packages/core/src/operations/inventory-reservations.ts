import type { Tx } from '@airstock/db';
import { z } from 'zod';
import type { AuditEvent } from '../audit.ts';
import { compare, normalize, subtract } from '../catalog/decimal.ts';
import { PositiveDecimal } from '../decimal.ts';
import { errors } from '../errors.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id, iso } from '../schemas.ts';
import {
  actorColumns,
  allocate,
  applyStockCost,
  assertScale,
  canSeeCosts,
  choosePositions,
  exactProduct,
  expireClaimsAt,
  insufficientStock,
  loadRuleScopes,
  loadStockVariant,
  lockCandidates,
  lockPositions,
  normalizeCode,
  OPEN_STATUSES,
  type Pick,
  refreshStatuses,
  shortfall,
  sumQuantities,
} from '../stock/engine.ts';
import { Flag, isSet, LotCode } from './inventory.ts';

// Reservations v2 (plan Section 5.3, ADR 0020): reserve variants and bundles, release and fulfill
// in part, reallocate, and list. Every command follows the lock order in stock/engine.ts.

const TOOL = 'manage_reservations';

const Reference = z.string().trim().min(1).max(200);

const AllocationOut = z.object({
  allocationId: Id,
  positionId: Id,
  locationId: Id,
  lotId: Id.nullable(),
  serialId: Id.nullable(),
  quantity: z.string(),
});

function allocationsOut(rows: Array<Pick & { allocationId: string }>) {
  return rows.map((r) => ({
    allocationId: r.allocationId,
    positionId: r.positionId,
    locationId: r.locationId,
    lotId: r.lotId,
    serialId: r.serialId,
    quantity: r.quantity,
  }));
}

interface BundleVersion {
  bundleVersionId: string;
  version: number;
  components: Array<{ variantId: string; perBundle: string }>;
}

/** The bundle's current definition, components added up per variant (ADR 0019). */
async function loadBundleVersion(tx: Tx, bundleId: string): Promise<BundleVersion> {
  const rows = await tx.query<{
    bundle_version_id: string;
    version: number;
    variant_id: string;
    per_bundle: string;
  }>(
    `select bv.id as bundle_version_id, bv.version, c.variant_id, sum(c.base_quantity)::text as per_bundle
     from bundles b
     join bundle_versions bv on bv.shop_id = b.shop_id and bv.bundle_id = b.id and bv.version = b.version
     join bundle_components c on c.shop_id = bv.shop_id and c.bundle_version_id = bv.id
     where b.id = $1
     group by bv.id, bv.version, c.variant_id
     order by c.variant_id`,
    [bundleId],
  );
  if (rows.length === 0)
    throw errors.unprocessable('not_a_bundle', 'This bundle has no components.');
  return {
    bundleVersionId: rows[0]!.bundle_version_id,
    version: rows[0]!.version,
    components: rows.map((r) => ({ variantId: r.variant_id, perBundle: normalize(r.per_bundle) })),
  };
}

async function findLot(tx: Tx, variantId: string, code: string): Promise<string> {
  const [lot] = await tx.query<{ id: string }>(
    'select id from lots where variant_id = $1 and code_normalized = $2',
    [variantId, normalizeCode(code)],
  );
  if (!lot) throw errors.notFound('Lot');
  return lot.id;
}

async function assertStorageLocation(tx: Tx, locationId: string | undefined): Promise<void> {
  if (!locationId) return;
  const [row] = await tx.query("select 1 from locations where id = $1 and kind = 'storage'", [
    locationId,
  ]);
  if (!row) throw errors.notFound('Location');
}

// Reserve ----------------------------------------------------------------------------------

export const reserveStock = defineOperation({
  id: 'inventory.reservations.create',
  summary: 'Reserve sellable stock',
  description:
    'Use this to hold units for an order or another purpose without moving them. Works for a variant or a bundle (every component is reserved together). Without locationId, the shop’s allocation rule picks positions: earliest expiry first for lots, then oldest stock. Fails whole if not enough is available, unless the caller is a sales channel connector, which records a shortage instead. Expiry is optional; the shop default applies when expiresInSeconds is left out, and null means never.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    variantId: Id,
    quantity: PositiveDecimal.describe('Base units, or bundles for a bundle variant.'),
    locationId: Id.optional().describe('Take stock only from this location and its sub-locations.'),
    lotCode: LotCode.optional().describe('Take stock only from this lot.'),
    purpose: z.enum(['manual', 'external_order']).default('manual'),
    externalRef: Reference.optional().describe('For example an external order and line ID.'),
    channel: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Which allocation rule applies; "default" when left out.'),
    expiresInSeconds: z
      .number()
      .int()
      .min(60)
      .max(60 * 60 * 24 * 90)
      .nullable()
      .optional()
      .describe('Release automatically after this many seconds; null never expires.'),
    allowShortage: z
      .boolean()
      .optional()
      .describe('Connectors only: record what is short as a shortage instead of failing.'),
  }),
  output: z.object({
    reservationId: Id,
    operationId: Id,
    variantId: Id,
    quantity: z.string(),
    status: z.string(),
    channel: z.string(),
    expiresAt: z.string().nullable(),
    shortage: z.string(),
    allocations: z.array(AllocationOut),
    bundle: z
      .object({
        bundleVersionId: Id,
        version: z.number(),
        components: z.array(
          z.object({
            reservationId: Id,
            variantId: Id,
            perBundle: z.string(),
            quantity: z.string(),
            shortage: z.string(),
            allocations: z.array(AllocationOut),
          }),
        ),
      })
      .nullable(),
  }),
  permission: 'inventory.reserve',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.reservation.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/reservations', status: 201 },
  mcp: { tool: TOOL, action: 'reserve', readOnly: false, destructive: false },
  locations: (input) => (input.locationId ? [input.locationId] : []),
  async handler(ctx, input) {
    const variant = await loadStockVariant(ctx.tx, input.variantId);
    assertScale(input.quantity, variant.quantityScale);
    if (input.allowShortage && ctx.caller.kind !== 'connector') {
      throw errors.forbidden('Only a sales channel connector can reserve with a shortage (D6).');
    }
    await assertStorageLocation(ctx.tx, input.locationId);
    let lotId: string | null = null;
    if (input.lotCode) {
      if (variant.trackingMode !== 'lot' && variant.trackingMode !== 'lot_expiry') {
        throw errors.unprocessable('not_lot_tracked', 'This variant is not tracked by lot.');
      }
      lotId = await findLot(ctx.tx, input.variantId, input.lotCode);
    }
    const channel = input.channel ?? 'default';
    const ruleScopes = await loadRuleScopes(ctx.tx, channel);
    let expiresInSeconds: number | null;
    if (input.expiresInSeconds !== undefined) expiresInSeconds = input.expiresInSeconds;
    else if (ctx.caller.kind === 'connector') expiresInSeconds = null;
    else {
      const [shop] = await ctx.tx.query<{ minutes: number | null }>(
        'select reservation_expiry_minutes as minutes from shops where id = app_shop_id()',
      );
      expiresInSeconds = shop?.minutes ? shop.minutes * 60 : null;
    }

    // What to allocate: the variant, or each component of the bundle's current version.
    const bundle = variant.bundleId ? await loadBundleVersion(ctx.tx, variant.bundleId) : null;
    const needs: Array<{ variantId: string; quantity: string; perBundle: string | null }> = [];
    if (bundle) {
      for (const c of bundle.components) {
        const component = await loadStockVariant(ctx.tx, c.variantId);
        const quantity = normalize(exactProduct(input.quantity, c.perBundle));
        assertScale(quantity, component.quantityScale, `Component ${component.sku}`);
        needs.push({ variantId: c.variantId, quantity, perBundle: c.perBundle });
      }
    } else
      needs.push({
        variantId: input.variantId,
        quantity: normalize(input.quantity),
        perBundle: null,
      });

    // 1. Positions, 2. expired claims there, then the choice.
    const locked = await lockCandidates(ctx.tx, {
      variantIds: needs.map((n) => n.variantId),
      locationId: input.locationId ?? null,
      lotId,
      ruleScopes,
      scope: ctx.locationScope,
      includeEmpty: input.allowShortage ?? false,
    });
    const events = await expireClaimsAt(ctx, locked);
    const { picks, available } = await choosePositions(ctx.tx, needs, locked, ruleScopes);
    const short = needs.map((n) => ({ ...n, shortage: shortfall(n.quantity, picks, n.variantId) }));
    if (short.some((s) => s.shortage !== '0') && !input.allowShortage) {
      if (!bundle) throw insufficientStock(input.quantity, available.get(input.variantId) ?? '0');
      const [row] = await ctx.tx.query<{ bundles: string }>(
        `select coalesce(min(trunc(x.available / x.per)), 0)::text as bundles
         from jsonb_to_recordset($1::jsonb) as x(available numeric, per numeric)`,
        [
          JSON.stringify(
            needs.map((n) => ({ available: available.get(n.variantId) ?? '0', per: n.perBundle })),
          ),
        ],
      );
      throw insufficientStock(input.quantity, row?.bundles ?? '0', {
        components: short.map((s) => ({
          variantId: s.variantId,
          requested: s.quantity,
          available: available.get(s.variantId) ?? '0',
        })),
      });
    }

    const operationId = ctx.newId();
    const reservationId = ctx.newId();
    const rows = bundle
      ? [
          {
            id: reservationId,
            variantId: input.variantId,
            quantity: normalize(input.quantity),
            shortage: '0',
            parentId: null,
            per: null,
            bundleVersionId: bundle.bundleVersionId,
            lotId: null,
          },
          ...short.map((s) => ({
            id: ctx.newId(),
            variantId: s.variantId,
            quantity: s.quantity,
            shortage: s.shortage,
            parentId: reservationId,
            per: s.perBundle,
            bundleVersionId: null,
            lotId: null,
          })),
        ]
      : [
          {
            id: reservationId,
            variantId: input.variantId,
            quantity: normalize(input.quantity),
            shortage: short[0]!.shortage,
            parentId: null,
            per: null,
            bundleVersionId: null,
            lotId,
          },
        ];
    const [created] = await ctx.tx.query<{ expires_at: Date | null }>(
      `with op as (
         insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
           external_ref)
         values (app_shop_id(), $1, 'reservation', $2, $3, $4, $5, $6)),
       rows as (
         select * from jsonb_to_recordset($7::jsonb) as x(id uuid, "variantId" uuid, quantity numeric,
           shortage numeric, "parentId" uuid, per numeric, "bundleVersionId" uuid, "lotId" uuid)),
       res as (
         insert into reservations (shop_id, id, variant_id, quantity, shortage_quantity, purpose,
           external_ref, expires_at, created_operation_id, channel, location_id, lot_id, parent_id,
           component_base_quantity, bundle_version_id)
         select app_shop_id(), r.id, r."variantId", r.quantity, r.shortage, $8, $6,
           case when $9::integer is null then null else now() + make_interval(secs => $9::integer) end,
           $1, $10, $11, r."lotId", r."parentId", r.per, r."bundleVersionId"
         from rows r
         returning id, expires_at)
       select expires_at from res where id = $12`,
      [
        operationId,
        ...actorColumns(ctx),
        input.externalRef ?? null,
        JSON.stringify(rows),
        input.purpose,
        expiresInSeconds,
        channel,
        input.locationId ?? null,
        reservationId,
      ],
    );
    const byVariant = new Map(
      rows.filter((r) => r.parentId !== null || !bundle).map((r) => [r.variantId, r.id]),
    );
    const made = await allocate(ctx, byVariant, picks);
    const shortageTotal = bundle ? '0' : short[0]!.shortage;
    const expiresAt = iso(created?.expires_at ?? null);
    const bundleOut = bundle
      ? {
          bundleVersionId: bundle.bundleVersionId,
          version: bundle.version,
          components: rows
            .filter((r) => r.parentId !== null)
            .map((r) => ({
              reservationId: r.id,
              variantId: r.variantId,
              perBundle: r.per!,
              quantity: r.quantity,
              shortage: r.shortage,
              allocations: allocationsOut(made.filter((m) => m.reservationId === r.id)),
            })),
        }
      : null;
    const anyShortage = short.some((s) => s.shortage !== '0');
    const locationIds = [...new Set(made.map((a) => a.locationId))];
    return {
      result: {
        reservationId,
        operationId,
        variantId: input.variantId,
        quantity: normalize(input.quantity),
        status: 'active',
        channel,
        expiresAt,
        shortage: shortageTotal,
        allocations: bundle ? [] : allocationsOut(made),
        bundle: bundleOut,
      },
      audit: {
        targetType: 'reservation',
        targetId: reservationId,
        operationId,
        locationIds,
        externalRef: input.externalRef ?? null,
        changes: {
          variantId: input.variantId,
          quantity: normalize(input.quantity),
          purpose: input.purpose,
          channel,
          locationId: input.locationId ?? null,
          lotId,
          allocations: allocationsOut(made),
          shortage: short
            .filter((s) => s.shortage !== '0')
            .map((s) => ({
              variantId: s.variantId,
              quantity: s.shortage,
            })),
          bundle: bundle
            ? {
                bundleVersionId: bundle.bundleVersionId,
                version: bundle.version,
                components: bundleOut!.components.map((c) => ({
                  reservationId: c.reservationId,
                  variantId: c.variantId,
                  quantity: c.quantity,
                })),
              }
            : null,
          expiresAt,
        },
      },
      outbox: [
        ...needs.map((n) => ({
          topic: 'inventory.availability_changed',
          payload: {
            variantId: n.variantId,
            locationIds: [
              ...new Set(made.filter((m) => m.variantId === n.variantId).map((m) => m.locationId)),
            ],
          },
        })),
        ...(anyShortage
          ? [
              {
                topic: 'inventory.shortage_opened',
                payload: {
                  reservationId,
                  externalRef: input.externalRef ?? null,
                  shortages: short
                    .filter((s) => s.shortage !== '0')
                    .map((s) => ({ variantId: s.variantId, quantity: s.shortage })),
                },
              },
            ]
          : []),
      ],
      events,
    };
  },
});

// Locking an existing reservation ------------------------------------------------------------

interface ReservationRow {
  id: string;
  parent_id: string | null;
  variant_id: string;
  quantity: string;
  shortage: string;
  allocated: string;
  status: string;
  expired: boolean;
  per: string | null;
  external_ref: string | null;
  channel: string;
  purpose: string;
}

/**
 * Locks a reservation for release, fulfillment, or reallocation: first the positions its open
 * allocations (and its components') sit on, then the reservation and its components in id order.
 * An allocation that moved to another position in between makes the caller retry.
 */
async function lockTree(
  ctx: HandlerContext,
  reservationId: string,
  extraPositions: string[] = [],
  expire = false,
): Promise<{
  root: ReservationRow;
  components: ReservationRow[];
  positions: string[];
  events: AuditEvent[];
}> {
  const ids = (
    await ctx.tx.query<{ id: string }>(
      'select id from reservations where id = $1 or parent_id = $1 order by id',
      [reservationId],
    )
  ).map((r) => r.id);
  if (ids.length === 0) throw errors.notFound('Reservation');
  const openPositions = async () =>
    (
      await ctx.tx.query<{ position_id: string }>(
        `select distinct position_id from reservation_allocations
         where reservation_id = any($1::uuid[]) and outstanding > 0`,
        [ids],
      )
    ).map((r) => r.position_id);
  const positions = await lockPositions(ctx.tx, [...(await openPositions()), ...extraPositions]);
  // Expired claims at those positions go first, locking their reservations and these together.
  const events = expire ? await expireClaimsAt(ctx, positions, ids) : [];
  const rows = await ctx.tx.query<ReservationRow>(
    `select r.id, r.parent_id, r.variant_id, r.quantity::text, r.shortage_quantity::text as shortage,
       coalesce((select sum(a.outstanding) from reservation_allocations a
         where a.shop_id = r.shop_id and a.reservation_id = r.id), 0)::text as allocated,
       r.status, (r.expires_at is not null and r.expires_at <= now()) as expired,
       r.component_base_quantity::text as per, r.external_ref, r.channel, r.purpose
     from reservations r where r.id = any($1::uuid[]) order by r.id for update`,
    [ids],
  );
  const held = new Set(positions);
  if ((await openPositions()).some((p) => !held.has(p))) {
    throw errors.conflict(
      'retry_conflict',
      'The reservation changed while it was being read. Retry the request.',
    );
  }
  const root = rows.find((r) => r.id === reservationId);
  if (!root) throw errors.notFound('Reservation');
  return {
    root,
    components: rows.filter((r) => r.parent_id === reservationId),
    positions,
    events,
  };
}

function assertOpen(root: ReservationRow): void {
  if (root.parent_id) {
    throw errors.unprocessable(
      'reservation_is_component',
      'This reservation is part of a bundle reservation; act on the bundle.',
      { parentReservationId: root.parent_id },
    );
  }
  // A transfer hold changes only through its transfer, so its line quantities stay exact (D8).
  if (root.purpose === 'transfer') {
    throw errors.unprocessable(
      'reservation_is_transfer',
      'This reservation is a transfer hold; dispatch or cancel it on the transfer (transfer_stock).',
    );
  }
  if (!(OPEN_STATUSES as readonly string[]).includes(root.status)) {
    throw errors.conflict('reservation_not_open', `The reservation is ${root.status}.`, {
      status: root.status,
    });
  }
  if (root.expired) {
    throw errors.conflict(
      'reservation_expired',
      'The reservation has expired; its units are already available.',
    );
  }
}

/** Bundles fully covered by every component's quantity (open or allocated). */
async function bundlesCovered(
  tx: Tx,
  components: ReservationRow[],
  field: 'open' | 'allocated',
): Promise<string> {
  const [row] = await tx.query<{ bundles: string }>(
    `select coalesce(min(x.qty / x.per), 0)::text as bundles
     from jsonb_to_recordset($1::jsonb) as x(qty numeric, per numeric)`,
    [
      JSON.stringify(
        components.map((c) => ({
          qty: field === 'open' ? sumQuantities([c.allocated, c.shortage]) : c.allocated,
          per: c.per,
        })),
      ),
    ],
  );
  return normalize(row?.bundles ?? '0');
}

// Release ----------------------------------------------------------------------------------

interface Moved {
  allocationId: string;
  positionId: string;
  locationId: string;
  quantity: string;
}

/** Releases from one reservation: its shortage first, then allocations, newest first. */
async function releaseFrom(
  ctx: HandlerContext,
  r: ReservationRow,
  quantity: string,
  allocationId: string | null,
): Promise<{ fromShortage: string; allocations: Moved[] }> {
  let rest = quantity;
  let fromShortage = '0';
  if (!allocationId && compare(r.shortage, '0') > 0) {
    fromShortage = compare(r.shortage, rest) < 0 ? normalize(r.shortage) : rest;
    await ctx.tx.query(
      `update reservations set shortage_quantity = shortage_quantity - $2::numeric,
         shortage_released = shortage_released + $2::numeric, updated_at = now()
       where id = $1`,
      [r.id, fromShortage],
    );
    rest = normalize(subtract(rest, fromShortage));
  }
  if (compare(rest, '0') <= 0) return { fromShortage, allocations: [] };
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
       where a.shop_id = app_shop_id() and a.reservation_id = $1 and a.outstanding > 0
         and ($3::uuid is null or a.id = $3)),
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
    [r.id, rest, allocationId],
  );
  return {
    fromShortage,
    allocations: rows.map((x) => ({
      allocationId: x.allocation_id,
      positionId: x.position_id,
      locationId: x.location_id,
      quantity: x.take,
    })),
  };
}

const ReleaseInput = z.object({
  reservationId: Id,
  quantity: PositiveDecimal.optional().describe(
    'How much to act on (bundles for a bundle reservation). Leave out for everything still open.',
  ),
  allocationId: Id.optional().describe('Act on this allocation only.'),
  reason: z.string().trim().min(1).max(500).optional(),
});

export const releaseReservation = defineOperation({
  id: 'inventory.reservations.release',
  summary: 'Release a reservation, fully or partly',
  description:
    'Use this when held units are no longer needed, such as a cancelled order line. Returns reserved units to availability without moving stock: an open shortage is released first, then allocations. Without a quantity, everything still open is released.',
  kind: 'command',
  scope: 'shop',
  input: ReleaseInput,
  output: z.object({
    reservationId: Id,
    operationId: Id,
    released: z.string(),
    status: z.string(),
    shortageReleased: z.string(),
  }),
  permission: 'inventory.reserve',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.reservation.released' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/reservations/{reservationId}/release' },
  mcp: { tool: TOOL, action: 'release', readOnly: false, destructive: false },
  // A shortage is at no position: it is about the reservation's location limit, if any.
  locations: async (input, tx) => [
    ...(await allocationLocations(tx, input.reservationId)),
    ...(await shortageLocations(tx, input.reservationId)),
  ],
  async handler(ctx, input) {
    const { root, components } = await lockTree(ctx, input.reservationId);
    assertOpen(root);
    const operationId = ctx.newId();
    await ctx.tx.query(
      `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
         external_ref, reason)
       values (app_shop_id(), $1, 'release', $2, $3, $4, $5, $6, $7)`,
      [operationId, ...actorColumns(ctx), root.external_ref, input.reason ?? null],
    );
    let quantity: string;
    const moved: Array<{ reservationId: string; fromShortage: string; allocations: Moved[] }> = [];
    if (components.length > 0) {
      if (input.allocationId) {
        throw errors.unprocessable(
          'bundle_by_quantity',
          'A bundle reservation is released by quantity of bundles, not by allocation.',
        );
      }
      const open = await bundlesCovered(ctx.tx, components, 'open');
      quantity = normalize(input.quantity ?? open);
      if (compare(quantity, open) > 0 || compare(quantity, '0') <= 0) {
        throw errors.unprocessable(
          'quantity_exceeds_reserved',
          'The quantity is more than is still reserved.',
          { outstanding: open },
        );
      }
      for (const c of components) {
        const q = normalize(exactProduct(quantity, c.per!));
        moved.push({ reservationId: c.id, ...(await releaseFrom(ctx, c, q, null)) });
      }
    } else {
      let open = sumQuantities([root.allocated, root.shortage]);
      if (input.allocationId) {
        const [a] = await ctx.tx.query<{ outstanding: string }>(
          'select outstanding::text from reservation_allocations where id = $1 and reservation_id = $2',
          [input.allocationId, root.id],
        );
        if (!a) throw errors.notFound('Allocation');
        open = a.outstanding;
      }
      quantity = normalize(input.quantity ?? open);
      if (compare(quantity, open) > 0 || compare(quantity, '0') <= 0) {
        throw errors.unprocessable(
          'quantity_exceeds_reserved',
          'The quantity is more than is still reserved.',
          { outstanding: normalize(open) },
        );
      }
      moved.push({
        reservationId: root.id,
        ...(await releaseFrom(ctx, root, quantity, input.allocationId ?? null)),
      });
    }
    const statuses = await refreshStatuses(ctx.tx, [root.id, ...components.map((c) => c.id)]);
    const all = moved.flatMap((m) => m.allocations);
    const locationIds = [...new Set(all.map((a) => a.locationId))];
    const shortageReleased = sumQuantities(moved.map((m) => m.fromShortage));
    return {
      result: {
        reservationId: root.id,
        operationId,
        released: quantity,
        status: statuses.get(root.id) ?? root.status,
        shortageReleased: normalize(shortageReleased),
      },
      audit: {
        targetType: 'reservation',
        targetId: root.id,
        operationId,
        locationIds,
        reason: input.reason ?? null,
        changes: {
          quantity,
          released: moved,
          status: statuses.get(root.id) ?? root.status,
        },
      },
      outbox: [...new Set([root.variant_id, ...components.map((c) => c.variant_id)])].map(
        (variantId) => ({
          topic: 'inventory.availability_changed',
          payload: { variantId, locationIds },
        }),
      ),
    };
  },
});

async function allocationLocations(tx: Tx, reservationId: string): Promise<string[]> {
  return (
    await tx.query<{ location_id: string }>(
      `select distinct p.location_id from reservation_allocations a
       join reservations r on r.shop_id = a.shop_id and r.id = a.reservation_id
       join inventory_positions p on p.shop_id = a.shop_id and p.id = a.position_id
       where r.id = $1 or r.parent_id = $1`,
      [reservationId],
    )
  ).map((r) => r.location_id);
}

/** The location limit of a reservation (or bundle component) with an open shortage. */
async function shortageLocations(tx: Tx, reservationId: string): Promise<string[]> {
  return (
    await tx.query<{ location_id: string }>(
      `select distinct location_id from reservations
       where (id = $1 or parent_id = $1) and shortage_quantity > 0 and location_id is not null`,
      [reservationId],
    )
  ).map((r) => r.location_id);
}

// Fulfill ----------------------------------------------------------------------------------

interface Shipped {
  allocationId: string;
  reservationId: string;
  variantId: string;
  positionId: string;
  locationId: string;
  lotId: string | null;
  serialId: string | null;
  quantity: string;
}

async function fulfillFrom(
  ctx: HandlerContext,
  r: ReservationRow,
  quantity: string,
  allocationId: string | null,
): Promise<Shipped[]> {
  const rows = await ctx.tx.query<{
    allocation_id: string;
    position_id: string;
    location_id: string;
    lot_id: string | null;
    serial_id: string | null;
    take: string;
  }>(
    `with open as (
       select a.id, a.position_id, a.outstanding, sum(a.outstanding) over (order by a.id) as running
       from reservation_allocations a
       where a.shop_id = app_shop_id() and a.reservation_id = $1 and a.outstanding > 0
         and ($3::uuid is null or a.id = $3)),
     picks as (
       select id, position_id, least(outstanding, $2::numeric - (running - outstanding)) as take
       from open where running - outstanding < $2::numeric),
     alloc as (
       update reservation_allocations a set fulfilled = a.fulfilled + p.take
       from picks p where a.shop_id = app_shop_id() and a.id = p.id),
     pos as (
       update inventory_positions x
       set on_hand = x.on_hand - s.take, allocated = x.allocated - s.take, version = x.version + 1,
         updated_at = now()
       from (select position_id, sum(take) as take from picks group by position_id) s
       where x.shop_id = app_shop_id() and x.id = s.position_id
       returning x.id, x.location_id, x.lot_id, x.serial_id)
     select p.id as allocation_id, p.position_id, pos.location_id, pos.lot_id, pos.serial_id, p.take::text
     from picks p join pos on pos.id = p.position_id order by p.id`,
    [r.id, quantity, allocationId],
  );
  return rows.map((x) => ({
    allocationId: x.allocation_id,
    reservationId: r.id,
    variantId: r.variant_id,
    positionId: x.position_id,
    locationId: x.location_id,
    lotId: x.lot_id,
    serialId: x.serial_id,
    quantity: x.take,
  }));
}

export const fulfillReservation = defineOperation({
  id: 'inventory.reservations.fulfill',
  summary: 'Fulfill a reservation, fully or partly',
  description:
    'Use this when reserved units leave the shop, such as a shipped order. Lowers on hand and reserved together at the allocated positions, records the cost of goods at the moving average, and marks serials sold. Without a quantity, everything allocated is fulfilled; a shortage cannot be fulfilled until stock covers it. A bundle is fulfilled by number of bundles. If the units came from another position, reallocate first.',
  kind: 'command',
  scope: 'shop',
  input: ReleaseInput.extend({
    reference: Reference.optional().describe('A shipment or fulfillment reference.'),
  }),
  output: z.object({
    reservationId: Id,
    operationId: Id,
    fulfilled: z.string(),
    status: z.string(),
    lines: z.array(
      z.object({
        variantId: Id,
        positionId: Id,
        locationId: Id,
        lotId: Id.nullable(),
        serialId: Id.nullable(),
        quantity: z.string(),
      }),
    ),
    costVisible: z.boolean(),
    costOfGoods: z
      .string()
      .nullable()
      .describe('Units times the moving average at fulfillment; needs costs.read.'),
  }),
  permission: 'inventory.fulfill',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.reservation.fulfilled' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/reservations/{reservationId}/fulfill' },
  mcp: { tool: TOOL, action: 'fulfill', readOnly: false, destructive: false },
  locations: (input, tx) => allocationLocations(tx, input.reservationId),
  async handler(ctx, input) {
    const { root, components } = await lockTree(ctx, input.reservationId);
    assertOpen(root);
    let quantity: string;
    const plan: Array<{ r: ReservationRow; quantity: string }> = [];
    if (components.length > 0) {
      if (input.allocationId) {
        throw errors.unprocessable(
          'bundle_by_quantity',
          'A bundle reservation is fulfilled by quantity of bundles, not by allocation.',
        );
      }
      const covered = await bundlesCovered(ctx.tx, components, 'allocated');
      quantity = normalize(input.quantity ?? covered);
      if (compare(quantity, covered) > 0 || compare(quantity, '0') <= 0) {
        throw errors.unprocessable(
          'quantity_exceeds_allocated',
          'The quantity is more than is allocated; a shortage must be covered by stock first.',
          { allocated: covered },
        );
      }
      for (const c of components) {
        plan.push({ r: c, quantity: normalize(exactProduct(quantity, c.per!)) });
      }
    } else {
      let allocated = root.allocated;
      if (input.allocationId) {
        const [a] = await ctx.tx.query<{ outstanding: string }>(
          'select outstanding::text from reservation_allocations where id = $1 and reservation_id = $2',
          [input.allocationId, root.id],
        );
        if (!a) throw errors.notFound('Allocation');
        allocated = a.outstanding;
      }
      quantity = normalize(input.quantity ?? allocated);
      if (compare(quantity, allocated) > 0 || compare(quantity, '0') <= 0) {
        throw errors.unprocessable(
          'quantity_exceeds_allocated',
          'The quantity is more than is allocated; a shortage must be covered by stock first.',
          { allocated: normalize(allocated), shortage: normalize(root.shortage) },
        );
      }
      plan.push({ r: root, quantity });
    }

    const operationId = ctx.newId();
    await ctx.tx.query(
      `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
         external_ref, reason)
       values (app_shop_id(), $1, 'fulfillment', $2, $3, $4, $5, $6, $7)`,
      [
        operationId,
        ...actorColumns(ctx),
        input.reference ?? root.external_ref,
        input.reason ?? null,
      ],
    );
    // 1–2. Positions and reservations are locked: move the stock.
    const shipped: Shipped[] = [];
    for (const step of plan) {
      shipped.push(...(await fulfillFrom(ctx, step.r, step.quantity, input.allocationId ?? null)));
    }
    // 3. Costs per variant (in id order), then the ledger, serials, and sold one-of-a-kind items.
    const variants = [...new Set(shipped.map((s) => s.variantId))].sort();
    const costs = new Map<string, { unitCost: string | null; costBasis: string }>();
    for (const variantId of variants) {
      const total = sumQuantities(
        shipped.filter((s) => s.variantId === variantId).map((s) => s.quantity),
      );
      costs.set(
        variantId,
        await applyStockCost(
          ctx,
          variantId,
          operationId,
          'fulfillment',
          `-${normalize(total)}`,
          null,
        ),
      );
    }
    await ctx.tx.query(
      `insert into inventory_entries (shop_id, id, operation_id, position_id, variant_id, location_id,
         delta, lot_id, serial_id, reservation_id, unit_cost, cost_basis)
       select app_shop_id(), x.id, $2, x."positionId", x."variantId", x."locationId", -x.quantity,
         x."lotId", x."serialId", x."reservationId", x."unitCost", x."costBasis"
       from jsonb_to_recordset($1::jsonb) as x(id uuid, "positionId" uuid, "variantId" uuid,
         "locationId" uuid, quantity numeric, "lotId" uuid, "serialId" uuid, "reservationId" uuid,
         "unitCost" numeric, "costBasis" text)`,
      [
        JSON.stringify(
          shipped.map((s) => ({
            ...s,
            id: ctx.newId(),
            unitCost: costs.get(s.variantId)?.unitCost ?? null,
            costBasis: costs.get(s.variantId)?.costBasis ?? 'none',
          })),
        ),
        operationId,
      ],
    );
    const serialIds = shipped.map((s) => s.serialId).filter((s): s is string => s !== null);
    if (serialIds.length > 0) {
      await ctx.tx.query(
        `update serial_units set status = 'sold', position_id = null, last_operation_id = $2,
           updated_at = now(), version = version + 1
         where id = any($1::uuid[])`,
        [serialIds, operationId],
      );
    }
    // A one-of-a-kind item with nothing left is sold: hidden from default views (D5).
    const sold = await ctx.tx.query<{ id: string }>(
      `update products p set status = 'sold', updated_at = now(), version = p.version + 1
       where p.status in ('active', 'draft')
         and p.id in (select v.product_id from variants v where v.id = any($1::uuid[]) and v.one_of_a_kind)
         and not exists (select 1 from variants v
           left join variant_costs c on c.shop_id = v.shop_id and c.variant_id = v.id
           where v.shop_id = p.shop_id and v.product_id = p.id and v.status = 'active'
             and (not v.one_of_a_kind or coalesce(c.quantity, 0) > 0))
       returning p.id`,
      [variants],
    );
    const statuses = await refreshStatuses(ctx.tx, [root.id, ...components.map((c) => c.id)]);
    const visible = canSeeCosts(ctx);
    const [cog] = await ctx.tx.query<{ total: string | null }>(
      `select case when bool_and(x."unitCost" is not null) then
         round_half_even(sum(x.quantity * x."unitCost"), 6)::text end as total
       from jsonb_to_recordset($1::jsonb) as x(quantity numeric, "unitCost" numeric)`,
      [
        JSON.stringify(
          shipped.map((s) => ({
            quantity: s.quantity,
            unitCost: costs.get(s.variantId)?.unitCost,
          })),
        ),
      ],
    );
    const lines = shipped.map((s) => ({
      variantId: s.variantId,
      positionId: s.positionId,
      locationId: s.locationId,
      lotId: s.lotId,
      serialId: s.serialId,
      quantity: s.quantity,
    }));
    const locationIds = [...new Set(shipped.map((s) => s.locationId))];
    return {
      result: {
        reservationId: root.id,
        operationId,
        fulfilled: quantity,
        status: statuses.get(root.id) ?? root.status,
        lines,
        costVisible: visible,
        costOfGoods: visible ? (cog?.total ?? null) : null,
      },
      audit: {
        targetType: 'reservation',
        targetId: root.id,
        operationId,
        locationIds,
        externalRef: input.reference ?? root.external_ref,
        reason: input.reason ?? null,
        changes: {
          quantity,
          lines,
          status: statuses.get(root.id) ?? root.status,
          soldProducts: sold.map((s) => s.id),
          restricted: {
            permission: 'costs.read',
            fields: {
              costOfGoods: cog?.total ?? null,
              unitCosts: Object.fromEntries([...costs].map(([v, c]) => [v, c.unitCost])),
            },
          },
        },
      },
      outbox: variants.map((variantId) => ({
        topic: 'inventory.availability_changed',
        payload: {
          variantId,
          locationIds: [
            ...new Set(shipped.filter((s) => s.variantId === variantId).map((s) => s.locationId)),
          ],
        },
      })),
    };
  },
});

// Reallocate -------------------------------------------------------------------------------

export const reallocateReservation = defineOperation({
  id: 'inventory.reservations.reallocate',
  summary: 'Move a reservation’s allocation to another position',
  description:
    'Use this when the units for a reservation should come from somewhere else, for example a picker scanned a different lot or serial, or the order ships from another location. Name the target as positionId, or as locationId, lotCode, or serial. Without allocationId the reservation must have exactly one open allocation.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    reservationId: Id,
    allocationId: Id.optional(),
    quantity: PositiveDecimal.optional().describe('Leave out to move the whole allocation.'),
    positionId: Id.optional(),
    locationId: Id.optional(),
    lotCode: LotCode.optional(),
    serial: z.string().trim().min(1).max(100).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  output: z.object({
    reservationId: Id,
    operationId: Id,
    moved: z.string(),
    from: z.object({ allocationId: Id, positionId: Id }),
    to: z.array(AllocationOut),
  }),
  permission: 'inventory.reserve',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.reservation.reallocated' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/reservations/{reservationId}/reallocate' },
  mcp: { tool: TOOL, action: 'reallocate', readOnly: false, destructive: false },
  locations: async (input, tx) => [
    ...(await allocationLocations(tx, input.reservationId)),
    ...(input.locationId ? [input.locationId] : []),
  ],
  async handler(ctx, input) {
    if (!input.positionId && !input.locationId && !input.lotCode && !input.serial) {
      throw errors.unprocessable(
        'target_required',
        'Name where the units should come from: positionId, locationId, lotCode, or serial.',
      );
    }
    await assertStorageLocation(ctx.tx, input.locationId);
    const [exists] = await ctx.tx.query('select 1 from reservations where id = $1', [
      input.reservationId,
    ]);
    if (!exists) throw errors.notFound('Reservation');
    const open = await ctx.tx.query<{
      id: string;
      reservation_id: string;
      position_id: string;
      variant_id: string;
    }>(
      `select a.id, a.reservation_id, a.position_id, r.variant_id
       from reservation_allocations a join reservations r on r.shop_id = a.shop_id and r.id = a.reservation_id
       where (r.id = $1 or r.parent_id = $1) and a.outstanding > 0 and ($2::uuid is null or a.id = $2)
       order by a.id`,
      [input.reservationId, input.allocationId ?? null],
    );
    if (open.length === 0) {
      throw input.allocationId
        ? errors.notFound('Allocation')
        : errors.conflict('nothing_allocated', 'The reservation has no open allocation.');
    }
    if (open.length > 1) {
      throw errors.unprocessable(
        'allocation_required',
        'The reservation has several open allocations: name one with allocationId.',
        { allocationIds: open.map((o) => o.id) },
      );
    }
    const source = open[0]!;
    const variant = await loadStockVariant(ctx.tx, source.variant_id);
    const lotId = input.lotCode ? await findLot(ctx.tx, variant.id, input.lotCode) : null;
    let serialId: string | null = null;
    if (input.serial) {
      const [s] = await ctx.tx.query<{ id: string }>(
        'select id from serial_units where variant_id = $1 and serial_normalized = $2',
        [variant.id, normalizeCode(input.serial)],
      );
      if (!s) throw errors.notFound('Serial');
      serialId = s.id;
    }
    const spec = {
      variantIds: [variant.id],
      locationId: input.locationId ?? null,
      lotId,
      serialId,
      ruleScopes: null,
      scope: ctx.locationScope,
      exclude: [source.position_id],
      only: input.positionId ? [input.positionId] : null,
    };
    // 1. The source and target positions together, in id order; 2. expired claims there and the
    // reservation, in id order.
    const targets = await lockCandidates(ctx.tx, spec, false);
    const { root, positions, events } = await lockTree(ctx, input.reservationId, targets, true);
    assertOpen(root);
    const [current] = await ctx.tx.query<{ outstanding: string }>(
      'select outstanding::text from reservation_allocations where id = $1',
      [source.id],
    );
    const outstanding = current?.outstanding ?? '0';
    const quantity = normalize(input.quantity ?? outstanding);
    if (compare(quantity, outstanding) > 0) {
      throw errors.unprocessable(
        'quantity_exceeds_allocated',
        'The quantity is more than this allocation holds.',
        { allocated: normalize(outstanding) },
      );
    }
    const held = new Set(positions);
    const usable = targets.filter((t) => held.has(t));
    const ruleScopes = await loadRuleScopes(ctx.tx, root.channel);
    const { picks, available } = await choosePositions(
      ctx.tx,
      [{ variantId: variant.id, quantity }],
      usable,
      ruleScopes,
    );
    if (shortfall(quantity, picks, variant.id) !== '0') {
      throw insufficientStock(quantity, available.get(variant.id) ?? '0');
    }
    const operationId = ctx.newId();
    await ctx.tx.query(
      `with op as (
         insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
           external_ref, reason)
         values (app_shop_id(), $1, 'reallocation', $2, $3, $4, $5, $6, $7)),
       src as (
         update reservation_allocations set moved = moved + $9::numeric where id = $8
         returning position_id)
       update inventory_positions p
       set allocated = p.allocated - $9::numeric, version = p.version + 1, updated_at = now()
       from src where p.shop_id = app_shop_id() and p.id = src.position_id`,
      [
        operationId,
        ...actorColumns(ctx),
        root.external_ref,
        input.reason ?? null,
        source.id,
        quantity,
      ],
    );
    const made = await allocate(
      ctx,
      new Map([[variant.id, source.reservation_id]]),
      picks,
      source.id,
    );
    const to = allocationsOut(made);
    const locationIds = [...new Set([...made.map((m) => m.locationId)])];
    const [from] = await ctx.tx.query<{ location_id: string }>(
      'select location_id from inventory_positions where id = $1',
      [source.position_id],
    );
    if (from) locationIds.push(from.location_id);
    return {
      result: {
        reservationId: root.id,
        operationId,
        moved: quantity,
        from: { allocationId: source.id, positionId: source.position_id },
        to,
      },
      audit: {
        targetType: 'reservation',
        targetId: root.id,
        operationId,
        locationIds: [...new Set(locationIds)],
        reason: input.reason ?? null,
        changes: {
          quantity,
          from: { allocationId: source.id, positionId: source.position_id },
          to,
        },
      },
      outbox: [
        {
          topic: 'inventory.availability_changed',
          payload: { variantId: variant.id, locationIds: [...new Set(locationIds)] },
        },
      ],
      events,
    };
  },
});

// Reads ------------------------------------------------------------------------------------

const ReservationOut = z.object({
  reservationId: Id,
  variantId: Id,
  sku: z.string(),
  quantity: z.string(),
  status: z.string(),
  purpose: z.string(),
  channel: z.string(),
  externalRef: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  locationId: Id.nullable(),
  lotId: Id.nullable(),
  shortage: z.string(),
  outstanding: z.string().describe('Still allocated (not fulfilled, released, or moved).'),
  fulfilled: z.string(),
  bundleVersionId: Id.nullable(),
  allocations: z.array(
    z.object({
      allocationId: Id,
      reservationId: Id,
      variantId: Id,
      positionId: Id,
      locationId: Id,
      locationPath: z.string(),
      lotCode: z.string().nullable(),
      serial: z.string().nullable(),
      quantity: z.string(),
      outstanding: z.string(),
      fulfilled: z.string(),
      released: z.string(),
      moved: z.string(),
    }),
  ),
  components: z.array(
    z.object({
      reservationId: Id,
      variantId: Id,
      sku: z.string(),
      perBundle: z.string(),
      quantity: z.string(),
      shortage: z.string(),
      status: z.string(),
    }),
  ),
});

export const listReservations = defineOperation({
  id: 'inventory.reservations.list',
  summary: 'List reservations',
  description:
    'Use this to see what is held: open reservations by default, with their allocations (location, lot, serial), shortages, and bundle components. Filter by variant, status, external reference, or channel. Newest first; page with `before`.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    reservationId: Id.optional().describe('One reservation.'),
    variantId: Id.optional(),
    status: z
      .enum(['open', 'closed', 'all'])
      .default('open')
      .describe('Ignored when reservationId is given.'),
    externalRef: Reference.optional(),
    channel: z.string().trim().min(1).max(100).optional(),
    shortageOnly: Flag.optional(),
    before: Id.optional().describe('Reservations created before this one (paging).'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  output: z.object({ reservations: z.array(ReservationOut), next: Id.nullable() }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'inventory.reservations.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/reservations' },
  mcp: { tool: TOOL, action: 'list', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const rows = await ctx.tx.query<z.infer<typeof ReservationOut>>(
      `with top as (
         select r.* from reservations r
         where r.parent_id is null
           and ($1::uuid is null or r.id = $1)
           and ($2::uuid is null or r.variant_id = $2 or exists (select 1 from reservations c
             where c.shop_id = r.shop_id and c.parent_id = r.id and c.variant_id = $2))
           and ($3 = 'all' or $1::uuid is not null
             or ($3 = 'open') = (r.status in ('active', 'partially_fulfilled')))
           and ($4::text is null or r.external_ref = $4)
           and ($5::text is null or r.channel = $5)
           and (not $6 or r.shortage_quantity > 0 or exists (select 1 from reservations c
             where c.shop_id = r.shop_id and c.parent_id = r.id and c.shortage_quantity > 0))
           and ($7::uuid is null or r.id < $7)
           and ($9::uuid[] is null or (not exists (
             select 1 from reservation_allocations a
             join reservations c on c.shop_id = a.shop_id and c.id = a.reservation_id
             where (c.id = r.id or c.parent_id = r.id)) and (r.location_id is null or exists (
             select 1 from locations rl where rl.shop_id = r.shop_id and rl.id = r.location_id
               and rl.path_ids && $9::uuid[]))) or exists (
             select 1 from reservation_allocations a
             join reservations c on c.shop_id = a.shop_id and c.id = a.reservation_id
             join inventory_positions p on p.shop_id = a.shop_id and p.id = a.position_id
             join locations l on l.shop_id = p.shop_id and l.id = p.location_id
             where (c.id = r.id or c.parent_id = r.id) and l.path_ids && $9::uuid[]))
         order by r.id desc
         limit $8)
       select t.id as "reservationId", t.variant_id as "variantId", v.sku, t.quantity::text,
         t.status, t.purpose, t.channel, t.external_ref as "externalRef",
         to_char(t.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt",
         to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
         t.location_id as "locationId", t.lot_id as "lotId",
         (t.shortage_quantity + coalesce((select sum(c.shortage_quantity) from reservations c
           where c.shop_id = t.shop_id and c.parent_id = t.id), 0))::text as shortage,
         coalesce((select sum(a.outstanding) from reservation_allocations a
           where a.shop_id = t.shop_id and a.reservation_id = t.id), 0)::text as outstanding,
         coalesce((select sum(a.fulfilled) from reservation_allocations a
           where a.shop_id = t.shop_id and a.reservation_id = t.id), 0)::text as fulfilled,
         t.bundle_version_id as "bundleVersionId",
         coalesce((select json_agg(json_build_object('allocationId', a.id,
             'reservationId', a.reservation_id, 'variantId', c.variant_id, 'positionId', a.position_id,
             'locationId', p.location_id, 'locationPath', l.path, 'lotCode', lt.code,
             'serial', su.serial, 'quantity', a.quantity::text, 'outstanding', a.outstanding::text,
             'fulfilled', a.fulfilled::text, 'released', a.released::text, 'moved', a.moved::text)
             order by a.id)
           from reservation_allocations a
           join reservations c on c.shop_id = a.shop_id and c.id = a.reservation_id
           join inventory_positions p on p.shop_id = a.shop_id and p.id = a.position_id
           join locations l on l.shop_id = p.shop_id and l.id = p.location_id
           left join lots lt on lt.shop_id = p.shop_id and lt.id = p.lot_id
           left join serial_units su on su.shop_id = p.shop_id and su.id = p.serial_id
           where (c.id = t.id or c.parent_id = t.id)
             and ($9::uuid[] is null or l.path_ids && $9::uuid[])), '[]'::json) as allocations,
         coalesce((select json_agg(json_build_object('reservationId', c.id, 'variantId', c.variant_id,
             'sku', cv.sku, 'perBundle', c.component_base_quantity::text, 'quantity', c.quantity::text,
             'shortage', c.shortage_quantity::text, 'status', c.status) order by c.id)
           from reservations c join variants cv on cv.shop_id = c.shop_id and cv.id = c.variant_id
           where c.shop_id = t.shop_id and c.parent_id = t.id), '[]'::json) as components
       from top t join variants v on v.shop_id = t.shop_id and v.id = t.variant_id
       order by t.id desc`,
      [
        input.reservationId ?? null,
        input.variantId ?? null,
        input.status,
        input.externalRef ?? null,
        input.channel ?? null,
        isSet(input.shortageOnly),
        input.before ?? null,
        input.limit,
        ctx.locationScope,
      ],
    );
    if (input.reservationId && rows.length === 0) throw errors.notFound('Reservation');
    return {
      result: {
        reservations: rows,
        next: rows.length === input.limit ? (rows.at(-1)?.reservationId ?? null) : null,
      },
      audit: {
        targetType: input.reservationId ? 'reservation' : 'shop',
        targetId: input.reservationId ?? ctx.shopId,
        locationIds: [
          ...new Set(rows.flatMap((r) => r.allocations.map((a) => a.locationId))),
        ].slice(0, 100),
        context: { input, count: rows.length },
      },
    };
  },
});

export const listShortages = defineOperation({
  id: 'inventory.shortages.list',
  summary: 'List open shortages',
  description:
    'Use this to see demand from accepted orders (such as Shopify) that no stock covers yet, per reservation and per variant. A receipt at an eligible location fills shortages oldest first. A shortage limited to a location outside your access is left out.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ variantId: Id.optional() }),
  output: z.object({
    shortages: z.array(
      z.object({
        reservationId: Id,
        parentReservationId: Id.nullable(),
        variantId: Id,
        sku: z.string(),
        shortage: z.string(),
        quantity: z.string(),
        externalRef: z.string().nullable(),
        channel: z.string(),
        createdAt: z.string(),
      }),
    ),
    byVariant: z.array(z.object({ variantId: Id, sku: z.string(), shortage: z.string() })),
  }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'inventory.shortages.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/shortages' },
  mcp: { tool: TOOL, action: 'shortages', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const rows = await ctx.tx.query<{
      reservationId: string;
      parentReservationId: string | null;
      variantId: string;
      sku: string;
      shortage: string;
      quantity: string;
      externalRef: string | null;
      channel: string;
      createdAt: Date;
    }>(
      `select r.id as "reservationId", r.parent_id as "parentReservationId", r.variant_id as "variantId",
         v.sku, r.shortage_quantity::text as shortage, r.quantity::text,
         coalesce(r.external_ref, p.external_ref) as "externalRef", r.channel, r.created_at as "createdAt"
       from reservations r
       join variants v on v.shop_id = r.shop_id and v.id = r.variant_id
       left join reservations p on p.shop_id = r.shop_id and p.id = r.parent_id
       where r.shortage_quantity > 0 and r.status in ('active', 'partially_fulfilled')
         and ($1::uuid is null or r.variant_id = $1)
         and ($2::uuid[] is null or r.location_id is null or exists (
           select 1 from locations l where l.shop_id = r.shop_id and l.id = r.location_id
             and l.path_ids && $2::uuid[]))
       order by r.id
       limit 500`,
      [input.variantId ?? null, ctx.locationScope],
    );
    const totals = new Map<string, { variantId: string; sku: string; shortage: string }>();
    for (const r of rows) {
      const t = totals.get(r.variantId) ?? { variantId: r.variantId, sku: r.sku, shortage: '0' };
      t.shortage = normalize(sumQuantities([t.shortage, r.shortage]));
      totals.set(r.variantId, t);
    }
    return {
      result: {
        shortages: rows.map((r) => ({ ...r, createdAt: iso(r.createdAt)! })),
        byVariant: [...totals.values()],
      },
      audit: {
        targetType: input.variantId ? 'variant' : 'shop',
        targetId: input.variantId ?? ctx.shopId,
        context: { input, count: rows.length },
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const inventoryReservationsOperations = [
  reserveStock,
  releaseReservation,
  fulfillReservation,
  reallocateReservation,
  listReservations,
  listShortages,
] as const;
