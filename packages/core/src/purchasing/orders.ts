import type { Tx } from '@airstock/db';
import { errors } from '../errors.ts';
import type { HandlerContext } from '../registry.ts';
import { iso } from '../schemas.ts';
import { type WebhookEmit, webhookEvent } from '../webhooks/events.ts';

// Purchase order reads shared by the operations, the PDF, and the email job (D11, PRD 6.8).

export const PO_STATUSES = [
  'draft',
  'sent',
  'partially_received',
  'received',
  'closed',
  'cancelled',
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

/** Orders whose open lines count as on order and can be received against. */
export const OPEN_PO_STATUSES: readonly PoStatus[] = ['sent', 'partially_received'];

export function poNumber(n: number): string {
  return `PO-${String(n).padStart(4, '0')}`;
}

export interface PurchaseOrderLineView {
  id: string;
  position: number;
  variantId: string;
  productId: string;
  productName: string;
  variantName: string | null;
  sku: string;
  packId: string | null;
  packName: string | null;
  packFactor: string | null;
  supplierItemId: string | null;
  supplierSku: string | null;
  quantity: string;
  ordered: string;
  received: string;
  cancelled: string;
  open: string;
  overReceived: string;
  unitCost: string | null;
  lineTotal: string | null;
  note: string | null;
}

export interface PurchaseOrderView {
  id: string;
  number: string;
  status: PoStatus;
  supplier: {
    id: string;
    name: string;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
  };
  warehouse: { id: string; name: string; address: string | null };
  location: { id: string; path: string } | null;
  currency: string;
  expectedOn: string | null;
  supplierReference: string | null;
  notes: string | null;
  costVisible: boolean;
  total: string | null;
  lines: PurchaseOrderLineView[];
  receipts: Array<{
    id: string;
    lineId: string;
    operationId: string;
    quantity: string;
    overReceived: string;
    createdAt: string;
  }>;
  sends: Array<{
    id: string;
    channel: 'email' | 'manual';
    recipient: string | null;
    status: 'recorded' | 'queued' | 'sent' | 'failed' | 'suppressed';
    purchaseOrderVersion: number;
    error: string | null;
    createdAt: string;
    completedAt: string | null;
  }>;
  shop: { name: string };
  createdAt: string;
  sentAt: string | null;
  receivedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
  version: number;
}

function addressText(address: unknown): string | null {
  if (!address || typeof address !== 'object') return null;
  const a = address as Record<string, unknown>;
  const parts = [
    a.line1,
    a.line2,
    [a.postalCode, a.city].filter(Boolean).join(' '),
    a.region,
    a.country,
  ]
    .filter((p) => typeof p === 'string' && p.trim() !== '')
    .map(String);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** One purchase order with lines, receipts, and sends. Costs only when `costs` is true. */
export async function loadPurchaseOrder(
  tx: Tx,
  id: string,
  costs: boolean,
): Promise<PurchaseOrderView> {
  const [row] = await tx.query<{
    id: string;
    number: number;
    status: PoStatus;
    currency: string;
    expected_on: string | null;
    supplier_reference: string | null;
    notes: string | null;
    created_at: Date;
    sent_at: Date | null;
    received_at: Date | null;
    closed_at: Date | null;
    cancelled_at: Date | null;
    updated_at: Date;
    version: number;
    supplier: PurchaseOrderView['supplier'];
    warehouse_id: string;
    warehouse_name: string;
    warehouse_address: unknown;
    location_id: string | null;
    location_path: string | null;
    shop_name: string;
    total: string | null;
    lines: Array<
      Omit<PurchaseOrderLineView, 'unitCost' | 'lineTotal'> & {
        unitCost: string | null;
        lineTotal: string | null;
      }
    >;
    receipts: PurchaseOrderView['receipts'];
    sends: PurchaseOrderView['sends'];
  }>(
    `select o.id, o.number, o.status, o.currency, to_char(o.expected_on, 'YYYY-MM-DD') as expected_on,
       o.supplier_reference, o.notes, o.created_at, o.sent_at, o.received_at, o.closed_at,
       o.cancelled_at, o.updated_at, o.version,
       json_build_object('id', s.id, 'name', s.name, 'contactName', s.contact_name,
         'email', s.email, 'phone', s.phone, 'address', s.address) as supplier,
       w.id as warehouse_id, w.name as warehouse_name, w.address as warehouse_address,
       o.location_id, loc.path as location_path, sh.name as shop_name,
       (select sum(round_half_even(l.quantity * l.unit_cost, 6))::text from purchase_order_lines l
         where l.shop_id = o.shop_id and l.purchase_order_id = o.id
         having count(*) = count(l.unit_cost)) as total,
       coalesce((select json_agg(json_build_object(
           'id', l.id, 'position', l.position, 'variantId', l.variant_id, 'productId', p.id,
           'productName', p.name, 'variantName', v.name, 'sku', v.sku, 'packId', l.pack_id,
           'packName', k.name, 'packFactor', l.pack_factor::text,
           'supplierItemId', l.supplier_item_id, 'supplierSku', l.supplier_sku,
           'quantity', l.quantity::text, 'ordered', l.ordered::text, 'received', l.received::text,
           'cancelled', l.cancelled::text,
           'open', case when o.status in ('sent', 'partially_received')
             then greatest(l.ordered - l.received - l.cancelled, 0) else 0 end::text,
           'overReceived', greatest(l.received - l.ordered, 0)::text,
           'unitCost', l.unit_cost::text,
           'lineTotal', round_half_even(l.quantity * l.unit_cost, 6)::text,
           'note', l.note) order by l.position)
         from purchase_order_lines l
         join variants v on v.shop_id = l.shop_id and v.id = l.variant_id
         join products p on p.shop_id = v.shop_id and p.id = v.product_id
         left join packs k on k.shop_id = l.shop_id and k.id = l.pack_id
         where l.shop_id = o.shop_id and l.purchase_order_id = o.id), '[]'::json) as lines,
       coalesce((select json_agg(json_build_object('id', r.id, 'lineId', r.line_id,
           'operationId', r.operation_id, 'quantity', r.quantity::text,
           'overReceived', r.over_received::text,
           'createdAt', to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
           order by r.created_at, r.id)
         from purchase_order_receipts r where r.shop_id = o.shop_id and r.purchase_order_id = o.id),
         '[]'::json) as receipts,
       coalesce((select json_agg(json_build_object('id', d.id, 'channel', d.channel,
           'recipient', d.recipient, 'status', d.status,
           'purchaseOrderVersion', d.purchase_order_version, 'error', d.error,
           'createdAt', to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'completedAt', to_char(d.completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
           order by d.created_at desc, d.id desc)
         from po_sends d where d.shop_id = o.shop_id and d.purchase_order_id = o.id), '[]'::json) as sends
     from purchase_orders o
     join suppliers s on s.shop_id = o.shop_id and s.id = o.supplier_id
     join warehouses w on w.shop_id = o.shop_id and w.id = o.warehouse_id
     join shops sh on sh.id = o.shop_id
     left join locations loc on loc.shop_id = o.shop_id and loc.id = o.location_id
     where o.id = $1`,
    [id],
  );
  if (!row) throw errors.notFound('Purchase order');
  return {
    id: row.id,
    number: poNumber(row.number),
    status: row.status,
    supplier: row.supplier,
    warehouse: {
      id: row.warehouse_id,
      name: row.warehouse_name,
      address: addressText(row.warehouse_address),
    },
    location: row.location_id ? { id: row.location_id, path: row.location_path ?? '' } : null,
    currency: row.currency,
    expectedOn: row.expected_on,
    supplierReference: row.supplier_reference,
    notes: row.notes,
    costVisible: costs,
    total: costs ? row.total : null,
    lines: row.lines.map((l) => ({
      ...l,
      unitCost: costs ? l.unitCost : null,
      lineTotal: costs ? l.lineTotal : null,
    })),
    receipts: row.receipts,
    sends: row.sends,
    shop: { name: row.shop_name },
    createdAt: iso(row.created_at)!,
    sentAt: iso(row.sent_at),
    receivedAt: iso(row.received_at),
    closedAt: iso(row.closed_at),
    cancelledAt: iso(row.cancelled_at),
    updatedAt: iso(row.updated_at)!,
    version: row.version,
  };
}

/**
 * Whether the caller's location scope covers a purchase order's destination: the warehouse, or
 * the order's receiving location. Null scope means every location.
 */
export async function destinationInScope(
  tx: Tx,
  scope: string[] | null,
  warehouseId: string,
  locationId: string | null,
): Promise<boolean> {
  if (scope === null) return true;
  if (scope.includes(warehouseId)) return true;
  if (!locationId) return false;
  const [row] = await tx.query<{ ok: boolean }>(
    'select path_ids && $2::uuid[] as ok from locations where id = $1',
    [locationId, scope],
  );
  return row?.ok ?? false;
}

export async function assertDestinationInScope(
  ctx: HandlerContext,
  warehouseId: string,
  locationId: string | null,
): Promise<void> {
  if (!(await destinationInScope(ctx.tx, ctx.locationScope, warehouseId, locationId))) {
    throw errors.forbidden('This purchase order’s destination is outside your locations.');
  }
}

/** Leaf-ish locations a webhook filter can match for an order's destination (D14). */
export async function destinationLocationIds(
  tx: Tx,
  warehouseId: string,
  locationId: string | null,
): Promise<string[]> {
  if (locationId) return [locationId];
  const rows = await tx.query<{ id: string }>(
    `select id from locations where warehouse_id = $1 and parent_id is null and kind = 'storage'
     order by path limit 200`,
    [warehouseId],
  );
  return rows.map((r) => r.id);
}

/** The webhook event for a status change (`purchase_order.status_changed`). */
export async function statusChangedWebhook(
  tx: Tx,
  order: {
    id: string;
    number: number | string;
    warehouseId: string;
    locationId: string | null;
    supplierId: string;
    version: number;
  },
  from: PoStatus | null,
  to: PoStatus,
): Promise<WebhookEmit> {
  return webhookEvent('purchase_order.status_changed', {
    data: {
      purchaseOrder: {
        id: order.id,
        number: typeof order.number === 'number' ? poNumber(order.number) : order.number,
        supplierId: order.supplierId,
        warehouseId: order.warehouseId,
        locationId: order.locationId,
        version: order.version,
      },
      status: { from, to },
    },
    locationIds: await destinationLocationIds(tx, order.warehouseId, order.locationId),
  });
}
