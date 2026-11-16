import { z } from 'zod';
import { callerKey } from '../caller.ts';
import { errors } from '../errors.ts';
import {
  DERIVATIVE_TYPES,
  MEDIA_LIMITS,
  MEDIA_TYPES,
  type MediaKind,
  type MediaType,
  maxBytes,
  mediaKind,
  normalizeRole,
  UPLOAD_PARTS,
} from '../media/files.ts';
import {
  LINK_COLUMNS,
  LinkOut,
  type LinkRow,
  linkOut,
  loadMediaRows,
  MEDIA_COLUMNS,
  MediaOut,
  type MediaRow,
  PrimaryPictureOut,
  ProductMediaOut,
  primaryPictures,
  productMedia,
  renderMedia,
} from '../media/library.ts';
import {
  checkIntentPending,
  mediaUnavailable,
  type UploadedPart,
  uploadPath,
} from '../media/uploads.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id } from '../schemas.ts';

// Pictures and attachments: upload intents and finalize, links with roles, order, primary flags
// and alt text, reads with signed links, and original downloads (plan Section 5.8, ADR 0015).

const TOOL = 'manage_media';
const UPLOAD_EXCEPTION =
  'File upload sends binary data, which MCP tools do not carry; the dashboard and the REST API upload files.';

// Arguments shared by several manage_media actions use one schema each: the MCP schema is flat.
const MediaIdArg = Id.describe('A media ID from list or find.');
const ProductIdArg = Id.describe('The product.');
const VariantIdArg = Id.describe('A variant of the product. Leave out for the product itself.');
const IdList = z
  .union([z.array(Id).max(2048), z.string().max(80_000)])
  .describe('IDs as an array, or comma-separated.');
const ScopeArg = z
  .enum(['product', 'variants', 'both'])
  .describe(
    'product: the product itself, shown for every variant. variants: only the listed variants. both: the product and the listed variants.',
  );
const RoleArg = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe(
    'Any role, such as primary, lifestyle, detail, packaging, dimension_diagram, or swatch.',
  );
const AltTextArg = z
  .string()
  .trim()
  .max(MEDIA_LIMITS.altTextLength)
  .nullable()
  .describe('Text describing the picture for people who cannot see it; null clears it.');
const PrimaryArg = z
  .boolean()
  .describe('Make this the primary picture of its scope (images only).');
const BoolParam = z.union([z.boolean(), z.enum(['true', 'false'])]);

function parseIds(value: unknown, path: string, max: number): string[] {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const ids = list.map((v) => String(v).trim()).filter(Boolean);
  const bad = ids.find((id) => !Id.safeParse(id).success);
  if (bad !== undefined) throw errors.validation([{ path, message: `Not an ID: ${bad}` }]);
  if (ids.length > max) throw errors.validation([{ path, message: `At most ${max} IDs.` }]);
  return [...new Set(ids)];
}

function roleFor(input: string | undefined, kind: MediaKind, becomesPrimary: boolean): string {
  if (input !== undefined) {
    const role = normalizeRole(input);
    if (!role)
      throw errors.validation([
        { path: 'role', message: 'Use letters, digits, and spaces, starting with a letter.' },
      ]);
    return role;
  }
  if (kind === 'document') return 'attachment';
  return becomesPrimary ? 'primary' : 'detail';
}

// Links ------------------------------------------------------------------------------------

interface LinkTargets {
  productId: string;
  scope?: 'product' | 'variants' | 'both';
  variantIds?: unknown;
  role?: string;
  altText?: string | null;
  primary?: boolean;
}

/** Locks the product so link changes on it run one at a time (positions, primary, the limit). */
async function lockProduct(ctx: HandlerContext, productId: string) {
  const [row] = await ctx.tx.query<{ id: string }>(
    'select id from products where id = $1 for update',
    [productId],
  );
  if (!row) throw errors.notFound('Product');
}

async function productVariants(ctx: HandlerContext, productId: string, ids: string[]) {
  if (ids.length === 0) return;
  const rows = await ctx.tx.query<{ id: string }>(
    'select id from variants where product_id = $1 and id = any($2::uuid[])',
    [productId, ids],
  );
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    throw errors.validation([
      {
        path: 'variantIds',
        message: `Not a variant of this product: ${ids.filter((i) => !found.has(i)).join(', ')}`,
      },
    ]);
  }
}

/**
 * Links a media item to a product, some of its variants, or both. Linking again where a link
 * exists changes nothing there. The first image in a scope becomes its primary picture.
 */
async function addLinks(
  ctx: HandlerContext,
  media: { id: string; kind: MediaKind },
  input: LinkTargets,
): Promise<{ created: LinkRow[]; existing: LinkRow[] }> {
  await lockProduct(ctx, input.productId);
  const scope = input.scope ?? 'product';
  const variantIds = parseIds(input.variantIds, 'variantIds', 2048);
  if (scope !== 'product' && variantIds.length === 0) {
    throw errors.validation([{ path: 'variantIds', message: 'Name the variants to link to.' }]);
  }
  if (scope === 'product' && variantIds.length > 0) {
    throw errors.validation([
      { path: 'scope', message: 'Use scope variants or both to link to variants.' },
    ]);
  }
  if (input.primary && media.kind !== 'image') {
    throw errors.validation([{ path: 'primary', message: 'Only images can be primary.' }]);
  }
  await productVariants(ctx, input.productId, variantIds);
  const targets: Array<string | null> = [
    ...(scope === 'variants' ? [] : [null]),
    ...(scope === 'product' ? [] : variantIds),
  ];
  const [usage] = await ctx.tx.query<{ media: number; linked: boolean }>(
    `select count(distinct media_id)::int as media, bool_or(media_id = $2) as linked
     from media_links where product_id = $1`,
    [input.productId, media.id],
  );
  if (!usage?.linked && (usage?.media ?? 0) >= MEDIA_LIMITS.mediaPerProduct) {
    throw errors.unprocessable(
      'too_many_media',
      `A product can have at most ${MEDIA_LIMITS.mediaPerProduct} pictures and attachments.`,
    );
  }
  const created: LinkRow[] = [];
  const existing: LinkRow[] = [];
  for (const variantId of targets) {
    const [scopeState] = await ctx.tx.query<{
      existing: LinkRow | null;
      has_primary: boolean;
      next: number;
    }>(
      `select
         (select row_to_json(x) from (select ${LINK_COLUMNS} from media_links l
            where l.product_id = $1 and l.variant_id is not distinct from $2 and l.media_id = $3) x)
           as existing,
         exists (select 1 from media_links where product_id = $1
           and variant_id is not distinct from $2 and is_primary) as has_primary,
         coalesce((select max(position) + 1 from media_links where product_id = $1
           and variant_id is not distinct from $2), 0) as next`,
      [input.productId, variantId, media.id],
    );
    if (scopeState!.existing) {
      existing.push(scopeState!.existing);
      continue;
    }
    const primary =
      media.kind === 'image' &&
      input.primary !== false &&
      (input.primary || !scopeState!.has_primary);
    if (primary && scopeState!.has_primary) {
      await ctx.tx.query(
        `update media_links set is_primary = false, updated_at = now()
         where product_id = $1 and variant_id is not distinct from $2 and is_primary`,
        [input.productId, variantId],
      );
    }
    const [row] = await ctx.tx.query<LinkRow>(
      `insert into media_links as l (shop_id, id, media_id, product_id, variant_id, role, position,
         is_primary, alt_text)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8)
       returning ${LINK_COLUMNS}`,
      [
        ctx.newId(),
        media.id,
        input.productId,
        variantId,
        roleFor(input.role, media.kind, primary),
        scopeState!.next,
        primary,
        input.altText || null,
      ],
    );
    created.push(row!);
  }
  return { created, existing };
}

/** After a scope loses its primary picture, its first remaining image takes over. */
async function promoteNextPrimary(
  ctx: HandlerContext,
  productId: string,
  variantId: string | null,
) {
  await ctx.tx.query(
    `update media_links set is_primary = true, updated_at = now()
     where id = (
       select l.id from media_links l
       join media_assets m on m.shop_id = l.shop_id and m.id = l.media_id
       where l.product_id = $1 and l.variant_id is not distinct from $2 and m.kind = 'image'
       order by l.position, l.id limit 1)
     and not exists (select 1 from media_links where product_id = $1
       and variant_id is not distinct from $2 and is_primary)`,
    [productId, variantId],
  );
}

async function activeMedia(ctx: HandlerContext, mediaId: string): Promise<MediaRow> {
  const [row] = await loadMediaRows(ctx.tx, [mediaId]);
  if (!row) throw errors.notFound('Media');
  return row;
}

async function linksOfMedia(ctx: HandlerContext, mediaId: string, productId: string) {
  const rows = await ctx.tx.query<LinkRow>(
    `select ${LINK_COLUMNS} from media_links l where l.media_id = $1 and l.product_id = $2
     order by l.variant_id nulls first, l.id`,
    [mediaId, productId],
  );
  return rows.map(linkOut);
}

// Upload -----------------------------------------------------------------------------------

const UploadOut = z.object({
  part: z.enum(UPLOAD_PARTS),
  url: z.string().describe('PUT the file body here, with the same authentication.'),
  method: z.literal('PUT'),
  contentTypes: z.array(z.string()),
  maxBytes: z.number(),
  maxSide: z.number().nullable().describe('Longest side in pixels, for derivatives.'),
});

export const createUpload = defineOperation({
  id: 'catalog.media.uploads.create',
  summary: 'Start uploading a picture or attachment',
  description:
    'Declare the file name, type, size in bytes, and SHA-256 (hex). The answer has upload URLs valid for 15 minutes: PUT the original to the first; for images also PUT a thumbnail (WebP or JPEG, longest side up to 320 px) and a display image (up to 1,600 px). Then finalize. A wrong checksum, a file that is not what it says, or an oversize file is refused and the upload fails.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    fileName: z.string().trim().min(1).max(255),
    contentType: z.enum(MEDIA_TYPES),
    size: z.number().int().positive().describe('Bytes.'),
    sha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'A SHA-256 as 64 hex characters.')
      .transform((s) => s.toLowerCase()),
    productId: Id.optional().describe('Checked against the per-product limit before uploading.'),
  }),
  output: z.object({
    intentId: Id,
    mediaId: Id,
    kind: z.enum(['image', 'document']),
    expiresAt: z.string(),
    uploads: z.array(UploadOut),
  }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.media.upload_started' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/media/uploads', status: 201 },
  mcp: { exception: UPLOAD_EXCEPTION },
  async handler(ctx, input) {
    const delivery = ctx.media;
    if (!delivery) throw mediaUnavailable();
    const kind = mediaKind(input.contentType);
    const limit = maxBytes(input.contentType);
    if (input.size > limit) {
      throw errors.unprocessable(
        'file_too_large',
        `${kind === 'image' ? 'Images' : 'Attachments'} can be at most ${limit / 1024 / 1024} MB.`,
        { maxBytes: limit },
      );
    }
    if (input.productId) {
      const [usage] = await ctx.tx.query<{ found: boolean; media: number }>(
        `select exists (select 1 from products where id = $1) as found,
           (select count(distinct media_id)::int from media_links where product_id = $1) as media`,
        [input.productId],
      );
      if (!usage?.found) throw errors.notFound('Product');
      if (usage.media >= MEDIA_LIMITS.mediaPerProduct) {
        throw errors.unprocessable(
          'too_many_media',
          `A product can have at most ${MEDIA_LIMITS.mediaPerProduct} pictures and attachments.`,
        );
      }
    }
    const intentId = ctx.newId();
    const mediaId = ctx.newId();
    const [row] = await ctx.tx.query<{ expires_at: Date }>(
      `insert into media_upload_intents (shop_id, id, media_id, kind, file_name, content_type,
         size_bytes, sha256, created_by, expires_at)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))
       returning expires_at`,
      [
        intentId,
        mediaId,
        kind,
        input.fileName,
        input.contentType,
        input.size,
        input.sha256,
        callerKey(ctx.caller),
        MEDIA_LIMITS.intentSeconds,
      ],
    );
    const parts = kind === 'image' ? UPLOAD_PARTS : (['original'] as const);
    const uploads = parts.map((part) => {
      const derivative = part === 'original' ? null : MEDIA_LIMITS[part];
      return {
        part,
        url: delivery.url(`/api/v1${uploadPath(ctx.shopId, intentId, part)}`),
        method: 'PUT' as const,
        contentTypes: derivative ? [...DERIVATIVE_TYPES] : [input.contentType],
        maxBytes: derivative ? derivative.maxBytes : input.size,
        maxSide: derivative ? derivative.maxSide : null,
      };
    });
    return {
      result: {
        intentId,
        mediaId,
        kind,
        expiresAt: new Date(row!.expires_at).toISOString(),
        uploads,
      },
      audit: {
        targetType: 'media_upload',
        targetId: intentId,
        changes: {
          mediaId,
          fileName: input.fileName,
          contentType: input.contentType,
          size: input.size,
          sha256: input.sha256,
        },
      },
    };
  },
});

export const finalizeUpload = defineOperation({
  id: 'catalog.media.uploads.finalize',
  summary: 'Finish an upload and attach the file',
  description:
    'After every part is uploaded, creates the media item and, when productId is given, links it in one step. An upload that is never finalized expires after 15 minutes and its files are deleted.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    intentId: Id,
    productId: ProductIdArg.optional(),
    scope: ScopeArg.optional(),
    variantIds: IdList.optional(),
    role: RoleArg.optional(),
    altText: AltTextArg.optional(),
    primary: PrimaryArg.optional(),
  }),
  output: z.object({ media: MediaOut, links: z.array(LinkOut) }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.media.finalized' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/media/uploads/{intentId}/finalize' },
  mcp: { exception: UPLOAD_EXCEPTION },
  async handler(ctx, input) {
    const [intent] = await ctx.tx.query<{
      media_id: string;
      kind: MediaKind;
      file_name: string;
      content_type: MediaType;
      size_bytes: string;
      sha256: string;
      parts: Partial<Record<(typeof UPLOAD_PARTS)[number], UploadedPart>>;
      status: string;
      created_by: string;
      expired: boolean;
    }>(
      `select media_id, kind, file_name, content_type, size_bytes, sha256, parts, status,
         created_by, expires_at <= now() as expired
       from media_upload_intents where id = $1 for update`,
      [input.intentId],
    );
    if (!intent || intent.created_by !== callerKey(ctx.caller)) throw errors.notFound('Upload');
    checkIntentPending(intent);
    if (!input.productId && (input.scope || input.variantIds || input.role || input.primary)) {
      throw errors.validation([{ path: 'productId', message: 'Name the product to link to.' }]);
    }
    const needed = intent.kind === 'image' ? UPLOAD_PARTS : (['original'] as const);
    const missing = needed.filter((p) => !intent.parts[p]);
    if (missing.length > 0) {
      throw errors.unprocessable('upload_incomplete', 'Upload every part before finishing.', {
        missing,
      });
    }
    const original = intent.parts.original!;
    const derivatives =
      intent.kind === 'image'
        ? { thumbnail: intent.parts.thumbnail, display: intent.parts.display }
        : {};
    await ctx.tx.query(
      `insert into media_assets (shop_id, id, kind, file_name, content_type, size_bytes, sha256,
         width, height, derivatives, created_by)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        intent.media_id,
        intent.kind,
        intent.file_name,
        intent.content_type,
        intent.size_bytes,
        intent.sha256,
        original.width,
        original.height,
        JSON.stringify(derivatives),
        callerKey(ctx.caller),
      ],
    );
    await ctx.tx.query(
      `update media_upload_intents set status = 'finalized', finalized_at = now() where id = $1`,
      [input.intentId],
    );
    let links: LinkRow[] = [];
    if (input.productId) {
      const added = await addLinks(
        ctx,
        { id: intent.media_id, kind: intent.kind },
        { ...input, productId: input.productId },
      );
      links = added.created;
    }
    const [media] = await renderMedia(ctx, await loadMediaRows(ctx.tx, [intent.media_id]));
    return {
      result: { media: media!, links: links.map(linkOut) },
      audit: {
        targetType: 'media',
        targetId: intent.media_id,
        changes: {
          intentId: input.intentId,
          kind: intent.kind,
          fileName: intent.file_name,
          contentType: intent.content_type,
          size: Number(intent.size_bytes),
          sha256: intent.sha256,
          derivatives,
          links: links.map((l) => ({
            productId: l.product_id,
            variantId: l.variant_id,
            role: l.role,
            position: l.position,
            primary: l.is_primary,
          })),
        },
      },
    };
  },
});

// Reads ------------------------------------------------------------------------------------

export const listProductMedia = defineOperation({
  id: 'catalog.media.list',
  summary: 'List the pictures and attachments of a product and its variants',
  description:
    'Gives each link’s role, order, primary flag, and alt text, and each file once with signed thumbnail and display links valid for at least 15 minutes. A variant shows its own pictures first, then the product’s; without its own primary picture it shows the product’s.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ productId: ProductIdArg }),
  output: ProductMediaOut,
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.media.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/products/{productId}/media' },
  mcp: { tool: TOOL, action: 'list', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const { result, mediaIds } = await productMedia(ctx, input.productId);
    return {
      result,
      // One access event per request, naming the media it returned (Q1).
      audit: {
        targetType: 'product',
        targetId: input.productId,
        context: { input, mediaIds },
      },
    };
  },
});

const FoundMedia = MediaOut.extend({
  linkedProductIds: z.array(Id).describe('Products it is linked to (up to 50).'),
});

export const findMedia = defineOperation({
  id: 'catalog.media.find',
  summary: 'Find files in the shop’s media library',
  description:
    'Newest first. Filter by IDs, kind, file name, or files linked to no product. Use it to resolve the media IDs a file field holds.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    mediaIds: IdList.optional(),
    kind: z.enum(['image', 'document']).optional(),
    query: z.string().trim().min(1).max(200).optional().describe('Text in the file name.'),
    unlinked: BoolParam.optional().describe('Only files linked to no product.'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: Id.optional().describe('Cursor from the previous page.'),
  }),
  output: z.object({ media: z.array(FoundMedia), nextCursor: z.string().nullable() }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.media.found' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/media' },
  mcp: { tool: TOOL, action: 'find', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const ids = parseIds(input.mediaIds, 'mediaIds', 200);
    const unlinked = input.unlinked === true || input.unlinked === 'true';
    const rows = await ctx.tx.query<MediaRow & { linked_product_ids: string[] }>(
      `select ${MEDIA_COLUMNS},
         array(select distinct l.product_id from media_links l
           where l.shop_id = m.shop_id and l.media_id = m.id limit 50) as linked_product_ids
       from media_assets m
       where m.status = 'active'
         and ($1::uuid[] is null or m.id = any($1::uuid[]))
         and ($2::text is null or m.kind = $2)
         and ($3::text is null or m.file_name ilike '%' || $3 || '%')
         and (not $4 or not exists (select 1 from media_links l
           where l.shop_id = m.shop_id and l.media_id = m.id))
         and ($5::uuid is null or m.id < $5)
       order by m.id desc
       limit $6`,
      [
        ids.length ? ids : null,
        input.kind ?? null,
        input.query?.replace(/[\\%_]/g, (c) => `\\${c}`) ?? null,
        unlinked,
        input.after ?? null,
        input.limit + 1,
      ],
    );
    const page = rows.slice(0, input.limit);
    const rendered = await renderMedia(ctx, page);
    const media = rendered.map((m, i) => ({
      ...m,
      linkedProductIds: page[i]!.linked_product_ids,
    }));
    return {
      result: {
        media,
        nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
      },
      audit: {
        targetType: 'media',
        targetId: 'find',
        context: { input, mediaIds: media.map((m) => m.mediaId) },
      },
    };
  },
});

export const getPrimaryPictures = defineOperation({
  id: 'catalog.media.primary',
  summary: 'Get the primary picture of each product or variant',
  description:
    'For gallery cards and checks such as “which items have no primary picture”: give up to 200 product or variant IDs. A variant without its own primary picture shows its product’s.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ productIds: IdList.optional(), variantIds: IdList.optional() }),
  output: z.object({ pictures: z.array(PrimaryPictureOut) }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.media.primary_viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/media/primary' },
  mcp: { tool: TOOL, action: 'primary_pictures', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const productIds = parseIds(input.productIds, 'productIds', 200);
    const variantIds = parseIds(input.variantIds, 'variantIds', 200);
    if (productIds.length + variantIds.length > 200) {
      throw errors.validation([{ path: 'productIds', message: 'At most 200 IDs in all.' }]);
    }
    const { pictures, mediaIds } = await primaryPictures(ctx, { productIds, variantIds });
    return {
      result: { pictures },
      audit: {
        targetType: 'media',
        targetId: 'primary',
        context: { productIds, variantIds, mediaIds },
      },
    };
  },
});

export const downloadOriginal = defineOperation({
  id: 'catalog.media.download',
  summary: 'Get a download link for an original file',
  description:
    'Each call is recorded as a download of the original. The link is valid for at least 5 minutes and needs no other authentication, so share it only with the person who asked.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ mediaId: MediaIdArg }),
  output: z.object({
    mediaId: Id,
    fileName: z.string(),
    contentType: z.string(),
    size: z.number(),
    url: z.string(),
    expiresAt: z.string(),
  }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.media.original_downloaded' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/media/{mediaId}/original' },
  mcp: { tool: TOOL, action: 'download_original', readOnly: true, destructive: false },
  async handler(ctx, input) {
    if (!ctx.media) throw mediaUnavailable();
    const media = await activeMedia(ctx, input.mediaId);
    const link = await ctx.media.sign({
      shopId: ctx.shopId,
      mediaId: media.id,
      part: 'original',
      ttlSeconds: MEDIA_LIMITS.originalLinkSeconds,
    });
    return {
      result: {
        mediaId: media.id,
        fileName: media.file_name,
        contentType: media.content_type,
        size: Number(media.size_bytes),
        ...link,
      },
      audit: {
        targetType: 'media',
        targetId: media.id,
        context: { fileName: media.file_name, size: Number(media.size_bytes) },
      },
    };
  },
});

// Link changes -----------------------------------------------------------------------------

const LinksResult = z.object({
  links: z.array(LinkOut).describe('Every link of this media item on the product.'),
});

export const linkMedia = defineOperation({
  id: 'catalog.media.link',
  summary: 'Attach a file to a product, some of its variants, or both',
  description:
    'scope product (default) shows it for the product and every variant; variants or both need variantIds. The first image in a scope becomes its primary picture. Linking where a link already exists changes nothing; use update_link for role, alt text, and primary.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    mediaId: MediaIdArg,
    productId: ProductIdArg,
    scope: ScopeArg.optional(),
    variantIds: IdList.optional(),
    role: RoleArg.optional(),
    altText: AltTextArg.optional(),
    primary: PrimaryArg.optional(),
  }),
  output: LinksResult,
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.media.linked' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/media/{mediaId}/links' },
  mcp: { tool: TOOL, action: 'link', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const media = await activeMedia(ctx, input.mediaId);
    const { created } = await addLinks(ctx, { id: media.id, kind: media.kind }, input);
    const links = await linksOfMedia(ctx, media.id, input.productId);
    return {
      result: { links },
      audit: {
        targetType: 'media',
        targetId: media.id,
        outcome: created.length === 0 ? 'no_change' : 'succeeded',
        changes: {
          productId: input.productId,
          linked: created.map((l) => ({
            variantId: l.variant_id,
            role: l.role,
            position: l.position,
            primary: l.is_primary,
            altText: l.alt_text,
          })),
        },
      },
    };
  },
});

async function findLink(
  ctx: HandlerContext,
  mediaId: string,
  productId: string,
  variantId: string | null,
): Promise<LinkRow> {
  await lockProduct(ctx, productId);
  const [link] = await ctx.tx.query<LinkRow>(
    `select ${LINK_COLUMNS} from media_links l
     where l.media_id = $1 and l.product_id = $2 and l.variant_id is not distinct from $3`,
    [mediaId, productId, variantId],
  );
  if (!link) throw errors.notFound('Media link');
  return link;
}

export const updateMediaLink = defineOperation({
  id: 'catalog.media.links.update',
  summary: 'Change a file’s role, alt text, or primary flag on a product or variant',
  description:
    'Leave out variantId for the product itself. primary true makes it the scope’s only primary picture; false leaves the scope without one.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    mediaId: MediaIdArg,
    productId: ProductIdArg,
    variantId: VariantIdArg.optional(),
    role: RoleArg.optional(),
    altText: AltTextArg.optional(),
    primary: PrimaryArg.optional(),
  }),
  output: z.object({ link: LinkOut }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.media.link_updated' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/media/{mediaId}/links/update' },
  mcp: { tool: TOOL, action: 'update_link', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const variantId = input.variantId ?? null;
    const media = await activeMedia(ctx, input.mediaId);
    const link = await findLink(ctx, media.id, input.productId, variantId);
    if (input.primary && media.kind !== 'image') {
      throw errors.validation([{ path: 'primary', message: 'Only images can be primary.' }]);
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const role = input.role === undefined ? link.role : roleFor(input.role, media.kind, false);
    if (role !== link.role) changes.role = { from: link.role, to: role };
    const altText = input.altText === undefined ? link.alt_text : input.altText || null;
    if (altText !== link.alt_text) changes.altText = { from: link.alt_text, to: altText };
    const primary = input.primary ?? link.is_primary;
    if (primary !== link.is_primary) changes.primary = { from: link.is_primary, to: primary };
    if (Object.keys(changes).length > 0) {
      if (changes.primary && primary) {
        await ctx.tx.query(
          `update media_links set is_primary = false, updated_at = now()
           where product_id = $1 and variant_id is not distinct from $2 and is_primary`,
          [input.productId, variantId],
        );
      }
      await ctx.tx.query(
        `update media_links set role = $2, alt_text = $3, is_primary = $4, updated_at = now()
         where id = $1`,
        [link.id, role, altText, primary],
      );
    }
    return {
      result: {
        link: linkOut({ ...link, role, alt_text: altText, is_primary: primary }),
      },
      audit: {
        targetType: 'media',
        targetId: media.id,
        outcome: Object.keys(changes).length === 0 ? 'no_change' : 'succeeded',
        changes: { productId: input.productId, variantId, fields: changes },
      },
    };
  },
});

export const reorderMedia = defineOperation({
  id: 'catalog.media.reorder',
  summary: 'Set the order of the files on a product or variant',
  description:
    'order lists every media ID linked to that scope, first to last. Leave out variantId for the product itself.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    productId: ProductIdArg,
    variantId: VariantIdArg.optional(),
    order: z.array(Id).min(1).max(MEDIA_LIMITS.mediaPerProduct),
  }),
  output: z.object({ links: z.array(LinkOut) }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.media.reordered' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/products/{productId}/media/order' },
  mcp: { tool: TOOL, action: 'reorder', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const variantId = input.variantId ?? null;
    await lockProduct(ctx, input.productId);
    const current = await ctx.tx.query<LinkRow>(
      `select ${LINK_COLUMNS} from media_links l
       where l.product_id = $1 and l.variant_id is not distinct from $2 order by l.position, l.id`,
      [input.productId, variantId],
    );
    const from = current.map((l) => l.media_id);
    const same =
      input.order.length === from.length &&
      new Set(input.order).size === from.length &&
      input.order.every((id) => from.includes(id));
    if (!same) {
      throw errors.validation([
        { path: 'order', message: 'List each media ID linked here exactly once.' },
      ]);
    }
    const changed = input.order.some((id, i) => from[i] !== id);
    if (changed) {
      await ctx.tx.query(
        `update media_links l set position = x.ord - 1, updated_at = now()
         from unnest($3::uuid[]) with ordinality as x(media_id, ord)
         where l.product_id = $1 and l.variant_id is not distinct from $2 and l.media_id = x.media_id`,
        [input.productId, variantId, input.order],
      );
    }
    const byMedia = new Map(current.map((l) => [l.media_id, l]));
    const links = input.order.map((id, i) => linkOut({ ...byMedia.get(id)!, position: i }));
    return {
      result: { links },
      audit: {
        targetType: input.variantId ? 'variant' : 'product',
        targetId: input.variantId ?? input.productId,
        outcome: changed ? 'succeeded' : 'no_change',
        changes: { productId: input.productId, variantId, order: { from, to: input.order } },
      },
    };
  },
});

export const unlinkMedia = defineOperation({
  id: 'catalog.media.unlink',
  summary: 'Remove a file from a product or some of its variants',
  description:
    'scope both (default) removes it from the product and every variant, or the listed ones; variants only from variants (all when none are listed); product only from the product itself. The file stays in the shop’s media library. If a primary picture is removed, the next image in that scope becomes primary.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    mediaId: MediaIdArg,
    productId: ProductIdArg,
    scope: ScopeArg.optional(),
    variantIds: IdList.optional(),
  }),
  output: LinksResult,
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.media.unlinked' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/media/{mediaId}/links/remove' },
  mcp: { tool: TOOL, action: 'remove', readOnly: false, destructive: true },
  async handler(ctx, input) {
    const scope = input.scope ?? 'both';
    const variantIds = parseIds(input.variantIds, 'variantIds', 2048);
    await lockProduct(ctx, input.productId);
    await productVariants(ctx, input.productId, variantIds);
    const removed = await ctx.tx.query<LinkRow>(
      `delete from media_links l
       where l.media_id = $1 and l.product_id = $2
         and (($3 and l.variant_id is null)
           or ($4 and l.variant_id is not null and ($5::uuid[] is null or l.variant_id = any($5::uuid[]))))
       returning ${LINK_COLUMNS}`,
      [
        input.mediaId,
        input.productId,
        scope !== 'variants',
        scope !== 'product',
        variantIds.length ? variantIds : null,
      ],
    );
    for (const l of removed.filter((r) => r.is_primary)) {
      await promoteNextPrimary(ctx, input.productId, l.variant_id);
    }
    const links = await linksOfMedia(ctx, input.mediaId, input.productId);
    return {
      result: { links },
      audit: {
        targetType: 'media',
        targetId: input.mediaId,
        outcome: removed.length === 0 ? 'no_change' : 'succeeded',
        changes: {
          productId: input.productId,
          removed: removed.map((l) => ({
            variantId: l.variant_id,
            role: l.role,
            primary: l.is_primary,
          })),
        },
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const mediaOperations = [
  createUpload,
  finalizeUpload,
  listProductMedia,
  findMedia,
  getPrimaryPictures,
  downloadOriginal,
  linkMedia,
  updateMediaLink,
  reorderMedia,
  unlinkMedia,
] as const;
