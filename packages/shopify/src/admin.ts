import type {
  CatalogImage,
  CatalogProduct,
  CatalogVariant,
  ShopifyProductState,
} from '@airstock/core';
import { SHOPIFY_API_VERSION } from './oauth.ts';

// The Admin GraphQL calls Phase 0 needs. Everything Shopify-specific stays behind this
// interface, so a change in the pinned API version touches one file (plan Section 11).

export interface ShopifyLocation {
  id: string;
  name: string;
  active: boolean;
}

export interface ShopifyVariant {
  variantId: string;
  inventoryItemId: string;
  sku: string;
  title: string;
  tracked: boolean;
}

export interface ShopifyOrderLine {
  lineId: string;
  variantId: string | null;
  quantity: number;
  /** The quantity after edits and refunds; absent when only the orders/create payload is known. */
  currentQuantity?: number;
  /** Where Shopify committed the units (its fulfillment orders), when read. */
  locationId?: string | null;
}

/**
 * An order's state as Airstock follows it: lines, fulfillments, refunds, and cancellation. The
 * orders/create payload carries the lines only; reads from the Admin API carry everything.
 */
export interface ShopifyOrder {
  orderId: string;
  createdAt: string;
  updatedAt?: string | null;
  cancelledAt?: string | null;
  lines: ShopifyOrderLine[];
  fulfillments?: Array<{
    fulfillmentId: string;
    status: 'success' | 'cancelled' | 'error' | 'failure' | 'open' | 'pending';
    locationId: string | null;
    createdAt: string;
    lines: Array<{ lineId: string; quantity: number }>;
  }>;
  refunds?: Array<{
    refundId: string;
    createdAt: string;
    lines: Array<{
      lineId: string;
      quantity: number;
      restockType: 'cancel' | 'return' | 'no_restock' | 'legacy_restock';
      locationId: string | null;
    }>;
  }>;
  /**
   * Shopify returns (read with `read_returns`): what came back, as Shopify's reverse fulfillment
   * dispositions, and the refunds issued through the return.
   */
  returns?: ShopifyReturn[];
}

export interface ShopifyReturn {
  returnId: string;
  /** Refunds issued through this return: their restock is the return's dispositions. */
  refundIds: string[];
  dispositions: Array<{
    dispositionId: string;
    lineId: string;
    quantity: number;
    type: 'restocked' | 'not_restocked' | 'processing_required' | 'missing';
    locationId: string | null;
    createdAt: string;
  }>;
}

export interface WebhookStatus {
  topic: string;
  status: 'subscribed' | 'already_subscribed' | 'failed';
  message?: string;
}

/** One quantity of a batched compare-and-set write. */
export interface SetQuantity {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
  /** What Airstock believes Shopify's quantity is (`changeFromQuantity`). */
  from: number;
}

/**
 * A batched write: Shopify applies all quantities or none. `stale` lists the indexes refused
 * because Shopify's quantity was not `from` (all of them when Shopify did not say which).
 */
export type SetResult = { kind: 'set' } | { kind: 'stale'; stale: number[] };

/** Most quantities in one `inventorySetQuantities` call. */
export const MAX_SET_QUANTITIES = 100;
/** Most inventory items read in one call. */
export const MAX_READ_ITEMS = 25;

export interface ShopifyAdmin {
  locations(): Promise<ShopifyLocation[]>;
  /** Variants that have a SKU, for matching by SKU. */
  variantsWithSku(limit?: number): Promise<ShopifyVariant[]>;
  /**
   * Shopify's `available` for these items (at most MAX_READ_ITEMS), keyed `item@location`; a
   * location where an item is not stocked is absent.
   */
  getAvailable(inventoryItemIds: string[]): Promise<Map<string, number>>;
  /**
   * Compare-and-set of `available` for many levels in one `inventorySetQuantities` call (at most
   * MAX_SET_QUANTITIES): refused as stale when a quantity in Shopify is not its `from`.
   */
  setAvailable(input: {
    quantities: SetQuantity[];
    idempotencyKey: string;
    reference: string;
  }): Promise<SetResult>;
  /** Orders created at or after `since`, newest first, with their whole state. */
  ordersSince(since: string): Promise<ShopifyOrder[]>;
  /** One order's whole state, or null when Shopify no longer has it. */
  order(orderId: string): Promise<ShopifyOrder | null>;
  /** Orders Shopify changed at or after `since`, oldest first, a page at a time. */
  ordersUpdatedSince(
    since: string,
    after?: string | null,
  ): Promise<{ orders: ShopifyOrder[]; next: string | null }>;
  /** Where Shopify committed each line (its fulfillment orders' assigned locations). */
  lineLocations(orderId: string): Promise<Map<string, string>>;
  /** The order a reverse fulfillment order (a return's) belongs to. */
  orderOfReverseFulfillmentOrder(id: string): Promise<string | null>;
  ensureWebhooks(uri: string, topics: string[]): Promise<WebhookStatus[]>;
  /** Starts the onboarding read of the whole catalog as a bulk operation; returns its ID. */
  startCatalogRead(): Promise<string>;
  /** A bulk operation's state; `url` is set when it completed with results. */
  bulkOperation(id: string): Promise<BulkOperationState>;
  /** Downloads and parses a completed catalog read. */
  fetchCatalog(url: string): Promise<CatalogProduct[]>;
  /** A product with its variants, or null when Shopify no longer has it. */
  product(productId: string): Promise<ShopifyProductState | null>;
  /** Variants whose SKU is one of these (to adopt a product a crashed create already made). */
  variantsBySku(
    skus: string[],
  ): Promise<Array<{ productId: string; variantId: string; inventoryItemId: string; sku: string }>>;
  /** Creates a product with its options, variants, and pictures (productSet). */
  createProduct(input: ListingInput): Promise<ListedProduct>;
  /** Changes product fields and adds pictures; variants are left as they are. */
  updateProduct(input: {
    productId: string;
    title?: string;
    descriptionHtml?: string;
    status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
    media?: Array<{ originalSource: string; alt: string | null }>;
  }): Promise<void>;
  /** Sets variant prices (productVariantsBulkUpdate). */
  updateVariantPrices(
    productId: string,
    prices: Array<{ variantId: string; price: string }>,
  ): Promise<void>;
  /** Uploads a picture to Shopify's staged storage; returns the URL productSet takes. */
  stagePicture(file: { filename: string; mimeType: string; bytes: Uint8Array }): Promise<string>;
}

/** A product Airstock lists in Shopify (created with productSet; D21). */
export interface ListingInput {
  title: string;
  descriptionHtml: string;
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  options: Array<{ name: string; values: string[] }>;
  variants: Array<{
    sku: string;
    barcode: string | null;
    price: string | null;
    optionValues: Array<{ optionName: string; name: string }>;
    /** Shopify locations where the item is stocked (at 0; the push sets the quantity). */
    locationIds: string[];
  }>;
  /** Pictures by staged-upload URL. */
  files: Array<{ originalSource: string; alt: string | null }>;
}

export interface ListedProduct {
  productId: string;
  variants: Array<{ variantId: string; inventoryItemId: string; sku: string | null }>;
}

export interface BulkOperationState {
  status: 'running' | 'completed' | 'failed';
  url: string | null;
  error: string | null;
}

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Throttling and server errors: worth retrying later. */
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ShopifyApiError';
  }
}

export const gid = (type: string, id: string) => `gid://shopify/${type}/${id}`;
const numeric = (value: string) => value.slice(value.lastIndexOf('/') + 1);

const QUERIES = {
  locations: `query { locations(first: 50) { nodes { id name isActive } } }`,
  variants: `query($after: String) {
    productVariants(first: 250, after: $after, query: "sku:*") {
      nodes { id sku title product { title } inventoryItem { id tracked } }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  available: `query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        inventoryLevels(first: 10) {
          nodes { location { id } quantities(names: ["available"]) { name quantity } }
        }
      }
    }
  }`,
  setAvailable: `mutation($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) {
      inventoryAdjustmentGroup { id }
      userErrors { code field message }
    }
  }`,
  orderIds: `query($query: String!, $after: String, $sort: OrderSortKeys!, $reverse: Boolean!) {
    orders(first: 25, sortKey: $sort, reverse: $reverse, query: $query, after: $after) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  // Requested cost stays under Shopify's 1,000 per query: an order with more than 100 lines, or
  // 10 fulfillments or refunds of 30 lines, is read in part (logged).
  order: `query($id: ID!) {
    order(id: $id) {
      id createdAt updatedAt cancelledAt returnStatus
      lineItems(first: 100) { nodes { id quantity currentQuantity variant { id } } }
      fulfillments(first: 10) {
        id status createdAt location { id }
        fulfillmentLineItems(first: 30) { nodes { lineItem { id } quantity } }
      }
      refunds(first: 10) {
        id createdAt
        refundLineItems(first: 30) { nodes { lineItem { id } quantity restockType location { id } } }
      }
    }
  }`,
  // Read only for orders with returns, and only with read_returns.
  returns: `query($id: ID!) {
    order(id: $id) {
      returns(first: 10) {
        nodes {
          id
          refunds(first: 10) { nodes { id } }
          reverseFulfillmentOrders(first: 5) {
            nodes {
              lineItems(first: 30) {
                nodes {
                  fulfillmentLineItem { lineItem { id } }
                  dispositions { id createdAt type quantity location { id } }
                }
              }
            }
          }
        }
      }
    }
  }`,
  reverseFulfillmentOrder: `query($id: ID!) { reverseFulfillmentOrder(id: $id) { id order { id } } }`,
  product: `query($id: ID!) {
    product(id: $id) {
      id title descriptionHtml status updatedAt
      mediaCount { count }
      variants(first: 100) {
        nodes { id title sku barcode price inventoryItem { id tracked } }
      }
    }
  }`,
  variantsBySku: `query($query: String!) {
    productVariants(first: 50, query: $query) {
      nodes { id sku product { id } inventoryItem { id } }
    }
  }`,
  productSet: `mutation($input: ProductSetInput!) {
    productSet(input: $input, synchronous: true) {
      product { id variants(first: 100) { nodes { id sku inventoryItem { id } } } }
      userErrors { field message code }
    }
  }`,
  productUpdate: `mutation($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
    productUpdate(product: $product, media: $media) {
      product { id }
      userErrors { field message }
    }
  }`,
  variantPrices: `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }`,
  stagedUpload: `mutation($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }`,
  lineLocations: `query($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 20) {
        nodes {
          assignedLocation { location { id } }
          lineItems(first: 50) { nodes { lineItem { id } } }
        }
      }
    }
  }`,
  webhooks: `query { webhookSubscriptions(first: 50) { nodes { id topic uri } } }`,
  bulkRun: `mutation($query: String!) {
    bulkOperationRunQuery(query: $query, groupObjects: false) {
      bulkOperation { id status }
      userErrors { field message code }
    }
  }`,
  bulkStatus: `query($id: ID!) {
    node(id: $id) { ... on BulkOperation { id status errorCode url partialDataUrl } }
  }`,
  createWebhook: `mutation($topic: WebhookSubscriptionTopic!, $subscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
      webhookSubscription { id topic uri }
      userErrors { field message }
    }
  }`,
};

/**
 * The onboarding read (plan Section 5.14): products with options, pictures, and variants with
 * their SKU, barcode, price, options, and available quantity per location. Four connections,
 * two levels deep, within Shopify's bulk limits. No customer data.
 */
export const CATALOG_BULK_QUERY = `{
  products {
    edges { node {
      id title status description
      options { name }
      media { edges { node { ... on MediaImage { id alt image { url width height } } } } }
      variants { edges { node {
        id sku barcode title price
        selectedOptions { name value }
        image { url altText width height }
        inventoryItem { id tracked
          inventoryLevels { edges { node { id location { id } quantities(names: ["available"]) { name quantity } } } }
        }
      } } }
    } }
  }
}`;

/** Parses a catalog read's JSONL: parents first, children name them with `__parentId`. */
export function parseCatalogJsonl(text: string): CatalogProduct[] {
  const products = new Map<string, CatalogProduct>();
  const variants = new Map<string, CatalogVariant>();
  const byItem = new Map<string, CatalogVariant>();
  const pendingLevels: Array<{ parent: string; locationId: string; available: number }> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown> & { id?: string; __parentId?: string };
    const id = typeof row.id === 'string' ? row.id : '';
    if (id.startsWith('gid://shopify/Product/')) {
      products.set(id, {
        productId: numeric(id),
        title: String(row.title ?? ''),
        description:
          typeof row.description === 'string' && row.description ? row.description : null,
        status: String(row.status ?? 'ACTIVE'),
        options: ((row.options as Array<{ name: string }> | undefined) ?? []).map((o) => o.name),
        images: [],
        variants: [],
      });
    } else if (id.startsWith('gid://shopify/ProductVariant/')) {
      const item = row.inventoryItem as { id: string; tracked: boolean } | null;
      const image = row.image as {
        url: string;
        altText: string | null;
        width: number | null;
        height: number | null;
      } | null;
      const variant: CatalogVariant = {
        variantId: numeric(id),
        inventoryItemId: item ? numeric(item.id) : null,
        sku: typeof row.sku === 'string' ? row.sku : null,
        barcode: typeof row.barcode === 'string' ? row.barcode : null,
        title: String(row.title ?? ''),
        price: typeof row.price === 'string' ? row.price : null,
        options: (row.selectedOptions as Array<{ name: string; value: string }> | undefined) ?? [],
        tracked: item?.tracked ?? false,
        levels: [],
        image: image?.url
          ? { url: image.url, alt: image.altText, width: image.width, height: image.height }
          : null,
      };
      variants.set(id, variant);
      if (item) byItem.set(item.id, variant);
      products.get(row.__parentId ?? '')?.variants.push(variant);
    } else if (id.startsWith('gid://shopify/MediaImage/')) {
      const image = row.image as {
        url: string;
        width: number | null;
        height: number | null;
      } | null;
      if (image?.url) {
        const picture: CatalogImage = {
          url: image.url,
          alt: typeof row.alt === 'string' ? row.alt : null,
          width: image.width,
          height: image.height,
        };
        products.get(row.__parentId ?? '')?.images.push(picture);
      }
    } else if (id.startsWith('gid://shopify/InventoryLevel/')) {
      const location = row.location as { id: string } | null;
      const quantities = (row.quantities as Array<{ name: string; quantity: number }>) ?? [];
      if (location) {
        pendingLevels.push({
          parent: row.__parentId ?? '',
          locationId: numeric(location.id),
          available: quantities.find((q) => q.name === 'available')?.quantity ?? 0,
        });
      }
    }
  }
  // An inventory level's parent is its variant (or, in some API versions, its inventory item).
  for (const level of pendingLevels) {
    const variant = variants.get(level.parent) ?? byItem.get(level.parent);
    variant?.levels.push({ locationId: level.locationId, available: level.available });
  }
  return [...products.values()];
}

/**
 * Minimal webhook payloads: only what turning an order into reservations needs. No customer
 * fields are requested (PRD 8.5).
 */
export const WEBHOOK_FIELDS: Record<string, string[] | undefined> = {
  ORDERS_CREATE: ['id', 'admin_graphql_api_id', 'created_at', 'line_items'],
  ORDERS_EDITED: ['order_edit'],
  ORDERS_CANCELLED: ['id', 'admin_graphql_api_id'],
  FULFILLMENTS_CREATE: ['id', 'order_id', 'status'],
  FULFILLMENTS_UPDATE: ['id', 'order_id', 'status'],
  REFUNDS_CREATE: ['id', 'order_id'],
  REVERSE_FULFILLMENT_ORDERS_DISPOSE: ['id', 'admin_graphql_api_id'],
  PRODUCTS_CREATE: ['id', 'admin_graphql_api_id', 'updated_at'],
  PRODUCTS_UPDATE: ['id', 'admin_graphql_api_id', 'updated_at'],
};

interface RawOrder {
  id: string;
  createdAt: string;
  updatedAt: string | null;
  cancelledAt: string | null;
  returnStatus?: string | null;
  lineItems: {
    nodes: Array<{
      id: string;
      quantity: number;
      currentQuantity: number;
      variant: { id: string } | null;
    }>;
  };
  fulfillments: Array<{
    id: string;
    status: string;
    createdAt: string;
    location: { id: string } | null;
    fulfillmentLineItems: { nodes: Array<{ lineItem: { id: string }; quantity: number }> };
  }>;
  refunds: Array<{
    id: string;
    createdAt: string;
    refundLineItems: {
      nodes: Array<{
        lineItem: { id: string };
        quantity: number;
        restockType: string;
        location: { id: string } | null;
      }>;
    };
  }>;
}

const FULFILLMENT_STATUSES = [
  'success',
  'cancelled',
  'error',
  'failure',
  'open',
  'pending',
] as const;
const RESTOCK_TYPES = ['cancel', 'return', 'no_restock', 'legacy_restock'] as const;

/** An Admin API order as the state the order sync applies. No customer fields are read. */
export function parseOrder(o: RawOrder): ShopifyOrder {
  const status = (s: string) => {
    const v = s.toLowerCase();
    return (FULFILLMENT_STATUSES as readonly string[]).includes(v)
      ? (v as (typeof FULFILLMENT_STATUSES)[number])
      : 'pending';
  };
  const restock = (s: string) => {
    const v = s.toLowerCase();
    return (RESTOCK_TYPES as readonly string[]).includes(v)
      ? (v as (typeof RESTOCK_TYPES)[number])
      : 'no_restock';
  };
  return {
    orderId: numeric(o.id),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    cancelledAt: o.cancelledAt,
    lines: o.lineItems.nodes.map((l) => ({
      lineId: numeric(l.id),
      variantId: l.variant ? numeric(l.variant.id) : null,
      quantity: l.quantity,
      currentQuantity: l.currentQuantity,
    })),
    fulfillments: o.fulfillments.map((f) => ({
      fulfillmentId: numeric(f.id),
      status: status(f.status),
      locationId: f.location ? numeric(f.location.id) : null,
      createdAt: f.createdAt,
      lines: f.fulfillmentLineItems.nodes.map((l) => ({
        lineId: numeric(l.lineItem.id),
        quantity: l.quantity,
      })),
    })),
    refunds: o.refunds.map((r) => ({
      refundId: numeric(r.id),
      createdAt: r.createdAt,
      lines: r.refundLineItems.nodes.map((l) => ({
        lineId: numeric(l.lineItem.id),
        quantity: l.quantity,
        restockType: restock(l.restockType),
        locationId: l.location ? numeric(l.location.id) : null,
      })),
    })),
  };
}

interface RawReturns {
  returns: {
    nodes: Array<{
      id: string;
      refunds: { nodes: Array<{ id: string }> };
      reverseFulfillmentOrders: {
        nodes: Array<{
          lineItems: {
            nodes: Array<{
              fulfillmentLineItem: { lineItem: { id: string } } | null;
              dispositions: Array<{
                id: string;
                createdAt: string;
                type: string;
                quantity: number;
                location: { id: string } | null;
              }>;
            }>;
          };
        }>;
      };
    }>;
  };
}

const DISPOSITIONS = ['restocked', 'not_restocked', 'processing_required', 'missing'] as const;

/** An order's returns as the order sync applies them. */
export function parseReturns(raw: RawReturns): ShopifyReturn[] {
  return raw.returns.nodes.map((r) => ({
    returnId: numeric(r.id),
    refundIds: r.refunds.nodes.map((x) => numeric(x.id)),
    dispositions: r.reverseFulfillmentOrders.nodes.flatMap((rfo) =>
      rfo.lineItems.nodes.flatMap((li) => {
        const lineId = li.fulfillmentLineItem?.lineItem.id;
        if (!lineId) return [];
        return li.dispositions.flatMap((d) => {
          const type = d.type.toLowerCase() as (typeof DISPOSITIONS)[number];
          if (!DISPOSITIONS.includes(type) || d.quantity <= 0) return [];
          return [
            {
              dispositionId: numeric(d.id),
              lineId: numeric(lineId),
              quantity: d.quantity,
              type,
              locationId: d.location ? numeric(d.location.id) : null,
              createdAt: d.createdAt,
            },
          ];
        });
      }),
    ),
  }));
}

interface CostExtension {
  requestedQueryCost?: number;
  throttleStatus?: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long until the bucket holds the query's cost again, at most 10 seconds. */
export function throttleWaitMs(cost: CostExtension | undefined): number {
  const status = cost?.throttleStatus;
  if (!status || !status.restoreRate) return 2000;
  const missing = (cost?.requestedQueryCost ?? 100) - status.currentlyAvailable;
  return Math.min(10_000, Math.max(250, Math.ceil((missing / status.restoreRate) * 1000)));
}

export function httpShopifyAdmin(
  shopDomain: string,
  accessToken: string,
  doFetch: typeof fetch = fetch,
  /** Scopes the store granted; reads that need a missing scope are left out. */
  scopes: readonly string[] | null = null,
): ShopifyAdmin {
  const granted = (scope: string) =>
    scopes === null || scopes.includes(scope) || scopes.includes(scope.replace(/^read_/, 'write_'));
  const endpoint = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  async function call<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    // Shopify's GraphQL limits are cost-based: a throttled call waits for the bucket to refill
    // (its restore rate), up to three times, then fails as retryable for the job to try later.
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-shopify-access-token': accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429 && attempt < 3) {
        await sleep(Math.min(10, Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000);
        continue;
      }
      if (!res.ok) {
        throw new ShopifyApiError(
          `Shopify Admin API returned ${res.status}.`,
          res.status,
          res.status === 429 || res.status >= 500,
        );
      }
      const body = (await res.json()) as {
        data?: T;
        errors?: Array<{ message: string; extensions?: { code?: string } }>;
        extensions?: { cost?: CostExtension };
      };
      if (body.errors?.length) {
        const code = body.errors[0]?.extensions?.code;
        if (code === 'THROTTLED' && attempt < 3) {
          await sleep(throttleWaitMs(body.extensions?.cost));
          continue;
        }
        throw new ShopifyApiError(
          body.errors.map((e) => e.message).join('; '),
          200,
          code === 'THROTTLED' || code === 'INTERNAL_SERVER_ERROR',
          code,
        );
      }
      return body.data as T;
    }
  }

  async function orderIds(
    query: string,
    sort: 'CREATED_AT' | 'UPDATED_AT',
    reverse: boolean,
    after: string | null,
  ): Promise<{ ids: string[]; next: string | null }> {
    const data = await call<{
      orders: {
        nodes: Array<{ id: string }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(QUERIES.orderIds, { query, after, sort, reverse });
    return {
      ids: data.orders.nodes.map((o) => o.id),
      next: data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null,
    };
  }

  async function readOrder(id: string): Promise<ShopifyOrder | null> {
    const data = await call<{ order: RawOrder | null }>(QUERIES.order, { id });
    if (!data.order) return null;
    const order = parseOrder(data.order);
    const status = data.order.returnStatus ?? 'NO_RETURN';
    if (status !== 'NO_RETURN' && granted('read_returns')) {
      const more = await call<{ order: RawReturns | null }>(QUERIES.returns, { id });
      if (more.order) order.returns = parseReturns(more.order);
    }
    return order;
  }

  return {
    async locations() {
      const data = await call<{
        locations: { nodes: Array<{ id: string; name: string; isActive: boolean }> };
      }>(QUERIES.locations);
      return data.locations.nodes.map((l) => ({
        id: numeric(l.id),
        name: l.name,
        active: l.isActive,
      }));
    },

    async variantsWithSku(limit = 1000) {
      const out: ShopifyVariant[] = [];
      let after: string | null = null;
      do {
        const data: {
          productVariants: {
            nodes: Array<{
              id: string;
              sku: string | null;
              title: string;
              product: { title: string };
              inventoryItem: { id: string; tracked: boolean };
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } = await call(QUERIES.variants, { after });
        for (const v of data.productVariants.nodes) {
          if (!v.sku?.trim()) continue;
          out.push({
            variantId: numeric(v.id),
            inventoryItemId: numeric(v.inventoryItem.id),
            sku: v.sku,
            title: `${v.product.title} / ${v.title}`,
            tracked: v.inventoryItem.tracked,
          });
        }
        after = data.productVariants.pageInfo.hasNextPage
          ? data.productVariants.pageInfo.endCursor
          : null;
      } while (after && out.length < limit);
      return out;
    },

    async getAvailable(inventoryItemIds) {
      const out = new Map<string, number>();
      if (inventoryItemIds.length === 0) return out;
      if (inventoryItemIds.length > MAX_READ_ITEMS) throw new Error('Too many items in one read.');
      const data = await call<{
        nodes: Array<{
          id?: string;
          inventoryLevels?: {
            nodes: Array<{
              location: { id: string };
              quantities: Array<{ name: string; quantity: number }>;
            }>;
          };
        } | null>;
      }>(QUERIES.available, { ids: inventoryItemIds.map((id) => gid('InventoryItem', id)) });
      for (const node of data.nodes) {
        if (!node?.id || !node.inventoryLevels) continue;
        for (const level of node.inventoryLevels.nodes) {
          const available = level.quantities.find((q) => q.name === 'available')?.quantity;
          if (available !== undefined) {
            out.set(`${numeric(node.id)}@${numeric(level.location.id)}`, available);
          }
        }
      }
      return out;
    },

    async setAvailable(input) {
      if (input.quantities.length > MAX_SET_QUANTITIES) throw new Error('Too many quantities.');
      const data = await call<{
        inventorySetQuantities: {
          userErrors: Array<{ code: string | null; field: string[] | null; message: string }>;
        };
      }>(QUERIES.setAvailable, {
        key: input.idempotencyKey,
        input: {
          name: 'available',
          reason: 'correction',
          referenceDocumentUri: input.reference,
          quantities: input.quantities.map((q) => ({
            inventoryItemId: gid('InventoryItem', q.inventoryItemId),
            locationId: gid('Location', q.locationId),
            quantity: q.quantity,
            changeFromQuantity: q.from,
          })),
        },
      });
      const errors = data.inventorySetQuantities.userErrors;
      if (errors.length === 0) return { kind: 'set' };
      const stale = errors.filter((e) => e.code === 'CHANGE_FROM_QUANTITY_STALE');
      if (stale.length === errors.length) {
        // The field path names the quantity: ["input", "quantities", "3", "changeFromQuantity"].
        const indexes = stale.map((e) => Number(e.field?.[2]));
        return {
          kind: 'stale',
          stale: indexes.every((i) => Number.isInteger(i) && i >= 0 && i < input.quantities.length)
            ? [...new Set(indexes)]
            : input.quantities.map((_, i) => i),
        };
      }
      const first = errors.find((e) => e.code !== 'CHANGE_FROM_QUANTITY_STALE')!;
      throw new ShopifyApiError(
        first.message,
        200,
        first.code === 'IDEMPOTENCY_CONCURRENT_REQUEST',
        first.code ?? undefined,
      );
    },

    async ordersSince(since) {
      const ids = await orderIds(`created_at:>='${since}'`, 'CREATED_AT', true, null);
      const orders = await Promise.all(ids.ids.map((id) => readOrder(id)));
      return orders.filter((o): o is ShopifyOrder => o !== null);
    },

    order: (orderId) => readOrder(gid('Order', orderId)),

    async ordersUpdatedSince(since, after = null) {
      const ids = await orderIds(`updated_at:>='${since}'`, 'UPDATED_AT', false, after);
      const orders: ShopifyOrder[] = [];
      for (const id of ids.ids) {
        const order = await readOrder(id);
        if (order) orders.push(order);
      }
      return { orders, next: ids.next };
    },

    async lineLocations(orderId) {
      const data = await call<{
        order: {
          fulfillmentOrders: {
            nodes: Array<{
              assignedLocation: { location: { id: string } | null } | null;
              lineItems: { nodes: Array<{ lineItem: { id: string } }> };
            }>;
          };
        } | null;
      }>(QUERIES.lineLocations, { id: gid('Order', orderId) });
      const out = new Map<string, string>();
      for (const fo of data.order?.fulfillmentOrders.nodes ?? []) {
        const location = fo.assignedLocation?.location?.id;
        if (!location) continue;
        for (const li of fo.lineItems.nodes) {
          if (!out.has(numeric(li.lineItem.id)))
            out.set(numeric(li.lineItem.id), numeric(location));
        }
      }
      return out;
    },

    async product(productId) {
      const data = await call<{
        product: {
          id: string;
          title: string;
          descriptionHtml: string | null;
          status: string;
          updatedAt: string | null;
          mediaCount: { count: number } | null;
          variants: {
            nodes: Array<{
              id: string;
              title: string;
              sku: string | null;
              barcode: string | null;
              price: string | null;
              inventoryItem: { id: string; tracked: boolean } | null;
            }>;
          };
        } | null;
      }>(QUERIES.product, { id: gid('Product', productId) });
      const p = data.product;
      if (!p) return null;
      return {
        productId: numeric(p.id),
        title: p.title,
        descriptionHtml: p.descriptionHtml,
        status: p.status,
        updatedAt: p.updatedAt,
        mediaCount: p.mediaCount?.count ?? 0,
        variants: p.variants.nodes.map((v) => ({
          variantId: numeric(v.id),
          inventoryItemId: v.inventoryItem ? numeric(v.inventoryItem.id) : null,
          sku: v.sku,
          barcode: v.barcode,
          price: v.price,
          title: v.title,
          tracked: v.inventoryItem?.tracked ?? false,
        })),
      };
    },

    async variantsBySku(skus) {
      if (skus.length === 0) return [];
      const quoted = skus.map((s) => `sku:"${s.replace(/["\\]/g, '')}"`).join(' OR ');
      const data = await call<{
        productVariants: {
          nodes: Array<{
            id: string;
            sku: string | null;
            product: { id: string };
            inventoryItem: { id: string } | null;
          }>;
        };
      }>(QUERIES.variantsBySku, { query: quoted });
      const wanted = new Set(skus.map((s) => s.trim().toUpperCase()));
      return data.productVariants.nodes.flatMap((v) =>
        v.sku && v.inventoryItem && wanted.has(v.sku.trim().toUpperCase())
          ? [
              {
                productId: numeric(v.product.id),
                variantId: numeric(v.id),
                inventoryItemId: numeric(v.inventoryItem.id),
                sku: v.sku,
              },
            ]
          : [],
      );
    },

    async createProduct(input) {
      const data = await call<{
        productSet: {
          product: {
            id: string;
            variants: {
              nodes: Array<{ id: string; sku: string | null; inventoryItem: { id: string } }>;
            };
          } | null;
          userErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
        };
      }>(QUERIES.productSet, {
        input: {
          title: input.title,
          descriptionHtml: input.descriptionHtml,
          status: input.status,
          productOptions: input.options.map((o, i) => ({
            name: o.name,
            position: i + 1,
            values: o.values.map((name) => ({ name })),
          })),
          variants: input.variants.map((v) => ({
            optionValues: v.optionValues,
            ...(v.price ? { price: v.price } : {}),
            ...(v.barcode ? { barcode: v.barcode } : {}),
            inventoryItem: { sku: v.sku, tracked: true },
            inventoryQuantities: v.locationIds.map((l) => ({
              locationId: gid('Location', l),
              name: 'available',
              quantity: 0,
            })),
          })),
          ...(input.files.length > 0
            ? {
                files: input.files.map((f) => ({
                  originalSource: f.originalSource,
                  contentType: 'IMAGE',
                  ...(f.alt ? { alt: f.alt } : {}),
                })),
              }
            : {}),
        },
      });
      const out = data.productSet;
      if (!out.product || out.userErrors.length > 0) {
        throw new ShopifyApiError(
          out.userErrors.map((e) => e.message).join('; ') || 'Shopify did not create the product.',
          200,
          false,
          out.userErrors[0]?.code ?? undefined,
        );
      }
      return {
        productId: numeric(out.product.id),
        variants: out.product.variants.nodes.map((v) => ({
          variantId: numeric(v.id),
          inventoryItemId: numeric(v.inventoryItem.id),
          sku: v.sku,
        })),
      };
    },

    async updateProduct(input) {
      const data = await call<{
        productUpdate: { userErrors: Array<{ field: string[] | null; message: string }> };
      }>(QUERIES.productUpdate, {
        product: {
          id: gid('Product', input.productId),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.descriptionHtml !== undefined
            ? { descriptionHtml: input.descriptionHtml }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
        media: (input.media ?? []).map((m) => ({
          originalSource: m.originalSource,
          mediaContentType: 'IMAGE',
          ...(m.alt ? { alt: m.alt } : {}),
        })),
      });
      const errors = data.productUpdate.userErrors;
      if (errors.length > 0) {
        throw new ShopifyApiError(errors.map((e) => e.message).join('; '), 200, false);
      }
    },

    async updateVariantPrices(productId, prices) {
      if (prices.length === 0) return;
      const data = await call<{
        productVariantsBulkUpdate: {
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(QUERIES.variantPrices, {
        productId: gid('Product', productId),
        variants: prices.map((p) => ({ id: gid('ProductVariant', p.variantId), price: p.price })),
      });
      const errors = data.productVariantsBulkUpdate.userErrors;
      if (errors.length > 0) {
        throw new ShopifyApiError(errors.map((e) => e.message).join('; '), 200, false);
      }
    },

    async stagePicture(file) {
      const data = await call<{
        stagedUploadsCreate: {
          stagedTargets: Array<{
            url: string;
            resourceUrl: string;
            parameters: Array<{ name: string; value: string }>;
          }>;
          userErrors: Array<{ message: string }>;
        };
      }>(QUERIES.stagedUpload, {
        input: [
          {
            resource: 'IMAGE',
            filename: file.filename,
            mimeType: file.mimeType,
            httpMethod: 'POST',
            fileSize: String(file.bytes.byteLength),
          },
        ],
      });
      const target = data.stagedUploadsCreate.stagedTargets[0];
      if (!target) {
        throw new ShopifyApiError(
          data.stagedUploadsCreate.userErrors.map((e) => e.message).join('; ') ||
            'Shopify gave no upload target.',
          200,
          true,
        );
      }
      const form = new FormData();
      for (const p of target.parameters) form.append(p.name, p.value);
      form.append(
        'file',
        new Blob([file.bytes as unknown as ArrayBuffer], { type: file.mimeType }),
        file.filename,
      );
      const res = await doFetch(target.url, { method: 'POST', body: form });
      if (!res.ok) {
        throw new ShopifyApiError(
          `Picture upload returned ${res.status}.`,
          res.status,
          res.status >= 500,
        );
      }
      return target.resourceUrl;
    },

    async orderOfReverseFulfillmentOrder(id) {
      const data = await call<{
        reverseFulfillmentOrder: { order: { id: string } | null } | null;
      }>(QUERIES.reverseFulfillmentOrder, { id: gid('ReverseFulfillmentOrder', id) });
      const order = data.reverseFulfillmentOrder?.order?.id;
      return order ? numeric(order) : null;
    },

    async startCatalogRead() {
      const data = await call<{
        bulkOperationRunQuery: {
          bulkOperation: { id: string } | null;
          userErrors: Array<{ message: string; code: string | null }>;
        };
      }>(QUERIES.bulkRun, { query: CATALOG_BULK_QUERY });
      const op = data.bulkOperationRunQuery;
      if (!op.bulkOperation) {
        const busy = op.userErrors.some((e) => e.code === 'OPERATION_IN_PROGRESS');
        throw new ShopifyApiError(
          op.userErrors.map((e) => e.message).join('; ') || 'Bulk operation refused.',
          200,
          busy,
          op.userErrors[0]?.code ?? undefined,
        );
      }
      return op.bulkOperation.id;
    },

    async bulkOperation(id) {
      const data = await call<{
        node: { status: string; errorCode: string | null; url: string | null } | null;
      }>(QUERIES.bulkStatus, { id });
      const node = data.node;
      if (!node) return { status: 'failed', url: null, error: 'Bulk operation not found.' };
      if (node.status === 'COMPLETED') return { status: 'completed', url: node.url, error: null };
      if (['FAILED', 'CANCELED', 'CANCELING', 'EXPIRED'].includes(node.status)) {
        return { status: 'failed', url: null, error: node.errorCode ?? node.status };
      }
      return { status: 'running', url: null, error: null };
    },

    async fetchCatalog(url) {
      if (!url.startsWith('https://'))
        throw new ShopifyApiError('Unexpected result URL.', 0, false);
      const res = await doFetch(url);
      if (!res.ok) {
        throw new ShopifyApiError(`Bulk result download returned ${res.status}.`, res.status, true);
      }
      return parseCatalogJsonl(await res.text());
    },

    async ensureWebhooks(uri, topics) {
      const existing = await call<{
        webhookSubscriptions: { nodes: Array<{ topic: string; uri: string }> };
      }>(QUERIES.webhooks);
      const out: WebhookStatus[] = [];
      for (const topic of topics) {
        if (existing.webhookSubscriptions.nodes.some((w) => w.topic === topic && w.uri === uri)) {
          out.push({ topic, status: 'already_subscribed' });
          continue;
        }
        const fields = WEBHOOK_FIELDS[topic];
        try {
          const data = await call<{
            webhookSubscriptionCreate: { userErrors: Array<{ message: string }> };
          }>(QUERIES.createWebhook, {
            topic,
            subscription: { uri, ...(fields ? { includeFields: fields } : {}) },
          });
          const errors = data.webhookSubscriptionCreate.userErrors;
          out.push(
            errors.length === 0
              ? { topic, status: 'subscribed' }
              : { topic, status: 'failed', message: errors.map((e) => e.message).join('; ') },
          );
        } catch (error) {
          out.push({ topic, status: 'failed', message: String((error as Error).message) });
        }
      }
      return out;
    },
  };
}
