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
  /** Reverse fulfillment orders (one per return) and their orders. */
  private readonly reverseOrders = new Map<string, string>();

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
    const now = new Date().toISOString();
    const order: ShopifyOrder = {
      orderId: String(this.nextId++),
      createdAt: now,
      updatedAt: now,
      cancelledAt: null,
      lines: lines.map((l) => ({
        lineId: String(this.nextId++),
        variantId: l.variant.variantId,
        quantity: l.quantity,
        currentQuantity: l.quantity,
        locationId: location,
      })),
      fulfillments: [],
      refunds: [],
    };
    for (const l of lines) this.take(l.variant.variantId, location, l.quantity);
    this.orders.push(order);
    return order;
  }

  private itemOf(variantId: string | null): string | undefined {
    return this.variants.find((v) => v.variantId === variantId)?.inventoryItemId;
  }

  /** Shopify's own change of `available` (an order takes, a restock gives back). */
  private take(variantId: string | null, location: string, quantity: number) {
    const item = this.itemOf(variantId);
    if (!item) return;
    const k = this.key(item, location);
    this.levels.set(k, (this.levels.get(k) ?? 0) - quantity);
  }

  private touch(order: ShopifyOrder) {
    order.updatedAt = new Date(Date.now() + 1).toISOString();
  }

  /** An order edit: a new quantity for a line; removed units are restocked, as Shopify's default. */
  editLine(order: ShopifyOrder, lineId: string, quantity: number) {
    const line = order.lines.find((l) => l.lineId === lineId)!;
    const before = line.currentQuantity ?? line.quantity;
    line.currentQuantity = quantity;
    if (quantity > line.quantity) line.quantity = quantity;
    this.take(line.variantId, line.locationId ?? '1001', quantity - before);
    this.touch(order);
  }

  addLine(order: ShopifyOrder, variant: ShopifyVariant, quantity: number, location = '1001') {
    const line = {
      lineId: String(this.nextId++),
      variantId: variant.variantId,
      quantity,
      currentQuantity: quantity,
      locationId: location,
    };
    order.lines.push(line);
    this.take(variant.variantId, location, quantity);
    this.touch(order);
    return line;
  }

  fulfill(
    order: ShopifyOrder,
    lines: Array<{ lineId: string; quantity: number }> | null = null,
    location = '1001',
  ) {
    const fulfillment = {
      fulfillmentId: String(this.nextId++),
      status: 'success' as const,
      locationId: location,
      createdAt: new Date().toISOString(),
      lines:
        lines ??
        order.lines.map((l) => ({ lineId: l.lineId, quantity: l.currentQuantity ?? l.quantity })),
    };
    order.fulfillments!.push(fulfillment);
    this.touch(order);
    return fulfillment;
  }

  cancelFulfillment(order: ShopifyOrder, fulfillmentId: string) {
    order.fulfillments!.find((f) => f.fulfillmentId === fulfillmentId)!.status = 'cancelled';
    this.touch(order);
  }

  /** A refund; a restock gives the units back to Shopify's available at its location. */
  refund(
    order: ShopifyOrder,
    lines: Array<{
      lineId: string;
      quantity: number;
      restockType: 'cancel' | 'return' | 'no_restock';
      location?: string;
    }>,
  ) {
    const refund = {
      refundId: String(this.nextId++),
      createdAt: new Date().toISOString(),
      lines: lines.map((l) => ({
        lineId: l.lineId,
        quantity: l.quantity,
        restockType: l.restockType,
        locationId: l.restockType === 'no_restock' ? null : (l.location ?? '1001'),
      })),
    };
    for (const l of lines) {
      const line = order.lines.find((x) => x.lineId === l.lineId)!;
      line.currentQuantity = (line.currentQuantity ?? line.quantity) - l.quantity;
      if (l.restockType !== 'no_restock')
        this.take(line.variantId, l.location ?? '1001', -l.quantity);
    }
    order.refunds!.push(refund);
    this.touch(order);
    return refund;
  }

  /**
   * A return in Shopify's return flow, processed: each line's units are disposed (a restock gives
   * them back to Shopify's available at the location), and with `refund` a refund is issued
   * through the return, without a restock of its own.
   */
  returnItems(
    order: ShopifyOrder,
    lines: Array<{
      lineId: string;
      quantity: number;
      type: 'restocked' | 'not_restocked' | 'processing_required' | 'missing';
      location?: string;
    }>,
    opts: { refund?: boolean } = {},
  ) {
    const now = new Date().toISOString();
    const ret = {
      returnId: String(this.nextId++),
      reverseFulfillmentOrderId: String(this.nextId++),
      refundIds: [] as string[],
      dispositions: lines.map((l) => ({
        dispositionId: String(this.nextId++),
        lineId: l.lineId,
        quantity: l.quantity,
        type: l.type,
        locationId: l.type === 'restocked' ? (l.location ?? '1001') : null,
        createdAt: now,
      })),
    };
    for (const l of lines) {
      if (l.type !== 'restocked') continue;
      const line = order.lines.find((x) => x.lineId === l.lineId)!;
      this.take(line.variantId, l.location ?? '1001', -l.quantity);
    }
    if (opts.refund) {
      const perLine = new Map<string, number>();
      for (const l of lines) perLine.set(l.lineId, (perLine.get(l.lineId) ?? 0) + l.quantity);
      const refund = this.refund(
        order,
        [...perLine].map(([lineId, quantity]) => ({
          lineId,
          quantity,
          restockType: 'no_restock' as const,
        })),
      );
      ret.refundIds.push(refund.refundId);
    }
    this.reverseOrders.set(ret.reverseFulfillmentOrderId, order.orderId);
    order.returns ??= [];
    order.returns.push({
      returnId: ret.returnId,
      refundIds: ret.refundIds,
      dispositions: ret.dispositions,
    });
    this.touch(order);
    return ret;
  }

  /** Cancels an order: unfulfilled units are refunded with restock (Shopify's default). */
  cancel(order: ShopifyOrder) {
    const fulfilled = new Map<string, number>();
    for (const f of order.fulfillments ?? []) {
      if (f.status !== 'success') continue;
      for (const l of f.lines) fulfilled.set(l.lineId, (fulfilled.get(l.lineId) ?? 0) + l.quantity);
    }
    const lines = order.lines
      .map((l) => ({
        lineId: l.lineId,
        quantity: (l.currentQuantity ?? l.quantity) - (fulfilled.get(l.lineId) ?? 0),
        restockType: 'cancel' as const,
        location: l.locationId ?? '1001',
      }))
      .filter((l) => l.quantity > 0);
    if (lines.length > 0) this.refund(order, lines);
    order.cancelledAt = new Date().toISOString();
    this.touch(order);
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

  /** The (limited) body of another order topic: the IDs that name the order. */
  topicBody(topic: string, order: ShopifyOrder, id = '1'): string {
    if (topic === 'orders/edited') {
      return JSON.stringify({ order_edit: { id: Number(id), order_id: Number(order.orderId) } });
    }
    if (topic === 'reverse_fulfillment_orders/dispose') {
      return JSON.stringify({
        id: Number(id),
        admin_graphql_api_id: `gid://shopify/ReverseFulfillmentOrder/${id}`,
      });
    }
    if (topic.startsWith('orders/')) {
      return JSON.stringify({
        id: Number(order.orderId),
        admin_graphql_api_id: `gid://shopify/Order/${order.orderId}`,
      });
    }
    return JSON.stringify({ id: Number(id), order_id: Number(order.orderId), status: 'success' });
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
    return structuredClone(this.orders.filter((o) => o.createdAt >= since).reverse());
  }
  async order(orderId: string) {
    const order = this.orders.find((o) => o.orderId === orderId);
    return order ? structuredClone(order) : null;
  }
  async ordersUpdatedSince(since: string) {
    const orders = this.orders
      .filter((o) => (o.updatedAt ?? o.createdAt) >= since)
      .sort((a, b) => ((a.updatedAt ?? '') < (b.updatedAt ?? '') ? -1 : 1));
    return { orders: structuredClone(orders), next: null };
  }
  async lineLocations(orderId: string) {
    const order = this.orders.find((o) => o.orderId === orderId);
    return new Map((order?.lines ?? []).map((l) => [l.lineId, l.locationId ?? '1001']));
  }
  async orderOfReverseFulfillmentOrder(id: string) {
    return this.reverseOrders.get(id) ?? null;
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
