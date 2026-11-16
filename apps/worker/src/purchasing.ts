import { errors, execute, ops, type PurchaseOrderView } from '@airstock/core';
import {
  FontLibrary,
  type FontLoader,
  type PurchaseOrderPdfInput,
  renderPurchaseOrderPdf,
} from '@airstock/pdf';
import type { Hono } from 'hono';
import { type AppDeps, type AppEnv, problem } from './app.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Font files from the Worker's own static assets (the label fonts, ADR 0019). */
export function assetFontLoader(assets: Fetcher): FontLoader {
  return async (file) => {
    const res = await assets.fetch(`https://assets.invalid/assets/fonts/${file}`);
    if (!res.ok) throw new Error(`Could not load the font ${file} (HTTP ${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

/** One library per loader: each font file is read at most once per isolate. */
const libraries = new WeakMap<FontLoader, FontLibrary>();
function libraryFor(loader: FontLoader): FontLibrary {
  let library = libraries.get(loader);
  if (!library) {
    library = new FontLibrary(loader);
    libraries.set(loader, library);
  }
  return library;
}

/** What the PDF prints for an order (D11). Costs only when the order view carries them. */
export function purchaseOrderPdfInput(order: PurchaseOrderView): PurchaseOrderPdfInput {
  return {
    number: order.number,
    status: order.status,
    currency: order.currency,
    shopName: order.shop.name,
    orderDate: (order.sentAt ?? order.createdAt).slice(0, 10),
    expectedOn: order.expectedOn,
    supplierReference: order.supplierReference,
    notes: order.notes,
    supplier: order.supplier,
    deliverTo: {
      name: order.warehouse.name,
      address: order.warehouse.address,
      location: order.location?.path ?? null,
    },
    lines: order.lines.map((l) => ({
      sku: l.sku,
      supplierSku: l.supplierSku,
      description: l.variantName ? `${l.productName} – ${l.variantName}` : l.productName,
      packName: l.packName,
      packFactor: l.packFactor,
      quantity: l.quantity,
      unitCost: l.unitCost,
      lineTotal: l.lineTotal,
    })),
    total: order.total,
    showCosts: order.costVisible,
  };
}

export async function purchaseOrderPdf(
  loader: FontLoader,
  order: PurchaseOrderView,
): Promise<Uint8Array> {
  const pdf = await renderPurchaseOrderPdf(purchaseOrderPdfInput(order), libraryFor(loader));
  return pdf.bytes;
}

/**
 * The PDF download (D11). It sits under /api/v1, so the caller is authenticated like any API call;
 * reading the order runs `purchasing.orders.get`, which checks permissions and location scope and
 * records the access. Costs print only for members with costs.read.
 */
export function mountPurchasingRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  app.get('/api/v1/shops/:shopId/purchase-orders/:purchaseOrderId/pdf', async (c) => {
    const { shopId, purchaseOrderId } = c.req.param();
    const requestId = c.get('requestId');
    if (!UUID.test(purchaseOrderId)) return problem(errors.notFound('Purchase order'), requestId);
    if (!deps.fonts) return problem(errors.serviceUnavailable(), requestId);
    const res = await execute(
      { db: c.get('db'), audit: c.get('audit'), logger: deps.logger },
      ops.getPurchaseOrder,
      {
        caller: c.get('caller'),
        shopId,
        input: { purchaseOrderId },
        requestId,
      },
    );
    const order = res.result as PurchaseOrderView;
    const bytes = await purchaseOrderPdf(deps.fonts, order);
    return new Response(bytes, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${order.number}.pdf"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });
}
