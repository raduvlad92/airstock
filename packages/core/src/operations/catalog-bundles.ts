import { z } from 'zod';
import { decimalScale, multiply, normalize } from '../catalog/decimal.ts';
import { PositiveDecimal } from '../decimal.ts';
import { errors } from '../errors.ts';
import { defineOperation } from '../registry.ts';
import { Id, normalizeSku } from '../schemas.ts';
import { loadBundleComponents, loadPackaging, PackagingOut } from './catalog-packaging.ts';
import { POSITION_STOCK_SQL } from './inventory.ts';

// Bundle definitions and their computed availability (plan Section 5.5, PRD 4.8, ADR 0019).
// A bundle holds no stock: its availability is the smallest floor(component available ÷
// quantity per bundle). Reserving and fulfilling bundles arrive in Phase 2.

export const BUNDLE_LIMITS = { components: 50 } as const;

const ComponentInput = z.object({
  variantId: Id.optional().describe('The component variant; or give its sku.'),
  sku: z.string().trim().min(1).max(100).optional(),
  packId: Id.optional().describe('Count the component in this pack of it, such as a 6-pack.'),
  quantity: PositiveDecimal.describe(
    'How many units of the component (or packs, with packId) go into one bundle.',
  ),
});

export const setBundle = defineOperation({
  id: 'catalog.bundles.set',
  summary: 'Set the components of a bundle',
  description:
    'Makes the variant a bundle of other variants with exact quantities, such as one candle and two soaps, or changes its components. Each change is a new version; an empty list makes it an ordinary variant again. A bundle holds no stock of its own, and bundles cannot contain bundles. Pass bundleVersion from get_packaging (0 for a new bundle).',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    variantId: Id,
    bundleVersion: z.number().int().min(0).describe('bundleVersion from get_packaging.'),
    components: z.array(ComponentInput).max(BUNDLE_LIMITS.components),
  }),
  output: z.object({ packaging: PackagingOut }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.bundle.set' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/variants/{variantId}/bundle' },
  mcp: { tool: 'edit_catalog', action: 'set_bundle', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const issues: Array<{ path: string; message: string }> = [];
    // Components by ID or SKU.
    const skus = input.components
      .filter((c) => !c.variantId && c.sku)
      .map((c) => normalizeSku(c.sku!));
    const bySku = new Map(
      skus.length === 0
        ? []
        : (
            await ctx.tx.query<{ id: string; sku_normalized: string }>(
              'select id, sku_normalized from variants where sku_normalized = any($1::text[])',
              [skus],
            )
          ).map((r) => [r.sku_normalized, r.id]),
    );
    const componentIds = input.components.map((c, i) => {
      const id = c.variantId ?? (c.sku ? bySku.get(normalizeSku(c.sku)) : undefined);
      if (!c.variantId && !c.sku)
        issues.push({ path: `components.${i}`, message: 'Give a variantId or a sku.' });
      else if (!id)
        issues.push({ path: `components.${i}.sku`, message: 'No variant with this SKU.' });
      return id ?? '';
    });
    if (issues.length > 0) throw errors.validation(issues);

    // Lock the bundle and its components in ID order, so two definitions cannot each make the
    // other's component a bundle at the same time.
    const ids = [...new Set([input.variantId, ...componentIds])].sort();
    await ctx.tx.query(
      'select id from variants where id = any($1::uuid[]) order by id for update',
      [ids],
    );
    // A separate statement after the locks, so it sees what a concurrent definition committed.
    const locked = await ctx.tx.query<{
      id: string;
      sku: string;
      status: string;
      quantity_scale: number;
      is_bundle: boolean;
    }>(
      `select v.id, v.sku, v.status, v.quantity_scale,
         exists (select 1 from bundles b where b.shop_id = v.shop_id and b.variant_id = v.id and b.active) as is_bundle
       from variants v where v.id = any($1::uuid[])`,
      [ids],
    );
    const variants = new Map(locked.map((v) => [v.id, v]));
    if (!variants.has(input.variantId)) throw errors.notFound('Variant');
    if (componentIds.some((id) => !variants.has(id))) throw errors.notFound('Component variant');

    const [bundle] = await ctx.tx.query<{ id: string; version: number; active: boolean }>(
      'select id, version, active from bundles where variant_id = $1 for update',
      [input.variantId],
    );
    const currentVersion = bundle?.version ?? 0;
    if (currentVersion !== input.bundleVersion) {
      throw errors.conflict(
        'version_conflict',
        'The bundle changed since you read it. Reload and retry.',
        {
          currentVersion,
        },
      );
    }

    const packIds = input.components.flatMap((c) => (c.packId ? [c.packId] : []));
    const packs = new Map(
      (
        await ctx.tx.query<{
          id: string;
          variant_id: string;
          base_quantity: string;
          version: number;
          status: string;
        }>(
          'select id, variant_id, base_quantity::text as base_quantity, version, status from packs where id = any($1::uuid[])',
          [packIds],
        )
      ).map((p) => [p.id, p]),
    );

    const lines = input.components.map((c, i) => {
      const variantId = componentIds[i]!;
      const component = variants.get(variantId)!;
      const path = `components.${i}`;
      if (variantId === input.variantId)
        issues.push({ path, message: 'A bundle cannot contain itself.' });
      if (component.is_bundle)
        issues.push({
          path,
          message: `${component.sku} is a bundle; bundles cannot contain bundles.`,
        });
      if (component.status !== 'active')
        issues.push({ path, message: `${component.sku} is archived.` });
      let baseQuantity = normalize(c.quantity);
      let packVersion: number | null = null;
      if (c.packId) {
        const pack = packs.get(c.packId);
        if (!pack || pack.variant_id !== variantId || pack.status !== 'active') {
          issues.push({
            path: `${path}.packId`,
            message: `Not an active pack of ${component.sku}.`,
          });
        } else {
          if (decimalScale(normalize(c.quantity)) > 0)
            issues.push({ path: `${path}.quantity`, message: 'Use a whole number of packs.' });
          baseQuantity = normalize(multiply(c.quantity, pack.base_quantity, 12));
          packVersion = pack.version;
        }
      }
      if (decimalScale(baseQuantity) > component.quantity_scale) {
        issues.push({
          path: `${path}.quantity`,
          message: `${component.sku} allows ${component.quantity_scale} decimal places in quantities.`,
        });
      }
      return {
        variantId,
        packId: c.packId ?? null,
        packVersion,
        quantity: normalize(c.quantity),
        baseQuantity,
        position: i,
      };
    });
    lines.forEach((l, i) => {
      if (lines.findIndex((x) => x.variantId === l.variantId && x.packId === l.packId) !== i)
        issues.push({ path: `components.${i}`, message: 'This component is already in the list.' });
    });
    if (issues.length > 0) throw errors.validation(issues);

    if (lines.length > 0) {
      const [usedIn] = await ctx.tx.query<{ sku: string }>(
        `select v.sku from bundle_components c
         join bundle_versions bv on bv.shop_id = c.shop_id and bv.id = c.bundle_version_id
         join bundles b on b.shop_id = bv.shop_id and b.id = bv.bundle_id and b.version = bv.version
         join variants v on v.shop_id = b.shop_id and v.id = b.variant_id
         where c.variant_id = $1 and b.active limit 1`,
        [input.variantId],
      );
      if (usedIn) {
        throw errors.conflict(
          'bundle_is_component',
          `This variant is a component of the bundle ${usedIn.sku}; bundles cannot contain bundles.`,
        );
      }
      const [stock] = await ctx.tx.query(
        `select 1 from inventory_positions where variant_id = $1 and (on_hand > 0 or allocated > 0) limit 1`,
        [input.variantId],
      );
      if (stock) {
        throw errors.conflict(
          'bundle_holds_stock',
          'A bundle holds no stock of its own. Move or adjust this variant’s stock first.',
        );
      }
    }

    const before = bundle ? await loadBundleComponents(ctx.tx, input.variantId) : null;
    const describe = (l: {
      variantId: string;
      packId: string | null;
      quantity: string;
      baseQuantity: string;
    }) => ({
      variantId: l.variantId,
      packId: l.packId,
      quantity: normalize(l.quantity),
      baseQuantity: normalize(l.baseQuantity),
    });
    const from = (before?.active ? before.components : []).map(describe);
    const to = lines.map(describe);
    if (JSON.stringify(from) === JSON.stringify(to)) {
      return {
        result: { packaging: await loadPackaging(ctx.tx, input.variantId) },
        audit: { targetType: 'variant', targetId: input.variantId, outcome: 'no_change' as const },
      };
    }

    const bundleId = bundle?.id ?? ctx.newId();
    const version = currentVersion + 1;
    const versionId = ctx.newId();
    await ctx.tx.query(
      `with b as (
         insert into bundles (shop_id, id, variant_id, version, active)
         values (app_shop_id(), $1, $2, $3, $4)
         on conflict (shop_id, variant_id)
         do update set version = excluded.version, active = excluded.active, updated_at = now()),
       bv as (
         insert into bundle_versions (shop_id, id, bundle_id, version) values (app_shop_id(), $5, $1, $3))
       insert into bundle_components (shop_id, id, bundle_version_id, position, variant_id, pack_id,
         pack_version, quantity, base_quantity)
       select app_shop_id(), x.id, $5, x.position, x.variant_id, x.pack_id, x.pack_version,
         x.quantity, x.base_quantity
       from jsonb_to_recordset($6::jsonb) as x(id uuid, position integer, variant_id uuid,
         pack_id uuid, pack_version integer, quantity numeric, base_quantity numeric)`,
      [
        bundleId,
        input.variantId,
        version,
        lines.length > 0,
        versionId,
        JSON.stringify(
          lines.map((l) => ({
            id: ctx.newId(),
            position: l.position,
            variant_id: l.variantId,
            pack_id: l.packId,
            pack_version: l.packVersion,
            quantity: l.quantity,
            base_quantity: l.baseQuantity,
          })),
        ),
      ],
    );
    return {
      result: { packaging: await loadPackaging(ctx.tx, input.variantId) },
      audit: {
        targetType: 'variant',
        targetId: input.variantId,
        changes: { bundle: { version, active: lines.length > 0, from, to } },
      },
    };
  },
});

const ComponentAvailability = z.object({
  variantId: Id,
  sku: z.string(),
  status: z.string(),
  perBundle: z.string().describe('Base units of the component in one bundle.'),
  available: z.string().describe('Sellable units available in the scope.'),
  bundles: z.string().describe('Whole bundles this component allows.'),
});

export const getBundleAvailability = defineOperation({
  id: 'catalog.bundles.availability',
  summary: 'Get how many of a bundle can be sold',
  description:
    'The smallest floor(component available ÷ quantity per bundle) over the bundle’s components, for the whole shop, a warehouse, or a location and its sub-locations. Only stock you can access counts; `partial` says when that is a subset. An archived component makes the bundle unavailable.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    variantId: Id,
    locationId: Id.optional().describe('A location; its sub-locations count too.'),
    warehouseId: Id.optional(),
  }),
  output: z.object({
    variantId: Id,
    sku: z.string(),
    bundleVersion: z.number(),
    partial: z.boolean(),
    available: z.string().describe('Whole bundles available.'),
    limitedBy: Id.nullable().describe('The component that sets the limit.'),
    components: z.array(ComponentAvailability),
  }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'catalog.bundle_availability.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/variants/{variantId}/bundle-availability' },
  mcp: {
    tool: 'search_catalog',
    action: 'bundle_availability',
    readOnly: true,
    destructive: false,
  },
  locations: (input) => (input.locationId ? [input.locationId] : []),
  async handler(ctx, input) {
    const [bundle] = await ctx.tx.query<{
      id: string;
      version: number;
      active: boolean;
      sku: string;
    }>(
      `select b.id, b.version, b.active, v.sku from variants v
       left join bundles b on b.shop_id = v.shop_id and b.variant_id = v.id
       where v.id = $1`,
      [input.variantId],
    );
    if (!bundle) throw errors.notFound('Variant');
    if (!bundle.active) throw errors.unprocessable('not_a_bundle', 'This variant is not a bundle.');
    if (input.warehouseId) {
      const [warehouse] = await ctx.tx.query('select 1 from warehouses where id = $1', [
        input.warehouseId,
      ]);
      if (!warehouse) throw errors.notFound('Warehouse');
    }
    // Components that appear in more than one pack add up per variant.
    const rows = await ctx.tx.query<{
      variant_id: string;
      sku: string;
      status: string;
      per_bundle: string;
      available: string;
      bundles: string;
      location_ids: string[];
    }>(
      `with comp as (
         select c.variant_id, sum(c.base_quantity) as per_bundle
         from bundle_versions bv
         join bundle_components c on c.shop_id = bv.shop_id and c.bundle_version_id = bv.id
         where bv.bundle_id = $5 and bv.version = $6
         group by c.variant_id),
       rows as (${POSITION_STOCK_SQL}),
       totals as (
         select comp.variant_id, comp.per_bundle,
           greatest(coalesce(sum(rows.available), 0), 0) as available,
           coalesce(array_agg(distinct rows.location_id) filter (where rows.location_id is not null), '{}') as location_ids
         from comp left join rows on rows.variant_id = comp.variant_id
         group by comp.variant_id, comp.per_bundle)
       select t.variant_id, v.sku, v.status, t.per_bundle::text as per_bundle,
         t.available::text as available,
         case when v.status = 'active' then div(t.available, t.per_bundle) else 0 end::text as bundles,
         t.location_ids
       from totals t join variants v on v.shop_id = app_shop_id() and v.id = t.variant_id
       order by v.sku`,
      [
        await componentIds(ctx.tx, bundle.id, bundle.version),
        input.locationId ?? null,
        ctx.locationScope,
        input.warehouseId ?? null,
        bundle.id,
        bundle.version,
      ],
    );
    let limitedBy: string | null = null;
    let available: bigint | null = null;
    for (const r of rows) {
      const n = BigInt(r.bundles);
      if (available === null || n < available) {
        available = n;
        limitedBy = r.variant_id;
      }
    }
    const locationIds = [...new Set(rows.flatMap((r) => r.location_ids))];
    return {
      result: {
        variantId: input.variantId,
        sku: bundle.sku,
        bundleVersion: bundle.version,
        partial: ctx.locationScope !== null,
        available: String(available ?? 0n),
        limitedBy,
        components: rows.map((r) => ({
          variantId: r.variant_id,
          sku: r.sku,
          status: r.status,
          perBundle: r.per_bundle,
          available: r.available,
          bundles: r.bundles,
        })),
      },
      audit: {
        targetType: 'variant',
        targetId: input.variantId,
        locationIds: locationIds.slice(0, 100),
        context: { input, bundleVersion: bundle.version },
      },
    };
  },
});

async function componentIds(
  tx: Parameters<typeof loadPackaging>[0],
  bundleId: string,
  version: number,
): Promise<string[]> {
  const rows = await tx.query<{ variant_id: string }>(
    `select distinct c.variant_id from bundle_versions bv
     join bundle_components c on c.shop_id = bv.shop_id and c.bundle_version_id = bv.id
     where bv.bundle_id = $1 and bv.version = $2`,
    [bundleId, version],
  );
  return rows.map((r) => r.variant_id);
}
