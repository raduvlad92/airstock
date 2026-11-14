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
  createWebhook: `mutation($topic: WebhookSubscriptionTopic!, $subscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
      webhookSubscription { id topic uri }
      userErrors { field message }
    }
  }`,
};

/**
 * Minimal webhook payloads: only what turning an order into reservations needs. No customer
 * fields are requested (PRD 8.5).
 */
export const WEBHOOK_FIELDS: Record<string, string[] | undefined> = {
  ORDERS_CREATE: ['id', 'created_at', 'line_items'],
};

export function httpShopifyAdmin(
  shopDomain: string,
  accessToken: string,
  doFetch: typeof fetch = fetch,
): ShopifyAdmin {
  const endpoint = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  async function call<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-shopify-access-token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });
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
    };
    if (body.errors?.length) {
      const code = body.errors[0]?.extensions?.code;
      throw new ShopifyApiError(
        body.errors.map((e) => e.message).join('; '),
        200,
        code === 'THROTTLED' || code === 'INTERNAL_SERVER_ERROR',
        code,
      );
    }
    return body.data as T;
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
