import type { ops } from '@airstock/core';
import { encodeValue } from '@airstock/core/catalog/fields';
import type { Out } from '../api.ts';
import { formatDecimal } from '../components/ui.tsx';
import { asDefinition, type CatalogSchema, type Column, type Mode } from './schema.ts';

export type QueryResult = Out<typeof ops.queryItems>;
export type Row = QueryResult['rows'][number];

/** The stock column: on hand at the shelf the grid shows stock for, typed as a count (G5). */
export const STOCK_AT = 'stock_at';

/** A row's identity in the grid: the variant in variants mode, the product in products mode. */
export const rowId = (row: Row) => row.variantId ?? row.productId;

export interface CellValue {
  /** The stored value, sent back as `expected` when the cell is edited. */
  raw: unknown;
  display: string;
  source: 'own' | 'inherited' | 'cleared' | 'none';
}

function measurementText(v: unknown): string {
  if (!v || typeof v !== 'object') return '';
  const m = v as { value?: string; unit?: string };
  return m.value !== undefined ? `${formatDecimal(m.value)} ${m.unit ?? ''}`.trim() : '';
}

export function cellValue(
  row: Row,
  column: Column,
  schema: CatalogSchema | undefined,
  mode: Mode,
): CellValue {
  const own = (raw: unknown, display: string): CellValue => ({
    raw,
    display,
    source: raw === null || raw === undefined ? 'none' : 'own',
  });
  if (!column.builtin) {
    const v = row.values[column.key];
    if (!v) return { raw: null, display: '', source: 'none' };
    return { raw: v.value, display: v.display ?? '', source: v.source };
  }
  switch (column.key) {
    case 'name':
      return own(row.name, row.name);
    case 'sku':
      return own(row.sku, row.sku ?? '');
    case 'title':
      return own(row.title, row.title);
    case 'price':
      if (mode === 'products') {
        const r = row.priceRange;
        const text = !r?.min
          ? ''
          : r.min === r.max
            ? formatDecimal(r.min, 2)
            : `${formatDecimal(r.min, 2)} – ${formatDecimal(r.max, 2)}`;
        return own(r?.min ?? null, text);
      }
      return own(row.price, row.price ? formatDecimal(row.price, 2) : '');
    case 'available':
      return own(row.available, row.available === null ? '' : formatDecimal(row.available));
    case STOCK_AT:
      return own(row.stockAt?.onHand ?? null, row.stockAt ? formatDecimal(row.stockAt.onHand) : '');
    case 'status':
      return own(row.productStatus, row.productStatus);
    case 'family': {
      const family = schema?.families.find((f) => f.id === row.familyId);
      return own(row.familyId, family?.name ?? '');
    }
    case 'tags':
      return own(row.tags, row.tags.join(', '));
    case 'weight': {
      const v = row.values.weight;
      return v
        ? { raw: v.value, display: measurementText(v.value), source: v.source }
        : own(null, '');
    }
    case 'skus':
      return own(row.skus, (row.skus ?? []).join(', ') + ((row.variantCount ?? 0) > 3 ? '…' : ''));
    case 'variantCount':
      return own(row.variantCount, String(row.variantCount ?? ''));
    default:
      return own(null, '');
  }
}

/** Text shown in the cell editor for a stored value. */
export function editText(column: Column, raw: unknown, schema: CatalogSchema | undefined): string {
  if (raw === null || raw === undefined) return '';
  if (column.key === STOCK_AT) return formatDecimal(String(raw));
  const field = column.field;
  switch (column.kind) {
    case 'measurement':
      return measurementText(raw);
    case 'money':
      return typeof raw === 'object'
        ? formatDecimal((raw as { amount: string }).amount)
        : formatDecimal(String(raw));
    case 'number':
      return String(raw);
    case 'select':
      return field?.options.find((o) => o.id === raw)?.label ?? String(raw);
    case 'multi':
      return (raw as string[])
        .map((id) => field?.options.find((o) => o.id === id)?.label ?? id)
        .join('; ');
    case 'tags':
      return (raw as string[]).join(', ');
    case 'family':
      return schema?.families.find((f) => f.id === raw)?.name ?? '';
    case 'boolean':
      return raw ? 'Yes' : 'No';
    default:
      return String(raw);
  }
}

export type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * Turns what was typed or pasted into the value sent to the API. Custom fields run the same
 * encoder as the server, so mistakes show before anything is sent.
 */
export function parseInput(
  column: Column,
  text: string,
  schema: CatalogSchema | undefined,
): Parsed {
  const t = text.trim();
  if (column.field) {
    const encoded = encodeValue(asDefinition(column.field), t === '' ? null : t, {
      currency: schema?.currency ?? 'EUR',
    });
    return encoded.ok
      ? { ok: true, value: encoded.value }
      : { ok: false, message: encoded.message };
  }
  switch (column.key) {
    case 'name':
    case 'sku':
      return t ? { ok: true, value: t } : { ok: false, message: 'A value is required.' };
    case 'price':
      if (t === '') return { ok: true, value: null };
      return /^\d+(\.\d{1,4})?$/.test(t)
        ? { ok: true, value: t }
        : { ok: false, message: 'Use a price such as 19.90.' };
    case 'tags':
      return {
        ok: true,
        value: t
          ? t
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean)
          : [],
      };
    case 'family': {
      if (t === '') return { ok: true, value: null };
      const family = schema?.families.find(
        (f) => f.name.toLowerCase() === t.toLowerCase() || f.id === t,
      );
      return family ? { ok: true, value: family.id } : { ok: false, message: `No family "${t}".` };
    }
    case STOCK_AT:
      return /^\d+(\.\d{1,6})?$/.test(t)
        ? { ok: true, value: t }
        : {
            ok: false,
            message: 'Type the units on the shelf, such as 12 (0 when there are none).',
          };
    case 'weight':
      if (t === '') return { ok: true, value: null };
      return /^\d+(\.\d+)?\s*(g|kg|oz|lb)$/i.test(t)
        ? { ok: true, value: t }
        : { ok: false, message: 'Use a weight such as 1.2 kg.' };
    default:
      return { ok: false, message: 'This column cannot be edited.' };
  }
}

/** The change for one edited cell, as catalog.items.update and bulk previews take it. */
export function changeFor(mode: Mode, row: Row, column: Column) {
  const field = column.key === 'family' ? 'family' : column.key;
  const onVariant = mode === 'variants' && column.level === 'variant';
  return {
    productId: row.productId,
    ...(onVariant && row.variantId ? { variantId: row.variantId } : {}),
    field,
  };
}

/** Fields a page must ask for so the visible columns have values. */
export function requestedFields(columns: Column[]): string[] {
  return columns
    .filter((c) => !c.builtin || c.key === 'weight' || c.key === 'available')
    .map((c) => c.key);
}
