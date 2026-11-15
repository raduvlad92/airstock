import type { Tx } from '@airstock/db';
import { z } from 'zod';
import type { Membership } from '../caller.ts';
import { normalize } from '../catalog/decimal.ts';
import { shopSettings } from '../catalog/store.ts';
import { NonNegativeDecimal, PositiveDecimal } from '../decimal.ts';
import { errors } from '../errors.ts';
import { effectivePermissions } from '../permissions.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id, iso, normalizeSku } from '../schemas.ts';

// Suppliers and supplier items (plan Section 5.6, ADR 0019). Costs are restricted: only members
// with costs.read see them, set them, or see them in the activity history (`changes.restricted`).

const TOOL = 'manage_suppliers';

/** Whether the caller may see and set costs (PRD 2.3). */
export function canSeeCosts(membership: Membership | null): boolean {
  return membership ? effectivePermissions(membership).has('costs.read') : false;
}

/** Audit changes that only members with `permission` may read; the activity history hides them. */
export function restricted(permission: 'costs.read', fields: Record<string, unknown>) {
  return { permission, fields };
}

// Arguments shared by several actions of manage_suppliers use one schema each (flat MCP schema).
const Name = z.string().trim().min(1).max(200);
const Text = (max: number) => z.string().trim().max(max).nullable().optional();
const Email = z
  .string()
  .trim()
  .max(320)
  .regex(/^$|^[^\s@]+@[^\s@]+$/, 'Use an email address.')
  .nullable()
  .optional();
const Currency = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code.')
  .optional()
  .describe('The shop currency; other currencies arrive later.');
const LeadTimeDays = z
  .number()
  .int()
  .min(0)
  .max(3650)
  .nullable()
  .optional()
  .describe('Days from order to delivery.');
const ExpectedVersion = z.number().int().min(1).describe('The version you read.');
const IncludeArchived = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .optional()
  .describe('Also list archived records.');
const Limit = z.coerce.number().int().min(1).max(200).default(50);
const After = Id.optional().describe('Cursor from the previous page.');
const OptionalId = Id.optional();

const SupplierFields = {
  contactName: Text(200),
  email: Email,
  phone: Text(50),
  website: Text(500),
  address: Text(1000),
  currency: Currency,
  leadTimeDays: LeadTimeDays,
  notes: Text(5000),
};

const SupplierOut = z.object({
  id: Id,
  name: z.string(),
  contactName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  address: z.string().nullable(),
  currency: z.string(),
  leadTimeDays: z.number().nullable(),
  notes: z.string().nullable(),
  status: z.enum(['active', 'archived']),
  version: z.number(),
  itemCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type SupplierView = z.infer<typeof SupplierOut>;

const SupplierItemOut = z.object({
  id: Id,
  supplierId: Id,
  supplierName: z.string(),
  variantId: Id,
  productId: Id,
  productName: z.string(),
  sku: z.string(),
  packId: Id.nullable(),
  packName: z.string().nullable(),
  packBaseQuantity: z.string().nullable(),
  supplierSku: z.string().nullable(),
  costVisible: z.boolean().describe('False when you lack costs.read: lastCost is then hidden.'),
  lastCost: z.string().nullable().describe('Per pack when packId is set, else per base unit.'),
  lastCostAt: z.string().nullable(),
  minimumOrderQuantity: z.string().nullable(),
  preferred: z.boolean(),
  status: z.enum(['active', 'archived']),
  version: z.number(),
});
type SupplierItemView = z.infer<typeof SupplierItemOut>;

interface SupplierRow {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  currency: string;
  lead_time_days: number | null;
  notes: string | null;
  status: 'active' | 'archived';
  version: number;
  item_count: number;
  created_at: Date;
  updated_at: Date;
}

const SUPPLIER_SELECT = `select s.id, s.name, s.contact_name, s.email, s.phone, s.website, s.address,
    s.currency, s.lead_time_days, s.notes, s.status, s.version, s.created_at, s.updated_at,
    (select count(*)::int from supplier_items i
      where i.shop_id = s.shop_id and i.supplier_id = s.id and i.status = 'active') as item_count
  from suppliers s`;

function supplierView(r: SupplierRow): SupplierView {
  return {
    id: r.id,
    name: r.name,
    contactName: r.contact_name,
    email: r.email,
    phone: r.phone,
    website: r.website,
    address: r.address,
    currency: r.currency,
    leadTimeDays: r.lead_time_days,
    notes: r.notes,
    status: r.status,
    version: r.version,
    itemCount: r.item_count,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

async function loadSupplier(tx: Tx, supplierId: string, lock = false): Promise<SupplierRow> {
  const [row] = await tx.query<SupplierRow>(
    `${SUPPLIER_SELECT} where s.id = $1${lock ? ' for update of s' : ''}`,
    [supplierId],
  );
  if (!row) throw errors.notFound('Supplier');
  return row;
}

interface ItemRow {
  id: string;
  supplier_id: string;
  supplier_name: string;
  variant_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  pack_id: string | null;
  pack_name: string | null;
  pack_base_quantity: string | null;
  supplier_sku: string | null;
  last_cost: string | null;
  last_cost_at: Date | null;
  minimum_order_quantity: string | null;
  preferred: boolean;
  status: 'active' | 'archived';
  version: number;
}

const ITEM_SELECT = `select i.id, i.supplier_id, s.name as supplier_name, i.variant_id, v.product_id,
    p.name as product_name, v.sku, i.pack_id, k.name as pack_name,
    k.base_quantity::text as pack_base_quantity, i.supplier_sku, i.last_cost::text as last_cost,
    i.last_cost_at, i.minimum_order_quantity::text as minimum_order_quantity, i.preferred,
    i.status, i.version
  from supplier_items i
  join suppliers s on s.shop_id = i.shop_id and s.id = i.supplier_id
  join variants v on v.shop_id = i.shop_id and v.id = i.variant_id
  join products p on p.shop_id = v.shop_id and p.id = v.product_id
  left join packs k on k.shop_id = i.shop_id and k.id = i.pack_id`;

function itemView(r: ItemRow, costs: boolean): SupplierItemView {
  return {
    id: r.id,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    variantId: r.variant_id,
    productId: r.product_id,
    productName: r.product_name,
    sku: r.sku,
    packId: r.pack_id,
    packName: r.pack_name,
    packBaseQuantity: r.pack_base_quantity,
    supplierSku: r.supplier_sku,
    costVisible: costs,
    lastCost: costs ? r.last_cost : null,
    lastCostAt: costs ? iso(r.last_cost_at) : null,
    minimumOrderQuantity: r.minimum_order_quantity,
    preferred: r.preferred,
    status: r.status,
    version: r.version,
  };
}

/** With `lock`, the row is locked first, so its version is the latest committed one. */
async function loadItem(tx: Tx, itemId: string, lock = false): Promise<ItemRow> {
  const [row] = await tx.query<ItemRow>(
    `${ITEM_SELECT} where i.id = $1${lock ? ' for update of i' : ''}`,
    [itemId],
  );
  if (!row) throw errors.notFound('Supplier item');
  return row;
}

function checkVersion(current: number, expected: number | undefined, what: string) {
  if (expected === undefined) {
    throw errors.validation([
      { path: 'expectedVersion', message: `Give the ${what} version you read.` },
    ]);
  }
  if (current !== expected) {
    throw errors.conflict(
      'version_conflict',
      `The ${what} changed since you read it. Reload and retry.`,
      {
        currentVersion: current,
      },
    );
  }
}

async function checkCurrency(ctx: HandlerContext, currency: string | undefined): Promise<string> {
  const { currency: shopCurrency } = await shopSettings(ctx.tx);
  if (currency && currency !== shopCurrency) {
    throw errors.unprocessable(
      'currency_not_supported',
      `Suppliers use the shop currency (${shopCurrency}) for now.`,
    );
  }
  return shopCurrency;
}

async function checkNameFree(tx: Tx, name: string, exceptId: string | null) {
  const [taken] = await tx.query<{ id: string }>(
    `select id from suppliers where lower(name) = lower($1) and status = 'active'
       and ($2::uuid is null or id <> $2)`,
    [name, exceptId],
  );
  if (taken) {
    throw errors.conflict('duplicate_supplier', 'A supplier with this name already exists.', {
      existingSupplierId: taken.id,
    });
  }
}

const empty = (v: string | null | undefined) => (v === undefined ? undefined : v || null);

// Suppliers ----------------------------------------------------------------------------------

export const listSuppliers = defineOperation({
  id: 'suppliers.list',
  summary: 'List suppliers',
  description: 'Suppliers by name, with how many active supplier items each has.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    query: z.string().trim().min(1).max(200).optional().describe('Text in the name or contact.'),
    includeArchived: IncludeArchived,
    limit: Limit,
    after: After,
  }),
  output: z.object({ suppliers: z.array(SupplierOut), nextCursor: z.string().nullable() }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'suppliers.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/suppliers' },
  mcp: { tool: TOOL, action: 'list', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const includeArchived = input.includeArchived === true || input.includeArchived === 'true';
    const pattern = input.query ? `%${input.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const rows = await ctx.tx.query<SupplierRow>(
      `${SUPPLIER_SELECT}
       where ($1 or s.status = 'active')
         and ($2::text is null or s.name ilike $2 or s.contact_name ilike $2 or s.email ilike $2)
         and ($3::uuid is null or (lower(s.name), s.id) >
           (select lower(c.name), c.id from suppliers c where c.id = $3))
       order by lower(s.name), s.id
       limit $4`,
      [includeArchived, pattern, input.after ?? null, input.limit + 1],
    );
    const page = rows.slice(0, input.limit);
    return {
      result: {
        suppliers: page.map(supplierView),
        nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
      },
      audit: { targetType: 'supplier', targetId: 'list' },
    };
  },
});

export const getSupplier = defineOperation({
  id: 'suppliers.get',
  summary: 'Get a supplier with its items',
  description:
    'The supplier’s details and the variants it supplies, with supplier SKUs and minimum order quantities. Costs are included only with the costs.read permission.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ supplierId: Id }),
  output: z.object({
    supplier: SupplierOut,
    items: z.array(SupplierItemOut),
    costVisible: z.boolean(),
  }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'suppliers.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/suppliers/{supplierId}' },
  mcp: { tool: TOOL, action: 'get', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const supplier = await loadSupplier(ctx.tx, input.supplierId);
    const costs = canSeeCosts(ctx.membership);
    const items = await ctx.tx.query<ItemRow>(
      `${ITEM_SELECT} where i.supplier_id = $1 and i.status = 'active' order by v.sku, i.id limit 500`,
      [input.supplierId],
    );
    return {
      result: {
        supplier: supplierView(supplier),
        items: items.map((r) => itemView(r, costs)),
        costVisible: costs,
      },
      audit: { targetType: 'supplier', targetId: input.supplierId, context: { costsShown: costs } },
    };
  },
});

export const createSupplier = defineOperation({
  id: 'suppliers.create',
  summary: 'Create a supplier',
  kind: 'command',
  scope: 'shop',
  input: z.object({ name: Name, ...SupplierFields }),
  output: z.object({ supplier: SupplierOut }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'supplier.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/suppliers', status: 201 },
  mcp: { tool: TOOL, action: 'create', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const currency = await checkCurrency(ctx, input.currency);
    await checkNameFree(ctx.tx, input.name, null);
    const id = ctx.newId();
    await ctx.tx.query(
      `insert into suppliers (shop_id, id, name, contact_name, email, phone, website, address,
         currency, lead_time_days, notes)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        input.name,
        empty(input.contactName) ?? null,
        empty(input.email) ?? null,
        empty(input.phone) ?? null,
        empty(input.website) ?? null,
        empty(input.address) ?? null,
        currency,
        input.leadTimeDays ?? null,
        empty(input.notes) ?? null,
      ],
    );
    const supplier = supplierView(await loadSupplier(ctx.tx, id));
    const fields = Object.fromEntries(
      [...Object.keys(COLUMN), 'currency'].map((k) => [
        k,
        (supplier as Record<string, unknown>)[k],
      ]),
    );
    return {
      result: { supplier },
      audit: { targetType: 'supplier', targetId: id, changes: { fields } },
    };
  },
});

const COLUMN: Record<string, string> = {
  name: 'name',
  contactName: 'contact_name',
  email: 'email',
  phone: 'phone',
  website: 'website',
  address: 'address',
  leadTimeDays: 'lead_time_days',
  notes: 'notes',
  status: 'status',
};

export const updateSupplier = defineOperation({
  id: 'suppliers.update',
  summary: 'Change or archive a supplier',
  description:
    'Changes the given fields; null clears one. status "archived" hides the supplier from new work and keeps its history; "active" restores it. Pass the version you read as expectedVersion.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    supplierId: Id,
    expectedVersion: ExpectedVersion,
    name: Name.optional(),
    ...SupplierFields,
    status: z.enum(['active', 'archived']).optional(),
  }),
  output: z.object({ supplier: SupplierOut }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'supplier.updated' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/suppliers/{supplierId}' },
  mcp: { tool: TOOL, action: 'update', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const before = await loadSupplier(ctx.tx, input.supplierId, true);
    checkVersion(before.version, input.expectedVersion, 'supplier');
    if (input.currency !== undefined) await checkCurrency(ctx, input.currency);
    const view = supplierView(before);
    const fields: Record<string, { from: unknown; to: unknown }> = {};
    const sets: string[] = [];
    const params: unknown[] = [input.supplierId];
    for (const key of Object.keys(COLUMN)) {
      const raw = (input as Record<string, unknown>)[key];
      if (raw === undefined) continue;
      const value =
        typeof raw === 'string' && key !== 'name' && key !== 'status' ? raw || null : raw;
      const from = (view as Record<string, unknown>)[key];
      if (value === from) continue;
      params.push(value);
      sets.push(`${COLUMN[key]} = $${params.length}`);
      fields[key] = { from, to: value };
    }
    const becomesActive =
      fields.status?.to === 'active' || (!fields.status && before.status === 'active');
    if ((fields.name || fields.status?.to === 'active') && becomesActive)
      await checkNameFree(ctx.tx, (input.name ?? before.name) as string, input.supplierId);
    if (sets.length === 0) {
      return {
        result: { supplier: view },
        audit: {
          targetType: 'supplier',
          targetId: input.supplierId,
          outcome: 'no_change' as const,
        },
      };
    }
    const [row] = await ctx.tx.query<{ version: number }>(
      `update suppliers set ${sets.join(', ')}, version = version + 1, updated_at = now()
       where id = $1 returning version`,
      params,
    );
    return {
      result: { supplier: supplierView(await loadSupplier(ctx.tx, input.supplierId)) },
      audit: {
        targetType: 'supplier',
        targetId: input.supplierId,
        changes: { fields, version: row!.version },
      },
    };
  },
});

// Supplier items -----------------------------------------------------------------------------

export const listSupplierItems = defineOperation({
  id: 'suppliers.items.list',
  summary: 'List supplier items for a variant or a supplier',
  description:
    'Who supplies a variant (or what a supplier supplies), with supplier SKUs, packs, minimum order quantities, and the preferred supplier. Costs are included only with the costs.read permission.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    variantId: OptionalId,
    supplierId: OptionalId,
    includeArchived: IncludeArchived,
    limit: Limit,
    after: After,
  }),
  output: z.object({
    items: z.array(SupplierItemOut),
    costVisible: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'supplier_items.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/supplier-items' },
  mcp: { tool: TOOL, action: 'list_items', readOnly: true, destructive: false },
  async handler(ctx, input) {
    if (!input.variantId && !input.supplierId) {
      throw errors.validation([
        { path: 'variantId', message: 'Give a variantId or a supplierId.' },
      ]);
    }
    const includeArchived = input.includeArchived === true || input.includeArchived === 'true';
    const costs = canSeeCosts(ctx.membership);
    const rows = await ctx.tx.query<ItemRow>(
      `${ITEM_SELECT}
       where ($1::uuid is null or i.variant_id = $1) and ($2::uuid is null or i.supplier_id = $2)
         and ($3 or i.status = 'active') and ($4::uuid is null or i.id > $4)
       order by i.id limit $5`,
      [
        input.variantId ?? null,
        input.supplierId ?? null,
        includeArchived,
        input.after ?? null,
        input.limit + 1,
      ],
    );
    const page = rows.slice(0, input.limit);
    return {
      result: {
        items: page.map((r) => itemView(r, costs)),
        costVisible: costs,
        nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
      },
      audit: {
        targetType: input.variantId ? 'variant' : 'supplier',
        targetId: input.variantId ?? input.supplierId!,
        context: { input, costsShown: costs },
      },
    };
  },
});

export const saveSupplierItem = defineOperation({
  id: 'suppliers.items.save',
  summary: 'Add or change a supplier item',
  description:
    'Without itemId, records that a supplier supplies a variant (optionally in one of its packs, such as a case) with its supplier SKU. With itemId and expectedVersion, changes the given fields; null clears one. preferred: true makes it the variant’s preferred supplier item. Setting lastCost needs the costs.read permission; it is per pack when a pack is set.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    itemId: OptionalId.describe('An existing supplier item, to change it.'),
    supplierId: OptionalId,
    variantId: OptionalId,
    packId: Id.nullable().optional().describe('The pack the supplier sells, such as a case.'),
    supplierSku: z.string().trim().min(1).max(100).nullable().optional(),
    lastCost: NonNegativeDecimal.nullable().optional(),
    minimumOrderQuantity: PositiveDecimal.nullable()
      .optional()
      .describe('In packs when a pack is set, else in base units.'),
    preferred: z.boolean().optional(),
    expectedVersion: ExpectedVersion.optional(),
  }),
  output: z.object({ item: SupplierItemOut }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'supplier_item.saved' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/supplier-items' },
  mcp: { tool: TOOL, action: 'save_item', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const costs = canSeeCosts(ctx.membership);
    if (input.lastCost !== undefined && !costs) {
      throw errors.forbidden('Setting a cost requires the costs.read permission.');
    }
    const before = input.itemId ? await loadItem(ctx.tx, input.itemId, true) : null;
    if (before) {
      checkVersion(before.version, input.expectedVersion, 'supplier item');
      if (before.status !== 'active')
        throw errors.conflict('supplier_item_archived', 'This supplier item was removed.');
      if (
        (input.supplierId && input.supplierId !== before.supplier_id) ||
        (input.variantId && input.variantId !== before.variant_id)
      ) {
        throw errors.validation([
          { path: 'supplierId', message: 'Remove the item and add a new one to move it.' },
        ]);
      }
    } else if (!input.supplierId || !input.variantId) {
      throw errors.validation([
        { path: 'supplierId', message: 'A new supplier item needs a supplierId and a variantId.' },
      ]);
    }
    const supplierId = before?.supplier_id ?? input.supplierId!;
    const variantId = before?.variant_id ?? input.variantId!;
    const [supplier] = await ctx.tx.query<{ status: string }>(
      'select status from suppliers where id = $1',
      [supplierId],
    );
    if (!supplier) throw errors.notFound('Supplier');
    if (!before && supplier.status !== 'active')
      throw errors.conflict('supplier_archived', 'The supplier is archived.');
    const [variant] = await ctx.tx.query('select 1 from variants where id = $1', [variantId]);
    if (!variant) throw errors.notFound('Variant');
    const packId = input.packId === undefined ? (before?.pack_id ?? null) : input.packId;
    if (packId) {
      const [pack] = await ctx.tx.query(
        `select 1 from packs where id = $1 and variant_id = $2 and status = 'active'`,
        [packId, variantId],
      );
      if (!pack) throw errors.notFound('Pack');
    }
    const supplierSku =
      input.supplierSku === undefined ? (before?.supplier_sku ?? null) : input.supplierSku;
    const lastCost =
      input.lastCost === undefined
        ? (before?.last_cost ?? null)
        : input.lastCost === null
          ? null
          : input.lastCost;
    const moq =
      input.minimumOrderQuantity === undefined
        ? (before?.minimum_order_quantity ?? null)
        : input.minimumOrderQuantity;
    const preferred = input.preferred ?? before?.preferred ?? false;

    const [clash] = await ctx.tx.query<{ id: string }>(
      `select id from supplier_items
       where supplier_id = $1 and variant_id = $2 and pack_id is not distinct from $3
         and status = 'active' and ($4::uuid is null or id <> $4)`,
      [supplierId, variantId, packId, before?.id ?? null],
    );
    if (clash) {
      throw errors.conflict(
        'supplier_item_exists',
        'This supplier already has an item for this variant and pack.',
        { existingItemId: clash.id },
      );
    }
    if (supplierSku) {
      const [taken] = await ctx.tx.query<{ id: string }>(
        `select id from supplier_items where supplier_id = $1 and supplier_sku_normalized = $2
           and status = 'active' and ($3::uuid is null or id <> $3)`,
        [supplierId, normalizeSku(supplierSku), before?.id ?? null],
      );
      if (taken) {
        throw errors.conflict(
          'duplicate_supplier_sku',
          'This supplier already uses this supplier SKU for another item.',
          { existingItemId: taken.id },
        );
      }
    }
    // One preferred item per variant: the previous one gives way.
    const demoted = preferred
      ? await ctx.tx.query<{ id: string }>(
          `update supplier_items set preferred = false, version = version + 1, updated_at = now()
           where variant_id = $1 and preferred and status = 'active' and ($2::uuid is null or id <> $2)
           returning id`,
          [variantId, before?.id ?? null],
        )
      : [];

    const id = before?.id ?? ctx.newId();
    const costChanged =
      (before?.last_cost ?? null) === null
        ? lastCost !== null
        : lastCost === null || normalize(lastCost) !== normalize(before!.last_cost!);
    const after = {
      packId,
      supplierSku,
      minimumOrderQuantity: moq === null ? null : normalize(moq),
      preferred,
    };
    const prior = before
      ? {
          packId: before.pack_id,
          supplierSku: before.supplier_sku,
          minimumOrderQuantity:
            before.minimum_order_quantity === null
              ? null
              : normalize(before.minimum_order_quantity),
          preferred: before.preferred,
        }
      : null;
    const fields: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(after) as Array<keyof typeof after>) {
      if (!prior || prior[key] !== after[key])
        fields[key] = { from: prior?.[key] ?? null, to: after[key] };
    }
    if (before && Object.keys(fields).length === 0 && !costChanged) {
      return {
        result: { item: itemView(before, costs) },
        audit: { targetType: 'supplier_item', targetId: id, outcome: 'no_change' as const },
      };
    }
    await ctx.tx.query(
      `insert into supplier_items (shop_id, id, supplier_id, variant_id, pack_id, supplier_sku,
         supplier_sku_normalized, last_cost, last_cost_at, minimum_order_quantity, preferred)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, case when $7::numeric is null then null else now() end, $8, $9)
       on conflict (shop_id, id) do update set pack_id = excluded.pack_id,
         supplier_sku = excluded.supplier_sku,
         supplier_sku_normalized = excluded.supplier_sku_normalized,
         last_cost = excluded.last_cost,
         last_cost_at = case when $10 then excluded.last_cost_at else supplier_items.last_cost_at end,
         minimum_order_quantity = excluded.minimum_order_quantity, preferred = excluded.preferred,
         version = supplier_items.version + 1, updated_at = now()`,
      [
        id,
        supplierId,
        variantId,
        packId,
        supplierSku,
        supplierSku ? normalizeSku(supplierSku) : null,
        lastCost,
        moq,
        preferred,
        costChanged,
      ],
    );
    const item = await loadItem(ctx.tx, id);
    return {
      result: { item: itemView(item, costs) },
      audit: {
        targetType: 'supplier_item',
        targetId: id,
        changes: {
          created: !before,
          supplierId,
          variantId,
          fields,
          ...(costChanged
            ? {
                restricted: restricted('costs.read', {
                  lastCost: { from: before?.last_cost ?? null, to: lastCost },
                }),
              }
            : {}),
          demotedPreferred: demoted.map((d) => d.id),
          version: item.version,
        },
      },
    };
  },
});

export const removeSupplierItem = defineOperation({
  id: 'suppliers.items.remove',
  summary: 'Remove a supplier item',
  description:
    'The supplier no longer supplies this variant or pack. The item is archived with its history.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ itemId: Id, expectedVersion: ExpectedVersion }),
  output: z.object({ item: SupplierItemOut }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'supplier_item.removed' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/supplier-items/{itemId}/remove' },
  mcp: { tool: TOOL, action: 'remove_item', readOnly: false, destructive: true },
  async handler(ctx, input) {
    const before = await loadItem(ctx.tx, input.itemId, true);
    checkVersion(before.version, input.expectedVersion, 'supplier item');
    const costs = canSeeCosts(ctx.membership);
    if (before.status === 'archived') {
      return {
        result: { item: itemView(before, costs) },
        audit: { targetType: 'supplier_item', targetId: before.id, outcome: 'no_change' as const },
      };
    }
    await ctx.tx.query(
      `update supplier_items set status = 'archived', preferred = false, version = version + 1,
         updated_at = now() where id = $1`,
      [before.id],
    );
    const item = await loadItem(ctx.tx, before.id);
    return {
      result: { item: itemView(item, costs) },
      audit: {
        targetType: 'supplier_item',
        targetId: before.id,
        changes: {
          fields: { status: { from: 'active', to: 'archived' } },
          supplierId: before.supplier_id,
          variantId: before.variant_id,
          version: item.version,
        },
      },
    };
  },
});
