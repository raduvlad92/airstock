import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { displayValue } from '../catalog/fields.ts';
import {
  type Cursor,
  compileFilter,
  compileSearch,
  decodeCursor,
  encodeCursor,
  type FilterItem,
  keysetCondition,
  type Mode,
  Params,
  QUERY_LIMITS,
  QueryError,
  type QueryField,
  resolveFields,
  sortExpression,
} from '../catalog/query.ts';
import {
  effectiveCustom,
  type FieldValue,
  inheritableValue,
  type OptionRow,
  variantTitle,
} from '../catalog/records.ts';
import { loadFields, type StoredField, visible } from '../catalog/store.ts';
import { errors } from '../errors.ts';
import { canonicalJson } from '../hash.ts';
import { effectivePermissions } from '../permissions.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id } from '../schemas.ts';

// catalog.items.query: the one read behind the grid, the gallery, exports, and MCP search
// (plan Section 5.10, ADR 0014).

const ConditionInput = z.object({
  field: z
    .string()
    .min(1)
    .max(100)
    .describe(
      'A field key, or a built-in: name, sku, price, status, family, tags, weight, available, created_at, updated_at.',
    ),
  op: z
    .string()
    .min(1)
    .max(30)
    .describe(
      'Text: contains, equals, starts_with. Numbers, money, measurements: eq, neq, lt, lte, gt, gte, between. Dates: before, after, on, between, within_next_days, within_last_days. Single select: is_any_of, is_none_of. Multi select and tags: has_any, has_all, has_none. Boolean: is. Relationships: has_related. Any: is_empty, is_not_empty.',
    ),
  value: z
    .unknown()
    .optional()
    .describe('Option labels or IDs for selects; "2 kg" for measurements; [from, to] for between.'),
});

export const FilterInput = z
  .array(
    z.union([
      ConditionInput,
      z.object({ any: z.array(ConditionInput).min(1).max(QUERY_LIMITS.conditions) }),
    ]),
  )
  .max(QUERY_LIMITS.conditions)
  .describe('All items must match; an {any: [...]} item matches when one of its conditions does.');

export const SortInput = z.object({
  field: z.string().min(1).max(100),
  direction: z.enum(['asc', 'desc']).default('asc'),
});

export const QueryInput = z.object({
  mode: z
    .enum(['variants', 'products'])
    .default('variants')
    .describe(
      'variants: one row per variant (SKU, price, stock). products: one row per product, variant values summarised.',
    ),
  search: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Matches SKUs exactly or by prefix, words in names and descriptions, and names with typos.',
    ),
  filter: FilterInput.optional(),
  sort: SortInput.optional().describe('Defaults to name, or to relevance when searching.'),
  fields: z
    .array(z.string().min(1).max(100))
    .max(100)
    .optional()
    .describe('Custom field keys (and weight, available) to return with each row.'),
  archived: z.enum(['exclude', 'include', 'only']).default('exclude'),
  limit: z.number().int().min(1).max(QUERY_LIMITS.pageSize).default(50),
  cursor: z
    .string()
    .max(4000)
    .optional()
    .describe('nextCursor from the previous page of the same query.'),
});
export type QueryInputType = z.infer<typeof QueryInput>;

const FieldValueOut = z.object({
  value: z.unknown(),
  display: z.string().nullable(),
  source: z.enum(['own', 'inherited', 'cleared', 'none']),
});

export const QueryRow = z.object({
  productId: Id,
  variantId: Id.nullable().describe('Null in products mode.'),
  name: z.string(),
  sku: z.string().nullable(),
  title: z.string().describe('Option values, such as "Black / M".'),
  status: z.string(),
  productStatus: z.string(),
  price: z.string().nullable(),
  familyId: Id.nullable(),
  tags: z.array(z.string()),
  variantCount: z.number().nullable().describe('Products mode: active variants.'),
  priceRange: z.object({ min: z.string().nullable(), max: z.string().nullable() }).nullable(),
  skus: z.array(z.string()).nullable().describe('Products mode: the first few SKUs.'),
  available: z
    .string()
    .nullable()
    .describe('When requested in fields: sellable stock available in your locations.'),
  values: z.record(z.string(), FieldValueOut),
});
export type QueryRowType = z.infer<typeof QueryRow>;

export const QueryOutput = z.object({
  mode: z.enum(['variants', 'products']),
  rows: z.array(QueryRow),
  nextCursor: z.string().nullable(),
  total: z.number().nullable().describe('Matching rows, counted on the first page only.'),
  totalCapped: z.boolean().describe('True when there are more than 10,000 and total stops there.'),
});
export type QueryOutputType = z.infer<typeof QueryOutput>;

interface Row {
  product_id: string;
  name: string;
  product_status: string;
  family_id: string | null;
  tags: string[];
  p_attributes: Record<string, unknown>;
  p_weight: unknown;
  variant_id: string | null;
  sku: string | null;
  price: string | null;
  status: string | null;
  option_value_ids: string[] | null;
  v_attributes: Record<string, unknown> | null;
  v_weight: unknown;
  available: string | null;
  sort_value: string | null;
  variant_count: number | null;
  price_min: string | null;
  price_max: string | null;
  skus: string[] | null;
}

function sortKey(input: QueryInputType, sort: { field: string; direction: string }): string {
  return canonicalJson({ m: input.mode, s: sort, q: input.search ?? null }).slice(0, 200);
}

function buildWhere(
  input: QueryInputType,
  fields: Map<string, QueryField>,
  params: Params,
): { conditions: string[]; rank: string | null } {
  const mode: Mode = input.mode;
  const conditions: string[] = [];
  if (mode === 'variants') {
    if (input.archived === 'exclude')
      conditions.push(`p.status <> 'archived' and v.status = 'active'`);
    if (input.archived === 'only')
      conditions.push(`(p.status = 'archived' or v.status = 'archived')`);
  } else {
    if (input.archived === 'exclude') conditions.push(`p.status <> 'archived'`);
    if (input.archived === 'only') conditions.push(`p.status = 'archived'`);
  }
  let rank: string | null = null;
  if (input.search) {
    const s = compileSearch(input.search, params, mode);
    conditions.push(s.where);
    rank = s.rank;
  }
  conditions.push(...compileFilter((input.filter ?? []) as FilterItem[], fields, params, mode));
  return { conditions, rank };
}

const FROM = {
  variants: 'variants v join products p on p.shop_id = v.shop_id and p.id = v.product_id',
  products: 'products p',
} as const;

/** Runs a catalog query for the caller: filters, search, sort, keyset paging, and selected values. */
export async function runQuery(
  ctx: HandlerContext,
  input: QueryInputType,
  defs?: StoredField[],
): Promise<QueryOutputType> {
  const all = defs ?? visible(await loadFields(ctx.tx, { includeArchived: true }), ctx.membership);
  const fields = resolveFields(all, ctx.locationScope);
  const mode = input.mode;
  const rowId = mode === 'variants' ? 'v.id' : 'p.id';
  try {
    const params = new Params();
    const { conditions, rank } = buildWhere(input, fields, params);
    const sort =
      input.sort ??
      (rank
        ? { field: '__relevance', direction: 'desc' as const }
        : { field: 'name', direction: 'asc' as const });
    const { expr: sortExpr, sqlType } =
      sort.field === '__relevance'
        ? { expr: rank!, sqlType: 'numeric' }
        : sortExpression(sort, fields, params, mode);
    const key = sortKey(input, sort);
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor, key);
      conditions.push(keysetCondition(sortExpr, sqlType, sort.direction, rowId, cursor, params));
    }
    const wanted = new Set(input.fields ?? []);
    for (const k of wanted) {
      if (!fields.has(k)) throw new QueryError('fields', `Unknown field "${k}".`);
    }
    const availableSql =
      mode === 'variants' && wanted.has('available')
        ? fields.get('available')!.expr(params, mode)
        : 'null';
    const select =
      mode === 'variants'
        ? `p.id as product_id, p.name, p.status as product_status, p.family_id, p.tags,
           p.attributes as p_attributes, p.weight as p_weight,
           v.id as variant_id, v.sku, v.price::text as price, v.status, v.option_value_ids,
           v.attributes as v_attributes,
           case when v.weight = 'null'::jsonb then to_jsonb('cleared'::text) else v.weight end as v_weight,
           ${availableSql}::text as available,
           null::int as variant_count, null as price_min, null as price_max, null::text[] as skus`
        : `p.id as product_id, p.name, p.status as product_status, p.family_id, p.tags,
           p.attributes as p_attributes, p.weight as p_weight,
           null::uuid as variant_id, null as sku, null as price, null as status, null::uuid[] as option_value_ids,
           null::jsonb as v_attributes, null::jsonb as v_weight, null as available,
           va.variant_count, va.price_min, va.price_max, va.skus`;
    const lateral =
      mode === 'products'
        ? `left join lateral (select count(*)::int as variant_count, min(x.price)::text as price_min,
             max(x.price)::text as price_max, (array_agg(x.sku order by x.sku))[1:3] as skus
           from variants x where x.shop_id = p.shop_id and x.product_id = p.id and x.status = 'active') va on true`
        : '';
    const limit = params.add(input.limit + 1);
    const rows = await ctx.tx.query<Row>(
      `select ${select}, (${sortExpr})::text as sort_value
       from ${FROM[mode]} ${lateral}
       where ${conditions.join(' and ') || 'true'}
       order by ${sortExpr} ${sort.direction} nulls last, ${rowId}
       limit ${limit}`,
      params.values,
    );
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > input.limit && last
        ? encodeCursor({
            value: last.sort_value,
            id: (mode === 'variants' ? last.variant_id : last.product_id)!,
            sort: key,
          } satisfies Cursor)
        : null;
    let total: number | null = null;
    let totalCapped = false;
    if (!input.cursor) {
      const countParams = new Params();
      const where = buildWhere(input, fields, countParams).conditions;
      const cap = countParams.add(QUERY_LIMITS.countCap + 1);
      const [count] = await ctx.tx.query<{ n: number }>(
        `select count(*)::int as n from (select 1 from ${FROM[mode]} where ${where.join(' and ') || 'true'} limit ${cap}) x`,
        countParams.values,
      );
      total = Math.min(count!.n, QUERY_LIMITS.countCap);
      totalCapped = count!.n > QUERY_LIMITS.countCap;
    }
    return {
      mode,
      rows: await shapeRows(ctx.tx, page, mode, all, wanted),
      nextCursor,
      total,
      totalCapped,
    };
  } catch (error) {
    if (error instanceof QueryError)
      throw errors.validation([{ path: error.path, message: error.message }]);
    throw error;
  }
}

async function shapeRows(
  tx: Tx,
  page: Row[],
  mode: Mode,
  defs: StoredField[],
  wanted: Set<string>,
): Promise<QueryRowType[]> {
  if (page.length === 0) return [];
  const productIds = [...new Set(page.map((r) => r.product_id))];
  const options =
    mode === 'variants'
      ? await tx.query<OptionRow & { product_id: string }>(
          `select o.product_id, o.id, o.name, o.position,
             coalesce((select json_agg(json_build_object('id', x.id, 'label', x.label, 'position', x.position)
                 order by x.position) from product_option_values x where x.shop_id = o.shop_id and x.option_id = o.id), '[]') as values
           from product_options o where o.product_id = any($1::uuid[]) order by o.position`,
          [productIds],
        )
      : [];
  const custom = defs.filter((d) => wanted.has(d.key));
  const relationDefs = custom.filter((d) => d.type === 'relationship');
  const relations = new Map<string, string[]>();
  if (relationDefs.length > 0) {
    const ids = [
      ...productIds,
      ...page.map((r) => r.variant_id).filter((x): x is string => Boolean(x)),
    ];
    const rels = await tx.query<{ field_id: string; source_id: string; target_id: string }>(
      `select field_id, source_id, target_id from record_relations
       where field_id = any($1::uuid[]) and source_id = any($2::uuid[]) order by position`,
      [relationDefs.map((d) => d.id), ids],
    );
    for (const r of rels) {
      const k = `${r.field_id}:${r.source_id}`;
      relations.set(k, [...(relations.get(k) ?? []), r.target_id]);
    }
  }
  // Products mode summarises variant-level values: the distinct values across active variants.
  const variantValues =
    mode === 'products' && custom.some((d) => d.level === 'variant')
      ? await tx.query<{ product_id: string; attributes: Record<string, unknown> }>(
          `select product_id, attributes from variants where product_id = any($1::uuid[]) and status = 'active'`,
          [productIds],
        )
      : [];
  return page.map((r) => {
    const values: Record<string, FieldValue> = {};
    const product = { attributes: r.p_attributes };
    for (const def of custom) {
      if (mode === 'variants') {
        if (def.level === 'product') {
          values[def.key] = effectiveCustom(def, 'product', r.product_id, product, null, relations);
        } else {
          values[def.key] = effectiveCustom(
            def,
            'variant',
            r.variant_id!,
            product,
            { attributes: r.v_attributes ?? {} },
            relations,
          );
        }
      } else if (def.level === 'variant') {
        const distinct = new Map<string, unknown>();
        for (const v of variantValues.filter((x) => x.product_id === r.product_id)) {
          const value = v.attributes[def.id];
          if (value !== undefined && value !== null) distinct.set(JSON.stringify(value), value);
        }
        const list = [...distinct.values()];
        values[def.key] = {
          value: list,
          display: list.length ? list.map((x) => displayValue(def, x)).join(', ') : null,
          source: list.length ? 'own' : 'none',
        };
      } else {
        values[def.key] = effectiveCustom(def, 'product', r.product_id, product, null, relations);
      }
    }
    if (wanted.has('weight')) {
      values.weight =
        mode === 'variants'
          ? inheritableValue(r.v_weight, r.p_weight)
          : { value: r.p_weight, display: null, source: r.p_weight ? 'own' : 'none' };
    }
    const productOptions = options.filter((o) => o.product_id === r.product_id);
    return {
      productId: r.product_id,
      variantId: r.variant_id,
      name: r.name,
      sku: r.sku,
      title: r.option_value_ids ? variantTitle(productOptions, r.option_value_ids) : '',
      status: r.status ?? r.product_status,
      productStatus: r.product_status,
      price: r.price,
      familyId: r.family_id,
      tags: r.tags,
      variantCount: r.variant_count,
      priceRange: mode === 'products' ? { min: r.price_min, max: r.price_max } : null,
      skus: r.skus,
      available: r.available,
      values,
    };
  });
}

export const queryItems = defineOperation({
  id: 'catalog.items.query',
  summary: 'Search, filter, and sort the catalog',
  description:
    'One page of products or variants. Combine `search`, a `filter` on any built-in or custom field (see describe_catalog for keys and options), and a `sort`; pass `nextCursor` back for the next page. Ask for custom field values with `fields`.',
  kind: 'read',
  scope: 'shop',
  input: QueryInput,
  output: QueryOutput,
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.items.queried' },
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/items/query' },
  mcp: { tool: 'search_catalog', action: 'query', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const result = await runQuery(ctx, input);
    return {
      result,
      audit: {
        targetType: 'catalog_query',
        targetId: input.mode,
        // Every query is an attributable read with its filters (A10).
        context: {
          mode: input.mode,
          search: input.search ?? null,
          filter: input.filter ?? [],
          sort: input.sort ?? null,
          fields: input.fields ?? [],
          archived: input.archived,
          page: input.cursor ? 'next' : 'first',
          returned: result.rows.length,
          total: result.total,
        },
      },
    };
  },
});

// Duplicates ---------------------------------------------------------------------------------

/** Similar-name threshold (plan 5.7: 0.6 proposed, tuned on the A01 data). */
export const SIMILARITY_THRESHOLD = 0.6;

export const DuplicateMatches = z.object({
  skuTaken: z
    .object({ variantId: Id, productId: Id, sku: z.string(), name: z.string() })
    .nullable(),
  barcodeTaken: z.object({ ownerType: z.string(), ownerId: Id, code: z.string() }).nullable(),
  similarNames: z.array(z.object({ productId: Id, name: z.string(), similarity: z.number() })),
});
export type DuplicateMatchesType = z.infer<typeof DuplicateMatches>;

/** Hook for barcode ownership (milestone N5 registers the lookup). */
export const duplicateHooks: {
  barcodeOwner?: (
    tx: Tx,
    code: string,
  ) => Promise<{ ownerType: string; ownerId: string; code: string } | null>;
} = {};

/**
 * The one duplicate check every create path runs (plan Section 5.7): the same normalized SKU or
 * barcode is blocked; names above the similarity threshold come back as likely matches.
 */
export async function findDuplicates(
  tx: Tx,
  input: {
    name?: string | undefined;
    sku?: string | undefined;
    barcode?: string | undefined;
    excludeProductId?: string | undefined;
  },
): Promise<DuplicateMatchesType> {
  let skuTaken: DuplicateMatchesType['skuTaken'] = null;
  if (input.sku) {
    const [row] = await tx.query<{ id: string; product_id: string; sku: string; name: string }>(
      `select v.id, v.product_id, v.sku, p.name from variants v
       join products p on p.shop_id = v.shop_id and p.id = v.product_id
       where v.sku_normalized = upper(regexp_replace(btrim($1), '\\s+', ' ', 'g'))`,
      [input.sku],
    );
    if (row)
      skuTaken = { variantId: row.id, productId: row.product_id, sku: row.sku, name: row.name };
  }
  const barcodeTaken =
    input.barcode && duplicateHooks.barcodeOwner
      ? await duplicateHooks.barcodeOwner(tx, input.barcode)
      : null;
  let similarNames: DuplicateMatchesType['similarNames'] = [];
  if (input.name?.trim()) {
    const rows = await tx.query<{ id: string; name: string; similarity: number }>(
      `select id, name, round(greatest(similarity(name, $1),
           case when lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim($1), '\\s+', ' ', 'g'))
             then 1 else 0 end)::numeric, 3)::float8 as similarity
       from products
       where (name % $1 or lower(name) = lower($1)) and status <> 'archived'
         and ($2::uuid is null or id <> $2)
       order by similarity desc, id limit 20`,
      [input.name.trim(), input.excludeProductId ?? null],
    );
    similarNames = rows
      .filter((r) => r.similarity >= SIMILARITY_THRESHOLD)
      .slice(0, 5)
      .map((r) => ({ productId: r.id, name: r.name, similarity: r.similarity }));
  }
  return { skuTaken, barcodeTaken, similarNames };
}

export const checkDuplicates = defineOperation({
  id: 'catalog.duplicates.check',
  summary: 'Check a name, SKU, or barcode for duplicates before creating',
  description:
    'Returns the record already using the SKU or barcode, and products with similar names. Creating with a taken SKU or barcode is refused; creating with a similar name needs acknowledgeSimilar.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    name: z.string().trim().max(500).optional(),
    sku: z.string().trim().min(1).max(100).optional(),
    barcode: z.string().trim().min(1).max(200).optional(),
    excludeProductId: Id.optional().describe('Leave this product out, when renaming it.'),
  }),
  output: DuplicateMatches,
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.duplicates.checked' },
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/items/duplicates' },
  mcp: { tool: 'search_catalog', action: 'check_duplicates', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const result = await findDuplicates(ctx.tx, input);
    return {
      result,
      audit: {
        targetType: 'catalog_duplicates',
        targetId: 'check',
        context: {
          name: input.name ?? null,
          sku: input.sku ?? null,
          skuTaken: result.skuTaken?.variantId ?? null,
          similar: result.similarNames.map((s) => s.productId),
        },
      },
    };
  },
});

// Saved views --------------------------------------------------------------------------------

const ColumnInput = z.object({
  key: z.string().min(1).max(100),
  width: z.number().int().min(40).max(1200).optional(),
  hidden: z.boolean().optional(),
});

export const ViewDefinition = z.object({
  mode: z.enum(['variants', 'products']),
  viewType: z.enum(['grid', 'gallery']).default('grid'),
  columns: z.array(ColumnInput).max(150).default([]),
  sort: SortInput.optional(),
  filter: FilterInput.optional(),
  search: z.string().trim().max(200).optional(),
  density: z.enum(['compact', 'comfortable']).default('compact'),
});

const SavedViewOut = z.object({
  id: Id,
  name: z.string(),
  shared: z.boolean(),
  mine: z.boolean(),
  definition: ViewDefinition,
  version: z.number(),
  updatedAt: z.string(),
});

const VIEW_EXCEPTION = 'Saved views are interface preferences, kept in the dashboard.';

async function viewOut(tx: Tx, id: string, membershipId: string) {
  const [row] = await tx.query<{
    id: string;
    name: string;
    shared: boolean;
    owner_membership_id: string;
    definition: z.infer<typeof ViewDefinition>;
    version: number;
    updated_at: Date;
  }>(
    'select id, name, shared, owner_membership_id, definition, version, updated_at from saved_views where id = $1',
    [id],
  );
  if (!row) throw errors.notFound('Saved view');
  return {
    id: row.id,
    name: row.name,
    shared: row.shared,
    mine: row.owner_membership_id === membershipId,
    definition: row.definition,
    version: row.version,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Another member's private view does not exist for the caller. */
function assertCanChange(
  ctx: HandlerContext,
  row: { owner_membership_id: string; shared: boolean },
) {
  if (row.owner_membership_id !== ctx.membership?.id && !row.shared)
    throw errors.notFound('Saved view');
}

export const listSavedViews = defineOperation({
  id: 'catalog.saved_views.list',
  summary: 'List your saved views and the shop’s shared ones',
  kind: 'read',
  scope: 'shop',
  input: z.object({}),
  output: z.object({ views: z.array(SavedViewOut) }),
  permission: 'catalog.read',
  connectionScope: 'session',
  audit: { action: 'catalog.saved_views.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/saved-views' },
  mcp: { exception: VIEW_EXCEPTION },
  async handler(ctx) {
    const rows = await ctx.tx.query<{ id: string }>(
      `select id from saved_views where shared or owner_membership_id = $1 order by lower(name), id limit 200`,
      [ctx.membership!.id],
    );
    const views = [];
    for (const r of rows) views.push(await viewOut(ctx.tx, r.id, ctx.membership!.id));
    return { result: { views }, audit: { targetType: 'saved_view', targetId: 'list' } };
  },
});

export const saveView = defineOperation({
  id: 'catalog.saved_views.save',
  summary: 'Create or change a saved view',
  description:
    'Without viewId, creates a view. A shared view is visible to the whole shop; sharing or changing a shared view needs catalog.write.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    viewId: Id.optional(),
    expectedVersion: z.number().int().optional(),
    name: z.string().trim().min(1).max(100),
    shared: z.boolean().default(false),
    definition: ViewDefinition,
  }),
  output: z.object({ view: SavedViewOut }),
  permission: 'catalog.read',
  connectionScope: 'session',
  audit: { action: 'catalog.saved_view.saved' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/saved-views' },
  mcp: { exception: VIEW_EXCEPTION },
  async handler(ctx, input) {
    const membershipId = ctx.membership!.id;
    const canWrite = hasPermission(ctx, 'catalog.write');
    if (input.shared && !canWrite)
      throw errors.forbidden('Sharing a view needs the catalog.write permission.');
    const definition = JSON.stringify(input.definition);
    if (!input.viewId) {
      const id = ctx.newId();
      await ctx.tx.query(
        `insert into saved_views (shop_id, id, owner_membership_id, name, shared, definition)
         values (app_shop_id(), $1, $2, $3, $4, $5)`,
        [id, membershipId, input.name, input.shared, definition],
      );
      const view = await viewOut(ctx.tx, id, membershipId);
      return {
        result: { view },
        audit: {
          targetType: 'saved_view',
          targetId: id,
          changes: { name: input.name, shared: input.shared, definition: input.definition },
        },
      };
    }
    const [row] = await ctx.tx.query<{
      owner_membership_id: string;
      shared: boolean;
      version: number;
      definition: unknown;
      name: string;
    }>(
      'select owner_membership_id, shared, version, definition, name from saved_views where id = $1 for update',
      [input.viewId],
    );
    if (!row) throw errors.notFound('Saved view');
    assertCanChange(ctx, row);
    if (row.owner_membership_id !== membershipId && !canWrite) {
      throw errors.forbidden('Changing a shared view needs the catalog.write permission.');
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
      throw errors.conflict('version_conflict', 'The view changed since you opened it.', {
        currentVersion: row.version,
      });
    }
    await ctx.tx.query(
      `update saved_views set name = $2, shared = $3, definition = $4, version = version + 1, updated_at = now() where id = $1`,
      [input.viewId, input.name, input.shared, definition],
    );
    const view = await viewOut(ctx.tx, input.viewId, membershipId);
    return {
      result: { view },
      audit: {
        targetType: 'saved_view',
        targetId: input.viewId,
        changes: {
          from: { name: row.name, shared: row.shared, definition: row.definition },
          to: { name: input.name, shared: input.shared, definition: input.definition },
        },
      },
    };
  },
});

export const deleteView = defineOperation({
  id: 'catalog.saved_views.delete',
  summary: 'Delete a saved view',
  kind: 'command',
  scope: 'shop',
  input: z.object({ viewId: Id }),
  output: z.object({ deleted: z.boolean() }),
  permission: 'catalog.read',
  connectionScope: 'session',
  audit: { action: 'catalog.saved_view.deleted' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/saved-views/{viewId}/delete' },
  mcp: { exception: VIEW_EXCEPTION },
  async handler(ctx, input) {
    const [row] = await ctx.tx.query<{
      owner_membership_id: string;
      shared: boolean;
      name: string;
    }>('select owner_membership_id, shared, name from saved_views where id = $1 for update', [
      input.viewId,
    ]);
    if (!row) throw errors.notFound('Saved view');
    assertCanChange(ctx, row);
    if (row.owner_membership_id !== ctx.membership!.id && !hasPermission(ctx, 'catalog.write')) {
      throw errors.forbidden('Deleting a shared view needs the catalog.write permission.');
    }
    await ctx.tx.query('delete from saved_views where id = $1', [input.viewId]);
    return {
      result: { deleted: true },
      audit: { targetType: 'saved_view', targetId: input.viewId, changes: { name: row.name } },
    };
  },
});

/** A shared view may be changed by anyone with catalog.write; a private one only by its owner. */
function hasPermission(ctx: HandlerContext, permission: 'catalog.write'): boolean {
  return ctx.membership ? effectivePermissions(ctx.membership).has(permission) : false;
}
