import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { normalize } from '../catalog/decimal.ts';

// Storefront values of a listing (plan Section 5.14, D21, ADR 0038), compared field by field on
// each side: what Airstock shows and what Shopify shows, as they were when the two last agreed.

export const LISTING_FIELDS = ['title', 'description', 'status', 'prices', 'pictures'] as const;
export type ListingField = (typeof LISTING_FIELDS)[number];

/** Outbox topic: publish a listing (create it in Shopify, or push the fields Airstock owns). */
export const SHOPIFY_LISTING_TOPIC = 'shopify.listing.publish';

export type Owners = Record<ListingField, 'airstock' | 'shopify'>;

export const ownedBy = (side: 'airstock' | 'shopify'): Owners =>
  Object.fromEntries(LISTING_FIELDS.map((f) => [f, side])) as Owners;

export interface StorefrontValues {
  title: string;
  /** Plain text (Airstock's Markdown, or Shopify's HTML as text). */
  description: string;
  status: 'draft' | 'active' | 'archived';
  /** Price by normalized SKU. */
  prices: Record<string, string>;
  /** Airstock: the product's picture media IDs. Shopify: how many pictures it shows. */
  pictures: string[] | number;
}

/** A product as Shopify shows it, read with its variants (no customer data). */
export const ShopifyProductState = z.object({
  productId: z.string().regex(/^[0-9]+$/),
  title: z.string().max(1000),
  descriptionHtml: z.string().max(200_000).nullable(),
  status: z.string().max(20),
  updatedAt: z.string().nullable(),
  variants: z
    .array(
      z.object({
        variantId: z.string().regex(/^[0-9]+$/),
        inventoryItemId: z
          .string()
          .regex(/^[0-9]+$/)
          .nullable(),
        sku: z.string().max(255).nullable(),
        barcode: z.string().max(255).nullable(),
        price: z.string().max(30).nullable(),
        title: z.string().max(1000),
        tracked: z.boolean(),
      }),
    )
    .max(250),
  mediaCount: z.number().int().min(0),
});
export type ShopifyProductState = z.infer<typeof ShopifyProductState>;

export const skuKey = (sku: string) => sku.trim().toUpperCase();

/** Markdown text as simple HTML: escaped, paragraphs and line breaks kept. */
export function textToHtml(text: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return text
    .trim()
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p>${escape(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Shopify's HTML description as text, for comparing and for Airstock's description field. */
export function htmlToText(html: string | null): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function shopifyValues(p: ShopifyProductState): StorefrontValues {
  const status = p.status.toLowerCase();
  return {
    title: p.title.trim(),
    description: htmlToText(p.descriptionHtml),
    status: status === 'active' || status === 'archived' ? status : 'draft',
    prices: Object.fromEntries(
      p.variants.flatMap((v) => (v.sku && v.price ? [[skuKey(v.sku), normalize(v.price)]] : [])),
    ),
    pictures: p.mediaCount,
  };
}

/** What Airstock would show in Shopify for a product: its active variants and pictures. */
export async function airstockValues(
  tx: Tx,
  productId: string,
  status: StorefrontValues['status'],
): Promise<StorefrontValues & { productStatus: string }> {
  const [product] = await tx.query<{ name: string; description: string | null; status: string }>(
    'select name, description, status from products where id = $1',
    [productId],
  );
  if (!product) throw new Error('Product not found.');
  const variants = await tx.query<{ sku: string; price: string | null }>(
    `select sku, price::text from variants where product_id = $1 and status = 'active'
     order by is_default desc, sku`,
    [productId],
  );
  const pictures = await tx.query<{ media_id: string }>(
    `select l.media_id from media_links l join media_assets m on m.shop_id = l.shop_id and m.id = l.media_id
     where l.product_id = $1 and l.variant_id is null and m.kind = 'image' and m.status = 'active'
       and m.external_url is null
     order by l.is_primary desc, l.position, l.id`,
    [productId],
  );
  return {
    title: product.name.trim(),
    description: (product.description ?? '').trim(),
    status,
    prices: Object.fromEntries(
      variants.flatMap((v) => (v.price ? [[skuKey(v.sku), normalize(v.price)]] : [])),
    ),
    pictures: pictures.map((p) => p.media_id),
    productStatus: product.status,
  };
}

/** Whether two values of a field are the same. */
export function sameValue(field: ListingField, a: unknown, b: unknown): boolean {
  if (field === 'prices') {
    const x = (a ?? {}) as Record<string, string>;
    const y = (b ?? {}) as Record<string, string>;
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    return [...keys].every((k) => x[k] === y[k]);
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
