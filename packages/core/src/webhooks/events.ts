// The webhook event-type registry (D14). Nothing about event types is hard-coded elsewhere: the
// API lists these, the dashboard renders its checklist from that list, the docs catalog is
// generated from it, and the dispatcher builds each event's `data` with its builder.
//
// Adding a type (I1–I6): see docs/webhooks.md, "Adding an event type". In short, give the type a
// data schema, a sample, and a builder (or keep `passthrough`), set it `available`, and emit it
// with `webhookEvent(type, input)` in the command's `webhooks` result, or with
// `insertWebhookEvents(tx, …)` in a job. Emitting writes the outbox row in the same transaction
// as the change, and only when the shop has an active subscription to that type.

import type { Tx } from '@airstock/db';
import { z } from 'zod';
import type { AuditEvent } from '../audit.ts';
import { UUID_PATTERN } from '../ids.ts';
import type { Permission } from '../permissions.ts';

/** The envelope's `api_version`. Changes that break consumers get a new version. */
export const WEBHOOK_API_VERSION = 'v1';

/** Outbox topic of domain events bound for webhooks; the dispatcher fans them out. */
export const WEBHOOK_EVENT_TOPIC = 'webhook.event';
/** Outbox topic that sends one stored delivery right after commit (Send test, replay). */
export const WEBHOOK_DELIVER_TOPIC = 'webhook.deliver';

/** Alert kinds a subscription can filter on (plan Section 5.9). I3 adds kinds here. */
export const WEBHOOK_ALERT_KINDS = [
  'low_stock',
  'lot_expiring',
  'shortage',
  'shopify_sync',
  'reconciliation_mismatch',
] as const;

export type WebhookFilter = 'locations' | 'alertKinds';

/** What a builder returns: the `data` snapshot and what the filters match on. */
export interface BuiltWebhookEvent {
  data: unknown;
  /** Leaf location IDs the event is about (matched against location filters). */
  locationIds?: string[];
  alertKind?: string | null;
}

export interface WebhookEventType {
  id: string;
  /** One sentence for the settings checklist and the docs catalog. */
  description: string;
  /**
   * `available`: offered in the dashboard and accepted by the API. `coming`: registered so the
   * catalog is complete, listed by the API, hidden in the dashboard and refused until the
   * milestone that emits it makes it available.
   */
  status: 'available' | 'coming';
  /** The person who subscribes must hold this, since the events carry these fields. */
  permission: Permission;
  /** The filters that apply; other filters on a subscription are ignored for this type. */
  filters: readonly WebhookFilter[];
  /** The shape of `data` (docs and tests). */
  data: z.ZodType;
  /** An example `data`, shown in the dashboard and docs and sent by "Send test" for this type. */
  sample: unknown;
  /**
   * Builds `data` when the event is dispatched, inside a transaction in the shop. Commands emit
   * references (IDs), so the business transaction stays cheap; snapshots carry versions, so a
   * consumer can drop an older update that arrives late. Null drops the event.
   */
  build(tx: Tx, input: unknown): Promise<BuiltWebhookEvent | null>;
}

/** An event emitted by a command or job; becomes one outbox row (`webhook.event`). */
export interface WebhookEmit {
  type: string;
  input: unknown;
}

/** For types whose emitter builds `data` itself, inside its transaction. */
const PassthroughInput = z.object({
  data: z.unknown(),
  locationIds: z.array(z.string()).optional(),
  alertKind: z.string().nullable().optional(),
});

async function passthrough(_tx: Tx, input: unknown): Promise<BuiltWebhookEvent | null> {
  const parsed = PassthroughInput.safeParse(input);
  if (!parsed.success) return null;
  return {
    data: parsed.data.data,
    locationIds: (parsed.data.locationIds ?? []).filter((id) => UUID_PATTERN.test(id)),
    alertKind: parsed.data.alertKind ?? null,
  };
}

// stock.changed ---------------------------------------------------------------------------------

const Location = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  warehouseId: z.string(),
});

const StockPosition = z.object({
  positionId: z.string(),
  variantId: z.string(),
  productId: z.string(),
  sku: z.string(),
  name: z.string(),
  location: Location,
  condition: z.string(),
  lotId: z.string().nullable(),
  lotCode: z.string().nullable(),
  expiresOn: z.string().nullable(),
  serialId: z.string().nullable(),
  serial: z.string().nullable(),
  onHand: z.string(),
  reserved: z.string(),
  available: z.string(),
  version: z.number().int(),
});

const StockChanged = z.object({
  reason: z.string().nullable(),
  positions: z.array(StockPosition),
  truncated: z.boolean(),
});

/** Payload of the `inventory.availability_changed` outbox topic, which stock.changed reads. */
const AvailabilityChanged = z.object({
  variantId: z.string().optional(),
  locationIds: z.array(z.string()).optional(),
  positionIds: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

const MAX_POSITIONS = 1000;

async function buildStockChanged(tx: Tx, input: unknown): Promise<BuiltWebhookEvent | null> {
  const parsed = AvailabilityChanged.safeParse(input);
  if (!parsed.success) return null;
  const p = parsed.data;
  const variantId = p.variantId && UUID_PATTERN.test(p.variantId) ? p.variantId : null;
  const locationIds = (p.locationIds ?? []).filter((id) => UUID_PATTERN.test(id));
  const positionIds = (p.positionIds ?? []).filter((id) => UUID_PATTERN.test(id));
  // Reserved and available come from stock_positions(), the one definition every stock read
  // uses (reservation and lot expiry, in-transit stock), as they are when the event is sent.
  const rows = await tx.query<{
    position_id: string;
    variant_id: string;
    product_id: string;
    sku: string;
    name: string;
    location_id: string;
    location_name: string;
    location_path: string;
    warehouse_id: string;
    condition: string;
    lot_id: string | null;
    lot_code: string | null;
    expires_on: string | null;
    serial_id: string | null;
    serial: string | null;
    on_hand: string;
    reserved: string;
    available: string;
    version: string;
  }>(
    `with targets as (
       select p.id, p.variant_id from inventory_positions p
       where $1::uuid is not null and p.variant_id = $1 and p.location_id = any($2::uuid[])
       union
       select p.id, p.variant_id from inventory_positions p where p.id = any($3::uuid[]))
     select sp.position_id, sp.variant_id, v.product_id, v.sku,
       coalesce(nullif(v.name, ''), pr.name) as name,
       sp.location_id, l.name as location_name, sp.location_path, sp.warehouse_id, sp.condition,
       sp.lot_id, lt.code as lot_code, sp.expires_on::text, sp.serial_id, su.serial,
       sp.on_hand::text, sp.reserved::text, sp.available::text, p.version::text
     from stock_positions(array(select distinct variant_id from targets)) sp
     join targets t on t.id = sp.position_id
     join inventory_positions p on p.shop_id = app_shop_id() and p.id = sp.position_id
     join variants v on v.shop_id = p.shop_id and v.id = sp.variant_id
     join products pr on pr.shop_id = v.shop_id and pr.id = v.product_id
     join locations l on l.shop_id = p.shop_id and l.id = sp.location_id
     left join lots lt on lt.shop_id = p.shop_id and lt.id = sp.lot_id
     left join serial_units su on su.shop_id = p.shop_id and su.id = sp.serial_id
     order by sp.location_path, v.sku, sp.condition, sp.position_id
     limit $4`,
    [variantId, locationIds, positionIds, MAX_POSITIONS + 1],
  );
  if (rows.length === 0) return null;
  const positions = rows.slice(0, MAX_POSITIONS).map((r) => ({
    positionId: r.position_id,
    variantId: r.variant_id,
    productId: r.product_id,
    sku: r.sku,
    name: r.name,
    location: {
      id: r.location_id,
      name: r.location_name,
      path: r.location_path,
      warehouseId: r.warehouse_id,
    },
    condition: r.condition,
    lotId: r.lot_id,
    lotCode: r.lot_code,
    expiresOn: r.expires_on,
    serialId: r.serial_id,
    serial: r.serial,
    onHand: r.on_hand,
    reserved: r.reserved,
    available: r.available,
    version: Number(r.version),
  }));
  return {
    data: { reason: p.reason ?? null, positions, truncated: rows.length > MAX_POSITIONS },
    locationIds: [...new Set(positions.map((x) => x.location.id))],
  };
}

// catalog.item.changed --------------------------------------------------------------------------

const CatalogChange = z.enum(['created', 'updated', 'archived', 'restored']);

const CatalogItem = z.object({
  change: CatalogChange,
  product: z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    version: z.number().int(),
  }),
  variant: z
    .object({
      id: z.string(),
      sku: z.string(),
      name: z.string().nullable(),
      price: z.string().nullable(),
      status: z.string(),
      version: z.number().int(),
    })
    .nullable(),
});

const CatalogItemChanged = z.object({
  operation: z.string(),
  items: z.array(CatalogItem),
  truncated: z.boolean(),
});

const CatalogInput = z.object({
  operation: z.string(),
  items: z.array(
    z.object({ type: z.enum(['product', 'variant']), id: z.string(), change: CatalogChange }),
  ),
  truncated: z.boolean().optional(),
});

const MAX_CATALOG_ITEMS = 200;

async function buildCatalogItemChanged(tx: Tx, input: unknown): Promise<BuiltWebhookEvent | null> {
  const parsed = CatalogInput.safeParse(input);
  if (!parsed.success) return null;
  const refs = parsed.data.items.filter((i) => UUID_PATTERN.test(i.id));
  const productIds = refs.filter((i) => i.type === 'product').map((i) => i.id);
  const variantIds = refs.filter((i) => i.type === 'variant').map((i) => i.id);
  const products = await tx.query<{ id: string; name: string; status: string; version: number }>(
    'select id, name, status, version from products where id = any($1::uuid[])',
    [productIds],
  );
  const variants = await tx.query<{
    id: string;
    product_id: string;
    sku: string;
    name: string | null;
    price: string | null;
    status: string;
    version: number;
    product_name: string;
    product_status: string;
    product_version: number;
  }>(
    `select v.id, v.product_id, v.sku, v.name, v.price::text as price, v.status, v.version,
         p.name as product_name, p.status as product_status, p.version as product_version
       from variants v join products p on p.shop_id = v.shop_id and p.id = v.product_id
     where v.id = any($1::uuid[])`,
    [variantIds],
  );
  const productById = new Map(products.map((p) => [p.id, p]));
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const items: z.infer<typeof CatalogItem>[] = [];
  for (const ref of refs) {
    if (ref.type === 'product') {
      const p = productById.get(ref.id);
      if (!p) continue;
      items.push({
        change: ref.change,
        product: { id: p.id, name: p.name, status: p.status, version: p.version },
        variant: null,
      });
    } else {
      const v = variantById.get(ref.id);
      if (!v) continue;
      items.push({
        change: ref.change,
        product: {
          id: v.product_id,
          name: v.product_name,
          status: v.product_status,
          version: v.product_version,
        },
        variant: {
          id: v.id,
          sku: v.sku,
          name: v.name,
          price: v.price,
          status: v.status,
          version: v.version,
        },
      });
    }
  }
  if (items.length === 0) return null;
  return {
    data: { operation: parsed.data.operation, items, truncated: parsed.data.truncated ?? false },
  };
}

function catalogChange(action: string): z.infer<typeof CatalogChange> {
  if (/\.(created|generated)$/.test(action)) return 'created';
  if (action.endsWith('.archived')) return 'archived';
  if (action.endsWith('.restored')) return 'restored';
  return 'updated';
}

/**
 * `catalog.item.changed` for a catalog command, from the events it commits: one event per
 * command naming the products and variants it created, changed, archived, or restored. Called
 * by the pipeline, so no catalog command needs its own hook. Imports announce `job.completed`
 * instead of one event per row.
 */
export function catalogChangeEmit(operationId: string, events: AuditEvent[]): WebhookEmit | null {
  if (!operationId.startsWith('catalog.')) return null;
  const seen = new Map<string, { type: 'product' | 'variant'; id: string; change: string }>();
  for (const e of events) {
    if (e.phase !== 'outcome' || e.outcome !== 'succeeded') continue;
    if (e.target_type !== 'product' && e.target_type !== 'variant') continue;
    if (!e.target_id || !UUID_PATTERN.test(e.target_id)) continue;
    const key = `${e.target_type}:${e.target_id}`;
    const change = catalogChange(e.action);
    const prior = seen.get(key);
    // A creation or archive says more than an update of the same record in the same command.
    if (!prior || prior.change === 'updated') {
      seen.set(key, { type: e.target_type, id: e.target_id, change });
    }
  }
  if (seen.size === 0) return null;
  const items = [...seen.values()];
  return webhookEvent('catalog.item.changed', {
    operation: operationId,
    items: items.slice(0, MAX_CATALOG_ITEMS),
    truncated: items.length > MAX_CATALOG_ITEMS,
  });
}

// job.completed ---------------------------------------------------------------------------------

const JobCompleted = z.object({
  job: z.object({
    kind: z.enum(['import', 'export']),
    id: z.string(),
    status: z.enum(['completed', 'failed']),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
    error: z.string().nullable(),
    fileName: z.string().nullable(),
    rows: z.number().int().nullable(),
    counts: z.record(z.string(), z.number()).nullable(),
  }),
});

const JobInput = z.object({ kind: z.enum(['import', 'export']), id: z.string() });

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

async function buildJobCompleted(tx: Tx, input: unknown): Promise<BuiltWebhookEvent | null> {
  const parsed = JobInput.safeParse(input);
  if (!parsed.success || !UUID_PATTERN.test(parsed.data.id)) return null;
  const { kind, id } = parsed.data;
  if (kind === 'import') {
    const [row] = await tx.query<{
      status: string;
      created_at: Date;
      completed_at: Date | null;
      error: string | null;
      file_name: string;
      counts: Record<string, number>;
    }>(
      'select status, created_at, completed_at, error, file_name, counts from import_jobs where id = $1',
      [id],
    );
    if (!row || (row.status !== 'completed' && row.status !== 'failed')) return null;
    const counts = Object.fromEntries(
      Object.entries(row.counts ?? {}).filter(([, v]) => typeof v === 'number'),
    );
    return {
      data: {
        job: {
          kind,
          id,
          status: row.status,
          createdAt: iso(row.created_at)!,
          completedAt: iso(row.completed_at),
          error: row.error,
          fileName: row.file_name,
          rows: null,
          counts,
        },
      },
    };
  }
  const [row] = await tx.query<{
    status: string;
    created_at: Date;
    completed_at: Date | null;
    error: string | null;
    row_count: number | null;
  }>('select status, created_at, completed_at, error, row_count from export_jobs where id = $1', [
    id,
  ]);
  if (!row || (row.status !== 'completed' && row.status !== 'failed')) return null;
  return {
    data: {
      job: {
        kind,
        id,
        status: row.status,
        createdAt: iso(row.created_at)!,
        completedAt: iso(row.completed_at),
        error: row.error,
        fileName: null,
        rows: row.row_count,
        counts: null,
      },
    },
  };
}

// webhook.test ----------------------------------------------------------------------------------

const WebhookTest = z.object({
  message: z.string(),
  subscription: z.object({ id: z.string(), name: z.string() }),
});

// The registry ----------------------------------------------------------------------------------

const SAMPLE_IDS = {
  shop: '0193a1b2-0000-7000-8000-000000000001',
  product: '0193a1b2-0000-7000-8000-000000000010',
  variant: '0193a1b2-0000-7000-8000-000000000011',
  warehouse: '0193a1b2-0000-7000-8000-000000000020',
  location: '0193a1b2-0000-7000-8000-000000000021',
  position: '0193a1b2-0000-7000-8000-000000000030',
  job: '0193a1b2-0000-7000-8000-000000000040',
  subscription: '0193a1b2-0000-7000-8000-000000000050',
  alert: '0193a1b2-0000-7000-8000-000000000060',
  reservation: '0193a1b2-0000-7000-8000-000000000070',
  transfer: '0193a1b2-0000-7000-8000-000000000080',
  purchaseOrder: '0193a1b2-0000-7000-8000-000000000090',
  return: '0193a1b2-0000-7000-8000-0000000000a0',
} as const;

const sampleLocation = {
  id: SAMPLE_IDS.location,
  name: 'A1',
  path: 'Main warehouse/A1',
  warehouseId: SAMPLE_IDS.warehouse,
};

const ComingStatus = z.object({ from: z.string().nullable(), to: z.string() });

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = [
  {
    id: 'stock.changed',
    description:
      'Stock changed: one event per operation (receipt, reservation, release, expiry, import, and the stock commands to come), naming every position it changed with SKU, location, lot or serial, on hand, reserved, available, and the position version.',
    status: 'available',
    permission: 'inventory.read',
    filters: ['locations'],
    data: StockChanged,
    sample: {
      reason: null,
      positions: [
        {
          positionId: SAMPLE_IDS.position,
          variantId: SAMPLE_IDS.variant,
          productId: SAMPLE_IDS.product,
          sku: 'ETB-PRE-01',
          name: 'Prismatic Evolutions Elite Trainer Box',
          location: sampleLocation,
          condition: 'sellable',
          lotId: null,
          lotCode: null,
          expiresOn: null,
          serialId: null,
          serial: null,
          onHand: '12',
          reserved: '3',
          available: '9',
          version: 7,
        },
      ],
      truncated: false,
    },
    build: buildStockChanged,
  },
  {
    id: 'catalog.item.changed',
    description:
      'A product or variant was created, changed, archived, or restored: one event per command, naming each record with its SKU, name, price, status, and version.',
    status: 'available',
    permission: 'catalog.read',
    filters: [],
    data: CatalogItemChanged,
    sample: {
      operation: 'catalog.items.update',
      items: [
        {
          change: 'updated',
          product: {
            id: SAMPLE_IDS.product,
            name: 'Prismatic Evolutions Elite Trainer Box',
            status: 'active',
            version: 3,
          },
          variant: {
            id: SAMPLE_IDS.variant,
            sku: 'ETB-PRE-01',
            name: null,
            price: '59.990000',
            status: 'active',
            version: 4,
          },
        },
      ],
      truncated: false,
    },
    build: buildCatalogItemChanged,
  },
  {
    id: 'job.completed',
    description:
      'An import or export finished, successfully or not, with its counts or row total. Download an export through the API or the dashboard.',
    status: 'available',
    permission: 'shop.read',
    filters: [],
    data: JobCompleted,
    sample: {
      job: {
        kind: 'import',
        id: SAMPLE_IDS.job,
        status: 'completed',
        createdAt: '2026-11-16T09:00:00.000Z',
        completedAt: '2026-11-16T09:00:12.000Z',
        error: null,
        fileName: 'products.csv',
        rows: null,
        counts: { done: 300, failed: 0, skipped: 0, stock_failed: 0 },
      },
    },
    build: buildJobCompleted,
  },
  {
    id: 'webhook.test',
    description: 'Sent by "Send test" in the dashboard or the API, to check the endpoint.',
    status: 'available',
    permission: 'webhooks.manage',
    filters: [],
    data: WebhookTest,
    sample: {
      message: 'Test event from Airstock.',
      subscription: { id: SAMPLE_IDS.subscription, name: 'n8n stock flow' },
    },
    build: passthrough,
  },
  // Registered now so the catalog is complete; each becomes available with its milestone.
  {
    id: 'alert.opened',
    description: 'An alert opened, such as low stock or a lot nearing expiry (I3).',
    status: 'coming',
    permission: 'inventory.read',
    filters: ['locations', 'alertKinds'],
    data: z.object({ alert: z.record(z.string(), z.unknown()) }),
    sample: {
      alert: {
        id: SAMPLE_IDS.alert,
        kind: 'low_stock',
        variantId: SAMPLE_IDS.variant,
        sku: 'ETB-PRE-01',
        warehouseId: SAMPLE_IDS.warehouse,
        available: '2',
        reorderPoint: '5',
        openedAt: '2026-11-16T09:00:00.000Z',
      },
    },
    build: passthrough,
  },
  {
    id: 'alert.resolved',
    description: 'An alert resolved because stock recovered, or was acknowledged (I3).',
    status: 'coming',
    permission: 'inventory.read',
    filters: ['locations', 'alertKinds'],
    data: z.object({ alert: z.record(z.string(), z.unknown()) }),
    sample: {
      alert: {
        id: SAMPLE_IDS.alert,
        kind: 'low_stock',
        variantId: SAMPLE_IDS.variant,
        sku: 'ETB-PRE-01',
        resolvedAt: '2026-11-17T09:00:00.000Z',
        resolution: 'recovered',
      },
    },
    build: passthrough,
  },
  {
    id: 'reservation.shortage',
    description: 'A connector order was reserved with a shortage it could not cover (I1).',
    status: 'coming',
    permission: 'inventory.read',
    filters: ['locations'],
    data: z.object({ reservation: z.record(z.string(), z.unknown()) }),
    sample: {
      reservation: {
        id: SAMPLE_IDS.reservation,
        sku: 'ETB-PRE-01',
        quantity: '3',
        shortageQuantity: '1',
        externalRef: 'shopify:order/1001/line/1',
      },
    },
    build: passthrough,
  },
  {
    id: 'transfer.status_changed',
    description: 'A transfer moved to another state, such as dispatched or received (I2).',
    status: 'coming',
    permission: 'inventory.read',
    filters: ['locations'],
    data: z.object({ transfer: z.record(z.string(), z.unknown()), status: ComingStatus }),
    sample: {
      transfer: { id: SAMPLE_IDS.transfer, reference: 'TR-0001' },
      status: { from: 'ready', to: 'dispatched' },
    },
    build: passthrough,
  },
  {
    id: 'purchase_order.status_changed',
    description: 'A purchase order moved to another state, such as sent or received (I3).',
    status: 'coming',
    permission: 'inventory.read',
    filters: ['locations'],
    data: z.object({ purchaseOrder: z.record(z.string(), z.unknown()), status: ComingStatus }),
    sample: {
      purchaseOrder: { id: SAMPLE_IDS.purchaseOrder, number: 'PO-0001' },
      status: { from: 'sent', to: 'partially_received' },
    },
    build: passthrough,
  },
  {
    id: 'return.status_changed',
    description: 'A return moved to another state, such as received or inspected (I2).',
    status: 'coming',
    permission: 'inventory.read',
    filters: ['locations'],
    data: z.object({ return: z.record(z.string(), z.unknown()), status: ComingStatus }),
    sample: {
      return: { id: SAMPLE_IDS.return, reference: 'RMA-0001' },
      status: { from: 'received', to: 'inspected' },
    },
    build: passthrough,
  },
  {
    id: 'shopify.sync_conflict',
    description:
      'Shopify and Airstock disagree on a quantity or field that no order explains (I6).',
    status: 'coming',
    permission: 'inventory.read',
    filters: ['locations'],
    data: z.object({ conflict: z.record(z.string(), z.unknown()) }),
    sample: {
      conflict: {
        kind: 'quantity',
        sku: 'ETB-PRE-01',
        locationId: SAMPLE_IDS.location,
        airstock: '9',
        shopify: '11',
      },
    },
    build: passthrough,
  },
];

export const webhookEventTypes: ReadonlyMap<string, WebhookEventType> = new Map(
  WEBHOOK_EVENT_TYPES.map((t) => [t.id, t]),
);

/** The sample envelope for a type, as the dashboard and the docs show it. */
export function sampleEnvelope(type: WebhookEventType) {
  return {
    id: '0193a1b2-0000-7000-8000-0000000000ff',
    type: type.id,
    created_at: '2026-11-16T09:00:00.000Z',
    shop_id: SAMPLE_IDS.shop,
    api_version: WEBHOOK_API_VERSION,
    data: type.sample,
  };
}

/** A domain event for the outbox. Throws for an unknown type, so a typo fails in tests. */
export function webhookEvent(type: string, input: unknown): WebhookEmit {
  if (!webhookEventTypes.has(type)) throw new Error(`Unknown webhook event type: ${type}`);
  return { type, input };
}

/**
 * Inserts emitted events as outbox rows, each only when the shop has an active subscription to
 * its type, so shops without webhooks pay one index probe. `$1` is a JSON array of
 * `{id, type, input}`. Used inside the business transaction (pipeline and jobs).
 */
export const INSERT_WEBHOOK_OUTBOX_SQL = `insert into outbox_events (shop_id, id, topic, payload)
  select app_shop_id(), x.id, '${WEBHOOK_EVENT_TOPIC}', jsonb_build_object('type', x.type, 'input', x.input)
  from jsonb_to_recordset($1::jsonb) as x(id uuid, type text, input jsonb)
  where exists (select 1 from webhook_subscriptions s
    where s.shop_id = app_shop_id() and s.status = 'active' and x.type = any(s.event_types))
  returning id`;

/** For jobs and sweeps that write outside the pipeline: same rule, inside their transaction. */
export async function insertWebhookEvents(
  tx: Tx,
  emits: WebhookEmit[],
  newId: () => string,
): Promise<number> {
  if (emits.length === 0) return 0;
  const rows = await tx.query(INSERT_WEBHOOK_OUTBOX_SQL, [
    JSON.stringify(emits.map((e) => ({ id: newId(), type: e.type, input: e.input }))),
  ]);
  return rows.length;
}
