import type { CatalogImage, CatalogProduct, CatalogVariant } from '@airstock/core';
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
}

export interface ShopifyOrder {
  orderId: string;
  createdAt: string;
  lines: ShopifyOrderLine[];
}

export interface WebhookStatus {
  topic: string;
  status: 'subscribed' | 'already_subscribed' | 'failed';
  message?: string;
}

export type SetResult = { kind: 'set' } | { kind: 'stale' };

export interface ShopifyAdmin {
  locations(): Promise<ShopifyLocation[]>;
  /** Variants that have a SKU, for matching by SKU. */
  variantsWithSku(limit?: number): Promise<ShopifyVariant[]>;
  /** Shopify's `available` quantity, or null when the item is not stocked at the location. */
  getAvailable(inventoryItemId: string, locationId: string): Promise<number | null>;
  /** Compare-and-set of `available`: refused as stale when Shopify's quantity is not `from`. */
  setAvailable(input: {
    inventoryItemId: string;
    locationId: string;
    quantity: number;
    from: number;
    idempotencyKey: string;
    reference: string;
  }): Promise<SetResult>;
  /** Orders created at or after `since`, newest first, with their line items. */
  ordersSince(since: string): Promise<ShopifyOrder[]>;
  ensureWebhooks(uri: string, topics: string[]): Promise<WebhookStatus[]>;
  /** Starts the onboarding read of the whole catalog as a bulk operation; returns its ID. */
  startCatalogRead(): Promise<string>;
  /** A bulk operation's state; `url` is set when it completed with results. */
  bulkOperation(id: string): Promise<BulkOperationState>;
  /** Downloads and parses a completed catalog read. */
  fetchCatalog(url: string): Promise<CatalogProduct[]>;
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
  available: `query($item: ID!, $location: ID!) {
    inventoryItem(id: $item) {
      id
      inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } }
    }
  }`,
  setAvailable: `mutation($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) {
      inventoryAdjustmentGroup { id }
      userErrors { code field message }
    }
  }`,
  orders: `query($query: String!) {
    orders(first: 50, sortKey: CREATED_AT, reverse: true, query: $query) {
      nodes { id createdAt lineItems(first: 100) { nodes { id quantity variant { id } } } }
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
        description: typeof row.description === 'string' && row.description ? row.description : null,
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
      const image = row.image as { url: string; width: number | null; height: number | null } | null;
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
  ORDERS_CREATE: ['id', 'created_at', 'line_items'],
};

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
): ShopifyAdmin {
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

    async getAvailable(inventoryItemId, locationId) {
      const data = await call<{
        inventoryItem: {
          inventoryLevel: { quantities: Array<{ name: string; quantity: number }> } | null;
        } | null;
      }>(QUERIES.available, {
        item: gid('InventoryItem', inventoryItemId),
        location: gid('Location', locationId),
      });
      const level = data.inventoryItem?.inventoryLevel;
      if (!level) return null;
      return level.quantities.find((q) => q.name === 'available')?.quantity ?? null;
    },

    async setAvailable(input) {
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
          quantities: [
            {
              inventoryItemId: gid('InventoryItem', input.inventoryItemId),
              locationId: gid('Location', input.locationId),
              quantity: input.quantity,
              changeFromQuantity: input.from,
            },
          ],
        },
      });
      const errors = data.inventorySetQuantities.userErrors;
      if (errors.length === 0) return { kind: 'set' };
      if (errors.some((e) => e.code === 'CHANGE_FROM_QUANTITY_STALE')) return { kind: 'stale' };
      const first = errors[0]!;
      throw new ShopifyApiError(
        first.message,
        200,
        first.code === 'IDEMPOTENCY_CONCURRENT_REQUEST',
        first.code ?? undefined,
      );
    },

    async ordersSince(since) {
      const data = await call<{
        orders: {
          nodes: Array<{
            id: string;
            createdAt: string;
            lineItems: {
              nodes: Array<{ id: string; quantity: number; variant: { id: string } | null }>;
            };
          }>;
        };
      }>(QUERIES.orders, { query: `created_at:>='${since}'` });
      return data.orders.nodes.map((o) => ({
        orderId: numeric(o.id),
        createdAt: o.createdAt,
        lines: o.lineItems.nodes.map((l) => ({
          lineId: numeric(l.id),
          variantId: l.variant ? numeric(l.variant.id) : null,
          quantity: l.quantity,
        })),
      }));
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
      if (!url.startsWith('https://')) throw new ShopifyApiError('Unexpected result URL.', 0, false);
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
