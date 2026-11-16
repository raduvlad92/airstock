import type { Tx } from '@airstock/db';
import { type Delimiter, detectDelimiter, parseCsv } from '../csv.ts';
import { normalizeSku } from '../schemas.ts';
import {
  checkBarcode,
  findBarcodeOwners,
  inferSymbology,
  normalizeBarcode,
  type Symbology,
} from './barcodes.ts';
import { compare, decimalScale, isDecimal, normalize } from './decimal.ts';
import { encodeValue, type FieldDefinition } from './fields.ts';
import { PACK_LIMITS, resolvePacks } from './packs.ts';
import { builtin, encodeDimensions, encodePrice, encodeTags } from './records.ts';
import type { StoredField } from './store.ts';

/**
 * CSV import (plan Section 5.12, ADR 0018): map columns, validate every row with the same encoder as
 * every other write path, group variant rows into products, and store each row's validated values
 * so the commit only writes.
 */

export const IMPORT_LIMITS = { bytes: 20 * 1024 * 1024, rows: 50_000, chunkRows: 200 } as const;

/**
 * Columns a file can map to, besides field:<key>, option:<name>, pack:<name>, pack_barcode:<name>,
 * and stock:<locationId>.
 */
export const BUILTIN_TARGETS = [
  'product',
  'name',
  'description',
  'status',
  'family',
  'tags',
  'sku',
  'barcode',
  'supplier',
  'supplier_sku',
  'price',
  'weight',
  'dimensions',
] as const;

export type Mapping = Record<string, string>;

export interface RowData {
  product: {
    name?: string;
    description?: string | null;
    status?: 'draft' | 'active';
    familyId?: string | null;
    tags?: string[];
    attributes: Record<string, unknown>;
  };
  variant: {
    sku: string;
    /** The variant's own barcode, added when the variant does not have it yet (ADR 0019). */
    barcode?: { code: string; normalized: string; symbology: Symbology };
    price?: string | null;
    weight?: unknown;
    dimensions?: unknown;
    attributes: Record<string, unknown>;
  };
  options: Array<{ name: string; value: string }>;
  relations: Array<{ fieldId: string; record: 'product' | 'variant'; targets: string[] }>;
  stock: Array<{ locationId: string; quantity: string }>;
  /**
   * Top-level packs of the variant, by name (ADR 0018): a quantity of base units to create the pack
   * with or change it to, and a barcode to add to it. Rows previewed before packs existed lack it.
   */
  packs?: ImportPack[];
  /** The variant's supplier item for an existing supplier, and its supplier SKU when given. */
  supplier?: { id: string; name: string; sku?: string };
}

export interface ImportPack {
  name: string;
  quantity?: string;
  barcode?: { code: string; normalized: string; symbology: Symbology };
}

export interface PreviewRow {
  rowNumber: number;
  groupKey: string;
  action: 'create' | 'update' | 'error';
  data: RowData | null;
  errors: string[];
  warnings: string[];
  productId: string | null;
  variantId: string | null;
}

export interface PreviewContext {
  tx: Tx;
  fields: StoredField[];
  currency: string;
  families: Array<{ id: string; name: string; status: string }>;
  /** Stock locations the caller may receive into: leaf, active, in scope. */
  locations: Map<string, { path: string }>;
}

const BARCODE_HEADERS = ['ean', 'ean13', 'ean-13', 'upc', 'gtin', 'barcode number'];
/** Headers compared after lower-casing and turning `_`, `-`, and `.` into spaces. */
const SUPPLIER_HEADERS = ['vendor', 'supplier name', 'vendor name'];
/** Supplier headers that Shopify's product CSV uses for the brand. */
const VENDOR_HEADERS = ['vendor', 'vendor name'];

/** Whether a header is "Vendor" or "Vendor name", which may hold a brand rather than a supplier. */
export function isVendorHeader(header: string): boolean {
  return VENDOR_HEADERS.includes(
    header
      .trim()
      .toLowerCase()
      .replace(/[\s_.-]+/g, ' '),
  );
}
const SUPPLIER_SKU_HEADERS = [
  'supplier sku',
  'vendor sku',
  'supplier code',
  'vendor code',
  'supplier item code',
  'supplier item number',
  'supplier part number',
  'vendor part number',
];
/** Words that make a header such as "Case qty" or "Carton EAN" a pack column. */
const PACK_WORDS = /\b(case|carton|box|inner|outer|pack|pallet|tray|crate|master|display|sleeve)\b/;

/** "case qty" → pack:Case, "units per carton" → pack:Carton, "case gtin" → pack_barcode:Case. */
function suggestPack(words: string): string | null {
  const capital = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
  const per =
    /^(?:units|qty|quantity|pcs|pieces|items) (?:per|in) (?:a |an |one |each )?(.+)$/.exec(words);
  const quantity = per?.[1] ?? /^(.+) (?:qty|quantity|units|pcs|count|pack)$/.exec(words)?.[1];
  if (quantity && PACK_WORDS.test(quantity)) return `pack:${capital(quantity)}`;
  const barcode = /^(.+) (?:barcode|ean|ean13|upc|gtin)$/.exec(words)?.[1];
  if (barcode && PACK_WORDS.test(barcode)) return `pack_barcode:${capital(barcode)}`;
  return null;
}

/**
 * Suggested mapping: headers that name a built-in, a field key or label, a supplier or pack
 * column, or option:/pack:/pack_barcode:/stock: columns.
 */
export function suggestMapping(header: string[], fields: FieldDefinition[]): Mapping {
  const out: Mapping = {};
  for (const h of header) {
    const t = h.trim();
    const lower = t.toLowerCase();
    const words = lower.replace(/[\s_.-]+/g, ' ').trim();
    const byBuiltin = (BUILTIN_TARGETS as readonly string[]).find(
      (b) =>
        b === lower ||
        (b === 'product' && lower === 'product_id') ||
        (b === 'barcode' && BARCODE_HEADERS.includes(lower)),
    );
    const field = fields.find((f) => f.key === lower || f.label.toLowerCase() === lower);
    if (byBuiltin) out[t] = byBuiltin;
    else if (field) out[t] = `field:${field.key}`;
    // After the shop's own fields: a "Vendor" field stays that field.
    else if (SUPPLIER_HEADERS.includes(words)) out[t] = 'supplier';
    else if (SUPPLIER_SKU_HEADERS.includes(words)) out[t] = 'supplier_sku';
    else if (/^option:/i.test(t)) out[t] = `option:${t.slice(7).trim()}`;
    else if (/^pack:/i.test(t)) out[t] = `pack:${t.slice(5).trim()}`;
    else if (/^pack_barcode:/i.test(t)) out[t] = `pack_barcode:${t.slice(13).trim()}`;
    else if (/^stock:/i.test(t)) out[t] = `stock:${t.slice(6).trim()}`;
    else out[t] = suggestPack(words) ?? 'ignore';
  }
  return out;
}

/** The pack a pack:<name> or pack_barcode:<name> target names, or null for other targets. */
export function packTarget(target: string): { kind: 'quantity' | 'barcode'; name: string } | null {
  if (target.startsWith('pack:')) return { kind: 'quantity', name: target.slice(5).trim() };
  if (target.startsWith('pack_barcode:')) return { kind: 'barcode', name: target.slice(13).trim() };
  return null;
}

export function readFile(
  text: string,
  delimiter?: Delimiter,
): { header: string[]; rows: string[][]; delimiter: Delimiter } {
  const d = delimiter ?? detectDelimiter(text);
  const all = parseCsv(text, d);
  const [header, ...rows] = all;
  if (!header) throw new Error('The file is empty.');
  return { header: header.map((h) => h.trim()), rows, delimiter: d };
}

/**
 * Validates every row without writing (plan 5.12). Rows whose SKU exists update that variant;
 * others create products, grouped by the `product` column (or the name) into variants.
 */
export async function previewRows(
  ctx: PreviewContext,
  header: string[],
  rows: string[][],
  mapping: Mapping,
): Promise<PreviewRow[]> {
  const fieldByKey = new Map(
    ctx.fields.filter((f) => f.status === 'active').map((f) => [f.key, f]),
  );
  const columns = header.map((h, i) => ({ index: i, header: h, target: mapping[h] ?? 'ignore' }));
  const target = (t: string) => columns.find((c) => c.target === t);
  const skuColumn = target('sku');
  if (!skuColumn) throw new Error('Map a column to sku: every row needs a SKU.');
  const once = new Map<string, string>();
  for (const c of columns) {
    if (c.target.startsWith('field:') && !fieldByKey.has(c.target.slice(6))) {
      throw new Error(`Column "${c.header}" maps to an unknown field ${c.target.slice(6)}.`);
    }
    if (c.target.startsWith('stock:') && !ctx.locations.has(c.target.slice(6))) {
      throw new Error(`Column "${c.header}" maps to a location you cannot receive into.`);
    }
    const pack = packTarget(c.target);
    if (pack && (pack.name === '' || pack.name.length > 100)) {
      throw new Error(`Column "${c.header}" needs a pack name of 1 to 100 characters.`);
    }
    // One column per supplier, supplier SKU, and pack value.
    const key = pack ? `${pack.kind}:${pack.name.toLowerCase()}` : c.target;
    if (pack || c.target === 'supplier' || c.target === 'supplier_sku') {
      if (once.has(key))
        throw new Error(`Columns "${once.get(key)}" and "${c.header}" map to ${c.target}.`);
      once.set(key, c.header);
    }
  }
  if (target('supplier_sku') && !target('supplier')) {
    throw new Error('Map a column to supplier too: a supplier SKU belongs to a supplier.');
  }
  const packNames = new Set(columns.flatMap((c) => packTarget(c.target)?.name.toLowerCase() ?? []));
  if (packNames.size > PACK_LIMITS.perVariant) {
    throw new Error(`A variant has at most ${PACK_LIMITS.perVariant} packs.`);
  }
  // Active suppliers of this shop, matched by name (any case) or ID; never created from a file.
  const suppliers = target('supplier')
    ? await ctx.tx.query<{ id: string; name: string }>(
        `select id, name from suppliers where status = 'active'`,
      )
    : [];
  const supplierByName = new Map(suppliers.map((x) => [x.name.toLowerCase(), x]));
  const supplierById = new Map(suppliers.map((x) => [x.id, x]));
  // Existing SKUs in one query.
  const skus = rows.map((r) => normalizeSku(r[skuColumn.index] ?? ''));
  const existing = new Map(
    (
      await ctx.tx.query<{
        sku_normalized: string;
        id: string;
        product_id: string;
        quantity_scale: number;
        tracking_mode: string;
        one_of_a_kind: boolean;
        is_bundle: boolean;
      }>(
        `select sku_normalized, id, product_id, quantity_scale, tracking_mode, one_of_a_kind,
           exists (select 1 from bundles b where b.shop_id = v.shop_id and b.variant_id = v.id and b.active) as is_bundle
         from variants v where sku_normalized = any($1::text[])`,
        [skus.filter(Boolean)],
      )
    ).map((r) => [r.sku_normalized, r]),
  );
  const seen = new Map<string, number>();
  const seenBarcodes = new Map<string, number>();
  const seenSupplierSkus = new Map<string, number>();
  const out: PreviewRow[] = [];
  for (const [i, cells] of rows.entries()) {
    const rowNumber = i + 2; // the header is line 1
    const errors: string[] = [];
    const warnings: string[] = [];
    const cell = (c: { index: number }) => (cells[c.index] ?? '').trim();
    const sku = cell(skuColumn);
    const skuNorm = normalizeSku(sku);
    const data: RowData = {
      product: { attributes: {} },
      variant: { sku, attributes: {} },
      options: [],
      relations: [],
      stock: [],
      packs: [],
    };
    const packFor = (name: string) => {
      const found = data.packs!.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (found) return found;
      const pack: ImportPack = { name };
      data.packs!.push(pack);
      return pack;
    };
    let supplierSku: string | null = null;
    let supplierFailed = false;
    if (!sku) errors.push('The SKU is empty.');
    else if (seen.has(skuNorm)) errors.push(`The SKU repeats row ${seen.get(skuNorm)}.`);
    else seen.set(skuNorm, rowNumber);
    const match = existing.get(skuNorm);
    for (const c of columns) {
      const value = cell(c);
      const t = c.target;
      if (t === 'ignore' || t === 'sku' || t === 'product') continue;
      // An empty cell leaves the value as it is (updates) or unset (creates).
      if (value === '') continue;
      const fail = (message: string) => errors.push(`${c.header}: ${message}`);
      if (t === 'name') {
        if (value.length > 500) fail('At most 500 characters.');
        else data.product.name = value;
      } else if (t === 'description') data.product.description = value;
      else if (t === 'status') {
        const s = value.toLowerCase();
        if (s === 'draft' || s === 'active') data.product.status = s;
        else fail('Use draft or active.');
      } else if (t === 'family') {
        const family = ctx.families.find(
          (f) =>
            f.status === 'active' &&
            (f.name.toLowerCase() === value.toLowerCase() || f.id === value),
        );
        if (family) data.product.familyId = family.id;
        else fail(`No family "${value}".`);
      } else if (t === 'tags') {
        const r = encodeTags(value);
        if (r.ok) data.product.tags = r.value as string[];
        else fail(r.message);
      } else if (t === 'barcode' || t.startsWith('pack_barcode:')) {
        const checked = checkBarcode(value, inferSymbology(value));
        if (!checked.ok) fail(checked.message);
        else if (seenBarcodes.has(checked.normalized))
          fail(`The barcode repeats row ${seenBarcodes.get(checked.normalized)}.`);
        else {
          seenBarcodes.set(checked.normalized, rowNumber);
          const barcode = {
            code: checked.code,
            normalized: checked.normalized,
            symbology: inferSymbology(value),
          };
          if (t === 'barcode') data.variant.barcode = barcode;
          else packFor(packTarget(t)!.name).barcode = barcode;
        }
      } else if (t.startsWith('pack:')) {
        // Base units in one pack, exact; the same checks as set_packs for a pack of base units.
        const name = packTarget(t)!.name;
        const q = value.replace(',', '.');
        if (!isDecimal(q) || compare(q, '0') <= 0) fail('Use a quantity of base units such as 12.');
        else {
          const resolved = resolvePacks(
            [{ key: name, name, quantity: q, inner: null }],
            match?.quantity_scale ?? 0,
          );
          if (!resolved.ok) fail(resolved.message);
          else packFor(name).quantity = normalize(q);
        }
      } else if (t === 'supplier') {
        const supplier = supplierByName.get(value.toLowerCase()) ?? supplierById.get(value);
        if (supplier) data.supplier = { id: supplier.id, name: supplier.name };
        else {
          supplierFailed = true;
          fail(`No supplier "${value}". Add it under Suppliers first.`);
        }
      } else if (t === 'supplier_sku') {
        if (value.length > 100) fail('At most 100 characters.');
        else supplierSku = value;
      } else if (t === 'price') {
        const r = encodePrice(value);
        if (r.ok) data.variant.price = r.value as string | null;
        else fail(r.message);
      } else if (t === 'weight') {
        const r = builtin('weight', 'variant')!.encode(value);
        if (r.ok) data.variant.weight = r.value;
        else fail(r.message);
      } else if (t === 'dimensions') {
        const r = encodeDimensions(value);
        if (r.ok) data.variant.dimensions = r.value;
        else fail(r.message);
      } else if (t.startsWith('option:')) {
        if (value.length > 100) fail('At most 100 characters.');
        else data.options.push({ name: t.slice(7), value });
      } else if (t.startsWith('stock:')) {
        const q = value.replace(',', '.');
        if (!isDecimal(q) || q.startsWith('-')) fail('Use a quantity such as 12.');
        else if (normalize(q) !== '0') {
          const scale = match?.quantity_scale ?? 0;
          if (decimalScale(normalize(q)) > scale)
            fail(`At most ${scale} decimal places for this item.`);
          else if (match && match.tracking_mode !== 'none')
            fail('This item is tracked by lot or serial: receive it with its lots or serials.');
          else if (match?.is_bundle) fail('A bundle holds no stock of its own.');
          else if (match?.one_of_a_kind)
            fail('This item is one of a kind: receive its single unit in the dashboard.');
          else data.stock.push({ locationId: t.slice(6), quantity: normalize(q) });
        }
      } else if (t.startsWith('field:')) {
        const def = fieldByKey.get(t.slice(6))!;
        const input =
          def.type === 'relationship' || def.type === 'file' || def.type === 'multi_select'
            ? value.split(/\s*[;|]\s*/).filter(Boolean)
            : value;
        const r = encodeValue(def, input, { currency: ctx.currency });
        if (!r.ok) fail(r.message);
        else if (def.type === 'file') fail('File fields are set in the dashboard.');
        else if (def.type === 'relationship') {
          data.relations.push({
            fieldId: def.id,
            record: def.level === 'variant' ? 'variant' : 'product',
            targets: r.value as string[],
          });
        } else if (def.level === 'variant') data.variant.attributes[def.id] = r.value;
        else data.product.attributes[def.id] = r.value;
      }
    }
    if (supplierSku !== null && data.supplier) {
      // A supplier SKU is unique per supplier (ADR 0019).
      const key = `${data.supplier.id}\u0000${normalizeSku(supplierSku)}`;
      if (seenSupplierSkus.has(key))
        errors.push(`supplier_sku: The supplier SKU repeats row ${seenSupplierSkus.get(key)}.`);
      else {
        seenSupplierSkus.set(key, rowNumber);
        data.supplier.sku = supplierSku;
      }
    } else if (supplierSku !== null && !supplierFailed) {
      errors.push('supplier_sku: Give the supplier in the same row.');
    }
    const productKey =
      (target('product') ? cell(target('product')!) : '') || data.product.name || sku;
    const groupKey = match ? `update:${match.product_id}` : `create:${productKey.toLowerCase()}`;
    out.push({
      rowNumber,
      groupKey,
      action: errors.length ? 'error' : match ? 'update' : 'create',
      data: errors.length ? null : data,
      errors,
      warnings,
      productId: match?.product_id ?? null,
      variantId: match?.id ?? null,
    });
  }
  await checkPacks(ctx, out);
  await checkBarcodeOwners(ctx, out);
  await checkSupplierSkus(ctx, out);
  await checkGroups(ctx, out);
  return out;
}

function rowError(r: PreviewRow, message: string) {
  r.errors.push(message);
  r.action = 'error';
  r.data = null;
}

export interface ExistingPack {
  variant_id: string;
  id: string;
  name: string;
  quantity: string;
  inner_pack_id: string | null;
  inner_name: string | null;
  base_quantity: string;
  /** Other active packs are made of this one. */
  is_inner: boolean;
  /** The SKU of an active bundle whose definition uses this pack. */
  bundle_sku: string | null;
  uses: string[];
  dimensions: unknown;
  weight: unknown;
  price: string | null;
  position: number;
  version: number;
}

/** The active packs of these variants, with what makes a quantity change unsafe. */
export async function loadExistingPacks(tx: Tx, variantIds: string[]): Promise<ExistingPack[]> {
  if (variantIds.length === 0) return [];
  return tx.query<ExistingPack>(
    `select p.variant_id, p.id, p.name, p.quantity::text as quantity, p.inner_pack_id,
       i.name as inner_name, p.base_quantity::text as base_quantity,
       exists (select 1 from packs o where o.shop_id = p.shop_id and o.inner_pack_id = p.id
         and o.status = 'active') as is_inner,
       (select v.sku from bundle_components c
          join bundle_versions bv on bv.shop_id = c.shop_id and bv.id = c.bundle_version_id
          join bundles b on b.shop_id = bv.shop_id and b.id = bv.bundle_id and b.version = bv.version
          join variants v on v.shop_id = b.shop_id and v.id = b.variant_id
          where c.shop_id = p.shop_id and c.pack_id = p.id and b.active limit 1) as bundle_sku,
       p.uses, p.dimensions, p.weight, p.price::text as price, p.position, p.version
     from packs p
     left join packs i on i.shop_id = p.shop_id and i.id = p.inner_pack_id
     where p.variant_id = any($1::uuid[]) and p.status = 'active'
     order by p.variant_id, p.position, p.id`,
    [variantIds],
  );
}

/**
 * What a pack column does to one variant's packs (ADR 0018): create a top-level pack, change the
 * quantity of one (a new pack version), or nothing. Nested packs stay out of CSV: a nested pack's
 * column must match its base quantity, and a pack other packs are made of keeps its quantity.
 * Used by the preview and again by the commit, against the packs as they are then.
 */
export function planPack(
  pack: ImportPack,
  existing: ExistingPack | undefined,
): { action: 'create' | 'change' | 'none' } | { problem: string } {
  if (pack.quantity === undefined) {
    if (existing) return { action: 'none' };
    return {
      problem: `pack_barcode:${pack.name}: The variant has no pack ${pack.name}. Map its quantity too (pack:${pack.name}).`,
    };
  }
  if (!existing) return { action: 'create' };
  const same = compare(pack.quantity, existing.base_quantity) === 0;
  if (existing.inner_pack_id) {
    return same
      ? { action: 'none' }
      : {
          problem: `pack:${pack.name}: ${existing.name} is made of ${existing.inner_name ?? 'other packs'}; change it in the dashboard.`,
        };
  }
  if (same) return { action: 'none' };
  if (existing.is_inner)
    return {
      problem: `pack:${pack.name}: Other packs are made of ${existing.name}; change its quantity in the dashboard.`,
    };
  if (existing.bundle_sku)
    return {
      problem: `pack:${pack.name}: ${existing.name} is used by a bundle (${existing.bundle_sku}). Change the bundle first.`,
    };
  return { action: 'change' };
}

/** Pack columns checked against the packs the matched variants already have. */
async function checkPacks(ctx: PreviewContext, rows: PreviewRow[]) {
  const packed = rows.filter((r) => r.data?.packs?.length);
  const existing = await loadExistingPacks(
    ctx.tx,
    packed.flatMap((r) => (r.variantId ? [r.variantId] : [])),
  );
  for (const r of packed) {
    const own = existing.filter((p) => p.variant_id === r.variantId);
    let added = 0;
    for (const pack of r.data!.packs!) {
      const plan = planPack(
        pack,
        own.find((p) => p.name.toLowerCase() === pack.name.toLowerCase()),
      );
      if ('problem' in plan) r.errors.push(plan.problem);
      else if (plan.action === 'create') added++;
    }
    if (own.length + added > PACK_LIMITS.perVariant)
      r.errors.push(`A variant has at most ${PACK_LIMITS.perVariant} packs.`);
    if (r.errors.length) {
      r.action = 'error';
      r.data = null;
    }
  }
}

/** A supplier SKU another variant has with the same supplier is an error, as in save_item. */
async function checkSupplierSkus(ctx: PreviewContext, rows: PreviewRow[]) {
  const skus = rows.filter((r) => r.data?.supplier?.sku);
  if (skus.length === 0) return;
  const owners = await ctx.tx.query<{
    supplier_id: string;
    supplier_sku_normalized: string;
    variant_id: string;
    sku: string;
  }>(
    `select i.supplier_id, i.supplier_sku_normalized, i.variant_id, v.sku
     from supplier_items i
     join unnest($1::uuid[], $2::text[]) as x(supplier_id, n)
       on x.supplier_id = i.supplier_id and x.n = i.supplier_sku_normalized
     join variants v on v.shop_id = i.shop_id and v.id = i.variant_id
     where i.status = 'active'`,
    [skus.map((r) => r.data!.supplier!.id), skus.map((r) => normalizeSku(r.data!.supplier!.sku!))],
  );
  for (const r of skus) {
    const supplier = r.data!.supplier!;
    const owner = owners.find(
      (o) =>
        o.supplier_id === supplier.id &&
        o.supplier_sku_normalized === normalizeSku(supplier.sku!) &&
        o.variant_id !== r.variantId,
    );
    if (owner)
      rowError(r, `supplier_sku: ${supplier.name} already uses ${supplier.sku} for ${owner.sku}.`);
  }
}

/**
 * A barcode another variant or pack holds is an error, as on every create path; one the row's own
 * variant already has needs no change.
 */
async function checkBarcodeOwners(ctx: PreviewContext, rows: PreviewRow[]) {
  const codes = (r: PreviewRow) => [
    ...(r.data?.variant.barcode
      ? [{ column: 'barcode', pack: null, barcode: r.data.variant.barcode }]
      : []),
    ...(r.data?.packs ?? []).flatMap((p) =>
      p.barcode ? [{ column: `pack_barcode:${p.name}`, pack: p, barcode: p.barcode }] : [],
    ),
  ];
  const coded = rows.filter((r) => codes(r).length > 0);
  if (coded.length === 0) return;
  const owners = new Map(
    (
      await findBarcodeOwners(
        ctx.tx,
        coded.flatMap((r) => codes(r).map((c) => c.barcode.normalized)),
      )
    ).map((o) => [normalizeBarcode(o.code), o]),
  );
  for (const r of coded) {
    const problems: string[] = [];
    for (const { column, pack, barcode } of codes(r)) {
      const owner = owners.get(barcode.normalized);
      if (!owner) continue;
      // The record the column is for already has it: nothing to add.
      const own =
        owner.variantId === r.variantId &&
        (pack === null
          ? owner.packId === null
          : owner.packName?.toLowerCase() === pack.name.toLowerCase());
      if (own) {
        if (pack) delete pack.barcode;
        else delete r.data!.variant.barcode;
        continue;
      }
      problems.push(
        `${column}: ${barcode.code} already belongs to ${owner.sku}${owner.packName ? ` (${owner.packName})` : ''}.`,
      );
    }
    for (const p of problems) r.errors.push(p);
    if (problems.length) {
      r.action = 'error';
      r.data = null;
    }
  }
}

/** Rules across the rows of one new product: a name, distinct option combinations, required fields. */
async function checkGroups(ctx: PreviewContext, rows: PreviewRow[]) {
  const groups = new Map<string, PreviewRow[]>();
  for (const r of rows)
    if (r.action === 'create') groups.set(r.groupKey, [...(groups.get(r.groupKey) ?? []), r]);
  const required = new Map<string, Array<{ id: string; key: string; level: string }>>();
  for (const f of ctx.families) {
    const rowsReq = await ctx.tx.query<{ field_id: string }>(
      'select field_id from family_fields where family_id = $1 and required',
      [f.id],
    );
    required.set(
      f.id,
      rowsReq
        .map((x) => ctx.fields.find((d) => d.id === x.field_id))
        .filter((d): d is StoredField => Boolean(d))
        .map((d) => ({ id: d.id, key: d.key, level: d.level })),
    );
  }
  const names: string[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const fail = (message: string) => {
      for (const r of group) {
        r.action = 'error';
        r.errors.push(message);
        r.data = null;
      }
    };
    if (!first.data!.product.name) {
      fail('A new product needs a name in its first row.');
      continue;
    }
    names.push(first.data!.product.name);
    if (group.length > 2048) {
      fail('A product has at most 2,048 variants.');
      continue;
    }
    const optionNames = [...new Set(group.flatMap((r) => r.data!.options.map((o) => o.name)))];
    if (optionNames.length > 3) {
      fail('A product has at most 3 options.');
      continue;
    }
    if (group.length > 1 || optionNames.length > 0) {
      const combos = new Set<string>();
      for (const r of group) {
        const values = optionNames.map(
          (n) => r.data!.options.find((o) => o.name === n)?.value ?? '',
        );
        if (values.some((v) => v === '')) {
          r.errors.push(`Give a value for every option (${optionNames.join(', ')}).`);
        } else if (combos.has(values.join('\u0000').toLowerCase())) {
          r.errors.push('Another row of this product has the same option values.');
        }
        combos.add(values.join('\u0000').toLowerCase());
      }
      if (group.some((r) => r.errors.length)) {
        fail('Fix the option values of this product.');
        continue;
      }
    }
    const status = first.data!.product.status ?? 'active';
    const familyId = first.data!.product.familyId;
    if (status === 'active' && familyId) {
      const missing = (required.get(familyId) ?? []).filter((f) =>
        f.level === 'variant'
          ? group.some(
              (r) =>
                r.data!.variant.attributes[f.id] === undefined &&
                !r.data!.relations.some((x) => x.fieldId === f.id),
            )
          : first.data!.product.attributes[f.id] === undefined &&
            !first.data!.relations.some((x) => x.fieldId === f.id),
      );
      if (missing.length)
        fail(
          `Required in this family: ${missing.map((m) => m.key).join(', ')} (or import it as a draft).`,
        );
    }
  }
  // Likely duplicates by name (plan 5.7): shown in the preview, not blocking.
  if (names.length > 0) {
    const similar = await ctx.tx.query<{ name: string; existing: string }>(
      `select n.name, p.name as existing from unnest($1::text[]) as n(name)
       join products p on p.name % n.name and similarity(p.name, n.name) >= 0.6 and p.status <> 'archived'`,
      [names],
    );
    for (const group of groups.values()) {
      const first = group[0]!;
      const hits = similar
        .filter((s) => s.name === first.data?.product.name)
        .map((s) => s.existing);
      if (hits.length)
        first.warnings.push(`Similar to existing: ${[...new Set(hits)].slice(0, 3).join(', ')}.`);
    }
  }
}
