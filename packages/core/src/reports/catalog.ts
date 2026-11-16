/**
 * The eight standard reports (PRD 3.5, plan Section 5.15): names, descriptions, groupings, and
 * which filters each takes. Pure data, shared by the operations and the dashboard.
 */

export const REPORT_TYPES = [
  'stock_on_hand',
  'low_stock',
  'movements',
  'inventory_value',
  'cost_of_goods',
  'purchasing',
  'expiring_lots',
  'shortages',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_GROUPS = [
  'position',
  'variant',
  'location',
  'warehouse',
  'category',
  'family',
  'entry',
  'type',
  'line',
  'order',
  'supplier',
  'lot',
  'rule',
] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

export const MOVEMENT_TYPES = [
  'receipt',
  'transfer',
  'fulfillment',
  'adjustment',
  'return',
  'count',
  'condition_change',
  'reversal',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export type ReportFilterKey =
  | 'warehouseId'
  | 'locationId'
  | 'familyId'
  | 'categoryId'
  | 'supplierId'
  | 'variantId'
  | 'search'
  | 'condition'
  | 'at'
  | 'from'
  | 'to'
  | 'days'
  | 'movementType'
  | 'overdueOnly';

export interface ReportInfo {
  type: ReportType;
  title: string;
  /** One sentence for the reports list. */
  summary: string;
  /** Costs and values need `costs.read`: the whole report, or only some columns. */
  costs: 'required' | 'columns' | 'none';
  groups: readonly ReportGroup[];
  defaultGroup: ReportGroup;
  filters: readonly ReportFilterKey[];
}

const CATALOG_FILTERS = ['familyId', 'categoryId', 'supplierId', 'variantId', 'search'] as const;
const PLACE_FILTERS = ['warehouseId', 'locationId'] as const;

export const REPORTS: Record<ReportType, ReportInfo> = {
  stock_on_hand: {
    type: 'stock_on_hand',
    title: 'Stock on hand',
    summary:
      'Units by variant, location, condition, and lot in base units with a pack breakdown, with what is reserved and available now.',
    costs: 'columns',
    groups: ['position', 'variant', 'location'],
    defaultGroup: 'position',
    filters: [...PLACE_FILTERS, ...CATALOG_FILTERS, 'condition'],
  },
  low_stock: {
    type: 'low_stock',
    title: 'Low stock',
    summary:
      'Variants at or below their reorder point, with what is on order and a suggested reorder.',
    costs: 'columns',
    groups: ['rule'],
    defaultGroup: 'rule',
    filters: [...PLACE_FILTERS, ...CATALOG_FILTERS],
  },
  movements: {
    type: 'movements',
    title: 'Movements',
    summary:
      'Receipts, transfers, fulfillments, adjustments, returns, and counts over a period, by variant, location, or type, or every entry.',
    costs: 'columns',
    groups: ['variant', 'location', 'type', 'entry'],
    defaultGroup: 'variant',
    filters: [...PLACE_FILTERS, ...CATALOG_FILTERS, 'from', 'to', 'movementType'],
  },
  inventory_value: {
    type: 'inventory_value',
    title: 'Inventory value',
    summary:
      'Units times the moving average cost by location, warehouse, category, family, or variant, now or at any past date.',
    costs: 'required',
    groups: ['location', 'warehouse', 'category', 'family', 'variant'],
    defaultGroup: 'location',
    filters: [...PLACE_FILTERS, ...CATALOG_FILTERS, 'at'],
  },
  cost_of_goods: {
    type: 'cost_of_goods',
    title: 'Cost of goods',
    summary: 'The cost of units fulfilled over a period, at the cost each fulfillment recorded.',
    costs: 'required',
    groups: ['variant', 'location', 'warehouse', 'category', 'family'],
    defaultGroup: 'variant',
    filters: [...PLACE_FILTERS, ...CATALOG_FILTERS, 'from', 'to'],
  },
  purchasing: {
    type: 'purchasing',
    title: 'Purchasing',
    summary: 'Open purchase orders, what is still on order, and receipts that are overdue.',
    costs: 'columns',
    groups: ['line', 'order', 'variant', 'supplier'],
    defaultGroup: 'line',
    filters: [...PLACE_FILTERS, ...CATALOG_FILTERS, 'overdueOnly'],
  },
  expiring_lots: {
    type: 'expiring_lots',
    title: 'Expiring lots',
    summary:
      'Lots with stock that expire within a chosen number of days, including those already past.',
    costs: 'columns',
    groups: ['lot', 'position'],
    defaultGroup: 'lot',
    filters: [...PLACE_FILTERS, ...CATALOG_FILTERS, 'days'],
  },
  shortages: {
    type: 'shortages',
    title: 'Shortages',
    summary:
      'Open shortages: demand from orders accepted by a sales channel that no stock covers yet.',
    costs: 'none',
    groups: ['order', 'variant'],
    defaultGroup: 'order',
    filters: [...PLACE_FILTERS, ...CATALOG_FILTERS],
  },
};

export const GROUP_LABELS: Record<ReportGroup, string> = {
  position: 'Variant, location, condition, and lot',
  variant: 'Variant',
  location: 'Location',
  warehouse: 'Warehouse',
  category: 'Category',
  family: 'Family',
  entry: 'Each entry',
  type: 'Movement type',
  line: 'Order line',
  order: 'Order',
  supplier: 'Supplier',
  lot: 'Lot',
  rule: 'Reorder rule',
};

/** How a report column's values read: decimals and dates travel as strings. */
export type ReportColumnType =
  | 'text'
  | 'quantity'
  | 'money'
  | 'integer'
  | 'date'
  | 'datetime'
  | 'boolean';

export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
  /** Shown only with costs.read. */
  cost?: boolean;
  /** Summed in the totals row. */
  total?: boolean;
}
