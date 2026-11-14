import { z } from 'zod';
import { decimalScale, NonNegativeDecimal } from '../decimal.ts';
import { errors } from '../errors.ts';
import { defineOperation } from '../registry.ts';
import { Id, normalizeSku } from '../schemas.ts';

export const createItem = defineOperation({
  id: 'catalog.items.create',
  summary: 'Create a product with its default variant',
  description:
    'Creates a product and the default variant that carries its SKU and inventory settings. A SKU that matches an existing one after normalization is rejected.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    name: z.string().trim().min(1).max(500),
    sku: z.string().trim().min(1).max(100),
    description: z.string().max(20000).optional(),
    price: NonNegativeDecimal.optional(),
    baseUnit: z.string().trim().min(1).max(20).default('each'),
    quantityScale: z
      .number()
      .int()
      .min(0)
      .max(6)
      .default(0)
      .describe('Decimal places allowed in stock quantities, 0 for whole units.'),
  }),
  output: z.object({ productId: Id, variantId: Id, sku: z.string() }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.item.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/items', status: 201 },
  mcp: { tool: 'create_item', readOnly: false, destructive: false },
  async handler(ctx, input) {
    if (input.price && decimalScale(input.price) > 4) {
      throw errors.validation([{ path: 'price', message: 'At most 4 decimal places.' }]);
    }
    const skuNormalized = normalizeSku(input.sku);
    const [existing] = await ctx.tx.query<{ id: string }>(
      'select id from variants where sku_normalized = $1',
      [skuNormalized],
    );
    if (existing) {
      throw errors.conflict('duplicate_sku', 'A variant with this SKU already exists.', {
        existingVariantId: existing.id,
      });
    }
    const productId = ctx.newId();
    const variantId = ctx.newId();
    await ctx.tx.query(
      `with product as (
         insert into products (shop_id, id, name, description) values (app_shop_id(), $1, $2, $3))
       insert into variants (shop_id, id, product_id, sku, sku_normalized, price, base_unit,
         quantity_scale, is_default)
       values (app_shop_id(), $4, $1, $5, $6, $7, $8, $9, true)`,
      [
        productId,
        input.name,
        input.description ?? null,
        variantId,
        input.sku,
        skuNormalized,
        input.price ?? null,
        input.baseUnit,
        input.quantityScale,
      ],
    );
    return {
      result: { productId, variantId, sku: input.sku },
      audit: {
        targetType: 'variant',
        targetId: variantId,
        changes: {
          productId,
          name: input.name,
          sku: input.sku,
          price: input.price ?? null,
          baseUnit: input.baseUnit,
          quantityScale: input.quantityScale,
        },
      },
    };
  },
});

const VariantSummary = z.object({
  variantId: Id,
  productId: Id,
  productName: z.string(),
  sku: z.string(),
  price: z.string().nullable(),
  baseUnit: z.string(),
  quantityScale: z.number(),
  status: z.string(),
});

export const searchVariants = defineOperation({
  id: 'catalog.variants.search',
  summary: 'Find variants by SKU or name',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    sku: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Exact SKU, matched after normalization.'),
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Text found in the product name or SKU.'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    after: Id.optional().describe('Cursor from the previous page.'),
  }),
  output: z.object({ variants: z.array(VariantSummary), nextCursor: z.string().nullable() }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.variants.searched' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/variants' },
  mcp: { tool: 'find_items', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const rows = await ctx.tx.query<{
      id: string;
      product_id: string;
      product_name: string;
      sku: string;
      price: string | null;
      base_unit: string;
      quantity_scale: number;
      status: string;
    }>(
      `select v.id, v.product_id, p.name as product_name, v.sku, v.price::text as price,
         v.base_unit, v.quantity_scale, v.status
       from variants v
       join products p on p.shop_id = v.shop_id and p.id = v.product_id
       where ($1::text is null or v.sku_normalized = $1)
         and ($2::text is null or p.name ilike '%' || $2 || '%' or v.sku ilike '%' || $2 || '%')
         and ($3::uuid is null or v.id > $3)
       order by v.id
       limit $4`,
      [
        input.sku ? normalizeSku(input.sku) : null,
        input.query?.replace(/[\\%_]/g, (c) => `\\${c}`) ?? null,
        input.after ?? null,
        input.limit + 1,
      ],
    );
    const page = rows.slice(0, input.limit);
    return {
      result: {
        variants: page.map((r) => ({
          variantId: r.id,
          productId: r.product_id,
          productName: r.product_name,
          sku: r.sku,
          price: r.price,
          baseUnit: r.base_unit,
          quantityScale: r.quantity_scale,
          status: r.status,
        })),
        nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
      },
      audit: { targetType: 'variant', targetId: 'search' },
    };
  },
});
