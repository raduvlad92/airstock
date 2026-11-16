import type { Tx } from '@airstock/db';
import { z } from 'zod';
import {
  encodeValue,
  FIELD_LEVELS,
  FIELD_LIMITS,
  FIELD_TYPES,
  type FieldConfig,
  type FieldDefinition,
  type FieldType,
  normalizeConfig,
  RESERVED_KEYS,
  SAFE_CONVERSIONS,
} from '../catalog/fields.ts';
import {
  findField,
  loadFields,
  type StoredField,
  shopSettings,
  visible,
} from '../catalog/store.ts';
import { TEMPLATE_KEYS, TEMPLATES } from '../catalog/templates.ts';
import { CANONICAL_UNIT, DISPLAY_UNITS, UNIT_KINDS, UNITS, unitKind } from '../catalog/units.ts';
import { errors } from '../errors.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id } from '../schemas.ts';

// Custom fields, options, and product families (plan Section 5.2, ADR 0012). Schema changes need
// the catalog.schema.manage permission and, for connections, the catalog:write scope.

const MCP_TOOL = 'manage_catalog_schema';

const FieldKey = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,62}$/,
    'Lowercase letters, digits, and underscores, starting with a letter.',
  )
  .describe(
    'A slug used in imports, exports, and the API, such as care_instructions. Never changes.',
  );

const DecimalText = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'A decimal number as text, such as "0" or "12.5".');

export const FieldConfigInput = z
  .object({
    maxLength: z.number().int().optional().describe('text and rich_text: most characters.'),
    min: DecimalText.optional().describe('integer, decimal, money, measurement: smallest value.'),
    max: DecimalText.optional().describe('integer, decimal, money, measurement: largest value.'),
    scale: z.number().int().optional().describe('decimal and money: decimal places, 0 to 6.'),
    unitKind: z
      .enum(UNIT_KINDS)
      .optional()
      .describe('measurement: weight, length, volume, or temperature.'),
    defaultUnit: z
      .string()
      .max(10)
      .optional()
      .describe('measurement: unit offered first, such as kg.'),
    maxItems: z.number().int().optional().describe('multi_select, file, relationship: most items.'),
    targetType: z
      .enum(['product', 'variant'])
      .optional()
      .describe('relationship: what it links to.'),
    relationKind: z
      .string()
      .max(50)
      .optional()
      .describe('relationship: what the link means, such as compatible_with or replaces.'),
    accept: z.enum(['images', 'documents', 'any']).optional().describe('file: accepted media.'),
  })
  .describe('Validation rules for the field type.');

const OptionOut = z.object({
  id: Id,
  label: z.string(),
  position: z.number(),
  archived: z.boolean(),
});

export const FieldOut = z.object({
  id: Id,
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  type: z.enum(FIELD_TYPES),
  level: z.enum(FIELD_LEVELS),
  config: z.record(z.string(), z.unknown()),
  defaultValue: z.unknown(),
  visibility: z.enum(['everyone', 'restricted']),
  status: z.enum(['active', 'archived']),
  isSystem: z.boolean(),
  version: z.number(),
  options: z.array(OptionOut),
});

export const FamilyOut = z.object({
  id: Id,
  name: z.string(),
  description: z.string().nullable(),
  templateKey: z.string().nullable(),
  status: z.enum(['active', 'archived']),
  version: z.number(),
  fields: z.array(
    z.object({
      fieldId: Id,
      key: z.string(),
      required: z.boolean(),
      position: z.number(),
      group: z.string().nullable(),
    }),
  ),
  suggestedOptions: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
});

const FamilyFieldInput = z.object({
  field: z.string().min(1).max(100).describe('Field key or ID.'),
  required: z.boolean().default(false),
  group: z.string().trim().max(100).optional().describe('Heading the field appears under.'),
});

const SuggestedOptionsInput = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(100),
      values: z.array(z.string().trim().min(1).max(100)).max(100),
    }),
  )
  .max(3)
  .describe('Option names and values suggested for variants, such as Size: S, M, L.');

function fieldOut(f: StoredField) {
  return {
    id: f.id,
    key: f.key,
    label: f.label,
    description: f.description,
    type: f.type,
    level: f.level,
    config: f.config as Record<string, unknown>,
    defaultValue: f.defaultValue,
    visibility: f.visibility,
    status: f.status,
    isSystem: f.isSystem,
    version: f.version,
    options: f.options,
  };
}

function requireSchemaPermission(ctx: HandlerContext) {
  // The registry already checks catalog.schema.manage; restricted fields depend on it too.
  if (!ctx.membership) throw errors.forbidden('A shop membership is required.');
}

async function countActiveFields(tx: Tx): Promise<number> {
  const [row] = await tx.query<{ n: number }>(
    `select count(*)::int as n from field_definitions where status = 'active'`,
  );
  return row?.n ?? 0;
}

async function lockField(tx: Tx, fieldId: string): Promise<StoredField> {
  const [locked] = await tx.query<{ id: string }>(
    'select id from field_definitions where id = $1 for update',
    [fieldId],
  );
  if (!locked) throw errors.notFound('Field');
  const [field] = await loadFields(tx, { ids: [fieldId], includeArchived: true });
  return field!;
}

function checkVersion(current: number, expected: number | undefined, what: string) {
  if (expected !== undefined && expected !== current) {
    throw errors.conflict(
      'version_conflict',
      `The ${what} changed since you read it. Reload and retry.`,
      {
        currentVersion: current,
      },
    );
  }
}

/** Inserts option labels after the existing ones; returns the new IDs. */
async function addOptions(
  ctx: HandlerContext,
  field: FieldDefinition,
  labels: string[],
): Promise<string[]> {
  const existing = new Set(
    field.options.filter((o) => !o.archived).map((o) => o.label.toLowerCase()),
  );
  const fresh: string[] = [];
  for (const raw of labels) {
    const label = raw.trim();
    if (!label) continue;
    if (existing.has(label.toLowerCase())) {
      throw errors.conflict(
        'duplicate_option',
        `${field.label} already has the option "${label}".`,
      );
    }
    existing.add(label.toLowerCase());
    fresh.push(label);
  }
  if (field.options.length + fresh.length > FIELD_LIMITS.optionsPerSelectField) {
    throw errors.unprocessable(
      'limit_reached',
      `A select field has at most ${FIELD_LIMITS.optionsPerSelectField} options.`,
    );
  }
  const start = field.options.reduce((max, o) => Math.max(max, o.position + 1), 0);
  const ids = fresh.map(() => ctx.newId());
  if (fresh.length > 0) {
    await ctx.tx.query(
      `insert into field_options (shop_id, id, field_id, label, position)
       select app_shop_id(), x.id, $1, x.label, $2 + x.ord - 1
       from unnest($3::uuid[], $4::text[]) with ordinality as x(id, label, ord)`,
      [field.id, start, ids, fresh],
    );
  }
  return ids;
}

interface NewField {
  key: string;
  label: string;
  type: FieldType;
  level: 'product' | 'variant' | 'both';
  description?: string | undefined;
  config?: FieldConfig | undefined;
  visibility?: 'everyone' | 'restricted' | undefined;
  options?: string[] | undefined;
  defaultValue?: unknown;
  isSystem?: boolean;
}

/** Creates one field definition with its options and default; shared by create and templates. */
export async function insertField(ctx: HandlerContext, input: NewField): Promise<StoredField> {
  if (RESERVED_KEYS.has(input.key)) {
    throw errors.unprocessable(
      'reserved_key',
      `"${input.key}" is a built-in field. Choose another key.`,
    );
  }
  if ((await countActiveFields(ctx.tx)) >= FIELD_LIMITS.activeFieldsPerShop) {
    throw errors.unprocessable(
      'limit_reached',
      `A shop has at most ${FIELD_LIMITS.activeFieldsPerShop} active fields. Archive one first.`,
    );
  }
  const config = normalizeConfig(input.type, input.config ?? {});
  if (typeof config === 'string') throw errors.validation([{ path: 'config', message: config }]);
  if (input.type === 'relationship' && input.level === 'both') {
    throw errors.validation([
      {
        path: 'level',
        message: 'A relationship field belongs to products or to variants, not both.',
      },
    ]);
  }
  const isSelect = input.type === 'single_select' || input.type === 'multi_select';
  if (!isSelect && input.options?.length) {
    throw errors.validation([{ path: 'options', message: 'Only select fields have options.' }]);
  }
  const id = ctx.newId();
  const [taken] = await ctx.tx.query('select 1 from field_definitions where key = $1', [input.key]);
  if (taken)
    throw errors.conflict('duplicate_key', `A field with the key "${input.key}" already exists.`);
  await ctx.tx.query(
    `insert into field_definitions (shop_id, id, key, label, description, type, level, config,
       visibility, is_system)
     values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.key,
      input.label,
      input.description ?? null,
      input.type,
      input.level,
      JSON.stringify(config),
      input.visibility ?? 'everyone',
      input.isSystem ?? false,
    ],
  );
  const draft: StoredField = {
    id,
    key: input.key,
    label: input.label,
    description: input.description ?? null,
    type: input.type,
    level: input.level,
    config,
    defaultValue: null,
    visibility: input.visibility ?? 'everyone',
    status: 'active',
    isSystem: input.isSystem ?? false,
    version: 1,
    options: [],
  };
  if (input.options?.length) await addOptions(ctx, draft, input.options);
  const [field] = await loadFields(ctx.tx, { ids: [id] });
  if (input.defaultValue !== undefined && input.defaultValue !== null) {
    if (input.type === 'relationship' || input.type === 'file') {
      throw errors.validation([
        { path: 'defaultValue', message: 'This field type has no default.' },
      ]);
    }
    const { currency } = await shopSettings(ctx.tx);
    const encoded = encodeValue(field!, input.defaultValue, { currency });
    if (!encoded.ok) throw errors.validation([{ path: 'defaultValue', message: encoded.message }]);
    await ctx.tx.query('update field_definitions set default_value = $2 where id = $1', [
      id,
      JSON.stringify(encoded.value),
    ]);
    field!.defaultValue = encoded.value;
  }
  return field!;
}

// Describe ---------------------------------------------------------------------------------

export const describeCatalog = defineOperation({
  id: 'catalog.schema.describe',
  summary: 'Describe the catalog: fields, options, families, units, and limits',
  description:
    'Read this first. Field keys, types, levels (product, variant, or both), and select options are what edit_catalog and search_catalog accept. Restricted fields appear only to members who manage the schema.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    includeArchived: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .optional()
      .describe('Also list archived fields and families.'),
  }),
  output: z.object({
    fields: z.array(FieldOut),
    families: z.array(FamilyOut),
    templates: z.array(
      z.object({ key: z.string(), name: z.string(), description: z.string(), added: z.boolean() }),
    ),
    units: z.object({
      display: z.enum(['metric', 'imperial']),
      kinds: z.record(
        z.string(),
        z.object({ canonical: z.string(), units: z.array(z.string()), display: z.string() }),
      ),
    }),
    limits: z.record(z.string(), z.number()),
    currency: z.string(),
  }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.schema.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/catalog/schema' },
  mcp: { tool: 'describe_catalog', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const includeArchived = input.includeArchived === true || input.includeArchived === 'true';
    const fields = visible(await loadFields(ctx.tx, { includeArchived }), ctx.membership);
    const families = await loadFamilies(ctx.tx, fields, includeArchived);
    const settings = await shopSettings(ctx.tx);
    const added = new Set(families.map((f) => f.templateKey).filter(Boolean));
    return {
      result: {
        fields: fields.map(fieldOut),
        families,
        templates: TEMPLATES.map((t) => ({
          key: t.key,
          name: t.name,
          description: t.description,
          added: added.has(t.key),
        })),
        units: {
          display: settings.displayUnits,
          kinds: Object.fromEntries(
            UNIT_KINDS.map((k) => [
              k,
              {
                canonical: CANONICAL_UNIT[k],
                units: Object.keys(UNITS[k]),
                display: DISPLAY_UNITS[settings.displayUnits][k],
              },
            ]),
          ),
        },
        limits: { ...FIELD_LIMITS, optionsPerProduct: 3, variantsPerProduct: 2048 },
        currency: settings.currency,
      },
      audit: { targetType: 'catalog_schema', targetId: ctx.shopId },
    };
  },
});

export async function loadFamilies(tx: Tx, fields: StoredField[], includeArchived = false) {
  const rows = await tx.query<{
    id: string;
    name: string;
    description: string | null;
    template_key: string | null;
    status: 'active' | 'archived';
    version: number;
    fields: Array<{ fieldId: string; required: boolean; position: number; group: string | null }>;
    options: Array<{ name: string; values: string[] }>;
  }>(
    `select f.id, f.name, f.description, f.template_key, f.status, f.version,
       coalesce((select json_agg(json_build_object('fieldId', ff.field_id, 'required', ff.required,
           'position', ff.position, 'group', ff.group_name) order by ff.position)
         from family_fields ff where ff.shop_id = f.shop_id and ff.family_id = f.id), '[]') as fields,
       coalesce((select json_agg(json_build_object('name', s.name, 'values', s."values") order by s.position)
         from family_option_suggestions s where s.shop_id = f.shop_id and s.family_id = f.id), '[]') as options
     from product_families f
     where $1 or f.status = 'active'
     order by f.name`,
    [includeArchived],
  );
  const byId = new Map(fields.map((f) => [f.id, f]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    templateKey: r.template_key,
    status: r.status,
    version: r.version,
    // Fields the caller cannot see (restricted) are left out.
    fields: r.fields
      .filter((f) => byId.has(f.fieldId))
      .map((f) => ({ ...f, key: byId.get(f.fieldId)!.key })),
    suggestedOptions: r.options,
  }));
}

// Fields -----------------------------------------------------------------------------------

export const createField = defineOperation({
  id: 'catalog.fields.create',
  summary: 'Create a custom field',
  description:
    'Adds a typed field to products, variants, or both (a variant inherits the product value until it has its own). Select fields take their options in `options`.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    key: FieldKey,
    label: z.string().trim().min(1).max(200),
    type: z.enum(FIELD_TYPES),
    level: z.enum(FIELD_LEVELS).default('product'),
    description: z.string().trim().max(2000).optional(),
    config: FieldConfigInput.optional(),
    options: z
      .array(z.string().trim().min(1).max(200))
      .max(FIELD_LIMITS.optionsPerSelectField)
      .optional()
      .describe('Option labels for single_select and multi_select fields.'),
    defaultValue: z
      .unknown()
      .optional()
      .describe('Value given to new products in a family with this field.'),
    visibility: z
      .enum(['everyone', 'restricted'])
      .default('everyone')
      .describe('restricted: only members who manage the schema see and change it.'),
  }),
  output: z.object({ field: FieldOut }),
  permission: 'catalog.schema.manage',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.field.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/catalog/fields', status: 201 },
  mcp: { tool: MCP_TOOL, action: 'create_field', readOnly: false, destructive: false },
  async handler(ctx, input) {
    requireSchemaPermission(ctx);
    const field = await insertField(ctx, input);
    return {
      result: { field: fieldOut(field) },
      audit: { targetType: 'field', targetId: field.id, changes: fieldOut(field) },
    };
  },
});

export const updateField = defineOperation({
  id: 'catalog.fields.update',
  summary: 'Change a field: label, rules, default, visibility, or archive and restore',
  description:
    'The key, type, and level never change (see convert_field for safe type changes). An archived field keeps its values but takes no new ones.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    fieldId: Id,
    expectedVersion: z
      .number()
      .int()
      .optional()
      .describe('Fails with a conflict if the field changed since.'),
    label: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    config: FieldConfigInput.optional(),
    defaultValue: z.unknown().optional(),
    visibility: z.enum(['everyone', 'restricted']).optional(),
    status: z.enum(['active', 'archived']).optional(),
  }),
  output: z.object({ field: FieldOut }),
  permission: 'catalog.schema.manage',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.field.updated' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/catalog/fields/{fieldId}' },
  mcp: { tool: MCP_TOOL, action: 'update_field', readOnly: false, destructive: false },
  async handler(ctx, input) {
    requireSchemaPermission(ctx);
    const field = await lockField(ctx.tx, input.fieldId);
    checkVersion(field.version, input.expectedVersion, 'field');
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const set: Record<string, unknown> = {};
    if (input.label !== undefined && input.label !== field.label) {
      changes.label = { from: field.label, to: input.label };
      set.label = input.label;
    }
    if (input.description !== undefined && input.description !== field.description) {
      changes.description = { from: field.description, to: input.description };
      set.description = input.description;
    }
    if (input.config) {
      if (input.config.unitKind && input.config.unitKind !== field.config.unitKind) {
        throw errors.unprocessable(
          'immutable_rule',
          'The unit kind cannot change. Create a new field.',
        );
      }
      if (input.config.targetType && input.config.targetType !== field.config.targetType) {
        throw errors.unprocessable(
          'immutable_rule',
          'The relationship target cannot change. Create a new field.',
        );
      }
      const config = normalizeConfig(field.type, { ...field.config, ...input.config });
      if (typeof config === 'string')
        throw errors.validation([{ path: 'config', message: config }]);
      changes.config = { from: field.config, to: config };
      set.config = JSON.stringify(config);
      field.config = config;
    }
    if (input.defaultValue !== undefined) {
      const { currency } = await shopSettings(ctx.tx);
      const encoded = encodeValue(field, input.defaultValue, { currency });
      if (!encoded.ok)
        throw errors.validation([{ path: 'defaultValue', message: encoded.message }]);
      changes.defaultValue = { from: field.defaultValue, to: encoded.value };
      set.default_value = JSON.stringify(encoded.value);
    }
    if (input.visibility !== undefined && input.visibility !== field.visibility) {
      if (field.isSystem)
        throw errors.unprocessable('system_field', 'Brand and category are always visible.');
      changes.visibility = { from: field.visibility, to: input.visibility };
      set.visibility = input.visibility;
    }
    if (input.status !== undefined && input.status !== field.status) {
      if (field.isSystem)
        throw errors.unprocessable('system_field', 'Brand and category cannot be archived.');
      if (
        input.status === 'active' &&
        (await countActiveFields(ctx.tx)) >= FIELD_LIMITS.activeFieldsPerShop
      ) {
        throw errors.unprocessable(
          'limit_reached',
          `A shop has at most ${FIELD_LIMITS.activeFieldsPerShop} active fields.`,
        );
      }
      changes.status = { from: field.status, to: input.status };
      set.status = input.status;
    }
    if (Object.keys(set).length === 0) {
      return {
        result: { field: fieldOut(field) },
        audit: { targetType: 'field', targetId: field.id, outcome: 'no_change' as const },
      };
    }
    const columns = Object.keys(set);
    await ctx.tx.query(
      `update field_definitions set ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')},
         version = version + 1, updated_at = now()
       where id = $1`,
      [field.id, ...columns.map((c) => set[c])],
    );
    const [updated] = await loadFields(ctx.tx, { ids: [field.id], includeArchived: true });
    return {
      result: { field: fieldOut(updated!) },
      audit: {
        targetType: 'field',
        targetId: field.id,
        changes: { ...changes, version: updated!.version },
      },
    };
  },
});

export const updateFieldOptions = defineOperation({
  id: 'catalog.field_options.update',
  summary: 'Add, rename, reorder, archive, or restore the options of a select field',
  description:
    'Options keep their IDs, so renaming one changes every record that has it. An archived option stays on existing records but is not offered for new choices.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    fieldId: Id,
    add: z
      .array(z.string().trim().min(1).max(200))
      .max(500)
      .optional()
      .describe('New option labels.'),
    rename: z
      .array(z.object({ optionId: Id, label: z.string().trim().min(1).max(200) }))
      .max(500)
      .optional(),
    archive: z.array(Id).max(500).optional().describe('Option IDs to archive.'),
    restore: z.array(Id).max(500).optional().describe('Option IDs to restore.'),
    order: z
      .array(Id)
      .max(500)
      .optional()
      .describe('Option IDs in the new order; unlisted ones follow.'),
  }),
  output: z.object({ field: FieldOut, added: z.array(Id) }),
  permission: 'catalog.schema.manage',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.field_options.updated' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/catalog/fields/{fieldId}/options' },
  mcp: { tool: MCP_TOOL, action: 'update_field_options', readOnly: false, destructive: false },
  async handler(ctx, input) {
    requireSchemaPermission(ctx);
    const field = await lockField(ctx.tx, input.fieldId);
    if (field.type !== 'single_select' && field.type !== 'multi_select') {
      throw errors.unprocessable('not_a_select_field', 'Only select fields have options.');
    }
    const known = new Map(field.options.map((o) => [o.id, o]));
    const unknown = [
      ...(input.rename ?? []).map((r) => r.optionId),
      ...(input.archive ?? []),
      ...(input.restore ?? []),
      ...(input.order ?? []),
    ].filter((id) => !known.has(id));
    if (unknown.length > 0) throw errors.notFound('Option');
    for (const r of input.rename ?? []) {
      const clash = field.options.find(
        (o) =>
          o.id !== r.optionId && !o.archived && o.label.toLowerCase() === r.label.toLowerCase(),
      );
      if (clash)
        throw errors.conflict(
          'duplicate_option',
          `${field.label} already has the option "${r.label}".`,
        );
      await ctx.tx.query('update field_options set label = $2 where id = $1', [
        r.optionId,
        r.label,
      ]);
      known.get(r.optionId)!.label = r.label;
    }
    if (input.archive?.length) {
      await ctx.tx.query('update field_options set archived = true where id = any($1::uuid[])', [
        input.archive,
      ]);
      for (const id of input.archive) known.get(id)!.archived = true;
    }
    if (input.restore?.length) {
      for (const id of input.restore) {
        const option = known.get(id)!;
        const clash = field.options.find(
          (o) => o.id !== id && !o.archived && o.label.toLowerCase() === option.label.toLowerCase(),
        );
        if (clash)
          throw errors.conflict(
            'duplicate_option',
            `An active option is already named "${option.label}".`,
          );
        option.archived = false;
      }
      await ctx.tx.query('update field_options set archived = false where id = any($1::uuid[])', [
        input.restore,
      ]);
    }
    if (input.order?.length) {
      const rest = field.options.filter((o) => !input.order!.includes(o.id)).map((o) => o.id);
      const ids = [...input.order, ...rest];
      await ctx.tx.query(
        `update field_options o set position = x.ord - 1
         from unnest($1::uuid[]) with ordinality as x(id, ord) where o.id = x.id`,
        [ids],
      );
    }
    const added = input.add?.length
      ? await addOptions(ctx, { ...field, options: [...known.values()] }, input.add)
      : [];
    await ctx.tx.query(
      'update field_definitions set version = version + 1, updated_at = now() where id = $1',
      [field.id],
    );
    const [updated] = await loadFields(ctx.tx, { ids: [field.id], includeArchived: true });
    return {
      result: { field: fieldOut(updated!), added },
      audit: {
        targetType: 'field',
        targetId: field.id,
        changes: {
          added: input.add ?? [],
          renamed: input.rename ?? [],
          archived: input.archive ?? [],
          restored: input.restore ?? [],
          reordered: (input.order?.length ?? 0) > 0,
          version: updated!.version,
        },
      },
    };
  },
});

/** SQL that rewrites one attribute value for a safe type change; $1 is the field ID. */
function conversionSql(from: FieldType, to: FieldType): string {
  const json = 'attributes->$1::text';
  const text = 'attributes->>$1::text';
  if (from === 'integer' && to === 'decimal')
    return `to_jsonb(trim_scale((${text})::numeric)::text)`;
  if (from === 'single_select' && to === 'multi_select') return `jsonb_build_array(${json})`;
  if (from === 'text' && to === 'rich_text') return json;
  if (from === 'decimal' && to === 'money')
    return `jsonb_build_object('amount', ${json}, 'currency', $2::text)`;
  // decimal → measurement: $2 is the unit, $3 the factor to canonical, $4 true for °F.
  return `jsonb_build_object('value', ${json}, 'unit', $2::text, 'canonical',
    trim_scale(round(case when $4 then ((${text})::numeric - 32) * 5 / 9
      else (${text})::numeric * $3::numeric end, 6))::text)`;
}

export const convertField = defineOperation({
  id: 'catalog.fields.convert',
  summary: 'Change a field to a compatible type, with a preview of affected records',
  description:
    'Safe changes only: integer to decimal, single to multi select, text to rich text, decimal to money or to a measurement in a chosen unit. Run with preview true first; it changes nothing and shows how many records have a value.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    fieldId: Id,
    toType: z.enum(FIELD_TYPES),
    unit: z
      .string()
      .max(10)
      .optional()
      .describe('decimal to measurement: the unit existing values are in.'),
    preview: z.boolean().default(true),
  }),
  output: z.object({
    preview: z.boolean(),
    affected: z.object({ products: z.number(), variants: z.number() }),
    field: FieldOut.nullable(),
  }),
  permission: 'catalog.schema.manage',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.field.converted' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/catalog/fields/{fieldId}/convert' },
  mcp: { tool: MCP_TOOL, action: 'convert_field', readOnly: false, destructive: false },
  async handler(ctx, input) {
    requireSchemaPermission(ctx);
    const field = await lockField(ctx.tx, input.fieldId);
    if (field.isSystem)
      throw errors.unprocessable('system_field', 'Brand and category cannot change type.');
    if (!(SAFE_CONVERSIONS[field.type] ?? []).includes(input.toType)) {
      throw errors.unprocessable(
        'unsafe_conversion',
        `A ${field.type} field cannot become ${input.toType}. Create a new field and copy the values with an import.`,
      );
    }
    let config: FieldConfig = { ...field.config };
    const kind = input.unit ? unitKind(input.unit) : null;
    if (input.toType === 'measurement') {
      if (!input.unit || !kind)
        throw errors.validation([{ path: 'unit', message: 'Choose the unit the values are in.' }]);
      config = { unitKind: kind, defaultUnit: input.unit };
    }
    const normalized = normalizeConfig(input.toType, config);
    if (typeof normalized === 'string')
      throw errors.validation([{ path: 'config', message: normalized }]);
    const [counts] = await ctx.tx.query<{ products: number; variants: number }>(
      `select (select count(*)::int from products where attributes ? $1::text
                 and jsonb_typeof(attributes->$1::text) <> 'null') as products,
              (select count(*)::int from variants where attributes ? $1::text
                 and jsonb_typeof(attributes->$1::text) <> 'null') as variants`,
      [field.id],
    );
    const affected = { products: counts!.products, variants: counts!.variants };
    if (input.preview) {
      return {
        result: { preview: true, affected, field: null },
        audit: {
          targetType: 'field',
          targetId: field.id,
          outcome: 'no_change' as const,
          context: { preview: true, affected },
        },
      };
    }
    const { currency } = await shopSettings(ctx.tx);
    const factor = kind && kind !== 'temperature' ? UNITS[kind][input.unit!]! : '1';
    const params =
      input.toType === 'measurement'
        ? [field.id, input.unit, factor, input.unit === '°F']
        : input.toType === 'money'
          ? [field.id, currency]
          : [field.id];
    const expression = conversionSql(field.type, input.toType);
    for (const table of ['products', 'variants']) {
      await ctx.tx.query(
        `update ${table} set attributes = jsonb_set(attributes, array[$1::text], ${expression})
         where attributes ? $1::text and jsonb_typeof(attributes->$1::text) <> 'null'`,
        params,
      );
    }
    await ctx.tx.query(
      `update field_definitions set type = $2, config = $3, default_value = null,
         version = version + 1, updated_at = now() where id = $1`,
      [field.id, input.toType, JSON.stringify(normalized)],
    );
    const [updated] = await loadFields(ctx.tx, { ids: [field.id], includeArchived: true });
    return {
      result: { preview: false, affected, field: fieldOut(updated!) },
      audit: {
        targetType: 'field',
        targetId: field.id,
        changes: {
          type: { from: field.type, to: input.toType },
          config: normalized,
          affected,
          version: updated!.version,
        },
      },
    };
  },
});

// Families ---------------------------------------------------------------------------------

async function writeFamilyMembers(
  ctx: HandlerContext,
  familyId: string,
  fieldsInput: Array<z.infer<typeof FamilyFieldInput>> | undefined,
  options: Array<{ name: string; values: string[] }> | undefined,
) {
  if (fieldsInput) {
    const all = await loadFields(ctx.tx);
    const rows = fieldsInput.map((f, i) => {
      const field = findField(all, f.field);
      if (!field)
        throw errors.validation([
          { path: `fields.${i}.field`, message: `No active field "${f.field}".` },
        ]);
      return { fieldId: field.id, required: f.required, group: f.group ?? null, position: i };
    });
    if (new Set(rows.map((r) => r.fieldId)).size !== rows.length) {
      throw errors.validation([{ path: 'fields', message: 'Each field may appear once.' }]);
    }
    await ctx.tx.query('delete from family_fields where family_id = $1', [familyId]);
    if (rows.length > 0) {
      await ctx.tx.query(
        `insert into family_fields (shop_id, family_id, field_id, required, position, group_name)
         select app_shop_id(), $1, x.field_id, x.required, x.position, x.group_name
         from jsonb_to_recordset($2::jsonb) as x(field_id uuid, required boolean, position int, group_name text)`,
        [
          familyId,
          JSON.stringify(
            rows.map((r) => ({
              field_id: r.fieldId,
              required: r.required,
              position: r.position,
              group_name: r.group,
            })),
          ),
        ],
      );
    }
  }
  if (options) {
    await ctx.tx.query('delete from family_option_suggestions where family_id = $1', [familyId]);
    for (const [i, o] of options.entries()) {
      await ctx.tx.query(
        `insert into family_option_suggestions (shop_id, id, family_id, name, position, "values")
         values (app_shop_id(), $1, $2, $3, $4, $5)`,
        [ctx.newId(), familyId, o.name, i, JSON.stringify(o.values)],
      );
    }
  }
}

async function familyOut(ctx: HandlerContext, familyId: string) {
  const fields = visible(await loadFields(ctx.tx, { includeArchived: true }), ctx.membership);
  const families = await loadFamilies(ctx.tx, fields, true);
  return families.find((f) => f.id === familyId)!;
}

async function assertFamilyNameFree(tx: Tx, name: string, exceptId: string | null) {
  const [clash] = await tx.query(
    `select 1 from product_families where lower(name) = lower($1) and status = 'active'
       and ($2::uuid is null or id <> $2)`,
    [name, exceptId],
  );
  if (clash) throw errors.conflict('duplicate_family', `A family named "${name}" already exists.`);
}

export const createFamily = defineOperation({
  id: 'catalog.families.create',
  summary: 'Create a product family',
  description:
    'A family lists the fields its products use (each optional or required, in order and groups) and suggests option names and values. A product has at most one family; other fields stay available.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    fields: z.array(FamilyFieldInput).max(300).optional(),
    suggestedOptions: SuggestedOptionsInput.optional(),
  }),
  output: z.object({ family: FamilyOut }),
  permission: 'catalog.schema.manage',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.family.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/catalog/families', status: 201 },
  mcp: { tool: MCP_TOOL, action: 'create_family', readOnly: false, destructive: false },
  async handler(ctx, input) {
    requireSchemaPermission(ctx);
    await assertFamilyNameFree(ctx.tx, input.name, null);
    const id = ctx.newId();
    await ctx.tx.query(
      `insert into product_families (shop_id, id, name, description) values (app_shop_id(), $1, $2, $3)`,
      [id, input.name, input.description ?? null],
    );
    await writeFamilyMembers(ctx, id, input.fields, input.suggestedOptions);
    const family = await familyOut(ctx, id);
    return { result: { family }, audit: { targetType: 'family', targetId: id, changes: family } };
  },
});

export const updateFamily = defineOperation({
  id: 'catalog.families.update',
  summary: 'Change a product family, its fields, or archive and restore it',
  description:
    '`fields` and `suggestedOptions` replace the whole list when given. Products in an archived family keep it, but it cannot be chosen for others.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    familyId: Id,
    expectedVersion: z.number().int().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    fields: z.array(FamilyFieldInput).max(300).optional(),
    suggestedOptions: SuggestedOptionsInput.optional(),
    status: z.enum(['active', 'archived']).optional(),
  }),
  output: z.object({ family: FamilyOut }),
  permission: 'catalog.schema.manage',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.family.updated' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/catalog/families/{familyId}' },
  mcp: { tool: MCP_TOOL, action: 'update_family', readOnly: false, destructive: false },
  async handler(ctx, input) {
    requireSchemaPermission(ctx);
    const [current] = await ctx.tx.query<{ name: string; version: number; status: string }>(
      'select name, version, status from product_families where id = $1 for update',
      [input.familyId],
    );
    if (!current) throw errors.notFound('Family');
    checkVersion(current.version, input.expectedVersion, 'family');
    const before = await familyOut(ctx, input.familyId);
    const name = input.name ?? current.name;
    if ((input.status ?? current.status) === 'active')
      await assertFamilyNameFree(ctx.tx, name, input.familyId);
    await ctx.tx.query(
      `update product_families set name = $2, description = case when $3 then $4 else description end,
         status = coalesce($5, status), version = version + 1, updated_at = now() where id = $1`,
      [
        input.familyId,
        name,
        input.description !== undefined,
        input.description ?? null,
        input.status ?? null,
      ],
    );
    await writeFamilyMembers(ctx, input.familyId, input.fields, input.suggestedOptions);
    const family = await familyOut(ctx, input.familyId);
    return {
      result: { family },
      audit: {
        targetType: 'family',
        targetId: input.familyId,
        changes: { from: before, to: family },
      },
    };
  },
});

export const addTemplate = defineOperation({
  id: 'catalog.templates.add',
  summary: 'Add a starter family: apparel, furniture, food, or spare parts',
  description:
    'Copies the template into the shop as ordinary fields and a family, which you can then change. A field whose key already exists with the same type is reused, and missing options are added to it.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ template: z.enum(TEMPLATE_KEYS) }),
  output: z.object({
    family: FamilyOut,
    createdFields: z.array(z.string()),
    reusedFields: z.array(z.string()),
  }),
  permission: 'catalog.schema.manage',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.template.added' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/catalog/templates', status: 201 },
  mcp: { tool: MCP_TOOL, action: 'add_template', readOnly: false, destructive: false },
  async handler(ctx, input) {
    requireSchemaPermission(ctx);
    const template = TEMPLATES.find((t) => t.key === input.template)!;
    const [already] = await ctx.tx.query(
      `select 1 from product_families where template_key = $1 and status = 'active'`,
      [template.key],
    );
    if (already)
      throw errors.conflict(
        'template_added',
        `The ${template.name} family is already in this shop.`,
      );
    await assertFamilyNameFree(ctx.tx, template.name, null);
    const existing = await loadFields(ctx.tx, { includeArchived: true });
    const createdFields: string[] = [];
    const reusedFields: string[] = [];
    const members: Array<z.infer<typeof FamilyFieldInput>> = [];
    for (const tf of template.fields) {
      const found = existing.find((f) => f.key === tf.key);
      if (found) {
        if (found.type !== tf.type) {
          throw errors.conflict(
            'field_key_taken',
            `The shop already has a field "${tf.key}" of type ${found.type}; the ${template.name} template needs ${tf.type}.`,
          );
        }
        if (found.status !== 'active') {
          throw errors.conflict('field_archived', `Restore the archived field "${tf.key}" first.`);
        }
        const missing = (tf.options ?? []).filter(
          (label) =>
            !found.options.some(
              (o) => !o.archived && o.label.toLowerCase() === label.toLowerCase(),
            ),
        );
        if (missing.length > 0) await addOptions(ctx, found, missing);
        reusedFields.push(tf.key);
      } else {
        await insertField(ctx, {
          key: tf.key,
          label: tf.label,
          type: tf.type,
          level: tf.level,
          config: tf.config,
          options: tf.options,
        });
        createdFields.push(tf.key);
      }
      members.push({ field: tf.key, required: tf.required ?? false, group: tf.group });
    }
    const id = ctx.newId();
    await ctx.tx.query(
      `insert into product_families (shop_id, id, name, description, template_key)
       values (app_shop_id(), $1, $2, $3, $4)`,
      [id, template.name, template.description, template.key],
    );
    await writeFamilyMembers(ctx, id, members, template.options);
    const family = await familyOut(ctx, id);
    return {
      result: { family, createdFields, reusedFields },
      audit: {
        targetType: 'family',
        targetId: id,
        changes: { template: template.key, createdFields, reusedFields },
      },
    };
  },
});

/** Brand and category: created with every shop (plan Section 5.1). */
export async function createSystemFields(ctx: HandlerContext): Promise<void> {
  for (const [key, label] of [
    ['brand', 'Brand'],
    ['category', 'Category'],
  ] as const) {
    await ctx.tx.query(
      `insert into field_definitions (shop_id, id, key, label, type, level, is_system)
       values (app_shop_id(), $1, $2, $3, 'single_select', 'product', true)`,
      [ctx.newId(), key, label],
    );
  }
}

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const catalogSchemaOperations = [
  describeCatalog,
  createField,
  updateField,
  updateFieldOptions,
  convertField,
  createFamily,
  updateFamily,
  addTemplate,
] as const;
