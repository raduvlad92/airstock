import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { compare, normalize, subtract } from '../catalog/decimal.ts';
import { NonNegativeDecimal, PositiveDecimal } from '../decimal.ts';
import { errors } from '../errors.ts';
import {
  assertDestinationInScope,
  loadPurchaseOrder,
  OPEN_PO_STATUSES,
  PO_STATUSES,
  type PoStatus,
  poNumber,
  statusChangedWebhook,
} from '../purchasing/orders.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id, iso } from '../schemas.ts';
import {
  assertScale,
  canSeeCosts,
  exactProduct,
  loadStockVariant,
  requireCosts,
} from '../stock/engine.ts';
import { DateOnly, LotCode, receiveIntoStock, StockCondition } from './inventory.ts';

// Purchase orders (plan Section 5.8, decision D11, PRD 6.8). A purchase order never changes stock
// by itself: receiving against a line runs the receipt path. Per-line ordered, received, and
// cancelled quantities are in base units and authoritative. Unit costs are restricted to
// costs.read; a receipt carries the line's cost into valuation whoever receives it.

const TOOL = 'manage_purchasing';

// Arguments shared by several actions of manage_purchasing use one schema each (flat MCP schema).
const PurchaseOrderId = Id.describe('The purchase order.');
const ExpectedVersion = z.number().int().min(1).describe('The order version you read.');
const ExpectedOn = DateOnly.nullable()
  .optional()
  .describe('When the delivery is expected (YYYY-MM-DD).');
const Notes = z
  .string()
  .trim()
  .max(5000)
  .nullable()
  .optional()
  .describe('Notes printed on the order.');
const SupplierReference = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .nullable()
  .optional()
  .describe('The supplier’s order or confirmation number.');
const ReceivingLocation = Id.optional().describe(
  'A leaf location. On draft: where deliveries are received by default. On receive: where the units go (defaults to the order’s receiving location).',
);
const Limit = z.coerce.number().int().min(1).max(200).default(50);

const LineInput = z.object({
  variantId: Id,
  packId: Id.nullable()
    .optional()
    .describe(
      'Order in one of the variant’s packs, such as a case. Omitted: the supplier item’s pack; null: base units.',
    ),
  quantity: PositiveDecimal.describe('Packs when the line has a pack, else base units.'),
  unitCost: NonNegativeDecimal.nullable()
    .optional()
    .describe(
      'Cost per pack (or per base unit without a pack). Omitted: the supplier item’s last cost. Needs costs.read.',
    ),
  supplierItemId: Id.optional().describe(
    'The supplier item; found from the variant and pack when omitted.',
  ),
  note: z.string().trim().max(500).nullable().optional(),
});
type LineInput = z.infer<typeof LineInput>;

const Lines = z.array(LineInput).min(1).max(500).describe('The order lines, in order.');

const SendOut = z.object({
  id: Id,
  channel: z.enum(['email', 'manual']),
  recipient: z.string().nullable(),
  status: z.enum(['recorded', 'queued', 'sent', 'failed', 'suppressed']),
  purchaseOrderVersion: z.number(),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

const LineOut = z.object({
  id: Id,
  position: z.number(),
  variantId: Id,
  productId: Id,
  productName: z.string(),
  variantName: z.string().nullable(),
  sku: z.string(),
  packId: Id.nullable(),
  packName: z.string().nullable(),
  packFactor: z.string().nullable().describe('Base units per pack when the line was written.'),
  supplierItemId: Id.nullable(),
  supplierSku: z.string().nullable(),
  quantity: z.string().describe('As ordered: packs when packId is set, else base units.'),
  ordered: z.string().describe('Base units.'),
  received: z.string().describe('Base units received against the line.'),
  cancelled: z.string().describe('Base units cancelled by closing or cancelling.'),
  open: z.string().describe('Base units still on order.'),
  overReceived: z.string().describe('Base units received beyond what was ordered.'),
  unitCost: z.string().nullable().describe('Per pack, or per base unit; needs costs.read.'),
  lineTotal: z.string().nullable(),
  note: z.string().nullable(),
});

export const PurchaseOrderOut = z.object({
  id: Id,
  number: z.string().describe('Such as PO-0007.'),
  status: z.enum(PO_STATUSES),
  supplier: z.object({
    id: Id,
    name: z.string(),
    contactName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    address: z.string().nullable(),
  }),
  warehouse: z.object({ id: Id, name: z.string(), address: z.string().nullable() }),
  location: z.object({ id: Id, path: z.string() }).nullable(),
  currency: z.string(),
  expectedOn: z.string().nullable(),
  supplierReference: z.string().nullable(),
  notes: z.string().nullable(),
  costVisible: z.boolean(),
  total: z.string().nullable().describe('Sum of line totals; needs costs.read.'),
  lines: z.array(LineOut),
  receipts: z.array(
    z.object({
      id: Id,
      lineId: Id,
      operationId: Id,
      quantity: z.string(),
      overReceived: z.string(),
      createdAt: z.string(),
    }),
  ),
  sends: z.array(SendOut),
  shop: z.object({ name: z.string() }),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  receivedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  updatedAt: z.string(),
  version: z.number(),
});

const SummaryOut = z.object({
  id: Id,
  number: z.string(),
  status: z.enum(PO_STATUSES),
  supplierId: Id,
  supplierName: z.string(),
  warehouseId: Id,
  warehouseName: z.string(),
  expectedOn: z.string().nullable(),
  overdue: z.boolean().describe('Expected before today and still open.'),
  lineCount: z.number(),
  ordered: z.string().describe('Base units over all lines.'),
  received: z.string(),
  open: z.string().describe('Base units still on order.'),
  total: z.string().nullable().describe('Needs costs.read.'),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  version: z.number(),
});

// Helpers -----------------------------------------------------------------------------------

interface OrderRow {
  id: string;
  number: number;
  status: PoStatus;
  supplier_id: string;
  warehouse_id: string;
  location_id: string | null;
  version: number;
}

async function lockOrder(tx: Tx, id: string): Promise<OrderRow> {
  const [row] = await tx.query<OrderRow>(
    `select id, number, status, supplier_id, warehouse_id, location_id, version
     from purchase_orders where id = $1 for update`,
    [id],
  );
  if (!row) throw errors.notFound('Purchase order');
  return row;
}

function checkVersion(current: number, expected: number) {
  if (current !== expected) {
    throw errors.conflict(
      'version_conflict',
      'The purchase order changed since you read it. Reload and retry.',
      { currentVersion: current },
    );
  }
}

const orderRef = (o: OrderRow) => ({
  id: o.id,
  number: o.number,
  warehouseId: o.warehouse_id,
  locationId: o.location_id,
  supplierId: o.supplier_id,
  version: o.version,
});

async function checkSupplier(tx: Tx, supplierId: string): Promise<void> {
  const [row] = await tx.query<{ status: string }>('select status from suppliers where id = $1', [
    supplierId,
  ]);
  if (!row) throw errors.notFound('Supplier');
  if (row.status !== 'active')
    throw errors.conflict('supplier_archived', 'The supplier is archived.');
}

async function checkDestination(
  ctx: HandlerContext,
  warehouseId: string,
  locationId: string | null,
): Promise<void> {
  const [warehouse] = await ctx.tx.query<{ archived: boolean }>(
    'select archived_at is not null as archived from warehouses where id = $1',
    [warehouseId],
  );
  if (!warehouse) throw errors.notFound('Warehouse');
  if (warehouse.archived) throw errors.conflict('warehouse_archived', 'The warehouse is archived.');
  if (locationId) {
    const [location] = await ctx.tx.query<{ warehouse_id: string | null; status: string }>(
      `select warehouse_id, status from locations where id = $1 and kind = 'storage'`,
      [locationId],
    );
    if (!location) throw errors.notFound('Location');
    if (location.warehouse_id !== warehouseId) {
      throw errors.unprocessable(
        'location_not_in_warehouse',
        'The receiving location must be inside the destination warehouse.',
      );
    }
    if (location.status !== 'active')
      throw errors.conflict('location_archived', 'The location is archived.');
  }
  await assertDestinationInScope(ctx, warehouseId, locationId);
}

interface ResolvedLine {
  variantId: string;
  packId: string | null;
  packFactor: string | null;
  packVersion: number | null;
  supplierItemId: string | null;
  supplierSku: string | null;
  quantity: string;
  ordered: string;
  unitCost: string | null;
  note: string | null;
}

/**
 * Checks each line and fills its defaults from the supplier item (PRD 6.8): the pack it is sold in,
 * its supplier SKU, and its last cost, converted exactly when the line uses another pack.
 */
async function resolveLines(
  ctx: HandlerContext,
  supplierId: string,
  lines: LineInput[],
): Promise<ResolvedLine[]> {
  if (lines.some((l) => l.unitCost !== undefined && l.unitCost !== null)) requireCosts(ctx);
  const out: ResolvedLine[] = [];
  for (const [index, line] of lines.entries()) {
    const at = (message: string, code = 'invalid_line') =>
      errors.unprocessable(code, `Line ${index + 1}: ${message}`, { line: index + 1 });
    const variant = await loadStockVariant(ctx.tx, line.variantId).catch((error: unknown) => {
      throw error instanceof Error &&
        'status' in error &&
        (error as { status: number }).status === 404
        ? at('the variant was not found.', 'not_found')
        : error;
    });
    if (variant.bundleId) {
      throw at(
        'this variant is a bundle, which holds no stock of its own. Order its components.',
        'bundle_holds_no_stock',
      );
    }
    const [item] = await ctx.tx.query<{
      id: string;
      supplier_id: string;
      variant_id: string;
      pack_id: string | null;
      supplier_sku: string | null;
      last_cost: string | null;
      item_factor: string | null;
      status: string;
    }>(
      line.supplierItemId
        ? `select i.id, i.supplier_id, i.variant_id, i.pack_id, i.supplier_sku, i.last_cost::text,
             k.base_quantity::text as item_factor, i.status
           from supplier_items i left join packs k on k.shop_id = i.shop_id and k.id = i.pack_id
           where i.id = $1`
        : `select i.id, i.supplier_id, i.variant_id, i.pack_id, i.supplier_sku, i.last_cost::text,
             k.base_quantity::text as item_factor, i.status
           from supplier_items i left join packs k on k.shop_id = i.shop_id and k.id = i.pack_id
           where i.supplier_id = $1 and i.variant_id = $2 and i.status = 'active'
           order by ($3::uuid is not null and i.pack_id = $3) desc, ($3::uuid is null and i.pack_id is null) desc,
             i.preferred desc, i.id
           limit 1`,
      line.supplierItemId
        ? [line.supplierItemId]
        : [supplierId, line.variantId, line.packId ?? null],
    );
    if (line.supplierItemId) {
      if (!item) throw at('the supplier item was not found.', 'not_found');
      if (item.supplier_id !== supplierId || item.variant_id !== line.variantId) {
        throw at('the supplier item belongs to another supplier or variant.');
      }
      if (item.status !== 'active') throw at('the supplier item is archived.');
    }
    // Pack: as given; omitted means the supplier item's pack; null means base units.
    const packId = line.packId === undefined ? (item?.pack_id ?? null) : line.packId;
    let pack: { factor: string; version: number } | null = null;
    if (packId) {
      const [row] = await ctx.tx.query<{ base_quantity: string; version: number; status: string }>(
        'select base_quantity::text, version, status from packs where id = $1 and variant_id = $2',
        [packId, line.variantId],
      );
      if (!row) throw at('the pack was not found for this variant.', 'not_found');
      if (row.status !== 'active') throw at('the pack is archived.', 'pack_archived');
      pack = { factor: normalize(row.base_quantity), version: row.version };
    }
    const quantity = normalize(line.quantity);
    const ordered = normalize(pack ? exactProduct(quantity, pack.factor) : quantity);
    assertScale(ordered, variant.quantityScale, `Line ${index + 1}`);
    let unitCost: string | null = line.unitCost === undefined ? null : line.unitCost;
    if (line.unitCost === undefined && item?.last_cost != null) {
      // The supplier's last cost is per its pack (or base unit); convert exactly to this line's.
      const [row] = await ctx.tx.query<{ cost: string }>(
        `select round_half_even($1::numeric / coalesce($2::numeric, 1) * coalesce($3::numeric, 1), 6)::text as cost`,
        [item.last_cost, item.item_factor, pack?.factor ?? null],
      );
      unitCost = row!.cost;
    }
    out.push({
      variantId: line.variantId,
      packId,
      packFactor: pack?.factor ?? null,
      packVersion: pack?.version ?? null,
      supplierItemId: item?.id ?? null,
      supplierSku: item?.supplier_sku ?? null,
      quantity,
      ordered,
      unitCost: unitCost === null ? null : normalize(unitCost),
      note: line.note || null,
    });
  }
  return out;
}

async function insertLines(tx: Tx, orderId: string, lines: ResolvedLine[], newId: () => string) {
  await tx.query(
    `insert into purchase_order_lines (shop_id, id, purchase_order_id, position, variant_id, pack_id,
       pack_factor, pack_version, supplier_item_id, supplier_sku, quantity, ordered, unit_cost, note)
     select app_shop_id(), x.id, $2, x.position, x."variantId", x."packId", x."packFactor",
       x."packVersion", x."supplierItemId", x."supplierSku", x.quantity, x.ordered, x."unitCost", x.note
     from jsonb_to_recordset($1::jsonb) as x(id uuid, position int, "variantId" uuid, "packId" uuid,
       "packFactor" numeric, "packVersion" int, "supplierItemId" uuid, "supplierSku" text,
       quantity numeric, ordered numeric, "unitCost" numeric, note text)`,
    [JSON.stringify(lines.map((l, position) => ({ ...l, id: newId(), position }))), orderId],
  );
}

/** What the activity history records for lines; costs are restricted (costs.read). */
function lineChanges(lines: ResolvedLine[]) {
  return {
    lines: lines.map((l) => ({
      variantId: l.variantId,
      packId: l.packId,
      quantity: l.quantity,
      ordered: l.ordered,
      supplierItemId: l.supplierItemId,
    })),
    restricted: {
      permission: 'costs.read',
      fields: { unitCosts: lines.map((l) => l.unitCost) },
    },
  };
}

// Reads -------------------------------------------------------------------------------------

export const listPurchaseOrders = defineOperation({
  id: 'purchasing.orders.list',
  summary: 'List purchase orders',
  description:
    'Use this to find purchase orders: by status (open means sent or partially received), supplier, variant, or overdue. Newest first, with what is still on order. Totals need costs.read. Not for stock levels (use get_stock).',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    status: z
      .enum([...PO_STATUSES, 'open'])
      .optional()
      .describe('A state, or "open" for sent and partially received orders.'),
    supplierId: Id.optional(),
    variantId: Id.optional().describe('Only orders with a line for this variant.'),
    overdue: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .optional()
      .describe('Only open orders expected before today.'),
    limit: Limit,
    after: Id.optional().describe('Cursor from the previous page.'),
  }),
  output: z.object({ purchaseOrders: z.array(SummaryOut), nextCursor: z.string().nullable() }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'purchasing.orders.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/purchase-orders' },
  mcp: { tool: TOOL, action: 'list', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const overdue = input.overdue === true || input.overdue === 'true';
    const costs = canSeeCosts(ctx);
    const rows = await ctx.tx.query<{
      id: string;
      number: number;
      status: PoStatus;
      supplier_id: string;
      supplier_name: string;
      warehouse_id: string;
      warehouse_name: string;
      expected_on: string | null;
      overdue: boolean;
      line_count: number;
      ordered: string;
      received: string;
      open: string;
      total: string | null;
      created_at: Date;
      sent_at: Date | null;
      version: number;
    }>(
      `select o.id, o.number, o.status, o.supplier_id, s.name as supplier_name, o.warehouse_id,
         w.name as warehouse_name, to_char(o.expected_on, 'YYYY-MM-DD') as expected_on,
         (o.status in ('sent', 'partially_received') and o.expected_on < (now() at time zone sh.timezone)::date) as overdue,
         t.line_count, t.ordered::text, t.received::text, t.open::text, t.total::text,
         o.created_at, o.sent_at, o.version
       from purchase_orders o
       join suppliers s on s.shop_id = o.shop_id and s.id = o.supplier_id
       join warehouses w on w.shop_id = o.shop_id and w.id = o.warehouse_id
       join shops sh on sh.id = o.shop_id
       cross join lateral (
         select count(*)::int as line_count, coalesce(sum(l.ordered), 0) as ordered,
           coalesce(sum(l.received), 0) as received,
           coalesce(sum(case when o.status in ('sent', 'partially_received')
             then greatest(l.ordered - l.received - l.cancelled, 0) else 0 end), 0) as open,
           case when count(*) = count(l.unit_cost) and count(*) > 0
             then sum(round_half_even(l.quantity * l.unit_cost, 6)) end as total
         from purchase_order_lines l
         where l.shop_id = o.shop_id and l.purchase_order_id = o.id) t
       where ($1::text is null or o.status = $1 or ($1 = 'open' and o.status in ('sent', 'partially_received')))
         and ($2::uuid is null or o.supplier_id = $2)
         and ($3::uuid is null or exists (select 1 from purchase_order_lines l
           where l.shop_id = o.shop_id and l.purchase_order_id = o.id and l.variant_id = $3))
         and (not $4 or (o.status in ('sent', 'partially_received')
           and o.expected_on < (now() at time zone sh.timezone)::date))
         and ($5::uuid[] is null or o.warehouse_id = any($5::uuid[]) or exists (
           select 1 from locations l where l.id = o.location_id and l.path_ids && $5::uuid[]))
         and ($6::uuid is null or o.number < (select c.number from purchase_orders c where c.id = $6))
       order by o.number desc
       limit $7`,
      [
        input.status ?? null,
        input.supplierId ?? null,
        input.variantId ?? null,
        overdue,
        ctx.locationScope,
        input.after ?? null,
        input.limit + 1,
      ],
    );
    const page = rows.slice(0, input.limit);
    return {
      result: {
        purchaseOrders: page.map((r) => ({
          id: r.id,
          number: poNumber(r.number),
          status: r.status,
          supplierId: r.supplier_id,
          supplierName: r.supplier_name,
          warehouseId: r.warehouse_id,
          warehouseName: r.warehouse_name,
          expectedOn: r.expected_on,
          overdue: r.overdue,
          lineCount: r.line_count,
          ordered: r.ordered,
          received: r.received,
          open: r.open,
          total: costs ? r.total : null,
          createdAt: iso(r.created_at)!,
          sentAt: iso(r.sent_at),
          version: r.version,
        })),
        nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
      },
      audit: { targetType: 'purchase_order', targetId: 'list' },
    };
  },
});

export const getPurchaseOrder = defineOperation({
  id: 'purchasing.orders.get',
  summary: 'Get a purchase order',
  description:
    'Use this to see one purchase order: supplier, destination, state, and each line with ordered, received, cancelled, and still-open quantities in base units, the receipts against it, and the send log. Unit costs and totals need costs.read.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ purchaseOrderId: PurchaseOrderId }),
  output: PurchaseOrderOut,
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'purchasing.order.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/purchase-orders/{purchaseOrderId}' },
  mcp: { tool: TOOL, action: 'get', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const costs = canSeeCosts(ctx);
    const order = await loadPurchaseOrder(ctx.tx, input.purchaseOrderId, costs);
    await assertDestinationInScope(ctx, order.warehouse.id, order.location?.id ?? null);
    return {
      result: order,
      audit: {
        targetType: 'purchase_order',
        targetId: order.id,
        context: { costsShown: costs },
      },
    };
  },
});

// Commands ----------------------------------------------------------------------------------

export const draftPurchaseOrder = defineOperation({
  id: 'purchasing.orders.create',
  summary: 'Draft a purchase order',
  description:
    'Use this to start a purchase order to one supplier for one destination warehouse. Each line names a variant and a quantity; the pack, supplier SKU, and unit cost default from the supplier item. The draft changes no stock and counts as on order only once it is sent. To draft from low stock, call suggest_from_low_stock first and draft what the person approves.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    supplierId: Id,
    warehouseId: Id.describe('The destination warehouse; on order counts here.'),
    locationId: ReceivingLocation,
    expectedOn: ExpectedOn,
    supplierReference: SupplierReference,
    notes: Notes,
    lines: Lines,
  }),
  output: PurchaseOrderOut,
  permission: 'purchasing.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'purchasing.order.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/purchase-orders', status: 201 },
  mcp: { tool: TOOL, action: 'draft', readOnly: false, destructive: false },
  async handler(ctx, input) {
    await checkSupplier(ctx.tx, input.supplierId);
    await checkDestination(ctx, input.warehouseId, input.locationId ?? null);
    const lines = await resolveLines(ctx, input.supplierId, input.lines);
    const [{ number } = { number: 0 }] = await ctx.tx.query<{ number: number }>(
      `insert into purchase_order_counters (shop_id, last_number) values (app_shop_id(), 1)
       on conflict (shop_id) do update set last_number = purchase_order_counters.last_number + 1
       returning last_number as number`,
    );
    const id = ctx.newId();
    await ctx.tx.query(
      `insert into purchase_orders (shop_id, id, number, supplier_id, warehouse_id, location_id,
         currency, expected_on, supplier_reference, notes, created_by_type, created_by_id)
       select app_shop_id(), $1, $2, $3, $4, $5, s.currency, $6::date, $7, $8, $9, $10
       from shops s where s.id = app_shop_id()`,
      [
        id,
        number,
        input.supplierId,
        input.warehouseId,
        input.locationId ?? null,
        input.expectedOn ?? null,
        input.supplierReference ?? null,
        input.notes || null,
        ctx.caller.kind,
        ctx.caller.id,
      ],
    );
    await insertLines(ctx.tx, id, lines, ctx.newId);
    const order = await loadPurchaseOrder(ctx.tx, id, canSeeCosts(ctx));
    return {
      result: order,
      audit: {
        targetType: 'purchase_order',
        targetId: id,
        externalRef: order.number,
        changes: {
          number: order.number,
          supplierId: input.supplierId,
          warehouseId: input.warehouseId,
          locationId: input.locationId ?? null,
          expectedOn: input.expectedOn ?? null,
          ...lineChanges(lines),
        },
      },
      webhooks: [
        await statusChangedWebhook(
          ctx.tx,
          {
            id,
            number,
            warehouseId: input.warehouseId,
            locationId: input.locationId ?? null,
            supplierId: input.supplierId,
            version: 1,
          },
          null,
          'draft',
        ),
      ],
    };
  },
});

export const updatePurchaseOrder = defineOperation({
  id: 'purchasing.orders.update',
  summary: 'Change a purchase order',
  description:
    'Use this to edit a purchase order. A draft can change everything, and lines replace the whole list. After sending, only expectedOn, supplierReference, and notes change; to order more, draft another order. Pass the version you read as expectedVersion.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    purchaseOrderId: PurchaseOrderId,
    expectedVersion: ExpectedVersion,
    supplierId: Id.optional(),
    warehouseId: Id.optional(),
    locationId: ReceivingLocation.nullable(),
    expectedOn: ExpectedOn,
    supplierReference: SupplierReference,
    notes: Notes,
    lines: Lines.optional(),
  }),
  output: PurchaseOrderOut,
  permission: 'purchasing.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'purchasing.order.updated' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/purchase-orders/{purchaseOrderId}' },
  mcp: { tool: TOOL, action: 'update', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const order = await lockOrder(ctx.tx, input.purchaseOrderId);
    await assertDestinationInScope(ctx, order.warehouse_id, order.location_id);
    checkVersion(order.version, input.expectedVersion);
    const draft = order.status === 'draft';
    if (order.status === 'closed' || order.status === 'cancelled') {
      throw errors.conflict('purchase_order_finished', `The order is ${order.status}.`);
    }
    const draftOnly = ['supplierId', 'warehouseId', 'locationId', 'lines'] as const;
    const blocked = draftOnly.filter((k) => input[k] !== undefined);
    if (!draft && blocked.length > 0) {
      throw errors.conflict(
        'purchase_order_sent',
        'After sending, only the expected date, supplier reference, and notes can change.',
        { fields: blocked },
      );
    }
    const supplierId = input.supplierId ?? order.supplier_id;
    const warehouseId = input.warehouseId ?? order.warehouse_id;
    const locationId =
      input.locationId === undefined
        ? warehouseId === order.warehouse_id
          ? order.location_id
          : null
        : input.locationId;
    if (input.supplierId) await checkSupplier(ctx.tx, supplierId);
    if (input.warehouseId || input.locationId !== undefined)
      await checkDestination(ctx, warehouseId, locationId);
    const changes: Record<string, unknown> = {};
    let lines: ResolvedLine[] | null = null;
    if (input.lines) {
      lines = await resolveLines(ctx, supplierId, input.lines);
      await ctx.tx.query('delete from purchase_order_lines where purchase_order_id = $1', [
        order.id,
      ]);
      await insertLines(ctx.tx, order.id, lines, ctx.newId);
      Object.assign(changes, lineChanges(lines));
    } else if (input.supplierId && input.supplierId !== order.supplier_id) {
      throw errors.unprocessable(
        'lines_required',
        'Changing the supplier needs the lines again, so their supplier items and costs match.',
      );
    }
    for (const key of [
      'supplierId',
      'warehouseId',
      'locationId',
      'expectedOn',
      'supplierReference',
      'notes',
    ] as const) {
      if (input[key] !== undefined) changes[key] = input[key];
    }
    await ctx.tx.query(
      `update purchase_orders set supplier_id = $2, warehouse_id = $3, location_id = $4,
         expected_on = case when $5 then $6::date else expected_on end,
         supplier_reference = case when $7 then $8 else supplier_reference end,
         notes = case when $9 then $10 else notes end,
         version = version + 1, updated_at = now()
       where id = $1`,
      [
        order.id,
        supplierId,
        warehouseId,
        locationId,
        input.expectedOn !== undefined,
        input.expectedOn ?? null,
        input.supplierReference !== undefined,
        input.supplierReference ?? null,
        input.notes !== undefined,
        input.notes || null,
      ],
    );
    const result = await loadPurchaseOrder(ctx.tx, order.id, canSeeCosts(ctx));
    return {
      result,
      audit: {
        targetType: 'purchase_order',
        targetId: order.id,
        externalRef: result.number,
        changes,
      },
    };
  },
});

export const sendPurchaseOrder = defineOperation({
  id: 'purchasing.orders.send',
  summary: 'Send a purchase order',
  description:
    'Use this when the order goes to the supplier. With email true (the default), Airstock emails the order as a PDF to the supplier’s address (or emailTo); with email false, it records that the order was sent another way. A draft becomes sent and starts counting as on order. Sending again re-sends the current order. Every send is logged.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    purchaseOrderId: PurchaseOrderId,
    email: z
      .boolean()
      .default(true)
      .describe('Email the PDF to the supplier; false records a send made outside Airstock.'),
    emailTo: z
      .string()
      .trim()
      .max(320)
      .regex(/^[^\s@]+@[^\s@]+$/, 'Use an email address.')
      .optional()
      .describe('Send to this address instead of the supplier’s.'),
    message: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .describe('A short note at the top of the email.'),
  }),
  output: z.object({ purchaseOrder: PurchaseOrderOut, send: SendOut }),
  permission: 'purchasing.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'purchasing.order.sent' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/purchase-orders/{purchaseOrderId}/send' },
  mcp: { tool: TOOL, action: 'send', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const order = await lockOrder(ctx.tx, input.purchaseOrderId);
    await assertDestinationInScope(ctx, order.warehouse_id, order.location_id);
    if (!['draft', 'sent', 'partially_received'].includes(order.status)) {
      throw errors.conflict(
        'purchase_order_finished',
        `The order is ${order.status.replace('_', ' ')}.`,
      );
    }
    let recipient: string | null = null;
    if (input.email) {
      const [supplier] = await ctx.tx.query<{ email: string | null }>(
        'select email from suppliers where id = $1',
        [order.supplier_id],
      );
      recipient = input.emailTo ?? supplier?.email ?? null;
      if (!recipient) {
        throw errors.unprocessable(
          'supplier_email_missing',
          'The supplier has no email address. Add one, give emailTo, or send with email false.',
        );
      }
    }
    const from = order.status;
    const to: PoStatus = from === 'draft' ? 'sent' : from;
    const version = order.version + 1;
    await ctx.tx.query(
      `update purchase_orders set status = $2, sent_at = coalesce(sent_at, now()),
         version = version + 1, updated_at = now() where id = $1`,
      [order.id, to],
    );
    const sendId = ctx.newId();
    await ctx.tx.query(
      `insert into po_sends (shop_id, id, purchase_order_id, purchase_order_version, channel,
         recipient, status, message, actor_type, actor_id)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        sendId,
        order.id,
        version,
        input.email ? 'email' : 'manual',
        recipient,
        input.email ? 'queued' : 'recorded',
        input.message || null,
        ctx.caller.kind,
        ctx.caller.id,
      ],
    );
    const result = await loadPurchaseOrder(ctx.tx, order.id, canSeeCosts(ctx));
    const send = result.sends.find((s) => s.id === sendId)!;
    return {
      result: { purchaseOrder: result, send },
      audit: {
        targetType: 'purchase_order',
        targetId: order.id,
        externalRef: result.number,
        changes: {
          status: { from, to },
          send: { id: sendId, channel: send.channel, recipient },
        },
      },
      outbox: input.email
        ? [{ topic: 'email.purchase_order', payload: { sendId, purchaseOrderId: order.id } }]
        : [],
      // Sending starts on order: low-stock alerts for these variants may resolve (PRD 6.9).
      ...(to !== from
        ? { alertCheck: { variantIds: [...new Set(result.lines.map((l) => l.variantId))] } }
        : {}),
      webhooks:
        to !== from
          ? [await statusChangedWebhook(ctx.tx, { ...orderRef(order), version }, from, to)]
          : [],
    };
  },
});

export const receivePurchaseOrderLine = defineOperation({
  id: 'purchasing.orders.receive',
  summary: 'Receive against a purchase order line',
  description:
    'Use this when goods from a purchase order arrive. Receives into a leaf location through the normal receipt: quantity is in the line’s pack (such as cases) unless inBaseUnits is true, with lotCode and expiresOn or serials when the variant is tracked. The line’s unit cost goes into the moving average. A partial receipt keeps the rest on order; receiving more than is open is refused unless confirmOverReceipt is true, and is then recorded as an over-receipt. Not for deliveries without an order (use receive_stock).',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    purchaseOrderId: PurchaseOrderId,
    lineId: Id.describe('The purchase order line.'),
    quantity: PositiveDecimal.describe(
      'Packs of the line’s pack, or base units when the line has none or inBaseUnits is true.',
    ),
    inBaseUnits: z.boolean().optional().describe('The quantity is in base units, not packs.'),
    locationId: ReceivingLocation,
    condition: StockCondition.default('sellable'),
    lotCode: LotCode.optional(),
    expiresOn: DateOnly.optional().describe('The lot’s expiry date (YYYY-MM-DD).'),
    producedOn: DateOnly.optional().describe('The lot’s production date (YYYY-MM-DD).'),
    serials: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(500)
      .optional()
      .describe('Serial-tracked variants: one serial per unit received.'),
    confirmOverReceipt: z
      .boolean()
      .optional()
      .describe('Receive more than is still open; recorded as an over-receipt.'),
  }),
  output: z.object({
    purchaseOrder: PurchaseOrderOut,
    receipt: z.object({
      operationId: Id,
      lineId: Id,
      quantity: z.string().describe('Base units received.'),
      overReceived: z.string().describe('Base units beyond what the line still had open.'),
      locationId: Id,
      lot: z.object({ lotId: Id, code: z.string(), expiresOn: z.string().nullable() }).nullable(),
      serials: z.array(z.object({ serialId: Id, serial: z.string(), positionId: Id })),
      shortagesFilled: z.array(z.object({ reservationId: Id, quantity: z.string() })),
      averageCost: z.string().nullable().describe('After the receipt; needs costs.read.'),
    }),
  }),
  permission: 'inventory.receive',
  connectionScope: 'inventory:write',
  audit: { action: 'purchasing.order.received' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/purchase-orders/{purchaseOrderId}/receive' },
  mcp: { tool: TOOL, action: 'receive', readOnly: false, destructive: false },
  locations: async (input, tx) => {
    if (input.locationId) return [input.locationId];
    const [row] = await tx.query<{ location_id: string | null }>(
      'select location_id from purchase_orders where id = $1',
      [input.purchaseOrderId],
    );
    return row?.location_id ? [row.location_id] : [];
  },
  async handler(ctx, input) {
    // Validate before touching stock; the order and line are locked after the receipt, which
    // keeps the lock order (positions first), and checked again there.
    const [line] = await ctx.tx.query<{
      purchase_order_id: string;
      status: PoStatus;
      number: number;
      supplier_id: string;
      warehouse_id: string;
      location_id: string | null;
      variant_id: string;
      pack_id: string | null;
      pack_factor: string | null;
      pack_version: number | null;
      ordered: string;
      received: string;
      cancelled: string;
      unit_cost_base: string | null;
    }>(
      `select l.purchase_order_id, o.status, o.number, o.supplier_id, o.warehouse_id, o.location_id,
         l.variant_id, l.pack_id, l.pack_factor::text, l.pack_version, l.ordered::text,
         l.received::text, l.cancelled::text,
         round_half_even(l.unit_cost / coalesce(l.pack_factor, 1), 6)::text as unit_cost_base
       from purchase_order_lines l
       join purchase_orders o on o.shop_id = l.shop_id and o.id = l.purchase_order_id
       where l.id = $1 and l.purchase_order_id = $2`,
      [input.lineId, input.purchaseOrderId],
    );
    if (!line) throw errors.notFound('Purchase order line');
    // Receiving changes the order, so it needs the order's destination in scope like every other
    // command on it (ADR 0027); the pipeline only checked the receiving location.
    await assertDestinationInScope(ctx, line.warehouse_id, line.location_id);
    if (!OPEN_PO_STATUSES.includes(line.status)) {
      throw errors.conflict(
        'purchase_order_not_open',
        line.status === 'draft'
          ? 'Send the order (or record it as sent) before receiving against it.'
          : `The order is ${line.status.replace('_', ' ')}; nothing is open to receive.`,
      );
    }
    const locationId = input.locationId ?? line.location_id;
    if (!locationId) {
      throw errors.validation([
        { path: 'locationId', message: 'Give the location the units go to.' },
      ]);
    }
    const [where] = await ctx.tx.query<{ warehouse_id: string | null }>(
      'select warehouse_id from locations where id = $1',
      [locationId],
    );
    if (!where) throw errors.notFound('Location');
    if (where.warehouse_id !== line.warehouse_id) {
      throw errors.unprocessable(
        'location_not_in_warehouse',
        'The receiving location must be inside the order’s destination warehouse.',
      );
    }
    const inPacks = Boolean(line.pack_id) && !input.inBaseUnits;
    const receipt = await receiveIntoStock(
      ctx,
      {
        variantId: line.variant_id,
        locationId,
        quantity: input.quantity,
        ...(inPacks ? { packId: line.pack_id! } : {}),
        condition: input.condition,
        ...(input.lotCode ? { lotCode: input.lotCode } : {}),
        ...(input.expiresOn ? { expiresOn: input.expiresOn } : {}),
        ...(input.producedOn ? { producedOn: input.producedOn } : {}),
        ...(input.serials ? { serials: input.serials } : {}),
        ...(line.unit_cost_base !== null
          ? { unitCost: line.unit_cost_base, costPer: 'base_unit' as const }
          : {}),
        supplierId: line.supplier_id,
        reference: poNumber(line.number),
      },
      {
        costFromPurchaseOrder: true,
        purchaseOrderLineId: input.lineId,
        // Packs convert at the size the line was ordered in, not the pack's current size.
        ...(inPacks && line.pack_factor !== null && line.pack_version !== null
          ? { orderedPack: { factor: line.pack_factor, version: line.pack_version } }
          : {}),
      },
    );
    const base = receipt.result.quantity;

    // Now the order, then the line (everything else in the lock order), and the checks again.
    const order = await lockOrder(ctx.tx, input.purchaseOrderId);
    const [locked] = await ctx.tx.query<{ ordered: string; received: string; cancelled: string }>(
      `select ordered::text, received::text, cancelled::text from purchase_order_lines
       where id = $1 for update`,
      [input.lineId],
    );
    if (!locked) throw errors.internal();
    if (!OPEN_PO_STATUSES.includes(order.status)) {
      throw errors.conflict(
        'purchase_order_not_open',
        `The order is ${order.status.replace('_', ' ')}.`,
      );
    }
    const openBefore = subtract(subtract(locked.ordered, locked.received), locked.cancelled);
    const open = compare(openBefore, '0') > 0 ? openBefore : '0';
    const over = compare(base, open) > 0 ? normalize(subtract(base, open)) : '0';
    if (over !== '0' && !input.confirmOverReceipt) {
      throw errors.conflict(
        'over_receipt',
        `This receives ${over} more than the line still has open (${normalize(open)}). Confirm the over-receipt to record it.`,
        { open: normalize(open), receiving: base, over },
      );
    }
    await ctx.tx.query(
      'update purchase_order_lines set received = received + $2::numeric where id = $1',
      [input.lineId, base],
    );
    await ctx.tx.query(
      `insert into purchase_order_receipts (shop_id, id, purchase_order_id, line_id, operation_id,
         quantity, over_received)
       values (app_shop_id(), $1, $2, $3, $4, $5::numeric, $6::numeric)`,
      [ctx.newId(), order.id, input.lineId, receipt.result.operationId, base, over],
    );
    const [state] = await ctx.tx.query<{ complete: boolean }>(
      `select bool_and(received + cancelled >= ordered) as complete from purchase_order_lines
       where purchase_order_id = $1`,
      [order.id],
    );
    const to: PoStatus = state?.complete ? 'received' : 'partially_received';
    await ctx.tx.query(
      `update purchase_orders set status = $2,
         received_at = case when $2 = 'received' then now() else received_at end,
         version = version + 1, updated_at = now()
       where id = $1`,
      [order.id, to],
    );
    const result = await loadPurchaseOrder(ctx.tx, order.id, canSeeCosts(ctx));
    const receiptEvent = ctx.event({
      action: 'inventory.receipt.created',
      outcome: 'succeeded',
      target_type: receipt.audit.targetType,
      target_id: receipt.audit.targetId,
      operation_id: receipt.audit.operationId ?? null,
      location_ids: receipt.audit.locationIds ?? null,
      external_ref: receipt.audit.externalRef ?? null,
      changes: receipt.audit.changes ?? null,
      context: { purchaseOrderId: order.id, lineId: input.lineId },
    });
    return {
      result: {
        purchaseOrder: result,
        receipt: {
          operationId: receipt.result.operationId,
          lineId: input.lineId,
          quantity: base,
          overReceived: over,
          locationId,
          lot: receipt.result.lot,
          serials: receipt.result.serials,
          shortagesFilled: receipt.result.shortagesFilled,
          averageCost: receipt.result.averageCost,
        },
      },
      audit: {
        targetType: 'purchase_order',
        targetId: order.id,
        operationId: receipt.result.operationId,
        locationIds: [locationId],
        externalRef: result.number,
        changes: {
          lineId: input.lineId,
          variantId: line.variant_id,
          quantity: base,
          entered: receipt.result.entered,
          overReceived: over,
          status: { from: order.status, to },
          restricted: {
            permission: 'costs.read',
            fields: { unitCost: line.unit_cost_base },
          },
        },
      },
      outbox: receipt.outbox ?? [],
      // On order went down: check the low-stock rule even when the units arrived unsellable,
      // which announces no availability change (PRD 6.9: available plus on order).
      alertCheck: { variantIds: [line.variant_id] },
      events: [receiptEvent, ...(receipt.events ?? [])],
      webhooks:
        to !== order.status
          ? [
              await statusChangedWebhook(
                ctx.tx,
                { ...orderRef(order), version: order.version + 1 },
                order.status,
                to,
              ),
            ]
          : [],
    };
  },
});

export const closePurchaseOrder = defineOperation({
  id: 'purchasing.orders.close',
  summary: 'Close a purchase order',
  description:
    'Use this when no more goods are coming for an order that was sent: anything still open on its lines is cancelled explicitly and stops counting as on order. What was received stays. A draft is cancelled instead.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    purchaseOrderId: PurchaseOrderId,
    expectedVersion: ExpectedVersion.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  output: z.object({
    purchaseOrder: PurchaseOrderOut,
    cancelled: z
      .array(z.object({ lineId: Id, quantity: z.string() }))
      .describe('The open remainder each line cancelled, in base units.'),
  }),
  permission: 'purchasing.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'purchasing.order.closed' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/purchase-orders/{purchaseOrderId}/close' },
  mcp: { tool: TOOL, action: 'close', readOnly: false, destructive: true },
  async handler(ctx, input) {
    const order = await lockOrder(ctx.tx, input.purchaseOrderId);
    await assertDestinationInScope(ctx, order.warehouse_id, order.location_id);
    if (input.expectedVersion !== undefined) checkVersion(order.version, input.expectedVersion);
    if (!['sent', 'partially_received', 'received'].includes(order.status)) {
      throw errors.conflict(
        'purchase_order_not_open',
        order.status === 'draft'
          ? 'A draft was never sent: cancel it instead.'
          : `The order is already ${order.status}.`,
      );
    }
    const cancelled = await ctx.tx.query<{ line_id: string; quantity: string; variant_id: string }>(
      `update purchase_order_lines l set cancelled = l.cancelled + greatest(l.ordered - l.received - l.cancelled, 0)
       from purchase_order_lines old
       where old.shop_id = l.shop_id and old.id = l.id and l.purchase_order_id = $1
       returning l.id as line_id, greatest(old.ordered - old.received - old.cancelled, 0)::text as quantity,
         l.variant_id`,
      [order.id],
    );
    await ctx.tx.query(
      `update purchase_orders set status = 'closed', closed_at = now(), version = version + 1,
         updated_at = now() where id = $1`,
      [order.id],
    );
    const result = await loadPurchaseOrder(ctx.tx, order.id, canSeeCosts(ctx));
    const remainder = cancelled
      .filter((c) => compare(c.quantity, '0') > 0)
      .map((c) => ({ lineId: c.line_id, quantity: normalize(c.quantity) }));
    return {
      result: { purchaseOrder: result, cancelled: remainder },
      audit: {
        targetType: 'purchase_order',
        targetId: order.id,
        externalRef: result.number,
        reason: input.reason ?? null,
        changes: { status: { from: order.status, to: 'closed' }, cancelled: remainder },
      },
      alertCheck: { variantIds: [...new Set(cancelled.map((c) => c.variant_id))] },
      webhooks: [
        await statusChangedWebhook(
          ctx.tx,
          { ...orderRef(order), version: order.version + 1 },
          order.status,
          'closed',
        ),
      ],
    };
  },
});

export const cancelPurchaseOrder = defineOperation({
  id: 'purchasing.orders.cancel',
  summary: 'Cancel a purchase order',
  description:
    'Use this to call off an order before anything was received: a draft or a sent order. Its lines stop counting as on order. Once goods arrived, close the order instead.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    purchaseOrderId: PurchaseOrderId,
    expectedVersion: ExpectedVersion.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  output: PurchaseOrderOut,
  permission: 'purchasing.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'purchasing.order.cancelled' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/purchase-orders/{purchaseOrderId}/cancel' },
  mcp: { tool: TOOL, action: 'cancel', readOnly: false, destructive: true },
  async handler(ctx, input) {
    const order = await lockOrder(ctx.tx, input.purchaseOrderId);
    await assertDestinationInScope(ctx, order.warehouse_id, order.location_id);
    if (input.expectedVersion !== undefined) checkVersion(order.version, input.expectedVersion);
    if (order.status !== 'draft' && order.status !== 'sent') {
      throw errors.conflict(
        'purchase_order_received',
        order.status === 'partially_received' || order.status === 'received'
          ? 'Goods were already received against this order: close it instead.'
          : `The order is already ${order.status}.`,
      );
    }
    await ctx.tx.query(
      'update purchase_order_lines set cancelled = ordered where purchase_order_id = $1',
      [order.id],
    );
    await ctx.tx.query(
      `update purchase_orders set status = 'cancelled', cancelled_at = now(), version = version + 1,
         updated_at = now() where id = $1`,
      [order.id],
    );
    const result = await loadPurchaseOrder(ctx.tx, order.id, canSeeCosts(ctx));
    return {
      result,
      audit: {
        targetType: 'purchase_order',
        targetId: order.id,
        externalRef: result.number,
        reason: input.reason ?? null,
        changes: { status: { from: order.status, to: 'cancelled' } },
      },
      ...(order.status === 'sent'
        ? { alertCheck: { variantIds: [...new Set(result.lines.map((l) => l.variantId))] } }
        : {}),
      webhooks: [
        await statusChangedWebhook(
          ctx.tx,
          { ...orderRef(order), version: order.version + 1 },
          order.status,
          'cancelled',
        ),
      ],
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const purchasingOperations = [
  listPurchaseOrders,
  getPurchaseOrder,
  draftPurchaseOrder,
  updatePurchaseOrder,
  sendPurchaseOrder,
  receivePurchaseOrderLine,
  closePurchaseOrder,
  cancelPurchaseOrder,
] as const;
