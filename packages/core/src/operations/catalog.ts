import { z } from 'zod';
import { defineOperation } from '../registry.ts';
import { Id, normalizeSku } from '../schemas.ts';

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
  mcp: {
    exception: 'Superseded over MCP by search_catalog (query); kept as a simple REST lookup.',
  },
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
