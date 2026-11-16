import type { Tx } from '@airstock/db';
import { z } from 'zod';
import type { AuditEvent } from '../audit.ts';
import { checkBarcode, inferSymbology, type Symbology } from '../catalog/barcodes.ts';
import { comparable, encodeValue, FIELD_LIMITS, type FieldDefinition } from '../catalog/fields.ts';
import {
  attributesSize,
  BUILTIN_FIELDS,
  type BuiltinField,
  builtin,
  effectiveCustom,
  type FieldValue,
  inheritableValue,
  loadOptions,
  type OptionRow,
  PRODUCT_COLUMNS,
  type ProductRow,
  type RecordType,
  VARIANT_COLUMNS,
  type VariantRow,
  variantTitle,
} from '../catalog/records.ts';
import {
  findField,
  loadFields,
  type StoredField,
  shopSettings,
  visible,
} from '../catalog/store.ts';
import { errors } from '../errors.ts';
import { fileFieldIssue } from '../media/library.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id, iso, normalizeSku } from '../schemas.ts';
import { findDuplicates } from './catalog-query.ts';

// Products and variants: create, read, field-level compare-and-set updates, archive and restore
// (plan Sections 5.1 and 5.11, ADRs 0012 and 0013).

const TOOL = 'edit_catalog';

const FieldValueOut = z.object({
  value: z.unknown(),
  display: z.string().nullable(),
  source: z.enum(['own', 'inherited', 'cleared', 'none']),
});

const OptionOut = z.object({
  id: Id,
  name: z.string(),
  position: z.number(),
  values: z.array(z.object({ id: Id, label: z.string(), position: z.number() })),
});

export const VariantOut = z.object({
  id: Id,
  sku: z.string(),
  title: z.string().describe('Option values, such as "Black / M"; empty for a single variant.'),
  optionValues: z.record(z.string(), z.string()).describe('Option name → value label.'),
  optionValueIds: z.array(Id),
  price: z.string().nullable(),
  baseUnit: z.string(),
  quantityScale: z.number(),
  trackingMode: z.string(),
  status: z.enum(['active', 'archived']),
  isDefault: z.boolean(),
  version: z.number(),
  weight: FieldValueOut,
  dimensions: FieldValueOut,
  fields: z.record(z.string(), FieldValueOut).describe('Custom fields by key.'),
});

export const ItemDetail = z.object({
  product: z.object({
    id: Id,
    name: z.string(),
    description: z.string().nullable(),
    status: z.enum(['draft', 'active', 'archived']),
    family: z.object({ id: Id, name: z.string() }).nullable(),
    tags: z.array(z.string()),
    weight: z.unknown(),
    dimensions: z.unknown(),
    version: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    fields: z.record(z.string(), FieldValueOut).describe('Custom fields by key.'),
  }),
  options: z.array(OptionOut),
  variants: z.array(VariantOut),
  incoming: z
    .array(
      z.object({
        field: z.string(),
        relationKind: z.string().nullable(),
        sourceType: z.enum(['product', 'variant']),
        sourceId: Id,
        sourceName: z.string(),
        targetId: Id,
      }),
    )
    .describe('Relationships other records have to this one, such as "replaces".'),
});
export type ItemDetailOut = z.infer<typeof ItemDetail>;

// Loading ----------------------------------------------------------------------------------

interface Loaded {
  product: ProductRow;
  variants: VariantRow[];
  options: OptionRow[];
  relations: Map<string, string[]>;
  familyFieldIds: Set<string>;
}

async function loadItem(tx: Tx, productId: string, lock = false): Promise<Loaded> {
  const [product] = await tx.query<ProductRow>(
    `select ${PRODUCT_COLUMNS} from products where id = $1${lock ? ' for update' : ''}`,
    [productId],
  );
  if (!product) throw errors.notFound('Product');
  const variants = await tx.query<VariantRow>(
    `select ${VARIANT_COLUMNS} from variants where product_id = $1 order by id${lock ? ' for update' : ''}`,
    [productId],
  );
  const options = await loadOptions(tx, productId);
  const ids = [productId, ...variants.map((v) => v.id)];
  const rels = await tx.query<{ field_id: string; source_id: string; target_id: string }>(
    'select field_id, source_id, target_id from record_relations where source_id = any($1::uuid[]) order by position, id',
    [ids],
  );
  const relations = new Map<string, string[]>();
  for (const r of rels) {
    const key = `${r.field_id}:${r.source_id}`;
    relations.set(key, [...(relations.get(key) ?? []), r.target_id]);
  }
  const familyFieldIds = new Set(
    product.family_id
      ? (
          await tx.query<{ field_id: string }>(
            'select field_id from family_fields where family_id = $1',
            [product.family_id],
          )
        ).map((r) => r.field_id)
      : [],
  );
  return { product, variants, options, relations, familyFieldIds };
}

function builtinValue(
  field: BuiltinField,
  record: RecordType,
  product: ProductRow,
  variant: VariantRow | null,
): FieldValue {
  const productValue = (product as unknown as Record<string, unknown>)[field.column] ?? null;
  if (record === 'product')
    return { value: productValue, display: null, source: productValue === null ? 'none' : 'own' };
  const raw = (variant as unknown as Record<string, unknown>)[field.column];
  if (field.level === 'both') return inheritableValue(raw, productValue);
  return {
    value: raw ?? null,
    display: null,
    source: raw === null || raw === undefined ? 'none' : 'own',
  };
}

function inScope(def: FieldDefinition, record: RecordType): boolean {
  return record === 'product' ? def.level !== 'variant' : def.level !== 'product';
}

export async function itemDetail(
  ctx: HandlerContext,
  productId: string,
  fields?: StoredField[],
): Promise<ItemDetailOut> {
  const loaded = await loadItem(ctx.tx, productId);
  const defs = visible(fields ?? (await loadFields(ctx.tx)), ctx.membership);
  return renderDetail(ctx.tx, loaded, defs);
}

async function renderDetail(tx: Tx, loaded: Loaded, defs: StoredField[]): Promise<ItemDetailOut> {
  const { product, variants, options, relations, familyFieldIds } = loaded;
  const fieldsFor = (record: RecordType, recordId: string, variant: VariantRow | null) => {
    const out: Record<string, FieldValue> = {};
    for (const def of defs) {
      if (!inScope(def, record)) continue;
      const v = effectiveCustom(def, record, recordId, product, variant, relations);
      if (v.source !== 'none' || familyFieldIds.has(def.id)) out[def.key] = v;
    }
    return out;
  };
  const [family] = product.family_id
    ? await tx.query<{ id: string; name: string }>(
        'select id, name from product_families where id = $1',
        [product.family_id],
      )
    : [];
  const ids = [product.id, ...variants.map((v) => v.id)];
  const incoming = await tx.query<{
    field_id: string;
    source_type: 'product' | 'variant';
    source_id: string;
    target_id: string;
    source_name: string;
  }>(
    `select r.field_id, r.source_type, r.source_id, r.target_id,
       coalesce(p.name, vp.name || ' · ' || v.sku) as source_name
     from record_relations r
     left join products p on r.source_type = 'product' and p.shop_id = r.shop_id and p.id = r.source_id
     left join variants v on r.source_type = 'variant' and v.shop_id = r.shop_id and v.id = r.source_id
     left join products vp on vp.shop_id = v.shop_id and vp.id = v.product_id
     where r.target_id = any($1::uuid[]) order by r.created_at limit 500`,
    [ids],
  );
  const byId = new Map(defs.map((d) => [d.id, d]));
  return {
    product: {
      id: product.id,
      name: product.name,
      description: product.description,
      status: product.status,
      family: family ?? null,
      tags: product.tags,
      weight: product.weight,
      dimensions: product.dimensions,
      version: product.version,
      createdAt: iso(product.created_at) as string,
      updatedAt: iso(product.updated_at) as string,
      fields: fieldsFor('product', product.id, null),
    },
    options,
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      title: variantTitle(options, v.option_value_ids),
      optionValues: Object.fromEntries(
        options
          .map((o) => [o.name, o.values.find((x) => v.option_value_ids.includes(x.id))?.label])
          .filter((e): e is [string, string] => typeof e[1] === 'string'),
      ),
      optionValueIds: v.option_value_ids,
      price: v.price,
      baseUnit: v.base_unit,
      quantityScale: v.quantity_scale,
      trackingMode: v.tracking_mode,
      status: v.status,
      isDefault: v.is_default,
      version: v.version,
      weight: inheritableValue(v.weight, product.weight),
      dimensions: inheritableValue(v.dimensions, product.dimensions),
      fields: fieldsFor('variant', v.id, v),
    })),
    incoming: incoming
      .filter((r) => byId.has(r.field_id))
      .map((r) => ({
        field: byId.get(r.field_id)!.key,
        relationKind: (byId.get(r.field_id)!.config.relationKind as string | undefined) ?? null,
        sourceType: r.source_type,
        sourceId: r.source_id,
        sourceName: r.source_name,
        targetId: r.target_id,
      })),
  };
}

// Changes ----------------------------------------------------------------------------------

export const ChangeInput = z.object({
  variantId: Id.optional().describe('Leave out to change the product itself.'),
  field: z
    .string()
    .min(1)
    .max(100)
    .describe(
      'A built-in field (name, description, status, family, tags, weight, dimensions; on variants sku, price, weight, dimensions, baseUnit, quantityScale) or a custom field key.',
    ),
  expected: z
    .unknown()
    .describe(
      'The value you last read for this field (null if it was empty). If someone changed it since, nothing is changed and you get a conflict with the current value.',
    ),
  value: z.unknown().optional().describe('The new value; null clears it.'),
  inherit: z
    .boolean()
    .optional()
    .describe('Variants only: remove the variant’s own value so it inherits the product’s again.'),
});
export type Change = z.infer<typeof ChangeInput>;

interface Conflict {
  recordType: RecordType;
  recordId: string;
  field: string;
  expected: unknown;
  current: unknown;
  changedBy: {
    actorType: string;
    actorId: string | null;
    source: string;
    clientId: string | null;
    at: string;
  } | null;
}

async function lastChange(tx: Tx, recordType: RecordType, recordId: string, field: string) {
  const [row] = await tx.query<{
    actor_type: string;
    actor_id: string | null;
    source: string;
    client_id: string | null;
    occurred_at: Date;
  }>(
    `select actor_type, actor_id, source, client_id, occurred_at from audit_events
     where shop_id = app_shop_id() and target_type = $1 and target_id = $2 and phase = 'outcome'
       and outcome = 'succeeded' and changes->'fields' ? $3
     order by occurred_at desc limit 1`,
    [recordType, recordId, field],
  );
  return row
    ? {
        actorType: row.actor_type,
        actorId: row.actor_id,
        source: row.source,
        clientId: row.client_id,
        at: iso(row.occurred_at) as string,
      }
    : null;
}

interface RecordWrite {
  type: RecordType;
  id: string;
  columns: Map<string, unknown>;
  /** Custom fields: a value, null (cleared on a variant / removed on a product), or undefined to inherit. */
  attributes: Map<string, { value: unknown; inherit: boolean }>;
  relations: Map<string, string[]>;
  log: Record<string, { from: unknown; to: unknown }>;
}

export interface ApplyResult {
  writes: RecordWrite[];
  definitionVersions: Record<string, number>;
}

/**
 * Applies field changes to one product and its variants, all or nothing (D3, Q4). Each change
 * carries the value the caller last read; if the current value differs, nothing is written and the
 * conflict says who changed it. Different fields never conflict with each other.
 */
export async function applyChanges(
  ctx: HandlerContext,
  productId: string,
  changes: Change[],
  opts: { expectCurrent?: boolean } = {},
): Promise<{ result: ApplyResult; loaded: Loaded; defs: StoredField[] }> {
  const loaded = await loadItem(ctx.tx, productId, true);
  const { product, variants } = loaded;
  const allDefs = await loadFields(ctx.tx, { includeArchived: true });
  const defs = visible(allDefs, ctx.membership);
  const { currency } = await shopSettings(ctx.tx);
  const writes = new Map<string, RecordWrite>();
  const conflicts: Conflict[] = [];
  const issues: Array<{ path: string; message: string }> = [];
  const definitionVersions: Record<string, number> = {};
  const touchedRequired = new Set<string>();

  const writeFor = (type: RecordType, id: string): RecordWrite => {
    let w = writes.get(id);
    if (!w) {
      w = { type, id, columns: new Map(), attributes: new Map(), relations: new Map(), log: {} };
      writes.set(id, w);
    }
    return w;
  };

  for (const [i, change] of changes.entries()) {
    const path = `changes.${i}`;
    const recordType: RecordType = change.variantId ? 'variant' : 'product';
    const variant = change.variantId ? variants.find((v) => v.id === change.variantId) : null;
    if (change.variantId && !variant) {
      issues.push({ path: `${path}.variantId`, message: 'Not a variant of this product.' });
      continue;
    }
    const recordId = variant?.id ?? product.id;
    if (change.value === undefined && !change.inherit) {
      issues.push({
        path: `${path}.value`,
        message: 'Give a value, null to clear, or inherit: true.',
      });
      continue;
    }
    const bf = builtin(change.field, recordType);
    const def = bf ? undefined : findField(defs, change.field);
    if (!bf && !def) {
      issues.push({
        path: `${path}.field`,
        message: `No field "${change.field}" on a ${recordType}.`,
      });
      continue;
    }
    if (def && !inScope(def, recordType)) {
      issues.push({
        path: `${path}.field`,
        message: `${def.label} is a ${def.level}-level field.`,
      });
      continue;
    }
    if (def && def.status !== 'active') {
      issues.push({ path: `${path}.field`, message: `${def.label} is archived.` });
      continue;
    }
    const inheritAllowed =
      recordType === 'variant' && (bf ? bf.level === 'both' : def!.level === 'both');
    if (change.inherit && !inheritAllowed) {
      issues.push({
        path: `${path}.inherit`,
        message: 'Only variant values of shared fields inherit.',
      });
      continue;
    }
    // Compare-and-set on the value the caller saw.
    const current = bf
      ? builtinValue(bf, recordType, product, variant ?? null).value
      : effectiveCustom(def!, recordType, recordId, product, variant ?? null, loaded.relations)
          .value;
    const cmp = (v: unknown) => (bf ? bf.comparable(v) : comparable(def!, v));
    let expected: unknown = change.expected ?? null;
    if (def && expected !== null) {
      const encoded = encodeValue(def, expected, { currency, current });
      if (encoded.ok) expected = encoded.value;
    }
    // A bulk preview takes the current values as expected; its commit then checks them (D4).
    if (!opts.expectCurrent && cmp(expected) !== cmp(current)) {
      conflicts.push({
        recordType,
        recordId,
        field: bf ? bf.key : def!.key,
        expected: change.expected ?? null,
        current,
        changedBy: null,
      });
      continue;
    }
    const w = writeFor(recordType, recordId);
    if (bf) {
      if (change.inherit) {
        w.columns.set(bf.column, undefined);
        w.log[bf.key] = { from: current, to: { inherit: true } };
        continue;
      }
      const encoded = bf.encode(change.value);
      if (!encoded.ok) {
        issues.push({ path: `${path}.value`, message: encoded.message });
        continue;
      }
      w.columns.set(bf.column, encoded.value);
      w.log[bf.key] = { from: current, to: encoded.value };
      continue;
    }
    definitionVersions[def!.key] = def!.version;
    if (change.inherit) {
      w.attributes.set(def!.id, { value: undefined, inherit: true });
      w.log[def!.key] = { from: current, to: { inherit: true } };
      touchedRequired.add(def!.id);
      continue;
    }
    const encoded = encodeValue(def!, change.value, { currency, current });
    if (!encoded.ok) {
      issues.push({ path: `${path}.value`, message: encoded.message });
      continue;
    }
    if (def!.type === 'file' && encoded.value !== null) {
      const issue = await fileFieldIssue(ctx.tx, def!, encoded.value as string[]);
      if (issue) {
        issues.push({ path: `${path}.value`, message: issue });
        continue;
      }
    }
    if (encoded.value === null) touchedRequired.add(def!.id);
    if (def!.type === 'relationship')
      w.relations.set(def!.id, (encoded.value as string[] | null) ?? []);
    else w.attributes.set(def!.id, { value: encoded.value, inherit: false });
    w.log[def!.key] = { from: current, to: encoded.value };
  }

  if (issues.length > 0) throw errors.validation(issues);
  if (conflicts.length > 0) {
    for (const c of conflicts)
      c.changedBy = await lastChange(ctx.tx, c.recordType, c.recordId, c.field);
    throw errors.conflict(
      'edit_conflict',
      'Someone changed these fields since you read them. Nothing was changed.',
      { conflicts },
    );
  }
  await validateWrites(ctx, loaded, [...writes.values()], allDefs);
  await checkRequired(ctx, loaded, [...writes.values()], defs, touchedRequired);
  return { result: { writes: [...writes.values()], definitionVersions }, loaded, defs };
}

/** Rules that need the database: unique SKUs, existing families and targets, units with stock. */
async function validateWrites(
  ctx: HandlerContext,
  loaded: Loaded,
  writes: RecordWrite[],
  defs: StoredField[],
) {
  const skus = writes
    .filter((w) => w.columns.has('sku'))
    .map((w) => ({ id: w.id, sku: normalizeSku(w.columns.get('sku') as string) }));
  if (new Set(skus.map((s) => s.sku)).size !== skus.length) {
    throw errors.conflict('duplicate_sku', 'Two variants would have the same SKU.');
  }
  for (const s of skus) {
    const [taken] = await ctx.tx.query<{ id: string }>(
      'select id from variants where sku_normalized = $1 and id <> $2',
      [s.sku, s.id],
    );
    if (taken) {
      throw errors.conflict('duplicate_sku', 'A variant with this SKU already exists.', {
        existingVariantId: taken.id,
      });
    }
  }
  for (const w of writes) {
    if (w.columns.has('family_id') && w.columns.get('family_id')) {
      const [family] = await ctx.tx.query<{ status: string }>(
        'select status from product_families where id = $1',
        [w.columns.get('family_id')],
      );
      if (!family) throw errors.notFound('Family');
      if (family.status !== 'active')
        throw errors.conflict('family_archived', 'The family is archived.');
    }
    if (w.type === 'variant' && (w.columns.has('base_unit') || w.columns.has('quantity_scale'))) {
      const variant = loaded.variants.find((v) => v.id === w.id)!;
      const narrowing =
        w.columns.has('base_unit') && w.columns.get('base_unit') !== variant.base_unit
          ? true
          : w.columns.has('quantity_scale') &&
            (w.columns.get('quantity_scale') as number) < variant.quantity_scale;
      if (narrowing) {
        const [history] = await ctx.tx.query(
          'select 1 from inventory_entries where variant_id = $1 limit 1',
          [w.id],
        );
        if (history) {
          throw errors.conflict(
            'unit_has_stock_history',
            'This variant already has stock history in its unit. Only more decimal places can be allowed now.',
          );
        }
      }
    }
    for (const [fieldId, targets] of w.relations) {
      if (targets.length === 0) continue;
      const def = defs.find((d) => d.id === fieldId)!;
      const table = def.config.targetType === 'variant' ? 'variants' : 'products';
      const [count] = await ctx.tx.query<{ n: number }>(
        `select count(*)::int as n from ${table} where id = any($1::uuid[])`,
        [targets],
      );
      if (count!.n !== targets.length)
        throw errors.notFound(`Related ${def.config.targetType ?? 'record'}`);
      if (targets.includes(w.id)) {
        throw errors.validation([
          { path: def.key, message: 'A record cannot be related to itself.' },
        ]);
      }
    }
  }
}

/**
 * Required family fields must have values on active products (drafts may be incomplete). Checked
 * fully when a product becomes active or changes family, and for each field this change empties.
 */
async function checkRequired(
  ctx: HandlerContext,
  loaded: Loaded,
  writes: RecordWrite[],
  defs: StoredField[],
  emptied: Set<string>,
) {
  const productWrite = writes.find((w) => w.type === 'product');
  const status =
    (productWrite?.columns.get('status') as string | undefined) ?? loaded.product.status;
  if (status !== 'active') return;
  const familyId = productWrite?.columns.has('family_id')
    ? (productWrite.columns.get('family_id') as string | null)
    : loaded.product.family_id;
  if (!familyId) return;
  const full =
    (productWrite?.columns.has('status') && loaded.product.status !== 'active') ||
    (productWrite?.columns.has('family_id') && familyId !== loaded.product.family_id);
  const required = await ctx.tx.query<{ field_id: string }>(
    'select field_id from family_fields where family_id = $1 and required',
    [familyId],
  );
  const missing = new Set<string>();
  const merged = mergeForCheck(loaded, writes);
  for (const { field_id } of required) {
    if (!full && !emptied.has(field_id)) continue;
    const def = defs.find((d) => d.id === field_id);
    if (!def) continue;
    if (def.level !== 'variant') {
      if (def.level === 'product' && isEmpty(merged.product, def)) missing.add(def.key);
      if (def.level === 'both') {
        for (const v of merged.variants) {
          const value = effectiveCustom(
            def,
            'variant',
            v.id,
            merged.product,
            v,
            merged.relations,
          ).value;
          if (value === null) missing.add(def.key);
        }
      }
    } else {
      for (const v of merged.variants) {
        if (
          effectiveCustom(def, 'variant', v.id, merged.product, v, merged.relations).value === null
        )
          missing.add(def.key);
      }
    }
  }
  if (missing.size > 0) {
    throw errors.unprocessable(
      'required_fields_missing',
      'An active product in this family needs values for its required fields. Fill them in or save it as a draft.',
      { fields: [...missing] },
    );
  }
}

function isEmpty(
  product: Pick<ProductRow, 'attributes'> & { id: string },
  def: FieldDefinition,
): boolean {
  return product.attributes[def.id] === null || product.attributes[def.id] === undefined;
}

function mergeForCheck(loaded: Loaded, writes: RecordWrite[]) {
  const apply = (attributes: Record<string, unknown>, w: RecordWrite | undefined) => {
    const out = { ...attributes };
    for (const [id, a] of w?.attributes ?? []) {
      if (a.inherit) delete out[id];
      else out[id] = a.value;
    }
    return out;
  };
  const relations = new Map(loaded.relations);
  for (const w of writes) for (const [fid, t] of w.relations) relations.set(`${fid}:${w.id}`, t);
  const byId = new Map(writes.map((w) => [w.id, w]));
  return {
    product: {
      id: loaded.product.id,
      attributes: apply(loaded.product.attributes, byId.get(loaded.product.id)),
    },
    variants: loaded.variants
      .filter((v) => v.status === 'active')
      .map((v) => ({ id: v.id, attributes: apply(v.attributes, byId.get(v.id)) })),
    relations,
  };
}

/** Writes the validated changes; returns one audit event per changed record. */
export async function persistWrites(
  ctx: HandlerContext,
  loaded: Loaded,
  apply: ApplyResult,
): Promise<Array<{ type: RecordType; id: string; version: number; log: RecordWrite['log'] }>> {
  const out = [];
  for (const w of apply.writes) {
    const table = w.type === 'product' ? 'products' : 'variants';
    const record =
      w.type === 'product'
        ? loaded.product
        : (loaded.variants.find((v) => v.id === w.id) as VariantRow);
    const attributes = { ...record.attributes };
    for (const [id, a] of w.attributes) {
      if (a.inherit || (w.type === 'product' && a.value === null)) delete attributes[id];
      else attributes[id] = a.value;
    }
    if (attributesSize(attributes) > FIELD_LIMITS.attributeBytesPerRecord) {
      throw errors.unprocessable(
        'attributes_too_large',
        `A record's custom field values may take at most ${FIELD_LIMITS.attributeBytesPerRecord / 1024} KB.`,
      );
    }
    const sets: string[] = ['attributes = $2', 'version = version + 1', 'updated_at = now()'];
    const params: unknown[] = [w.id, JSON.stringify(attributes)];
    for (const [column, value] of w.columns) {
      const bf = BUILTIN_FIELDS.find((f) => f.column === column)!;
      params.push(
        value === undefined
          ? null
          : bf.kind === 'json'
            ? JSON.stringify(value)
            : bf.kind === 'array'
              ? value
              : value,
      );
      if (bf.kind === 'json') {
        // On a variant, SQL NULL inherits and JSON null clears.
        sets.push(
          value === undefined
            ? `${column} = null`
            : value === null
              ? `${column} = ${w.type === 'variant' ? `'null'::jsonb` : 'null'}`
              : `${column} = $${params.length}::jsonb`,
        );
        if (value === undefined || value === null) params.pop();
      } else {
        sets.push(`${column} = $${params.length}`);
      }
      if (column === 'sku') {
        params.push(normalizeSku(value as string));
        sets.push(`sku_normalized = $${params.length}`);
      }
    }
    const [row] = await ctx.tx.query<{ version: number }>(
      `update ${table} set ${sets.join(', ')} where id = $1 returning version`,
      params,
    );
    for (const [fieldId, targets] of w.relations) {
      await ctx.tx.query('delete from record_relations where field_id = $1 and source_id = $2', [
        fieldId,
        w.id,
      ]);
      if (targets.length > 0) {
        const def = (await loadFields(ctx.tx, { ids: [fieldId] }))[0]!;
        await ctx.tx.query(
          `insert into record_relations (shop_id, id, field_id, source_type, source_id, target_type, target_id, position)
           select app_shop_id(), x.id, $1, $2, $3, $4, x.target, x.ord - 1
           from unnest($5::uuid[], $6::uuid[]) with ordinality as x(id, target, ord)`,
          [
            fieldId,
            w.type,
            w.id,
            def.config.targetType ?? 'product',
            targets.map(() => ctx.newId()),
            targets,
          ],
        );
      }
    }
    out.push({ type: w.type, id: w.id, version: row!.version, log: w.log });
  }
  return out;
}

// Operations -------------------------------------------------------------------------------

const VariantFieldsInput = {
  sku: z.string().trim().min(1).max(100),
  price: z.string().max(30).optional().describe('Decimal string such as "19.90".'),
  baseUnit: z.string().trim().min(1).max(20).default('each'),
  quantityScale: z
    .number()
    .int()
    .min(0)
    .max(6)
    .default(0)
    .describe('Decimal places allowed in stock quantities, 0 for whole units.'),
};

export const createItem = defineOperation({
  id: 'catalog.items.create',
  summary: 'Create a product with its default variant',
  description:
    'Creates a product and the default variant that carries its SKU and price. `fields` takes custom field values by key (see describe_catalog); variant-level fields go to the default variant. Add size or colour variants afterwards with generate_variants. A SKU that matches an existing one after normalization is rejected.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    name: z.string().trim().min(1).max(500),
    ...VariantFieldsInput,
    description: z.string().max(FIELD_LIMITS.richTextLength).optional().describe('Markdown text.'),
    status: z.enum(['draft', 'active']).default('active'),
    family: z.string().max(200).optional().describe('Family ID or name.'),
    tags: z.array(z.string().max(100)).max(50).optional(),
    weight: z.unknown().optional().describe('Such as "1.2 kg" or {value, unit}.'),
    dimensions: z
      .unknown()
      .optional()
      .describe('Such as "120 x 60 x 75 cm" or {length, width, height, unit}.'),
    fields: z.record(z.string(), z.unknown()).optional().describe('Custom field values by key.'),
    barcode: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'The barcode printed on the item, such as its EAN-13. The type is detected from the code; a code another item or pack already has is refused.',
      ),
    acknowledgeSimilar: z
      .boolean()
      .default(false)
      .describe(
        'Products with similar names make the create fail with `similar_items_found` and the matches. Show them, and only after the person confirms it is a different product, retry with true.',
      ),
  }),
  output: z.object({ productId: Id, variantId: Id, sku: z.string(), item: ItemDetail }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.item.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/items', status: 201 },
  mcp: { tool: TOOL, action: 'create_product', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const issues: Array<{ path: string; message: string }> = [];
    const encodeBuiltin = (key: string, record: RecordType, value: unknown) => {
      const r = builtin(key, record)!.encode(value);
      if (!r.ok) issues.push({ path: key, message: r.message });
      return r.ok ? r.value : null;
    };
    const price = encodeBuiltin('price', 'variant', input.price ?? null);
    const tags = encodeBuiltin('tags', 'product', input.tags ?? []);
    const weight = encodeBuiltin('weight', 'product', input.weight ?? null);
    const dimensions = encodeBuiltin('dimensions', 'product', input.dimensions ?? null);
    const skuNormalized = normalizeSku(input.sku);
    // One duplicate check on every create path (plan 5.7): taken SKUs are refused, similar names
    // need an acknowledgment, and the matches shown are recorded with the outcome.
    let barcode: { code: string; normalized: string; symbology: Symbology } | null = null;
    if (input.barcode) {
      const symbology = inferSymbology(input.barcode);
      const checked = checkBarcode(input.barcode, symbology);
      if (!checked.ok) throw errors.validation([{ path: 'barcode', message: checked.message }]);
      barcode = { code: checked.code, normalized: checked.normalized, symbology };
    }
    const duplicates = await findDuplicates(ctx.tx, {
      name: input.name,
      sku: input.sku,
      barcode: barcode?.code,
    });
    if (duplicates.skuTaken) {
      throw errors.conflict('duplicate_sku', 'A variant with this SKU already exists.', {
        existingVariantId: duplicates.skuTaken.variantId,
        existing: duplicates.skuTaken,
      });
    }
    if (duplicates.barcodeTaken) {
      throw errors.conflict('duplicate_barcode', 'Another item already has this barcode.', {
        existing: duplicates.barcodeTaken,
      });
    }
    if (duplicates.similarNames.length > 0 && !input.acknowledgeSimilar) {
      throw errors.conflict(
        'similar_items_found',
        'Products with similar names already exist. Check them; if this is a different product, create it with acknowledgeSimilar.',
        { similarNames: duplicates.similarNames },
      );
    }
    let familyId: string | null = null;
    if (input.family) {
      const [family] = await ctx.tx.query<{ id: string; status: string }>(
        `select id, status from product_families
         where (id::text = $1 or lower(name) = lower($1)) order by status limit 1`,
        [input.family],
      );
      if (!family) throw errors.notFound('Family');
      if (family.status !== 'active')
        throw errors.conflict('family_archived', 'The family is archived.');
      familyId = family.id;
    }
    const defs = visible(await loadFields(ctx.tx), ctx.membership);
    const { currency } = await shopSettings(ctx.tx);
    const productAttributes: Record<string, unknown> = {};
    const variantAttributes: Record<string, unknown> = {};
    const relations: Array<{ def: StoredField; record: RecordType; targets: string[] }> = [];
    for (const [key, raw] of Object.entries(input.fields ?? {})) {
      const def = findField(defs, key);
      if (!def) {
        issues.push({ path: `fields.${key}`, message: `No active field "${key}".` });
        continue;
      }
      const encoded = encodeValue(def, raw, { currency });
      if (!encoded.ok) {
        issues.push({ path: `fields.${key}`, message: encoded.message });
        continue;
      }
      if (encoded.value === null) continue;
      if (def.type === 'file') {
        const issue = await fileFieldIssue(ctx.tx, def, encoded.value as string[]);
        if (issue) {
          issues.push({ path: `fields.${key}`, message: issue });
          continue;
        }
      }
      const record: RecordType = def.level === 'variant' ? 'variant' : 'product';
      if (def.type === 'relationship')
        relations.push({ def, record, targets: encoded.value as string[] });
      else if (record === 'variant') variantAttributes[def.id] = encoded.value;
      else productAttributes[def.id] = encoded.value;
    }
    if (issues.length > 0) throw errors.validation(issues);
    // Defaults of the family's fields fill what was not given.
    if (familyId) {
      const members = await ctx.tx.query<{ field_id: string; required: boolean }>(
        'select field_id, required from family_fields where family_id = $1',
        [familyId],
      );
      for (const m of members) {
        const def = defs.find((d) => d.id === m.field_id);
        if (!def || def.defaultValue === null || def.defaultValue === undefined) continue;
        const target = def.level === 'variant' ? variantAttributes : productAttributes;
        if (!(def.id in target)) target[def.id] = def.defaultValue;
      }
      if (input.status === 'active') {
        const missing = members
          .filter((m) => m.required)
          .map((m) => defs.find((d) => d.id === m.field_id))
          .filter((d): d is StoredField => Boolean(d))
          .filter((d) =>
            d.type === 'relationship'
              ? !relations.some((r) => r.def.id === d.id)
              : d.level === 'variant'
                ? variantAttributes[d.id] === undefined
                : productAttributes[d.id] === undefined,
          )
          .map((d) => d.key);
        if (missing.length > 0) {
          throw errors.unprocessable(
            'required_fields_missing',
            'An active product in this family needs values for its required fields. Fill them in or create it as a draft.',
            { fields: missing },
          );
        }
      }
    }
    const productId = ctx.newId();
    const variantId = ctx.newId();
    await ctx.tx.query(
      `with product as (
         insert into products (shop_id, id, name, description, status, family_id, tags, attributes, weight, dimensions)
         values (app_shop_id(), $1, $2, $3, $10, $11, $12, $13, $14, $15))
       insert into variants (shop_id, id, product_id, sku, sku_normalized, price, base_unit,
         quantity_scale, is_default, attributes)
       values (app_shop_id(), $4, $1, $5, $6, $7, $8, $9, true, $16)`,
      [
        productId,
        input.name,
        input.description ?? null,
        variantId,
        input.sku,
        skuNormalized,
        price,
        input.baseUnit,
        input.quantityScale,
        input.status,
        familyId,
        tags,
        JSON.stringify(productAttributes),
        weight === null ? null : JSON.stringify(weight),
        dimensions === null ? null : JSON.stringify(dimensions),
        JSON.stringify(variantAttributes),
      ],
    );
    if (barcode) {
      await ctx.tx.query(
        `insert into barcodes (shop_id, id, variant_id, symbology, code, code_normalized, position)
         values (app_shop_id(), $1, $2, $3, $4, $5, 0)`,
        [ctx.newId(), variantId, barcode.symbology, barcode.code, barcode.normalized],
      );
    }
    for (const r of relations) {
      const table = r.def.config.targetType === 'variant' ? 'variants' : 'products';
      const [count] = await ctx.tx.query<{ n: number }>(
        `select count(*)::int as n from ${table} where id = any($1::uuid[])`,
        [r.targets],
      );
      if (count!.n !== r.targets.length)
        throw errors.notFound(`Related ${r.def.config.targetType ?? 'record'}`);
      await ctx.tx.query(
        `insert into record_relations (shop_id, id, field_id, source_type, source_id, target_type, target_id, position)
         select app_shop_id(), x.id, $1, $2, $3, $4, x.target, x.ord - 1
         from unnest($5::uuid[], $6::uuid[]) with ordinality as x(id, target, ord)`,
        [
          r.def.id,
          r.record,
          r.record === 'product' ? productId : variantId,
          r.def.config.targetType ?? 'product',
          r.targets.map(() => ctx.newId()),
          r.targets,
        ],
      );
    }
    const item = await itemDetail(ctx, productId, defs);
    return {
      result: { productId, variantId, sku: input.sku, item },
      audit: {
        targetType: 'variant',
        targetId: variantId,
        changes: {
          productId,
          name: input.name,
          sku: input.sku,
          price,
          baseUnit: input.baseUnit,
          quantityScale: input.quantityScale,
          status: input.status,
          familyId,
          ...(barcode ? { barcode: { code: barcode.code, symbology: barcode.symbology } } : {}),
          acknowledgedSimilar: duplicates.similarNames.map((m) => m.productId),
          fields: Object.fromEntries(
            [...Object.entries(productAttributes), ...Object.entries(variantAttributes)].map(
              ([id, v]) => [defs.find((d) => d.id === id)?.key ?? id, v],
            ),
          ),
        },
      },
    };
  },
});

export const getItem = defineOperation({
  id: 'catalog.items.get',
  summary: 'Get a product with its variants, options, and field values',
  description:
    'Look up by product ID, variant ID, or exact SKU. Each field value says whether it is the record’s own, inherited from the product, or cleared. Use these values as `expected` when you change them.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    productId: Id.optional(),
    variantId: Id.optional(),
    sku: z.string().trim().min(1).max(100).optional(),
  }),
  output: z.object({ item: ItemDetail }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.item.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/items/detail' },
  mcp: { tool: 'search_catalog', action: 'get', readOnly: true, destructive: false },
  async handler(ctx, input) {
    let productId = input.productId ?? null;
    if (!productId && (input.variantId || input.sku)) {
      const [row] = await ctx.tx.query<{ product_id: string }>(
        `select product_id from variants where ($1::uuid is null or id = $1)
           and ($2::text is null or sku_normalized = $2) limit 1`,
        [input.variantId ?? null, input.sku ? normalizeSku(input.sku) : null],
      );
      if (!row) throw errors.notFound('Item');
      productId = row.product_id;
    }
    if (!productId)
      throw errors.validation([
        { path: 'productId', message: 'Give a product ID, variant ID, or SKU.' },
      ]);
    const item = await itemDetail(ctx, productId);
    return { result: { item }, audit: { targetType: 'product', targetId: productId } };
  },
});

export const updateItem = defineOperation({
  id: 'catalog.items.update',
  summary: 'Change field values of one product and its variants',
  description:
    'Each change names a field and the value you last read as `expected`. Changes to different fields never conflict; a field someone else changed since you read it returns `edit_conflict` with the current value and who changed it, and nothing is saved. To change many products at once, use a bulk preview.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ productId: Id, changes: z.array(ChangeInput).min(1).max(200) }),
  output: z.object({
    records: z.array(
      z.object({ type: z.enum(['product', 'variant']), id: Id, version: z.number() }),
    ),
    item: ItemDetail,
  }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.item.updated' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/items/{productId}/changes' },
  mcp: { tool: TOOL, action: 'update', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const { result, loaded, defs } = await applyChanges(ctx, input.productId, input.changes);
    const written = await persistWrites(ctx, loaded, result);
    const item = await itemDetail(ctx, input.productId, defs);
    const records = written.map((w) => ({ type: w.type, id: w.id, version: w.version }));
    const [first, ...rest] = written;
    if (!first) {
      return {
        result: { records, item },
        audit: { targetType: 'product', targetId: input.productId, outcome: 'no_change' as const },
      };
    }
    return {
      result: { records, item },
      audit: {
        targetType: first.type,
        targetId: first.id,
        changes: {
          fields: first.log,
          version: first.version,
          definitionVersions: result.definitionVersions,
        },
      },
      events: rest.map((w) => recordEvent(ctx, w, result.definitionVersions)),
    };
  },
});

/** One event per further changed record, so each record's history shows its own changes. */
export function recordEvent(
  ctx: HandlerContext,
  w: { type: RecordType; id: string; version: number; log: Record<string, unknown> },
  definitionVersions: Record<string, number>,
): AuditEvent {
  return ctx.event({
    action: w.type === 'product' ? 'catalog.product.changed' : 'catalog.variant.changed',
    outcome: 'succeeded',
    target_type: w.type,
    target_id: w.id,
    changes: { fields: w.log, version: w.version, definitionVersions },
  });
}

// Archive and restore ----------------------------------------------------------------------

function statusHandler(record: RecordType, archived: boolean) {
  return async (ctx: HandlerContext, id: string) => {
    const table = `${record}s`;
    const [row] = await ctx.tx.query<{
      status: string;
      product_id?: string;
      option_value_ids?: string[];
    }>(
      `select status${record === 'variant' ? ', product_id, option_value_ids' : ''} from ${table} where id = $1 for update`,
      [id],
    );
    if (!row) throw errors.notFound(record === 'product' ? 'Product' : 'Variant');
    const target = archived ? 'archived' : 'active';
    if (row.status === target || (!archived && row.status === 'draft')) {
      const [v] = await ctx.tx.query<{ version: number }>(
        `select version from ${table} where id = $1`,
        [id],
      );
      return {
        result: { id, status: row.status, version: v!.version },
        audit: { targetType: record, targetId: id, outcome: 'no_change' as const },
      };
    }
    if (archived) {
      const [open] = await ctx.tx.query(
        `select 1 from inventory_positions p join variants v on v.shop_id = p.shop_id and v.id = p.variant_id
         where p.allocated > 0 and ${record === 'product' ? 'v.product_id' : 'v.id'} = $1 limit 1`,
        [id],
      );
      if (open)
        throw errors.conflict('open_reservations', `Release the ${record}'s reservations first.`);
      if (record === 'variant') {
        const [others] = await ctx.tx.query<{ n: number }>(
          `select count(*)::int as n from variants where product_id = $1 and status = 'active' and id <> $2`,
          [row.product_id, id],
        );
        if (others!.n === 0) {
          throw errors.conflict(
            'last_variant',
            'A product keeps at least one active variant. Archive the product instead.',
          );
        }
      }
    } else if (record === 'variant') {
      const [clash] = await ctx.tx.query(
        `select 1 from variants where product_id = $1 and status = 'active' and option_value_ids = $2::uuid[] and id <> $3`,
        [row.product_id, row.option_value_ids, id],
      );
      if (clash)
        throw errors.conflict(
          'combination_taken',
          'An active variant already has these option values.',
        );
    }
    const [updated] = await ctx.tx.query<{ version: number }>(
      `update ${table} set status = $2, version = version + 1, updated_at = now() where id = $1 returning version`,
      [id, target],
    );
    return {
      result: { id, status: target, version: updated!.version },
      audit: {
        targetType: record,
        targetId: id,
        changes: {
          fields: { status: { from: row.status, to: target } },
          version: updated!.version,
        },
      },
    };
  };
}

const StatusOut = z.object({ id: Id, status: z.string(), version: z.number() });
const ARCHIVE_PRODUCT =
  'Hides the product and its variants from new work. Its history and stock stay; nothing is deleted. A product with open reservations cannot be archived.';
const ARCHIVE_VARIANT =
  'Hides one variant. The last active variant cannot be archived (archive the product). A variant with open reservations cannot be archived.';

export const archiveProduct = defineOperation({
  id: 'catalog.products.archive',
  summary: 'Archive a product',
  description: ARCHIVE_PRODUCT,
  kind: 'command',
  scope: 'shop',
  input: z.object({ productId: Id }),
  output: StatusOut,
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.product.archived' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/products/{productId}/archive' },
  mcp: { tool: TOOL, action: 'archive_product', readOnly: false, destructive: false },
  handler: (ctx, input) => statusHandler('product', true)(ctx, input.productId),
});

export const restoreProduct = defineOperation({
  id: 'catalog.products.restore',
  summary: 'Restore an archived product',
  kind: 'command',
  scope: 'shop',
  input: z.object({ productId: Id }),
  output: StatusOut,
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.product.restored' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/products/{productId}/restore' },
  mcp: { tool: TOOL, action: 'restore_product', readOnly: false, destructive: false },
  handler: (ctx, input) => statusHandler('product', false)(ctx, input.productId),
});

export const archiveVariant = defineOperation({
  id: 'catalog.variants.archive',
  summary: 'Archive a variant',
  description: ARCHIVE_VARIANT,
  kind: 'command',
  scope: 'shop',
  input: z.object({ variantId: Id }),
  output: StatusOut,
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.variant.archived' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/variants/{variantId}/archive' },
  mcp: { tool: TOOL, action: 'archive_variant', readOnly: false, destructive: false },
  handler: (ctx, input) => statusHandler('variant', true)(ctx, input.variantId),
});

export const restoreVariant = defineOperation({
  id: 'catalog.variants.restore',
  summary: 'Restore an archived variant',
  kind: 'command',
  scope: 'shop',
  input: z.object({ variantId: Id }),
  output: StatusOut,
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.variant.restored' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/variants/{variantId}/restore' },
  mcp: { tool: TOOL, action: 'restore_variant', readOnly: false, destructive: false },
  handler: (ctx, input) => statusHandler('variant', false)(ctx, input.variantId),
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const catalogItemsOperations = [
  createItem,
  getItem,
  updateItem,
  archiveProduct,
  restoreProduct,
  archiveVariant,
  restoreVariant,
] as const;
