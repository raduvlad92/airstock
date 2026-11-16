import { z } from 'zod';
import { locationCode, SYMBOLOGIES, type Symbology } from '../catalog/barcodes.ts';
import { multiply, normalize } from '../catalog/decimal.ts';
import { shopSettings } from '../catalog/store.ts';
import { errors } from '../errors.ts';
import {
  BUILTIN_TEMPLATES,
  ITEM_LABEL_FIELDS,
  LABEL_KINDS,
  LABEL_LAYOUT_KEYS,
  LABEL_LIMITS,
  type LabelKind,
  LOCATION_LABEL_FIELDS,
} from '../labels/layouts.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id, iso } from '../schemas.ts';
import { VARIANT_TITLE_SQL } from './catalog-packaging.ts';

// Labels (plan Section 5.4, D9, ADR 0019). The server resolves and logs what goes on each label;
// the browser draws the PDF with bwip-js and pdf-lib, so rendering costs the server no CPU.

const MCP_EXCEPTION = {
  exception:
    'Labels are drawn as a PDF in the dashboard and printed from the browser; an MCP client cannot print them.',
};

const TemplateOut = z.object({
  id: Id.nullable().describe('Null for a built-in template.'),
  key: z.string().nullable().describe('The built-in template’s key.'),
  name: z.string(),
  kind: z.enum(LABEL_KINDS),
  layout: z.enum(LABEL_LAYOUT_KEYS),
  fields: z.array(z.string()),
  status: z.enum(['active', 'archived']),
  version: z.number(),
  updatedAt: z.string().nullable(),
});
type TemplateView = z.infer<typeof TemplateOut>;

const ResolvedTemplate = z.object({
  name: z.string(),
  layout: z.enum(LABEL_LAYOUT_KEYS),
  fields: z.array(z.string()),
});

const TemplateChoice = {
  templateId: Id.optional().describe('A saved template.'),
  template: z.string().max(100).optional().describe('A built-in template key.'),
  layout: z
    .enum(LABEL_LAYOUT_KEYS)
    .optional()
    .describe('Without a template: the sheet or label size.'),
  fields: z
    .array(z.string().max(50))
    .max(10)
    .optional()
    .describe('Without a template: what to print.'),
};

function fieldsFor(kind: LabelKind): readonly string[] {
  return kind === 'item' ? ITEM_LABEL_FIELDS : LOCATION_LABEL_FIELDS;
}

async function resolveTemplate(
  ctx: HandlerContext,
  kind: LabelKind,
  input: { templateId?: string; template?: string; layout?: string; fields?: string[] },
): Promise<z.infer<typeof ResolvedTemplate>> {
  let chosen: { name: string; kind: string; layout: string; fields: string[] } | undefined;
  if (input.templateId) {
    const [row] = await ctx.tx.query<{
      name: string;
      kind: string;
      layout: string;
      fields: string[];
    }>(
      `select name, kind, layout, fields from label_templates where id = $1 and status = 'active'`,
      [input.templateId],
    );
    if (!row) throw errors.notFound('Label template');
    chosen = row;
  } else if (input.template) {
    chosen = BUILTIN_TEMPLATES.find((t) => t.key === input.template);
    if (!chosen) throw errors.notFound('Label template');
  } else if (input.layout) {
    chosen = {
      name: 'Custom',
      kind,
      layout: input.layout,
      fields: input.fields ?? [...fieldsFor(kind)],
    };
  } else {
    chosen = BUILTIN_TEMPLATES.find((t) => t.kind === kind);
  }
  if (!chosen || chosen.kind !== kind) {
    throw errors.unprocessable('wrong_template_kind', `Choose a template for ${kind} labels.`);
  }
  const allowed = fieldsFor(kind);
  const fields = (
    input.layout && !input.templateId && !input.template
      ? (input.fields ?? chosen.fields)
      : chosen.fields
  ).filter((f, i, all) => allowed.includes(f) && all.indexOf(f) === i);
  return {
    name: chosen.name,
    layout: chosen.layout as z.infer<typeof ResolvedTemplate>['layout'],
    fields,
  };
}

function totalCopies(entries: Array<{ copies: number }>) {
  const total = entries.reduce((n, e) => n + e.copies, 0);
  if (total > LABEL_LIMITS.labels) {
    throw errors.unprocessable(
      'too_many_labels',
      `Print at most ${LABEL_LIMITS.labels} labels at a time.`,
    );
  }
  return total;
}

const Copies = z.number().int().min(1).max(LABEL_LIMITS.copies).default(1);

const Barcode = z
  .object({ symbology: z.enum(SYMBOLOGIES), code: z.string() })
  .nullable()
  .describe('Null when the record has no barcode.');

// Item and pack labels -----------------------------------------------------------------------

export const renderItemLabels = defineOperation({
  id: 'labels.items.render',
  summary: 'Resolve item and pack labels for printing',
  description:
    'Returns what goes on each label: name, SKU, option values, price, pack, and the first barcode of the variant or pack. A pack label carries the pack’s own barcode and price (or the variant’s price per base unit times the pack). The dashboard draws the PDF.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    items: z
      .array(z.object({ variantId: Id, packId: Id.optional(), copies: Copies }))
      .min(1)
      .max(LABEL_LIMITS.entries),
    ...TemplateChoice,
  }),
  output: z.object({
    template: ResolvedTemplate,
    currency: z.string(),
    total: z.number(),
    missingBarcodes: z.number(),
    labels: z.array(
      z.object({
        kind: z.enum(['variant', 'pack']),
        variantId: Id,
        packId: Id.nullable(),
        copies: z.number(),
        name: z.string(),
        sku: z.string(),
        options: z.string(),
        price: z.string().nullable(),
        pack: z.string().nullable(),
        barcode: Barcode,
      }),
    ),
  }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'labels.items.rendered' },
  idempotency: 'none',
  // POST: the record list is too long for a query string. It is still a read.
  http: { method: 'POST', path: '/shops/{shopId}/labels/items' },
  mcp: MCP_EXCEPTION,
  async handler(ctx, input) {
    const total = totalCopies(input.items);
    const template = await resolveTemplate(ctx, 'item', input);
    const { currency } = await shopSettings(ctx.tx);
    const variantIds = [...new Set(input.items.map((i) => i.variantId))];
    const variants = new Map(
      (
        await ctx.tx.query<{
          id: string;
          sku: string;
          name: string;
          title: string;
          price: string | null;
          base_unit: string;
          barcode: { symbology: Symbology; code: string } | null;
        }>(
          `select v.id, v.sku, p.name, ${VARIANT_TITLE_SQL('v')} as title, v.price::text as price,
             v.base_unit,
             (select json_build_object('symbology', b.symbology, 'code', b.code) from barcodes b
               where b.shop_id = v.shop_id and b.variant_id = v.id and b.pack_id is null
               order by b.position, b.id limit 1) as barcode
           from variants v join products p on p.shop_id = v.shop_id and p.id = v.product_id
           where v.id = any($1::uuid[])`,
          [variantIds],
        )
      ).map((v) => [v.id, v]),
    );
    if (variants.size !== variantIds.length) throw errors.notFound('Variant');
    const packIds = [...new Set(input.items.flatMap((i) => (i.packId ? [i.packId] : [])))];
    const packs = new Map(
      (
        await ctx.tx.query<{
          id: string;
          variant_id: string;
          name: string;
          base_quantity: string;
          price: string | null;
          barcode: { symbology: Symbology; code: string } | null;
        }>(
          `select k.id, k.variant_id, k.name, k.base_quantity::text as base_quantity,
             k.price::text as price,
             (select json_build_object('symbology', b.symbology, 'code', b.code) from barcodes b
               where b.shop_id = k.shop_id and b.pack_id = k.id
               order by b.position, b.id limit 1) as barcode
           from packs k where k.id = any($1::uuid[]) and k.status = 'active'`,
          [packIds],
        )
      ).map((p) => [p.id, p]),
    );
    const labels = input.items.map((item, i) => {
      const v = variants.get(item.variantId)!;
      const pack = item.packId ? packs.get(item.packId) : undefined;
      if (item.packId && (!pack || pack.variant_id !== item.variantId)) {
        throw errors.validation([
          { path: `items.${i}.packId`, message: 'Not an active pack of this variant.' },
        ]);
      }
      const price = pack
        ? (pack.price ?? (v.price === null ? null : multiply(v.price, pack.base_quantity, 6)))
        : v.price;
      return {
        kind: pack ? ('pack' as const) : ('variant' as const),
        variantId: v.id,
        packId: pack?.id ?? null,
        copies: item.copies,
        name: v.name,
        sku: v.sku,
        options: v.title,
        price: price === null ? null : normalize(price),
        pack: pack ? `${pack.name} · ${normalize(pack.base_quantity)} ${v.base_unit}` : null,
        // A pack label never falls back to the variant's barcode: scanning it would count one unit.
        barcode: pack ? pack.barcode : v.barcode,
      };
    });
    const missingBarcodes = labels.filter((l) => !l.barcode).length;
    return {
      result: { template, currency, total, missingBarcodes, labels },
      audit: {
        targetType: 'label',
        targetId: 'items',
        context: {
          template,
          total,
          missingBarcodes,
          records: input.items.slice(0, 100).map((i) => ({
            variantId: i.variantId,
            packId: i.packId ?? null,
            copies: i.copies,
          })),
        },
      },
    };
  },
});

// Location labels ----------------------------------------------------------------------------

export const renderLocationLabels = defineOperation({
  id: 'labels.locations.render',
  summary: 'Resolve location labels for printing',
  description:
    'Returns each location’s path, code, warehouse, and a QR code of its ID (LOC: followed by the ID), which stays valid when the location is renamed. The dashboard draws the PDF.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    locations: z
      .array(z.object({ locationId: Id, copies: Copies }))
      .min(1)
      .max(LABEL_LIMITS.entries),
    ...TemplateChoice,
  }),
  output: z.object({
    template: ResolvedTemplate,
    total: z.number(),
    labels: z.array(
      z.object({
        locationId: Id,
        copies: z.number(),
        path: z.string(),
        code: z.string().nullable(),
        warehouse: z.string(),
        barcode: Barcode,
      }),
    ),
  }),
  permission: 'storage.read',
  connectionScope: 'storage:read',
  audit: { action: 'labels.locations.rendered' },
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/labels/locations' },
  mcp: MCP_EXCEPTION,
  locations: (input) => input.locations.map((l) => l.locationId),
  async handler(ctx, input) {
    const total = totalCopies(input.locations);
    const template = await resolveTemplate(ctx, 'location', input);
    const rows = new Map(
      (
        await ctx.tx.query<{ id: string; path: string; code: string | null; warehouse: string }>(
          `select l.id, l.path, l.code, w.name as warehouse from locations l
           join warehouses w on w.shop_id = l.shop_id and w.id = l.warehouse_id
           where l.id = any($1::uuid[])`,
          [input.locations.map((l) => l.locationId)],
        )
      ).map((r) => [r.id, r]),
    );
    const labels = input.locations.map((l) => {
      const row = rows.get(l.locationId)!;
      return {
        locationId: row.id,
        copies: l.copies,
        path: row.path,
        code: row.code,
        warehouse: row.warehouse,
        barcode: { symbology: 'qr' as const, code: locationCode(row.id) },
      };
    });
    return {
      result: { template, total, labels },
      audit: {
        targetType: 'label',
        targetId: 'locations',
        locationIds: [...rows.keys()].slice(0, 100),
        context: { template, total },
      },
    };
  },
});

// Templates ----------------------------------------------------------------------------------

interface TemplateRow {
  id: string;
  name: string;
  kind: LabelKind;
  layout: TemplateView['layout'];
  fields: string[];
  status: 'active' | 'archived';
  version: number;
  updated_at: Date;
}

const templateView = (r: TemplateRow): TemplateView => ({
  id: r.id,
  key: null,
  name: r.name,
  kind: r.kind,
  layout: r.layout,
  fields: r.fields,
  status: r.status,
  version: r.version,
  updatedAt: iso(r.updated_at),
});

export const listLabelTemplates = defineOperation({
  id: 'labels.templates.list',
  summary: 'List label templates',
  description: 'The built-in templates and the shop’s own.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    includeArchived: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  }),
  output: z.object({ templates: z.array(TemplateOut) }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'labels.templates.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/labels/templates' },
  mcp: MCP_EXCEPTION,
  async handler(ctx, input) {
    const includeArchived = input.includeArchived === true || input.includeArchived === 'true';
    const rows = await ctx.tx.query<TemplateRow>(
      `select id, name, kind, layout, fields, status, version, updated_at from label_templates
       where ($1 or status = 'active') order by kind, lower(name)`,
      [includeArchived],
    );
    const builtins: TemplateView[] = BUILTIN_TEMPLATES.map((t) => ({
      id: null,
      key: t.key,
      name: t.name,
      kind: t.kind,
      layout: t.layout,
      fields: t.fields,
      status: 'active',
      version: 0,
      updatedAt: null,
    }));
    return {
      result: { templates: [...builtins, ...rows.map(templateView)] },
      audit: { targetType: 'label_template', targetId: 'list' },
    };
  },
});

export const saveLabelTemplate = defineOperation({
  id: 'labels.templates.save',
  summary: 'Save a label template',
  description:
    'Without templateId, creates a template; with templateId and expectedVersion, changes it. status "archived" removes it from the list.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    templateId: Id.optional(),
    expectedVersion: z.number().int().min(1).optional(),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(LABEL_KINDS),
    layout: z.enum(LABEL_LAYOUT_KEYS),
    fields: z.array(z.string().max(50)).min(1).max(10),
    status: z.enum(['active', 'archived']).default('active'),
  }),
  output: z.object({ template: TemplateOut }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'labels.template.saved' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/labels/templates' },
  mcp: {
    exception:
      'Label templates are print settings for the dashboard, where labels are drawn; an MCP client cannot print.',
  },
  async handler(ctx, input) {
    const allowed = fieldsFor(input.kind);
    const unknown = input.fields.filter((f) => !allowed.includes(f));
    if (unknown.length > 0) {
      throw errors.validation([
        { path: 'fields', message: `${input.kind} labels can show ${allowed.join(', ')}.` },
      ]);
    }
    const fields = [...new Set(input.fields)];
    let before: TemplateRow | undefined;
    if (input.templateId) {
      [before] = await ctx.tx.query<TemplateRow>(
        `select id, name, kind, layout, fields, status, version, updated_at from label_templates
         where id = $1 for update`,
        [input.templateId],
      );
      if (!before) throw errors.notFound('Label template');
      if (input.expectedVersion !== before.version) {
        throw errors.conflict(
          'version_conflict',
          'The template changed since you read it. Reload and retry.',
          { currentVersion: before.version },
        );
      }
    }
    if (input.status === 'active') {
      const [taken] = await ctx.tx.query<{ id: string }>(
        `select id from label_templates where lower(name) = lower($1) and status = 'active'
           and ($2::uuid is null or id <> $2)`,
        [input.name, input.templateId ?? null],
      );
      if (taken)
        throw errors.conflict('duplicate_template', 'A template with this name already exists.');
    }
    const id = before?.id ?? ctx.newId();
    const [row] = await ctx.tx.query<TemplateRow>(
      `insert into label_templates (shop_id, id, name, kind, layout, fields, status)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6)
       on conflict (shop_id, id) do update set name = excluded.name, kind = excluded.kind,
         layout = excluded.layout, fields = excluded.fields, status = excluded.status,
         version = label_templates.version + 1, updated_at = now()
       returning id, name, kind, layout, fields, status, version, updated_at`,
      [id, input.name, input.kind, input.layout, fields, input.status],
    );
    const after = {
      name: row!.name,
      kind: row!.kind,
      layout: row!.layout,
      fields,
      status: row!.status,
    };
    return {
      result: { template: templateView(row!) },
      audit: {
        targetType: 'label_template',
        targetId: id,
        changes: {
          from: before
            ? {
                name: before.name,
                kind: before.kind,
                layout: before.layout,
                fields: before.fields,
                status: before.status,
              }
            : null,
          to: after,
          version: row!.version,
        },
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const labelsOperations = [
  renderItemLabels,
  renderLocationLabels,
  listLabelTemplates,
  saveLabelTemplate,
] as const;
