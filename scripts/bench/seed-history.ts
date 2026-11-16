/**
 * Audit history seed (Phase 2 plan, milestone I0; Phase 1 risk R7): about three months of
 * activity for the persona shops from seed-personas.ts, 1,000,000 events in all by default.
 *
 *   DATABASE_OWNER_URL=… tsx scripts/bench/seed-history.ts [--events 1000000] [--names 'Bench %']
 *     [--batch 5000] [--max-mb 850] [--seed 7] [--dry-run]
 *
 * Events use the real envelope (core `auditEvent`) and arrive through the function the audit queue
 * consumer calls, `ingest_audit_events`, in time order, into monthly partitions created the way
 * `ensure_audit_partitions` names them. Each shop's history starts with its setup and the catalog
 * import (one event per product, variant, and opening receipt, as the import job writes), then
 * follows a working pattern: weekdays busier than weekends, people in office hours, integrations
 * around the clock, and slow growth.
 *
 * The mix is made of activities rather than single events: dashboard sessions (grid queries, item
 * views, edits with one change event per record, client-reported interface events), phone
 * scanning with receipts, ChatGPT conversations through MCP, Shopify orders with reservations,
 * API syncs, catalog maintenance and bulk edits, exports, the expiry sweep, and the failures,
 * denials, conflicts, and replays that real callers cause. Mostly reads, as PRD 7.3 records every
 * read.
 *
 * Event targets are the shops' real variants, products, locations, and members. Operation and
 * reservation IDs in the history are made up: the ledger holds only the opening stock.
 *
 * Stops before the database passes --max-mb (the free plan refuses every write at 1 GB).
 */
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { type AuditEvent, auditEvent } from '../../packages/core/src/audit.ts';
import type { Caller, Source } from '../../packages/core/src/caller.ts';
import { uuidv7 } from '../../packages/core/src/ids.ts';
import { PERSONAS } from './personas.ts';

const { values: args } = parseArgs({
  options: {
    events: { type: 'string', default: '1000000' },
    names: { type: 'string', default: 'Bench %' },
    batch: { type: 'string', default: '5000' },
    'max-mb': { type: 'string', default: '850' },
    seed: { type: 'string', default: '7' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('Set DATABASE_OWNER_URL.');
const TARGET = Number(args.events);
const BATCH = Number(args.batch);
const MAX_BYTES = Number(args['max-mb']) * 1024 * 1024;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.now() - 5 * 60_000;

let state = createHash('sha256').update(args.seed).digest().readUInt32LE(0);
const rand = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
const chance = (p: number) => rand() < p;

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  client.query<T>(sql, params).then((r) => r.rows);

// Shops and what their events point at ---------------------------------------------------------

interface Member {
  userId: string;
  role: string;
}
interface Shop {
  id: string;
  name: string;
  key: string;
  share: number;
  shopify: boolean;
  start: number;
  owner: Member;
  members: Member[];
  credentialId: string;
  credentialUser: string;
  grantId: string;
  clientId: string;
  connectorId: string;
  products: string[];
  variants: Array<{ id: string; productId: string; sku: string }>;
  variantById: Map<string, { id: string; productId: string; sku: string }>;
  stocked: Array<{ variantId: string; locationIds: string[]; positionIds: string[] }>;
  leaves: string[];
  warehouses: string[];
  suppliers: string[];
  bundles: string[];
  fields: Array<{ key: string; type: string; options: string[] }>;
  importId: string;
  receipts: Array<{ variantId: string; locationId: string; positionId: string; quantity: string }>;
  counts: { products: number; variants: number; locations: number; fields: number };
  /** Events still to write after the import. */
  quota: number;
}

const shopRows = await q<{ id: string; name: string; created_at: Date }>(
  'select id, name, created_at from shops where name like $1 order by name',
  [args.names],
);
if (shopRows.length === 0)
  throw new Error(`No shops match ${args.names}. Run seed-personas.ts first.`);
const existing = await q<{ n: string }>(
  'select count(*)::text as n from audit_events where shop_id = any($1::uuid[])',
  [shopRows.map((s) => s.id)],
);
if (Number(existing[0]!.n) > 1000 && !args.force && !args['dry-run']) {
  throw new Error(
    `These shops already have ${existing[0]!.n} events. Clean up and reseed, or pass --force to add more.`,
  );
}

const shops: Shop[] = [];
for (const s of shopRows) {
  const persona = PERSONAS.find((p) => p.shopName === s.name);
  const members = await q<{ user_id: string; role: string }>(
    'select user_id, role from memberships where shop_id = $1 order by created_at, id',
    [s.id],
  );
  const [credential] = await q<{ id: string; user_id: string }>(
    `select c.id, m.user_id from api_credentials c join memberships m on m.shop_id = c.shop_id and m.id = c.membership_id
     where c.shop_id = $1 limit 1`,
    [s.id],
  );
  const [grant] = await q<{ id: string; client_id: string | null }>(
    'select id, client_id from connection_grants where shop_id = $1 limit 1',
    [s.id],
  );
  const variants = await q<{ id: string; product_id: string; sku: string }>(
    `select id, product_id, sku from variants where shop_id = $1 and status = 'active'`,
    [s.id],
  );
  const positions = await q<{ variant_id: string; location_ids: string[]; position_ids: string[] }>(
    `select variant_id, array_agg(location_id) as location_ids, array_agg(id) as position_ids
     from inventory_positions where shop_id = $1 group by variant_id`,
    [s.id],
  );
  const leaves = await q<{ id: string }>(
    `select l.id from locations l where l.shop_id = $1
       and not exists (select 1 from locations c where c.shop_id = l.shop_id and c.parent_id = l.id)`,
    [s.id],
  );
  const fields = await q<{ key: string; type: string; options: string[] }>(
    `select f.key, f.type, coalesce(array(select o.label from field_options o
       where o.shop_id = f.shop_id and o.field_id = f.id order by o.position), '{}') as options
     from field_definitions f where f.shop_id = $1`,
    [s.id],
  );
  const receipts = await q<{
    variant_id: string;
    location_id: string;
    position_id: string;
    quantity: string;
    external_ref: string;
  }>(
    `select e.variant_id, e.location_id, e.position_id, e.delta::text as quantity, o.external_ref
     from inventory_entries e join inventory_operations o on o.shop_id = e.shop_id and o.id = e.operation_id
     where e.shop_id = $1 and o.reason = 'opening stock' order by e.variant_id, e.location_id`,
    [s.id],
  );
  const [counts] = await q<{
    products: number;
    locations: number;
    warehouses: string[];
    suppliers: string[];
    bundles: string[];
  }>(
    `select (select count(*) from products where shop_id = $1)::int as products,
       (select count(*) from locations where shop_id = $1)::int as locations,
       array(select id::text from warehouses where shop_id = $1) as warehouses,
       array(select id::text from suppliers where shop_id = $1) as suppliers,
       array(select variant_id::text from bundles where shop_id = $1 and active) as bundles`,
    [s.id],
  );
  const owner = { userId: members[0]!.user_id, role: members[0]!.role };
  shops.push({
    id: s.id,
    name: s.name,
    key: persona?.key ?? 'other',
    share: persona?.activityShare ?? 1 / shopRows.length,
    shopify: persona?.shopify ?? true,
    start: new Date(s.created_at).getTime(),
    owner,
    members: members.map((m) => ({ userId: m.user_id, role: m.role })),
    credentialId: credential?.id ?? uuidv7(),
    credentialUser: credential?.user_id ?? owner.userId,
    grantId: grant?.id ?? uuidv7(),
    clientId: grant?.client_id ?? 'https://chatgpt.com/oauth/client.json',
    connectorId: uuidv7(),
    products: [...new Set(variants.map((v) => v.product_id))],
    variants: variants.map((v) => ({ id: v.id, productId: v.product_id, sku: v.sku })),
    variantById: new Map(
      variants.map((v) => [v.id, { id: v.id, productId: v.product_id, sku: v.sku }]),
    ),
    stocked: positions.map((p) => ({
      variantId: p.variant_id,
      locationIds: p.location_ids,
      positionIds: p.position_ids,
    })),
    leaves: leaves.map((l) => l.id),
    warehouses: counts!.warehouses,
    suppliers: counts!.suppliers,
    bundles: counts!.bundles,
    fields,
    importId: receipts[0]?.external_ref.replace(/^import /, '') ?? uuidv7(),
    receipts: receipts.map((r) => ({
      variantId: r.variant_id,
      locationId: r.location_id,
      positionId: r.position_id,
      quantity: r.quantity,
    })),
    counts: {
      products: counts!.products,
      variants: variants.length,
      locations: counts!.locations,
      fields: fields.length,
    },
    quota: 0,
  });
}

// Callers --------------------------------------------------------------------------------------

function userCaller(m: Member, source: Source = 'dashboard'): Caller {
  return {
    kind: 'user',
    id: m.userId,
    userId: m.userId,
    boundShopId: null,
    membership: null,
    scopes: 'all',
    source,
  };
}
const apiCaller = (s: Shop): Caller => ({
  kind: 'api_credential',
  id: s.credentialId,
  userId: s.credentialUser,
  boundShopId: s.id,
  membership: null,
  scopes: 'all',
  source: 'api',
});
const mcpCaller = (s: Shop): Caller => ({
  kind: 'connection',
  id: s.grantId,
  userId: s.owner.userId,
  boundShopId: s.id,
  membership: null,
  scopes: 'all',
  source: 'mcp',
  clientId: s.clientId,
  grantId: s.grantId,
});
const shopifyCaller = (s: Shop): Caller => ({
  kind: 'connector',
  id: s.connectorId,
  userId: null,
  boundShopId: s.id,
  membership: null,
  scopes: 'all',
  source: 'shopify',
});
const systemCaller = (s: Shop, id: string): Caller => ({
  kind: 'system',
  id,
  userId: null,
  boundShopId: s.id,
  membership: null,
  scopes: 'all',
  source: 'scheduled',
});
const byRole = (s: Shop, ...roles: string[]) => {
  const list = s.members.filter((m) => roles.includes(m.role));
  return list.length > 0 ? pick(list) : s.owner;
};

// Event building -------------------------------------------------------------------------------

type Fields = Pick<AuditEvent, 'action' | 'phase' | 'outcome'> & Partial<AuditEvent>;

/** One request: its events share the request ID, and a command's share its attempt and key. */
class Request {
  readonly events: AuditEvent[] = [];
  readonly requestId: string;
  attemptId: string | null = null;
  key: string | null = null;
  constructor(
    readonly shop: Shop,
    readonly caller: Caller,
    public t: number,
  ) {
    this.requestId = uuidv7(t);
  }
  private add(fields: Fields, at = this.t) {
    const e = auditEvent(
      {
        shopId: this.shop.id,
        caller: this.caller,
        requestId: this.requestId,
        attemptId: this.attemptId,
        idempotencyKey: this.key,
      },
      fields,
    );
    e.event_id = uuidv7(at);
    e.occurred_at = new Date(at).toISOString();
    this.events.push(e);
    return e;
  }
  /** A read: one access event after the query. */
  read(action: string, fields: Partial<AuditEvent> = {}) {
    this.t += int(15, 250);
    return this.add({ action, phase: 'outcome', outcome: 'succeeded', ...fields });
  }
  /** A command: the attempt, then the outcome (succeeded or another), plus extra change events. */
  command(
    action: string,
    fields: Partial<AuditEvent>,
    opts: { idempotent?: boolean; extra?: Fields[] } = {},
  ) {
    this.attemptId = uuidv7(this.t);
    this.key = opts.idempotent === false ? null : crypto.randomUUID();
    this.add({ action, phase: 'attempt', outcome: 'received' });
    this.t += int(30, 400);
    const outcome = this.add({ action, phase: 'outcome', outcome: 'succeeded', ...fields });
    for (const extra of opts.extra ?? []) this.add(extra);
    return outcome;
  }
  /** A refused or failed request: one outcome event (with an attempt first for commands). */
  failure(
    action: string,
    kind: 'validation' | 'denied' | 'conflict' | 'not_found' | 'unknown',
    command: boolean,
  ) {
    if (command) {
      this.attemptId = uuidv7(this.t);
      this.key = crypto.randomUUID();
      if (kind !== 'denied' && kind !== 'validation')
        this.add({ action, phase: 'attempt', outcome: 'received' });
    }
    this.t += int(10, 300);
    const error = {
      validation: { code: 'validation_failed', status: 400 },
      denied: { code: 'forbidden', status: 403 },
      conflict: {
        code: pick(['insufficient_stock', 'version_conflict', 'field_changed']),
        status: 409,
      },
      not_found: { code: 'not_found', status: 404 },
      unknown: { code: 'outcome_unknown', status: 503 },
    }[kind];
    return this.add({
      action,
      phase: 'outcome',
      outcome:
        kind === 'validation' || kind === 'not_found'
          ? 'failed'
          : kind === 'unknown'
            ? 'unknown'
            : kind === 'denied'
              ? 'denied'
              : 'conflict',
      error,
      context:
        kind === 'validation'
          ? {
              problem: {
                errors: [
                  {
                    path: pick(['quantity', 'locationId', 'sku', 'price']),
                    message: 'Invalid value.',
                  },
                ],
              },
            }
          : null,
    });
  }
  /** A replayed command: the same key sent again. */
  replay(action: string) {
    this.t += int(500, 30_000);
    this.add({ action, phase: 'outcome', outcome: 'replayed' });
  }
  /** Interface events the dashboard reports itself, with the batch's own read event. */
  clientEvents(types: Array<[string, string | null, string | null, Record<string, unknown>?]>) {
    let seq = 0;
    for (const [type, targetType, targetId, details] of types) {
      this.t += int(200, 20_000);
      this.add({
        action: `client.${type}`,
        phase: 'outcome',
        outcome: 'succeeded',
        target_type: targetType,
        target_id: targetId,
        context: { clientReported: true, clientSeq: seq++, ...(details ? { details } : {}) },
      });
    }
    this.t += int(100, 2000);
    this.add({
      action: 'activity.client_events.received',
      phase: 'outcome',
      outcome: 'succeeded',
      target_type: 'client_events',
      target_id: 'batch',
      context: { accepted: types.length, duplicates: 0, rejected: 0 },
    });
  }
}

const variant = (s: Shop) => pick(s.variants);
const stocked = (s: Shop) => (s.stocked.length > 0 ? pick(s.stocked) : null);
const decimal = (n: number) => `${n}.000000`;

function queryContext(s: Shop, page: 'first' | 'next') {
  const select = s.fields.filter((f) => f.type === 'single_select' && f.options.length > 0);
  const f = select.length > 0 ? pick(select) : null;
  const search = chance(0.35) ? pick(s.variants).sku.slice(0, int(3, 8)) : null;
  return {
    mode: chance(0.8) ? 'variants' : 'products',
    search,
    filter:
      f && chance(0.5)
        ? [{ field: f.key, op: 'is_any_of', value: [pick(f.options)] }]
        : chance(0.15)
          ? [{ field: 'available', op: 'gt', value: '0' }]
          : [],
    sort: chance(0.6)
      ? null
      : { field: pick(['price', 'sku', 'name', 'updated_at']), direction: pick(['asc', 'desc']) },
    fields: s.fields.slice(0, int(2, 6)).map((x) => x.key),
    archived: 'exclude',
    page,
    returned: 50,
    total: search ? int(0, 60) : s.counts.variants,
  };
}

// Activities -----------------------------------------------------------------------------------

type Activity = (s: Shop, t: number) => AuditEvent[];

/** A member working in the dashboard grid. */
const browse: Activity = (s, t) => {
  const m = byRole(s, 'owner', 'manager', 'catalog_editor', 'viewer');
  const r = new Request(s, userCaller(m), t);
  const client: Array<[string, string | null, string | null, Record<string, unknown>?]> = [
    ['page.viewed', 'page', 'catalog', { path: '/catalog' }],
  ];
  r.read('catalog.items.queried', {
    target_type: 'catalog_query',
    target_id: 'variants',
    context: queryContext(s, 'first'),
  });
  for (let i = 0; i < (chance(0.4) ? int(1, 4) : 0); i++)
    r.read('catalog.items.queried', {
      target_type: 'catalog_query',
      target_id: 'variants',
      context: queryContext(s, 'next'),
    });
  if (chance(0.5)) {
    const v = Array.from({ length: 5 }, () => variant(s));
    r.read('catalog.media.primary_viewed', {
      target_type: 'media',
      target_id: 'primary',
      context: {
        productIds: v.map((x) => x.productId),
        variantIds: [],
        mediaIds: v.slice(0, 2).map(() => uuidv7(t)),
      },
    });
  }
  if (chance(0.25))
    client.push([
      pick([
        'grid.column_resized',
        'grid.column_visibility_changed',
        'grid.column_order_changed',
        'view.type_switched',
      ]),
      'grid',
      'variants',
      { column: pick(s.fields).key },
    ]);
  for (let i = 0; i < int(0, 3); i++) {
    const v = variant(s);
    r.read('catalog.item.viewed', {
      target_type: 'product',
      target_id: v.productId,
      context: { input: { productId: v.productId } },
    });
    client.push(
      ['detail_panel.opened', 'product', v.productId],
      ['detail_panel.closed', 'product', v.productId],
    );
    if (chance(0.15))
      r.read('catalog.packaging.viewed', {
        target_type: 'variant',
        target_id: v.id,
        context: { input: { variantId: v.id } },
      });
    if (chance(0.1))
      r.read('activity.viewed', {
        target_type: 'product',
        target_id: v.productId,
        context: { input: { targetType: 'product', targetId: v.productId, limit: 50 } },
      });
    if (m.role !== 'viewer' && chance(0.3)) edit(r, s, v);
    else if (m.role === 'viewer' && chance(0.1)) r.failure('catalog.item.updated', 'denied', true);
  }
  if (chance(0.7)) r.clientEvents(client);
  return r.events;
};

/** A field edit: the product's outcome plus one change event per further record. */
function edit(r: Request, s: Shop, v: Shop['variants'][number]) {
  const f = pick(s.fields);
  if (chance(0.04)) {
    r.failure('catalog.item.updated', 'conflict', true);
    return;
  }
  const change = {
    [f.key]: {
      from: f.options.length ? pick(f.options) : String(int(1, 500)),
      to: f.options.length ? pick(f.options) : String(int(1, 500)),
    },
  };
  const extra: Fields[] = [];
  for (let i = 0; i < (chance(0.3) ? int(1, 4) : 0); i++)
    extra.push({
      action: 'catalog.variant.changed',
      phase: 'outcome',
      outcome: 'succeeded',
      target_type: 'variant',
      target_id: variant(s).id,
      changes: {
        fields: { price: { from: `${int(5, 90)}.00`, to: `${int(5, 90)}.00` } },
        version: int(2, 9),
        definitionVersions: {},
      },
    });
  r.command(
    'catalog.item.updated',
    {
      target_type: 'product',
      target_id: v.productId,
      changes: { fields: change, version: int(2, 12), definitionVersions: { [f.key]: 1 } },
    },
    { extra },
  );
}

/** Phone scanning in the warehouse: lookups, availability, receipts. */
const scan: Activity = (s, t) => {
  const m = byRole(s, 'inventory_operator', 'manager');
  const r = new Request(s, userCaller(m), t);
  for (let i = 0; i < int(1, 6); i++) {
    const p = stocked(s);
    const v = (p && s.variantById.get(p.variantId)) || variant(s);
    const found = chance(0.94);
    r.read('catalog.barcode.looked_up', {
      target_type: found ? 'variant' : 'barcode',
      target_id: found ? v.id : 'lookup',
      context: { code: `2${int(10 ** 10, 10 ** 11 - 1)}${int(0, 9)}`, found },
    });
    if (found && p) {
      r.read('inventory.availability.viewed', {
        target_type: 'variant',
        target_id: v.id,
        location_ids: p.locationIds,
        context: { input: { variantId: v.id } },
      });
      if (chance(0.35))
        receipt(r, v.id, pick(p.locationIds), chance(0.5) ? `PO-${int(1000, 9999)}` : null);
    }
  }
  if (chance(0.15))
    r.read('storage.locations.listed', {
      target_type: 'location',
      target_id: 'list',
      location_ids: s.leaves.slice(0, 100),
      context: { input: {} },
    });
  return r.events;
};

function receipt(r: Request, variantId: string, locationId: string, reference: string | null) {
  if (chance(0.03)) {
    r.failure('inventory.receipt.created', pick(['validation', 'conflict'] as const), true);
    return;
  }
  const quantity = String(int(1, 48));
  r.command('inventory.receipt.created', {
    target_type: 'variant',
    target_id: variantId,
    operation_id: uuidv7(r.t),
    location_ids: [locationId],
    external_ref: reference,
    changes: {
      positionId: uuidv7(r.t),
      condition: 'sellable',
      quantity,
      unitCost: chance(0.6) ? `${int(1, 200)}.${int(10, 99)}` : null,
      onHandAfter: decimal(int(Number(quantity), 400)),
    },
  });
  if (chance(0.01)) r.replay('inventory.receipt.created');
}

function reservation(r: Request, s: Shop, externalRef: string | null) {
  const p = stocked(s);
  if (!p) return;
  if (chance(0.04)) {
    r.failure('inventory.reservation.created', 'conflict', true);
    return;
  }
  const quantity = String(int(1, 3));
  const locationId = pick(p.locationIds);
  r.command('inventory.reservation.created', {
    target_type: 'reservation',
    target_id: uuidv7(r.t),
    operation_id: uuidv7(r.t),
    location_ids: [locationId],
    external_ref: externalRef,
    changes: {
      variantId: p.variantId,
      quantity,
      purpose: externalRef ? 'external_order' : 'manual',
      allocations: [
        { positionId: pick(p.positionIds), locationId, quantity: decimal(Number(quantity)) },
      ],
      expiresAt: externalRef ? null : new Date(r.t + 30 * 60_000).toISOString(),
    },
  });
}

/** A ChatGPT conversation through the MCP connection. */
const mcpChat: Activity = (s, t) => {
  const r = new Request(s, mcpCaller(s), t);
  r.read('shop.context.viewed', { target_type: 'shop', target_id: s.id, context: { input: {} } });
  if (chance(0.4))
    r.read('catalog.schema.viewed', {
      target_type: 'catalog_schema',
      target_id: s.id,
      context: { input: {} },
    });
  for (let i = 0; i < int(1, 3); i++) {
    r.t += int(5_000, 60_000);
    r.read('catalog.items.queried', {
      target_type: 'catalog_query',
      target_id: 'variants',
      context: { ...queryContext(s, 'first'), search: pick(s.variants).sku.slice(0, 5) },
    });
  }
  for (let i = 0; i < int(0, 4); i++) {
    const p = stocked(s);
    if (p)
      r.read('inventory.availability.viewed', {
        target_type: 'variant',
        target_id: p.variantId,
        location_ids: p.locationIds,
        context: { input: { variantId: p.variantId } },
      });
  }
  if (chance(0.15)) {
    const p = stocked(s);
    if (p) receipt(r, p.variantId, pick(p.locationIds), `chat ${int(100, 999)}`);
  }
  if (chance(0.1)) reservation(r, s, null);
  if (chance(0.1))
    r.read('activity.viewed', {
      target_type: 'activity',
      target_id: 'list',
      context: { input: { limit: 20 } },
    });
  if (chance(0.04))
    r.failure(pick(['catalog.item.updated', 'inventory.receipt.created']), 'denied', true);
  if (chance(0.03)) r.failure('catalog.items.queried', 'validation', false);
  return r.events;
};

/** A Shopify order: the webhook, then a reservation per line; some are released later. */
const shopifyOrder: Activity = (s, t) => {
  const r = new Request(s, shopifyCaller(s), t);
  const order = int(5_000_000_000_000, 6_000_000_000_000);
  r.read('shopify.webhook.received', {
    target_type: 'shopify_connection',
    target_id: s.connectorId,
    context: {
      topic: 'orders/create',
      eventId: crypto.randomUUID(),
      webhookId: crypto.randomUUID(),
    },
    changes: { receiptId: uuidv7(t), jobId: uuidv7(t) },
  });
  const lines = int(1, 3);
  for (let i = 0; i < lines; i++) {
    const job = new Request(s, shopifyCaller(s), r.t + int(500, 5_000));
    reservation(job, s, `shopify:order/${order}/line/${order + i + 1}`);
    r.events.push(...job.events);
    r.t = job.t;
    if (chance(0.06)) {
      // Cancelled later the same day, or the next.
      const later = new Request(s, shopifyCaller(s), r.t + int(10 * 60_000, 30 * HOUR));
      const reservationId = job.events.at(-1)?.target_id ?? uuidv7(r.t);
      later.command('inventory.reservation.released', {
        target_type: 'reservation',
        target_id: reservationId,
        operation_id: uuidv7(later.t),
        location_ids: job.events.at(-1)?.location_ids ?? null,
        reason: 'order cancelled',
        changes: { released: [{ positionId: uuidv7(later.t), quantity: '1' }], status: 'released' },
      });
      r.events.push(...later.events);
    }
  }
  if (chance(0.01))
    r.read('shopify.webhook.received', {
      target_type: 'shopify_connection',
      target_id: s.connectorId,
      outcome: 'no_change',
      context: { topic: 'orders/create', eventId: crypto.randomUUID() },
    });
  return r.events;
};

/** An integration (n8n, an ERP) checking availability and sending receipts through the API. */
const apiSync: Activity = (s, t) => {
  const r = new Request(s, apiCaller(s), t);
  for (let i = 0; i < int(3, 25); i++) {
    const p = stocked(s);
    if (!p) break;
    r.read('inventory.availability.viewed', {
      target_type: 'variant',
      target_id: p.variantId,
      location_ids: p.locationIds,
      context: { input: { variantId: p.variantId } },
    });
  }
  if (chance(0.3))
    r.read('catalog.items.queried', {
      target_type: 'catalog_query',
      target_id: 'variants',
      context: { ...queryContext(s, 'first'), sort: { field: 'updated_at', direction: 'desc' } },
    });
  if (chance(s.key === 'parts' ? 0.5 : 0.15)) {
    for (let i = 0; i < int(1, 8); i++) {
      const p = stocked(s);
      if (p) receipt(r, p.variantId, pick(p.locationIds), `ERP-GR-${int(10000, 99999)}`);
    }
  }
  if (chance(0.02)) r.failure('inventory.availability.viewed', 'not_found', false);
  return r.events;
};

/** Catalog maintenance: bulk edits, supplier items, barcodes, packs, pictures, new items. */
const catalogWork: Activity = (s, t) => {
  const m = byRole(s, 'catalog_editor', 'manager', 'owner');
  const r = new Request(s, userCaller(m), t);
  const kind = int(1, 7);
  if (kind === 1) {
    const previewId = uuidv7(t);
    r.read('catalog.bulk.previewed', {
      target_type: 'bulk_preview',
      target_id: previewId,
      context: { records: int(5, 80) },
    });
    const records = int(5, 80);
    const extra: Fields[] = Array.from({ length: records }, () => ({
      action: 'catalog.variant.changed',
      phase: 'outcome' as const,
      outcome: 'succeeded' as const,
      target_type: 'variant',
      target_id: variant(s).id,
      changes: {
        fields: { price: { from: `${int(5, 90)}.00`, to: `${int(5, 90)}.90` } },
        version: int(2, 9),
        definitionVersions: {},
      },
    }));
    r.command(
      'catalog.bulk.committed',
      {
        target_type: 'bulk_preview',
        target_id: previewId,
        changes: { records, products: Math.ceil(records / 3) },
      },
      { extra },
    );
  } else if (kind === 2 && s.suppliers.length > 0) {
    const v = variant(s);
    r.read('supplier_items.listed', {
      target_type: 'variant',
      target_id: v.id,
      context: { input: { variantId: v.id } },
    });
    r.command('supplier_item.saved', {
      target_type: 'supplier_item',
      target_id: uuidv7(t),
      changes: {
        restricted: {
          permission: 'costs.read',
          lastCost: { from: `${int(1, 50)}.00`, to: `${int(1, 50)}.50` },
        },
        minimumOrderQuantity: { from: null, to: String(int(1, 50)) },
      },
    });
  } else if (kind === 3) {
    const v = variant(s);
    r.command('catalog.barcodes.set', {
      target_type: 'variant',
      target_id: v.id,
      changes: { added: [`2${int(10 ** 11, 10 ** 12 - 1)}`], removed: [], version: int(1, 4) },
    });
  } else if (kind === 4) {
    const v = variant(s);
    const mediaId = uuidv7(t);
    r.command('catalog.media.upload_started', {
      target_type: 'media',
      target_id: mediaId,
      changes: { fileName: `IMG_${int(1000, 9999)}.jpg`, bytes: int(800_000, 4_000_000) },
    });
    r.command('catalog.media.finalized', {
      target_type: 'media',
      target_id: mediaId,
      changes: { width: 2048, height: 1536 },
    });
    r.command('catalog.media.linked', {
      target_type: 'product',
      target_id: v.productId,
      changes: { mediaId, position: int(0, 4) },
    });
  } else if (kind === 5) {
    const productId = uuidv7(t);
    r.read('catalog.duplicates.checked', {
      target_type: 'catalog_duplicates',
      target_id: 'check',
      context: { name: 'New item', sku: null, skuTaken: null, similar: [] },
    });
    r.command('catalog.item.created', {
      target_type: 'variant',
      target_id: uuidv7(t),
      changes: {
        productId,
        name: `New item ${int(1, 9999)}`,
        sku: `NEW-${int(1000, 9999)}`,
        price: `${int(5, 90)}.00`,
        baseUnit: 'each',
      },
    });
  } else if (kind === 6) {
    r.read('catalog.schema.viewed', {
      target_type: 'catalog_schema',
      target_id: s.id,
      context: { input: {} },
    });
    if (chance(0.3))
      r.command('catalog.field_options.updated', {
        target_type: 'field',
        target_id: uuidv7(t),
        changes: { added: [`Option ${int(1, 99)}`] },
      });
  } else {
    const exportId = uuidv7(t);
    r.command('catalog.export.created', {
      target_type: 'export',
      target_id: exportId,
      changes: { query: { mode: 'variants', archived: 'exclude', filter: [] } },
    });
    const job = new Request(s, { ...userCaller(m), source: 'import' }, r.t + int(2_000, 20_000));
    job.read('catalog.export.completed', {
      target_type: 'export',
      target_id: exportId,
      changes: { rows: s.counts.variants },
    });
    job.read('catalog.export.downloaded', { target_type: 'export', target_id: exportId });
    r.events.push(...job.events);
  }
  if (chance(0.03)) r.failure('catalog.item.updated', 'validation', true);
  return r.events;
};

/** Stock work by a member: purchase deliveries, manual reservations and releases. */
const stockWork: Activity = (s, t) => {
  const m = byRole(s, 'inventory_operator', 'manager', 'owner');
  const r = new Request(s, userCaller(m), t);
  if (chance(0.6)) {
    const po = `PO-${int(1000, 9999)}`;
    for (let i = 0; i < int(1, 12); i++) {
      const p = stocked(s);
      if (p) receipt(r, p.variantId, pick(p.locationIds), po);
    }
  } else {
    reservation(r, s, null);
    if (chance(0.5)) {
      const last = r.events.at(-1);
      r.command('inventory.reservation.released', {
        target_type: 'reservation',
        target_id: last?.target_id ?? uuidv7(t),
        operation_id: uuidv7(r.t),
        location_ids: last?.location_ids ?? null,
        changes: { released: [{ positionId: uuidv7(r.t), quantity: '1' }], status: 'released' },
      });
    }
  }
  if (chance(0.2))
    r.read('activity.viewed', {
      target_type: 'variant',
      target_id: variant(s).id,
      context: { input: { limit: 50 } },
    });
  return r.events;
};

/** The expiry sweep releasing manual reservations nobody released. */
const expirySweep: Activity = (s, t) => {
  const r = new Request(s, systemCaller(s, 'reservation-expiry'), t);
  const operationId = uuidv7(t);
  for (let i = 0; i < int(1, 4); i++) {
    const p = stocked(s);
    if (!p) break;
    r.read('inventory.reservation.expired', {
      actor_type: 'system',
      actor_id: 'reservation-expiry',
      target_type: 'reservation',
      target_id: uuidv7(t - int(HOUR, 3 * HOUR)),
      operation_id: operationId,
      location_ids: [pick(p.locationIds)],
      changes: {
        released: [{ positionId: pick(p.positionIds), quantity: '1.000000' }],
        status: 'expired',
      },
      context: { trigger: 'sweep' },
    });
  }
  return r.events;
};

/** The owner or a manager reading history. */
const activityReview: Activity = (s, t) => {
  const r = new Request(s, userCaller(byRole(s, 'owner', 'manager')), t);
  const pages = int(1, 4);
  for (let i = 0; i < pages; i++) {
    const v = chance(0.5) ? variant(s) : null;
    r.read('activity.viewed', {
      target_type: v ? 'variant' : 'activity',
      target_id: v ? v.id : 'list',
      context: {
        input: {
          ...(v ? { targetType: 'variant', targetId: v.id } : {}),
          limit: 50,
          ...(i > 0 ? { before: `${new Date(t).toISOString()}|${uuidv7(t)}` } : {}),
        },
      },
    });
  }
  return r.events;
};

const ACTIVITIES: Array<{
  name: string;
  run: Activity;
  weight: (s: Shop) => number;
  people: boolean;
}> = [
  { name: 'browse', run: browse, weight: () => 30, people: true },
  {
    name: 'scan',
    run: scan,
    weight: (s) => (s.key === 'parts' || s.key === 'owner' ? 18 : 12),
    people: true,
  },
  { name: 'mcp', run: mcpChat, weight: () => 9, people: true },
  { name: 'shopify', run: shopifyOrder, weight: (s) => (s.shopify ? 20 : 0), people: false },
  { name: 'api', run: apiSync, weight: (s) => (s.key === 'parts' ? 22 : 8), people: false },
  { name: 'catalog', run: catalogWork, weight: () => 6, people: true },
  { name: 'stock', run: stockWork, weight: () => 7, people: true },
  { name: 'expiry', run: expirySweep, weight: () => 2, people: false },
  { name: 'review', run: activityReview, weight: () => 3, people: true },
];

// Setup and import at the start of each shop's history ------------------------------------------

function setupAndImport(s: Shop): AuditEvent[] {
  const out: AuditEvent[] = [];
  const owner = userCaller(s.owner);
  let t = s.start - 3 * HOUR;
  const cmd = (action: string, fields: Partial<AuditEvent>) => {
    const r = new Request(s, owner, t);
    r.command(action, fields);
    t = r.t + int(2_000, 40_000);
    out.push(...r.events);
  };
  cmd('shop.created', {
    target_type: 'shop',
    target_id: s.id,
    changes: { name: s.name, currency: 'EUR' },
  });
  for (const w of s.warehouses)
    cmd('storage.warehouse.created', {
      target_type: 'warehouse',
      target_id: w,
      changes: { name: 'Warehouse' },
    });
  for (let i = 0; i < s.counts.locations; i++) {
    const r = new Request(s, owner, t);
    r.command('storage.location.created', {
      target_type: 'location',
      target_id: s.leaves[i % s.leaves.length]!,
      location_ids: [s.leaves[i % s.leaves.length]!],
      changes: { name: `Location ${i + 1}` },
    });
    t = r.t + int(800, 4_000);
    out.push(...r.events);
  }
  for (const f of s.fields)
    cmd('catalog.field.created', {
      target_type: 'field',
      target_id: uuidv7(t),
      changes: { key: f.key, type: f.type },
    });
  for (const id of s.suppliers)
    cmd('supplier.created', {
      target_type: 'supplier',
      target_id: id,
      changes: { name: 'Supplier' },
    });

  // The import: upload, preview, commit, then the job's chunks (D10) and the opening receipts.
  t = s.start;
  const importCaller = { ...owner, source: 'import' as Source };
  cmd('catalog.import.uploaded', {
    target_type: 'import',
    target_id: s.importId,
    changes: { fileName: 'catalog.csv' },
  });
  const preview = new Request(s, owner, t);
  preview.read('catalog.import.previewed', {
    target_type: 'import',
    target_id: s.importId,
    context: { rows: s.counts.variants },
  });
  out.push(...preview.events);
  t = preview.t + 60_000;
  cmd('catalog.import.committed', {
    target_type: 'import',
    target_id: s.importId,
    changes: { rows: s.counts.variants },
  });
  const job = new Request(s, importCaller, t);
  const emit = (fields: Fields) => {
    const e = auditEvent(
      {
        shopId: s.id,
        caller: importCaller,
        requestId: job.requestId,
        attemptId: null,
        idempotencyKey: null,
      },
      fields,
    );
    // About 200 rows per chunk, a chunk every few seconds.
    job.t += int(5, 25);
    e.event_id = uuidv7(job.t);
    e.occurred_at = new Date(job.t).toISOString();
    out.push(e);
  };
  const seenProducts = new Set<string>();
  for (const [row, v] of s.variants.entries()) {
    if (!seenProducts.has(v.productId)) {
      seenProducts.add(v.productId);
      emit({
        action: 'catalog.product.imported',
        phase: 'outcome',
        outcome: 'succeeded',
        target_type: 'product',
        target_id: v.productId,
        changes: { importId: s.importId, row: row + 2 },
      });
    }
    emit({
      action: 'catalog.variant.imported',
      phase: 'outcome',
      outcome: 'succeeded',
      target_type: 'variant',
      target_id: v.id,
      changes: { importId: s.importId, row: row + 2, sku: v.sku },
    });
  }
  for (const [row, rc] of s.receipts.entries()) {
    emit({
      action: 'inventory.receipt.created',
      phase: 'outcome',
      outcome: 'succeeded',
      target_type: 'variant',
      target_id: rc.variantId,
      operation_id: uuidv7(job.t),
      location_ids: [rc.locationId],
      idempotency_key: `import:${s.importId}:${row + 2}:${rc.locationId}`,
      reason: 'opening stock',
      external_ref: `import ${s.importId}`,
      changes: {
        positionId: rc.positionId,
        condition: 'sellable',
        quantity: rc.quantity,
        importId: s.importId,
        row: row + 2,
      },
    });
  }
  emit({
    action: 'catalog.import.completed',
    phase: 'outcome',
    outcome: 'succeeded',
    target_type: 'import',
    target_id: s.importId,
    changes: { done: s.counts.variants, failed: 0, skipped: 0 },
  });
  return out;
}

// Time profile ---------------------------------------------------------------------------------

/** An index drawn with probability proportional to its weight. */
function drawIndex(profile: number[]): number {
  const total = profile.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (const [i, w] of profile.entries()) {
    r -= w;
    if (r < 0) return i;
  }
  return profile.length - 1;
}

/** Relative activity by hour (UTC, for shops one or two hours ahead), people and integrations. */
const PEOPLE_HOURS = [
  0.05, 0.03, 0.02, 0.02, 0.03, 0.15, 0.5, 0.9, 1, 1, 1, 0.9, 0.95, 1, 1, 0.95, 0.8, 0.6, 0.45, 0.4,
  0.3, 0.2, 0.12, 0.08,
];
const MACHINE_HOURS = [
  0.3, 0.25, 0.2, 0.2, 0.2, 0.3, 0.5, 0.7, 0.9, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.95, 0.9, 0.8, 0.6,
  0.4,
];
function dayWeight(day: number, first: number, last: number): number {
  const weekday = new Date(day).getUTCDay();
  const week = weekday === 0 ? 0.35 : weekday === 6 ? 0.6 : 1;
  const growth = 0.8 + (0.4 * (day - first)) / Math.max(1, last - first);
  return week * growth;
}

// Run ------------------------------------------------------------------------------------------

const firstDay = Math.min(...shops.map((s) => s.start)) - 3 * HOUR;
const dayStart = (t: number) => t - (t % DAY);

// Partitions for every month of the history, as ensure_audit_partitions names them.
if (!args['dry-run']) {
  for (
    let m = new Date(dayStart(firstDay));
    m.getTime() <= NOW;
    m.setUTCMonth(m.getUTCMonth() + 1)
  ) {
    const from = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1));
    const to = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    const name = `audit_events_${from.getUTCFullYear()}_${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
    const [found] = await q<{ r: string | null }>('select to_regclass($1)::text as r', [name]);
    if (!found?.r) {
      await q(
        `create table ${name} partition of audit_events for values from ('${from.toISOString().slice(0, 10)}') to ('${to.toISOString().slice(0, 10)}')`,
      );
      console.log(`Created partition ${name}.`);
    }
  }
  await q('select ensure_audit_partitions(3)');
}

// Quotas: each shop's share of the total, less its setup and import events.
const imports = new Map(shops.map((s) => [s.id, setupAndImport(s)]));
const shareSum = shops.reduce((a, s) => a + s.share, 0);
let assigned = 0;
for (const [i, s] of shops.entries()) {
  const total =
    i === shops.length - 1 ? TARGET - assigned : Math.round((TARGET * s.share) / shareSum);
  assigned += total;
  s.quota = total - imports.get(s.id)!.length;
  if (s.quota < 0) throw new Error(`${s.name}: the import alone has more events than its share.`);
}

let buffer: AuditEvent[] = [];
for (const list of imports.values()) buffer.push(...list);
let written = 0;
let produced = buffer.length;
const byAction = new Map<string, number>();
const started = performance.now();
let stopped = false;

async function flush(until: number) {
  buffer.sort((a, b) =>
    a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0,
  );
  let cut = buffer.findIndex((e) => Date.parse(e.occurred_at) >= until);
  if (cut < 0) cut = buffer.length;
  const ready = buffer.slice(0, cut);
  buffer = buffer.slice(cut);
  for (let i = 0; i < ready.length && !stopped; i += BATCH) {
    const chunk = ready.slice(i, i + BATCH);
    for (const e of chunk) byAction.set(e.action, (byAction.get(e.action) ?? 0) + 1);
    if (!args['dry-run']) {
      const [res] = await q<{ n: number }>('select ingest_audit_events($1::jsonb) as n', [
        JSON.stringify(chunk),
      ]);
      if (res!.n !== chunk.length) console.warn(`  ${chunk.length - res!.n} duplicates ignored`);
    }
    written += chunk.length;
    if (
      !args['dry-run'] &&
      Math.floor(written / 50_000) !== Math.floor((written - chunk.length) / 50_000)
    ) {
      const [size] = await q<{ b: string }>(
        'select pg_database_size(current_database())::text as b',
      );
      const mb = Number(size!.b) / 1024 / 1024;
      console.log(
        `  ${written.toLocaleString('en')} events, up to ${chunk.at(-1)!.occurred_at.slice(0, 10)}, database ${mb.toFixed(0)} MB, ${((performance.now() - started) / 1000).toFixed(0)} s`,
      );
      if (Number(size!.b) > MAX_BYTES) {
        console.error(`Stopping: the database passed ${args['max-mb']} MB.`);
        stopped = true;
      }
    }
  }
}

const lastDay = dayStart(NOW);
const days: number[] = [];
for (let d = dayStart(firstDay); d <= lastDay; d += DAY) days.push(d);
const weights = new Map<string, Map<number, number>>();
for (const s of shops) {
  const own = days.filter((d) => d + DAY > s.start);
  const sum = own.reduce((a, d) => a + dayWeight(d, own[0]!, own.at(-1)!), 0);
  weights.set(s.id, new Map(own.map((d) => [d, dayWeight(d, own[0]!, own.at(-1)!) / sum])));
}

const remaining = new Map(shops.map((s) => [s.id, s.quota]));
for (const [di, d] of days.entries()) {
  if (stopped) break;
  for (const s of shops) {
    const w = weights.get(s.id)!.get(d);
    if (!w) continue;
    const isLast = di === days.length - 1;
    let quota = isLast
      ? remaining.get(s.id)!
      : Math.min(remaining.get(s.id)!, Math.round(s.quota * w));
    const active = ACTIVITIES.filter((a) => a.weight(s) > 0);
    const profile = active.map((a) => a.weight(s));
    while (quota > 0) {
      const a = active[drawIndex(profile)]!;
      const hour = drawIndex(a.people ? PEOPLE_HOURS : MACHINE_HOURS);
      let t = d + hour * HOUR + int(0, HOUR - 1);
      // The first day starts after the import; the last day ends now.
      if (t < s.start + 2 * HOUR)
        t = s.start + 2 * HOUR + int(0, Math.max(1, d + DAY - s.start - 2 * HOUR - 1));
      if (t >= NOW) t = NOW - int(60_000, 6 * HOUR);
      let events = a.run(s, t).filter((e) => Date.parse(e.occurred_at) < NOW);
      if (events.length > quota) events = events.slice(0, quota);
      quota -= events.length;
      remaining.set(s.id, remaining.get(s.id)! - events.length);
      produced += events.length;
      buffer.push(...events);
    }
  }
  await flush(d + DAY);
}
if (!stopped) await flush(Number.POSITIVE_INFINITY);
if (!args['dry-run']) await q('analyze audit_events');
await client.end();

const summary = [...byAction.entries()].sort((a, b) => b[1] - a[1]);
const reads = summary
  .filter(([a]) => /viewed|queried|listed|looked_up|checked|previewed|downloaded/.test(a))
  .reduce((n, [, c]) => n + c, 0);
console.log(
  JSON.stringify(
    {
      events: written,
      produced,
      seconds: Number(((performance.now() - started) / 1000).toFixed(1)),
      readShare: Number((reads / Math.max(1, written)).toFixed(3)),
      shops: shops.map((s) => ({
        name: s.name,
        quota: s.quota,
        importEvents: imports.get(s.id)!.length,
      })),
      topActions: Object.fromEntries(summary.slice(0, 25)),
    },
    null,
    2,
  ),
);
if (stopped) process.exitCode = 1;
