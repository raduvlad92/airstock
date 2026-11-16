import type { Tx } from '@airstock/db';
import { z } from 'zod';
import type { FieldDefinition } from '../catalog/fields.ts';
import { loadOptions, variantTitle } from '../catalog/records.ts';
import { errors } from '../errors.ts';
import type { HandlerContext } from '../registry.ts';
import { Id, iso } from '../schemas.ts';
import { type DerivativePart, MEDIA_LIMITS, roleLabel, STARTER_ROLES } from './files.ts';

// Reading media: output shapes, a product's pictures with signed links, and the primary picture
// per product or variant for gallery cards (plan Section 5.8, ADR 0015). Exported for the grid,
// detail panel, and gallery (N3), which put the returned media IDs in their own access event (Q1).

export const ImageLinkOut = z.object({
  url: z
    .string()
    .nullable()
    .describe('Signed link, valid at least 15 minutes. Null when media delivery is not set up.'),
  contentType: z.string(),
  size: z.number().describe('Bytes.'),
  width: z.number().nullable(),
  height: z.number().nullable(),
});
export type ImageLink = z.infer<typeof ImageLinkOut>;

export const MediaOut = z.object({
  mediaId: Id,
  kind: z.enum(['image', 'document']),
  fileName: z.string(),
  contentType: z.string(),
  size: z.number().describe('Bytes of the original file.'),
  sha256: z.string(),
  width: z.number().nullable().describe('Pixels, for images whose header could be read.'),
  height: z.number().nullable(),
  createdAt: z.string(),
  thumbnail: ImageLinkOut.nullable().describe('Up to 320 px. Images only.'),
  display: ImageLinkOut.nullable().describe('Up to 1,600 px. Images only.'),
});
export type MediaItem = z.infer<typeof MediaOut>;

export const LinkOut = z.object({
  linkId: Id,
  mediaId: Id,
  productId: Id,
  variantId: Id.nullable().describe('Null for the product itself.'),
  role: z.string(),
  roleLabel: z.string(),
  position: z.number(),
  primary: z.boolean(),
  altText: z.string().nullable(),
});
export type MediaLink = z.infer<typeof LinkOut>;

export const ProductMediaOut = z.object({
  productId: Id,
  product: z.object({
    primaryMediaId: Id.nullable(),
    links: z.array(LinkOut).describe('In display order. Every variant inherits these.'),
  }),
  variants: z.array(
    z.object({
      variantId: Id,
      sku: z.string(),
      title: z.string(),
      primaryMediaId: Id.nullable().describe(
        'The variant’s own primary picture, else the product’s.',
      ),
      primaryInherited: z.boolean(),
      links: z
        .array(LinkOut)
        .describe('Links to this variant only, in order. Shown before the product’s pictures.'),
    }),
  ),
  media: z.array(MediaOut).describe('Each linked file once.'),
  roles: z.array(z.string()).describe('Starter roles and the roles in use in this shop.'),
  limits: z.object({
    mediaPerProduct: z.number(),
    imageBytes: z.number(),
    documentBytes: z.number(),
  }),
});
export type ProductMedia = z.infer<typeof ProductMediaOut>;

export const PrimaryPictureOut = z.object({
  recordType: z.enum(['product', 'variant']),
  recordId: Id,
  mediaId: Id.nullable().describe('Null when the record has no primary picture.'),
  inherited: z.boolean().describe('True when a variant shows its product’s primary picture.'),
  altText: z.string().nullable(),
  thumbnail: ImageLinkOut.nullable(),
});
export type PrimaryPicture = z.infer<typeof PrimaryPictureOut>;

export interface MediaRow {
  id: string;
  kind: 'image' | 'document';
  file_name: string;
  content_type: string;
  size_bytes: string | number | null;
  sha256: string;
  width: number | null;
  height: number | null;
  derivatives: Partial<
    Record<DerivativePart, { contentType: string; size: number; width: number; height: number }>
  >;
  created_at: Date;
  /** A picture referenced by its Shopify URL (D17): no R2 objects, shown from Shopify's CDN. */
  external_url: string | null;
}

export const MEDIA_COLUMNS =
  'm.id, m.kind, m.file_name, m.content_type, m.size_bytes, m.sha256, m.width, m.height, m.derivatives, m.created_at, m.external_url';

/** Pixel width asked of Shopify's CDN for each part (it scales on request). */
const EXTERNAL_WIDTHS: Record<DerivativePart, number> = { thumbnail: 320, display: 1600 };

function externalLink(row: MediaRow, part: DerivativePart): ImageLink {
  const width = Math.min(EXTERNAL_WIDTHS[part], row.width ?? EXTERNAL_WIDTHS[part]);
  const url = new URL(row.external_url!);
  url.searchParams.set('width', String(width));
  return {
    url: url.href,
    contentType: row.content_type,
    size: 0,
    width,
    height: row.width && row.height ? Math.round((row.height * width) / row.width) : width,
  };
}

export interface LinkRow {
  id: string;
  media_id: string;
  product_id: string;
  variant_id: string | null;
  role: string;
  position: number;
  is_primary: boolean;
  alt_text: string | null;
}

export const LINK_COLUMNS =
  'l.id, l.media_id, l.product_id, l.variant_id, l.role, l.position, l.is_primary, l.alt_text';

export function linkOut(r: LinkRow): MediaLink {
  return {
    linkId: r.id,
    mediaId: r.media_id,
    productId: r.product_id,
    variantId: r.variant_id,
    role: r.role,
    roleLabel: roleLabel(r.role),
    position: r.position,
    primary: r.is_primary,
    altText: r.alt_text,
  };
}

async function derivativeLink(
  ctx: Pick<HandlerContext, 'shopId' | 'media'>,
  row: MediaRow,
  part: DerivativePart,
): Promise<ImageLink | null> {
  if (row.kind === 'image' && row.external_url) return externalLink(row, part);
  const d = row.derivatives[part];
  if (row.kind !== 'image' || !d) return null;
  const signed = ctx.media
    ? await ctx.media.sign({
        shopId: ctx.shopId,
        mediaId: row.id,
        part,
        ttlSeconds: MEDIA_LIMITS.linkSeconds,
      })
    : null;
  return {
    url: signed?.url ?? null,
    contentType: d.contentType,
    size: d.size,
    width: d.width,
    height: d.height,
  };
}

/** Media rows as returned to clients, with signed thumbnail and display links. */
export async function renderMedia(
  ctx: Pick<HandlerContext, 'shopId' | 'media'>,
  rows: MediaRow[],
): Promise<MediaItem[]> {
  return Promise.all(
    rows.map(async (r) => ({
      mediaId: r.id,
      kind: r.kind,
      fileName: r.file_name,
      contentType: r.content_type,
      size: Number(r.size_bytes ?? 0),
      sha256: r.sha256,
      width: r.width,
      height: r.height,
      createdAt: iso(r.created_at) as string,
      thumbnail: await derivativeLink(ctx, r, 'thumbnail'),
      display: await derivativeLink(ctx, r, 'display'),
    })),
  );
}

export async function loadMediaRows(tx: Tx, ids: string[]): Promise<MediaRow[]> {
  if (ids.length === 0) return [];
  return tx.query<MediaRow>(
    `select ${MEDIA_COLUMNS} from media_assets m
     where m.id = any($1::uuid[]) and m.status = 'active' order by m.id`,
    [ids],
  );
}

/** Starter roles first, then the other roles the shop uses. */
export async function shopRoles(tx: Tx): Promise<string[]> {
  const rows = await tx.query<{ role: string }>(
    'select distinct role from media_links order by role limit 200',
  );
  const starters: readonly string[] = STARTER_ROLES;
  return [...STARTER_ROLES, ...rows.map((r) => r.role).filter((r) => !starters.includes(r))];
}

/**
 * A product's pictures and attachments: its own links, each variant's links, and each file once
 * with signed links. `mediaIds` is what the caller's access event should name (Q1).
 */
export async function productMedia(
  ctx: Pick<HandlerContext, 'tx' | 'shopId' | 'media'>,
  productId: string,
): Promise<{ result: ProductMedia; mediaIds: string[] }> {
  const [product] = await ctx.tx.query<{ id: string }>('select id from products where id = $1', [
    productId,
  ]);
  if (!product) throw errors.notFound('Product');
  const variants = await ctx.tx.query<{ id: string; sku: string; option_value_ids: string[] }>(
    'select id, sku, option_value_ids from variants where product_id = $1 order by id',
    [productId],
  );
  const options = await loadOptions(ctx.tx, productId);
  const links = await ctx.tx.query<LinkRow>(
    `select ${LINK_COLUMNS} from media_links l
     join media_assets m on m.shop_id = l.shop_id and m.id = l.media_id and m.status = 'active'
     where l.product_id = $1 order by l.position, l.id`,
    [productId],
  );
  const mediaIds = [...new Set(links.map((l) => l.media_id))];
  const media = await renderMedia(ctx, await loadMediaRows(ctx.tx, mediaIds));
  const own = links.filter((l) => l.variant_id === null);
  const productPrimary = own.find((l) => l.is_primary)?.media_id ?? null;
  return {
    mediaIds,
    result: {
      productId,
      product: { primaryMediaId: productPrimary, links: own.map(linkOut) },
      variants: variants.map((v) => {
        const mine = links.filter((l) => l.variant_id === v.id);
        const primary = mine.find((l) => l.is_primary)?.media_id ?? null;
        return {
          variantId: v.id,
          sku: v.sku,
          title: variantTitle(options, v.option_value_ids),
          primaryMediaId: primary ?? productPrimary,
          primaryInherited: primary === null && productPrimary !== null,
          links: mine.map(linkOut),
        };
      }),
      media,
      roles: await shopRoles(ctx.tx),
      limits: {
        mediaPerProduct: MEDIA_LIMITS.mediaPerProduct,
        imageBytes: MEDIA_LIMITS.imageBytes,
        documentBytes: MEDIA_LIMITS.documentBytes,
      },
    },
  };
}

/**
 * The primary picture of each product or variant, for gallery cards. A variant without its own
 * primary picture shows its product's (ADR 0012 inheritance). IDs of other shops, or of records
 * that do not exist, come back with no picture.
 */
export async function primaryPictures(
  ctx: Pick<HandlerContext, 'tx' | 'shopId' | 'media'>,
  ids: { productIds?: string[]; variantIds?: string[] },
): Promise<{ pictures: PrimaryPicture[]; mediaIds: string[] }> {
  type Row = {
    record_id: string;
    media_id: string | null;
    alt_text: string | null;
    inherited: boolean;
  };
  const productIds = [...new Set(ids.productIds ?? [])];
  const variantIds = [...new Set(ids.variantIds ?? [])];
  const products = productIds.length
    ? await ctx.tx.query<Row>(
        `select x.id as record_id, l.media_id, l.alt_text, false as inherited
         from unnest($1::uuid[]) as x(id)
         left join media_links l on l.product_id = x.id and l.variant_id is null and l.is_primary`,
        [productIds],
      )
    : [];
  const variants = variantIds.length
    ? await ctx.tx.query<Row>(
        `select x.id as record_id, coalesce(own.media_id, prod.media_id) as media_id,
           case when own.media_id is null then prod.alt_text else own.alt_text end as alt_text,
           (own.media_id is null and prod.media_id is not null) as inherited
         from unnest($1::uuid[]) as x(id)
         left join variants v on v.id = x.id
         left join lateral (select l.media_id, l.alt_text from media_links l
           where l.variant_id = v.id and l.is_primary limit 1) own on true
         left join lateral (select l.media_id, l.alt_text from media_links l
           where l.product_id = v.product_id and l.variant_id is null and l.is_primary limit 1) prod on true`,
        [variantIds],
      )
    : [];
  const mediaIds = [
    ...new Set([...products, ...variants].map((r) => r.media_id).filter((m) => m !== null)),
  ];
  const rows = new Map((await loadMediaRows(ctx.tx, mediaIds)).map((r) => [r.id, r]));
  const picture = async (recordType: 'product' | 'variant', r: Row): Promise<PrimaryPicture> => {
    const row = r.media_id ? rows.get(r.media_id) : undefined;
    return {
      recordType,
      recordId: r.record_id,
      mediaId: row ? row.id : null,
      inherited: row ? r.inherited : false,
      altText: row ? r.alt_text : null,
      thumbnail: row ? await derivativeLink(ctx, row, 'thumbnail') : null,
    };
  };
  const pictures = await Promise.all([
    ...products.map((r) => picture('product', r)),
    ...variants.map((r) => picture('variant', r)),
  ]);
  return { pictures, mediaIds: [...rows.keys()] };
}

/**
 * Why media IDs cannot be a file field's value, or null: each must be a file in this shop, of the
 * kind the field accepts (images, documents, or any).
 */
export async function fileFieldIssue(
  tx: Tx,
  def: Pick<FieldDefinition, 'config'>,
  mediaIds: string[],
): Promise<string | null> {
  if (mediaIds.length === 0) return null;
  const rows = await tx.query<{ id: string; kind: string }>(
    `select id, kind from media_assets where id = any($1::uuid[]) and status = 'active'`,
    [mediaIds],
  );
  const found = new Map(rows.map((r) => [r.id, r.kind]));
  const missing = mediaIds.filter((id) => !found.has(id));
  if (missing.length > 0) return `No media with ID ${missing.join(', ')} in this shop.`;
  const accept = def.config.accept ?? 'any';
  if (accept === 'any') return null;
  const want = accept === 'images' ? 'image' : 'document';
  const wrong = mediaIds.filter((id) => found.get(id) !== want);
  return wrong.length > 0
    ? `This field takes ${accept} only; ${wrong.join(', ')} ${wrong.length === 1 ? 'is' : 'are'} not.`
    : null;
}
