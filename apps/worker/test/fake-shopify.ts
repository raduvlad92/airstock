import {
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
    return variant;
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
