import type { Tx } from '@airstock/db';
import { z } from 'zod';
import {
  BARCODE_LIMITS,
  type BarcodeOwner,
  checkBarcode,
  findBarcodeOwner,
  findBarcodeOwners,
  GENERATED_SYMBOLOGIES,
  internalCode,
  normalizeBarcode,
  SYMBOLOGIES,
  type Symbology,
} from '../catalog/barcodes.ts';
import { normalize } from '../catalog/decimal.ts';
import {
  PACK_LIMITS,
  PACK_USES,
  type PackSpec,
  type PackUse,
  resolvePacks,
} from '../catalog/packs.ts';
import { builtin, encodeDimensions, encodePrice } from '../catalog/records.ts';
import { PositiveDecimal } from '../decimal.ts';
import { errors } from '../errors.ts';
import { canonicalJson } from '../hash.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id } from '../schemas.ts';

// Packs, barcodes, and shipping packages of a variant (plan Sections 5.3 and 5.4, ADR 0019).
// Each list is replaced as a whole and carries the version the caller read, so a stale edit is
// refused instead of silently dropping someone else's change.

const TOOL = 'edit_catalog';

// Read model ---------------------------------------------------------------------------------

export const PackOut = z.object({
  id: Id,
  name: z.string(),
  quantity: z.string().describe('Base units, or inner packs when innerPackId is set.'),
  innerPackId: Id.nullable(),
  innerPackName: z.string().nullable(),
  baseQuantity: z.string().describe('Base units in one pack, through any inner packs.'),
  uses: z.array(z.enum(PACK_USES)),
  dimensions: z.unknown(),
  weight: z.unknown(),
  price: z.string().nullable(),
  status: z.enum(['active', 'archived']),
  version: z.number(),
});

export const BarcodeOut = z.object({
  id: Id,
  code: z.string(),
  symbology: z.enum(SYMBOLOGIES),
  packId: Id.nullable().describe('Null for the variant’s own barcode.'),
  source: z.enum(['entered', 'generated']),
});

const ShippingPackageOut = z.object({
  id: Id,
  name: z.string().nullable(),
  dimensions: z.unknown(),
  weight: z.unknown(),
});

export const BundleComponentOut = z.object({
  variantId: Id,
  sku: z.string(),
  productName: z.string(),
  title: z.string(),
  packId: Id.nullable(),
  packName: z.string().nullable(),
  quantity: z.string().describe('Packs when packId is set, otherwise base units.'),
  baseQuantity: z.string().describe('Base units of the component in one bundle.'),
  status: z.string().describe('The component variant’s status.'),
});

export const PackagingOut = z.object({
  variantId: Id,
  productId: Id,
  productName: z.string(),
  sku: z.string(),
  baseUnit: z.string(),
  quantityScale: z.number(),
  price: z.string().nullable(),
  packsVersion: z.number(),
  barcodesVersion: z.number(),
  shippingPackagesVersion: z.number(),
  bundleVersion: z.number().describe('0 until the variant is first made a bundle.'),
  packs: z.array(PackOut),
  barcodes: z.array(BarcodeOut),
  shippingPackages: z.array(ShippingPackageOut),
  bundle: z
    .object({ version: z.number(), active: z.boolean(), components: z.array(BundleComponentOut) })
    .nullable()
    .describe('Set when the variant is or was a bundle; inactive means it has no components.'),
  componentOf: z
    .array(z.object({ variantId: Id, sku: z.string(), productName: z.string() }))
    .describe('Bundles that contain this variant.'),
});
export type Packaging = z.infer<typeof PackagingOut>;

interface PackRow {
  id: string;
  name: string;
  quantity: string;
  inner_pack_id: string | null;
  base_quantity: string;
  uses: PackUse[];
  dimensions: unknown;
  weight: unknown;
  price: string | null;
  position: number;
  status: 'active' | 'archived';
  version: number;
}

const PACK_COLUMNS = `id, name, quantity::text as quantity, inner_pack_id,
  base_quantity::text as base_quantity, uses, dimensions, weight, price::text as price, position,
  status, version`;

/** Variant titles ("Black / M") from option value labels in option order. */
export const VARIANT_TITLE_SQL = (alias: string) =>
  `coalesce((select string_agg(ov.label, ' / ' order by o.position)
     from product_option_values ov
     join product_options o on o.shop_id = ov.shop_id and o.id = ov.option_id
     where ov.shop_id = ${alias}.shop_id and ov.id = any(${alias}.option_value_ids)), '')`;

export async function loadBundleComponents(
  tx: Tx,
  bundleVariantId: string,
): Promise<{
  id: string;
  version: number;
  active: boolean;
  components: z.infer<typeof BundleComponentOut>[];
} | null> {
  const [bundle] = await tx.query<{ id: string; version: number; active: boolean }>(
    'select id, version, active from bundles where variant_id = $1',
    [bundleVariantId],
  );
  if (!bundle) return null;
  const rows = await tx.query<{
    variant_id: string;
    sku: string;
    product_name: string;
    title: string;
    pack_id: string | null;
    pack_name: string | null;
    quantity: string;
    base_quantity: string;
    status: string;
  }>(
    `select c.variant_id, v.sku, p.name as product_name, ${VARIANT_TITLE_SQL('v')} as title,
       c.pack_id, k.name as pack_name, c.quantity::text as quantity,
       c.base_quantity::text as base_quantity, v.status
     from bundle_versions bv
     join bundle_components c on c.shop_id = bv.shop_id and c.bundle_version_id = bv.id
     join variants v on v.shop_id = c.shop_id and v.id = c.variant_id
     join products p on p.shop_id = v.shop_id and p.id = v.product_id
     left join packs k on k.shop_id = c.shop_id and k.id = c.pack_id
     where bv.bundle_id = $1 and bv.version = $2
     order by c.position`,
    [bundle.id, bundle.version],
  );
  return {
    ...bundle,
    components: rows.map((r) => ({
      variantId: r.variant_id,
      sku: r.sku,
      productName: r.product_name,
      title: r.title,
      packId: r.pack_id,
      packName: r.pack_name,
      quantity: r.quantity,
      baseQuantity: r.base_quantity,
      status: r.status,
    })),
  };
}

export async function loadPackaging(
  tx: Tx,
  variantId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<Packaging> {
  const [variant] = await tx.query<{
    id: string;
    product_id: string;
    product_name: string;
    sku: string;
    base_unit: string;
    quantity_scale: number;
    price: string | null;
    packs_version: number;
    barcodes_version: number;
    shipping_packages_version: number;
  }>(
    `select v.id, v.product_id, p.name as product_name, v.sku, v.base_unit, v.quantity_scale,
       v.price::text as price, coalesce(vp.packs_version, 0) as packs_version,
       coalesce(vp.barcodes_version, 0) as barcodes_version,
       coalesce(vp.shipping_packages_version, 0) as shipping_packages_version
     from variants v
     join products p on p.shop_id = v.shop_id and p.id = v.product_id
     left join variant_packaging vp on vp.shop_id = v.shop_id and vp.variant_id = v.id
     where v.id = $1`,
    [variantId],
  );
  if (!variant) throw errors.notFound('Variant');
  const packs = await tx.query<PackRow>(
    `select ${PACK_COLUMNS} from packs where variant_id = $1 and ($2 or status = 'active')
     order by status, position, id`,
    [variantId, opts.includeArchived ?? false],
  );
  const barcodes = await tx.query<{
    id: string;
    code: string;
    symbology: Symbology;
    pack_id: string | null;
    source: 'entered' | 'generated';
  }>(
    `select id, code, symbology, pack_id, source from barcodes where variant_id = $1
     order by pack_id nulls first, position, id`,
    [variantId],
  );
  const packages = await tx.query<{
    id: string;
    name: string | null;
    dimensions: unknown;
    weight: unknown;
  }>(
    'select id, name, dimensions, weight from shipping_packages where variant_id = $1 order by position',
    [variantId],
  );
  const bundle = await loadBundleComponents(tx, variantId);
  const componentOf = await tx.query<{ variant_id: string; sku: string; product_name: string }>(
    `select distinct v.id as variant_id, v.sku, p.name as product_name
     from bundle_components c
     join bundle_versions bv on bv.shop_id = c.shop_id and bv.id = c.bundle_version_id
     join bundles b on b.shop_id = bv.shop_id and b.id = bv.bundle_id and b.version = bv.version
     join variants v on v.shop_id = b.shop_id and v.id = b.variant_id
     join products p on p.shop_id = v.shop_id and p.id = v.product_id
     where c.variant_id = $1 and b.active
     order by v.sku`,
    [variantId],
  );
  const names = new Map(packs.map((p) => [p.id, p.name]));
  return {
    variantId: variant.id,
    productId: variant.product_id,
    productName: variant.product_name,
    sku: variant.sku,
    baseUnit: variant.base_unit,
    quantityScale: variant.quantity_scale,
    price: variant.price,
    packsVersion: variant.packs_version,
    barcodesVersion: variant.barcodes_version,
    shippingPackagesVersion: variant.shipping_packages_version,
    bundleVersion: bundle?.version ?? 0,
    packs: packs.map((p) => ({
      id: p.id,
      name: p.name,
      quantity: p.quantity,
      innerPackId: p.inner_pack_id,
      innerPackName: p.inner_pack_id ? (names.get(p.inner_pack_id) ?? null) : null,
      baseQuantity: p.base_quantity,
      uses: p.uses,
      dimensions: p.dimensions,
      weight: p.weight,
      price: p.price,
      status: p.status,
      version: p.version,
    })),
    barcodes: barcodes.map((b) => ({
      id: b.id,
      code: b.code,
      symbology: b.symbology,
      packId: b.pack_id,
      source: b.source,
    })),
    shippingPackages: packages,
    bundle: bundle
      ? { version: bundle.version, active: bundle.active, components: bundle.components }
      : null,
    componentOf: componentOf.map((c) => ({
      variantId: c.variant_id,
      sku: c.sku,
      productName: c.product_name,
    })),
  };
}

// Locking and versions -----------------------------------------------------------------------

interface LockedVariant {
  id: string;
  quantity_scale: number;
  packs_version: number;
  barcodes_version: number;
  shipping_packages_version: number;
}

/**
 * Locks the variant's packaging row (creating it on first use), which serializes edits to its
 * packs, barcodes, and shipping packages without locking the variant record itself.
 */
async function lockPackaging(ctx: HandlerContext, variantId: string): Promise<LockedVariant> {
  const [row] = await ctx.tx.query<LockedVariant>(
    `with v as (select id, quantity_scale from variants where id = $1),
     lock as (
       insert into variant_packaging (shop_id, variant_id)
       select app_shop_id(), id from v
       on conflict (shop_id, variant_id)
       do update set packs_version = variant_packaging.packs_version
       returning packs_version, barcodes_version, shipping_packages_version)
     select v.id, v.quantity_scale, lock.* from v cross join lock`,
    [variantId],
  );
  if (!row) throw errors.notFound('Variant');
  return row;
}

type ListColumn = 'packs_version' | 'barcodes_version' | 'shipping_packages_version';

function checkListVersion(current: number, expected: number, what: string) {
  if (current !== expected) {
    throw errors.conflict(
      'version_conflict',
      `The ${what} changed since you read them. Reload and retry.`,
      { currentVersion: current },
    );
  }
}

async function bumpVersion(ctx: HandlerContext, variantId: string, column: ListColumn) {
  const [row] = await ctx.tx.query<{ version: number }>(
    `update variant_packaging set ${column} = ${column} + 1 where variant_id = $1
     returning ${column} as version`,
    [variantId],
  );
  return row!.version;
}

const weightEncoder = builtin('weight', 'variant')!.encode;

// Packs --------------------------------------------------------------------------------------

const PackInput = z.object({
  id: Id.optional().describe('An existing pack, to change it. Leave out for a new pack.'),
  name: z.string().trim().min(1).max(100).describe('Such as Inner pack, Case, or Pallet.'),
  quantity: PositiveDecimal.describe(
    'How many base units the pack holds, or how many inner packs when innerPack is set.',
  ),
  innerPack: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'The pack this one is made of, by ID or by its name in this list: "a case holds 12 inner packs".',
    ),
  uses: z
    .array(z.enum(PACK_USES))
    .max(PACK_USES.length)
    .default(['purchasing', 'counting', 'transfer'])
    .describe('What the pack is used for. A sales pack is sold as one unit.'),
  dimensions: z.unknown().optional().describe('Such as "40 x 30 x 20 cm".'),
  weight: z.unknown().optional().describe('Such as "4.5 kg".'),
  price: z
    .string()
    .max(30)
    .nullable()
    .optional()
    .describe('Its own price; without one, the variant’s price per base unit applies.'),
});

interface PlannedPack {
  id: string;
  isNew: boolean;
  name: string;
  quantity: string;
  innerPackId: string | null;
  baseQuantity: string;
  uses: PackUse[];
  dimensions: unknown;
  weight: unknown;
  price: string | null;
  position: number;
}

function packDefinition(p: {
  name: string;
  quantity: string;
  innerPackId: string | null;
  baseQuantity: string;
  uses: PackUse[];
  dimensions: unknown;
  weight: unknown;
  price: string | null;
}) {
  return {
    name: p.name,
    quantity: normalize(p.quantity),
    innerPackId: p.innerPackId,
    baseQuantity: normalize(p.baseQuantity),
    uses: p.uses,
    dimensions: p.dimensions ?? null,
    weight: p.weight ?? null,
    price: p.price === null ? null : normalize(p.price),
  };
}

// jsonb does not keep key order, so compare canonical forms.
const sameJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Active bundles whose current definition uses one of these packs. */
async function packsInBundles(tx: Tx, packIds: string[]) {
  if (packIds.length === 0) return [];
  return tx.query<{ pack_id: string; sku: string }>(
    `select distinct c.pack_id, v.sku
     from bundle_components c
     join bundle_versions bv on bv.shop_id = c.shop_id and bv.id = c.bundle_version_id
     join bundles b on b.shop_id = bv.shop_id and b.id = bv.bundle_id and b.version = bv.version
     join variants v on v.shop_id = b.shop_id and v.id = b.variant_id
     where c.pack_id = any($1::uuid[]) and b.active`,
    [packIds],
  );
}

export const setPacks = defineOperation({
  id: 'catalog.packs.set',
  summary: 'Set the packs of a variant',
  description:
    'Replaces the variant’s list of packs (inner pack, case, pallet). Each pack holds a quantity of base units, or of another pack in the list ("a case holds 12 inner packs"), and resolves to an exact base quantity that must fit the variant’s decimal places. Packs left out are archived, never deleted. Pass packsVersion from get_packaging; a stale version returns version_conflict.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    variantId: Id,
    packsVersion: z.number().int().min(0).describe('packsVersion from get_packaging.'),
    packs: z.array(PackInput).max(PACK_LIMITS.perVariant),
  }),
  output: z.object({ packaging: PackagingOut }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.packs.set' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/variants/{variantId}/packs' },
  mcp: { tool: TOOL, action: 'set_packs', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const variant = await lockPackaging(ctx, input.variantId);
    checkListVersion(variant.packs_version, input.packsVersion, 'packs');
    const existing = await ctx.tx.query<PackRow>(
      `select ${PACK_COLUMNS} from packs where variant_id = $1`,
      [input.variantId],
    );
    const byId = new Map(existing.map((p) => [p.id, p]));
    const issues: Array<{ path: string; message: string }> = [];

    const ids = input.packs.map((p) => p.id ?? ctx.newId());
    for (const [i, p] of input.packs.entries()) {
      if (p.id && !byId.has(p.id))
        issues.push({ path: `packs.${i}.id`, message: 'Not a pack of this variant.' });
      if (p.id && input.packs.findIndex((q) => q.id === p.id) !== i)
        issues.push({ path: `packs.${i}.id`, message: 'Each pack may appear once.' });
      if (input.packs.findIndex((q) => q.name.toLowerCase() === p.name.toLowerCase()) !== i)
        issues.push({ path: `packs.${i}.name`, message: 'Each pack name may appear once.' });
    }
    const resolveInner = (ref: string | undefined, i: number): string | null => {
      if (!ref) return null;
      const byIdIndex = ids.indexOf(ref);
      const index =
        byIdIndex >= 0
          ? byIdIndex
          : input.packs.findIndex((q) => q.name.toLowerCase() === ref.toLowerCase());
      if (index < 0) {
        issues.push({ path: `packs.${i}.innerPack`, message: `No pack "${ref}" in this list.` });
        return null;
      }
      if (index === i) {
        issues.push({ path: `packs.${i}.innerPack`, message: 'A pack cannot hold itself.' });
        return null;
      }
      return ids[index]!;
    };

    const planned: PlannedPack[] = input.packs.map((p, i) => {
      const dimensions = encodeDimensions(p.dimensions ?? null);
      const weight = weightEncoder(p.weight ?? null);
      const price = encodePrice(p.price ?? null);
      if (!dimensions.ok)
        issues.push({ path: `packs.${i}.dimensions`, message: dimensions.message });
      if (!weight.ok) issues.push({ path: `packs.${i}.weight`, message: weight.message });
      if (!price.ok) issues.push({ path: `packs.${i}.price`, message: price.message });
      return {
        id: ids[i]!,
        isNew: !p.id,
        name: p.name,
        quantity: p.quantity,
        innerPackId: resolveInner(p.innerPack, i),
        baseQuantity: '0',
        uses: PACK_USES.filter((u) => p.uses.includes(u)),
        dimensions: dimensions.ok ? dimensions.value : null,
        weight: weight.ok ? weight.value : null,
        price: price.ok ? (price.value as string | null) : null,
        position: i,
      };
    });
    if (issues.length > 0) throw errors.validation(issues);

    const specs: PackSpec[] = planned.map((p) => ({
      key: p.id,
      name: p.name,
      quantity: p.quantity,
      inner: p.innerPackId,
    }));
    const resolved = resolvePacks(specs, variant.quantity_scale);
    if (!resolved.ok) {
      const pack = planned.find((p) => p.id === resolved.key)!;
      throw errors.unprocessable(resolved.code, resolved.message, {
        pack: pack.name,
        quantityScale: variant.quantity_scale,
      });
    }
    for (const p of planned) p.baseQuantity = resolved.base.get(p.id)!;

    // What changes.
    const keep = new Set(planned.map((p) => p.id));
    const archived = existing.filter((p) => p.status === 'active' && !keep.has(p.id));
    const changed: Array<{ plan: PlannedPack; before: PackRow }> = [];
    const added: PlannedPack[] = [];
    const moved: PlannedPack[] = [];
    for (const p of planned) {
      const before = byId.get(p.id);
      if (!before) {
        added.push(p);
        continue;
      }
      const from = packDefinition({
        name: before.name,
        quantity: before.quantity,
        innerPackId: before.inner_pack_id,
        baseQuantity: before.base_quantity,
        uses: before.uses,
        dimensions: before.dimensions,
        weight: before.weight,
        price: before.price,
      });
      if (!sameJson(from, packDefinition(p)) || before.status !== 'active')
        changed.push({ plan: p, before });
      else if (before.position !== p.position) moved.push(p);
    }

    // A bundle's definition keeps the base quantity it was written with, so the packs it uses
    // cannot change size or disappear underneath it.
    const resized = changed
      .filter((c) => normalize(c.before.base_quantity) !== normalize(c.plan.baseQuantity))
      .map((c) => c.plan.id);
    const inBundles = await packsInBundles(ctx.tx, [...resized, ...archived.map((p) => p.id)]);
    if (inBundles.length > 0) {
      const names = inBundles.map((b) => byId.get(b.pack_id)?.name ?? b.pack_id);
      throw errors.conflict(
        'pack_in_bundle',
        `${[...new Set(names)].join(', ')} is used by a bundle (${inBundles[0]!.sku}). Change the bundle first.`,
        { packs: [...new Set(inBundles.map((b) => b.pack_id))] },
      );
    }
    if (archived.length > 0) {
      const [supplied] = await ctx.tx.query<{ pack_id: string }>(
        `select pack_id from supplier_items where pack_id = any($1::uuid[]) and status = 'active' limit 1`,
        [archived.map((p) => p.id)],
      );
      if (supplied) {
        throw errors.conflict(
          'pack_in_use',
          `${byId.get(supplied.pack_id)!.name} is used by a supplier item. Change it first.`,
          { packId: supplied.pack_id },
        );
      }
    }

    if (added.length === 0 && changed.length === 0 && archived.length === 0 && moved.length === 0) {
      return {
        result: { packaging: await loadPackaging(ctx.tx, input.variantId) },
        audit: { targetType: 'variant', targetId: input.variantId, outcome: 'no_change' as const },
      };
    }

    const writes = [
      ...added.map((p) => ({ ...rowFor(p), status: 'active', version: 1 })),
      ...changed.map((c) => ({
        ...rowFor(c.plan),
        status: 'active',
        version: c.before.version + 1,
      })),
      ...archived.map((p) => ({
        id: p.id,
        name: p.name,
        quantity: p.quantity,
        inner_pack_id: p.inner_pack_id,
        base_quantity: p.base_quantity,
        uses: p.uses,
        dimensions: p.dimensions,
        weight: p.weight,
        price: p.price,
        position: p.position,
        status: 'archived',
        version: p.version + 1,
      })),
    ];
    if (writes.length > 0) {
      await ctx.tx.query(
        `with x as (
           select * from jsonb_to_recordset($1::jsonb) as x(id uuid, name text, quantity numeric,
             inner_pack_id uuid, base_quantity numeric, uses text[], dimensions jsonb, weight jsonb,
             price numeric, position integer, status text, version integer, version_id uuid)),
         packs_written as (
           insert into packs (shop_id, id, variant_id, name, quantity, inner_pack_id, base_quantity,
             uses, dimensions, weight, price, position, status, version)
           select app_shop_id(), id, $2, name, quantity, inner_pack_id, base_quantity, uses,
             dimensions, weight, price, position, status, version from x
           on conflict (shop_id, id) do update set name = excluded.name,
             quantity = excluded.quantity, inner_pack_id = excluded.inner_pack_id,
             base_quantity = excluded.base_quantity, uses = excluded.uses,
             dimensions = excluded.dimensions, weight = excluded.weight, price = excluded.price,
             position = excluded.position, status = excluded.status, version = excluded.version,
             updated_at = now()
           returning id)
         insert into pack_versions (shop_id, id, pack_id, version, name, quantity, inner_pack_id,
           base_quantity, uses, dimensions, weight, price, status)
         select app_shop_id(), x.version_id, x.id, x.version, x.name, x.quantity,
           x.inner_pack_id, x.base_quantity, x.uses, x.dimensions, x.weight, x.price, x.status
         from x join packs_written w on w.id = x.id`,
        [JSON.stringify(writes.map((w) => ({ ...w, version_id: ctx.newId() }))), input.variantId],
      );
    }
    for (const p of moved) {
      await ctx.tx.query('update packs set position = $2 where id = $1', [p.id, p.position]);
    }
    // An archived pack can no longer be scanned: its barcodes are released.
    const released =
      archived.length > 0
        ? await ctx.tx.query<{ code: string; pack_id: string }>(
            'delete from barcodes where pack_id = any($1::uuid[]) returning code, pack_id',
            [archived.map((p) => p.id)],
          )
        : [];
    if (released.length > 0) await bumpVersion(ctx, input.variantId, 'barcodes_version');
    const packsVersion = await bumpVersion(ctx, input.variantId, 'packs_version');
    return {
      result: { packaging: await loadPackaging(ctx.tx, input.variantId) },
      audit: {
        targetType: 'variant',
        targetId: input.variantId,
        changes: {
          packs: {
            added: added.map((p) => ({ id: p.id, ...packDefinition(p) })),
            changed: changed.map((c) => ({
              id: c.plan.id,
              from: packDefinition({
                name: c.before.name,
                quantity: c.before.quantity,
                innerPackId: c.before.inner_pack_id,
                baseQuantity: c.before.base_quantity,
                uses: c.before.uses,
                dimensions: c.before.dimensions,
                weight: c.before.weight,
                price: c.before.price,
              }),
              to: packDefinition(c.plan),
              version: c.before.version + 1,
            })),
            archived: archived.map((p) => ({ id: p.id, name: p.name })),
            reordered: moved.map((p) => p.id),
          },
          barcodesReleased: released.map((b) => ({ code: b.code, packId: b.pack_id })),
          packsVersion,
        },
      },
    };
  },
});

function rowFor(p: PlannedPack) {
  return {
    id: p.id,
    name: p.name,
    quantity: p.quantity,
    inner_pack_id: p.innerPackId,
    base_quantity: p.baseQuantity,
    uses: p.uses,
    dimensions: p.dimensions,
    weight: p.weight,
    price: p.price,
    position: p.position,
  };
}

// Shipping packages --------------------------------------------------------------------------

const ShippingPackageInput = z.object({
  name: z.string().trim().min(1).max(100).optional().describe('Such as "Box 1 of 3: frame".'),
  dimensions: z.unknown().describe('Such as "120 x 60 x 75 cm".'),
  weight: z.unknown().describe('Such as "18 kg".'),
});

export const setShippingPackages = defineOperation({
  id: 'catalog.shipping_packages.set',
  summary: 'Set the shipping packages of a variant',
  description:
    'Replaces the boxes one unit ships in, in order, each with dimensions and weight (for example a sofa shipped in three boxes). Shipping packages are not packs: they do not change quantities. Pass shippingPackagesVersion from get_packaging.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    variantId: Id,
    shippingPackagesVersion: z
      .number()
      .int()
      .min(0)
      .describe('shippingPackagesVersion from get_packaging.'),
    shippingPackages: z.array(ShippingPackageInput).max(20),
  }),
  output: z.object({ packaging: PackagingOut }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.shipping_packages.set' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/variants/{variantId}/shipping-packages' },
  mcp: { tool: TOOL, action: 'set_shipping_packages', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const variant = await lockPackaging(ctx, input.variantId);
    checkListVersion(
      variant.shipping_packages_version,
      input.shippingPackagesVersion,
      'shipping packages',
    );
    const issues: Array<{ path: string; message: string }> = [];
    const rows = input.shippingPackages.map((p, i) => {
      const dimensions = encodeDimensions(p.dimensions ?? null);
      const weight = weightEncoder(p.weight ?? null);
      if (!dimensions.ok)
        issues.push({ path: `shippingPackages.${i}.dimensions`, message: dimensions.message });
      else if (dimensions.value === null)
        issues.push({ path: `shippingPackages.${i}.dimensions`, message: 'Give the box size.' });
      if (!weight.ok)
        issues.push({ path: `shippingPackages.${i}.weight`, message: weight.message });
      else if (weight.value === null)
        issues.push({ path: `shippingPackages.${i}.weight`, message: 'Give the box weight.' });
      return {
        id: ctx.newId(),
        name: p.name ?? null,
        dimensions: dimensions.ok ? dimensions.value : null,
        weight: weight.ok ? weight.value : null,
        position: i,
      };
    });
    if (issues.length > 0) throw errors.validation(issues);
    const before = await ctx.tx.query<{
      name: string | null;
      dimensions: unknown;
      weight: unknown;
    }>(
      'select name, dimensions, weight from shipping_packages where variant_id = $1 order by position',
      [input.variantId],
    );
    const after = rows.map(({ name, dimensions, weight }) => ({ name, dimensions, weight }));
    if (sameJson(before, after)) {
      return {
        result: { packaging: await loadPackaging(ctx.tx, input.variantId) },
        audit: { targetType: 'variant', targetId: input.variantId, outcome: 'no_change' as const },
      };
    }
    await ctx.tx.query(
      `with gone as (delete from shipping_packages where variant_id = $2)
       insert into shipping_packages (shop_id, id, variant_id, position, name, dimensions, weight)
       select app_shop_id(), x.id, $2, x.position, x.name, x.dimensions, x.weight
       from jsonb_to_recordset($1::jsonb) as x(id uuid, position integer, name text, dimensions jsonb, weight jsonb)`,
      [JSON.stringify(rows), input.variantId],
    );
    const version = await bumpVersion(ctx, input.variantId, 'shipping_packages_version');
    return {
      result: { packaging: await loadPackaging(ctx.tx, input.variantId) },
      audit: {
        targetType: 'variant',
        targetId: input.variantId,
        changes: {
          shippingPackages: { from: before, to: after },
          shippingPackagesVersion: version,
        },
      },
    };
  },
});

// Barcodes -----------------------------------------------------------------------------------

const BarcodeInput = z.object({
  code: z.string().trim().min(1).max(BARCODE_LIMITS.codeLength),
  symbology: z
    .enum(SYMBOLOGIES)
    .describe(
      'ean13, ean8, and upca are checked for their check digit; qr and other take any text.',
    ),
  packId: Id.nullable()
    .optional()
    .describe('One of the variant’s packs; leave out for the variant itself.'),
});

function duplicate(owner: BarcodeOwner) {
  return errors.conflict(
    'duplicate_barcode',
    `This barcode already belongs to ${owner.sku}${owner.packName ? ` (${owner.packName})` : ''}.`,
    { existing: owner },
  );
}

export const setBarcodes = defineOperation({
  id: 'catalog.barcodes.set',
  summary: 'Set the barcodes of a variant and its packs',
  description:
    'Replaces every barcode of the variant and of its packs. A barcode is unique in the shop across variants and packs; one that another record holds returns duplicate_barcode with that record. EAN-13, EAN-8, and UPC-A check digits are validated. Pass barcodesVersion from get_packaging. To add an internal code, use generate_barcode.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    variantId: Id,
    barcodesVersion: z.number().int().min(0).describe('barcodesVersion from get_packaging.'),
    barcodes: z.array(BarcodeInput).max(BARCODE_LIMITS.perVariant),
  }),
  output: z.object({ packaging: PackagingOut }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.barcodes.set' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/variants/{variantId}/barcodes' },
  mcp: { tool: TOOL, action: 'set_barcodes', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const variant = await lockPackaging(ctx, input.variantId);
    checkListVersion(variant.barcodes_version, input.barcodesVersion, 'barcodes');
    const packs = await ctx.tx.query<{ id: string }>(
      `select id from packs where variant_id = $1 and status = 'active'`,
      [input.variantId],
    );
    const packIds = new Set(packs.map((p) => p.id));
    const issues: Array<{ path: string; message: string }> = [];
    const wanted = input.barcodes.map((b, i) => {
      const check = checkBarcode(b.code, b.symbology);
      if (!check.ok) issues.push({ path: `barcodes.${i}.code`, message: check.message });
      if (b.packId && !packIds.has(b.packId))
        issues.push({
          path: `barcodes.${i}.packId`,
          message: 'Not an active pack of this variant.',
        });
      return {
        code: check.ok ? check.code : b.code,
        normalized: check.ok ? check.normalized : '',
        symbology: b.symbology,
        packId: b.packId ?? null,
        position: i,
      };
    });
    wanted.forEach((w, i) => {
      if (w.normalized && wanted.findIndex((x) => x.normalized === w.normalized) !== i)
        issues.push({
          path: `barcodes.${i}.code`,
          message: 'This barcode is already in the list.',
        });
    });
    if (issues.length > 0) throw errors.validation(issues);

    const existing = await ctx.tx.query<{
      id: string;
      code: string;
      code_normalized: string;
      symbology: Symbology;
      pack_id: string | null;
      position: number;
      source: string;
    }>(
      'select id, code, code_normalized, symbology, pack_id, position, source from barcodes where variant_id = $1',
      [input.variantId],
    );
    const current = new Map(existing.map((b) => [b.code_normalized, b]));
    const added = wanted.filter((w) => !current.has(w.normalized));
    for (const owner of await findBarcodeOwners(
      ctx.tx,
      added.map((a) => a.normalized),
    )) {
      if (owner.variantId !== input.variantId) throw duplicate(owner);
    }
    const keep = new Set(wanted.map((w) => w.normalized));
    const removed = existing.filter((b) => !keep.has(b.code_normalized));
    const updated = wanted.filter((w) => {
      const b = current.get(w.normalized);
      return (
        b &&
        (b.code !== w.code ||
          b.symbology !== w.symbology ||
          b.pack_id !== w.packId ||
          b.position !== w.position)
      );
    });
    if (added.length === 0 && removed.length === 0 && updated.length === 0) {
      return {
        result: { packaging: await loadPackaging(ctx.tx, input.variantId) },
        audit: { targetType: 'variant', targetId: input.variantId, outcome: 'no_change' as const },
      };
    }
    if (removed.length > 0) {
      await ctx.tx.query('delete from barcodes where id = any($1::uuid[])', [
        removed.map((b) => b.id),
      ]);
    }
    for (const w of updated) {
      await ctx.tx.query(
        `update barcodes set code = $2, symbology = $3, pack_id = $4, position = $5
         where variant_id = $6 and code_normalized = $1`,
        [w.normalized, w.code, w.symbology, w.packId, w.position, input.variantId],
      );
    }
    if (added.length > 0) {
      await ctx.tx.query(
        `insert into barcodes (shop_id, id, variant_id, pack_id, symbology, code, code_normalized, position)
         select app_shop_id(), x.id, $2, x.pack_id, x.symbology, x.code, x.normalized, x.position
         from jsonb_to_recordset($1::jsonb) as x(id uuid, pack_id uuid, symbology text, code text,
           normalized text, position integer)`,
        [
          JSON.stringify(
            added.map((a) => ({
              id: ctx.newId(),
              pack_id: a.packId,
              symbology: a.symbology,
              code: a.code,
              normalized: a.normalized,
              position: a.position,
            })),
          ),
          input.variantId,
        ],
      );
    }
    const barcodesVersion = await bumpVersion(ctx, input.variantId, 'barcodes_version');
    const describe = (b: { code: string; symbology: string; packId: string | null }) => ({
      code: b.code,
      symbology: b.symbology,
      packId: b.packId,
    });
    return {
      result: { packaging: await loadPackaging(ctx.tx, input.variantId) },
      audit: {
        targetType: 'variant',
        targetId: input.variantId,
        changes: {
          barcodes: {
            added: added.map(describe),
            removed: removed.map((b) =>
              describe({ code: b.code, symbology: b.symbology, packId: b.pack_id }),
            ),
            changed: updated.map(describe),
          },
          barcodesVersion,
        },
      },
    };
  },
});

export const generateBarcode = defineOperation({
  id: 'catalog.barcodes.generate',
  summary: 'Generate an internal barcode for a variant or pack',
  description:
    'Adds a new internal code from the shop’s sequence (such as AS00000042) as a Code 128 barcode or a QR code. The code identifies the record inside this shop only; it is never a URL. Use it for items without a supplier barcode.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    variantId: Id,
    packId: Id.optional().describe('One of the variant’s packs; leave out for the variant itself.'),
    symbology: z.enum(GENERATED_SYMBOLOGIES).default('code128'),
  }),
  output: z.object({ barcode: BarcodeOut, packaging: PackagingOut }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.barcode.generated' },
  idempotency: 'required',
  http: {
    method: 'POST',
    path: '/shops/{shopId}/variants/{variantId}/barcodes/generate',
    status: 201,
  },
  mcp: { tool: TOOL, action: 'generate_barcode', readOnly: false, destructive: false },
  async handler(ctx, input) {
    await lockPackaging(ctx, input.variantId);
    if (input.packId) {
      const [pack] = await ctx.tx.query(
        `select 1 from packs where id = $1 and variant_id = $2 and status = 'active'`,
        [input.packId, input.variantId],
      );
      if (!pack) throw errors.notFound('Pack');
    }
    const [count] = await ctx.tx.query<{ n: number; next: number }>(
      'select count(*)::int as n, coalesce(max(position) + 1, 0)::int as next from barcodes where variant_id = $1',
      [input.variantId],
    );
    if (count!.n >= BARCODE_LIMITS.perVariant) {
      throw errors.unprocessable(
        'limit_reached',
        `A variant and its packs have at most ${BARCODE_LIMITS.perVariant} barcodes.`,
      );
    }
    // Skip sequence values a merchant already typed in as their own codes.
    let code = '';
    for (let attempt = 0; attempt < 100 && !code; attempt++) {
      const [next] = await ctx.tx.query<{ value: string }>(
        `insert into barcode_sequences (shop_id, last_value) values (app_shop_id(), 1)
         on conflict (shop_id) do update set last_value = barcode_sequences.last_value + 1
         returning last_value::text as value`,
      );
      const candidate = internalCode(next!.value);
      if (!(await findBarcodeOwner(ctx.tx, normalizeBarcode(candidate)))) code = candidate;
    }
    if (!code) throw errors.conflict('retry_conflict', 'Could not find a free code. Retry.');
    const id = ctx.newId();
    await ctx.tx.query(
      `insert into barcodes (shop_id, id, variant_id, pack_id, symbology, code, code_normalized, source, position)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6, 'generated', $7)`,
      [
        id,
        input.variantId,
        input.packId ?? null,
        input.symbology,
        code,
        normalizeBarcode(code),
        count!.next,
      ],
    );
    const barcodesVersion = await bumpVersion(ctx, input.variantId, 'barcodes_version');
    const barcode = {
      id,
      code,
      symbology: input.symbology,
      packId: input.packId ?? null,
      source: 'generated' as const,
    };
    return {
      result: { barcode, packaging: await loadPackaging(ctx.tx, input.variantId) },
      audit: {
        targetType: 'variant',
        targetId: input.variantId,
        changes: {
          barcode: { code, symbology: input.symbology, packId: barcode.packId },
          barcodesVersion,
        },
      },
    };
  },
});

// Reads --------------------------------------------------------------------------------------

export const getPackaging = defineOperation({
  id: 'catalog.packaging.get',
  summary: 'Get the packs, barcodes, shipping packages, and bundle of a variant',
  description:
    'Packs with their exact base quantities, every barcode of the variant and its packs, the boxes one unit ships in, and the bundle definition if the variant is one. The versions are what set_packs, set_barcodes, set_shipping_packages, and set_bundle expect.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    variantId: Id,
    includeArchived: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .optional()
      .describe('Also list archived packs.'),
  }),
  output: PackagingOut,
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.packaging.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/variants/{variantId}/packaging' },
  mcp: { tool: 'search_catalog', action: 'get_packaging', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const packaging = await loadPackaging(ctx.tx, input.variantId, {
      includeArchived: input.includeArchived === true || input.includeArchived === 'true',
    });
    return { result: packaging, audit: { targetType: 'variant', targetId: input.variantId } };
  },
});

export const lookupBarcode = defineOperation({
  id: 'catalog.barcodes.lookup',
  summary: 'Find the variant or pack a barcode belongs to',
  description:
    'Matches a scanned or typed code the way uniqueness does: GTINs in any length (UPC-A and EAN-13 match each other), other codes ignoring case. A pack match says how many base units the pack stands for.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ code: z.string().trim().min(1).max(BARCODE_LIMITS.codeLength) }),
  output: z.object({
    normalized: z.string(),
    match: z
      .object({
        barcodeId: Id,
        code: z.string(),
        symbology: z.enum(SYMBOLOGIES),
        variantId: Id,
        productId: Id,
        sku: z.string(),
        productName: z.string(),
        packId: Id.nullable(),
        packName: z.string().nullable(),
        baseQuantity: z.string(),
      })
      .nullable(),
  }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.barcode.looked_up' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/barcodes/lookup' },
  mcp: { tool: 'search_catalog', action: 'lookup_barcode', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const normalized = normalizeBarcode(input.code);
    const match = await findBarcodeOwner(ctx.tx, normalized);
    return {
      result: { normalized, match },
      audit: {
        targetType: match ? 'variant' : 'barcode',
        targetId: match?.variantId ?? 'lookup',
        context: { code: input.code, found: Boolean(match) },
      },
    };
  },
});
