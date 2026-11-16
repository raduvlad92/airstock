import {
  type CatalogProduct,
  execute,
  importFileKey,
  jobCaller,
  matchCatalog,
  onboardingCsv,
  ops,
  type StoredCaller,
} from '@airstock/core';
import { ShopifyApiError } from './admin.ts';
import { connectedStore, NotConnectedError, runJob, type SyncDeps } from './sync.ts';

// The onboarding job (plan Section 5.14, D17). Each run takes the onboarding one step further and
// says when to run again; every step is safe to repeat, so a lost message or a crash resumes
// from the stored state (the cron sweep re-sends stale runs):
//
//   reading    start the bulk read once (its ID is kept), poll it, store the catalog in R2
//   matching   match by SKU and barcode, write the CSV import and preview it as the member
//   previewed  waits for the member to commit (shopify.onboarding.commit)
//   committing waits for the import job to complete
//   finishing  maps variants and references pictures, 200 rows per transaction; orders placed
//              since the catalog read are applied again for the newly mapped variants

export type OnboardingStep = { status: 'done' } | { status: 'again'; delaySeconds: number };

interface OnboardingState {
  connection_id: string;
  status: string;
  caller: StoredCaller;
  bulk_operation_id: string | null;
  file_key: string | null;
  import_id: string | null;
  import_status: string | null;
  import_error: string | null;
}

const catalogKey = (shopId: string, onboardingId: string) =>
  `shops/${shopId}/shopify/onboardings/${onboardingId}/catalog.json`;

async function setState(
  deps: SyncDeps,
  shopId: string,
  id: string,
  from: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const names = Object.keys(fields);
  await deps.db.transaction({ shopId, userId: null }, (tx) =>
    tx.query(
      `update shopify_onboardings set ${names.map((n, i) => `${n} = $${i + 3}`).join(', ')},
         updated_at = now(), version = version + 1
       where id = $1 and status = $2`,
      [id, from, ...names.map((n) => fields[n])],
    ),
  );
}

async function fail(deps: SyncDeps, shopId: string, id: string, from: string, error: string) {
  await setState(deps, shopId, id, from, {
    status: 'failed',
    error: error.slice(0, 1000),
    completed_at: new Date().toISOString(),
  });
}

export async function runOnboarding(
  deps: SyncDeps,
  shopId: string,
  onboardingId: string,
): Promise<OnboardingStep> {
  const [state] = await deps.db.transaction({ shopId, userId: null }, (tx) =>
    tx.query<OnboardingState>(
      `update shopify_onboardings o set updated_at = now()
       where o.id = $1
       returning o.connection_id, o.status, o.caller, o.bulk_operation_id, o.file_key, o.import_id,
         (select i.status from import_jobs i where i.shop_id = o.shop_id and i.id = o.import_id) as import_status,
         (select i.error from import_jobs i where i.shop_id = o.shop_id and i.id = o.import_id) as import_error`,
      [onboardingId],
    ),
  );
  if (!state) return { status: 'done' };
  try {
    switch (state.status) {
      case 'reading':
        return await read(deps, shopId, onboardingId, state);
      case 'matching':
        return await match(deps, shopId, onboardingId, state);
      case 'committing':
        if (state.import_status === 'completed') {
          await setState(deps, shopId, onboardingId, 'committing', { status: 'finishing' });
          return finish(deps, shopId, onboardingId, state);
        }
        if (state.import_status === 'failed' || state.import_status === 'cancelled') {
          await fail(
            deps,
            shopId,
            onboardingId,
            'committing',
            `The import stopped: ${state.import_error ?? state.import_status}.`,
          );
          return { status: 'done' };
        }
        return { status: 'again', delaySeconds: 15 };
      case 'finishing':
        return await finish(deps, shopId, onboardingId, state);
      default:
        return { status: 'done' };
    }
  } catch (error) {
    if (error instanceof NotConnectedError) {
      await fail(deps, shopId, onboardingId, state.status, 'The store is no longer connected.');
      return { status: 'done' };
    }
    if (error instanceof ShopifyApiError && !error.retryable) {
      await fail(deps, shopId, onboardingId, state.status, error.message);
      return { status: 'done' };
    }
    deps.logger?.error('shopify_onboarding_step_failed', {
      onboardingId,
      status: state.status,
      error: String(error),
    });
    return { status: 'again', delaySeconds: 60 };
  }
}

async function read(
  deps: SyncDeps,
  shopId: string,
  id: string,
  state: OnboardingState,
): Promise<OnboardingStep> {
  if (!deps.files) throw new Error('File storage is not available.');
  const store = await connectedStore(deps, shopId, state.connection_id);
  if (!state.bulk_operation_id) {
    const operationId = await store.admin.startCatalogRead();
    await setState(deps, shopId, id, 'reading', { bulk_operation_id: operationId });
    return { status: 'again', delaySeconds: 5 };
  }
  const op = await store.admin.bulkOperation(state.bulk_operation_id);
  if (op.status === 'running') return { status: 'again', delaySeconds: 10 };
  if (op.status === 'failed') {
    await fail(deps, shopId, id, 'reading', `Shopify could not read the catalog: ${op.error}.`);
    return { status: 'done' };
  }
  // A store without products completes without a result file.
  const products = op.url ? await store.admin.fetchCatalog(op.url) : [];
  const key = catalogKey(shopId, id);
  await deps.files.put(key, JSON.stringify(products), 'application/json');
  await deps.db.transaction({ shopId, userId: null }, async (tx) => {
    const variants = products.flatMap((p) =>
      p.variants.map((v) => ({
        id: v.variantId,
        productId: p.productId,
        item: v.inventoryItemId,
        sku: v.sku?.slice(0, 255) || null,
        barcode: v.barcode?.slice(0, 255) || null,
        title: (v.title && v.title !== 'Default Title' ? `${p.title} / ${v.title}` : p.title).slice(
          0,
          1000,
        ),
        tracked: v.tracked,
      })),
    );
    // The store's catalog as seen now: unmapped variants are listed from here.
    for (let i = 0; i < variants.length; i += 1000) {
      await tx.query(
        `insert into shopify_catalog_variants (shop_id, connection_id, shopify_variant_id,
           shopify_product_id, shopify_inventory_item_id, sku, barcode, title, tracked)
         select app_shop_id(), $1, x.id, x."productId", x.item, x.sku, x.barcode, x.title, x.tracked
         from jsonb_to_recordset($2::jsonb) as x(id text, "productId" text, item text, sku text,
           barcode text, title text, tracked boolean)
         on conflict (shop_id, connection_id, shopify_variant_id) do update set
           shopify_product_id = excluded.shopify_product_id,
           shopify_inventory_item_id = excluded.shopify_inventory_item_id, sku = excluded.sku,
           barcode = excluded.barcode, title = excluded.title, tracked = excluded.tracked,
           seen_at = now()`,
        [state.connection_id, JSON.stringify(variants.slice(i, i + 1000))],
      );
    }
    await tx.query(
      `update shopify_onboardings set status = 'matching', file_key = $2,
         counts = jsonb_build_object('products', $3::int, 'variants', $4::int),
         updated_at = now(), version = version + 1
       where id = $1 and status = 'reading'`,
      [id, key, products.length, variants.length],
    );
  });
  return match(deps, shopId, id, { ...state, status: 'matching', file_key: key });
}

async function match(
  deps: SyncDeps,
  shopId: string,
  id: string,
  state: OnboardingState,
): Promise<OnboardingStep> {
  if (!deps.files || !state.file_key) throw new Error('File storage is not available.');
  const text = await deps.files.get(state.file_key);
  if (text === null) {
    await fail(deps, shopId, id, 'matching', 'The catalog read was lost; start again.');
    return { status: 'done' };
  }
  const products = JSON.parse(text) as CatalogProduct[];
  const store = await connectedStore(deps, shopId, state.connection_id);
  const caller = await jobCaller(deps.db, shopId, state.caller, 'shopify');
  const prepared = await deps.db.transaction(
    { shopId, userId: null, readOnly: true },
    async (tx) => {
      const maps = await tx.query<{
        shopify_variant_id: string;
        variant_id: string;
        pack_id: string | null;
      }>(
        'select shopify_variant_id, variant_id, pack_id from shopify_variant_maps where connection_id = $1',
        [state.connection_id],
      );
      const matched = await matchCatalog(
        tx,
        products,
        new Map(
          maps.map((m) => [m.shopify_variant_id, { variantId: m.variant_id, packId: m.pack_id }]),
        ),
      );
      const locations = await tx.query<{
        shopify_location_id: string;
        receive_location_id: string | null;
      }>(
        'select shopify_location_id, receive_location_id from shopify_location_maps where connection_id = $1',
        [state.connection_id],
      );
      const [connection] = await tx.query<{
        shopify_locations: Array<{ id: string; name: string; active: boolean }>;
      }>('select shopify_locations from shopify_connections where id = $1', [state.connection_id]);
      return { matched, locations, known: connection?.shopify_locations ?? [] };
    },
  );
  const receiveAt = new Map(
    prepared.locations.flatMap((l) =>
      l.receive_location_id ? [[l.shopify_location_id, l.receive_location_id] as const] : [],
    ),
  );
  const mapped = new Set(prepared.locations.map((l) => l.shopify_location_id));
  const withStock = new Set(
    products.flatMap((p) => p.variants.flatMap((v) => v.levels.map((l) => l.locationId))),
  );
  const unmappedLocations = [...withStock]
    .filter((l) => !mapped.has(l))
    .map((l) => ({ id: l, name: prepared.known.find((k) => k.id === l)?.name ?? l }));
  const csv = onboardingCsv(products, prepared.matched, receiveAt);

  let importId = state.import_id;
  if (csv) {
    const requestId = crypto.randomUUID();
    const created = await execute(deps, ops.createImport, {
      caller,
      shopId,
      requestId,
      idempotencyKey: `shopify-onboarding:${id}:import`,
      input: { fileName: `Shopify ${store.shopDomain}.csv`.slice(0, 200) },
    });
    importId = (created.result as { importId: string }).importId;
    await deps.files.put(importFileKey(shopId, importId), csv.csv, 'text/csv');
    await execute(deps, ops.recordImportUpload, {
      caller,
      shopId,
      requestId,
      input: { importId, sizeBytes: Math.max(1, new TextEncoder().encode(csv.csv).length) },
    });
    await execute(deps, ops.previewImport, {
      caller,
      shopId,
      requestId,
      idempotencyKey: `shopify-onboarding:${id}:preview`,
      input: { importId, mapping: csv.mapping, delimiter: ',' },
    });
  }
  const pictures = new Map<string, boolean>();
  const byVariant = new Map(
    products.flatMap((p) => p.variants.map((v) => [v.variantId, { p, v }] as const)),
  );
  const counts = { sku: 0, barcode: 0, new: 0, skipped: 0 };
  for (const m of prepared.matched) counts[m.match]++;
  const rows = prepared.matched.map((m) => {
    const { p, v } = byVariant.get(m.shopifyVariantId)!;
    // The product's pictures go with its first new variant; a variant's own picture with it.
    let list: Array<Record<string, unknown>> = [];
    if (m.match === 'new') {
      if (!pictures.has(p.productId)) {
        pictures.set(p.productId, true);
        list = p.images.slice(0, 20).map((i) => ({ ...i, variantLevel: false }));
      }
      if (v.image && !p.images.some((i) => i.url === v.image!.url)) {
        list.push({ ...v.image, variantLevel: true });
      }
    }
    return { ...m, pictures: list, tracked: v.tracked };
  });
  await deps.db.transaction({ shopId, userId: null }, async (tx) => {
    for (let i = 0; i < rows.length; i += 500) {
      await tx.query(
        `insert into shopify_onboarding_rows (shop_id, onboarding_id, shopify_variant_id,
           shopify_product_id, shopify_inventory_item_id, sku, barcode, title, match, variant_id,
           pack_id, import_sku, import_row, pictures, tracked, note)
         select app_shop_id(), $1, x."shopifyVariantId", x."shopifyProductId",
           x."shopifyInventoryItemId", x.sku, x.barcode, left(x.title, 1000), x.match, x."variantId",
           x."packId", x."importSku", x."importRow", coalesce(x.pictures, '[]'), x.tracked, x.note
         from jsonb_to_recordset($2::jsonb) as x("shopifyVariantId" text, "shopifyProductId" text,
           "shopifyInventoryItemId" text, sku text, barcode text, title text, match text,
           "variantId" uuid, "packId" uuid, "importSku" text, "importRow" int, pictures jsonb,
           tracked boolean, note text)
         on conflict (shop_id, onboarding_id, shopify_variant_id) do update set
           match = excluded.match, variant_id = excluded.variant_id, pack_id = excluded.pack_id,
           import_sku = excluded.import_sku, import_row = excluded.import_row,
           pictures = excluded.pictures, tracked = excluded.tracked, note = excluded.note`,
        [id, JSON.stringify(rows.slice(i, i + 500))],
      );
    }
    await tx.query(
      `update shopify_onboardings set status = 'previewed', import_id = $2,
         counts = counts || $3::jsonb, unmapped_locations = $4::jsonb,
         updated_at = now(), version = version + 1
       where id = $1 and status = 'matching'`,
      [id, importId, JSON.stringify(counts), JSON.stringify(unmappedLocations)],
    );
  });
  return { status: 'done' };
}

async function finish(
  deps: SyncDeps,
  shopId: string,
  id: string,
  state: OnboardingState,
): Promise<OnboardingStep> {
  const caller = await jobCaller(deps.db, shopId, state.caller, 'shopify');
  for (let i = 0; i < 50; i++) {
    const done = await execute(deps, ops.finishShopifyOnboarding, {
      caller,
      shopId,
      input: { onboardingId: id },
    });
    const { remaining, orderJobs } = done.result as { remaining: number; orderJobs: string[] };
    // Orders placed while the preview waited, applied now that their variants are mapped. A job
    // that fails is retried by the job runner (the cron sweep sends it again).
    for (const jobId of orderJobs) await runJob(deps, shopId, jobId);
    await deps.dispatch?.().catch(() => {});
    if (remaining === 0) return { status: 'done' };
  }
  return { status: 'again', delaySeconds: 1 };
}
