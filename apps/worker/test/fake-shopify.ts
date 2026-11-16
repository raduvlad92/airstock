import type { CatalogImage, CatalogProduct } from '@airstock/core';
import {
  type BulkOperationState,
  SHOPIFY_SCOPES,
  type ShopifyAdmin,
  type ShopifyAuth,
  type ShopifyLocation,
  type ShopifyOrder,
  type ShopifyVariant,
  type TokenSet,
  type WebhookStatus,
} from '@airstock/shopify';

/**
 * An in-memory Shopify store with the behavior the sync depends on: an order lowers
 * `available` when Shopify accepts it, and `inventorySetQuantities` refuses a write whose
 * `changeFromQuantity` is not the current quantity.
 */
export class FakeStore implements ShopifyAdmin {
  readonly levels = new Map<string, number>();
  readonly orders: ShopifyOrder[] = [];
  readonly variants: ShopifyVariant[] = [];
  readonly sets: Array<{ item: string; location: string; from: number; to: number }> = [];
  readonly refused: Array<{ item: string; location: string; from: number; actual: number }> = [];
  readonly webhooks: Array<{ uri: string; topic: string }> = [];
  locationList: ShopifyLocation[] = [
    { id: '1001', name: 'Shop location', active: true },
    { id: '1002', name: 'Warehouse', active: true },
  ];
  /** Products for the onboarding read; variants added with addVariant get one each. */
  readonly products: Array<{
    productId: string;
    title: string;
    status: string;
    description: string | null;
    options: string[];
    images: CatalogImage[];
    variants: Array<{
      variant: ShopifyVariant;
      barcode: string | null;
      price: string | null;
      options: Array<{ name: string; value: string }>;
      image: CatalogImage | null;
    }>;
  }> = [];
  readonly bulkReads: string[] = [];
  /** Polls a bulk read answers "running" before it completes. */
  bulkPolls = 1;
  private polls = new Map<string, number>();
  private nextId = 5_000_000;

  constructor(readonly domain: string) {}

  key(item: string, location: string): string {
    return `${item}@${location}`;
  }

  addVariant(sku: string, quantity: number, location = '1001'): ShopifyVariant {
    const variant: ShopifyVariant = {
      variantId: String(this.nextId++),
      inventoryItemId: String(this.nextId++),
      sku,
      title: sku,
      tracked: true,
    };
    this.variants.push(variant);
    this.levels.set(this.key(variant.inventoryItemId, location), quantity);
    this.products.push({
      productId: String(this.nextId++),
      title: sku,
      status: 'ACTIVE',
      description: null,
      options: ['Title'],
      images: [],
      variants: [
        {
          variant,
          barcode: null,
          price: null,
          options: [{ name: 'Title', value: 'Default Title' }],
          image: null,
        },
      ],
    });
    return variant;
  }

  /** A product with options, barcodes, prices, pictures, and quantities per location. */
  addProduct(input: {
    title: string;
    status?: string;
    description?: string;
    options?: string[];
    images?: string[];
    variants: Array<{
      sku: string | null;
      barcode?: string;
      price?: string;
      options?: string[];
      quantities?: Record<string, number>;
      tracked?: boolean;
      image?: string;
    }>;
  }): ShopifyVariant[] {
    const optionNames = input.options ?? ['Title'];
    const out: ShopifyVariant[] = [];
    const product = {
      productId: String(this.nextId++),
      title: input.title,
      status: input.status ?? 'ACTIVE',
      description: input.description ?? null,
      options: optionNames,
      images: (input.images ?? []).map((url) => ({ url, alt: null, width: 2048, height: 2048 })),
      variants: [] as (typeof this.products)[number]['variants'],
    };
    for (const v of input.variants) {
      const variant: ShopifyVariant = {
        variantId: String(this.nextId++),
        inventoryItemId: String(this.nextId++),
        sku: v.sku ?? '',
        title: (v.options ?? ['Default Title']).join(' / '),
        tracked: v.tracked ?? true,
      };
      this.variants.push(variant);
      for (const [location, quantity] of Object.entries(v.quantities ?? {})) {
        this.levels.set(this.key(variant.inventoryItemId, location), quantity);
      }
      product.variants.push({
        variant,
        barcode: v.barcode ?? null,
        price: v.price ?? null,
        options: v.options
          ? v.options.map((value, i) => ({ name: optionNames[i]!, value }))
          : [{ name: 'Title', value: 'Default Title' }],
        image: v.image ? { url: v.image, alt: null, width: 800, height: 800 } : null,
      });
      out.push(variant);
    }
    this.products.push(product);
    return out;
  }

  async startCatalogRead() {
    const id = `gid://shopify/BulkOperation/${this.nextId++}`;
    this.bulkReads.push(id);
    return id;
  }
  async bulkOperation(id: string): Promise<BulkOperationState> {
    if (!this.bulkReads.includes(id)) return { status: 'failed', url: null, error: 'NOT_FOUND' };
    const polls = (this.polls.get(id) ?? 0) + 1;
    this.polls.set(id, polls);
    if (polls <= this.bulkPolls) return { status: 'running', url: null, error: null };
    return {
      status: 'completed',
      url: `https://storage.test/bulk/${id.split('/').pop()}`,
      error: null,
    };
  }
  async fetchCatalog(_url: string): Promise<CatalogProduct[]> {
    return this.products.map((p) => ({
      productId: p.productId,
      title: p.title,
      description: p.description,
      status: p.status,
      options: p.options,
      images: p.images,
      variants: p.variants.map((v) => ({
        variantId: v.variant.variantId,
        inventoryItemId: v.variant.inventoryItemId,
        sku: v.variant.sku || null,
        barcode: v.barcode,
        title: v.variant.title,
        price: v.price,
        options: v.options,
        tracked: v.variant.tracked,
        levels: this.locationList.flatMap((l) => {
          const q = this.levels.get(this.key(v.variant.inventoryItemId, l.id));
          return q === undefined ? [] : [{ locationId: l.id, available: q }];
        }),
        image: v.image,
      })),
    }));
  }

  /** A checkout: Shopify commits the units right away and returns the order. */
  placeOrder(lines: Array<{ variant: ShopifyVariant; quantity: number }>, location = '1001') {
    const order: ShopifyOrder = {
      orderId: String(this.nextId++),
      createdAt: new Date().toISOString(),
      lines: lines.map((l) => ({
        lineId: String(this.nextId++),
        variantId: l.variant.variantId,
        quantity: l.quantity,
      })),
    };
    for (const l of lines) {
      const k = this.key(l.variant.inventoryItemId, location);
      this.levels.set(k, (this.levels.get(k) ?? 0) - l.quantity);
    }
    this.orders.push(order);
    return order;
  }

  /** The orders/create webhook body Shopify would send for an order. */
  webhookBody(order: ShopifyOrder): string {
    return JSON.stringify({
      id: Number(order.orderId),
      admin_graphql_api_id: `gid://shopify/Order/${order.orderId}`,
      created_at: order.createdAt,
      line_items: order.lines.map((l) => ({
        id: Number(l.lineId),
        variant_id: Number(l.variantId),
        quantity: l.quantity,
      })),
    });
  }

  available(variant: ShopifyVariant, location = '1001'): number | undefined {
    return this.levels.get(this.key(variant.inventoryItemId, location));
  }

  async locations() {
    return this.locationList;
  }
  async variantsWithSku() {
    return this.variants;
  }
  async getAvailable(item: string, location: string) {
    return this.levels.get(this.key(item, location)) ?? null;
  }
  async setAvailable(input: {
    inventoryItemId: string;
    locationId: string;
    quantity: number;
    from: number;
  }) {
    const k = this.key(input.inventoryItemId, input.locationId);
    const actual = this.levels.get(k) ?? 0;
    if (actual !== input.from) {
      this.refused.push({
        item: input.inventoryItemId,
        location: input.locationId,
        from: input.from,
        actual,
      });
      return { kind: 'stale' as const };
    }
    this.levels.set(k, input.quantity);
    this.sets.push({
      item: input.inventoryItemId,
      location: input.locationId,
      from: input.from,
      to: input.quantity,
    });
    return { kind: 'set' as const };
  }
  async ordersSince(since: string) {
    return this.orders.filter((o) => o.createdAt >= since).reverse();
  }
  async ensureWebhooks(uri: string, topics: string[]): Promise<WebhookStatus[]> {
    return topics.map((topic) => {
      const exists = this.webhooks.some((w) => w.topic === topic && w.uri === uri);
      if (!exists) this.webhooks.push({ uri, topic });
      return { topic, status: exists ? 'already_subscribed' : 'subscribed' };
    });
  }
}

/** Shopify's token endpoint: codes map to stores; refreshes rotate the pair. */
export class FakeAuth implements ShopifyAuth {
  readonly codes = new Map<string, string>();
  refreshes = 0;
  accessLifetimeMs = 60 * 60 * 1000;

  tokens(prefix: string): TokenSet {
    const now = Date.now();
    return {
      accessToken: `shpat_${prefix}_${now}`,
      scopes: [...SHOPIFY_SCOPES],
      accessTokenExpiresAt: new Date(now + this.accessLifetimeMs),
      refreshToken: `shprt_${prefix}_${now}`,
      refreshTokenExpiresAt: new Date(now + 90 * 24 * 3600 * 1000),
    };
  }
  async exchangeCode(shopDomain: string, code: string) {
    if (this.codes.get(code) !== shopDomain) throw new Error('invalid code');
    this.codes.delete(code);
    return this.tokens('install');
  }
  async refresh(_shopDomain: string, refreshToken: string) {
    if (!refreshToken.startsWith('shprt_')) throw new Error('invalid refresh token');
    this.refreshes++;
    await new Promise((r) => setTimeout(r, 20));
    return this.tokens(`refresh${this.refreshes}`);
  }
}
