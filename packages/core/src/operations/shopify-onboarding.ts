import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { errors } from '../errors.ts';
import { sha256Hex } from '../hash.ts';
import { effectivePermissions } from '../permissions.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id, iso } from '../schemas.ts';
import type { CatalogImage } from '../shopify/catalog.ts';
import { commitImport, storeCaller } from './imports.ts';
import { applyVariantMaps, lockActiveConnection } from './shopify-mapping.ts';

// The onboarding import (plan Section 5.14, D17). A job reads the store with a bulk operation,
// matches its variants by SKU and barcode, and writes the new ones as a CSV import (ADR 0018) that
// a person previews and commits here; the import's job writes the records and the opening
// receipts in chunks, with checkpoints and per-row outcomes. When it completes, the job maps every
// matched and created variant and references the Shopify pictures of new products by URL.

/** Outbox topic that runs the next step of an onboarding (packages/shopify, onboarding.ts). */
export const ONBOARDING_RUN_TOPIC = 'shopify.onboarding.run';

const IMPORT_HINT =
  'Starting an onboarding import needs a person to review the preview, so it is done in the dashboard.';

const OnboardingRowOut = z.object({
  shopifyVariantId: z.string(),
  shopifyProductId: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  title: z.string(),
  match: z.enum(['sku', 'barcode', 'new', 'skipped']),
  variantId: Id.nullable(),
  packId: Id.nullable(),
  importSku: z.string().nullable(),
  importRow: z.number().nullable(),
  mapped: z.boolean(),
  note: z.string().nullable(),
});

const OnboardingOut = z.object({
  onboardingId: Id,
  connectionId: Id,
  status: z.enum([
    'reading',
    'matching',
    'previewed',
    'committing',
    'finishing',
    'completed',
    'failed',
    'cancelled',
  ]),
  importId: Id.nullable(),
  counts: z.record(z.string(), z.number()),
  unmappedLocations: z.array(z.object({ id: z.string(), name: z.string() })),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

interface OnboardingRow {
  id: string;
  connection_id: string;
  status: z.infer<typeof OnboardingOut>['status'];
  import_id: string | null;
  counts: Record<string, number>;
  unmapped_locations: Array<{ id: string; name: string }>;
  error: string | null;
  created_at: Date;
  completed_at: Date | null;
}

const COLUMNS =
  'id, connection_id, status, import_id, counts, unmapped_locations, error, created_at, completed_at';

function onboardingOut(r: OnboardingRow): z.infer<typeof OnboardingOut> {
  return {
    onboardingId: r.id,
    connectionId: r.connection_id,
    status: r.status,
    importId: r.import_id,
    counts: r.counts,
    unmappedLocations: r.unmapped_locations,
    error: r.error,
    createdAt: iso(r.created_at) as string,
    completedAt: iso(r.completed_at),
  };
}

async function loadOnboarding(tx: Tx, id: string, lock = false): Promise<OnboardingRow> {
  const [row] = await tx.query<OnboardingRow>(
    `select ${COLUMNS} from shopify_onboardings where id = $1${lock ? ' for update' : ''}`,
    [id],
  );
  if (!row) throw errors.notFound('Onboarding import');
  return row;
}

function requireImportAccess(ctx: HandlerContext): void {
  const permissions = ctx.membership ? effectivePermissions(ctx.membership) : new Set();
  if (!permissions.has('imports.run') || !permissions.has('catalog.write')) {
    throw errors.forbidden('Requires the imports.run and catalog.write permissions.');
  }
}

export const startShopifyOnboarding = defineOperation({
  id: 'shopify.onboarding.start',
  summary: 'Read a connected store’s catalog for the onboarding import',
  description:
    'Starts reading the store’s products, variants, SKUs, barcodes, prices, pictures, and quantities with a Shopify bulk operation. When it is read, every Shopify variant is matched by SKU, then barcode, and the new ones become an import preview to review and commit. Quantities at mapped Shopify locations arrive as opening stock; map the locations first. One run at a time per store.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ connectionId: Id }),
  output: z.object({ onboarding: OnboardingOut }),
  permission: 'connections.manage',
  connectionScope: 'session',
  audit: { action: 'shopify.onboarding.started' },
  idempotency: 'required',
  http: {
    method: 'POST',
    path: '/shops/{shopId}/shopify/connections/{connectionId}/onboardings',
    status: 201,
  },
  mcp: { exception: IMPORT_HINT },
  async handler(ctx, input) {
    requireImportAccess(ctx);
    await lockActiveConnection(ctx.tx, input.connectionId);
    const id = ctx.newId();
    try {
      await ctx.tx.query(
        `insert into shopify_onboardings (shop_id, id, connection_id, caller)
         values (app_shop_id(), $1, $2, $3)`,
        [id, input.connectionId, JSON.stringify(storeCaller(ctx.caller))],
      );
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'shopify_onboardings_open_idx') {
        throw errors.conflict(
          'onboarding_running',
          'An onboarding import of this store is already running. Finish or cancel it first.',
        );
      }
      throw error;
    }
    return {
      result: { onboarding: onboardingOut(await loadOnboarding(ctx.tx, id)) },
      audit: {
        targetType: 'shopify_onboarding',
        targetId: id,
        changes: { connectionId: input.connectionId },
      },
      outbox: [{ topic: ONBOARDING_RUN_TOPIC, payload: { onboardingId: id } }],
    };
  },
});

export const getShopifyOnboarding = defineOperation({
  id: 'shopify.onboarding.get',
  summary: 'Get an onboarding import with its matches',
  description:
    'Shows an onboarding import’s status and totals, the Shopify locations whose quantities are not imported because they are not mapped, and each Shopify variant: matched by SKU or barcode, new, or skipped (with why). Filter by match; at most 500 rows.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    onboardingId: Id,
    match: z.enum(['sku', 'barcode', 'new', 'skipped']).optional(),
  }),
  output: z.object({ onboarding: OnboardingOut, rows: z.array(OnboardingRowOut) }),
  permission: 'shop.read',
  connectionScope: 'shop:read',
  audit: { action: 'shopify.onboarding.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/shopify/onboardings/{onboardingId}' },
  mcp: { exception: IMPORT_HINT },
  async handler(ctx, input) {
    const onboarding = await loadOnboarding(ctx.tx, input.onboardingId);
    const rows = await ctx.tx.query<z.infer<typeof OnboardingRowOut>>(
      `select shopify_variant_id as "shopifyVariantId", shopify_product_id as "shopifyProductId",
         sku, barcode, title, match, variant_id as "variantId", pack_id as "packId",
         import_sku as "importSku", import_row as "importRow", mapped, note
       from shopify_onboarding_rows where onboarding_id = $1 and ($2::text is null or match = $2)
       order by case match when 'skipped' then 0 when 'new' then 1 else 2 end, title, shopify_variant_id
       limit 500`,
      [input.onboardingId, input.match ?? null],
    );
    return {
      result: { onboarding: onboardingOut(onboarding), rows },
      audit: { targetType: 'shopify_onboarding', targetId: input.onboardingId },
    };
  },
});

export const listShopifyOnboardings = defineOperation({
  id: 'shopify.onboarding.list',
  summary: 'List onboarding imports',
  description: 'The latest 20 onboarding imports of the shop’s connected stores, newest first.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ connectionId: Id.optional() }),
  output: z.object({ onboardings: z.array(OnboardingOut) }),
  permission: 'shop.read',
  connectionScope: 'shop:read',
  audit: { action: 'shopify.onboarding.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/shopify/onboardings' },
  mcp: { exception: IMPORT_HINT },
  async handler(ctx, input) {
    const rows = await ctx.tx.query<OnboardingRow>(
      `select ${COLUMNS} from shopify_onboardings
       where ($1::uuid is null or connection_id = $1) order by created_at desc limit 20`,
      [input.connectionId ?? null],
    );
    return {
      result: { onboardings: rows.map(onboardingOut) },
      audit: { targetType: 'shopify_onboarding', targetId: 'list' },
    };
  },
});

export const commitShopifyOnboarding = defineOperation({
  id: 'shopify.onboarding.commit',
  summary: 'Commit a previewed onboarding import',
  description:
    'Writes the new products of the preview through the import job (rows with errors are skipped), with Shopify’s quantities at mapped locations as opening stock, then maps every matched and new variant to its Shopify variant and references the Shopify pictures of new products. Matched variants keep their data and stock.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ onboardingId: Id }),
  output: z.object({ onboarding: OnboardingOut }),
  permission: 'connections.manage',
  connectionScope: 'session',
  audit: { action: 'shopify.onboarding.committed' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/shopify/onboardings/{onboardingId}/commit' },
  mcp: { exception: IMPORT_HINT },
  async handler(ctx, input) {
    requireImportAccess(ctx);
    const onboarding = await loadOnboarding(ctx.tx, input.onboardingId, true);
    if (onboarding.status !== 'previewed') {
      throw errors.conflict(
        'onboarding_not_previewed',
        'Wait until the store has been read and matched, then commit.',
      );
    }
    await lockActiveConnection(ctx.tx, onboarding.connection_id);
    const outbox: Array<{ topic: string; payload: unknown }> = [];
    if (onboarding.import_id) {
      const committed = await commitImport.handler(ctx, { importId: onboarding.import_id });
      outbox.push(...(committed.outbox ?? []));
    }
    await ctx.tx.query(
      `update shopify_onboardings set status = $2, caller = $3, updated_at = now(),
         version = version + 1 where id = $1`,
      [
        input.onboardingId,
        onboarding.import_id ? 'committing' : 'finishing',
        JSON.stringify(storeCaller(ctx.caller)),
      ],
    );
    outbox.push({ topic: ONBOARDING_RUN_TOPIC, payload: { onboardingId: input.onboardingId } });
    return {
      result: { onboarding: onboardingOut(await loadOnboarding(ctx.tx, input.onboardingId)) },
      audit: {
        targetType: 'shopify_onboarding',
        targetId: input.onboardingId,
        changes: { importId: onboarding.import_id, counts: onboarding.counts },
      },
      outbox,
    };
  },
});

export const cancelShopifyOnboarding = defineOperation({
  id: 'shopify.onboarding.cancel',
  summary: 'Cancel an onboarding import before it is committed',
  description:
    'Stops an onboarding import that has not been committed. Nothing was written to the catalog yet.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ onboardingId: Id }),
  output: z.object({ onboarding: OnboardingOut }),
  permission: 'connections.manage',
  connectionScope: 'session',
  audit: { action: 'shopify.onboarding.cancelled' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/shopify/onboardings/{onboardingId}/cancel' },
  mcp: { exception: IMPORT_HINT },
  async handler(ctx, input) {
    const onboarding = await loadOnboarding(ctx.tx, input.onboardingId, true);
    if (!['reading', 'matching', 'previewed'].includes(onboarding.status)) {
      throw errors.conflict(
        'onboarding_committed',
        'This onboarding import was already committed or has ended.',
      );
    }
    await ctx.tx.query(
      `update shopify_onboardings set status = 'cancelled', updated_at = now(), completed_at = now(),
         version = version + 1 where id = $1`,
      [input.onboardingId],
    );
    if (onboarding.import_id) {
      await ctx.tx.query(
        `update import_jobs set status = 'cancelled', updated_at = now(), version = version + 1
         where id = $1 and status in ('uploading', 'uploaded', 'previewed')`,
        [onboarding.import_id],
      );
    }
    return {
      result: { onboarding: onboardingOut(await loadOnboarding(ctx.tx, input.onboardingId)) },
      audit: { targetType: 'shopify_onboarding', targetId: input.onboardingId },
    };
  },
});

// Finishing: maps and pictures ------------------------------------------------------------------

const FINISH_CHUNK = 200;

function pictureType(url: string): string {
  const path = url.split('?')[0]!.toLowerCase();
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.avif')) return 'image/avif';
  return 'image/jpeg';
}

interface Picture extends CatalogImage {
  variantLevel: boolean;
}

/**
 * Pictures of products the import created, referenced by their Shopify URL (D17): one media
 * record per URL, linked to the product (or to the variant, for a variant's own picture). A
 * product that already has pictures keeps them.
 */
async function referencePictures(
  ctx: HandlerContext,
  items: Array<{ productId: string; variantId: string; pictures: Picture[] }>,
): Promise<number> {
  const urls = new Map<string, Picture>();
  for (const item of items) for (const p of item.pictures) urls.set(p.url, p);
  if (urls.size === 0) return 0;
  const assets = await Promise.all(
    [...urls.values()].map(async (p) => ({
      id: ctx.newId(),
      url: p.url,
      sha256: await sha256Hex(p.url),
      fileName: (p.url.split('?')[0]!.split('/').pop() || 'picture').slice(0, 255),
      contentType: pictureType(p.url),
      width: p.width,
      height: p.height,
    })),
  );
  await ctx.tx.query(
    `insert into media_assets (shop_id, id, kind, file_name, content_type, sha256, width, height,
       created_by, external_url)
     select app_shop_id(), x.id, 'image', x."fileName", x."contentType", x.sha256, x.width, x.height,
       $2, x.url
     from jsonb_to_recordset($1::jsonb) as x(id uuid, url text, sha256 text, "fileName" text,
       "contentType" text, width int, height int)
     on conflict (shop_id, sha256) where external_url is not null do nothing`,
    [JSON.stringify(assets), `${ctx.caller.kind}:${ctx.caller.id}`],
  );
  const links = items.flatMap((item) =>
    item.pictures.map((p, i) => ({
      id: ctx.newId(),
      sha256: assets.find((a) => a.url === p.url)!.sha256,
      productId: item.productId,
      variantId: p.variantLevel ? item.variantId : null,
      role: i === 0 && !p.variantLevel ? 'primary' : 'detail',
      position: i,
      primary: i === 0,
      alt: p.alt?.slice(0, 1000) ?? null,
    })),
  );
  const made = await ctx.tx.query(
    `with x as (
       select * from jsonb_to_recordset($1::jsonb) as x(id uuid, sha256 text, "productId" uuid,
         "variantId" uuid, role text, position int, "primary" boolean, alt text)),
     ready as (
       select x.*, m.id as media_id from x
       join media_assets m on m.shop_id = app_shop_id() and m.sha256 = x.sha256
         and m.external_url is not null)
     insert into media_links (shop_id, id, media_id, product_id, variant_id, role, position,
       is_primary, alt_text)
     select app_shop_id(), r.id, r.media_id, r."productId", r."variantId", r.role, r.position,
       r."primary" and not exists (select 1 from media_links l where l.shop_id = app_shop_id()
         and l.product_id = r."productId"
         and coalesce(l.variant_id, l.product_id) = coalesce(r."variantId", r."productId")
         and l.is_primary),
       r.alt
     from ready r
     on conflict do nothing
     returning id`,
    [JSON.stringify(links)],
  );
  return made.length;
}

export const finishShopifyOnboarding = defineOperation({
  id: 'shopify.onboarding.finish',
  summary: 'Map the variants of a committed onboarding import, a chunk at a time',
  kind: 'command',
  scope: 'shop',
  input: z.object({ onboardingId: Id }),
  output: z.object({ remaining: z.number().int(), mapped: z.number().int() }),
  permission: 'connections.manage',
  connectionScope: 'session',
  audit: { action: 'shopify.onboarding.finished_chunk' },
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/shopify/onboardings/{onboardingId}/finish' },
  mcp: { exception: 'Integration callback: runs only from the onboarding job.' },
  async handler(ctx, input) {
    const onboarding = await loadOnboarding(ctx.tx, input.onboardingId, true);
    if (onboarding.status !== 'finishing') {
      return {
        result: { remaining: 0, mapped: 0 },
        audit: {
          targetType: 'shopify_onboarding',
          targetId: input.onboardingId,
          outcome: 'no_change',
        },
      };
    }
    await lockActiveConnection(ctx.tx, onboarding.connection_id);
    const rows = await ctx.tx.query<{
      shopify_variant_id: string;
      shopify_product_id: string;
      shopify_inventory_item_id: string | null;
      sku: string | null;
      title: string;
      match: 'sku' | 'barcode' | 'new' | 'skipped';
      variant_id: string | null;
      pack_id: string | null;
      import_row: number | null;
      pictures: Picture[];
      tracked: boolean;
      imported_variant_id: string | null;
      import_status: string | null;
      import_errors: string[] | null;
      product_id: string | null;
    }>(
      `select r.shopify_variant_id, r.shopify_product_id, r.shopify_inventory_item_id, r.sku, r.title,
         r.match, r.variant_id, r.pack_id, r.import_row, r.pictures, r.tracked,
         i.variant_id as imported_variant_id, i.status as import_status, i.errors as import_errors,
         v.product_id
       from shopify_onboarding_rows r
       left join import_rows i on i.shop_id = r.shop_id and i.import_id = $2 and i.row_number = r.import_row
       left join variants v on v.shop_id = r.shop_id and v.id = coalesce(r.variant_id, i.variant_id)
       where r.onboarding_id = $1 and not r.mapped and r.match <> 'skipped'
       order by r.shopify_variant_id
       limit ${FINISH_CHUNK}
       for update of r`,
      [input.onboardingId, onboarding.import_id],
    );
    const maps = rows.flatMap((r) => {
      const variantId = r.variant_id ?? r.imported_variant_id;
      if (!variantId || !r.shopify_inventory_item_id || !r.tracked) return [];
      return [
        {
          shopifyVariantId: r.shopify_variant_id,
          shopifyInventoryItemId: r.shopify_inventory_item_id,
          shopifyProductId: r.shopify_product_id,
          sku: r.sku,
          title: r.title,
          variantId,
          packId: r.pack_id,
          source: r.match === 'sku' || r.match === 'barcode' ? r.match : ('onboarding' as const),
        },
      ];
    });
    // A Shopify variant already mapped by a person keeps that map.
    const kept = new Set(
      (
        await ctx.tx.query<{ shopify_variant_id: string }>(
          `select shopify_variant_id from shopify_variant_maps
           where connection_id = $1 and shopify_variant_id = any($2::text[]) and source = 'manual'`,
          [onboarding.connection_id, maps.map((m) => m.shopifyVariantId)],
        )
      ).map((r) => r.shopify_variant_id),
    );
    const toMap = maps.filter((m) => !kept.has(m.shopifyVariantId));
    const applied =
      toMap.length > 0
        ? await applyVariantMaps(ctx, onboarding.connection_id, toMap)
        : { set: 0, removed: 0, items: [] as string[] };
    const pictures = await referencePictures(
      ctx,
      rows.flatMap((r) =>
        r.match === 'new' && r.imported_variant_id && r.product_id && r.pictures.length > 0
          ? [{ productId: r.product_id, variantId: r.imported_variant_id, pictures: r.pictures }]
          : [],
      ),
    );
    const notes = rows.flatMap((r) =>
      r.match === 'new' && !r.imported_variant_id
        ? [
            {
              id: r.shopify_variant_id,
              note: `Not imported: ${(r.import_errors ?? []).join('; ') || r.import_status || 'no import row'}`,
            },
          ]
        : [],
    );
    await ctx.tx.query(
      `update shopify_onboarding_rows r set mapped = true,
         variant_id = coalesce(r.variant_id, x."variantId"),
         note = coalesce(x.note, r.note)
       from jsonb_to_recordset($2::jsonb) as x(id text, "variantId" uuid, note text)
       where r.onboarding_id = $1 and r.shopify_variant_id = x.id`,
      [
        input.onboardingId,
        JSON.stringify(
          rows.map((r) => ({
            id: r.shopify_variant_id,
            variantId: r.imported_variant_id,
            note: notes.find((n) => n.id === r.shopify_variant_id)?.note ?? null,
          })),
        ),
      ],
    );
    const [left] = await ctx.tx.query<{ count: number }>(
      `select count(*)::int as count from shopify_onboarding_rows
       where onboarding_id = $1 and not mapped and match <> 'skipped'`,
      [input.onboardingId],
    );
    const remaining = left?.count ?? 0;
    await ctx.tx.query(
      `update shopify_onboardings set
         counts = counts || jsonb_build_object('mapped', coalesce((counts->>'mapped')::int, 0) + $2::int,
           'pictures', coalesce((counts->>'pictures')::int, 0) + $3::int,
           'notImported', coalesce((counts->>'notImported')::int, 0) + $4::int),
         status = case when $5::int = 0 then 'completed' else status end,
         completed_at = case when $5::int = 0 then now() else completed_at end,
         updated_at = now(), version = version + 1
       where id = $1`,
      [input.onboardingId, applied.set, pictures, notes.length, remaining],
    );
    return {
      result: { remaining, mapped: applied.set },
      audit: {
        targetType: 'shopify_onboarding',
        targetId: input.onboardingId,
        changes: { mapped: applied.set, pictures, notImported: notes.length, remaining },
      },
      outbox:
        applied.items.length > 0
          ? [
              {
                topic: 'shopify.levels.push',
                payload: {
                  connectionId: onboarding.connection_id,
                  inventoryItemIds: applied.items,
                },
              },
            ]
          : [],
    };
  },
});

export const shopifyOnboardingOperations = [
  startShopifyOnboarding,
  getShopifyOnboarding,
  listShopifyOnboardings,
  commitShopifyOnboarding,
  cancelShopifyOnboarding,
] as const;

/** Run only by the onboarding job; no REST route or MCP tool. */
export const shopifyOnboardingCallbacks = [finishShopifyOnboarding] as const;
