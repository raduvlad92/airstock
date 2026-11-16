import { z } from 'zod';
import { compare, normalize } from '../catalog/decimal.ts';
import { NonNegativeDecimal, PositiveDecimal } from '../decimal.ts';
import { errors } from '../errors.ts';
import { defineOperation, type HandlerContext, type HandlerResult } from '../registry.ts';
import { Id } from '../schemas.ts';
import {
  actorColumns,
  applyStockCost,
  assertScale,
  canSeeCosts,
  exactProduct,
  loadStockVariant,
  normalizeCode,
  requireCosts,
} from '../stock/engine.ts';
import { fillShortages } from '../stock/shortages.ts';

// Receipts and stock reads (plan Sections 5.1 and 5.2, ADR 0020). Stock arithmetic happens in
// PostgreSQL numeric or exact decimal strings; see packages/core/src/stock/engine.ts for the lock
// order and the shared helpers.

export const StockCondition = z.enum([
  'sellable',
  'quarantine',
  'damaged',
  'repair',
  'supplier_return',
]);

export const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2027-03-31.')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a real date.');

/** A yes/no query parameter: REST sends it as text, MCP as a boolean. */
export const Flag = z.union([z.boolean(), z.enum(['true', 'false'])]);
export const isSet = (flag: z.infer<typeof Flag> | undefined) => flag === true || flag === 'true';

export const LotCode = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe('A lot or batch code. Codes are unique per variant, ignoring case and extra spaces.');

const PositionSnapshot = z.object({
  positionId: Id,
  variantId: Id,
  locationId: Id,
  condition: StockCondition,
  lotId: Id.nullable(),
  serialId: Id.nullable(),
  onHand: z.string(),
  allocated: z.string(),
});

const ReceiptInput = z.object({
  variantId: Id,
  locationId: Id,
  quantity: PositiveDecimal.describe('Base units, or the number of packs when packId is set.'),
  packId: Id.optional().describe('Receive in one of the variant’s packs, such as a case.'),
  condition: StockCondition.default('sellable'),
  lotCode: LotCode.optional(),
  expiresOn: DateOnly.optional().describe('The lot’s expiry date (YYYY-MM-DD).'),
  producedOn: DateOnly.optional().describe('The lot’s production date (YYYY-MM-DD).'),
  serials: z
    .array(z.string().trim().min(1).max(100))
    .min(1)
    .max(500)
    .optional()
    .describe('Serial-tracked variants: one serial (or certificate number) per unit received.'),
  unitCost: NonNegativeDecimal.optional().describe(
    'Cost per base unit, or per pack with costPer "pack". Needs costs.read.',
  ),
  costPer: z.enum(['base_unit', 'pack']).optional(),
  supplierId: Id.optional(),
  reference: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Supplier or inbound reference, such as a delivery note.'),
  reason: z.string().trim().min(1).max(500).optional(),
});

const ReceiptOutput = z.object({
  operationId: Id,
  variantId: Id,
  quantity: z.string().describe('Base units received.'),
  entered: z
    .object({
      packId: Id,
      packName: z.string(),
      packVersion: z.number(),
      quantity: z.string(),
      factor: z.string(),
    })
    .nullable(),
  lot: z.object({ lotId: Id, code: z.string(), expiresOn: z.string().nullable() }).nullable(),
  serials: z.array(z.object({ serialId: Id, serial: z.string(), positionId: Id })),
  position: PositionSnapshot,
  positions: z.array(PositionSnapshot),
  shortagesFilled: z.array(z.object({ reservationId: Id, quantity: z.string() })),
  costVisible: z.boolean(),
  unitCost: z.string().nullable().describe('The cost per base unit recorded; needs costs.read.'),
  averageCost: z.string().nullable().describe('The moving average after the receipt.'),
});

export const receiveStock = defineOperation({
  id: 'inventory.receipts.create',
  summary: 'Receive stock into a location',
  description:
    'Use this when units arrive: a delivery, opening stock, or a found item. Adds units of a variant to a leaf location in a condition. The quantity is in base units, or in packs when packId is set (for example 3 cases). Lot-tracked variants need lotCode (and expiresOn for lot_expiry); serial-tracked variants need one serial per unit. A unit cost needs costs.read and updates the moving average. Not for reserving or fulfilling orders (use manage_reservations).',
  kind: 'command',
  scope: 'shop',
  input: ReceiptInput,
  output: ReceiptOutput,
  permission: 'inventory.receive',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.receipt.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/receipts', status: 201 },
  mcp: { tool: 'receive_stock', action: 'receive', readOnly: false, destructive: false },
  locations: (input) => [input.locationId],
  handler: (ctx, input) => receiveIntoStock(ctx, input),
});

export type ReceiptInput = z.infer<typeof ReceiptInput>;
export type ReceiptOutput = z.infer<typeof ReceiptOutput>;

export interface ReceiptOptions {
  /**
   * The unit cost comes from a purchase order line, not from the caller, so a member without
   * costs.read (an inventory operator receiving a delivery) may still record it (PRD 6.8).
   */
  costFromPurchaseOrder?: boolean;
  /** Links a lot created or first received here to its purchase order line (G6). */
  purchaseOrderLineId?: string;
}

/**
 * The receipt path (plan Section 5.2): `inventory.receipts.create` and receipts against a purchase
 * order line both run it, inside the caller's transaction.
 */
export async function receiveIntoStock(
  ctx: HandlerContext,
  input: ReceiptInput,
  options: ReceiptOptions = {},
): Promise<HandlerResult<ReceiptOutput>> {
  const variant = await loadStockVariant(ctx.tx, input.variantId);
  // A bundle holds no stock of its own (PRD 4.8); its availability comes from its components.
  if (variant.bundleId) {
    throw errors.unprocessable(
      'bundle_holds_no_stock',
      'This variant is a bundle, which holds no stock of its own. Use its components.',
    );
  }
  if (input.unitCost !== undefined && !options.costFromPurchaseOrder) requireCosts(ctx);
  if (input.costPer === 'pack' && !input.packId) {
    throw errors.unprocessable('pack_required', 'A cost per pack needs packId.');
  }
  // The share lock waits for an archive or move of this location to finish, and holds off
  // one that starts later, so neither can pass its no-stock check while stock arrives.
  const [location] = await ctx.tx.query<{ status: string; has_children: boolean }>(
    `select l.status, exists (select 1 from locations c where c.shop_id = l.shop_id and c.parent_id = l.id) as has_children
     from locations l where l.id = $1 and l.kind = 'storage' for share`,
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

  // Packs convert exactly with the pack's current version (ADR 0019).
  let pack: { id: string; name: string; version: number; factor: string } | null = null;
  if (input.packId) {
    const [row] = await ctx.tx.query<{
      id: string;
      name: string;
      version: number;
      base_quantity: string;
      status: string;
    }>(
      `select id, name, version, base_quantity::text, status from packs
       where id = $1 and variant_id = $2`,
      [input.packId, input.variantId],
    );
    if (!row) throw errors.notFound('Pack');
    if (row.status !== 'active') throw errors.conflict('pack_archived', 'The pack is archived.');
    pack = {
      id: row.id,
      name: row.name,
      version: row.version,
      factor: normalize(row.base_quantity),
    };
  }
  const base = pack
    ? normalize(exactProduct(input.quantity, pack.factor))
    : normalize(input.quantity);
  assertScale(base, variant.quantityScale);

  // Tracking (D4).
  const mode = variant.trackingMode;
  const lotFields = input.lotCode ?? input.expiresOn ?? input.producedOn;
  if (mode === 'none' || mode === 'serial') {
    if (lotFields !== undefined) {
      throw errors.unprocessable('not_lot_tracked', 'This variant is not tracked by lot.');
    }
  } else if (!input.lotCode) {
    throw errors.unprocessable('lot_required', 'This variant is tracked by lot: give lotCode.');
  }
  if (mode !== 'serial' && input.serials) {
    throw errors.unprocessable('not_serial_tracked', 'This variant is not tracked by serial.');
  }
  const serials = (input.serials ?? []).map((s) => ({ serial: s, normalized: normalizeCode(s) }));
  if (mode === 'serial') {
    if (serials.length === 0 || compare(base, String(serials.length)) !== 0) {
      throw errors.unprocessable(
        'serial_count_mismatch',
        'Give one serial for each unit received.',
        { quantity: base, serials: serials.length },
      );
    }
    if (new Set(serials.map((s) => s.normalized)).size !== serials.length) {
      throw errors.unprocessable('duplicate_serial', 'The same serial appears twice.');
    }
  }
  if (variant.oneOfAKind && compare(base, '1') > 0) {
    throw errors.conflict(
      'one_of_a_kind',
      'This item is one of a kind: at most one unit can be in stock.',
    );
  }
  if (input.supplierId) {
    const [supplier] = await ctx.tx.query<{ status: string }>(
      'select status from suppliers where id = $1',
      [input.supplierId],
    );
    if (!supplier) throw errors.notFound('Supplier');
    if (supplier.status !== 'active')
      throw errors.conflict('supplier_archived', 'The supplier is archived.');
  }
  let unitCostBase: string | null = null;
  if (input.unitCost !== undefined) {
    if (input.costPer === 'pack' && pack) {
      const [row] = await ctx.tx.query<{ cost: string }>(
        'select round_half_even($1::numeric / $2::numeric, 6)::text as cost',
        [input.unitCost, pack.factor],
      );
      unitCostBase = normalize(row!.cost);
    } else unitCostBase = normalize(input.unitCost);
  }

  const operationId = ctx.newId();
  await ctx.tx.query(
    `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
       external_ref, reason, supplier_id)
     values (app_shop_id(), $1, 'receipt', $2, $3, $4, $5, $6, $7, $8)`,
    [
      operationId,
      ...actorColumns(ctx),
      input.reference ?? null,
      input.reason ?? null,
      input.supplierId ?? null,
    ],
  );

  // The lot: created on first receipt, before the position that names it.
  let lot: { lotId: string; code: string; expiresOn: string | null } | null = null;
  let lotChanged: Record<string, unknown> | null = null;
  if (input.lotCode) {
    const code = normalizeCode(input.lotCode);
    const [created] = await ctx.tx.query<{ id: string }>(
      `insert into lots (shop_id, id, variant_id, code, code_normalized, expires_on, produced_on,
         supplier_id, created_operation_id, purchase_order_line_id, purchase_order_ref)
       values (app_shop_id(), $1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10)
       on conflict (shop_id, variant_id, code_normalized) do nothing
       returning id`,
      [
        ctx.newId(),
        input.variantId,
        input.lotCode,
        code,
        input.expiresOn ?? null,
        input.producedOn ?? null,
        input.supplierId ?? null,
        operationId,
        options.purchaseOrderLineId ?? null,
        options.purchaseOrderLineId ? (input.reference ?? null) : null,
      ],
    );
    const [row] = await ctx.tx.query<{ id: string; code: string; expires_on: string | null }>(
      `select id, code, to_char(expires_on, 'YYYY-MM-DD') as expires_on from lots
       where variant_id = $1 and code_normalized = $2`,
      [input.variantId, code],
    );
    if (!row) throw errors.internal();
    if (!created && options.purchaseOrderLineId) {
      // A lot first received outside a purchase order learns its order on the first PO receipt.
      await ctx.tx.query(
        `update lots set purchase_order_line_id = $2, purchase_order_ref = coalesce(purchase_order_ref, $3)
         where id = $1 and purchase_order_line_id is null`,
        [row.id, options.purchaseOrderLineId, input.reference ?? null],
      );
    }
    let expiresOn = row.expires_on;
    if (!created && input.expiresOn && input.expiresOn !== expiresOn) {
      if (expiresOn !== null) {
        throw errors.conflict(
          'lot_expiry_mismatch',
          `Lot ${row.code} already has the expiry date ${expiresOn}.`,
          { lotId: row.id, expiresOn },
        );
      }
      await ctx.tx.query(
        `update lots set expires_on = $2::date, updated_at = now(), version = version + 1 where id = $1`,
        [row.id, input.expiresOn],
      );
      lotChanged = { expiresOn: { from: null, to: input.expiresOn } };
      expiresOn = input.expiresOn;
    }
    if (mode === 'lot_expiry' && expiresOn === null) {
      throw errors.unprocessable(
        'expiry_required',
        'This variant is tracked by lot with expiry: give expiresOn.',
      );
    }
    lot = { lotId: row.id, code: row.code, expiresOn };
  }

  // 1. Positions: the upsert locks an existing position; serial positions are new rows.
  const positionIds: string[] = [];
  const serialRows: Array<{ serialId: string; serial: string; positionId: string }> = [];
  if (mode === 'serial') {
    for (const s of serials) {
      serialRows.push({ serialId: ctx.newId(), serial: s.serial, positionId: ctx.newId() });
    }
    await ctx.tx.query(
      `insert into inventory_positions (shop_id, id, variant_id, location_id, condition, serial_id,
         on_hand, received_at)
       select app_shop_id(), x."positionId", $2, $3, $4, x."serialId", 1, now()
       from jsonb_to_recordset($1::jsonb) as x("positionId" uuid, "serialId" uuid)`,
      [JSON.stringify(serialRows), input.variantId, input.locationId, input.condition],
    );
    const inserted = await ctx.tx.query<{ serial_normalized: string }>(
      `insert into serial_units (shop_id, id, variant_id, serial, serial_normalized, status,
         position_id, created_operation_id, last_operation_id)
       select app_shop_id(), x."serialId", $2, x.serial, x.normalized, 'in_stock', x."positionId", $3, $3
       from jsonb_to_recordset($1::jsonb)
         as x("serialId" uuid, serial text, normalized text, "positionId" uuid)
       on conflict (shop_id, variant_id, serial_normalized) do nothing
       returning serial_normalized`,
      [
        JSON.stringify(serialRows.map((r, i) => ({ ...r, normalized: serials[i]!.normalized }))),
        input.variantId,
        operationId,
      ],
    );
    if (inserted.length !== serialRows.length) {
      const fresh = new Set(inserted.map((r) => r.serial_normalized));
      throw errors.conflict(
        'serial_exists',
        'One or more of these serials already exist for this variant.',
        { serials: serials.filter((s) => !fresh.has(s.normalized)).map((s) => s.serial) },
      );
    }
    positionIds.push(...serialRows.map((r) => r.positionId));
  } else {
    const [position] = await ctx.tx.query<{ id: string }>(
      `insert into inventory_positions (shop_id, id, variant_id, location_id, condition, lot_id,
         on_hand, received_at)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6::numeric, now())
       on conflict on constraint inventory_positions_identity
       do update set on_hand = inventory_positions.on_hand + excluded.on_hand,
         received_at = case when inventory_positions.on_hand = 0 then now()
           else inventory_positions.received_at end,
         version = inventory_positions.version + 1, updated_at = now()
       returning id`,
      [ctx.newId(), input.variantId, input.locationId, input.condition, lot?.lotId ?? null, base],
    );
    if (!position) throw errors.internal();
    positionIds.push(position.id);
  }

  // 2. Reservations: open shortages take the new units first (D6).
  const shortage =
    input.condition === 'sellable'
      ? await fillShortages(ctx, input.variantId, positionIds)
      : { fills: [], events: [] };

  // 3. The variant's cost row: owned quantity, moving average, and the one-of-a-kind limit.
  const cost = await applyStockCost(
    ctx,
    input.variantId,
    operationId,
    'receipt',
    base,
    unitCostBase,
  );
  if (variant.oneOfAKind) {
    if (compare(cost.quantityAfter, '1') > 0) {
      throw errors.conflict(
        'one_of_a_kind',
        'This item is one of a kind and already has a unit in stock.',
      );
    }
    // Sold, then bought back or returned: in stock again (D5).
    await ctx.tx.query(
      `update products set status = 'active', updated_at = now(), version = version + 1
       where id = $1 and status = 'sold'`,
      [variant.productId],
    );
  }

  await ctx.tx.query(
    `insert into inventory_entries (shop_id, id, operation_id, position_id, variant_id, location_id,
       delta, lot_id, serial_id, pack_id, pack_version, entered_quantity, conversion_factor,
       unit_cost, cost_basis)
     select app_shop_id(), x.id, $2, x."positionId", $3, $4, x.delta, $5, x."serialId", $6, $7,
       $8::numeric, $9::numeric, $10::numeric, $11
     from jsonb_to_recordset($1::jsonb) as x(id uuid, "positionId" uuid, "serialId" uuid, delta numeric)`,
    [
      JSON.stringify(
        mode === 'serial'
          ? serialRows.map((r) => ({
              id: ctx.newId(),
              positionId: r.positionId,
              serialId: r.serialId,
              delta: '1',
            }))
          : [{ id: ctx.newId(), positionId: positionIds[0], serialId: null, delta: base }],
      ),
      operationId,
      input.variantId,
      input.locationId,
      lot?.lotId ?? null,
      // A serial receipt in packs keeps the pack in its event: each entry is one unit.
      mode === 'serial' ? null : (pack?.id ?? null),
      mode === 'serial' ? null : (pack?.version ?? null),
      mode === 'serial' || !pack ? null : normalize(input.quantity),
      mode === 'serial' || !pack ? null : pack.factor,
      cost.unitCost,
      cost.costBasis,
    ],
  );

  const positions = await ctx.tx.query<{
    id: string;
    lot_id: string | null;
    serial_id: string | null;
    on_hand: string;
    allocated: string;
  }>(
    `select id, lot_id, serial_id, on_hand::text, allocated::text from inventory_positions
     where id = any($1::uuid[]) order by id`,
    [positionIds],
  );
  const snapshots = positions.map((p) => ({
    positionId: p.id,
    variantId: input.variantId,
    locationId: input.locationId,
    condition: input.condition,
    lotId: p.lot_id,
    serialId: p.serial_id,
    onHand: p.on_hand,
    allocated: p.allocated,
  }));
  const visible = canSeeCosts(ctx);
  const entered = pack
    ? {
        packId: pack.id,
        packName: pack.name,
        packVersion: pack.version,
        quantity: normalize(input.quantity),
        factor: pack.factor,
      }
    : null;
  return {
    result: {
      operationId,
      variantId: input.variantId,
      quantity: base,
      entered,
      lot,
      serials: serialRows,
      position: snapshots[0]!,
      positions: snapshots,
      shortagesFilled: shortage.fills.map((f) => ({
        reservationId: f.reservationId,
        quantity: f.quantity,
      })),
      costVisible: visible,
      unitCost: visible ? cost.unitCost : null,
      averageCost: visible ? cost.averageAfter : null,
    },
    audit: {
      targetType: 'variant',
      targetId: input.variantId,
      operationId,
      locationIds: [input.locationId],
      externalRef: input.reference ?? null,
      reason: input.reason ?? null,
      changes: {
        condition: input.condition,
        quantity: base,
        entered,
        lot: lot ? { ...lot, ...(lotChanged ? { changed: lotChanged } : {}) } : null,
        serials: serialRows.map((r) => r.serial),
        positions: snapshots.map((s) => ({ positionId: s.positionId, onHandAfter: s.onHand })),
        supplierId: input.supplierId ?? null,
        shortagesFilled: shortage.fills,
        restricted: {
          permission: 'costs.read',
          fields: {
            unitCost: cost.unitCost,
            costBasis: cost.costBasis,
            averageAfter: cost.averageAfter,
          },
        },
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
    events: shortage.events,
  };
}

/**
 * Stock per position with what is reserved and available right now, from the shared SQL function
 * `stock_positions` (migration 0017): expired claims and expired lots stop counting before any
 * sweeper runs. Shared by stock reads and bundle availability. Parameters:
 * $1 variant IDs, $2 an optional location (with its sub-locations), $3 the caller's location
 * scope, $4 an optional warehouse.
 */
export const POSITION_STOCK_SQL = `
  select sp.position_id as id, sp.variant_id, sp.location_id, sp.location_path as path,
    sp.warehouse_id, sp.condition, sp.on_hand, sp.reserved, sp.available, sp.lot_id, sp.serial_id,
    sp.transfer_id, sp.sellable, sp.lot_expired, sp.expires_on
  from stock_positions($1::uuid[]) sp
  where ($2::uuid is null or sp.path_ids @> array[$2::uuid])
    and ($3::uuid[] is null or sp.path_ids && $3::uuid[])
    and ($4::uuid is null or sp.warehouse_id = $4::uuid)`;

const Totals = z.object({
  onHand: z.string().describe('Physically at locations, in every condition (not in transit).'),
  sellableOnHand: z.string(),
  reserved: z.string(),
  available: z.string().describe('Never below zero; shortages are reported separately.'),
  quarantined: z.string(),
  damaged: z.string(),
  repair: z.string(),
  supplierReturn: z.string(),
  expired: z.string().describe('On hand in lots past their sellable date.'),
  inTransit: z.string(),
  ownedTotal: z.string().describe('On hand plus in transit.'),
  shortage: z
    .string()
    .describe('Demand from accepted orders that no stock covers yet (whole shop).'),
});

export const getAvailability = defineOperation({
  id: 'inventory.availability.get',
  summary: 'Get stock and availability for a variant',
  description:
    'Use this for "how many do I have" questions: on hand, reserved, available, in transit, quarantined, damaged, expired, and shortage for one variant, per location, condition, lot, and serial, with totals. Filter by locationId (with its sub-locations) or warehouseId. Totals cover only the locations you can access; `partial` says when that is a subset. The average cost and value are included with costs.read.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ variantId: Id, locationId: Id.optional(), warehouseId: Id.optional() }),
  output: z.object({
    variantId: Id,
    sku: z.string(),
    trackingMode: z.string(),
    partial: z.boolean(),
    totals: Totals,
    positions: z.array(
      z.object({
        positionId: Id,
        locationId: Id,
        locationPath: z.string(),
        warehouseId: Id.nullable(),
        condition: StockCondition,
        lotId: Id.nullable(),
        lotCode: z.string().nullable(),
        expiresOn: z.string().nullable(),
        lotExpired: z.boolean(),
        serial: z.string().nullable(),
        inTransit: z.boolean(),
        sellable: z.boolean(),
        onHand: z.string(),
        reserved: z.string(),
        available: z.string(),
      }),
    ),
    costVisible: z.boolean(),
    cost: z
      .object({
        averageCost: z.string().nullable(),
        defaultCost: z.string().nullable(),
        ownedQuantity: z.string(),
        value: z.string().nullable(),
      })
      .nullable()
      .describe('Shop-wide moving average and value of owned stock; needs costs.read.'),
  }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'inventory.availability.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/availability' },
  mcp: { tool: 'get_stock', action: 'stock', readOnly: true, destructive: false },
  locations: (input) => (input.locationId ? [input.locationId] : []),
  async handler(ctx, input) {
    const [variant] = await ctx.tx.query<{ sku: string; tracking_mode: string }>(
      'select sku, tracking_mode from variants where id = $1',
      [input.variantId],
    );
    if (!variant) throw errors.notFound('Variant');
    if (input.warehouseId) {
      const [warehouse] = await ctx.tx.query('select 1 from warehouses where id = $1', [
        input.warehouseId,
      ]);
      if (!warehouse) throw errors.notFound('Warehouse');
    }
    const [view] = await ctx.tx.query<{
      totals: z.infer<typeof Totals>;
      positions: Array<{
        positionId: string;
        locationId: string;
        locationPath: string;
        warehouseId: string | null;
        condition: z.infer<typeof StockCondition>;
        lotId: string | null;
        lotCode: string | null;
        expiresOn: string | null;
        lotExpired: boolean;
        serial: string | null;
        inTransit: boolean;
        sellable: boolean;
        onHand: string;
        reserved: string;
        available: string;
      }>;
    }>(
      `with rows as (${POSITION_STOCK_SQL}),
       stocked as (
         select rows.*, lt.code as lot_code, su.serial
         from rows
         left join lots lt on lt.shop_id = app_shop_id() and lt.id = rows.lot_id
         left join serial_units su on su.shop_id = app_shop_id() and su.id = rows.serial_id
         where rows.on_hand > 0 or rows.reserved > 0)
       select
         (select json_build_object(
            'onHand', coalesce(sum(on_hand) filter (where transfer_id is null), 0)::text,
            'sellableOnHand', coalesce(sum(on_hand) filter (where condition = 'sellable'
              and transfer_id is null and not lot_expired), 0)::text,
            'reserved', coalesce(sum(reserved), 0)::text,
            'available', coalesce(sum(available), 0)::text,
            'quarantined', coalesce(sum(on_hand) filter (where condition = 'quarantine' and transfer_id is null), 0)::text,
            'damaged', coalesce(sum(on_hand) filter (where condition = 'damaged' and transfer_id is null), 0)::text,
            'repair', coalesce(sum(on_hand) filter (where condition = 'repair' and transfer_id is null), 0)::text,
            'supplierReturn', coalesce(sum(on_hand) filter (where condition = 'supplier_return' and transfer_id is null), 0)::text,
            'expired', coalesce(sum(on_hand) filter (where lot_expired and transfer_id is null), 0)::text,
            'inTransit', coalesce(sum(on_hand) filter (where transfer_id is not null), 0)::text,
            'ownedTotal', coalesce(sum(on_hand), 0)::text,
            'shortage', (select coalesce(sum(shortage_quantity), 0)::text from reservations
              where variant_id = ($1::uuid[])[1] and status in ('active', 'partially_fulfilled')))
          from rows) as totals,
         coalesce((select json_agg(json_build_object(
            'positionId', id, 'locationId', location_id, 'locationPath', path,
            'warehouseId', warehouse_id, 'condition', condition, 'lotId', lot_id,
            'lotCode', lot_code, 'expiresOn', to_char(expires_on, 'YYYY-MM-DD'),
            'lotExpired', lot_expired, 'serial', serial, 'inTransit', transfer_id is not null,
            'sellable', sellable, 'onHand', on_hand::text, 'reserved', reserved::text,
            'available', available::text)
            order by path, condition, expires_on nulls last, lot_code, serial)
          from stocked), '[]'::json) as positions`,
      [[input.variantId], input.locationId ?? null, ctx.locationScope, input.warehouseId ?? null],
    );
    if (!view) throw errors.internal();
    const visible = canSeeCosts(ctx);
    let cost = null;
    if (visible) {
      const [row] = await ctx.tx.query<{
        average_cost: string | null;
        default_cost: string | null;
        quantity: string;
        value: string | null;
      }>(
        `select average_cost::text, default_cost::text, quantity::text,
           round_half_even(quantity * average_cost, 6)::text as value
         from variant_costs where variant_id = $1`,
        [input.variantId],
      );
      cost = {
        averageCost: row?.average_cost ?? null,
        defaultCost: row?.default_cost ?? null,
        ownedQuantity: row?.quantity ?? '0',
        value: row?.value ?? null,
      };
    }
    return {
      result: {
        variantId: input.variantId,
        sku: variant.sku,
        trackingMode: variant.tracking_mode,
        partial: ctx.locationScope !== null,
        totals: view.totals,
        positions: view.positions,
        costVisible: visible,
        cost,
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

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const inventoryOperations = [receiveStock, getAvailability] as const;
