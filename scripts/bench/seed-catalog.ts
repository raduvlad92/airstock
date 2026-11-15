/**
 * Catalog benchmark seed (plan N2, Section 8): shops with realistic products, variants, and custom
 * field values, inserted directly as the database owner in large batches.
 *
 *   DATABASE_OWNER_URL=postgres://… tsx scripts/bench/seed-catalog.ts \
 *     [--shops 3] [--variants 10000] [--owner-user <users.id>] [--out seed.json]
 *
 * Each shop gets the brand and category system fields plus twelve custom fields of nine types,
 * about a quarter as many products as variants (1–8 variants each, with size and colour options),
 * and stock at two locations for a third of the variants. Deterministic for a given seed.
 *
 * Stock positions are written without ledger entries, so a seeded shop is for measurement only and
 * never for inventory tests.
 */

import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { uuidv7 } from '../../packages/core/src/ids.ts';
import { formatApiToken } from '../../packages/core/src/operations/access.ts';

const { values: args } = parseArgs({
  options: {
    shops: { type: 'string', default: '3' },
    variants: { type: 'string', default: '10000' },
    'owner-user': { type: 'string' },
    seed: { type: 'string', default: '42' },
    // Writes an API token per shop into the --out file (keep it out of the repository).
    tokens: { type: 'boolean', default: false },
    out: { type: 'string', default: 'seed.json' },
  },
});
const url =
  process.env.DATABASE_OWNER_URL ?? 'postgres://postgres:postgres@localhost:54329/airstock_dev';

let state = Number(args.seed);
const rand = () => {
  state = (state * 1103515245 + 12345) % 2 ** 31;
  return state / 2 ** 31;
};
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));

const ADJECTIVES = [
  'Classic',
  'Slim',
  'Organic',
  'Vintage',
  'Compact',
  'Premium',
  'Everyday',
  'Nordic',
  'Rustic',
  'Modern',
  'Soft',
  'Heavy-duty',
  'Travel',
  'Kids',
  'Outdoor',
];
const NOUNS = [
  'T-shirt',
  'Hoodie',
  'Chair',
  'Table',
  'Lamp',
  'Honey',
  'Olive oil',
  'Coffee beans',
  'Filter',
  'Bearing',
  'Gasket',
  'Mug',
  'Blanket',
  'Shelf',
  'Backpack',
  'Sneaker',
  'Jacket',
  'Candle',
  'Teapot',
  'Rug',
];
const MATERIALS = [
  'Cotton',
  'Linen',
  'Wool',
  'Oak',
  'Walnut',
  'Steel',
  'Ceramic',
  'Glass',
  'Leather',
  'Polyester',
];
const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const COLOURS = ['Black', 'White', 'Grey', 'Navy', 'Red', 'Green'];

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

const shopsOut: Array<{
  shopId: string;
  variants: number;
  products: number;
  locationIds: string[];
  token?: string;
}> = [];
const started = performance.now();
for (let s = 0; s < Number(args.shops); s++) {
  const shopId = uuidv7();
  let userId = args['owner-user'];
  if (!userId) {
    userId = uuidv7();
    await q('insert into users (id, workos_user_id, email) values ($1, $2, $3)', [
      userId,
      `bench_${userId}`,
      `bench-${userId}@example.test`,
    ]);
  }
  const warehouseId = uuidv7();
  const locations = [uuidv7(), uuidv7()];
  await q(
    'insert into shops (id, name, currency, timezone, created_by) values ($1, $2, $3, $4, $5)',
    [shopId, `Bench shop ${s + 1}`, 'EUR', 'Europe/Berlin', userId],
  );
  const membershipId = uuidv7();
  await q(`insert into memberships (shop_id, id, user_id, role) values ($1, $2, $3, 'owner')`, [
    shopId,
    membershipId,
    userId,
  ]);
  let token: string | undefined;
  if (args.tokens) {
    const credentialId = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    await q(
      `insert into api_credentials (shop_id, id, membership_id, name, secret_hash, scopes)
       values ($1, $2, $3, 'benchmark', $4, $5)`,
      [
        shopId,
        credentialId,
        membershipId,
        createHash('sha256').update(secret).digest('hex'),
        ['shop:read', 'catalog:read', 'catalog:write', 'inventory:read'],
      ],
    );
    token = formatApiToken(credentialId, secret);
  }
  await q(`insert into warehouses (shop_id, id, name) values ($1, $2, 'Main stock')`, [
    shopId,
    warehouseId,
  ]);
  for (const [i, id] of locations.entries()) {
    await q(
      `insert into locations (shop_id, id, warehouse_id, name, path, path_ids) values ($1, $2, $3, $4, $5, array[$3, $2]::uuid[])`,
      [shopId, id, warehouseId, `Bin ${i + 1}`, `Main stock/Bin ${i + 1}`],
    );
  }

  // Fields: id by key, options by label.
  const fieldIds: Record<string, string> = {};
  const options: Record<string, Record<string, string>> = {};
  const defs: Array<[string, string, string, string, Record<string, unknown>, string[]]> = [
    [
      'brand',
      'Brand',
      'single_select',
      'product',
      {},
      Array.from({ length: 40 }, (_, i) => `Brand ${i + 1}`),
    ],
    [
      'category',
      'Category',
      'single_select',
      'product',
      {},
      Array.from({ length: 30 }, (_, i) => `Category ${i + 1}`),
    ],
    ['material', 'Material', 'single_select', 'both', {}, MATERIALS],
    ['seasons', 'Seasons', 'multi_select', 'product', {}, SEASONS],
    ['care', 'Care instructions', 'rich_text', 'product', {}, []],
    ['manufacturer_number', 'Manufacturer number', 'text', 'variant', {}, []],
    [
      'net_weight',
      'Net weight',
      'measurement',
      'variant',
      { unitKind: 'weight', defaultUnit: 'g' },
      [],
    ],
    ['shelf_life_days', 'Shelf life (days)', 'integer', 'both', {}, []],
    ['launch_date', 'Launch date', 'date', 'product', {}, []],
    ['rrp', 'RRP', 'money', 'variant', { scale: 2 }, []],
    ['margin', 'Margin', 'decimal', 'variant', { scale: 3 }, []],
    ['eco', 'Eco label', 'boolean', 'product', {}, []],
    ['colour_family', 'Colour family', 'text', 'both', {}, []],
    [
      'assembled_width',
      'Assembled width',
      'measurement',
      'both',
      { unitKind: 'length', defaultUnit: 'cm' },
      [],
    ],
  ];
  for (const [key, label, type, level, config, opts] of defs) {
    const id = uuidv7();
    fieldIds[key] = id;
    await q(
      `insert into field_definitions (shop_id, id, key, label, type, level, config, is_system) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        shopId,
        id,
        key,
        label,
        type,
        level,
        JSON.stringify(config),
        key === 'brand' || key === 'category',
      ],
    );
    options[key] = {};
    for (const [position, l] of opts.entries()) {
      const oid = uuidv7();
      options[key][l] = oid;
      await q(
        'insert into field_options (shop_id, id, field_id, label, position) values ($1, $2, $3, $4, $5)',
        [shopId, oid, id, l, position],
      );
    }
  }

  const target = Number(args.variants);
  const products: Array<Record<string, unknown>> = [];
  const variants: Array<Record<string, unknown>> = [];
  const productOptions: Array<Record<string, unknown>> = [];
  const optionValues: Array<Record<string, unknown>> = [];
  const positions: Array<Record<string, unknown>> = [];
  let n = 0;
  while (n < target) {
    const productId = uuidv7();
    const name = `${pick(ADJECTIVES)} ${pick(NOUNS)} ${int(1, 999)}`;
    const attrs: Record<string, unknown> = {
      [fieldIds.brand!]: options.brand![pick(Object.keys(options.brand!))],
      [fieldIds.category!]: options.category![pick(Object.keys(options.category!))],
      [fieldIds.material!]: options.material![pick(MATERIALS)],
      [fieldIds.seasons!]: SEASONS.filter(() => rand() < 0.4).map((x) => options.seasons![x]),
      [fieldIds.care!]: 'Wash at 30 °C. **Do not tumble dry.**',
      [fieldIds.launch_date!]: `202${int(3, 6)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`,
      [fieldIds.eco!]: rand() < 0.3,
      [fieldIds.shelf_life_days!]: int(30, 900),
      [fieldIds.colour_family!]: pick(COLOURS),
    };
    if (rand() < 0.5) {
      const cm = int(30, 220);
      attrs[fieldIds.assembled_width!] = {
        value: String(cm),
        unit: 'cm',
        canonical: String(cm * 10),
      };
    }
    const count = Math.min(target - n, pick([1, 1, 2, 3, 4, 6, 8]));
    products.push({
      id: productId,
      name,
      description: `${name}. Made with care.`,
      attributes: attrs,
      tags: rand() < 0.5 ? ['new'] : [],
    });
    // Options: size × colour when there are several variants.
    const valueIds: string[][] = [];
    if (count > 1) {
      const sizeId = uuidv7();
      const colourId = uuidv7();
      productOptions.push(
        { id: sizeId, product_id: productId, name: 'Size', position: 0 },
        { id: colourId, product_id: productId, name: 'Colour', position: 1 },
      );
      const sizes = SIZES.slice(0, Math.min(SIZES.length, count));
      const colours = COLOURS.slice(0, Math.ceil(count / sizes.length));
      const sizeIds = sizes.map((label, position) => {
        const id = uuidv7();
        optionValues.push({ id, option_id: sizeId, label, position });
        return id;
      });
      const colourIds = colours.map((label, position) => {
        const id = uuidv7();
        optionValues.push({ id, option_id: colourId, label, position });
        return id;
      });
      for (const c of colourIds)
        for (const sz of sizeIds) if (valueIds.length < count) valueIds.push([c, sz].sort());
    } else {
      valueIds.push([]);
    }
    for (const [i, ids] of valueIds.entries()) {
      const id = uuidv7();
      const sku = `B${s}-${String(n).padStart(6, '0')}`;
      const grams = int(50, 5000);
      const vattrs: Record<string, unknown> = {
        [fieldIds.manufacturer_number!]: `MPN-${int(10000, 99999)}`,
        [fieldIds.net_weight!]: { value: String(grams), unit: 'g', canonical: String(grams) },
        [fieldIds.rrp!]: {
          amount: `${int(5, 300)}.${String(int(0, 99)).padStart(2, '0')}`,
          currency: 'EUR',
        },
        [fieldIds.margin!]: `0.${String(int(100, 600))}`,
      };
      if (rand() < 0.2) vattrs[fieldIds.material!] = options.material![pick(MATERIALS)];
      variants.push({
        id,
        product_id: productId,
        sku,
        sku_normalized: sku,
        price: `${int(3, 400)}.${pick(['00', '50', '90', '99'])}`,
        is_default: i === 0,
        option_value_ids: ids,
        attributes: vattrs,
      });
      if (rand() < 0.33) {
        for (const loc of locations)
          positions.push({
            id: uuidv7(),
            variant_id: id,
            location_id: loc,
            on_hand: String(int(0, 120)),
          });
      }
      n++;
    }
  }
  const batch = async (
    table: string,
    rows: Array<Record<string, unknown>>,
    columns: string,
    types: string,
  ) => {
    for (let i = 0; i < rows.length; i += 2000) {
      await q(
        `insert into ${table} (shop_id, ${columns}) select $1, ${columns} from jsonb_to_recordset($2::jsonb) as x(${types})`,
        [shopId, JSON.stringify(rows.slice(i, i + 2000))],
      );
    }
  };
  await batch(
    'products',
    products,
    'id, name, description, attributes, tags',
    'id uuid, name text, description text, attributes jsonb, tags text[]',
  );
  await batch(
    'product_options',
    productOptions,
    'id, product_id, name, position',
    'id uuid, product_id uuid, name text, position smallint',
  );
  await batch(
    'product_option_values',
    optionValues,
    'id, option_id, label, position',
    'id uuid, option_id uuid, label text, position int',
  );
  await batch(
    'variants',
    variants,
    'id, product_id, sku, sku_normalized, price, is_default, option_value_ids, attributes',
    'id uuid, product_id uuid, sku text, sku_normalized text, price numeric, is_default boolean, option_value_ids uuid[], attributes jsonb',
  );
  await batch(
    'inventory_positions',
    positions,
    'id, variant_id, location_id, on_hand',
    'id uuid, variant_id uuid, location_id uuid, on_hand numeric',
  );
  shopsOut.push({
    shopId,
    variants: variants.length,
    products: products.length,
    locationIds: locations,
    ...(token ? { token } : {}),
  });
  console.log(`shop ${s + 1}: ${products.length} products, ${variants.length} variants`);
}
await q('analyze products; analyze variants; analyze inventory_positions');
await client.end();
await writeFile(
  args.out,
  JSON.stringify({ shops: shopsOut, seconds: (performance.now() - started) / 1000 }, null, 2),
);
console.log(`Seeded in ${((performance.now() - started) / 1000).toFixed(1)} s; wrote ${args.out}.`);
