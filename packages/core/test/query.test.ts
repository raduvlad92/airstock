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
import { compare } from '../src/catalog/decimal.ts';

// N2 done-when: random filters and sorts give the same rows, in the same order, as an in-memory
// reference implementation; and A43 (duplicates) through the API.

const db = appDatabase();
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;

type Attr = Record<string, unknown>;
interface P {
  id: string;
  name: string;
  status: string;
  attributes: Attr;
}
interface V {
  id: string;
  productId: string;
  sku: string;
  price: string | null;
  status: string;
  attributes: Attr;
}
interface F {
  id: string;
  key: string;
  type: string;
  level: 'product' | 'variant' | 'both';
  options: Array<{ id: string; label: string; position: number }>;
}

const fields: Record<string, F> = {};
const products: P[] = [];
const variants: V[] = [];

const letters = fc.stringMatching(/^[a-e]{1,4}$/);

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Query shop');
  h = harness(db, sink, shop);
  const make = async (
    key: string,
    type: string,
    level: string,
    extra: Record<string, unknown> = {},
  ) => {
    const { field } = await h.run(ops.createField, { key, label: key, type, level, ...extra });
    fields[key] = field;
  };
  await make('t', 'text', 'both');
  await make('n', 'decimal', 'variant', { config: { scale: 2 } });
  await make('i', 'integer', 'product');
  await make('b', 'boolean', 'product');
  await make('d', 'date', 'both');
  await make('s', 'single_select', 'both', { options: ['A', 'B', 'C'] });
  await make('m', 'multi_select', 'product', { options: ['X', 'Y', 'Z'] });
  await make('w', 'measurement', 'variant', { config: { unitKind: 'weight' } });

  // A random catalog with every inheritance state: absent (inherit), JSON null (cleared), value.
  const state = <T>(arb: fc.Arbitrary<T>) =>
    fc.oneof(
      { weight: 1, arbitrary: fc.constant(undefined) },
      { weight: 1, arbitrary: fc.constant(null) },
      { weight: 3, arbitrary: arb },
    );
  const s = fields.s!.options.map((o) => o.id);
  const m = fields.m!.options.map((o) => o.id);
  const value = {
    t: letters,
    n: fc
      .tuple(fc.integer({ min: -50, max: 50 }), fc.integer({ min: 0, max: 99 }))
      .map(([a, b]) =>
        `${a}.${String(b).padStart(2, '0')}`.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1'),
      ),
    i: fc.integer({ min: -20, max: 20 }),
    b: fc.boolean(),
    d: fc.integer({ min: 1, max: 28 }).map((day) => `2026-01-${String(day).padStart(2, '0')}`),
    s: fc.constantFrom(...s),
    m: fc.subarray(m, { minLength: 1 }),
    w: fc
      .integer({ min: 0, max: 2000 })
      .map((g) =>
        g % 2
          ? { value: String(g), unit: 'g', canonical: String(g) }
          : { value: String(g / 1000), unit: 'kg', canonical: String(g) },
      ),
  };
  const productArb = fc.record({
    name: letters,
    archived: fc.boolean().map((x) => x && Math.random() < 0.3),
    t: state(value.t),
    i: state(value.i),
    b: state(value.b),
    d: state(value.d),
    s: state(value.s),
    m: state(value.m),
    variants: fc.array(
      fc.record({
        price: fc.option(
          fc.integer({ min: 0, max: 10000 }).map((c) => (c / 100).toString()),
          { nil: null },
        ),
        archived: fc.boolean().map((x) => x && Math.random() < 0.2),
        t: state(value.t),
        n: state(value.n),
        d: state(value.d),
        s: state(value.s),
        w: state(value.w),
      }),
      { minLength: 1, maxLength: 3 },
    ),
  });
  const sample = fc.sample(productArb, { numRuns: 45, seed: 20261115 });
  const put = (attrs: Attr, key: string, v: unknown) => {
    if (v !== undefined) attrs[fields[key]!.id] = v;
  };
  for (const [pi, p] of sample.entries()) {
    const product: P = {
      id: uuidv7(),
      name: p.name,
      status: p.archived ? 'archived' : 'active',
      attributes: {},
    };
    // Products carry values only (no explicit null): null on a product means no key.
    for (const k of ['t', 'i', 'b', 'd', 's', 'm'] as const)
      if (p[k] !== null) put(product.attributes, k, p[k]);
    products.push(product);
    for (const [vi, v] of p.variants.entries()) {
      const variant: V = {
        id: uuidv7(),
        productId: product.id,
        sku: `Q-${pi}-${vi}`,
        price: v.price,
        status: v.archived ? 'archived' : 'active',
        attributes: {},
      };
      for (const k of ['t', 'n', 'd', 's', 'w'] as const) put(variant.attributes, k, v[k]);
      // Variant-level fields have no inheritance: JSON null means empty, like no key.
      variants.push(variant);
    }
  }
  for (const p of products) {
    await ownerQuery(
      `insert into products (shop_id, id, name, status, attributes) values ($1, $2, $3, $4, $5)`,
      [shop.shopId, p.id, p.name, p.status, JSON.stringify(p.attributes)],
    );
  }
  for (const v of variants) {
    await ownerQuery(
      `insert into variants (shop_id, id, product_id, sku, sku_normalized, price, status, attributes, option_value_ids)
       values ($1, $2, $3, $4, $4, $5, $6, $7, array[$2]::uuid[])`,
      [shop.shopId, v.id, v.productId, v.sku, v.price, v.status, JSON.stringify(v.attributes)],
    );
  }
});
afterAll(() => db.close());

// The reference implementation ------------------------------------------------------------

type Cond = { field: string; op: string; value?: unknown };
type Item = Cond | { any: Cond[] };

function value(field: string, p: P, v: V | null): unknown {
  if (field === 'name') return p.name;
  if (field === 'price') return v?.price ?? null;
  if (field === 'sku') return v?.sku ?? null;
  const f = fields[field]!;
  const pv = p.attributes[f.id] ?? null;
  if (f.level === 'product' || !v) return pv;
  if (f.level === 'variant') return v.attributes[f.id] ?? null;
  return f.id in v.attributes ? v.attributes[f.id] : pv;
}

const levelOf = (field: string) =>
  field === 'price' || field === 'sku'
    ? 'variant'
    : field === 'name'
      ? 'product'
      : fields[field]!.level === 'variant'
        ? 'variant'
        : 'product';

function scalar(field: string, raw: unknown): string | number | boolean | null {
  if (raw === null || raw === undefined) return null;
  if (field === 'w') return (raw as { canonical: string }).canonical;
  return raw as string | number | boolean;
}

function test(c: Cond, p: P, v: V | null): boolean {
  const raw = value(c.field, p, v);
  const x = scalar(c.field, raw);
  const num = (a: unknown) => String(a);
  switch (c.op) {
    case 'is_empty':
      return Array.isArray(raw) ? raw.length === 0 : x === null || x === '';
    case 'is_not_empty':
      return !test({ ...c, op: 'is_empty' }, p, v);
    case 'contains':
      return x !== null && String(x).includes(String(c.value));
    case 'starts_with':
      return x !== null && String(x).startsWith(String(c.value));
    case 'equals':
      return x !== null && String(x) === String(c.value);
    case 'eq':
      return x !== null && compare(num(x), num(c.value)) === 0;
    case 'neq':
      return x === null || compare(num(x), num(c.value)) !== 0;
    case 'lt':
      return x !== null && compare(num(x), num(c.value)) < 0;
    case 'gte':
      return x !== null && compare(num(x), num(c.value)) >= 0;
    case 'between': {
      const [a, b] = c.value as [unknown, unknown];
      if (x === null) return false;
      if (c.field === 'd') return String(x) >= String(a) && String(x) <= String(b);
      return compare(num(x), num(a)) >= 0 && compare(num(x), num(b)) <= 0;
    }
    case 'before':
      return x !== null && String(x) < String(c.value);
    case 'after':
      return x !== null && String(x) > String(c.value);
    case 'is':
      return x === c.value;
    case 'is_any_of':
      return x !== null && (c.value as string[]).includes(String(x));
    case 'is_none_of':
      return x === null || !(c.value as string[]).includes(String(x));
    case 'has_any':
      return Array.isArray(raw) && raw.some((o) => (c.value as string[]).includes(o));
    case 'has_all':
      return Array.isArray(raw) && (c.value as string[]).every((o) => raw.includes(o));
    case 'has_none':
      return !(Array.isArray(raw) && raw.some((o) => (c.value as string[]).includes(o)));
  }
  throw new Error(`op ${c.op}`);
}

function matches(item: Item, p: P, v: V | null, mode: 'variants' | 'products'): boolean {
  const one = (c: Cond) =>
    mode === 'products' && levelOf(c.field) === 'variant'
      ? variants.some((x) => x.productId === p.id && x.status === 'active' && test(c, p, x))
      : test(c, p, v);
  return 'any' in item ? item.any.some(one) : one(item);
}

function sortValue(
  field: string,
  p: P,
  v: V | null,
  mode: 'variants' | 'products',
): string | number | null {
  if (field === 'name') return p.name.toLowerCase();
  const pick = (vv: V | null) => {
    const raw = scalar(field, value(field, p, vv));
    if (raw === null) return null;
    if (field === 's') return fields.s!.options.find((o) => o.id === raw)!.position;
    if (typeof raw === 'string' && field !== 't' && field !== 'd') return raw;
    return raw as string | number;
  };
  if (mode === 'products' && levelOf(field) === 'variant') {
    const values = variants
      .filter((x) => x.productId === p.id && x.status === 'active')
      .map(pick)
      .filter((x): x is string | number => x !== null);
    if (values.length === 0) return null;
    return values.reduce((a, b) => (cmpValues(field, a, b) <= 0 ? a : b));
  }
  return pick(v);
}

function cmpValues(field: string, a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (['n', 'w', 'price', 'i'].includes(field)) return compare(String(a), String(b));
  return a < b ? -1 : a > b ? 1 : 0;
}

function reference(q: {
  mode: 'variants' | 'products';
  filter: Item[];
  sort: { field: string; direction: 'asc' | 'desc' };
}) {
  const rows =
    q.mode === 'variants'
      ? variants
          .filter((v) => v.status === 'active')
          .map((v) => ({ p: products.find((p) => p.id === v.productId)!, v }))
          .filter(({ p }) => p.status !== 'archived')
      : products.filter((p) => p.status !== 'archived').map((p) => ({ p, v: null as V | null }));
  const kept = rows.filter(({ p, v }) => q.filter.every((item) => matches(item, p, v, q.mode)));
  const id = (r: { p: P; v: V | null }) => (q.mode === 'variants' ? r.v!.id : r.p.id);
  return kept
    .map((r) => ({ r, s: sortValue(q.sort.field, r.p, r.v, q.mode) }))
    .sort((a, b) => {
      if (a.s === null && b.s !== null) return 1;
      if (b.s === null && a.s !== null) return -1;
      if (a.s !== null && b.s !== null) {
        const c = cmpValues(q.sort.field, a.s, b.s) * (q.sort.direction === 'asc' ? 1 : -1);
        if (c !== 0) return c;
      }
      return id(a.r) < id(b.r) ? -1 : 1;
    })
    .map(({ r }) => id(r));
}

// Random queries ---------------------------------------------------------------------------

const condition: fc.Arbitrary<Cond> = fc.oneof(
  fc.record({
    field: fc.constantFrom('t', 'name'),
    op: fc.constantFrom('contains', 'starts_with', 'equals', 'is_empty', 'is_not_empty'),
    value: letters.map((s) => s.slice(0, 2)),
  }),
  fc.record({
    field: fc.constantFrom('n', 'price', 'i'),
    op: fc.constantFrom('eq', 'neq', 'lt', 'gte', 'is_empty'),
    value: fc.integer({ min: -30, max: 60 }).map(String),
  }),
  fc.record({
    field: fc.constant('n'),
    op: fc.constant('between'),
    value: fc
      .tuple(fc.integer({ min: -50, max: 0 }), fc.integer({ min: 0, max: 50 }))
      .map(([a, b]) => [String(a), String(b)]),
  }),
  fc.record({
    field: fc.constant('w'),
    op: fc.constantFrom('lt', 'gte'),
    value: fc.integer({ min: 0, max: 2000 }).map((g) => `${g} g`),
  }),
  fc.record({
    field: fc.constant('d'),
    op: fc.constantFrom('before', 'after', 'is_empty'),
    value: fc.integer({ min: 1, max: 28 }).map((d) => `2026-01-${String(d).padStart(2, '0')}`),
  }),
  fc.record({ field: fc.constant('b'), op: fc.constant('is'), value: fc.boolean() }),
  fc.record({
    field: fc.constant('s'),
    op: fc.constantFrom('is_any_of', 'is_none_of'),
    value: fc.subarray(['A', 'B', 'C'], { minLength: 1 }),
  }),
  fc.record({
    field: fc.constant('m'),
    op: fc.constantFrom('has_any', 'has_all', 'has_none'),
    value: fc.subarray(['X', 'Y', 'Z'], { minLength: 1 }),
  }),
);

const labelToId = (c: Cond): Cond => {
  if (c.field === 's' || c.field === 'm') {
    const f = fields[c.field]!;
    return {
      ...c,
      value: (c.value as string[]).map((l) => f.options.find((o) => o.label === l)!.id),
    };
  }
  if (c.field === 'w') return { ...c, value: String(c.value).replace(' g', '') };
  return c;
};

describe('catalog query (D2): filters and sorts against a reference implementation', () => {
  it('agrees on random queries, across every page', async () => {
    const stats = { runs: 0, nonEmpty: 0, multiPage: 0 };
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'variants' | 'products'>('variants', 'products'),
        fc.array(
          fc.oneof(
            { weight: 4, arbitrary: condition },
            {
              weight: 1,
              arbitrary: fc
                .array(condition, { minLength: 1, maxLength: 2 })
                .map((any) => ({ any })),
            },
          ),
          { maxLength: 3 },
        ),
        fc.record({
          field: fc.constantFrom('name', 'price', 't', 'n', 'd', 's', 'i', 'w'),
          direction: fc.constantFrom<'asc' | 'desc'>('asc', 'desc'),
        }),
        fc.integer({ min: 1, max: 9 }),
        async (mode, filter, sort, limit) => {
          const expected = reference({
            mode,
            filter: filter.map((item) =>
              'any' in item ? { any: item.any.map(labelToId) } : labelToId(item),
            ),
            sort,
          });
          const got: string[] = [];
          let cursor: string | undefined;
          let total: number | null = null;
          for (let page = 0; page < 100; page++) {
            const res = await h.run(ops.queryItems, {
              mode,
              filter,
              sort,
              limit,
              ...(cursor ? { cursor } : {}),
            });
            if (page === 0) total = res.total;
            got.push(
              ...res.rows.map((r: { variantId: string | null; productId: string }) =>
                mode === 'variants' ? r.variantId : r.productId,
              ),
            );
            cursor = res.nextCursor ?? undefined;
            if (!cursor) break;
          }
          expect(got).toEqual(expected);
          expect(total).toBe(expected.length);
          stats.runs++;
          if (expected.length > 0) stats.nonEmpty++;
          if (expected.length > limit) stats.multiPage++;
        },
      ),
      { numRuns: 120, seed: 1115 },
    );
    // The random queries must exercise real results and paging, not only empty pages.
    expect(stats.nonEmpty / stats.runs).toBeGreaterThan(0.5);
    expect(stats.multiPage / stats.runs).toBeGreaterThan(0.3);
  });
});

describe('catalog query behaviour', () => {
  it('searches SKUs exactly, words in names, and names with typos', async () => {
    const item = await h.run(ops.createItem, {
      name: 'Walnut sideboard',
      sku: 'SB-WAL-01',
      description: 'Solid walnut, three drawers.',
    });
    const by = async (search: string) =>
      (await h.run(ops.queryItems, { search, mode: 'variants' })).rows.map(
        (r: { productId: string }) => r.productId,
      );
    expect(await by('sb-wal-01')).toContain(item.productId);
    expect(await by('drawers')).toContain(item.productId);
    expect(await by('walnt sideboard')).toContain(item.productId);
    expect(await by('zzzz qqqq')).not.toContain(item.productId);
  });

  it('records each query with its filters (A10), and refuses unknown fields and restricted ones', async () => {
    const before = sink.events.length;
    await h.run(ops.queryItems, {
      filter: [{ field: 'price', op: 'gte', value: '10' }],
      sort: { field: 'price', direction: 'desc' },
    });
    const event = sink.events.slice(before).find((e) => e.action === 'catalog.items.queried')!;
    expect(event.context).toMatchObject({
      filter: [{ field: 'price', op: 'gte', value: '10' }],
      sort: { field: 'price', direction: 'desc' },
    });
    await expect(
      h.run(ops.queryItems, { filter: [{ field: 'nope', op: 'eq', value: 1 }] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      h.run(ops.queryItems, { filter: [{ field: 'b', op: 'contains', value: 'x' }] }),
    ).rejects.toMatchObject({ status: 400 });
    await h.run(ops.createField, {
      key: 'secret_cost',
      label: 'Secret',
      type: 'decimal',
      visibility: 'restricted',
    });
    const editor = await addMember(shop.shopId, 'catalog_editor');
    await expect(
      h.run(
        ops.queryItems,
        { filter: [{ field: 'secret_cost', op: 'gt', value: '1' }] },
        { caller: editor.caller },
      ),
    ).rejects.toMatchObject({ status: 400 });
    // A cursor from another query is refused rather than misread.
    const first = await h.run(ops.queryItems, { limit: 1 });
    await expect(
      h.run(ops.queryItems, {
        limit: 1,
        sort: { field: 'price', direction: 'asc' },
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('filters families by name as well as by ID, and refuses a name no family has (F13)', async () => {
    const family = await h.run(ops.createFamily, { name: 'Garden furniture' });
    const bench = await h.run(ops.createItem, {
      name: 'Teak bench',
      sku: 'FAM-BENCH-1',
      family: 'Garden furniture',
    });
    const ids = async (filter: unknown[]) =>
      (await h.run(ops.queryItems, { mode: 'products', filter, limit: 200 })).rows.map(
        (r: { productId: string }) => r.productId,
      );
    const byName = await ids([{ field: 'family', op: 'is_any_of', value: ['garden FURNITURE'] }]);
    expect(byName).toEqual([bench.productId]);
    expect(await ids([{ field: 'family', op: 'is_any_of', value: [family.family.id] }])).toEqual(
      byName,
    );
    expect(
      await ids([{ any: [{ field: 'family', op: 'is_any_of', value: 'Garden furniture' }] }]),
    ).toEqual(byName);
    expect(
      await ids([{ field: 'family', op: 'is_none_of', value: ['Garden furniture'] }]),
    ).not.toContain(bench.productId);
    // ChatGPT once passed a name that matched nothing and got an empty page with no error.
    await expect(
      h.run(ops.queryItems, {
        filter: [
          { field: 'price', op: 'gte', value: '0' },
          { field: 'family', op: 'is_any_of', value: ['Furniture'] },
        ],
      }),
    ).rejects.toMatchObject({
      status: 400,
      extra: {
        errors: [
          {
            path: 'filter.1.value',
            message: expect.stringContaining('"Garden furniture"'),
          },
        ],
      },
    });
  });

  it('returns selected values with their inheritance state and summarises variants in products mode', async () => {
    const res = await h.run(ops.queryItems, {
      mode: 'variants',
      fields: ['t', 'w', 'available'],
      limit: 200,
    });
    const states = new Set(
      res.rows.map((r: { values: { t: { source: string } } }) => r.values.t.source),
    );
    expect(states).toEqual(new Set(['own', 'inherited', 'cleared', 'none']));
    const products = await h.run(ops.queryItems, { mode: 'products', fields: ['n'], limit: 5 });
    expect(products.rows[0]).toMatchObject({ variantId: null, variantCount: expect.any(Number) });
  });
});

describe('A43: duplicate SKUs are blocked and similar names flagged', () => {
  it('blocks a taken SKU and asks for acknowledgment of a similar name', async () => {
    await h.run(ops.createItem, { name: 'Ceramic coffee mug', sku: 'MUG-CER-1' });
    await expect(
      h.run(ops.createItem, { name: 'Anything', sku: ' mug-cer-1 ' }),
    ).rejects.toMatchObject({ code: 'duplicate_sku' });
    const similar = await h
      .run(ops.createItem, { name: 'Ceramic Coffee Mugs', sku: 'MUG-CER-2' })
      .catch((e: { code: string; extra: { similarNames: Array<{ name: string }> } }) => e);
    expect(similar).toMatchObject({
      code: 'similar_items_found',
      extra: { similarNames: [{ name: 'Ceramic coffee mug' }] },
    });
    const created = await h.run(ops.createItem, {
      name: 'Ceramic Coffee Mugs',
      sku: 'MUG-CER-2',
      acknowledgeSimilar: true,
    });
    expect(created.productId).toBeTruthy();
    // The warning shown and the choice made are both in the history.
    const warned = sink.events.find(
      (e) =>
        e.action === 'catalog.item.created' &&
        (e.error as { code?: string })?.code === 'similar_items_found',
    );
    expect(warned?.context).toMatchObject({
      problem: { similarNames: [expect.objectContaining({ name: 'Ceramic coffee mug' })] },
    });
    const [chosen] = await ownerQuery<{ changes: { acknowledgedSimilar: string[] } }>(
      `select changes from audit_events where target_id = $1 and action = 'catalog.item.created'`,
      [created.variantId],
    );
    expect(chosen!.changes.acknowledgedSimilar).toHaveLength(1);
    const check = await h.run(ops.checkDuplicates, {
      name: 'ceramic coffee mug',
      sku: 'MUG-CER-2',
    });
    expect(check.skuTaken.sku).toBe('MUG-CER-2');
    expect(check.similarNames.map((s: { name: string }) => s.name)).toEqual(
      expect.arrayContaining(['Ceramic coffee mug']),
    );
  });
});

describe('saved views', () => {
  it('keeps private views private and lets only catalog writers share or change shared ones', async () => {
    const viewer = await addMember(shop.shopId, 'viewer');
    const definition = {
      mode: 'variants',
      columns: [{ key: 'sku', width: 120 }],
      sort: { field: 'price', direction: 'asc' },
    };
    const mine = await h.run(ops.saveView, { name: 'Cheap first', definition });
    const theirs = await h.run(
      ops.saveView,
      { name: 'Viewer view', definition },
      { caller: viewer.caller },
    );
    await expect(
      h.run(ops.saveView, { name: 'Shared', shared: true, definition }, { caller: viewer.caller }),
    ).rejects.toMatchObject({ status: 403 });
    const shared = await h.run(ops.saveView, { name: 'Team view', shared: true, definition });
    const list = await h.run(ops.listSavedViews, {}, { caller: viewer.caller });
    expect(list.views.map((v: { name: string }) => v.name).sort()).toEqual([
      'Team view',
      'Viewer view',
    ]);
    await expect(
      h.run(
        ops.saveView,
        { viewId: shared.view.id, name: 'Renamed', shared: true, definition },
        { caller: viewer.caller },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(h.run(ops.deleteView, { viewId: theirs.view.id })).rejects.toMatchObject({
      status: 404,
    });
    expect((await h.run(ops.deleteView, { viewId: mine.view.id })).deleted).toBe(true);
  });
});
