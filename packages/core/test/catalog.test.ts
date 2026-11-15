import { ops, uuidv7 } from '@airstock/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  appDatabase,
  type Harness,
  harness,
  MemoryAuditSink,
  ownerQuery,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';
import { encodeValue, type FIELD_TYPES, type FieldDefinition } from '../src/catalog/fields.ts';
import { toCanonical } from '../src/catalog/units.ts';

// Phase 1, milestone N1: custom fields, families, options, inheritance, compare-and-set (A01, A02).

const db = appDatabase();
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Catalog shop');
  h = harness(db, sink, shop);
});
afterAll(() => db.close());

async function rejects(
  promise: Promise<unknown>,
): Promise<{ status: number; code: string; extra: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { status: number; code: string; extra: Record<string, unknown> };
    return { status: e.status, code: e.code, extra: e.extra };
  }
  throw new Error('Expected the call to fail.');
}

const field = async (input: Record<string, unknown>) => (await h.run(ops.createField, input)).field;

describe('A01: four kinds of product in one shop, each with its family and fields', () => {
  let schema: Awaited<ReturnType<typeof describe_>>;
  const describe_ = () => h.run(ops.describeCatalog, {});

  it('starts with the brand and category system fields', async () => {
    schema = await describe_();
    expect(schema.fields.map((f: { key: string }) => f.key)).toEqual(['brand', 'category']);
    expect(schema.fields.every((f: { isSystem: boolean }) => f.isSystem)).toBe(true);
    expect(schema.templates.map((t: { key: string }) => t.key)).toEqual([
      'apparel',
      'furniture',
      'food',
      'spare_parts',
    ]);
  });

  it('adds the four starter families; a shared key is reused and its options merged', async () => {
    const apparel = await h.run(ops.addTemplate, { template: 'apparel' });
    expect(apparel.createdFields).toContain('material');
    const furniture = await h.run(ops.addTemplate, { template: 'furniture' });
    expect(furniture.reusedFields).toEqual(['material']);
    await h.run(ops.addTemplate, { template: 'food' });
    await h.run(ops.addTemplate, { template: 'spare_parts' });
    schema = await describe_();
    expect(schema.families.map((f: { name: string }) => f.name)).toEqual([
      'Apparel',
      'Food',
      'Furniture',
      'Spare parts',
    ]);
    const material = schema.fields.find((f: { key: string }) => f.key === 'material');
    const labels = material.options.map((o: { label: string }) => o.label);
    expect(labels).toEqual(expect.arrayContaining(['Cotton', 'Oak', 'Walnut']));
    expect(schema.templates.every((t: { added: boolean }) => t.added)).toBe(true);
    expect((await rejects(h.run(ops.addTemplate, { template: 'food' }))).code).toBe(
      'template_added',
    );
  });

  it('stores a value of every field type and reads it back', async () => {
    const created = {
      notes: await field({ key: 'notes', label: 'Notes', type: 'text' }),
      launch: await field({ key: 'launch_date', label: 'Launch date', type: 'date' }),
      reviewed: await field({ key: 'reviewed_at', label: 'Reviewed at', type: 'timestamp' }),
      margin: await field({
        key: 'margin',
        label: 'Margin',
        type: 'decimal',
        config: { scale: 3 },
      }),
      rrp: await field({ key: 'rrp', label: 'RRP', type: 'money' }),
      seasons: await field({
        key: 'seasons',
        label: 'Seasons',
        type: 'multi_select',
        options: ['Spring', 'Summer', 'Autumn', 'Winter'],
      }),
      manual: await field({ key: 'manual', label: 'Manual', type: 'file' }),
    };
    expect(Object.values(created)).toHaveLength(7);
    const brand = schema.fields.find((f: { key: string }) => f.key === 'brand');
    await h.run(ops.updateFieldOptions, { fieldId: brand.id, add: ['Bibica', 'Nordwood'] });

    const shirt = await h.run(ops.createItem, {
      name: 'Linen shirt',
      sku: 'SHIRT-1',
      family: 'Apparel',
      price: '49.90',
      fields: {
        brand: 'bibica',
        material: 'Linen',
        care_instructions: '**Wash cold.** Hang to dry.',
        notes: 'Bestseller',
        launch_date: '2026-03-01',
        reviewed_at: '2026-11-15T09:30:00+02:00',
        margin: '0.425',
        rrp: { amount: '59.90', currency: 'EUR' },
        seasons: ['Summer', 'Spring'],
      },
    });
    const p = shirt.item.product.fields;
    expect(p.brand.display).toBe('Bibica');
    expect(p.material.display).toBe('Linen');
    expect(p.reviewed_at.value).toBe('2026-11-15T07:30:00.000Z');
    expect(p.rrp.value).toEqual({ amount: '59.9', currency: 'EUR' });
    expect(p.seasons.display).toBe('Spring, Summer');
    expect(p.notes.source).toBe('own');

    const table = await h.run(ops.createItem, {
      name: 'Oak table',
      sku: 'TABLE-1',
      family: 'Furniture',
      dimensions: '180 x 90 x 75 cm',
      weight: '42 kg',
      fields: { finish: 'Oiled', assembly_required: 'yes', assembled_width: '180 cm' },
    });
    expect(table.item.product.dimensions.canonical).toEqual({
      length: '1800',
      width: '900',
      height: '750',
    });
    expect(table.item.product.fields.assembly_required.value).toBe(true);
    expect(table.item.variants[0].weight).toMatchObject({
      source: 'inherited',
      value: { value: '42', unit: 'kg', canonical: '42000' },
    });

    const honey = await h.run(ops.createItem, {
      name: 'Acacia honey',
      sku: 'HONEY-500',
      family: 'Food',
      fields: {
        net_weight: '500 g',
        storage: 'Ambient',
        allergens: [],
        shelf_life_days: '730',
        ingredients: 'Acacia honey.',
      },
    });
    expect(honey.item.variants[0].fields.net_weight.value).toEqual({
      value: '500',
      unit: 'g',
      canonical: '500',
    });
    expect(honey.item.variants[0].fields.shelf_life_days).toMatchObject({
      value: 730,
      source: 'inherited',
    });

    const filter = await h.run(ops.createItem, {
      name: 'Oil filter',
      sku: 'FILT-100',
      family: 'Spare parts',
      fields: {
        condition: 'New',
        manufacturer_number: 'OF-100',
        compatible_with: [table.productId],
      },
    });
    const replacement = await h.run(ops.createItem, {
      name: 'Oil filter v2',
      sku: 'FILT-200',
      family: 'Spare parts',
      acknowledgeSimilar: true,
      fields: { condition: 'New', replaces: [filter.variantId] },
    });
    expect(replacement.item.variants[0].fields.replaces.value).toEqual([filter.variantId]);
    // Relationships are queryable both ways.
    const old = await h.run(ops.getItem, { sku: 'FILT-100' });
    expect(old.item.incoming).toEqual([
      expect.objectContaining({
        field: 'replaces',
        relationKind: 'replaces',
        sourceId: replacement.variantId,
      }),
    ]);
    const tableBack = await h.run(ops.getItem, { productId: table.productId });
    expect(tableBack.item.incoming[0]).toMatchObject({
      field: 'compatible_with',
      sourceId: filter.productId,
    });

    // File fields take values once media exists (N4).
    const file = await rejects(
      h.run(ops.createItem, { name: 'Manual item', sku: 'MAN-1', fields: { manual: [uuidv7()] } }),
    );
    expect(file.status).toBe(400);
  });

  it('rejects values that do not fit the field, on every path through one encoder', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ launch_date: '2026-02-30' }, 'fields.launch_date'],
      [{ margin: '1.2345' }, 'fields.margin'],
      [{ rrp: { amount: '5', currency: 'USD' } }, 'fields.rrp'],
      [{ material: 'Granite' }, 'fields.material'],
      [{ reviewed_at: '2026-11-15 09:30' }, 'fields.reviewed_at'],
      [{ shelf_life_days: '4000' }, 'fields.shelf_life_days'],
      [{ net_weight: '2 m' }, 'fields.net_weight'],
      [{ nonexistent: 'x' }, 'fields.nonexistent'],
    ];
    for (const [fields, path] of cases) {
      const res = await rejects(
        h.run(ops.createItem, { name: 'Bad', sku: `BAD-${uuidv7().slice(-6)}`, fields }),
      );
      expect(res.status, path).toBe(400);
      expect(JSON.stringify(res.extra.errors)).toContain(path);
    }
  });

  it('requires required family fields on active products only', async () => {
    const missing = await rejects(
      h.run(ops.createItem, {
        name: 'Jam',
        sku: 'JAM-1',
        family: 'Food',
        fields: { net_weight: '300 g' },
      }),
    );
    expect(missing).toMatchObject({
      status: 422,
      code: 'required_fields_missing',
      extra: { fields: ['storage'] },
    });
    const draft = await h.run(ops.createItem, {
      name: 'Jam',
      sku: 'JAM-1',
      family: 'Food',
      status: 'draft',
      fields: { net_weight: '300 g' },
    });
    const activate = await rejects(
      h.run(ops.updateItem, {
        productId: draft.productId,
        changes: [{ field: 'status', expected: 'draft', value: 'active' }],
      }),
    );
    expect(activate.code).toBe('required_fields_missing');
    const done = await h.run(ops.updateItem, {
      productId: draft.productId,
      changes: [
        { field: 'storage', expected: null, value: 'Chilled' },
        { field: 'status', expected: 'draft', value: 'active' },
      ],
    });
    expect(done.item.product.status).toBe('active');
  });
});

describe('A02: a simple product becomes a product with size and colour variants', () => {
  it('keeps the product and first variant’s IDs, SKU, stock, and history', async () => {
    const created = await h.run(ops.createItem, { name: 'T-shirt', sku: 'TS-1', price: '19.90' });
    await h.run(ops.receiveStock, {
      variantId: created.variantId,
      locationId: shop.locationId,
      quantity: '7',
    });
    const before = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from audit_events where target_id = $1`,
      [created.variantId],
    );

    const preview = await h.run(ops.generateVariants, {
      productId: created.productId,
      options: [
        { name: 'Color', values: ['Black', 'White'] },
        { name: 'Size', values: ['S', 'M', 'L', 'XL'] },
      ],
      skuPattern: 'TS-{color}-{size}',
      price: '19.90',
    });
    expect(preview.mode).toBe('preview');
    expect(preview.combinations).toHaveLength(8);
    expect(preview.combinations[0]).toMatchObject({
      state: 'kept',
      sku: 'TS-1',
      variantId: created.variantId,
    });
    expect(preview.combinations.map((c: { sku: string }) => c.sku)).toContain('TS-BLACK-M');
    expect(preview.combinations.every((c: { duplicate: boolean }) => !c.duplicate)).toBe(true);
    // Nothing exists yet.
    expect((await h.run(ops.getItem, { productId: created.productId })).item.variants).toHaveLength(
      1,
    );

    // A taken SKU shows as a duplicate in the preview and blocks the create.
    await h.run(ops.createItem, { name: 'Other', sku: 'TS-WHITE-XL' });
    const again = await h.run(ops.generateVariants, {
      productId: created.productId,
      options: [
        { name: 'Color', values: ['Black', 'White'] },
        { name: 'Size', values: ['S', 'M', 'L', 'XL'] },
      ],
      skuPattern: 'TS-{color}-{size}',
    });
    expect(again.combinations.find((c: { sku: string }) => c.sku === 'TS-WHITE-XL').duplicate).toBe(
      true,
    );
    expect(
      (
        await rejects(
          h.run(ops.generateVariants, {
            productId: created.productId,
            options: [
              { name: 'Color', values: ['Black', 'White'] },
              { name: 'Size', values: ['S', 'M', 'L', 'XL'] },
            ],
            skuPattern: 'TS-{color}-{size}',
            mode: 'create',
          }),
        )
      ).code,
    ).toBe('duplicate_sku');

    const done = await h.run(ops.generateVariants, {
      productId: created.productId,
      options: [
        { name: 'Color', values: ['Black', 'White'] },
        { name: 'Size', values: ['S', 'M', 'L'] },
      ],
      skuPattern: 'TS-{color}-{size}',
      price: '21.50',
      mode: 'create',
    });
    expect(done.created).toBe(5);
    const item = done.item;
    expect(item.product.id).toBe(created.productId);
    expect(item.variants).toHaveLength(6);
    const first = item.variants.find((v: { id: string }) => v.id === created.variantId);
    expect(first).toMatchObject({ sku: 'TS-1', price: '19.900000', title: 'Black / S' });
    expect(item.variants.filter((v: { price: string }) => v.price === '21.500000')).toHaveLength(5);
    expect(new Set(item.variants.map((v: { sku: string }) => v.sku)).size).toBe(6);

    const stock = await h.run(ops.getAvailability, { variantId: created.variantId });
    expect(Number(stock.totals.onHand)).toBe(7);
    const after = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from audit_events where target_id = $1`,
      [created.variantId],
    );
    expect(after[0]!.n).toBeGreaterThanOrEqual(before[0]!.n);

    // Renaming a value keeps its ID, so variants are untouched.
    const color = item.options.find((o: { name: string }) => o.name === 'Color');
    const black = color.values.find((v: { label: string }) => v.label === 'Black');
    const renamed = await h.run(ops.setProductOptions, {
      productId: created.productId,
      options: [
        { id: color.id, name: 'Colour', values: [{ id: black.id, label: 'Jet black' }, 'White'] },
        { name: 'Size', values: ['S', 'M', 'L'] },
      ],
    });
    expect(
      renamed.item.variants.find((v: { id: string }) => v.id === created.variantId).title,
    ).toBe('Jet black / S');
    expect(
      renamed.item.variants.find((v: { id: string }) => v.id === created.variantId).version,
    ).toBe(first.version);

    // A value in use cannot be removed; removing every option needs one active variant.
    expect(
      (
        await rejects(
          h.run(ops.setProductOptions, {
            productId: created.productId,
            options: [
              { name: 'Colour', values: ['White'] },
              { name: 'Size', values: ['S', 'M', 'L'] },
            ],
          }),
        )
      ).code,
    ).toBe('option_value_in_use');
    expect(
      (await rejects(h.run(ops.setProductOptions, { productId: created.productId, options: [] })))
        .code,
    ).toBe('combination_taken');
  });
});

describe('field-level compare-and-set (D3, Q4)', () => {
  it('lets edits to different fields both succeed and the same field conflict once', async () => {
    const created = await h.run(ops.createItem, { name: 'Lamp', sku: 'LAMP-CAS', price: '10' });
    const editor = await addMember(shop.shopId, 'catalog_editor');
    const [a, b] = await Promise.allSettled([
      h.run(ops.updateItem, {
        productId: created.productId,
        changes: [{ variantId: created.variantId, field: 'price', expected: '10', value: '12' }],
      }),
      h.run(
        ops.updateItem,
        {
          productId: created.productId,
          changes: [
            { variantId: created.variantId, field: 'price', expected: '10.00', value: '13' },
          ],
        },
        { caller: editor.caller },
      ),
    ]);
    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    const failure = (a.status === 'rejected' ? a.reason : (b as PromiseRejectedResult).reason) as {
      code: string;
      extra: {
        conflicts: Array<{ field: string; current: string; changedBy: { actorType: string } }>;
      };
    };
    expect(failure.code).toBe('edit_conflict');
    expect(failure.extra.conflicts[0]).toMatchObject({
      field: 'price',
      changedBy: { actorType: 'user' },
    });

    const [c, d] = await Promise.all([
      h.run(ops.updateItem, {
        productId: created.productId,
        changes: [{ field: 'name', expected: 'Lamp', value: 'Desk lamp' }],
      }),
      h.run(
        ops.updateItem,
        {
          productId: created.productId,
          changes: [{ field: 'tags', expected: [], value: ['lighting'] }],
        },
        { caller: editor.caller },
      ),
    ]);
    expect(c.records[0].version + d.records[0].version).toBeGreaterThan(2);
    const item = (await h.run(ops.getItem, { productId: created.productId })).item;
    expect(item.product).toMatchObject({ name: 'Desk lamp', tags: ['lighting'] });
  });

  it('inherits, overrides, clears, and inherits again on a variant', async () => {
    const color = await field({
      key: 'colour_family',
      label: 'Colour family',
      type: 'text',
      level: 'both',
    });
    const created = await h.run(ops.createItem, {
      name: 'Mug',
      sku: 'MUG-1',
      weight: '350 g',
      fields: { colour_family: 'Blue' },
    });
    const v = created.variantId;
    const read = async () => (await h.run(ops.getItem, { variantId: v })).item.variants[0];
    expect((await read()).fields.colour_family).toMatchObject({
      value: 'Blue',
      source: 'inherited',
    });
    await h.run(ops.updateItem, {
      productId: created.productId,
      changes: [
        { variantId: v, field: 'colour_family', expected: 'Blue', value: 'Navy' },
        { variantId: v, field: 'weight', expected: { value: '350', unit: 'g' }, value: null },
      ],
    });
    let variant = await read();
    expect(variant.fields.colour_family).toMatchObject({ value: 'Navy', source: 'own' });
    expect(variant.weight).toMatchObject({ value: null, source: 'cleared' });
    await h.run(ops.updateItem, {
      productId: created.productId,
      changes: [
        { variantId: v, field: 'colour_family', expected: 'Navy', inherit: true },
        { variantId: v, field: 'weight', expected: null, inherit: true },
      ],
    });
    variant = await read();
    expect(variant.fields.colour_family).toMatchObject({ value: 'Blue', source: 'inherited' });
    expect(variant.weight).toMatchObject({ source: 'inherited', value: { value: '350' } });
    expect(color.level).toBe('both');
  });
});

describe('schema rules', () => {
  it('converts integer to decimal with a preview first', async () => {
    const qty = await field({ key: 'pack_count', label: 'Pack count', type: 'integer' });
    await h.run(ops.createItem, { name: 'Socks', sku: 'SOCK-1', fields: { pack_count: 3 } });
    const preview = await h.run(ops.convertField, { fieldId: qty.id, toType: 'decimal' });
    expect(preview).toMatchObject({
      preview: true,
      affected: { products: 1, variants: 0 },
      field: null,
    });
    expect((await h.run(ops.getItem, { sku: 'SOCK-1' })).item.product.fields.pack_count.value).toBe(
      3,
    );
    const done = await h.run(ops.convertField, {
      fieldId: qty.id,
      toType: 'decimal',
      preview: false,
    });
    expect(done.field.type).toBe('decimal');
    expect((await h.run(ops.getItem, { sku: 'SOCK-1' })).item.product.fields.pack_count.value).toBe(
      '3',
    );
    expect(
      (
        await rejects(
          h.run(ops.convertField, { fieldId: qty.id, toType: 'boolean', preview: false }),
        )
      ).code,
    ).toBe('unsafe_conversion');
  });

  it('keeps an archived option on records but offers it for no new choice', async () => {
    const tone = await field({
      key: 'tone',
      label: 'Tone',
      type: 'single_select',
      options: ['Warm', 'Cold'],
    });
    const warm = tone.options[0].id;
    const item = await h.run(ops.createItem, {
      name: 'Bulb',
      sku: 'BULB-1',
      fields: { tone: 'Warm' },
    });
    await h.run(ops.updateFieldOptions, { fieldId: tone.id, archive: [warm] });
    // The record keeps it, and an edit of another field leaves it alone.
    expect((await h.run(ops.getItem, { sku: 'BULB-1' })).item.product.fields.tone.value).toBe(warm);
    const fresh = await rejects(
      h.run(ops.createItem, {
        name: 'Bulb 2',
        sku: 'BULB-2',
        fields: { tone: 'Warm' },
        acknowledgeSimilar: true,
      }),
    );
    expect(fresh.status).toBe(400);
    await h.run(ops.updateItem, {
      productId: item.productId,
      changes: [{ field: 'tone', expected: warm, value: 'Cold' }],
    });
  });

  it('hides restricted fields from members who do not manage the schema', async () => {
    await field({
      key: 'buy_price_note',
      label: 'Buying note',
      type: 'text',
      visibility: 'restricted',
    });
    const viewer = await addMember(shop.shopId, 'catalog_editor');
    const own = await h.run(ops.describeCatalog, {});
    const theirs = await h.run(ops.describeCatalog, {}, { caller: viewer.caller });
    expect(own.fields.some((f: { key: string }) => f.key === 'buy_price_note')).toBe(true);
    expect(theirs.fields.some((f: { key: string }) => f.key === 'buy_price_note')).toBe(false);
    const denied = await rejects(
      h.run(
        ops.createField,
        { key: 'x_field', label: 'X', type: 'text' },
        { caller: viewer.caller },
      ),
    );
    expect(denied.status).toBe(403);
  });

  it('refuses reserved keys and enforces the field limit', async () => {
    expect((await rejects(field({ key: 'sku', label: 'SKU 2', type: 'text' }))).code).toBe(
      'reserved_key',
    );
    expect((await rejects(field({ key: 'notes', label: 'Notes', type: 'text' }))).code).toBe(
      'duplicate_key',
    );
  });

  it('keeps another shop’s fields, families, and records out of reach (A13)', async () => {
    const other = await seedShop(db, sink, 'Other catalog shop');
    const o = harness(db, sink, other);
    const theirField = await o.run(ops.createField, {
      key: 'secret',
      label: 'Secret',
      type: 'text',
    });
    const theirItem = await o.run(ops.createItem, { name: 'Theirs', sku: 'THEIRS-1' });
    expect(
      (await rejects(h.run(ops.updateField, { fieldId: theirField.field.id, label: 'Mine' })))
        .status,
    ).toBe(404);
    expect(
      (
        await rejects(
          h.run(ops.updateItem, {
            productId: theirItem.productId,
            changes: [{ field: 'name', expected: 'Theirs', value: 'x' }],
          }),
        )
      ).status,
    ).toBe(404);
    expect((await rejects(h.run(ops.getItem, { productId: theirItem.productId }))).status).toBe(
      404,
    );
    const rel = await rejects(
      h.run(ops.createItem, {
        name: 'Linker',
        sku: 'LINK-1',
        family: 'Spare parts',
        fields: { condition: 'New', compatible_with: [theirItem.productId] },
      }),
    );
    expect(rel.status).toBe(404);
    const rows = await ownerQuery(
      'select 1 from field_definitions where shop_id = $1 and key = $2',
      [shop.shopId, 'secret'],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('field encoding (property)', () => {
  const def = (
    type: (typeof FIELD_TYPES)[number],
    extra: Partial<FieldDefinition> = {},
  ): FieldDefinition => ({
    id: 'f',
    key: 'f',
    label: 'F',
    type,
    level: 'product',
    config:
      type === 'measurement' ? { unitKind: 'weight' } : type === 'decimal' ? { scale: 4 } : {},
    defaultValue: null,
    visibility: 'everyone',
    status: 'active',
    isSystem: false,
    version: 1,
    options: [
      { id: '01900000-0000-7000-8000-000000000001', label: 'One', position: 0, archived: false },
      { id: '01900000-0000-7000-8000-000000000002', label: 'Two', position: 1, archived: false },
    ],
    ...extra,
  });
  const ctx = { currency: 'EUR' };
  const arbitraries: Record<string, fc.Arbitrary<unknown>> = {
    text: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim() !== ''),
    rich_text: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim() !== ''),
    integer: fc.integer(),
    decimal: fc
      .tuple(fc.integer({ min: -1e9, max: 1e9 }), fc.integer({ min: 0, max: 9999 }))
      .map(([a, b]) => `${a}.${String(b).padStart(4, '0')}`),
    boolean: fc.boolean(),
    date: fc
      .date({ min: new Date('1900-01-01'), max: new Date('2200-01-01'), noInvalidDate: true })
      .map((d) => d.toISOString().slice(0, 10)),
    timestamp: fc
      .date({ min: new Date('1970-01-01'), max: new Date('2200-01-01'), noInvalidDate: true })
      .map((d) => d.toISOString()),
    single_select: fc.constantFrom('One', 'two', '01900000-0000-7000-8000-000000000001'),
    multi_select: fc.subarray(['One', 'Two'], { minLength: 1 }),
    money: fc
      .integer({ min: 0, max: 1e7 })
      .map((n) => ({ amount: (n / 100).toFixed(2), currency: 'EUR' })),
    measurement: fc
      .tuple(fc.integer({ min: 0, max: 1e6 }), fc.constantFrom('g', 'kg', 'oz', 'lb'))
      .map(([n, unit]) => `${n / 10} ${unit}`),
    relationship: fc.uniqueArray(fc.uuid({ version: 7 }), { minLength: 1, maxLength: 5 }),
  };

  it('every type round-trips: the stored form encodes to itself', () => {
    for (const [type, arb] of Object.entries(arbitraries)) {
      fc.assert(
        fc.property(arb, (input) => {
          const d = def(type as (typeof FIELD_TYPES)[number]);
          const first = encodeValue(d, input, ctx);
          expect(first.ok, `${type} ${JSON.stringify(input)}`).toBe(true);
          if (!first.ok) return;
          const second = encodeValue(d, first.value, ctx);
          expect(second).toEqual(first);
        }),
        { numRuns: 100 },
      );
    }
  });

  it('converts units exactly', () => {
    expect(toCanonical('1', 'lb')).toBe('453.59237');
    expect(toCanonical('2.5', 'kg')).toBe('2500');
    expect(toCanonical('212', '°F')).toBe('100');
    expect(toCanonical('1', 'fl oz')).toBe('29.57353');
  });
});
