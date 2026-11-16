import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { NonNegativeDecimal } from '../decimal.ts';
import { AppError, errors } from '../errors.ts';
import { canonicalJson } from '../hash.ts';
import { effectivePermissions } from '../permissions.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id, iso, isTimeZone } from '../schemas.ts';

// Warehouses and locations (PRD 5.1, 5.2; plan Section 5.9; ADR 0016).
//
// Structural changes in a warehouse (creating, renaming, moving, archiving, or restoring its
// locations) lock the warehouse row first, then the locations in id order. Commands that need an
// active location (receipts, Shopify mappings) take a share lock on it, so an archive or a move
// and a receipt cannot both pass their checks.

const TOOL = 'manage_storage';

// Inputs. Actions of one MCP tool share one flat schema, so an argument name means the same
// schema everywhere, and none has a default: a default would leak into the other actions.

const Name = z.string().trim().min(1).max(200);
const Ownership = z.enum(['owned', 'rented', 'third_party']);
const OperatingStatus = z
  .enum(['operating', 'paused'])
  .describe('How the site is running. A record only; fulfillmentEligible decides allocation.');
const ExpectedVersion = z
  .number()
  .int()
  .min(1)
  .describe('The version you read. Fails with a conflict if the record changed since.');
const Code = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .nullable()
  .describe('Short code such as A-03, unique among active locations of the warehouse.');
const ParentId = Id.nullable().describe('The location to put it inside; null for the top level.');
const FulfillmentEligible = z
  .boolean()
  .describe('Whether orders may be allocated from here. Applies to everything inside it too.');
const IncludeArchived = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .optional()
  .describe('Also list archived records.');
const TimeZone = z
  .string()
  .min(1)
  .max(64)
  .refine(isTimeZone, 'Unknown IANA time zone.')
  .nullable()
  .describe('IANA time zone such as Europe/Berlin; null uses the shop time zone.');

const Address = z
  .object({
    line1: z.string().trim().max(200).optional(),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(100).optional(),
    region: z.string().trim().max(100).optional(),
    postalCode: z.string().trim().max(20).optional(),
    country: z
      .string()
      .trim()
      .regex(/^([A-Za-z]{2})?$/, 'ISO 3166-1 alpha-2 code such as DE.')
      .optional(),
  })
  .nullable();
const Contact = z
  .object({
    name: z.string().trim().max(200).optional(),
    email: z
      .string()
      .trim()
      .max(320)
      .regex(/^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'An email address.')
      .optional(),
    phone: z.string().trim().max(50).optional(),
  })
  .nullable();
const ProviderRef = z.object({
  provider: z.string().trim().min(1).max(50).describe('The other system, such as shipbob.'),
  externalId: z.string().trim().min(1).max(200),
});
const ProviderRefs = z
  .array(ProviderRef)
  .max(20)
  .describe('This site’s IDs in other systems, such as a fulfillment partner.');

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date as YYYY-MM-DD.')
  .refine((v) => {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!)).toISOString().slice(0, 10) === v;
  }, 'Not a valid date.');
const Rate = z.object({
  description: z.string().trim().min(1).max(200).describe('For example "Storage per pallet".'),
  amount: NonNegativeDecimal,
  unit: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .describe('What the amount is charged per, such as "pallet per week" or "order".'),
});
const Contract = z
  .object({
    startDate: IsoDate.nullable().optional(),
    endDate: IsoDate.nullable().optional(),
    feeDescription: z.string().trim().max(2000).nullable().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'ISO 4217 code such as EUR.')
      .optional()
      .describe('Defaults to the shop currency.'),
    rates: z.array(Rate).max(50).optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    attachmentMediaIds: z.array(Id).max(20).optional(),
  })
  .nullable()
  .describe(
    'Commercial terms. Needs the storage.commercial.read permission. Replaces the whole contract; null removes it. A record only, not billing.',
  );

// Outputs ----------------------------------------------------------------------------------

const ContractOut = z.object({
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  feeDescription: z.string().nullable(),
  currency: z.string(),
  rates: z.array(z.object({ description: z.string(), amount: z.string(), unit: z.string() })),
  notes: z.string().nullable(),
  attachmentMediaIds: z.array(Id),
});
type StoredContract = z.infer<typeof ContractOut>;

const AddressOut = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});
const ContactOut = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
});

const WarehouseOut = z.object({
  warehouseId: Id,
  name: z.string(),
  ownership: Ownership,
  operatorName: z.string().nullable(),
  timezone: z.string().nullable(),
  address: AddressOut.nullable(),
  contact: ContactOut.nullable(),
  providerRefs: z.array(z.object({ provider: z.string(), externalId: z.string() })),
  operatingStatus: z.enum(['operating', 'paused']),
  fulfillmentEligible: z.boolean(),
  status: z.enum(['active', 'archived']),
  activeLocations: z.number().int(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  contract: ContractOut.nullable()
    .optional()
    .describe('Present only for members with the storage.commercial.read permission.'),
});
type WarehouseView = z.infer<typeof WarehouseOut>;

const LocationOut = z.object({
  locationId: Id,
  warehouseId: Id,
  warehouseName: z.string(),
  ownership: z.string(),
  parentId: Id.nullable(),
  name: z.string(),
  code: z.string().nullable(),
  path: z.string().describe('Warehouse, then the locations above, then this one, joined by /.'),
  holdsStockAllowed: z.boolean().describe('True for locations without children.'),
  fulfillmentEligible: z.boolean().describe('This location’s own setting.'),
  effectiveFulfillmentEligible: z
    .boolean()
    .describe('False when this location, one above it, or its warehouse is not eligible.'),
  status: z.string(),
  version: z.number().int(),
});
type LocationView = z.infer<typeof LocationOut>;

const StatusOut = z.object({
  id: Id,
  status: z.enum(['active', 'archived']),
  version: z.number().int(),
  locationsChanged: z.number().int().describe('Locations archived or restored with it.'),
});

// Helpers ----------------------------------------------------------------------------------

export function canSeeCommercial(ctx: Pick<HandlerContext, 'membership'>): boolean {
  return ctx.membership
    ? effectivePermissions(ctx.membership).has('storage.commercial.read')
    : false;
}

function requireCommercial(ctx: HandlerContext): void {
  if (!canSeeCommercial(ctx)) {
    throw errors.forbidden('Requires the storage.commercial.read permission to change contracts.');
  }
}

function outOfScope(message: string): AppError {
  return new AppError(403, 'location_out_of_scope', message, 'denied');
}

/** A member limited to some locations may change a warehouse only if the whole warehouse is theirs. */
function assertWarehouseInScope(ctx: HandlerContext, warehouseId: string): void {
  if (ctx.locationScope !== null && !ctx.locationScope.includes(warehouseId)) {
    throw outOfScope('You do not have access to this whole warehouse.');
  }
}

/** Drops empty strings; an object with nothing left is stored as null. */
function compact<T extends Record<string, string | undefined>>(value: T | null): Partial<T> | null {
  if (!value) return null;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined && v !== '');
  return entries.length > 0 ? (Object.fromEntries(entries) as Partial<T>) : null;
}

function normalizeAddress(value: z.infer<typeof Address>) {
  const address = compact(value);
  if (address?.country) address.country = address.country.toUpperCase();
  return address;
}

function normalizeProviderRefs(refs: z.infer<typeof ProviderRefs>) {
  const seen = new Set<string>();
  for (const [i, ref] of refs.entries()) {
    const key = `${ref.provider.toLowerCase()}\u0000${ref.externalId}`;
    if (seen.has(key)) {
      throw errors.validation([
        { path: `providerRefs.${i}`, message: 'Each provider ID may appear once.' },
      ]);
    }
    seen.add(key);
  }
  return refs;
}

async function normalizeContract(
  tx: Tx,
  value: z.infer<typeof Contract>,
): Promise<StoredContract | null> {
  if (value === null) return null;
  if (value.startDate && value.endDate && value.endDate < value.startDate) {
    throw errors.validation([
      { path: 'contract.endDate', message: 'The end date is before the start date.' },
    ]);
  }
  let currency = value.currency;
  if (!currency) {
    const [shop] = await tx.query<{ currency: string }>(
      'select currency from shops where id = app_shop_id()',
    );
    currency = shop?.currency ?? 'EUR';
  }
  return {
    startDate: value.startDate ?? null,
    endDate: value.endDate ?? null,
    feeDescription: value.feeDescription || null,
    currency,
    rates: value.rates ?? [],
    notes: value.notes || null,
    // Kept as given: media records arrive with milestone N4, which validates them.
    attachmentMediaIds: [...new Set(value.attachmentMediaIds ?? [])],
  };
}

interface WarehouseRow {
  id: string;
  name: string;
  ownership: 'owned' | 'rented' | 'third_party';
  operator_name: string | null;
  timezone: string | null;
  address: WarehouseView['address'];
  contact: WarehouseView['contact'];
  provider_refs: WarehouseView['providerRefs'];
  operating_status: 'operating' | 'paused';
  fulfillment_eligible: boolean;
  status: 'active' | 'archived';
  contract: StoredContract | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  active_locations: number;
}

async function loadWarehouses(
  ctx: HandlerContext,
  opts: { ids?: string[]; includeArchived?: boolean },
): Promise<WarehouseView[]> {
  const commercial = canSeeCommercial(ctx);
  const rows = await ctx.tx.query<WarehouseRow>(
    `select w.id, w.name, w.ownership, w.operator_name, w.timezone, w.address, w.contact,
       w.provider_refs, w.operating_status, w.fulfillment_eligible, w.status,
       case when $4 then w.contract end as contract,
       w.version, w.created_at, w.updated_at, w.archived_at,
       (select count(*)::int from locations l
         where l.shop_id = w.shop_id and l.warehouse_id = w.id and l.status = 'active') as active_locations
     from warehouses w
     where ($1::uuid[] is null or w.id = any($1::uuid[]))
       and ($2 or w.status = 'active')
       and ($3::uuid[] is null or w.id = any($3::uuid[]) or exists (
         select 1 from locations l
         where l.shop_id = w.shop_id and l.warehouse_id = w.id and l.path_ids && $3::uuid[]))
     order by w.status, w.created_at, w.id
     limit 500`,
    [opts.ids ?? null, opts.includeArchived ?? false, ctx.locationScope, commercial],
  );
  return rows.map((r) => ({
    warehouseId: r.id,
    name: r.name,
    ownership: r.ownership,
    operatorName: r.operator_name,
    timezone: r.timezone,
    address: r.address,
    contact: r.contact,
    providerRefs: r.provider_refs,
    operatingStatus: r.operating_status,
    fulfillmentEligible: r.fulfillment_eligible,
    status: r.status,
    activeLocations: r.active_locations,
    version: r.version,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
    archivedAt: iso(r.archived_at),
    ...(commercial ? { contract: r.contract } : {}),
  }));
}

async function loadWarehouse(ctx: HandlerContext, id: string): Promise<WarehouseView> {
  const [warehouse] = await loadWarehouses(ctx, { ids: [id], includeArchived: true });
  if (!warehouse) throw errors.notFound('Warehouse');
  return warehouse;
}

interface LockedWarehouse {
  id: string;
  name: string;
  status: string;
  version: number;
}

async function lockWarehouse(tx: Tx, id: string): Promise<LockedWarehouse> {
  const [row] = await tx.query<LockedWarehouse>(
    'select id, name, status, version from warehouses where id = $1 for update',
    [id],
  );
  if (!row) throw errors.notFound('Warehouse');
  return row;
}

interface LockedLocation {
  id: string;
  warehouse_id: string;
  parent_id: string | null;
  name: string;
  code: string | null;
  path: string;
  path_ids: string[];
  status: string;
  archived_via: string | null;
  fulfillment_eligible: boolean;
  version: number;
}

/**
 * Locks a location's warehouse, then the location and everything inside it, in id order.
 * Returns the location first.
 */
async function lockSubtree(
  tx: Tx,
  locationId: string,
): Promise<{ warehouse: LockedWarehouse; location: LockedLocation; subtree: LockedLocation[] }> {
  const [found] = await tx.query<{ warehouse_id: string }>(
    `select warehouse_id from locations where id = $1 and kind = 'storage'`,
    [locationId],
  );
  if (!found) throw errors.notFound('Location');
  const warehouse = await lockWarehouse(tx, found.warehouse_id);
  const subtree = await tx.query<LockedLocation>(
    `select id, warehouse_id, parent_id, name, code, path, path_ids, status, archived_via,
       fulfillment_eligible, version
     from locations where warehouse_id = $1 and path_ids @> array[$2]::uuid[]
     order by id for update`,
    [found.warehouse_id, locationId],
  );
  const location = subtree.find((l) => l.id === locationId);
  if (!location) throw errors.notFound('Location');
  return { warehouse, location, subtree };
}

function checkVersion(current: number, expected: number, what: string): void {
  if (expected !== current) {
    throw errors.conflict(
      'version_conflict',
      `The ${what} changed since you read it. Reload and retry.`,
      { currentVersion: current },
    );
  }
}

/**
 * Refuses when any of the locations holds stock or open reservations (PRD 5.2). Allocations
 * never exceed on-hand stock, so on-hand covers reservations too; both are reported.
 */
async function assertNoStock(tx: Tx, locationIds: string[], message: string): Promise<void> {
  const [row] = await tx.query<{ on_hand: string; reserved: string; paths: string[] }>(
    `select coalesce(sum(p.on_hand), 0)::text as on_hand,
       coalesce(sum(p.allocated), 0)::text as reserved,
       coalesce(array_agg(distinct l.path), '{}') as paths
     from inventory_positions p
     join locations l on l.shop_id = p.shop_id and l.id = p.location_id
     where p.location_id = any($1::uuid[]) and (p.on_hand > 0 or p.allocated > 0)`,
    [locationIds],
  );
  if (row && row.paths.length > 0) {
    throw errors.conflict('location_holds_stock', message, {
      onHand: row.on_hand,
      reserved: row.reserved,
      locations: row.paths.slice(0, 20),
    });
  }
}

/** A location a sales channel sells from stays active until it is unmapped. */
async function assertNotMapped(tx: Tx, locationIds: string[]): Promise<void> {
  const [mapped] = await tx.query<{ path: string }>(
    `select l.path from shopify_location_maps m
     join locations l on l.shop_id = m.shop_id and l.id = m.location_id
     where m.location_id = any($1::uuid[]) limit 1`,
    [locationIds],
  );
  if (mapped) {
    throw errors.conflict(
      'location_mapped',
      'A Shopify store sells from this location. Change the Shopify mapping first.',
      { location: mapped.path },
    );
  }
}

async function assertCodeFree(
  tx: Tx,
  warehouseId: string,
  codes: Array<{ id: string; code: string | null }>,
): Promise<void> {
  const wanted = codes.filter((c) => c.code !== null);
  if (wanted.length === 0) return;
  const lowered = wanted.map((c) => (c.code as string).toLowerCase());
  if (new Set(lowered).size !== lowered.length) {
    throw errors.conflict('code_taken', 'Two of these locations have the same code.');
  }
  const [taken] = await tx.query<{ code: string; path: string }>(
    `select code, path from locations
     where warehouse_id = $1 and status = 'active' and lower(code) = any($2::text[])
       and not (id = any($3::uuid[]))
     limit 1`,
    [warehouseId, lowered, wanted.map((c) => c.id)],
  );
  if (taken) {
    throw errors.conflict(
      'code_taken',
      `The code ${taken.code} is already used in this warehouse.`,
      { location: taken.path },
    );
  }
}

/**
 * The path rule: the warehouse name, the labels above, then this location's label (its code, or
 * its name), joined by "/". A top-level location labelled like its warehouse (the default "Main
 * stock") does not repeat the name.
 */
function topLevelPath(warehouseName: string, label: string): string {
  return label === warehouseName ? warehouseName : `${warehouseName}/${label}`;
}

/** Rewrites path and path_ids for a whole warehouse after a rename, code change, or move. */
async function recomputePaths(tx: Tx, warehouseId: string): Promise<number> {
  const rows = await tx.query(
    `with recursive tree as (
       select l.id,
         case when coalesce(l.code, l.name) = w.name then w.name
           else w.name || '/' || coalesce(l.code, l.name) end as path,
         array[w.id, l.id]::uuid[] as path_ids
       from locations l
       join warehouses w on w.shop_id = l.shop_id and w.id = l.warehouse_id
       where l.warehouse_id = $1 and l.parent_id is null
       union all
       select c.id, t.path || '/' || coalesce(c.code, c.name), t.path_ids || c.id
       from locations c join tree t on c.parent_id = t.id
       where c.shop_id = app_shop_id())
     update locations l set path = t.path, path_ids = t.path_ids, updated_at = now()
     from tree t
     where l.shop_id = app_shop_id() and l.id = t.id
       and (l.path <> t.path or l.path_ids <> t.path_ids)
     returning l.id`,
    [warehouseId],
  );
  return rows.length;
}

async function loadLocations(
  ctx: HandlerContext,
  opts: { ids?: string[]; warehouseId?: string },
): Promise<LocationView[]> {
  const rows = await ctx.tx.query<{
    id: string;
    warehouse_id: string;
    warehouse_name: string;
    ownership: string;
    parent_id: string | null;
    name: string;
    code: string | null;
    path: string;
    is_leaf: boolean;
    fulfillment_eligible: boolean;
    effective: boolean;
    status: string;
    version: number;
  }>(
    `select l.id, l.warehouse_id, w.name as warehouse_name, w.ownership, l.parent_id, l.name,
       l.code, l.path, l.fulfillment_eligible, l.status, l.version,
       location_fulfillment_eligible(l.shop_id, l.path_ids) as effective,
       not exists (select 1 from locations c where c.shop_id = l.shop_id and c.parent_id = l.id) as is_leaf
     from locations l
     join warehouses w on w.shop_id = l.shop_id and w.id = l.warehouse_id
     where ($1::uuid is null or l.warehouse_id = $1)
       and ($2::uuid[] is null or l.id = any($2::uuid[]))
       and ($3::uuid[] is null or l.path_ids && $3::uuid[])
     order by l.path, l.id
     limit 1000`,
    [opts.warehouseId ?? null, opts.ids ?? null, ctx.locationScope],
  );
  return rows.map((r) => ({
    locationId: r.id,
    warehouseId: r.warehouse_id,
    warehouseName: r.warehouse_name,
    ownership: r.ownership,
    parentId: r.parent_id,
    name: r.name,
    code: r.code,
    path: r.path,
    holdsStockAllowed: r.is_leaf,
    fulfillmentEligible: r.fulfillment_eligible,
    effectiveFulfillmentEligible: r.effective,
    status: r.status,
    version: r.version,
  }));
}

async function loadLocation(ctx: HandlerContext, id: string): Promise<LocationView> {
  const [location] = await loadLocations(ctx, { ids: [id] });
  if (!location) throw errors.notFound('Location');
  return location;
}

const WAREHOUSE_FIELDS = {
  name: 'name',
  ownership: 'ownership',
  operatorName: 'operator_name',
  timezone: 'timezone',
  address: 'address',
  contact: 'contact',
  providerRefs: 'provider_refs',
  operatingStatus: 'operating_status',
  fulfillmentEligible: 'fulfillment_eligible',
} as const;
type WarehouseField = keyof typeof WAREHOUSE_FIELDS;
const JSON_COLUMNS = new Set(['address', 'contact', 'provider_refs', 'contract']);

// jsonb reorders object keys, so compare in a canonical key order.
const sameJson = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
/** SQL NULL for a missing value; JSON.stringify(null) would store a JSON null instead. */
const jsonParam = (value: unknown) => (value == null ? null : JSON.stringify(value));

// Warehouses -------------------------------------------------------------------------------

const WarehouseInput = {
  ownership: Ownership.optional().describe('owned, rented, or third_party. New warehouses: owned.'),
  operatorName: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .describe('Who runs the site, for rented and third-party warehouses.'),
  timezone: TimeZone.optional(),
  address: Address.optional(),
  contact: Contact.optional(),
  providerRefs: ProviderRefs.optional(),
  operatingStatus: OperatingStatus.optional(),
  fulfillmentEligible: FulfillmentEligible.optional(),
  contract: Contract.optional(),
};

export const listWarehouses = defineOperation({
  id: 'storage.warehouses.list',
  summary: 'List warehouses with their records',
  description:
    'Address, operator, contact, provider IDs, operating status, ownership, and fulfillment eligibility. Contract terms appear only with the storage.commercial.read permission; `commercialVisible` says whether they were included.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ includeArchived: IncludeArchived }),
  output: z.object({
    partial: z.boolean().describe('True when your access is limited to some locations.'),
    commercialVisible: z.boolean(),
    warehouses: z.array(WarehouseOut),
  }),
  permission: 'storage.read',
  connectionScope: 'storage:read',
  audit: { action: 'storage.warehouses.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/warehouses' },
  mcp: { tool: TOOL, action: 'list_warehouses', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const includeArchived = input.includeArchived === true || input.includeArchived === 'true';
    const warehouses = await loadWarehouses(ctx, { includeArchived });
    return {
      result: {
        partial: ctx.locationScope !== null,
        commercialVisible: canSeeCommercial(ctx),
        warehouses,
      },
      audit: {
        targetType: 'warehouse',
        targetId: 'list',
        context: { input, commercialVisible: canSeeCommercial(ctx) },
      },
    };
  },
});

export const getWarehouse = defineOperation({
  id: 'storage.warehouses.get',
  summary: 'Get one warehouse with its record',
  description: 'Contract terms appear only with the storage.commercial.read permission.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ warehouseId: Id }),
  output: z.object({ commercialVisible: z.boolean(), warehouse: WarehouseOut }),
  permission: 'storage.read',
  connectionScope: 'storage:read',
  audit: { action: 'storage.warehouse.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/warehouses/{warehouseId}' },
  mcp: { tool: TOOL, action: 'get_warehouse', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const warehouse = await loadWarehouse(ctx, input.warehouseId);
    return {
      result: { commercialVisible: canSeeCommercial(ctx), warehouse },
      audit: {
        targetType: 'warehouse',
        targetId: input.warehouseId,
        context: { input, commercialVisible: canSeeCommercial(ctx) },
      },
    };
  },
});

export const createWarehouse = defineOperation({
  id: 'storage.warehouses.create',
  summary: 'Create a warehouse or storage site',
  description:
    'Owned, rented, or run by a third party. Rented and third-party sites record their operator and, with the storage.commercial.read permission, their contract. Add locations to hold stock.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ name: Name, ...WarehouseInput }),
  output: z.object({ warehouseId: Id, warehouse: WarehouseOut }),
  permission: 'storage.manage',
  connectionScope: 'storage:write',
  audit: { action: 'storage.warehouse.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/warehouses', status: 201 },
  mcp: { tool: TOOL, action: 'create_warehouse', readOnly: false, destructive: false },
  async handler(ctx, input) {
    if (ctx.locationScope !== null) {
      throw outOfScope('Members limited to specific locations cannot create warehouses.');
    }
    if (input.contract !== undefined) requireCommercial(ctx);
    const warehouseId = ctx.newId();
    const contract =
      input.contract === undefined ? null : await normalizeContract(ctx.tx, input.contract);
    await ctx.tx.query(
      `insert into warehouses (shop_id, id, name, ownership, operator_name, timezone, address,
         contact, provider_refs, operating_status, fulfillment_eligible, contract)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb)`,
      [
        warehouseId,
        input.name,
        input.ownership ?? 'owned',
        input.operatorName || null,
        input.timezone ?? null,
        jsonParam(normalizeAddress(input.address ?? null)),
        jsonParam(compact(input.contact ?? null)),
        jsonParam(normalizeProviderRefs(input.providerRefs ?? [])),
        input.operatingStatus ?? 'operating',
        input.fulfillmentEligible ?? true,
        jsonParam(contract),
      ],
    );
    const warehouse = await loadWarehouse(ctx, warehouseId);
    const { contract: _hidden, activeLocations: _count, ...record } = warehouse;
    return {
      result: { warehouseId, warehouse },
      audit: {
        targetType: 'warehouse',
        targetId: warehouseId,
        // `contract` is a top-level key so activity reads can hide it (activity.ts).
        changes: { ...record, ...(contract ? { contract } : {}) },
      },
    };
  },
});

export const updateWarehouse = defineOperation({
  id: 'storage.warehouses.update',
  summary: 'Change a warehouse record',
  description:
    'Send only what changes, with the version you read. Renaming a warehouse updates the paths of its locations. Changing the contract needs the storage.commercial.read permission. Archived warehouses must be restored first.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    warehouseId: Id,
    expectedVersion: ExpectedVersion,
    name: Name.optional(),
    ...WarehouseInput,
  }),
  output: z.object({ warehouse: WarehouseOut, locationsRenamed: z.number().int() }),
  permission: 'storage.manage',
  connectionScope: 'storage:write',
  audit: { action: 'storage.warehouse.updated' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/warehouses/{warehouseId}' },
  mcp: { tool: TOOL, action: 'update_warehouse', readOnly: false, destructive: false },
  async handler(ctx, input) {
    assertWarehouseInScope(ctx, input.warehouseId);
    if (input.contract !== undefined) requireCommercial(ctx);
    const locked = await lockWarehouse(ctx.tx, input.warehouseId);
    checkVersion(locked.version, input.expectedVersion, 'warehouse');
    if (locked.status !== 'active') {
      throw errors.conflict('warehouse_archived', 'Restore the warehouse before changing it.');
    }
    const [current] = await ctx.tx.query<WarehouseRow>('select * from warehouses where id = $1', [
      input.warehouseId,
    ]);
    if (!current) throw errors.notFound('Warehouse');

    const next: Partial<Record<WarehouseField, unknown>> = {
      name: input.name,
      ownership: input.ownership,
      operatorName: input.operatorName === undefined ? undefined : input.operatorName || null,
      timezone: input.timezone,
      address: input.address === undefined ? undefined : normalizeAddress(input.address),
      contact: input.contact === undefined ? undefined : compact(input.contact),
      providerRefs:
        input.providerRefs === undefined ? undefined : normalizeProviderRefs(input.providerRefs),
      operatingStatus: input.operatingStatus,
      fulfillmentEligible: input.fulfillmentEligible,
    };
    const fields: Record<string, { from: unknown; to: unknown }> = {};
    const set: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(WAREHOUSE_FIELDS) as Array<
      [WarehouseField, (typeof WAREHOUSE_FIELDS)[WarehouseField]]
    >) {
      const value = next[key];
      if (value === undefined) continue;
      const before = current[column as keyof WarehouseRow];
      if (sameJson(before, value)) continue;
      fields[key] = { from: before, to: value };
      set[column] = value;
    }
    let contractChange: { from: unknown; to: unknown } | null = null;
    if (input.contract !== undefined) {
      const contract = await normalizeContract(ctx.tx, input.contract);
      if (!sameJson(current.contract, contract)) {
        contractChange = { from: current.contract, to: contract };
        set.contract = contract;
      }
    }
    if (Object.keys(set).length === 0) {
      return {
        result: { warehouse: await loadWarehouse(ctx, input.warehouseId), locationsRenamed: 0 },
        audit: { targetType: 'warehouse', targetId: input.warehouseId, outcome: 'no_change' },
      };
    }
    const columns = Object.keys(set);
    await ctx.tx.query(
      `update warehouses set ${columns
        .map((c, i) => `${c} = $${i + 2}${JSON_COLUMNS.has(c) ? '::jsonb' : ''}`)
        .join(', ')}, version = version + 1, updated_at = now()
       where id = $1`,
      [
        input.warehouseId,
        ...columns.map((c) => (JSON_COLUMNS.has(c) ? jsonParam(set[c]) : set[c])),
      ],
    );
    const locationsRenamed = fields.name ? await recomputePaths(ctx.tx, input.warehouseId) : 0;
    const warehouse = await loadWarehouse(ctx, input.warehouseId);
    return {
      result: { warehouse, locationsRenamed },
      audit: {
        targetType: 'warehouse',
        targetId: input.warehouseId,
        changes: {
          fields,
          ...(contractChange ? { contract: contractChange } : {}),
          version: warehouse.version,
          ...(locationsRenamed > 0 ? { locationsRenamed } : {}),
        },
      },
    };
  },
});

export const archiveWarehouse = defineOperation({
  id: 'storage.warehouses.archive',
  summary: 'Archive a warehouse and its locations',
  description:
    'Refused while any of its locations holds stock or open reservations, or a Shopify store sells from one. A shop keeps at least one active warehouse. History stays; restoring brings back the locations archived with it.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ warehouseId: Id }),
  output: StatusOut,
  permission: 'storage.manage',
  connectionScope: 'storage:write',
  audit: { action: 'storage.warehouse.archived' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/warehouses/{warehouseId}/archive' },
  mcp: { tool: TOOL, action: 'archive_warehouse', readOnly: false, destructive: false },
  async handler(ctx, input) {
    assertWarehouseInScope(ctx, input.warehouseId);
    const warehouse = await lockWarehouse(ctx.tx, input.warehouseId);
    if (warehouse.status === 'archived') {
      return {
        result: {
          id: warehouse.id,
          status: 'archived' as const,
          version: warehouse.version,
          locationsChanged: 0,
        },
        audit: { targetType: 'warehouse', targetId: warehouse.id, outcome: 'no_change' },
      };
    }
    const [others] = await ctx.tx.query<{ n: number }>(
      `select count(*)::int as n from warehouses where status = 'active' and id <> $1`,
      [warehouse.id],
    );
    if (others!.n === 0) {
      throw errors.conflict(
        'last_warehouse',
        'A shop keeps at least one active warehouse. Add another one first.',
      );
    }
    const locations = await ctx.tx.query<{ id: string; status: string }>(
      'select id, status from locations where warehouse_id = $1 order by id for update',
      [warehouse.id],
    );
    const ids = locations.map((l) => l.id);
    await assertNoStock(
      ctx.tx,
      ids,
      'Move the stock out and release the reservations before archiving this warehouse.',
    );
    await assertNotMapped(ctx.tx, ids);
    const active = locations.filter((l) => l.status === 'active').map((l) => l.id);
    const [row] = await ctx.tx.query<{ version: number }>(
      `with locs as (
         update locations set status = 'archived', archived_at = now(), archived_via = $1,
           version = version + 1, updated_at = now()
         where id = any($2::uuid[]))
       update warehouses set status = 'archived', archived_at = now(), version = version + 1,
         updated_at = now()
       where id = $1 returning version`,
      [warehouse.id, active],
    );
    return {
      result: {
        id: warehouse.id,
        status: 'archived' as const,
        version: row!.version,
        locationsChanged: active.length,
      },
      audit: {
        targetType: 'warehouse',
        targetId: warehouse.id,
        changes: {
          status: { from: 'active', to: 'archived' },
          archivedLocations: active,
          version: row!.version,
        },
        locationIds: active.slice(0, 100),
      },
    };
  },
});

export const restoreWarehouse = defineOperation({
  id: 'storage.warehouses.restore',
  summary: 'Restore an archived warehouse',
  description:
    'Brings back the warehouse and the locations archived with it. Locations archived on their own stay archived.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ warehouseId: Id }),
  output: StatusOut,
  permission: 'storage.manage',
  connectionScope: 'storage:write',
  audit: { action: 'storage.warehouse.restored' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/warehouses/{warehouseId}/restore' },
  mcp: { tool: TOOL, action: 'restore_warehouse', readOnly: false, destructive: false },
  async handler(ctx, input) {
    assertWarehouseInScope(ctx, input.warehouseId);
    const warehouse = await lockWarehouse(ctx.tx, input.warehouseId);
    if (warehouse.status === 'active') {
      return {
        result: {
          id: warehouse.id,
          status: 'active' as const,
          version: warehouse.version,
          locationsChanged: 0,
        },
        audit: { targetType: 'warehouse', targetId: warehouse.id, outcome: 'no_change' },
      };
    }
    const restored = await ctx.tx.query<{ id: string }>(
      `select id from locations where warehouse_id = $1 and archived_via = $1 order by id for update`,
      [warehouse.id],
    );
    const ids = restored.map((l) => l.id);
    const [row] = await ctx.tx.query<{ version: number }>(
      `with locs as (
         update locations set status = 'active', archived_at = null, archived_via = null,
           version = version + 1, updated_at = now()
         where id = any($2::uuid[]))
       update warehouses set status = 'active', archived_at = null, version = version + 1,
         updated_at = now()
       where id = $1 returning version`,
      [warehouse.id, ids],
    );
    return {
      result: {
        id: warehouse.id,
        status: 'active' as const,
        version: row!.version,
        locationsChanged: ids.length,
      },
      audit: {
        targetType: 'warehouse',
        targetId: warehouse.id,
        changes: {
          status: { from: 'archived', to: 'active' },
          restoredLocations: ids,
          version: row!.version,
        },
        locationIds: ids.slice(0, 100),
      },
    };
  },
});

// Locations --------------------------------------------------------------------------------

export const listLocations = defineOperation({
  id: 'storage.locations.list',
  summary: 'List warehouses and their locations',
  description:
    'Every location with its path, code, status, and version, in path order. Stock is held only at locations without children.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ warehouseId: Id.optional() }),
  output: z.object({
    partial: z.boolean().describe('True when your access is limited to some locations.'),
    locations: z.array(LocationOut),
  }),
  permission: 'storage.read',
  connectionScope: 'storage:read',
  audit: { action: 'storage.locations.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/locations' },
  mcp: { tool: TOOL, action: 'list_locations', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const locations = await loadLocations(ctx, { warehouseId: input.warehouseId });
    return {
      result: { partial: ctx.locationScope !== null, locations },
      audit: {
        targetType: 'location',
        targetId: 'list',
        locationIds: locations.map((l) => l.locationId).slice(0, 100),
      },
    };
  },
});

export const createLocation = defineOperation({
  id: 'storage.locations.create',
  summary: 'Create a storage location',
  description:
    'Creates a location in a warehouse, optionally inside another location. Stock is held only at locations without children, so a location that holds stock cannot gain children.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    warehouseId: Id,
    parentId: ParentId.optional(),
    name: Name,
    code: Code.optional(),
    fulfillmentEligible: FulfillmentEligible.optional(),
  }),
  output: z.object({ locationId: Id, path: z.string() }),
  permission: 'storage.manage',
  connectionScope: 'storage:write',
  audit: { action: 'storage.location.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/locations', status: 201 },
  mcp: { tool: TOOL, action: 'create_location', readOnly: false, destructive: false },
  locations: (input) => (input.parentId ? [input.parentId] : []),
  async handler(ctx, input) {
    const warehouse = await lockWarehouse(ctx.tx, input.warehouseId);
    if (warehouse.status !== 'active')
      throw errors.conflict('warehouse_archived', 'The warehouse is archived.');
    if (!input.parentId) assertWarehouseInScope(ctx, input.warehouseId);
    const id = ctx.newId();
    const code = input.code ?? null;
    const label = code ?? input.name;
    let path = topLevelPath(warehouse.name, label);
    let pathIds = [input.warehouseId, id];
    if (input.parentId) {
      const [parent] = await ctx.tx.query<{
        warehouse_id: string;
        path: string;
        path_ids: string[];
        status: string;
        holds_stock: boolean;
      }>(
        `select l.warehouse_id, l.path, l.path_ids, l.status,
           exists (select 1 from inventory_positions p
             where p.shop_id = l.shop_id and p.location_id = l.id
               and (p.on_hand > 0 or p.allocated > 0)) as holds_stock
         from locations l where l.id = $1 for update`,
        [input.parentId],
      );
      if (!parent) throw errors.notFound('Parent location');
      if (parent.warehouse_id !== input.warehouseId) {
        throw errors.unprocessable(
          'parent_in_other_warehouse',
          'The parent location is in another warehouse.',
        );
      }
      if (parent.status !== 'active') {
        throw errors.conflict('location_archived', 'The parent location is archived.');
      }
      if (parent.holds_stock) {
        throw errors.conflict(
          'location_holds_stock',
          'Move the stock out of this location before adding locations inside it.',
        );
      }
      path = `${parent.path}/${label}`;
      pathIds = [...parent.path_ids, id];
    }
    await assertCodeFree(ctx.tx, input.warehouseId, [{ id, code }]);
    await ctx.tx.query(
      `insert into locations (shop_id, id, warehouse_id, parent_id, name, code, path, path_ids, fulfillment_eligible)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7::uuid[], $8)`,
      [
        id,
        input.warehouseId,
        input.parentId ?? null,
        input.name,
        code,
        path,
        pathIds,
        input.fulfillmentEligible ?? true,
      ],
    );
    return {
      result: { locationId: id, path },
      audit: {
        targetType: 'location',
        targetId: id,
        changes: { ...input, path },
        locationIds: [id],
      },
    };
  },
});

export const updateLocation = defineOperation({
  id: 'storage.locations.update',
  summary: 'Rename a location, change its code, or its fulfillment eligibility',
  description:
    'Send only what changes, with the version you read. The paths of the location and everything inside it follow a new name or code. Archived locations must be restored first.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    locationId: Id,
    expectedVersion: ExpectedVersion,
    name: Name.optional(),
    code: Code.optional(),
    fulfillmentEligible: FulfillmentEligible.optional(),
  }),
  output: z.object({ location: LocationOut, locationsRenamed: z.number().int() }),
  permission: 'storage.manage',
  connectionScope: 'storage:write',
  audit: { action: 'storage.location.updated' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/locations/{locationId}' },
  mcp: { tool: TOOL, action: 'update_location', readOnly: false, destructive: false },
  locations: (input) => [input.locationId],
  async handler(ctx, input) {
    const { location } = await lockSubtree(ctx.tx, input.locationId);
    checkVersion(location.version, input.expectedVersion, 'location');
    if (location.status !== 'active') {
      throw errors.conflict('location_archived', 'Restore the location before changing it.');
    }
    const fields: Record<string, { from: unknown; to: unknown }> = {};
    if (input.name !== undefined && input.name !== location.name) {
      fields.name = { from: location.name, to: input.name };
    }
    if (input.code !== undefined && input.code !== location.code) {
      fields.code = { from: location.code, to: input.code };
      await assertCodeFree(ctx.tx, location.warehouse_id, [{ id: location.id, code: input.code }]);
    }
    if (
      input.fulfillmentEligible !== undefined &&
      input.fulfillmentEligible !== location.fulfillment_eligible
    ) {
      fields.fulfillmentEligible = {
        from: location.fulfillment_eligible,
        to: input.fulfillmentEligible,
      };
    }
    if (Object.keys(fields).length === 0) {
      return {
        result: { location: await loadLocation(ctx, location.id), locationsRenamed: 0 },
        audit: { targetType: 'location', targetId: location.id, outcome: 'no_change' },
      };
    }
    await ctx.tx.query(
      `update locations set name = coalesce($2, name),
         code = case when $3 then $4 else code end,
         fulfillment_eligible = coalesce($5, fulfillment_eligible),
         version = version + 1, updated_at = now()
       where id = $1`,
      [
        location.id,
        fields.name ? input.name : null,
        fields.code !== undefined,
        input.code ?? null,
        fields.fulfillmentEligible ? input.fulfillmentEligible : null,
      ],
    );
    const locationsRenamed =
      fields.name || fields.code ? await recomputePaths(ctx.tx, location.warehouse_id) : 0;
    const updated = await loadLocation(ctx, location.id);
    return {
      result: { location: updated, locationsRenamed },
      audit: {
        targetType: 'location',
        targetId: location.id,
        changes: {
          fields,
          ...(updated.path !== location.path
            ? { path: { from: location.path, to: updated.path } }
            : {}),
          version: updated.version,
          ...(locationsRenamed > 1 ? { locationsRenamed } : {}),
        },
        locationIds: [location.id],
      },
    };
  },
});

export const moveLocation = defineOperation({
  id: 'storage.locations.move',
  summary: 'Move a location to a new parent in the same warehouse',
  description:
    'Allowed only while the location and everything inside it hold no stock. parentId null moves it to the top level. Paths follow the move; a location cannot move inside itself.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ locationId: Id, expectedVersion: ExpectedVersion, parentId: ParentId }),
  output: z.object({ location: LocationOut, locationsMoved: z.number().int() }),
  permission: 'storage.manage',
  connectionScope: 'storage:write',
  audit: { action: 'storage.location.moved' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/locations/{locationId}/move' },
  mcp: { tool: TOOL, action: 'move_location', readOnly: false, destructive: false },
  locations: (input) => [input.locationId, ...(input.parentId ? [input.parentId] : [])],
  async handler(ctx, input) {
    const { location, subtree } = await lockSubtree(ctx.tx, input.locationId);
    checkVersion(location.version, input.expectedVersion, 'location');
    if (location.status !== 'active') {
      throw errors.conflict('location_archived', 'Restore the location before moving it.');
    }
    if (input.parentId === location.parent_id) {
      return {
        result: { location: await loadLocation(ctx, location.id), locationsMoved: 0 },
        audit: { targetType: 'location', targetId: location.id, outcome: 'no_change' },
      };
    }
    if (input.parentId !== null) {
      if (subtree.some((l) => l.id === input.parentId)) {
        throw errors.unprocessable(
          'move_cycle',
          'A location cannot move inside itself or a location inside it.',
        );
      }
      const [parent] = await ctx.tx.query<{
        warehouse_id: string;
        status: string;
        holds_stock: boolean;
      }>(
        `select l.warehouse_id, l.status,
           exists (select 1 from inventory_positions p
             where p.shop_id = l.shop_id and p.location_id = l.id
               and (p.on_hand > 0 or p.allocated > 0)) as holds_stock
         from locations l where l.id = $1 for update`,
        [input.parentId],
      );
      if (!parent) throw errors.notFound('Parent location');
      if (parent.warehouse_id !== location.warehouse_id) {
        throw errors.unprocessable(
          'parent_in_other_warehouse',
          'Locations move only within their warehouse.',
        );
      }
      if (parent.status !== 'active') {
        throw errors.conflict('location_archived', 'The new parent location is archived.');
      }
      if (parent.holds_stock) {
        throw errors.conflict(
          'location_holds_stock',
          'Move the stock out of the new parent before putting locations inside it.',
        );
      }
    } else {
      assertWarehouseInScope(ctx, location.warehouse_id);
    }
    const ids = subtree.map((l) => l.id);
    await assertNoStock(
      ctx.tx,
      ids,
      'Move the stock out of this location and the locations inside it before moving it.',
    );
    await ctx.tx.query(
      `update locations set parent_id = $2, version = version + 1, updated_at = now() where id = $1`,
      [location.id, input.parentId],
    );
    await recomputePaths(ctx.tx, location.warehouse_id);
    const moved = await loadLocation(ctx, location.id);
    return {
      result: { location: moved, locationsMoved: ids.length },
      audit: {
        targetType: 'location',
        targetId: location.id,
        changes: {
          parentId: { from: location.parent_id, to: input.parentId },
          path: { from: location.path, to: moved.path },
          locationsMoved: ids,
          version: moved.version,
        },
        locationIds: [...ids, ...(input.parentId ? [input.parentId] : [])].slice(0, 100),
      },
    };
  },
});

export const archiveLocation = defineOperation({
  id: 'storage.locations.archive',
  summary: 'Archive a location and everything inside it',
  description:
    'Refused while it or a location inside it holds stock or open reservations, or a Shopify store sells from it. Archived locations take no new operations; history stays. Restoring brings back the locations archived with it.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ locationId: Id }),
  output: StatusOut,
  permission: 'storage.manage',
  connectionScope: 'storage:write',
  audit: { action: 'storage.location.archived' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/locations/{locationId}/archive' },
  mcp: { tool: TOOL, action: 'archive_location', readOnly: false, destructive: false },
  locations: (input) => [input.locationId],
  async handler(ctx, input) {
    const { location, subtree } = await lockSubtree(ctx.tx, input.locationId);
    if (location.status === 'archived') {
      return {
        result: {
          id: location.id,
          status: 'archived' as const,
          version: location.version,
          locationsChanged: 0,
        },
        audit: { targetType: 'location', targetId: location.id, outcome: 'no_change' },
      };
    }
    const ids = subtree.map((l) => l.id);
    await assertNoStock(
      ctx.tx,
      ids,
      'Move the stock out and release the reservations before archiving this location.',
    );
    await assertNotMapped(ctx.tx, ids);
    const inside = subtree
      .filter((l) => l.id !== location.id && l.status === 'active')
      .map((l) => l.id);
    const [row] = await ctx.tx.query<{ version: number }>(
      `with inside as (
         update locations set status = 'archived', archived_at = now(), archived_via = $1,
           version = version + 1, updated_at = now()
         where id = any($2::uuid[]))
       update locations set status = 'archived', archived_at = now(), archived_via = null,
         version = version + 1, updated_at = now()
       where id = $1 returning version`,
      [location.id, inside],
    );
    return {
      result: {
        id: location.id,
        status: 'archived' as const,
        version: row!.version,
        locationsChanged: inside.length,
      },
      audit: {
        targetType: 'location',
        targetId: location.id,
        changes: {
          status: { from: 'active', to: 'archived' },
          archivedInside: inside,
          version: row!.version,
        },
        locationIds: [location.id, ...inside].slice(0, 100),
      },
    };
  },
});

export const restoreLocation = defineOperation({
  id: 'storage.locations.restore',
  summary: 'Restore an archived location',
  description:
    'Brings back the location and the locations archived with it. Its warehouse and the location above it must be active.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ locationId: Id }),
  output: StatusOut,
  permission: 'storage.manage',
  connectionScope: 'storage:write',
  audit: { action: 'storage.location.restored' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/locations/{locationId}/restore' },
  mcp: { tool: TOOL, action: 'restore_location', readOnly: false, destructive: false },
  locations: (input) => [input.locationId],
  async handler(ctx, input) {
    const { warehouse, location, subtree } = await lockSubtree(ctx.tx, input.locationId);
    if (location.status === 'active') {
      return {
        result: {
          id: location.id,
          status: 'active' as const,
          version: location.version,
          locationsChanged: 0,
        },
        audit: { targetType: 'location', targetId: location.id, outcome: 'no_change' },
      };
    }
    if (warehouse.status !== 'active') {
      throw errors.conflict('warehouse_archived', 'Restore the warehouse first.');
    }
    if (location.parent_id) {
      const [parent] = await ctx.tx.query<{ status: string }>(
        'select status from locations where id = $1',
        [location.parent_id],
      );
      if (parent?.status !== 'active') {
        throw errors.conflict('parent_archived', 'Restore the location above it first.');
      }
    }
    const inside = subtree.filter((l) => l.archived_via === location.id);
    await assertCodeFree(
      ctx.tx,
      location.warehouse_id,
      [location, ...inside].map((l) => ({ id: l.id, code: l.code })),
    );
    const insideIds = inside.map((l) => l.id);
    const [row] = await ctx.tx.query<{ version: number }>(
      `with inside as (
         update locations set status = 'active', archived_at = null, archived_via = null,
           version = version + 1, updated_at = now()
         where id = any($2::uuid[]))
       update locations set status = 'active', archived_at = null, archived_via = null,
         version = version + 1, updated_at = now()
       where id = $1 returning version`,
      [location.id, insideIds],
    );
    return {
      result: {
        id: location.id,
        status: 'active' as const,
        version: row!.version,
        locationsChanged: insideIds.length,
      },
      audit: {
        targetType: 'location',
        targetId: location.id,
        changes: {
          status: { from: 'archived', to: 'active' },
          restoredInside: insideIds,
          version: row!.version,
        },
        locationIds: [location.id, ...insideIds].slice(0, 100),
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const storageOperations = [
  listWarehouses,
  getWarehouse,
  createWarehouse,
  updateWarehouse,
  archiveWarehouse,
  restoreWarehouse,
  listLocations,
  createLocation,
  updateLocation,
  moveLocation,
  archiveLocation,
  restoreLocation,
] as const;
