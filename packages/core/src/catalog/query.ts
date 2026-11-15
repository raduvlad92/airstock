import { normalizeBarcode } from './barcodes.ts';
import { compare, isDecimal, normalize } from './decimal.ts';
import type { FieldDefinition, FieldType } from './fields.ts';
import { toCanonical, unitKind } from './units.ts';

/**
 * The catalog query compiler (plan Section 5.10, decision D2, ADR 0014). A small typed grammar of
 * conditions, compiled into parameterized SQL over `products p` and `variants v`. Field names and
 * operators come from a whitelist; every value travels as a parameter.
 */

export type Mode = 'variants' | 'products';

export interface Condition {
  field: string;
  op: string;
  value?: unknown;
}
export interface Group {
  any: Condition[];
}
export type FilterItem = Condition | Group;

export interface SortSpec {
  field: string;
  direction: 'asc' | 'desc';
}

export const QUERY_LIMITS = { conditions: 20, pageSize: 200, countCap: 10_000 } as const;

/** The operators each kind of value supports (plan Section 5.2). */
export const OPERATORS = {
  text: ['contains', 'equals', 'starts_with', 'is_empty', 'is_not_empty'],
  rich_text: ['contains', 'is_empty', 'is_not_empty'],
  number: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'is_empty', 'is_not_empty'],
  boolean: ['is', 'is_empty', 'is_not_empty'],
  date: [
    'before',
    'after',
    'on',
    'between',
    'within_next_days',
    'within_last_days',
    'is_empty',
    'is_not_empty',
  ],
  select: ['is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
  multi: ['has_any', 'has_all', 'has_none', 'is_empty', 'is_not_empty'],
  file: ['has_any', 'is_empty'],
  relation: ['has_related', 'is_empty'],
} as const;
export type ValueKind = keyof typeof OPERATORS;

const KIND_OF_TYPE: Record<FieldType, ValueKind> = {
  text: 'text',
  rich_text: 'rich_text',
  integer: 'number',
  decimal: 'number',
  money: 'number',
  measurement: 'number',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'date',
  single_select: 'select',
  multi_select: 'multi',
  file: 'file',
  relationship: 'relation',
};

export class QueryError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

/** Collects parameters; `add` returns the placeholder. */
export class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Where a value lives: on the product, or on each variant (products mode then asks "any variant"). */
type Level = 'product' | 'variant';

export interface QueryField {
  key: string;
  label: string;
  kind: ValueKind;
  level: Level;
  /** SQL type of the sort and comparison expression. */
  sqlType: 'text' | 'numeric' | 'boolean' | 'date' | 'timestamptz' | 'jsonb' | 'text[]';
  /** Typed SQL expression in variants mode (aliases p and v) or products mode (alias p). */
  expr(params: Params, mode: Mode): string;
  sortable: boolean;
  /** For measurements: the unit kind values are converted from. */
  unitKind?: string;
  def?: FieldDefinition;
  /** Date (YYYY-MM-DD) or timestamp, for date operators. */
  temporal?: 'date' | 'timestamp';
}

/** A custom value in variants mode: the variant's own if it has the key, else the product's. */
function customJson(def: FieldDefinition, params: Params, mode: Mode): string {
  const id = params.add(def.id);
  if (def.level === 'product' || (mode === 'products' && def.level === 'both'))
    return `(p.attributes -> ${id}::text)`;
  if (def.level === 'variant') return `(v.attributes -> ${id}::text)`;
  return `(case when v.attributes ? ${id}::text then v.attributes -> ${id}::text else p.attributes -> ${id}::text end)`;
}

function customField(def: FieldDefinition): QueryField {
  const kind = KIND_OF_TYPE[def.type];
  const level: Level = def.level === 'variant' ? 'variant' : 'product';
  const typed = (json: string): string => {
    switch (def.type) {
      case 'integer':
      case 'decimal':
        return `((${json}) #>> '{}')::numeric`;
      case 'money':
        return `((${json}) ->> 'amount')::numeric`;
      case 'measurement':
        return `((${json}) ->> 'canonical')::numeric`;
      case 'boolean':
        return `((${json}) #>> '{}')::boolean`;
      case 'date':
        return `((${json}) #>> '{}')::date`;
      case 'timestamp':
        return `((${json}) #>> '{}')::timestamptz`;
      case 'multi_select':
      case 'file':
      case 'relationship':
        return json;
      default:
        return `((${json}) #>> '{}')`;
    }
  };
  const sqlType: QueryField['sqlType'] =
    kind === 'number'
      ? 'numeric'
      : def.type === 'boolean'
        ? 'boolean'
        : def.type === 'date'
          ? 'date'
          : def.type === 'timestamp'
            ? 'timestamptz'
            : kind === 'multi' || kind === 'file' || kind === 'relation'
              ? 'jsonb'
              : 'text';
  return {
    key: def.key,
    label: def.label,
    kind,
    level: def.level === 'both' ? 'product' : level,
    sqlType,
    def,
    unitKind: def.config.unitKind,
    temporal: def.type === 'date' ? 'date' : def.type === 'timestamp' ? 'timestamp' : undefined,
    sortable: !['multi', 'file', 'relation', 'rich_text'].includes(kind),
    expr(params, mode) {
      // 'both' fields behave per variant in variants mode.
      return typed(customJson(def, params, mode));
    },
  };
}

/**
 * Warehouses and locations that keep everything inside them out of fulfillment (ADR 0016, as
 * location_fulfillment_eligible()). `path_ids` holds the warehouse, every location above, and the
 * location itself, so one overlap test per position applies the rule. As an uncorrelated scalar the
 * planner computes the list once per query; it is almost always empty.
 */
const INELIGIBLE_IDS = `(select coalesce(array_agg(x.id), '{}'::uuid[]) from (
  select id from locations where not fulfillment_eligible
  union all select id from warehouses where not fulfillment_eligible) x)`;

/** Sellable stock available at fulfillment-eligible locations in the caller's scope. */
function availableExpr(params: Params, scope: string[] | null): string {
  const s = params.add(scope);
  return `(select coalesce(sum(ip.on_hand - ip.allocated + coalesce((
       select sum(a.quantity - a.released - a.fulfilled) from reservation_allocations a
       join reservations r on r.shop_id = a.shop_id and r.id = a.reservation_id
       where a.shop_id = ip.shop_id and a.position_id = ip.id and a.released + a.fulfilled < a.quantity
         and r.status in ('active', 'partially_fulfilled') and r.expires_at <= now()), 0)), 0)
     from inventory_positions ip
     join locations l on l.shop_id = ip.shop_id and l.id = ip.location_id
     where ip.shop_id = v.shop_id and ip.variant_id = v.id and ip.condition = 'sellable'
       and l.status = 'active' and not (l.path_ids && ${INELIGIBLE_IDS})
       and (${s}::uuid[] is null or l.path_ids && ${s}::uuid[]))`;
}

/** Built-in fields, by the name the API uses. */
function builtinFields(scope: string[] | null): QueryField[] {
  const f = (
    key: string,
    label: string,
    kind: ValueKind,
    level: Level,
    sqlType: QueryField['sqlType'],
    sql: (params: Params) => string,
    extra: Partial<QueryField> = {},
  ): QueryField => ({
    key,
    label,
    kind,
    level,
    sqlType,
    sortable: true,
    expr: (params) => sql(params),
    ...extra,
  });
  return [
    f('name', 'Name', 'text', 'product', 'text', () => 'p.name'),
    f('description', 'Description', 'rich_text', 'product', 'text', () => 'p.description', {
      sortable: false,
    }),
    f('status', 'Status', 'select', 'product', 'text', () => 'p.status'),
    f('family', 'Family', 'select', 'product', 'text', () => 'p.family_id::text'),
    f('tags', 'Tags', 'multi', 'product', 'text[]', () => 'p.tags', { sortable: false }),
    f('created_at', 'Created', 'date', 'product', 'timestamptz', () => 'p.created_at', {
      temporal: 'timestamp',
    }),
    f('updated_at', 'Updated', 'date', 'product', 'timestamptz', () => 'p.updated_at', {
      temporal: 'timestamp',
    }),
    f('sku', 'SKU', 'text', 'variant', 'text', () => 'v.sku'),
    f('price', 'Price', 'number', 'variant', 'numeric', () => 'v.price'),
    f('variant_status', 'Variant status', 'select', 'variant', 'text', () => 'v.status'),
    f(
      'weight',
      'Weight',
      'number',
      'variant',
      'numeric',
      () =>
        `((case when v.weight is not null then v.weight else p.weight end) ->> 'canonical')::numeric`,
      { unitKind: 'weight' },
    ),
    f('available', 'Available', 'number', 'variant', 'numeric', (params) =>
      availableExpr(params, scope),
    ),
    // Completeness checks such as "which items have no primary picture" (plan 7.3). A variant
    // counts its product's primary picture, as the gallery shows it.
    {
      key: 'has_picture',
      label: 'Has a primary picture',
      kind: 'boolean',
      level: 'product',
      sqlType: 'boolean',
      sortable: true,
      expr: (_params, mode) =>
        `exists (select 1 from media_links ml join media_assets ma on ma.shop_id = ml.shop_id and ma.id = ml.media_id
           where ml.shop_id = p.shop_id and ml.product_id = p.id and ml.is_primary and ma.status = 'active'
             and (ml.variant_id is null${mode === 'variants' ? ' or ml.variant_id = v.id' : ''}))`,
    },
    f(
      'has_shipping_package',
      'Has a shipping package',
      'boolean',
      'variant',
      'boolean',
      () =>
        'exists (select 1 from shipping_packages sp where sp.shop_id = v.shop_id and sp.variant_id = v.id)',
    ),
    f(
      'has_barcode',
      'Has a barcode',
      'boolean',
      'variant',
      'boolean',
      () =>
        'exists (select 1 from barcodes b where b.shop_id = v.shop_id and b.variant_id = v.id and b.pack_id is null)',
    ),
    f(
      'supplier_sku',
      'Supplier SKU',
      'text',
      'variant',
      'text',
      () =>
        `(select si.supplier_sku from supplier_items si where si.shop_id = v.shop_id and si.variant_id = v.id
           and si.status = 'active' and si.supplier_sku is not null order by si.preferred desc, si.id limit 1)`,
    ),
  ];
}

export function resolveFields(
  defs: FieldDefinition[],
  scope: string[] | null,
): Map<string, QueryField> {
  const out = new Map<string, QueryField>();
  for (const b of builtinFields(scope)) out.set(b.key, b);
  for (const d of defs) if (!out.has(d.key)) out.set(d.key, customField(d));
  return out;
}

// Values -----------------------------------------------------------------------------------

function decimalValue(field: QueryField, value: unknown, path: string): string {
  if (field.unitKind) {
    const text =
      typeof value === 'string'
        ? value
        : value && typeof value === 'object'
          ? `${(value as { value?: unknown }).value} ${(value as { unit?: unknown }).unit}`
          : '';
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*(.+?)\s*$/.exec(text);
    if (!m || unitKind(m[2]!) !== field.unitKind) {
      throw new QueryError(path, `Use a value with a ${field.unitKind} unit, such as "2 kg".`);
    }
    return toCanonical(m[1]!, m[2]!);
  }
  const raw =
    typeof value === 'number'
      ? String(value)
      : value && typeof value === 'object'
        ? (value as { amount?: unknown }).amount
        : value;
  if (typeof raw !== 'string' || !isDecimal(raw.trim()))
    throw new QueryError(path, 'Use a number.');
  return normalize(raw.trim());
}

function dateValue(field: QueryField, value: unknown, path: string): string {
  if (typeof value !== 'string')
    throw new QueryError(path, 'Use a date (YYYY-MM-DD) or an ISO time.');
  const t = value.trim();
  if (field.temporal === 'date' ? !/^\d{4}-\d{2}-\d{2}$/.test(t) : Number.isNaN(Date.parse(t))) {
    throw new QueryError(path, 'Use a date (YYYY-MM-DD) or an ISO time.');
  }
  return t;
}

function optionIds(field: QueryField, value: unknown, path: string): string[] {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.length > 100) throw new QueryError(path, 'Give one to 100 values.');
  return list.map((item) => {
    if (typeof item !== 'string') throw new QueryError(path, 'Use option IDs or labels.');
    if (!field.def) return item;
    const option =
      field.def.options.find((o) => o.id === item) ??
      field.def.options.find((o) => o.label.toLowerCase() === item.trim().toLowerCase());
    if (!option) throw new QueryError(path, `"${item}" is not an option of ${field.label}.`);
    return option.id;
  });
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * One condition as SQL on the row's own expression. Products mode asks "any active variant" for
 * variant-level fields.
 */
function compileCondition(
  c: Condition,
  fields: Map<string, QueryField>,
  params: Params,
  mode: Mode,
  path: string,
): string {
  const field = fields.get(c.field);
  if (!field) throw new QueryError(`${path}.field`, `Unknown field "${c.field}".`);
  const allowed = OPERATORS[field.kind] as readonly string[];
  if (!allowed.includes(c.op)) {
    throw new QueryError(`${path}.op`, `${field.label} supports: ${allowed.join(', ')}.`);
  }
  const perVariant = mode === 'products' && field.level === 'variant';
  const exprMode: Mode = perVariant ? 'variants' : mode;
  const e = field.expr(params, exprMode);
  const vpath = `${path}.value`;
  let sql: string;
  switch (c.op) {
    case 'is_empty':
    case 'is_not_empty': {
      let empty: string;
      if (field.kind === 'relation') {
        const id = params.add(field.def!.id);
        empty = `not exists (select 1 from record_relations r where r.shop_id = p.shop_id and r.field_id = ${id}
          and r.source_id = ${field.def!.level === 'variant' ? 'v.id' : 'p.id'})`;
      } else if (field.sqlType === 'text[]') empty = `cardinality(${e}) = 0`;
      else if (field.sqlType === 'jsonb') {
        empty = `(${e} is null or jsonb_typeof(${e}) <> 'array' or jsonb_array_length(${e}) = 0)`;
      } else if (field.sqlType === 'text') empty = `coalesce(${e}, '') = ''`;
      else empty = `${e} is null`;
      sql = c.op === 'is_empty' ? empty : `not (${empty})`;
      break;
    }
    case 'contains':
      sql = `${e} ilike '%' || ${params.add(escapeLike(String(c.value ?? '')))} || '%'`;
      break;
    case 'starts_with':
      sql = `${e} ilike ${params.add(escapeLike(String(c.value ?? '')))} || '%'`;
      break;
    case 'equals':
      sql =
        field.key === 'sku'
          ? `v.sku_normalized = upper(regexp_replace(btrim(${params.add(String(c.value ?? ''))}), '\\s+', ' ', 'g'))`
          : `lower(${e}) = lower(${params.add(String(c.value ?? ''))})`;
      break;
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const sym = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' }[c.op];
      sql = `${e} ${sym} ${params.add(decimalValue(field, c.value, vpath))}::numeric`;
      if (c.op === 'neq') sql = `(${e} is null or ${sql})`;
      break;
    }
    case 'between': {
      if (!Array.isArray(c.value) || c.value.length !== 2)
        throw new QueryError(vpath, 'Give [from, to].');
      if (field.kind === 'number') {
        const a = decimalValue(field, c.value[0], vpath);
        const b = decimalValue(field, c.value[1], vpath);
        sql = `${e} between ${params.add(a)}::numeric and ${params.add(b)}::numeric`;
      } else {
        const t = field.sqlType;
        sql = `${e} between ${params.add(dateValue(field, c.value[0], vpath))}::${t} and ${params.add(dateValue(field, c.value[1], vpath))}::${t}`;
      }
      break;
    }
    case 'before':
    case 'after':
    case 'on': {
      const v = `${params.add(dateValue(field, c.value, vpath))}::${field.sqlType}`;
      sql =
        c.op === 'before'
          ? `${e} < ${v}`
          : c.op === 'after'
            ? `${e} > ${v}`
            : field.sqlType === 'date'
              ? `${e} = ${v}`
              : `${e}::date = ${v}::date`;
      break;
    }
    case 'within_next_days':
    case 'within_last_days': {
      const n = Number(c.value);
      if (!Number.isInteger(n) || n < 0 || n > 3650)
        throw new QueryError(vpath, 'Use a number of days, 0 to 3650.');
      const days = `make_interval(days => ${params.add(n)}::int)`;
      const now = field.sqlType === 'date' ? 'current_date' : 'now()';
      sql =
        c.op === 'within_next_days'
          ? `${e} >= ${now} and ${e} <= ${now} + ${days}`
          : `${e} <= ${now} and ${e} >= ${now} - ${days}`;
      break;
    }
    case 'is': {
      if (typeof c.value !== 'boolean') throw new QueryError(vpath, 'Use true or false.');
      sql = `${e} = ${params.add(c.value)}::boolean`;
      break;
    }
    case 'is_any_of':
    case 'is_none_of': {
      const ids = field.def
        ? optionIds(field, c.value, vpath)
        : (Array.isArray(c.value) ? c.value : [c.value]).map(String);
      const p = params.add(ids);
      sql =
        c.op === 'is_any_of'
          ? `${e} = any(${p}::text[])`
          : `(${e} is null or not (${e} = any(${p}::text[])))`;
      break;
    }
    case 'has_any':
    case 'has_all':
    case 'has_none': {
      if (field.kind === 'file') {
        sql = `(jsonb_typeof(${e}) = 'array' and jsonb_array_length(${e}) > 0)`;
        break;
      }
      if (field.sqlType === 'text[]') {
        const tags = (Array.isArray(c.value) ? c.value : [c.value]).map(String);
        const p = params.add(tags);
        sql =
          c.op === 'has_any'
            ? `${e} && ${p}::text[]`
            : c.op === 'has_all'
              ? `${e} @> ${p}::text[]`
              : `not (${e} && ${p}::text[])`;
        break;
      }
      const p = params.add(optionIds(field, c.value, vpath));
      sql =
        c.op === 'has_any'
          ? `coalesce(${e} ?| ${p}::text[], false)`
          : c.op === 'has_all'
            ? `coalesce(${e} ?& ${p}::text[], false)`
            : `not coalesce(${e} ?| ${p}::text[], false)`;
      break;
    }
    case 'has_related': {
      const id = params.add(field.def!.id);
      const targets =
        c.value === undefined || c.value === null
          ? null
          : (Array.isArray(c.value) ? c.value : [c.value]).map(String);
      sql = `exists (select 1 from record_relations r where r.shop_id = p.shop_id and r.field_id = ${id}
        and r.source_id = ${field.def!.level === 'variant' ? 'v.id' : 'p.id'}
        and (${params.add(targets)}::uuid[] is null or r.target_id = any(${params.add(targets)}::uuid[])))`;
      break;
    }
    default:
      throw new QueryError(`${path}.op`, `Unknown operator ${c.op}.`);
  }
  if (perVariant) {
    return `exists (select 1 from variants v where v.shop_id = p.shop_id and v.product_id = p.id
      and v.status = 'active' and (${sql}))`;
  }
  return `(${sql})`;
}

export function compileFilter(
  filter: FilterItem[],
  fields: Map<string, QueryField>,
  params: Params,
  mode: Mode,
): string[] {
  const count = filter.reduce((n, item) => n + ('any' in item ? item.any.length : 1), 0);
  if (count > QUERY_LIMITS.conditions) {
    throw new QueryError('filter', `At most ${QUERY_LIMITS.conditions} conditions.`);
  }
  return filter.map((item, i) =>
    'any' in item
      ? `(${item.any.map((c, j) => compileCondition(c, fields, params, mode, `filter.${i}.any.${j}`)).join(' or ') || 'true'})`
      : compileCondition(item, fields, params, mode, `filter.${i}`),
  );
}

/** Text search: exact SKU, full text on name and description, and trigrams on the name for typos. */
export function compileSearch(
  search: string,
  params: Params,
  mode: Mode,
): { where: string; rank: string } {
  const q = params.add(search);
  const sku = params.add(search.trim().replace(/\s+/g, ' ').toUpperCase());
  const doc = `to_tsvector('simple', p.name || ' ' || coalesce(p.description, ''))`;
  const skuMatch =
    mode === 'variants'
      ? `v.sku_normalized = ${sku} or v.sku_normalized like ${params.add(`${escapeLike(search.trim().toUpperCase())}%`)}`
      : `exists (select 1 from variants sv where sv.shop_id = p.shop_id and sv.product_id = p.id and sv.sku_normalized = ${sku})`;
  // A scanned or typed barcode, and a supplier's SKU, find the variant that carries it (ADR 0019).
  const barcode = params.add(normalizeBarcode(search));
  const variantIds = `(select b.variant_id from barcodes b where b.code_normalized = ${barcode}
    union all select si.variant_id from supplier_items si
      where si.supplier_sku_normalized = ${sku} and si.status = 'active')`;
  const codeMatch =
    mode === 'variants'
      ? `v.id in ${variantIds}`
      : `p.id in (select cv.product_id from variants cv where cv.id in ${variantIds})`;
  // Products whose words or name match, found through the full-text and trigram indexes.
  const byName = `p.id in (select sp.id from products sp where to_tsvector('simple', sp.name || ' ' || coalesce(sp.description, ''))
    @@ plainto_tsquery('simple', ${q}) or sp.name % ${q})`;
  return {
    where: `(${skuMatch} or ${codeMatch} or ${byName})`,
    rank: `(${mode === 'variants' ? `(case when v.sku_normalized = ${sku} or v.id in ${variantIds} then 3 else 0 end)` : '0'}
      + ts_rank(${doc}, plainto_tsquery('simple', ${q})) + similarity(p.name, ${q}))::numeric(12, 6)`,
  };
}

export function sortExpression(
  sort: SortSpec,
  fields: Map<string, QueryField>,
  params: Params,
  mode: Mode,
): { expr: string; sqlType: string } {
  const field = fields.get(sort.field);
  if (!field) throw new QueryError('sort.field', `Unknown field "${sort.field}".`);
  if (!field.sortable) throw new QueryError('sort.field', `${field.label} cannot be sorted.`);
  if (mode === 'products' && field.level === 'variant') {
    // Products sort by their variants' lowest value (prices, SKUs) or total (stock).
    const agg = field.key === 'available' ? 'sum' : 'min';
    const inner = field.expr(params, 'variants');
    return {
      expr: `(select ${agg}(${inner}) from variants v where v.shop_id = p.shop_id and v.product_id = p.id and v.status = 'active')`,
      sqlType: field.sqlType,
    };
  }
  const e = field.expr(params, mode);
  if (field.kind === 'select' && field.def) {
    // Options sort by their position, not their label.
    return {
      expr: `(select o.position from field_options o where o.shop_id = p.shop_id and o.id::text = ${e})`,
      sqlType: 'integer',
    };
  }
  if (field.sqlType === 'text') return { expr: `lower(${e})`, sqlType: 'text' };
  return { expr: e, sqlType: field.sqlType };
}

/** Keyset cursor: the last row's sort value and ID, tied to the sort it was made for. */
export interface Cursor {
  value: string | number | boolean | null;
  id: string;
  sort: string;
}

export function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(text: string, sortKey: string): Cursor {
  try {
    const c = JSON.parse(atob(text.replace(/-/g, '+').replace(/_/g, '/'))) as Cursor;
    if (c.sort !== sortKey || typeof c.id !== 'string' || !/^[0-9a-f-]{36}$/.test(c.id))
      throw new Error();
    return c;
  } catch {
    throw new QueryError(
      'cursor',
      'This cursor belongs to another query. Start from the first page.',
    );
  }
}

/** Rows after the cursor for `order by expr dir nulls last, id`. */
export function keysetCondition(
  expr: string,
  sqlType: string,
  direction: 'asc' | 'desc',
  rowId: string,
  cursor: Cursor,
  params: Params,
): string {
  const v = `${params.add(cursor.value === null ? null : String(cursor.value))}::${sqlType}`;
  const id = `${params.add(cursor.id)}::uuid`;
  const after = direction === 'asc' ? '>' : '<';
  return `((${v} is not null and (${expr} ${after} ${v} or (${expr} = ${v} and ${rowId} > ${id}) or ${expr} is null))
    or (${v} is null and ${expr} is null and ${rowId} > ${id}))`;
}

export { compare };
