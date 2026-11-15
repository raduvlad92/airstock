/**
 * Label layouts and fields (plan Section 5.4, D9, ADR 0019). Pure constants shared by the
 * `labels.*` operations and the dashboard, which draws the PDF (`@airstock/core/labels`).
 * Sizes are millimetres.
 */

export interface LabelLayout {
  key: LabelLayoutKey;
  label: string;
  page: { width: number; height: number };
  columns: number;
  rows: number;
  labelWidth: number;
  labelHeight: number;
  marginLeft: number;
  marginTop: number;
  gapX: number;
  gapY: number;
  /** Space kept clear inside each label. */
  padding: number;
}

export const LABEL_LAYOUT_KEYS = ['a4_3x8', 'a4_4x10', 'thermal_50x25', 'thermal_100x50'] as const;
export type LabelLayoutKey = (typeof LABEL_LAYOUT_KEYS)[number];

const A4 = { width: 210, height: 297 };

export const LABEL_LAYOUTS: Record<LabelLayoutKey, LabelLayout> = {
  // 24 labels of 70 × 37 mm, the common A4 sheet without side margins.
  a4_3x8: {
    key: 'a4_3x8',
    label: 'A4 sheet, 3 × 8 (70 × 37 mm)',
    page: A4,
    columns: 3,
    rows: 8,
    labelWidth: 70,
    labelHeight: 37,
    marginLeft: 0,
    marginTop: 0.5,
    gapX: 0,
    gapY: 0,
    padding: 3,
  },
  // 40 labels of 52.5 × 29.7 mm, which tile A4 exactly.
  a4_4x10: {
    key: 'a4_4x10',
    label: 'A4 sheet, 4 × 10 (52.5 × 29.7 mm)',
    page: A4,
    columns: 4,
    rows: 10,
    labelWidth: 52.5,
    labelHeight: 29.7,
    marginLeft: 0,
    marginTop: 0,
    gapX: 0,
    gapY: 0,
    padding: 2.5,
  },
  thermal_50x25: {
    key: 'thermal_50x25',
    label: 'Thermal, 50 × 25 mm',
    page: { width: 50, height: 25 },
    columns: 1,
    rows: 1,
    labelWidth: 50,
    labelHeight: 25,
    marginLeft: 0,
    marginTop: 0,
    gapX: 0,
    gapY: 0,
    padding: 1.5,
  },
  thermal_100x50: {
    key: 'thermal_100x50',
    label: 'Thermal, 100 × 50 mm',
    page: { width: 100, height: 50 },
    columns: 1,
    rows: 1,
    labelWidth: 100,
    labelHeight: 50,
    marginLeft: 0,
    marginTop: 0,
    gapX: 0,
    gapY: 0,
    padding: 3,
  },
};

export const LABEL_KINDS = ['item', 'location'] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];

/** Fields an item label can show (PRD 4.7; lot and expiry arrive with lots in Phase 2). */
export const ITEM_LABEL_FIELDS = ['name', 'sku', 'options', 'price', 'pack', 'barcode'] as const;
export type ItemLabelField = (typeof ITEM_LABEL_FIELDS)[number];

export const LOCATION_LABEL_FIELDS = ['path', 'code', 'warehouse', 'barcode'] as const;
export type LocationLabelField = (typeof LOCATION_LABEL_FIELDS)[number];

export const LABEL_FIELD_LABELS: Record<ItemLabelField | LocationLabelField, string> = {
  name: 'Name',
  sku: 'SKU',
  options: 'Options',
  price: 'Price',
  pack: 'Pack',
  barcode: 'Barcode',
  path: 'Location path',
  code: 'Location code',
  warehouse: 'Warehouse',
};

export interface BuiltinTemplate {
  key: string;
  name: string;
  kind: LabelKind;
  layout: LabelLayoutKey;
  fields: string[];
}

/** Templates every shop starts with; a shop saves its own next to them. */
export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    key: 'items_a4_3x8',
    name: 'Product labels, A4 3 × 8',
    kind: 'item',
    layout: 'a4_3x8',
    fields: ['name', 'sku', 'options', 'price', 'pack', 'barcode'],
  },
  {
    key: 'items_a4_4x10',
    name: 'Product labels, A4 4 × 10',
    kind: 'item',
    layout: 'a4_4x10',
    fields: ['name', 'sku', 'options', 'barcode'],
  },
  {
    key: 'items_thermal_50x25',
    name: 'Product labels, thermal 50 × 25 mm',
    kind: 'item',
    layout: 'thermal_50x25',
    fields: ['name', 'sku', 'barcode'],
  },
  {
    key: 'items_thermal_100x50',
    name: 'Product labels, thermal 100 × 50 mm',
    kind: 'item',
    layout: 'thermal_100x50',
    fields: ['name', 'sku', 'options', 'price', 'pack', 'barcode'],
  },
  {
    key: 'locations_a4_3x8',
    name: 'Location labels, A4 3 × 8',
    kind: 'location',
    layout: 'a4_3x8',
    fields: ['path', 'warehouse', 'barcode'],
  },
  {
    key: 'locations_thermal_100x50',
    name: 'Location labels, thermal 100 × 50 mm',
    kind: 'location',
    layout: 'thermal_100x50',
    fields: ['path', 'code', 'warehouse', 'barcode'],
  },
];

export const LABEL_LIMITS = { entries: 500, copies: 100, labels: 2000 } as const;
