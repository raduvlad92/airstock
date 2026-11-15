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
import { decimalScale, isDecimal, normalize } from './decimal.ts';
import { encodeValue, type FieldDefinition } from './fields.ts';
import { builtin, encodeDimensions, encodePrice, encodeTags } from './records.ts';
import type { StoredField } from './store.ts';

/**
 * CSV import (plan Section 5.12, ADR 0018): map columns, validate every row with the same encoder as
 * every other write path, group variant rows into products, and store each row's validated values
 * so the commit only writes.
 */

export const IMPORT_LIMITS = { bytes: 20 * 1024 * 1024, rows: 50_000, chunkRows: 200 } as const;

/** Columns a file can map to, besides field:<key>, option:<name>, and stock:<locationId>. */
export const BUILTIN_TARGETS = [
  'product',
  'name',
  'description',
  'status',
  'family',
  'tags',
  'sku',
  'barcode',
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

/** Suggested mapping: headers that name a built-in, a field key or label, or option:/stock: columns. */
export function suggestMapping(header: string[], fields: FieldDefinition[]): Mapping {
  const out: Mapping = {};
  for (const h of header) {
    const t = h.trim();
    const lower = t.toLowerCase();
    const byBuiltin = (BUILTIN_TARGETS as readonly string[]).find(
      (b) =>
        b === lower ||
        (b === 'product' && lower === 'product_id') ||
        (b === 'barcode' && BARCODE_HEADERS.includes(lower)),
    );
    const field = fields.find((f) => f.key === lower || f.label.toLowerCase() === lower);
    if (byBuiltin) out[t] = byBuiltin;
    else if (field) out[t] = `field:${field.key}`;
    else if (/^option:/i.test(t)) out[t] = `option:${t.slice(7).trim()}`;
    else if (/^stock:/i.test(t)) out[t] = `stock:${t.slice(6).trim()}`;
    else out[t] = 'ignore';
  }
  return out;
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
  for (const c of columns) {
    if (c.target.startsWith('field:') && !fieldByKey.has(c.target.slice(6))) {
      throw new Error(`Column "${c.header}" maps to an unknown field ${c.target.slice(6)}.`);
    }
    if (c.target.startsWith('stock:') && !ctx.locations.has(c.target.slice(6))) {
      throw new Error(`Column "${c.header}" maps to a location you cannot receive into.`);
    }
  }
  // Existing SKUs in one query.
  const skus = rows.map((r) => normalizeSku(r[skuColumn.index] ?? ''));
  const existing = new Map(
    (
      await ctx.tx.query<{
        sku_normalized: string;
        id: string;
        product_id: string;
        quantity_scale: number;
      }>(
        `select sku_normalized, id, product_id, quantity_scale from variants where sku_normalized = any($1::text[])`,
        [skus.filter(Boolean)],
      )
    ).map((r) => [r.sku_normalized, r]),
  );
  const seen = new Map<string, number>();
  const seenBarcodes = new Map<string, number>();
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
    };
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
      } else if (t === 'barcode') {
        const checked = checkBarcode(value, inferSymbology(value));
        if (!checked.ok) fail(checked.message);
        else if (seenBarcodes.has(checked.normalized))
          fail(`The barcode repeats row ${seenBarcodes.get(checked.normalized)}.`);
        else {
          seenBarcodes.set(checked.normalized, rowNumber);
          data.variant.barcode = {
            code: checked.code,
            normalized: checked.normalized,
            symbology: inferSymbology(value),
          };
        }
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
  await checkBarcodeOwners(ctx, out);
  await checkGroups(ctx, out);
  return out;
}

/**
 * A barcode another variant or pack holds is an error, as on every create path; one the row's own
 * variant already has needs no change.
 */
async function checkBarcodeOwners(ctx: PreviewContext, rows: PreviewRow[]) {
  const coded = rows.filter((r) => r.data?.variant.barcode);
  if (coded.length === 0) return;
  const owners = new Map(
    (
      await findBarcodeOwners(
        ctx.tx,
        coded.map((r) => r.data!.variant.barcode!.normalized),
      )
    ).map((o) => [normalizeBarcode(o.code), o]),
  );
  for (const r of coded) {
    const barcode = r.data!.variant.barcode!;
    const owner = owners.get(barcode.normalized);
    if (!owner) continue;
    if (owner.variantId === r.variantId && owner.packId === null) {
      delete r.data!.variant.barcode;
      continue;
    }
    r.errors.push(
      `barcode: ${barcode.code} already belongs to ${owner.sku}${owner.packName ? ` (${owner.packName})` : ''}.`,
    );
    r.action = 'error';
    r.data = null;
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
