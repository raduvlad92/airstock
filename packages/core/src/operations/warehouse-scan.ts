import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { findBarcodeOwner, normalizeBarcode, parseLocationCode } from '../catalog/barcodes.ts';
import { normalize } from '../catalog/decimal.ts';
import { AppError, errors } from '../errors.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id, normalizeSku } from '../schemas.ts';
import { normalizeCode } from '../stock/engine.ts';
import { getAvailability } from './inventory.ts';

// Scan lookup for the phone app (plan 5.12, D13): one read that says what a scanned code is —
// a location label, a variant or pack barcode, a serial or certificate number, a location code,
// or a SKU — with the item's packs and its stock per location. It is logged like any read.

export const WAREHOUSE_TOOL = 'warehouse_work';

const LocationRef = z.object({
  locationId: Id,
  warehouseId: Id,
  warehouseName: z.string(),
  path: z.string(),
  code: z.string().nullable(),
  holdsStock: z.boolean().describe('Stock sits only at locations without children.'),
});

const ItemRef = z.object({
  variantId: Id,
  productId: Id,
  productName: z.string(),
  variantName: z.string().nullable(),
  sku: z.string(),
  trackingMode: z.string().describe('none, lot, lot_expiry, or serial.'),
  oneOfAKind: z.boolean(),
  quantityScale: z.number().int(),
  matchedBy: z.enum(['barcode', 'serial', 'sku']),
  pack: z
    .object({ packId: Id, name: z.string(), baseQuantity: z.string() })
    .nullable()
    .describe('Set when the code is a pack’s barcode, such as a case.'),
  serial: z
    .object({
      serialId: Id,
      serial: z.string(),
      status: z.string(),
      locationId: Id.nullable(),
      locationPath: z.string().nullable(),
    })
    .nullable()
    .describe('Set when the code is a serial or certificate number.'),
  packs: z.array(z.object({ packId: Id, name: z.string(), baseQuantity: z.string() })),
});

export const ScanOut = z.object({
  code: z.string(),
  kind: z.enum(['location', 'item', 'unknown']),
  location: LocationRef.nullable(),
  item: ItemRef.nullable(),
  stock: getAvailability.output
    .nullable()
    .describe('The item’s stock per location you can see, as get_stock returns it.'),
});

async function locationBy(
  tx: Tx,
  where: 'id' | 'code',
  value: string,
): Promise<(z.infer<typeof LocationRef> & { pathIds: string[] }) | null> {
  const rows = await tx.query<{
    id: string;
    warehouse_id: string;
    warehouse_name: string;
    path: string;
    code: string | null;
    holds_stock: boolean;
    path_ids: string[];
  }>(
    `select l.id, l.warehouse_id, w.name as warehouse_name, l.path, l.code, l.path_ids,
       not exists (select 1 from locations c where c.shop_id = l.shop_id and c.parent_id = l.id
         and c.status = 'active') as holds_stock
     from locations l join warehouses w on w.shop_id = l.shop_id and w.id = l.warehouse_id
     where l.kind = 'storage' and l.status = 'active'
       and ${where === 'id' ? 'l.id = $1::uuid' : 'upper(l.code) = upper($1)'}
     order by l.path limit 2`,
    [value],
  );
  // A location code shared by two locations is ambiguous: the label (LOC:) is the safe way.
  if (rows.length !== 1) return null;
  const r = rows[0]!;
  return {
    locationId: r.id,
    warehouseId: r.warehouse_id,
    warehouseName: r.warehouse_name,
    path: r.path,
    code: r.code,
    holdsStock: r.holds_stock,
    pathIds: r.path_ids,
  };
}

function assertInScope(ctx: HandlerContext, pathIds: string[]): void {
  if (ctx.locationScope && !pathIds.some((id) => ctx.locationScope!.includes(id))) {
    throw new AppError(
      403,
      'location_out_of_scope',
      'You do not have access to this location.',
      'denied',
    );
  }
}

async function itemFor(
  tx: Tx,
  variantId: string,
  matchedBy: z.infer<typeof ItemRef>['matchedBy'],
  pack: z.infer<typeof ItemRef>['pack'],
  serial: z.infer<typeof ItemRef>['serial'],
): Promise<z.infer<typeof ItemRef>> {
  const [v] = await tx.query<{
    product_id: string;
    product_name: string;
    variant_name: string | null;
    sku: string;
    tracking_mode: string;
    one_of_a_kind: boolean;
    quantity_scale: number;
    packs: Array<{ packId: string; name: string; baseQuantity: string }>;
  }>(
    `select v.product_id, p.name as product_name, v.name as variant_name, v.sku, v.tracking_mode,
       v.one_of_a_kind, v.quantity_scale,
       coalesce((select json_agg(json_build_object('packId', k.id, 'name', k.name,
           'baseQuantity', trim_scale(k.base_quantity)::text) order by k.position, k.id)
         from packs k where k.shop_id = v.shop_id and k.variant_id = v.id and k.status = 'active'),
         '[]'::json) as packs
     from variants v join products p on p.shop_id = v.shop_id and p.id = v.product_id
     where v.id = $1`,
    [variantId],
  );
  if (!v) throw errors.notFound('Variant');
  return {
    variantId,
    productId: v.product_id,
    productName: v.product_name,
    variantName: v.variant_name,
    sku: v.sku,
    trackingMode: v.tracking_mode,
    oneOfAKind: v.one_of_a_kind,
    quantityScale: v.quantity_scale,
    matchedBy,
    pack,
    serial,
    packs: v.packs,
  };
}

/** What a code names, in the order a scanner meets them. */
export async function resolveCode(
  ctx: HandlerContext,
  code: string,
): Promise<
  | { kind: 'location'; location: z.infer<typeof LocationRef> }
  | { kind: 'item'; item: z.infer<typeof ItemRef> }
  | { kind: 'unknown' }
> {
  const tx = ctx.tx;
  // 1. A location label: LOC: and the location's ID (ADR 0019).
  const labelId = parseLocationCode(code);
  if (labelId) {
    const location = await locationBy(tx, 'id', labelId);
    if (!location) throw errors.notFound('Location');
    assertInScope(ctx, location.pathIds);
    const { pathIds: _, ...rest } = location;
    return { kind: 'location', location: rest };
  }
  // 2. A variant's or pack's barcode, matched the way uniqueness is (GTIN padding, case).
  const owner = await findBarcodeOwner(tx, normalizeBarcode(code));
  if (owner) {
    const pack = owner.packId
      ? {
          packId: owner.packId,
          name: owner.packName ?? '',
          baseQuantity: normalize(owner.baseQuantity),
        }
      : null;
    return { kind: 'item', item: await itemFor(tx, owner.variantId, 'barcode', pack, null) };
  }
  // 3. A serial or grading-certificate number of a serialized unit, in stock first.
  const [unit] = await tx.query<{
    id: string;
    variant_id: string;
    serial: string;
    status: string;
    location_id: string | null;
    path: string | null;
  }>(
    `select su.id, su.variant_id, su.serial, su.status, pos.location_id, l.path
     from serial_units su
     left join inventory_positions pos on pos.shop_id = su.shop_id and pos.id = su.position_id
     left join locations l on l.shop_id = pos.shop_id and l.id = pos.location_id
     where su.serial_normalized = $1
     order by (su.status = 'in_stock') desc, su.updated_at desc limit 1`,
    [normalizeCode(code)],
  );
  if (unit) {
    const serial = {
      serialId: unit.id,
      serial: unit.serial,
      status: unit.status,
      locationId: unit.location_id,
      locationPath: unit.path,
    };
    return { kind: 'item', item: await itemFor(tx, unit.variant_id, 'serial', null, serial) };
  }
  // 4. A location's own code, typed or on an older label.
  const byCode = await locationBy(tx, 'code', code.trim());
  if (byCode) {
    assertInScope(ctx, byCode.pathIds);
    const { pathIds: _, ...rest } = byCode;
    return { kind: 'location', location: rest };
  }
  // 5. A SKU, typed.
  const [sku] = await tx.query<{ id: string }>(
    `select id from variants where sku_normalized = $1 and status = 'active'`,
    [normalizeSku(code)],
  );
  if (sku) return { kind: 'item', item: await itemFor(tx, sku.id, 'sku', null, null) };
  return { kind: 'unknown' };
}

export const scanLookup = defineOperation({
  id: 'warehouse.scan.lookup',
  summary: 'Identify a scanned code and show its stock',
  description:
    'Use this when someone scans or types a code in the warehouse and wants to know what it is: a location label (LOC:…), a product or pack barcode, a serial or grading-certificate number, a location code, or a SKU. Returns the location, or the item with its packs and its stock per location (the same figures as get_stock). An unknown code returns kind "unknown". Not for searching by name (use search_catalog).',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    code: z.string().trim().min(1).max(200).describe('The text the scanner read.'),
    includeStock: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .optional()
      .describe('Include the item’s stock per location (default true).'),
  }),
  output: ScanOut,
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'warehouse.scan.looked_up' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/scan' },
  mcp: { tool: WAREHOUSE_TOOL, action: 'scan', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const found = await resolveCode(ctx, input.code);
    const wantStock = input.includeStock !== false && input.includeStock !== 'false';
    let stock: z.infer<typeof getAvailability.output> | null = null;
    if (found.kind === 'item' && wantStock) {
      stock = (await getAvailability.handler(ctx, { variantId: found.item.variantId })).result;
    }
    return {
      result: {
        code: input.code,
        kind: found.kind,
        location: found.kind === 'location' ? found.location : null,
        item: found.kind === 'item' ? found.item : null,
        stock,
      },
      audit: {
        targetType:
          found.kind === 'item' ? 'variant' : found.kind === 'location' ? 'location' : 'scan',
        targetId:
          found.kind === 'item'
            ? found.item.variantId
            : found.kind === 'location'
              ? found.location.locationId
              : 'unknown',
        locationIds:
          found.kind === 'location'
            ? [found.location.locationId]
            : [...new Set((stock?.positions ?? []).map((p) => p.locationId))].slice(0, 100),
        context: {
          code: input.code,
          kind: found.kind,
          ...(found.kind === 'item' ? { matchedBy: found.item.matchedBy } : {}),
        },
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const warehouseScanOperations = [scanLookup] as const;
