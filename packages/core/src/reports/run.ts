import type { Tx } from '@airstock/db';
import { reorderRuleStates } from '../alerts/check.ts';
import { add, compare, normalize } from '../catalog/decimal.ts';
import { Params } from '../catalog/query.ts';
import { type AppError, errors } from '../errors.ts';
import { ruleInScope, suggestReorders } from '../operations/reorder.ts';
import { normalizeSku } from '../schemas.ts';
import {
  GROUP_LABELS,
  type MovementType,
  REPORTS,
  type ReportColumn,
  type ReportFilterKey,
  type ReportGroup,
  type ReportType,
} from './catalog.ts';

// The eight standard reports (PRD 3.5, plan Section 5.15, D15). Each report is a read: a query
// over the stock tables in the caller's shop, limited to their location scope, with costs only
// for costs.read. Rows are sorted by any visible column and paged by keyset; the totals cover
// every row the filters select, not just the page.

export interface ReportFilters {
  warehouseId?: string | undefined;
  locationId?: string | undefined;
  familyId?: string | undefined;
  categoryId?: string | undefined;
  supplierId?: string | undefined;
  variantId?: string | undefined;
  search?: string | undefined;
  condition?: string | undefined;
  at?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  days?: number | undefined;
  movementType?: MovementType | undefined;
  overdueOnly?: boolean | undefined;
  groupBy?: ReportGroup | undefined;
  sort?: string | undefined;
}

export interface ReportEnv {
  tx: Tx;
  /** Null means every location; otherwise the warehouse and location IDs the caller may use. */
  locationScope: string[] | null;
  costs: boolean;
}

export type ReportCell = string | number | boolean | null;
export type ReportRow = Record<string, ReportCell>;

export interface ReportResult {
  report: ReportType;
  title: string;
  groupBy: ReportGroup;
  groupLabel: string;
  sort: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: Record<string, string>;
  rowCount: number;
  nextCursor: string | null;
  partial: boolean;
  costVisible: boolean;
  currency: string;
  at: string | null;
  from: string | null;
  to: string | null;
  days: number | null;
  /** Filters this report does not take; they were left out. */
  ignoredFilters: string[];
}

/** The page size an interactive run allows; exports page through every row. */
export const REPORT_PAGE_MAX = 500;
/** Interactive runs stop here; past it, the person exports the report (a job). */
export const REPORT_STATEMENT_TIMEOUT_MS = 25_000;

interface Column extends ReportColumn {
  /** Computed after the query (such as the pack breakdown): not sortable. */
  computed?: boolean;
}

type Built =
  | {
      kind: 'sql';
      /** CTEs ending in `base`, whose columns are `key` (unique text) and the columns' keys. */
      ctes: string;
      columns: Column[];
      defaultSort: string;
      /** Raw base columns to fetch for computed columns. */
      extra?: string[];
    }
  | { kind: 'rows'; rows: ReportRow[]; columns: Column[]; defaultSort: string };

interface Ctx {
  env: ReportEnv;
  params: Params;
  f: ReportFilters;
  group: ReportGroup;
  times: Times;
  categoryField: string | null;
}

interface Times {
  timezone: string;
  currency: string;
  today: string;
  at: Date | null;
  from: Date;
  to: Date;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function checkMoment(path: string, value: string | undefined): void {
  if (value === undefined) return;
  if (DATE.test(value) && !Number.isNaN(Date.parse(value))) return;
  if (TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))) return;
  throw errors.validation([
    { path, message: 'Use a date (2026-12-01) or an ISO 8601 time with a time zone.' },
  ]);
}

/**
 * Dates are days in the shop's time zone: `at` and `to` mean the end of that day, `from` its
 * start. Timestamps are used as given (`to` is exclusive).
 */
async function resolveTimes(tx: Tx, f: ReportFilters): Promise<Times> {
  checkMoment('at', f.at);
  checkMoment('from', f.from);
  checkMoment('to', f.to);
  const [row] = await tx.query<{
    timezone: string;
    currency: string;
    today: string;
    at: Date | null;
    from: Date;
    to: Date;
  }>(
    `with s as (select timezone, currency from shops where id = app_shop_id()),
     t as (select s.*,
       case when $1::text is null then null
         when $1 ~ '^\\d{4}-\\d{2}-\\d{2}$' then (($1::date + 1)::timestamp at time zone s.timezone)
         else $1::timestamptz end as at,
       case when $3::text is null then now()
         when $3 ~ '^\\d{4}-\\d{2}-\\d{2}$' then (($3::date + 1)::timestamp at time zone s.timezone)
         else $3::timestamptz end as "to"
       from s)
     select t.timezone, t.currency,
       to_char((now() at time zone t.timezone)::date, 'YYYY-MM-DD') as today, t.at, t."to",
       case when $2::text is null then t."to" - interval '30 days'
         when $2 ~ '^\\d{4}-\\d{2}-\\d{2}$' then ($2::date::timestamp at time zone t.timezone)
         else $2::timestamptz end as "from"
     from t`,
    [f.at ?? null, f.from ?? null, f.to ?? null],
  );
  if (!row) throw errors.internal();
  if (row.from >= row.to) {
    throw errors.validation([{ path: 'from', message: 'The period must start before it ends.' }]);
  }
  return row;
}

// Shared pieces ------------------------------------------------------------------------------

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** `vf`: the variants the catalog filters select, with their display name, family, category. */
function variantCte(c: Ctx, opts: { supplierItems: boolean } = { supplierItems: true }): string {
  const p = c.params;
  const conds: string[] = [];
  if (c.f.variantId) conds.push(`v.id = ${p.add(c.f.variantId)}::uuid`);
  if (c.f.familyId) conds.push(`p.family_id = ${p.add(c.f.familyId)}::uuid`);
  if (c.f.categoryId) {
    conds.push(
      c.categoryField
        ? `p.attributes ->> ${p.add(c.categoryField)}::text = ${p.add(c.f.categoryId)}::text`
        : 'false',
    );
  }
  if (c.f.supplierId && opts.supplierItems) {
    conds.push(`exists (select 1 from supplier_items si where si.shop_id = v.shop_id
      and si.variant_id = v.id and si.status = 'active' and si.supplier_id = ${p.add(c.f.supplierId)}::uuid)`);
  }
  if (c.f.search) {
    const sku = `%${likeEscape(normalizeSku(c.f.search))}%`;
    const name = `%${likeEscape(c.f.search.trim())}%`;
    conds.push(`(v.sku_normalized like ${p.add(sku)} or p.name ilike ${p.add(name)})`);
  }
  const category = c.categoryField
    ? `(p.attributes ->> ${p.add(c.categoryField)}::text)`
    : 'null::text';
  return `vf as (
    select v.id as variant_id, v.sku, p.name || coalesce(' – ' || nullif(v.name, ''), '') as item,
      p.family_id, ${category} as category_id
    from variants v join products p on p.shop_id = v.shop_id and p.id = v.product_id
    where ${conds.length > 0 ? conds.join(' and ') : 'true'})`;
}

/** `lf`: the locations in the caller's scope and the place filters, with warehouse names. */
function locationCte(c: Ctx): string {
  const p = c.params;
  const scope = p.add(c.env.locationScope);
  const conds = [`(${scope}::uuid[] is null or l.path_ids && ${scope}::uuid[])`];
  if (c.f.warehouseId) conds.push(`l.warehouse_id = ${p.add(c.f.warehouseId)}::uuid`);
  if (c.f.locationId) conds.push(`l.path_ids @> array[${p.add(c.f.locationId)}::uuid]`);
  return `lf as (
    select l.id as location_id, l.path, l.kind, l.warehouse_id,
      coalesce(w.name, 'In transit') as warehouse
    from locations l left join warehouses w on w.shop_id = l.shop_id and w.id = l.warehouse_id
    where ${conds.join(' and ')})`;
}

const costOr = (c: Ctx, expr: string) => (c.env.costs ? expr : 'null::numeric');

/** Category and family names for grouped rows (`x.category_id`, `x.family_id`). */
const CATEGORY_LABEL = `coalesce((select fo.label from field_options fo
  where fo.shop_id = app_shop_id() and fo.id::text = x.category_id), 'No category')`;
const FAMILY_LABEL = `coalesce((select pf.name from product_families pf
  where pf.shop_id = app_shop_id() and pf.id = x.family_id), 'No family')`;

const q = (key: string, label: string, total = true): Column => ({
  key,
  label,
  type: 'quantity',
  total,
});
const money = (key: string, label: string, total = true): Column => ({
  key,
  label,
  type: 'money',
  cost: true,
  total,
});
const text = (key: string, label: string): Column => ({ key, label, type: 'text' });
const SKU = text('sku', 'SKU');
const PRODUCT = text('product', 'Product');
const LOCATION = text('location', 'Location');
const WAREHOUSE = text('warehouse', 'Warehouse');

// 1. Stock on hand -----------------------------------------------------------------------------

function stockOnHand(c: Ctx): Built {
  const p = c.params;
  const condition = c.f.condition ? `and s.condition = ${p.add(c.f.condition)}` : '';
  const sp = `sp as (
    select s.*, lf.warehouse from stock_positions(array(select variant_id from vf)) s
    join lf on lf.location_id = s.location_id
    where (s.on_hand > 0 or s.reserved > 0) ${condition})`;
  const head = `${variantCte(c)}, ${locationCte(c)}, ${sp}`;
  const packs: Column = { key: 'packs', label: 'In packs', type: 'text', computed: true };
  if (c.group === 'variant') {
    return {
      kind: 'sql',
      ctes: `${head}, base as (
        select s.variant_id::text as key, s.variant_id::text as "_variantId", vf.sku, vf.item as product,
          coalesce(sum(s.on_hand) filter (where s.transfer_id is null), 0) as "onHand",
          coalesce(sum(s.on_hand) filter (where s.condition = 'sellable' and s.transfer_id is null
            and not s.lot_expired), 0) as sellable,
          coalesce(sum(s.reserved), 0) as reserved, coalesce(sum(s.available), 0) as available,
          coalesce(sum(s.on_hand) filter (where s.condition = 'quarantine' and s.transfer_id is null), 0)
            as quarantined,
          coalesce(sum(s.on_hand) filter (where s.condition in ('damaged', 'repair', 'supplier_return')
            and s.transfer_id is null), 0) as damaged,
          coalesce(sum(s.on_hand) filter (where s.lot_expired and s.transfer_id is null), 0) as expired,
          coalesce(sum(s.on_hand) filter (where s.transfer_id is not null), 0) as "inTransit",
          ${costOr(c, 'sum(s.on_hand) * max(vc.average_cost)')} as value
        from sp s join vf on vf.variant_id = s.variant_id
        left join variant_costs vc on vc.shop_id = app_shop_id() and vc.variant_id = s.variant_id
        group by s.variant_id, vf.sku, vf.item)`,
      columns: [
        SKU,
        PRODUCT,
        q('onHand', 'On hand'),
        packs,
        q('sellable', 'Sellable'),
        q('reserved', 'Reserved'),
        q('available', 'Available'),
        q('quarantined', 'Quarantined'),
        q('damaged', 'Damaged or in repair'),
        q('expired', 'Expired'),
        q('inTransit', 'In transit'),
        money('value', 'Value'),
      ],
      defaultSort: 'sku',
      extra: ['_variantId'],
    };
  }
  if (c.group === 'location') {
    return {
      kind: 'sql',
      ctes: `${head}, base as (
        select s.location_id::text as key, s.location_path as location, s.warehouse,
          count(distinct s.variant_id) filter (where s.on_hand > 0)::int as variants,
          sum(s.on_hand) as "onHand", sum(s.reserved) as reserved, sum(s.available) as available,
          ${costOr(c, 'sum(s.on_hand * vc.average_cost)')} as value
        from sp s
        left join variant_costs vc on vc.shop_id = app_shop_id() and vc.variant_id = s.variant_id
        group by s.location_id, s.location_path, s.warehouse)`,
      columns: [
        LOCATION,
        WAREHOUSE,
        { key: 'variants', label: 'Variants', type: 'integer', total: true },
        q('onHand', 'On hand'),
        q('reserved', 'Reserved'),
        q('available', 'Available'),
        money('value', 'Value'),
      ],
      defaultSort: 'location',
    };
  }
  return {
    kind: 'sql',
    ctes: `${head}, base as (
      select s.variant_id::text || ':' || s.location_id::text || ':' || s.condition || ':'
          || coalesce(s.lot_id::text, '-') as key,
        s.variant_id::text as "_variantId", vf.sku, vf.item as product, s.location_path as location,
        s.warehouse, s.condition, lt.code as lot, lt.expires_on as "expiresOn",
        sum(s.on_hand) as "onHand", sum(s.reserved) as reserved, sum(s.available) as available,
        ${costOr(c, 'sum(s.on_hand) * max(vc.average_cost)')} as value
      from sp s join vf on vf.variant_id = s.variant_id
      left join lots lt on lt.shop_id = app_shop_id() and lt.id = s.lot_id
      left join variant_costs vc on vc.shop_id = app_shop_id() and vc.variant_id = s.variant_id
      group by s.variant_id, s.location_id, s.location_path, s.warehouse, s.condition, s.lot_id,
        vf.sku, vf.item, lt.code, lt.expires_on)`,
    columns: [
      SKU,
      PRODUCT,
      LOCATION,
      WAREHOUSE,
      text('condition', 'Condition'),
      text('lot', 'Lot'),
      { key: 'expiresOn', label: 'Expires', type: 'date' },
      q('onHand', 'On hand'),
      packs,
      q('reserved', 'Reserved'),
      q('available', 'Available'),
      money('value', 'Value'),
    ],
    defaultSort: 'sku',
    extra: ['_variantId'],
  };
}

// 2. Low stock ---------------------------------------------------------------------------------

async function lowStock(c: Ctx): Promise<Built> {
  const { tx } = c.env;
  let variantIds: string[] | null = null;
  if (c.f.variantId || c.f.familyId || c.f.categoryId || c.f.supplierId || c.f.search) {
    const rows = await tx.query<{ variant_id: string }>(
      `with ${variantCte(c)} select variant_id from vf`,
      c.params.values,
    );
    variantIds = rows.map((r) => r.variant_id);
  }
  const states =
    variantIds && variantIds.length === 0
      ? []
      : (await reorderRuleStates(tx, variantIds))
          .filter((s) => s.low)
          .filter((s) => ruleInScope(c.env.locationScope, s))
          .filter((s) => !c.f.warehouseId || s.warehouseId === c.f.warehouseId)
          .filter((s) => !c.f.locationId || s.scopeIds.includes(c.f.locationId));
  const suggestions = await suggestReorders(tx, states, c.env.costs);
  const rows: ReportRow[] = suggestions.map(({ state: s, need, supplier, line }) => {
    const ordering = compare(need, '0') > 0 && line !== null;
    return {
      key: s.ruleId,
      sku: s.sku,
      product: s.productName,
      warehouse: s.warehouseName,
      location: s.locationPath,
      available: normalize(s.available),
      onOrder: normalize(s.onOrder),
      reorderPoint: normalize(s.reorderPoint),
      reorderQuantity: s.reorderQuantity === null ? null : normalize(s.reorderQuantity),
      maximumLevel: s.maximumLevel === null ? null : normalize(s.maximumLevel),
      need: compare(need, '0') > 0 ? need : '0',
      supplier: supplier?.name ?? null,
      supplierSku: line?.supplierSku ?? null,
      orderQuantity: ordering ? line.quantity : null,
      orderUnit: ordering ? (line.packName ?? 'Units') : null,
      orderedUnits: ordering ? line.ordered : null,
      unitCost: c.env.costs && line?.unitCost ? normalize(line.unitCost) : null,
      orderValue:
        c.env.costs && ordering && line.unitCost
          ? normalize(multiplyExact(line.quantity, line.unitCost))
          : null,
    };
  });
  return {
    kind: 'rows',
    rows,
    columns: [
      SKU,
      PRODUCT,
      WAREHOUSE,
      LOCATION,
      q('available', 'Available'),
      q('onOrder', 'On order'),
      q('reorderPoint', 'Reorder point', false),
      q('reorderQuantity', 'Reorder quantity', false),
      q('maximumLevel', 'Maximum level', false),
      q('need', 'Needed'),
      text('supplier', 'Supplier'),
      text('supplierSku', 'Supplier SKU'),
      q('orderQuantity', 'Suggested order', false),
      text('orderUnit', 'Order unit'),
      q('orderedUnits', 'Suggested units'),
      money('unitCost', 'Unit cost', false),
      money('orderValue', 'Order value'),
    ],
    defaultSort: 'sku',
  };
}

function multiplyExact(a: string, b: string): string {
  const [wa = '0', fa = ''] = a.split('.');
  const [wb = '0', fb = ''] = b.split('.');
  const units = BigInt(wa + fa) * BigInt(wb + fb);
  const scale = fa.length + fb.length;
  const digits = units.toString().padStart(scale + 1, '0');
  return scale > 0 ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
}

// 3. Movements ---------------------------------------------------------------------------------

/** A movement's type from its operation kind: dispatch and receipt are both transfers. */
const MOVEMENT_TYPE = `case when o.kind in ('transfer_dispatch', 'transfer_receipt') then 'transfer'
  else o.kind end`;

function movements(c: Ctx): Built {
  const p = c.params;
  const type = c.f.movementType ? `and ${MOVEMENT_TYPE} = ${p.add(c.f.movementType)}` : '';
  // Units in transit are in stock on hand; here transfers count where they leave and arrive.
  const mv = `mv as (
    select e.id, e.variant_id, e.location_id, e.delta, e.unit_cost, e.lot_id, e.created_at,
      ${MOVEMENT_TYPE} as type, o.kind, coalesce(o.external_ref, o.reason) as reference,
      lf.path, lf.warehouse
    from inventory_entries e
    join inventory_operations o on o.shop_id = e.shop_id and o.id = e.operation_id
    join lf on lf.location_id = e.location_id and lf.kind = 'storage'
    where e.created_at >= ${p.add(c.times.from)}::timestamptz
      and e.created_at < ${p.add(c.times.to)}::timestamptz ${type})`;
  const head = `${variantCte(c)}, ${locationCte(c)}, ${mv}`;
  const byType = `
    coalesce(sum(m.delta) filter (where m.type = 'receipt'), 0) as received,
    coalesce(sum(m.delta) filter (where m.type = 'transfer' and m.delta > 0), 0) as "transferredIn",
    coalesce(sum(m.delta) filter (where m.type = 'transfer' and m.delta < 0), 0) as "transferredOut",
    coalesce(sum(m.delta) filter (where m.type = 'fulfillment'), 0) as fulfilled,
    coalesce(sum(m.delta) filter (where m.type = 'adjustment'), 0) as adjusted,
    coalesce(sum(m.delta) filter (where m.type = 'return'), 0) as returned,
    coalesce(sum(m.delta) filter (where m.type = 'count'), 0) as counted,
    coalesce(sum(m.delta) filter (where m.type not in ('receipt', 'transfer', 'fulfillment',
      'adjustment', 'return', 'count')), 0) as other,
    sum(m.delta) as net, count(*)::int as entries,
    ${costOr(c, 'sum(m.delta * m.unit_cost)')} as "netValue"`;
  const typeColumns: Column[] = [
    q('received', 'Received'),
    q('transferredIn', 'Transferred in'),
    q('transferredOut', 'Transferred out'),
    q('fulfilled', 'Fulfilled'),
    q('adjusted', 'Adjusted'),
    q('returned', 'Returned'),
    q('counted', 'Counted'),
    q('other', 'Other'),
    q('net', 'Net change'),
    { key: 'entries', label: 'Entries', type: 'integer', total: true },
    money('netValue', 'Net value'),
  ];
  if (c.group === 'location') {
    return {
      kind: 'sql',
      ctes: `${head}, base as (
        select m.location_id::text as key, m.path as location, m.warehouse, ${byType}
        from mv m join vf on vf.variant_id = m.variant_id
        group by m.location_id, m.path, m.warehouse)`,
      columns: [LOCATION, WAREHOUSE, ...typeColumns],
      defaultSort: 'location',
    };
  }
  if (c.group === 'type') {
    return {
      kind: 'sql',
      ctes: `${head}, base as (
        select m.type as key, m.type, coalesce(sum(m.delta) filter (where m.delta > 0), 0) as "in",
          coalesce(sum(m.delta) filter (where m.delta < 0), 0) as "out", sum(m.delta) as net,
          count(*)::int as entries, ${costOr(c, 'sum(m.delta * m.unit_cost)')} as "netValue"
        from mv m join vf on vf.variant_id = m.variant_id
        group by m.type)`,
      columns: [
        text('type', 'Type'),
        q('in', 'In'),
        q('out', 'Out'),
        q('net', 'Net change'),
        { key: 'entries', label: 'Entries', type: 'integer', total: true },
        money('netValue', 'Net value'),
      ],
      defaultSort: 'type',
    };
  }
  if (c.group === 'entry') {
    return {
      kind: 'sql',
      ctes: `${head}, base as (
        select m.id::text as key, m.created_at as "occurredAt", m.type, m.kind, vf.sku,
          vf.item as product, m.path as location, m.warehouse, lt.code as lot, m.delta as quantity,
          ${costOr(c, 'm.unit_cost')} as "unitCost", ${costOr(c, 'm.delta * m.unit_cost')} as value,
          m.reference
        from mv m join vf on vf.variant_id = m.variant_id
        left join lots lt on lt.shop_id = app_shop_id() and lt.id = m.lot_id)`,
      columns: [
        { key: 'occurredAt', label: 'When', type: 'datetime' },
        text('type', 'Type'),
        text('kind', 'Operation'),
        SKU,
        PRODUCT,
        LOCATION,
        WAREHOUSE,
        text('lot', 'Lot'),
        q('quantity', 'Quantity'),
        money('unitCost', 'Unit cost', false),
        money('value', 'Value'),
        text('reference', 'Reference'),
      ],
      defaultSort: '-occurredAt',
    };
  }
  return {
    kind: 'sql',
    ctes: `${head}, base as (
      select m.variant_id::text as key, vf.sku, vf.item as product, ${byType}
      from mv m join vf on vf.variant_id = m.variant_id
      group by m.variant_id, vf.sku, vf.item)`,
    columns: [SKU, PRODUCT, ...typeColumns],
    defaultSort: 'sku',
  };
}

// 4. Inventory value ---------------------------------------------------------------------------

/**
 * Value at a moment (ADR 0022): units per variant and location then (the balance now minus the
 * ledger entries after it) times the variant's moving average then (the last cost-history row
 * at or before it). Both are stored, so asking again later gives the same answer (A39).
 */
function inventoryValue(c: Ctx): Built {
  const p = c.params;
  const at = c.times.at;
  const quantities = at
    ? `q as (
        select pos.variant_id, pos.location_id, sum(pos.on_hand - coalesce(a.after, 0)) as quantity
        from inventory_positions pos
        join lf on lf.location_id = pos.location_id
        join vf on vf.variant_id = pos.variant_id
        left join (select e.position_id, sum(e.delta) as after from inventory_entries e
          where e.created_at > ${p.add(at)}::timestamptz group by e.position_id) a
          on a.position_id = pos.id
        group by pos.variant_id, pos.location_id),
      ac as (
        select distinct on (h.variant_id) h.variant_id, h.average_after as average
        from variant_cost_history h
        where h.occurred_at <= ${p.add(at)}::timestamptz
        order by h.variant_id, h.occurred_at desc, h.id desc)`
    : `q as (
        select pos.variant_id, pos.location_id, sum(pos.on_hand) as quantity
        from inventory_positions pos
        join lf on lf.location_id = pos.location_id
        join vf on vf.variant_id = pos.variant_id
        where pos.on_hand > 0
        group by pos.variant_id, pos.location_id),
      ac as (select variant_id, average_cost as average from variant_costs)`;
  const head = `${variantCte(c)}, ${locationCte(c)}, ${quantities},
    x as (
      select q.variant_id, q.location_id, lf.path, lf.warehouse_id, lf.warehouse, vf.sku, vf.item,
        vf.family_id, vf.category_id, q.quantity, ac.average, q.quantity * ac.average as value,
        case when ac.average is null then q.quantity else 0 end as unknown
      from q join lf on lf.location_id = q.location_id join vf on vf.variant_id = q.variant_id
      left join ac on ac.variant_id = q.variant_id
      where q.quantity <> 0)`;
  const sums = `sum(x.quantity) as quantity, sum(x.value) as value, sum(x.unknown) as "unknownCost"`;
  const valueColumns: Column[] = [
    q('quantity', 'Units'),
    money('value', 'Value'),
    q('unknownCost', 'Units without a cost'),
  ];
  const grouped = (key: string, cols: string, groupBy: string, columns: Column[], sort: string) =>
    ({
      kind: 'sql',
      ctes: `${head}, base as (select ${key} as key, ${cols}, ${sums} from x group by ${groupBy})`,
      columns: [...columns, ...valueColumns],
      defaultSort: sort,
    }) satisfies Built;
  switch (c.group) {
    case 'variant':
      return {
        kind: 'sql',
        ctes: `${head}, base as (
          select x.variant_id::text as key, x.sku, x.item as product, ${sums},
            max(x.average) as "averageCost"
          from x group by x.variant_id, x.sku, x.item)`,
        columns: [
          SKU,
          PRODUCT,
          q('quantity', 'Units'),
          money('averageCost', 'Average cost', false),
          money('value', 'Value'),
          q('unknownCost', 'Units without a cost'),
        ],
        defaultSort: '-value',
      };
    case 'warehouse':
      return grouped(
        `coalesce(x.warehouse_id::text, 'in_transit')`,
        'x.warehouse',
        'x.warehouse_id, x.warehouse',
        [WAREHOUSE],
        'warehouse',
      );
    case 'category':
      return grouped(
        `coalesce(x.category_id, 'none')`,
        `${CATEGORY_LABEL} as category`,
        'x.category_id',
        [text('category', 'Category')],
        'category',
      );
    case 'family':
      return grouped(
        `coalesce(x.family_id::text, 'none')`,
        `${FAMILY_LABEL} as family`,
        'x.family_id',
        [text('family', 'Family')],
        'family',
      );
    default:
      return grouped(
        'x.location_id::text',
        'x.path as location, x.warehouse',
        'x.location_id, x.path, x.warehouse',
        [LOCATION, WAREHOUSE],
        'location',
      );
  }
}

// 5. Cost of goods -----------------------------------------------------------------------------

function costOfGoods(c: Ctx): Built {
  const p = c.params;
  const head = `${variantCte(c)}, ${locationCte(c)},
    x as (
      select e.variant_id, e.location_id, lf.path, lf.warehouse_id, lf.warehouse, vf.sku, vf.item,
        vf.family_id, vf.category_id, -e.delta as quantity, -e.delta * e.unit_cost as cost,
        case when e.unit_cost is null then -e.delta else 0 end as unknown
      from inventory_entries e
      join inventory_operations o on o.shop_id = e.shop_id and o.id = e.operation_id
      join lf on lf.location_id = e.location_id
      join vf on vf.variant_id = e.variant_id
      where o.kind = 'fulfillment' and e.created_at >= ${p.add(c.times.from)}::timestamptz
        and e.created_at < ${p.add(c.times.to)}::timestamptz)`;
  const sums = `sum(x.quantity) as quantity, sum(x.cost) as "costOfGoods",
    sum(x.unknown) as "unknownCost"`;
  const cogs: Column[] = [
    q('quantity', 'Units fulfilled'),
    money('costOfGoods', 'Cost of goods'),
    q('unknownCost', 'Units without a cost'),
  ];
  const grouped = (key: string, cols: string, groupBy: string, columns: Column[], sort: string) =>
    ({
      kind: 'sql',
      ctes: `${head}, base as (select ${key} as key, ${cols}, ${sums} from x group by ${groupBy})`,
      columns: [...columns, ...cogs],
      defaultSort: sort,
    }) satisfies Built;
  switch (c.group) {
    case 'location':
      return grouped(
        'x.location_id::text',
        'x.path as location, x.warehouse',
        'x.location_id, x.path, x.warehouse',
        [LOCATION, WAREHOUSE],
        'location',
      );
    case 'warehouse':
      return grouped(
        `coalesce(x.warehouse_id::text, 'in_transit')`,
        'x.warehouse',
        'x.warehouse_id, x.warehouse',
        [WAREHOUSE],
        'warehouse',
      );
    case 'category':
      return grouped(
        `coalesce(x.category_id, 'none')`,
        `${CATEGORY_LABEL} as category`,
        'x.category_id',
        [text('category', 'Category')],
        'category',
      );
    case 'family':
      return grouped(
        `coalesce(x.family_id::text, 'none')`,
        `${FAMILY_LABEL} as family`,
        'x.family_id',
        [text('family', 'Family')],
        'family',
      );
    default:
      return {
        kind: 'sql',
        ctes: `${head}, base as (
          select x.variant_id::text as key, x.sku, x.item as product, ${sums},
            case when sum(x.quantity) - sum(x.unknown) > 0
              then sum(x.cost) / (sum(x.quantity) - sum(x.unknown)) end as "averageCost"
          from x group by x.variant_id, x.sku, x.item)`,
        columns: [
          SKU,
          PRODUCT,
          q('quantity', 'Units fulfilled'),
          money('averageCost', 'Average unit cost', false),
          money('costOfGoods', 'Cost of goods'),
          q('unknownCost', 'Units without a cost'),
        ],
        defaultSort: '-costOfGoods',
      };
  }
}

// 6. Purchasing --------------------------------------------------------------------------------

function purchasing(c: Ctx): Built {
  const p = c.params;
  const scope = p.add(c.env.locationScope);
  const conds = [
    `o.status in ('sent', 'partially_received')`,
    `(${scope}::uuid[] is null or o.warehouse_id = any(${scope}::uuid[]) or ol.path_ids && ${scope}::uuid[])`,
  ];
  if (c.f.warehouseId) conds.push(`o.warehouse_id = ${p.add(c.f.warehouseId)}::uuid`);
  if (c.f.locationId) conds.push(`ol.path_ids @> array[${p.add(c.f.locationId)}::uuid]`);
  if (c.f.supplierId) conds.push(`o.supplier_id = ${p.add(c.f.supplierId)}::uuid`);
  const today = `${p.add(c.times.today)}::date`;
  const pl = `pl as (
    select l.id as line_id, o.id as order_id, o.number, o.status, o.expected_on, s.name as supplier,
      w.name as warehouse, ol.path as location, l.variant_id, vf.sku, vf.item, l.ordered, l.received,
      l.cancelled, greatest(l.ordered - l.received - l.cancelled, 0) as open,
      ${costOr(c, 'l.unit_cost / coalesce(l.pack_factor, 1)')} as unit_cost,
      o.expected_on < ${today} and l.ordered - l.received - l.cancelled > 0 as overdue
    from purchase_orders o
    join purchase_order_lines l on l.shop_id = o.shop_id and l.purchase_order_id = o.id
    join vf on vf.variant_id = l.variant_id
    join suppliers s on s.shop_id = o.shop_id and s.id = o.supplier_id
    join warehouses w on w.shop_id = o.shop_id and w.id = o.warehouse_id
    left join locations ol on ol.shop_id = o.shop_id and ol.id = o.location_id
    where ${conds.join(' and ')})`;
  const overdueOnly = c.f.overdueOnly ? 'where pl.overdue' : '';
  const head = `${variantCte(c, { supplierItems: false })}, ${pl},
    x as (select pl.*, pl.open * pl.unit_cost as open_value,
      case when pl.overdue then ${today} - pl.expected_on else 0 end as days_overdue
      from pl ${overdueOnly})`;
  const number = `'PO-' || lpad(x.number::text, 4, '0')`;
  switch (c.group) {
    case 'order':
      return {
        kind: 'sql',
        ctes: `${head}, base as (
          select x.order_id::text as key, ${number} as "order", x.supplier, x.warehouse,
            x.location, x.status, x.expected_on as "expectedOn", bool_or(x.overdue) as overdue,
            max(x.days_overdue)::int as "daysOverdue", count(*)::int as lines,
            sum(x.ordered) as ordered, sum(x.received) as received, sum(x.open) as "onOrder",
            ${costOr(c, 'sum(x.open_value)')} as "openValue"
          from x group by x.order_id, x.number, x.supplier, x.warehouse, x.location, x.status,
            x.expected_on)`,
        columns: [
          text('order', 'Order'),
          text('supplier', 'Supplier'),
          WAREHOUSE,
          LOCATION,
          text('status', 'Status'),
          { key: 'expectedOn', label: 'Expected', type: 'date' },
          { key: 'overdue', label: 'Overdue', type: 'boolean' },
          { key: 'daysOverdue', label: 'Days overdue', type: 'integer' },
          { key: 'lines', label: 'Lines', type: 'integer', total: true },
          q('ordered', 'Ordered'),
          q('received', 'Received'),
          q('onOrder', 'On order'),
          money('openValue', 'Open value'),
        ],
        defaultSort: 'expectedOn',
      };
    case 'variant':
      return {
        kind: 'sql',
        ctes: `${head}, base as (
          select x.variant_id::text as key, x.sku, x.item as product,
            count(distinct x.order_id)::int as orders, sum(x.open) as "onOrder",
            coalesce(sum(x.open) filter (where x.overdue), 0) as "overdueQuantity",
            min(x.expected_on) as "nextExpectedOn", ${costOr(c, 'sum(x.open_value)')} as "openValue"
          from x group by x.variant_id, x.sku, x.item)`,
        columns: [
          SKU,
          PRODUCT,
          { key: 'orders', label: 'Orders', type: 'integer' },
          q('onOrder', 'On order'),
          q('overdueQuantity', 'Overdue'),
          { key: 'nextExpectedOn', label: 'Next expected', type: 'date' },
          money('openValue', 'Open value'),
        ],
        defaultSort: 'sku',
      };
    case 'supplier':
      return {
        kind: 'sql',
        ctes: `${head}, base as (
          select x.supplier as key, x.supplier, count(distinct x.order_id)::int as orders,
            count(distinct x.order_id) filter (where x.overdue)::int as "overdueOrders",
            sum(x.open) as "onOrder", coalesce(sum(x.open) filter (where x.overdue), 0)
              as "overdueQuantity",
            ${costOr(c, 'sum(x.open_value)')} as "openValue"
          from x group by x.supplier)`,
        columns: [
          text('supplier', 'Supplier'),
          { key: 'orders', label: 'Orders', type: 'integer', total: true },
          { key: 'overdueOrders', label: 'Overdue orders', type: 'integer', total: true },
          q('onOrder', 'On order'),
          q('overdueQuantity', 'Overdue'),
          money('openValue', 'Open value'),
        ],
        defaultSort: 'supplier',
      };
    default:
      return {
        kind: 'sql',
        ctes: `${head}, base as (
          select x.line_id::text as key, ${number} as "order", x.supplier, x.warehouse, x.location,
            x.status, x.expected_on as "expectedOn", x.overdue, x.days_overdue::int as "daysOverdue",
            x.sku, x.item as product, x.ordered, x.received, x.cancelled, x.open as "onOrder",
            x.unit_cost as "unitCost", ${costOr(c, 'x.open_value')} as "openValue"
          from x)`,
        columns: [
          text('order', 'Order'),
          text('supplier', 'Supplier'),
          WAREHOUSE,
          LOCATION,
          text('status', 'Status'),
          { key: 'expectedOn', label: 'Expected', type: 'date' },
          { key: 'overdue', label: 'Overdue', type: 'boolean' },
          { key: 'daysOverdue', label: 'Days overdue', type: 'integer' },
          SKU,
          PRODUCT,
          q('ordered', 'Ordered'),
          q('received', 'Received'),
          q('cancelled', 'Cancelled'),
          q('onOrder', 'On order'),
          money('unitCost', 'Unit cost', false),
          money('openValue', 'Open value'),
        ],
        defaultSort: 'expectedOn',
      };
  }
}

// 7. Expiring lots -----------------------------------------------------------------------------

function expiringLots(c: Ctx): Built {
  const p = c.params;
  const days = c.f.days ?? 30;
  const today = `${p.add(c.times.today)}::date`;
  const head = `${variantCte(c)}, ${locationCte(c)},
    el as (
      select lt.id, lt.variant_id, lt.code, lt.expires_on, v.sell_by_margin_days as margin
      from lots lt join vf on vf.variant_id = lt.variant_id
      join variants v on v.shop_id = lt.shop_id and v.id = lt.variant_id
      where lt.expires_on is not null and lt.expires_on <= ${today} + ${p.add(days)}::integer),
    x as (
      select s.*, lf.warehouse, el.code, el.expires_on as expires, el.margin, vf.sku, vf.item,
        s.on_hand * vc.average_cost as value
      from stock_positions(array(select distinct variant_id from el)) s
      join el on el.id = s.lot_id
      join lf on lf.location_id = s.location_id
      join vf on vf.variant_id = s.variant_id
      left join variant_costs vc on vc.shop_id = app_shop_id() and vc.variant_id = s.variant_id
      where s.on_hand > 0)`;
  const lotCols = `x.sku, x.item as product, x.code as lot, x.expires as "expiresOn",
    x.expires - x.margin as "sellableUntil", (x.expires - ${today})::int as "daysLeft",
    bool_or(x.lot_expired) as expired, sum(x.on_hand) as "onHand", sum(x.reserved) as reserved,
    sum(x.available) as available, ${costOr(c, 'sum(x.value)')} as value`;
  const lotColumns: Column[] = [
    SKU,
    PRODUCT,
    text('lot', 'Lot'),
    { key: 'expiresOn', label: 'Expires', type: 'date' },
    { key: 'sellableUntil', label: 'Sellable until', type: 'date' },
    { key: 'daysLeft', label: 'Days left', type: 'integer' },
    { key: 'expired', label: 'Expired', type: 'boolean' },
  ];
  const stockColumns: Column[] = [
    q('onHand', 'On hand'),
    q('reserved', 'Reserved'),
    q('available', 'Available'),
    money('value', 'Value'),
  ];
  if (c.group === 'position') {
    return {
      kind: 'sql',
      ctes: `${head}, base as (
        select x.lot_id::text || ':' || x.location_id::text as key, ${lotCols},
          x.location_path as location, x.warehouse
        from x group by x.lot_id, x.location_id, x.location_path, x.warehouse, x.sku, x.item,
          x.code, x.expires, x.margin)`,
      columns: [...lotColumns, LOCATION, WAREHOUSE, ...stockColumns],
      defaultSort: 'expiresOn',
    };
  }
  return {
    kind: 'sql',
    ctes: `${head}, base as (
      select x.lot_id::text as key, ${lotCols},
        string_agg(distinct x.location_path, '; ') as locations
      from x group by x.lot_id, x.sku, x.item, x.code, x.expires, x.margin)`,
    columns: [...lotColumns, text('locations', 'Locations'), ...stockColumns],
    defaultSort: 'expiresOn',
  };
}

// 8. Shortages ---------------------------------------------------------------------------------

function shortages(c: Ctx): Built {
  const p = c.params;
  const scope = p.add(c.env.locationScope);
  const conds = [
    'r.shortage_quantity > 0',
    `r.status in ('active', 'partially_fulfilled')`,
    // A shortage limited to a location is location data; one for the whole shop is not.
    `(r.location_id is null or ${scope}::uuid[] is null or rl.path_ids && ${scope}::uuid[])`,
  ];
  if (c.f.warehouseId) conds.push(`rl.warehouse_id = ${p.add(c.f.warehouseId)}::uuid`);
  if (c.f.locationId) conds.push(`rl.path_ids @> array[${p.add(c.f.locationId)}::uuid]`);
  const head = `${variantCte(c)},
    x as (
      select r.id, r.variant_id, vf.sku, vf.item, r.quantity, r.shortage_quantity as shortage,
        coalesce(r.external_ref, pr.external_ref) as order_ref, r.channel, r.created_at
      from reservations r
      join vf on vf.variant_id = r.variant_id
      left join reservations pr on pr.shop_id = r.shop_id and pr.id = r.parent_id
      left join locations rl on rl.shop_id = r.shop_id and rl.id = r.location_id
      where ${conds.join(' and ')})`;
  if (c.group === 'variant') {
    return {
      kind: 'sql',
      ctes: `${head},
        oo as (
          select o.variant_id, sum(o.quantity) as quantity
          from purchase_on_order(array(select distinct variant_id from x)) o
          left join locations ol on ol.shop_id = app_shop_id() and ol.id = o.location_id
          where (${scope}::uuid[] is null or o.warehouse_id = any(${scope}::uuid[])
            or ol.path_ids && ${scope}::uuid[])
          group by o.variant_id),
        base as (
          select x.variant_id::text as key, x.sku, x.item as product, sum(x.shortage) as shortage,
            count(*)::int as orders, min(x.created_at) as "oldest",
            coalesce(max(oo.quantity), 0) as "onOrder"
          from x left join oo on oo.variant_id = x.variant_id
          group by x.variant_id, x.sku, x.item)`,
      columns: [
        SKU,
        PRODUCT,
        q('shortage', 'Short'),
        { key: 'orders', label: 'Orders', type: 'integer', total: true },
        { key: 'oldest', label: 'Oldest', type: 'datetime' },
        q('onOrder', 'On order'),
      ],
      defaultSort: '-shortage',
    };
  }
  return {
    kind: 'sql',
    ctes: `${head}, base as (
      select x.id::text as key, x.order_ref as "order", x.channel, x.sku, x.item as product,
        x.quantity as ordered, x.shortage, x.created_at as "createdAt",
        extract(day from now() - x.created_at)::int as "ageDays"
      from x)`,
    columns: [
      text('order', 'Order'),
      text('channel', 'Channel'),
      SKU,
      PRODUCT,
      q('ordered', 'Ordered'),
      q('shortage', 'Short'),
      { key: 'createdAt', label: 'Accepted', type: 'datetime' },
      { key: 'ageDays', label: 'Days open', type: 'integer' },
    ],
    defaultSort: 'createdAt',
  };
}

// The runner -----------------------------------------------------------------------------------

interface CursorData {
  /** The report, grouping, sort, and filters the cursor belongs to. */
  s: string;
  /** The last row's raw sort value. */
  v: string | number | boolean | null;
  /** The last row's key. */
  k: string;
}

function encode(c: CursorData): string {
  let binary = '';
  for (const b of new TextEncoder().encode(JSON.stringify(c))) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(text: string, signature: string): CursorData {
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const c = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as CursorData;
    if (c.s !== signature || typeof c.k !== 'string') throw new Error();
    return c;
  } catch {
    throw errors.validation([
      { path: 'cursor', message: 'This cursor belongs to another report run. Start again.' },
    ]);
  }
}

/** A stable signature of what a cursor pages through, so it cannot be reused elsewhere. */
function signature(report: ReportType, group: ReportGroup, sort: string, f: ReportFilters): string {
  const { sort: _sort, groupBy: _group, ...rest } = f;
  const filters = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('&');
  return `${report}|${group}|${sort}|${filters}`;
}

const SQL_TYPES: Record<ReportColumn['type'], string> = {
  text: 'text',
  quantity: 'numeric',
  money: 'numeric',
  integer: 'integer',
  date: 'date',
  datetime: 'timestamptz',
  boolean: 'boolean',
};

/** One cell as the API returns it: decimals rounded half to even at 6 places, dates as text. */
function formatSql(col: Column, expr: string): string {
  switch (col.type) {
    case 'quantity':
    case 'money':
      return `round_half_even(${expr}, 6)::text`;
    case 'date':
      return `to_char(${expr}, 'YYYY-MM-DD')`;
    case 'datetime':
      return `to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    default:
      return expr;
  }
}

const ident = (key: string) => `"${key.replace(/"/g, '')}"`;

/** Which filters a report does not take, so the result can say they were left out. */
function ignoredFilters(report: ReportType, f: ReportFilters): string[] {
  const taken = new Set<string>(REPORTS[report].filters);
  return (Object.keys(f) as Array<ReportFilterKey | 'sort' | 'groupBy'>).filter(
    (k) => k !== 'sort' && k !== 'groupBy' && f[k] !== undefined && !taken.has(k),
  );
}

/**
 * Runs a report and returns one page of rows with totals over every row. `limit` is the page
 * size; exports page through with the cursor.
 */
export async function runReport(
  env: ReportEnv,
  report: ReportType,
  filters: ReportFilters,
  page: { cursor?: string | undefined; limit: number },
): Promise<ReportResult> {
  const info = REPORTS[report];
  if (info.costs === 'required' && !env.costs) {
    throw errors.forbidden(
      `The ${info.title.toLowerCase()} report shows costs; it needs costs.read.`,
    );
  }
  const group = filters.groupBy ?? info.defaultGroup;
  if (!info.groups.includes(group)) {
    throw errors.validation([
      {
        path: 'groupBy',
        message: `${info.title} groups by ${info.groups.map((g) => `"${g}"`).join(', ')}.`,
      },
    ]);
  }
  const ignored = ignoredFilters(report, filters);
  const f: ReportFilters = { ...filters };
  for (const k of ignored) delete f[k as ReportFilterKey];

  const tx = env.tx;
  const times = await resolveTimes(tx, f);
  let categoryField: string | null = null;
  if (f.categoryId || group === 'category') {
    const [row] = await tx.query<{ id: string }>(
      `select id from field_definitions where key = 'category'`,
    );
    categoryField = row?.id ?? null;
  }
  const c: Ctx = { env, params: new Params(), f, group, times, categoryField };
  const built = await build(report, c);
  const columns = built.columns.filter((col) => env.costs || !col.cost);
  const requested = f.sort ?? built.defaultSort;
  const desc = requested.startsWith('-');
  const sortKey = desc ? requested.slice(1) : requested;
  const sortColumn = columns.find((col) => col.key === sortKey && !col.computed);
  if (!sortColumn) {
    throw errors.validation([
      {
        path: 'sort',
        message: `Sort by one of ${columns
          .filter((col) => !col.computed)
          .map((col) => `"${col.key}"`)
          .join(', ')}; prefix "-" for descending.`,
      },
    ]);
  }
  const sort = `${desc ? '-' : ''}${sortKey}`;
  const sig = signature(report, group, sort, f);
  const cursor = page.cursor ? decode(page.cursor, sig) : null;
  const limit = Math.max(1, page.limit);

  let rows: ReportRow[];
  let totals: Record<string, string>;
  let count: number;
  let lastSort: Array<string | number | boolean | null> = [];
  if (built.kind === 'rows') {
    const sorted = sortRows(built.rows, sortColumn, desc);
    const start = cursor ? sorted.findIndex((r) => r.key === cursor.k) + 1 : 0;
    const slice = sorted.slice(start, start + limit + 1);
    count = sorted.length;
    totals = Object.fromEntries(
      columns
        .filter((col) => col.total && (col.type === 'quantity' || col.type === 'money'))
        .map((col) => [
          col.key,
          normalize(
            sorted.reduce(
              (sum, r) => (typeof r[col.key] === 'string' ? add(sum, r[col.key] as string) : sum),
              '0',
            ),
          ),
        ]),
    );
    rows = slice;
    lastSort = slice.map((r) => r[sortKey] ?? null);
  } else {
    const p = c.params;
    const expr = `b.${ident(sortKey)}`;
    const dir = desc ? 'desc' : 'asc';
    let keyset = 'true';
    if (cursor) {
      const type = SQL_TYPES[sortColumn.type];
      const v = `${p.add(cursor.v === null ? null : String(cursor.v))}::${type}`;
      const k = `${p.add(cursor.k)}::text`;
      const after = desc ? '<' : '>';
      keyset = `((${v} is not null and (${expr} ${after} ${v} or (${expr} = ${v} and b.key > ${k})
        or ${expr} is null)) or (${v} is null and ${expr} is null and b.key > ${k}))`;
    }
    const select = [
      ...columns
        .filter((col) => !col.computed)
        .map((col) => `${formatSql(col, `b.${ident(col.key)}`)} as ${ident(col.key)}`),
      ...(built.extra ?? []).map((key) => `b.${ident(key)}::text as ${ident(key)}`),
      'b.key',
      `${expr}::text as "_sort"`,
      `row_number() over (order by ${expr} ${dir} nulls last, b.key) as "_ord"`,
    ].join(', ');
    const totalSql = columns
      .filter((col) => col.total && !col.computed)
      .map((col) =>
        col.type === 'integer'
          ? `'${col.key}', coalesce(sum(b.${ident(col.key)}), 0)::text`
          : `'${col.key}', coalesce(round_half_even(sum(b.${ident(col.key)}), 6), 0)::text`,
      );
    const sql = `with ${built.ctes}
      select (select count(*)::int from base) as count,
        (select json_build_object(${totalSql.join(', ') || `'rows', count(*)::text`}) from base b) as totals,
        coalesce((select json_agg(r order by r."_ord") from (
          select ${select} from base b where ${keyset}
          order by ${expr} ${dir} nulls last, b.key limit ${limit + 1}) r), '[]'::json) as rows`;
    let result: { count: number; totals: Record<string, string>; rows: ReportRow[] } | undefined;
    try {
      [result] = await tx.query(sql, p.values);
    } catch (error) {
      if ((error as { code?: string }).code === '57014') throw tooLarge();
      throw error;
    }
    if (!result) throw errors.internal();
    count = result.count;
    totals = Object.fromEntries(
      Object.entries(result.totals).filter(([key]) => columns.some((col) => col.key === key)),
    );
    for (const [key, value] of Object.entries(totals)) {
      const col = columns.find((x) => x.key === key)!;
      if (col.type !== 'integer') totals[key] = normalize(value);
    }
    rows = result.rows;
    lastSort = rows.map((r) => r._sort as string | null);
  }

  const more = rows.length > limit;
  if (more) {
    rows = rows.slice(0, limit);
    lastSort = lastSort.slice(0, limit);
  }
  const last = rows[rows.length - 1];
  const nextCursor =
    more && last
      ? encode({ s: sig, v: lastSort[lastSort.length - 1] ?? null, k: String(last.key) })
      : null;

  if (columns.some((col) => col.key === 'packs')) await addPackBreakdown(tx, rows);
  const out = rows.map((r) => {
    const row: ReportRow = { key: String(r.key) };
    for (const col of columns) {
      const v = r[col.key] ?? null;
      row[col.key] =
        typeof v === 'string' && (col.type === 'quantity' || col.type === 'money')
          ? normalize(v)
          : v;
    }
    return row;
  });

  return {
    report,
    title: info.title,
    groupBy: group,
    groupLabel: GROUP_LABELS[group],
    sort,
    columns: columns.map(({ computed: _computed, ...col }) => col),
    rows: out,
    totals,
    rowCount: count,
    nextCursor,
    partial: env.locationScope !== null,
    costVisible: env.costs,
    currency: times.currency,
    at: report === 'inventory_value' ? (times.at ?? new Date()).toISOString() : null,
    from: report === 'movements' || report === 'cost_of_goods' ? times.from.toISOString() : null,
    to: report === 'movements' || report === 'cost_of_goods' ? times.to.toISOString() : null,
    days: report === 'expiring_lots' ? (f.days ?? 30) : null,
    ignoredFilters: ignored,
  };
}

export function tooLarge(): AppError {
  return errors.unprocessable(
    'report_too_large',
    'This report takes too long to show here. Narrow the filters, or export it as CSV: exports run as a background job.',
  );
}

function build(report: ReportType, c: Ctx): Built | Promise<Built> {
  switch (report) {
    case 'stock_on_hand':
      return stockOnHand(c);
    case 'low_stock':
      return lowStock(c);
    case 'movements':
      return movements(c);
    case 'inventory_value':
      return inventoryValue(c);
    case 'cost_of_goods':
      return costOfGoods(c);
    case 'purchasing':
      return purchasing(c);
    case 'expiring_lots':
      return expiringLots(c);
    case 'shortages':
      return shortages(c);
  }
}

/** In-memory sort for reports computed in TypeScript (low stock): nulls last, then the key. */
function sortRows(rows: ReportRow[], col: Column, desc: boolean): ReportRow[] {
  const numeric = col.type === 'quantity' || col.type === 'money' || col.type === 'integer';
  const cmp = (a: ReportCell, b: ReportCell): number => {
    if (numeric) return compare(String(a), String(b));
    return String(a).localeCompare(String(b));
  };
  return [...rows].sort((x, y) => {
    const a = x[col.key] ?? null;
    const b = y[col.key] ?? null;
    if (a === null || b === null) {
      if (a !== b) return a === null ? 1 : -1;
    } else {
      const d = cmp(a, b);
      if (d !== 0) return desc ? -d : d;
    }
    return String(x.key).localeCompare(String(y.key));
  });
}

/**
 * The pack breakdown of on hand (PRD 3.5): whole packs from the largest active pack down, then
 * the base units left, such as "3 × Case (24) + 5".
 */
async function addPackBreakdown(tx: Tx, rows: ReportRow[]): Promise<void> {
  const ids = [...new Set(rows.map((r) => r._variantId).filter((v): v is string => !!v))];
  if (ids.length === 0) return;
  const packs = await tx.query<{ variant_id: string; name: string; base_quantity: string }>(
    `select variant_id, name, base_quantity::text from packs
     where variant_id = any($1::uuid[]) and status = 'active'
     order by variant_id, base_quantity desc, position`,
    [ids],
  );
  const byVariant = new Map<string, Array<{ name: string; size: bigint; text: string }>>();
  for (const p of packs) {
    // Breakdowns use whole base units; packs of fractional quantities are left out.
    if (!/^\d+(\.0+)?$/.test(p.base_quantity)) continue;
    const list = byVariant.get(p.variant_id) ?? [];
    const size = BigInt(p.base_quantity.split('.')[0]!);
    if (size > 1n) list.push({ name: p.name, size, text: size.toString() });
    byVariant.set(p.variant_id, list);
  }
  for (const r of rows) {
    const list = byVariant.get(String(r._variantId)) ?? [];
    const onHand = typeof r.onHand === 'string' ? normalize(r.onHand) : '0';
    if (list.length === 0 || !/^\d+$/.test(onHand)) {
      r.packs = null;
      continue;
    }
    let rest = BigInt(onHand);
    const parts: string[] = [];
    for (const pack of list) {
      const n = rest / pack.size;
      if (n > 0n) {
        parts.push(`${n} × ${pack.name} (${pack.text})`);
        rest -= n * pack.size;
      }
    }
    if (parts.length === 0) {
      r.packs = null;
      continue;
    }
    if (rest > 0n) parts.push(rest.toString());
    r.packs = parts.join(' + ');
  }
}
