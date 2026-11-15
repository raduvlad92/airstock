import type { ops } from '@airstock/core';
import type { FieldDefinition } from '@airstock/core/catalog/fields';
import { useQuery } from '@tanstack/react-query';
import { api, type Out } from '../api.ts';

export type CatalogSchema = Out<typeof ops.describeCatalog>;
export type SchemaField = CatalogSchema['fields'][number];
export type Mode = 'variants' | 'products';

export function useCatalogSchema(shopId: string) {
  return useQuery({
    queryKey: ['shop', shopId, 'schema'],
    queryFn: () => api<CatalogSchema>(`/shops/${shopId}/catalog/schema`),
    staleTime: 60_000,
  });
}

/** The schema's field as the shared encoder expects it (packages/core/src/catalog/fields.ts). */
export function asDefinition(f: SchemaField): FieldDefinition {
  return {
    id: f.id,
    key: f.key,
    label: f.label,
    type: f.type,
    level: f.level,
    config: f.config as FieldDefinition['config'],
    defaultValue: f.defaultValue,
    visibility: f.visibility,
    status: f.status,
    isSystem: f.isSystem,
    version: f.version,
    options: f.options,
  };
}

/** How a column reads, shows, and edits its value. */
export type ColumnKind =
  | 'text'
  | 'number'
  | 'money'
  | 'measurement'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'select'
  | 'multi'
  | 'tags'
  | 'family'
  | 'readonly';

export interface Column {
  key: string;
  label: string;
  kind: ColumnKind;
  /** Where an edit lands in variants mode: on the product, or on the variant. */
  level: 'product' | 'variant';
  editable: boolean;
  /** Sortable on the server. */
  sortable: boolean;
  defaultWidth: number;
  field?: SchemaField;
  /** Built-in fields read from the row itself; custom ones from row.values. */
  builtin: boolean;
}

const KIND: Record<SchemaField['type'], ColumnKind> = {
  text: 'text',
  rich_text: 'text',
  integer: 'number',
  decimal: 'number',
  money: 'money',
  measurement: 'measurement',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'timestamp',
  single_select: 'select',
  multi_select: 'multi',
  file: 'readonly',
  relationship: 'readonly',
};

/** Columns available in a mode: built-ins first, then active custom fields. */
export function columnsFor(
  mode: Mode,
  schema: CatalogSchema | undefined,
  canWrite: boolean,
): Column[] {
  const b = (
    key: string,
    label: string,
    kind: ColumnKind,
    level: 'product' | 'variant',
    width: number,
    opts: Partial<Column> = {},
  ): Column => ({
    key,
    label,
    kind,
    level,
    editable: canWrite && kind !== 'readonly',
    sortable: true,
    defaultWidth: width,
    builtin: true,
    ...opts,
  });
  const builtins: Column[] =
    mode === 'variants'
      ? [
          b('name', 'Name', 'text', 'product', 240),
          b('sku', 'SKU', 'text', 'variant', 140),
          b('title', 'Options', 'readonly', 'variant', 140, { sortable: false }),
          b('price', 'Price', 'money', 'variant', 100),
          b('available', 'Available', 'readonly', 'variant', 100),
          b('status', 'Status', 'readonly', 'product', 90, { sortable: true }),
          b('family', 'Family', 'family', 'product', 140),
          b('tags', 'Tags', 'tags', 'product', 160, { sortable: false }),
          b('weight', 'Weight', 'measurement', 'variant', 100),
        ]
      : [
          b('name', 'Name', 'text', 'product', 260),
          b('skus', 'SKUs', 'readonly', 'product', 180, { sortable: false }),
          b('variantCount', 'Variants', 'readonly', 'product', 90, { sortable: false }),
          b('price', 'Price', 'readonly', 'product', 120),
          b('status', 'Status', 'readonly', 'product', 90),
          b('family', 'Family', 'family', 'product', 140),
          b('tags', 'Tags', 'tags', 'product', 160, { sortable: false }),
        ];
  const custom = (schema?.fields ?? [])
    .filter((f) => f.status === 'active')
    .filter((f) => mode === 'variants' || f.level !== 'variant' || true)
    .map<Column>((f) => {
      const kind = KIND[f.type];
      // In products mode, variant-level values are summaries and not edited in place.
      const editable =
        canWrite && kind !== 'readonly' && !(mode === 'products' && f.level === 'variant');
      return {
        key: f.key,
        label: f.label,
        kind,
        level: f.level === 'product' ? 'product' : 'variant',
        editable,
        sortable: !['multi', 'readonly'].includes(kind) && f.type !== 'rich_text',
        defaultWidth: kind === 'text' ? 180 : 130,
        field: f,
        builtin: false,
      };
    });
  return [...builtins, ...custom];
}

export const DEFAULT_COLUMNS: Record<Mode, string[]> = {
  variants: ['name', 'sku', 'title', 'price', 'available', 'brand', 'category', 'status'],
  products: ['name', 'skus', 'variantCount', 'price', 'brand', 'category', 'family', 'status'],
};
