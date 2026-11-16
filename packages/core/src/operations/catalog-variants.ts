import { z } from 'zod';
import {
  loadOptions,
  type OptionRow,
  VARIANT_COLUMNS,
  type VariantRow,
} from '../catalog/records.ts';
import { errors } from '../errors.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id, normalizeSku } from '../schemas.ts';
import { ItemDetail, itemDetail } from './catalog-items.ts';

// Product options and variant generation (plan Section 5.1). Options have stable value IDs, so
// renaming "Grey" to "Gray" touches no variant. A variant stores its option value IDs sorted, so
// reordering options never rewrites variants.

export const MAX_OPTIONS = 3;
export const MAX_VARIANTS = 2048;
const MAX_VALUES = 100;

const ValueInput = z.union([
  z.string().trim().min(1).max(100),
  z.object({ id: Id.optional(), label: z.string().trim().min(1).max(100) }),
]);

export const OptionsInput = z
  .array(
    z.object({
      id: Id.optional().describe('An existing option, to rename or reorder it.'),
      name: z.string().trim().min(1).max(100).describe('Such as Size or Colour.'),
      values: z
        .array(ValueInput)
        .min(1)
        .max(MAX_VALUES)
        .describe('Value labels in order, or {id, label} to rename an existing value.'),
    }),
  )
  .max(MAX_OPTIONS)
  .describe(`Up to ${MAX_OPTIONS} options, in order.`);
type OptionsSpec = z.infer<typeof OptionsInput>;

interface PlannedValue {
  id: string;
  label: string;
  isNew: boolean;
}
interface PlannedOption {
  id: string;
  name: string;
  isNew: boolean;
  values: PlannedValue[];
}

const sortIds = (ids: string[]) => [...ids].sort();

/**
 * Matches the requested options to the existing ones by ID, then by name, and their values by ID,
 * then by label (case-insensitive). Unmatched ones are new. With `replace`, existing options and
 * values left out are removed; otherwise they are kept.
 */
function plan(
  ctx: HandlerContext,
  existing: OptionRow[],
  spec: OptionsSpec,
  replace: boolean,
): {
  options: PlannedOption[];
  removedOptions: OptionRow[];
  removedValues: string[];
} {
  const used = new Set<string>();
  const options: PlannedOption[] = spec.map((o, i) => {
    const match =
      (o.id ? existing.find((e) => e.id === o.id) : undefined) ??
      existing.find((e) => !used.has(e.id) && e.name.toLowerCase() === o.name.toLowerCase());
    if (o.id && !match)
      throw errors.validation([
        { path: `options.${i}.id`, message: 'Not an option of this product.' },
      ]);
    if (match) used.add(match.id);
    const usedValues = new Set<string>();
    const values: PlannedValue[] = o.values.map((v, j) => {
      const label = typeof v === 'string' ? v : v.label;
      const id = typeof v === 'string' ? undefined : v.id;
      const found =
        (id ? match?.values.find((x) => x.id === id) : undefined) ??
        match?.values.find(
          (x) => !usedValues.has(x.id) && x.label.toLowerCase() === label.toLowerCase(),
        );
      if (id && !found) {
        throw errors.validation([
          { path: `options.${i}.values.${j}`, message: 'Not a value of this option.' },
        ]);
      }
      if (found) usedValues.add(found.id);
      return { id: found?.id ?? ctx.newId(), label, isNew: !found };
    });
    if (new Set(values.map((v) => v.label.toLowerCase())).size !== values.length) {
      throw errors.validation([
        { path: `options.${i}.values`, message: 'Each value may appear once.' },
      ]);
    }
    if (!replace && match) {
      // Keep existing values that were not mentioned, after the requested ones.
      for (const x of match.values)
        if (!usedValues.has(x.id)) values.push({ id: x.id, label: x.label, isNew: false });
    }
    return { id: match?.id ?? ctx.newId(), name: o.name, isNew: !match, values };
  });
  if (new Set(options.map((o) => o.name.toLowerCase())).size !== options.length) {
    throw errors.validation([{ path: 'options', message: 'Each option name may appear once.' }]);
  }
  const removedOptions = replace ? existing.filter((e) => !used.has(e.id)) : [];
  if (!replace) {
    for (const e of existing) {
      if (!used.has(e.id)) {
        throw errors.validation([
          {
            path: 'options',
            message: `Include the product's existing option "${e.name}" with the values to use.`,
          },
        ]);
      }
    }
  }
  const removedValues = replace
    ? options.flatMap((o) => {
        const before = existing.find((e) => e.id === o.id);
        return (before?.values ?? [])
          .filter((v) => !o.values.some((x) => x.id === v.id))
          .map((v) => v.id);
      })
    : [];
  if (options.length > MAX_OPTIONS) {
    throw errors.unprocessable('limit_reached', `A product has at most ${MAX_OPTIONS} options.`);
  }
  return { options, removedOptions, removedValues };
}

/** Writes the planned options and values (names, labels, positions). */
async function writeOptions(
  ctx: HandlerContext,
  productId: string,
  planned: PlannedOption[],
  removed: OptionRow[],
  removedValues: string[],
) {
  // Option positions are unique per product, checked at commit, so options can swap places.
  if (removedValues.length > 0) {
    await ctx.tx.query('delete from product_option_values where id = any($1::uuid[])', [
      removedValues,
    ]);
  }
  for (const o of removed) {
    await ctx.tx.query('delete from product_option_values where option_id = $1', [o.id]);
    await ctx.tx.query('delete from product_options where id = $1', [o.id]);
  }
  for (const [i, o] of planned.entries()) {
    if (o.isNew) {
      await ctx.tx.query(
        `insert into product_options (shop_id, id, product_id, name, position) values (app_shop_id(), $1, $2, $3, $4)`,
        [o.id, productId, o.name, i],
      );
    } else {
      await ctx.tx.query('update product_options set name = $2, position = $3 where id = $1', [
        o.id,
        o.name,
        i,
      ]);
    }
    // Labels are unique per option; park the existing ones before renaming.
    await ctx.tx.query(`update product_option_values set label = id::text where option_id = $1`, [
      o.id,
    ]);
    for (const [j, v] of o.values.entries()) {
      if (v.isNew) {
        await ctx.tx.query(
          `insert into product_option_values (shop_id, id, option_id, label, position)
           values (app_shop_id(), $1, $2, $3, $4)`,
          [v.id, o.id, v.label, j],
        );
      } else {
        await ctx.tx.query(
          'update product_option_values set label = $2, position = $3 where id = $1',
          [v.id, v.label, j],
        );
      }
    }
  }
}

async function lockProduct(ctx: HandlerContext, productId: string) {
  const [product] = await ctx.tx.query<{ version: number; status: string }>(
    'select version, status from products where id = $1 for update',
    [productId],
  );
  if (!product) throw errors.notFound('Product');
  const variants = await ctx.tx.query<VariantRow>(
    `select ${VARIANT_COLUMNS} from variants where product_id = $1 order by id for update`,
    [productId],
  );
  return { product, variants, options: await loadOptions(ctx.tx, productId) };
}

/**
 * New option values for existing variants: each variant keeps its values for options that stay
 * and takes the first value of every new option, so combinations stay distinct.
 */
function reassign(
  variant: VariantRow,
  planned: PlannedOption[],
  removedValues: Set<string>,
): string[] {
  const kept = variant.option_value_ids.filter(
    (id) => !removedValues.has(id) && planned.some((o) => o.values.some((v) => v.id === id)),
  );
  const ids = [...kept];
  for (const o of planned) {
    if (!o.values.some((v) => ids.includes(v.id))) ids.push(o.values[0]!.id);
  }
  return sortIds(ids);
}

async function assertDistinct(variants: Array<{ id: string; status: string; ids: string[] }>) {
  const seen = new Map<string, string>();
  for (const v of variants.filter((x) => x.status === 'active')) {
    const key = v.ids.join(',');
    if (seen.has(key)) {
      throw errors.conflict(
        'combination_taken',
        'Two active variants would have the same option values. Archive one first, or keep the option.',
      );
    }
    seen.set(key, v.id);
  }
}

export const setProductOptions = defineOperation({
  id: 'catalog.product_options.set',
  summary: 'Set a product’s options and their values (rename, reorder, add, remove)',
  description:
    'Give the full list of options in order. Existing options and values are matched by ID, then by name or label; ones left out are removed. Existing variants keep their values and take the first value of any new option. A value still used by a variant cannot be removed, and removing every option needs exactly one active variant.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    productId: Id,
    expectedVersion: z.number().int().optional().describe('The product version you read.'),
    options: OptionsInput,
  }),
  output: z.object({ item: ItemDetail }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.product_options.set' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/products/{productId}/options' },
  mcp: { tool: 'edit_catalog', action: 'set_options', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const { product, variants, options } = await lockProduct(ctx, input.productId);
    if (input.expectedVersion !== undefined && input.expectedVersion !== product.version) {
      throw errors.conflict(
        'version_conflict',
        'The product changed since you read it. Reload and retry.',
        {
          currentVersion: product.version,
        },
      );
    }
    const planned = plan(ctx, options, input.options, true);
    const removed = new Set(planned.removedValues);
    const inUse = variants.find((v) => v.option_value_ids.some((id) => removed.has(id)));
    if (inUse) {
      throw errors.conflict(
        'option_value_in_use',
        `A value you removed is still used by variant ${inUse.sku}. Archive the variant, or keep the value.`,
      );
    }
    const removedOptionValues = new Set(
      planned.removedOptions.flatMap((o) => o.values.map((v) => v.id)),
    );
    const next = variants.map((v) => ({
      id: v.id,
      status: v.status,
      before: v.option_value_ids,
      ids: reassign(v, planned.options, removedOptionValues),
    }));
    await assertDistinct(next);
    await writeOptions(
      ctx,
      input.productId,
      planned.options,
      planned.removedOptions,
      planned.removedValues,
    );
    for (const v of next) {
      if (v.ids.join(',') !== v.before.join(',')) {
        await ctx.tx.query(
          'update variants set option_value_ids = $2::uuid[], version = version + 1, updated_at = now() where id = $1',
          [v.id, v.ids],
        );
      }
    }
    const [updated] = await ctx.tx.query<{ version: number }>(
      'update products set version = version + 1, updated_at = now() where id = $1 returning version',
      [input.productId],
    );
    const item = await itemDetail(ctx, input.productId);
    return {
      result: { item },
      audit: {
        targetType: 'product',
        targetId: input.productId,
        changes: {
          fields: { options: { from: options.map(summary), to: item.options.map(summary) } },
          version: updated!.version,
        },
      },
    };
  },
});

function summary(o: { name: string; values: Array<{ label: string }> }) {
  return { name: o.name, values: o.values.map((v) => v.label) };
}

/** Fills `{option}` placeholders with value labels; option names match ignoring case and spaces. */
export function skuFromPattern(pattern: string, values: Record<string, string>): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[\s_-]+/g, '')
      .replace(/^colour$/, 'color');
  const byName = new Map(Object.entries(values).map(([k, v]) => [norm(k), v]));
  return pattern.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const value = byName.get(norm(name));
    if (value === undefined) throw new Error(name);
    return value.toUpperCase().replace(/\s+/g, '-');
  });
}

export const generateVariants = defineOperation({
  id: 'catalog.variants.generate',
  summary: 'Preview or create variants for every combination of option values',
  description:
    'Give the options and values to combine (including the product’s existing options) and a SKU pattern such as "TS-{color}-{size}". With mode "preview" (the default) nothing is created: you get each combination, its SKU, and any duplicates. Run again with mode "create" to create the missing variants. A product’s single default variant keeps its ID, SKU, stock, and history and takes the first combination.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    productId: Id,
    options: OptionsInput,
    skuPattern: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Placeholders are option names in braces. Without one, SKUs are the base SKU plus the values.',
      ),
    price: z
      .string()
      .max(30)
      .optional()
      .describe('Price for new variants; defaults to the default variant’s.'),
    mode: z.enum(['preview', 'create']).default('preview'),
  }),
  output: z.object({
    mode: z.enum(['preview', 'create']),
    combinations: z.array(
      z.object({
        optionValues: z.record(z.string(), z.string()),
        sku: z.string(),
        variantId: Id.nullable(),
        state: z
          .enum(['existing', 'kept', 'new'])
          .describe('kept: the default variant takes this combination.'),
        duplicate: z.boolean().describe('The SKU is already used, or repeats within this set.'),
      }),
    ),
    created: z.number(),
    item: ItemDetail.nullable(),
  }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.variants.generated' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/products/{productId}/variants/generate' },
  mcp: { tool: 'edit_catalog', action: 'generate_variants', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const { variants, options } = await lockProduct(ctx, input.productId);
    if (input.options.length === 0)
      throw errors.validation([{ path: 'options', message: 'Give at least one option.' }]);
    const planned = plan(ctx, options, input.options, false);
    const requested = input.options.map((o, i) =>
      planned.options[i]!.values.filter((v) =>
        o.values.some(
          (x) => (typeof x === 'string' ? x : x.label).toLowerCase() === v.label.toLowerCase(),
        ),
      ),
    );
    // Every combination of the requested values, in option order.
    let combos: PlannedValue[][] = [[]];
    for (const values of requested) combos = combos.flatMap((c) => values.map((v) => [...c, v]));
    const active = variants.filter((v) => v.status === 'active');
    const reassigned = variants.map((v) => ({
      ...v,
      next: reassign(v, planned.options, new Set()),
    }));
    if (combos.length + active.length > MAX_VARIANTS + 1) {
      throw errors.unprocessable(
        'limit_reached',
        `A product has at most ${MAX_VARIANTS} variants.`,
      );
    }
    // A product without options has one default variant: it takes the first combination.
    const defaultVariant = options.length === 0 && active.length === 1 ? active[0]! : null;
    const base = (defaultVariant ?? active.find((v) => v.is_default) ?? active[0])!;
    const existingSkus = new Set<string>();
    const rows: Array<{
      values: PlannedValue[];
      optionValues: Record<string, string>;
      sku: string;
      variantId: string | null;
      state: 'existing' | 'kept' | 'new';
      duplicate: boolean;
    }> = [];
    for (const [i, combo] of combos.entries()) {
      const ids = sortIds(combo.map((v) => v.id));
      const optionValues = Object.fromEntries(
        planned.options.map((o, k) => [o.name, combo[k]!.label]),
      );
      const match = reassigned.find(
        (v) => v.status === 'active' && v.next.join(',') === ids.join(','),
      );
      if (i === 0 && defaultVariant) {
        rows.push({
          values: combo,
          optionValues,
          sku: defaultVariant.sku,
          variantId: defaultVariant.id,
          state: 'kept',
          duplicate: false,
        });
        continue;
      }
      if (match) {
        rows.push({
          values: combo,
          optionValues,
          sku: match.sku,
          variantId: match.id,
          state: 'existing',
          duplicate: false,
        });
        continue;
      }
      let sku: string;
      try {
        sku = input.skuPattern
          ? skuFromPattern(input.skuPattern, optionValues)
          : `${base.sku}-${combo.map((v) => v.label.toUpperCase().replace(/\s+/g, '-')).join('-')}`;
      } catch (error) {
        throw errors.validation([
          {
            path: 'skuPattern',
            message: `No option named "${(error as Error).message}" in the pattern.`,
          },
        ]);
      }
      if (sku.length > 100)
        throw errors.validation([
          { path: 'skuPattern', message: 'SKUs are at most 100 characters.' },
        ]);
      rows.push({
        values: combo,
        optionValues,
        sku,
        variantId: null,
        state: 'new',
        duplicate: false,
      });
    }
    // Duplicates: within the set, and against every SKU in the shop.
    const fresh = rows.filter((r) => r.state === 'new');
    const taken = await ctx.tx.query<{ sku_normalized: string }>(
      'select sku_normalized from variants where sku_normalized = any($1::text[])',
      [fresh.map((r) => normalizeSku(r.sku))],
    );
    for (const t of taken) existingSkus.add(t.sku_normalized);
    const seen = new Set<string>();
    for (const r of rows) {
      const n = normalizeSku(r.sku);
      if (r.state === 'new' && (existingSkus.has(n) || seen.has(n))) r.duplicate = true;
      seen.add(n);
    }
    const out = rows.map(({ values: _v, ...r }) => r);
    if (input.mode === 'preview') {
      return {
        result: { mode: 'preview' as const, combinations: out, created: 0, item: null },
        audit: {
          targetType: 'product',
          targetId: input.productId,
          outcome: 'no_change' as const,
          context: { preview: true, combinations: rows.length, new: fresh.length },
        },
      };
    }
    const duplicates = rows.filter((r) => r.duplicate).map((r) => r.sku);
    if (duplicates.length > 0) {
      throw errors.conflict(
        'duplicate_sku',
        'Some generated SKUs are already used. Change the pattern.',
        {
          skus: duplicates,
        },
      );
    }
    await writeOptions(ctx, input.productId, planned.options, [], []);
    // Existing variants take values for new options; the default variant takes the first combination.
    for (const v of reassigned) {
      const next = v.id === defaultVariant?.id ? sortIds(rows[0]!.values.map((x) => x.id)) : v.next;
      if (next.join(',') !== v.option_value_ids.join(',')) {
        await ctx.tx.query(
          'update variants set option_value_ids = $2::uuid[], version = version + 1, updated_at = now() where id = $1',
          [v.id, next],
        );
      }
    }
    const price = input.price ?? base.price;
    const created: string[] = [];
    for (const r of rows.filter((x) => x.state === 'new')) {
      const id = ctx.newId();
      await ctx.tx.query(
        `insert into variants (shop_id, id, product_id, sku, sku_normalized, price, base_unit, quantity_scale,
           option_value_ids)
         values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8::uuid[])`,
        [
          id,
          input.productId,
          r.sku,
          normalizeSku(r.sku),
          price,
          base.base_unit,
          base.quantity_scale,
          sortIds(r.values.map((x) => x.id)),
        ],
      );
      r.variantId = id;
      created.push(id);
    }
    const [updated] = await ctx.tx.query<{ version: number }>(
      'update products set version = version + 1, updated_at = now() where id = $1 returning version',
      [input.productId],
    );
    const item = await itemDetail(ctx, input.productId);
    return {
      result: {
        mode: 'create' as const,
        combinations: rows.map(({ values: _v, ...r }) => r),
        created: created.length,
        item,
      },
      audit: {
        targetType: 'product',
        targetId: input.productId,
        changes: {
          fields: { options: { from: options.map(summary), to: item.options.map(summary) } },
          createdVariants: rows
            .filter((r) => r.state === 'new')
            .map((r) => ({ id: r.variantId, sku: r.sku })),
          version: updated!.version,
        },
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const catalogVariantsOperations = [setProductOptions, generateVariants] as const;
