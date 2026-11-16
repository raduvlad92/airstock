/**
 * The six benchmark shops of the Phase 2 plan (Section 7.2): the owner's store and five made-up
 * personas. Catalogs are invented in each shop's style; no name is a real brand's product, and
 * every EAN uses the restricted-circulation prefix 2, which no real product carries.
 *
 * A persona is data: custom fields, families, warehouses with their location tree, suppliers, and
 * a catalog builder that describes products in the words a merchant would type (option labels,
 * "250 g"). `seed-personas.ts` encodes them with the product's own field encoder and writes them.
 *
 * Milestone I1 adds lots with expiry, serials, and one-of-a-kind items. Until then every variant
 * is tracked as `none`; the places that change are marked "I1:".
 */
import type { FieldConfig, FieldLevel, FieldType } from '../../packages/core/src/catalog/fields.ts';
import type { PackUse } from '../../packages/core/src/catalog/packs.ts';

export type Attrs = Record<string, unknown>;

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  level: FieldLevel;
  config?: FieldConfig;
  options?: string[];
}

export interface FamilySpec {
  name: string;
  /** Set when the family stands for a starter template the merchant added. */
  templateKey?: 'apparel' | 'furniture' | 'food' | 'spare_parts';
  fields: string[];
  required?: string[];
  options?: Array<{ name: string; values: string[] }>;
}

/** A location; leaves hold stock. `role` tags a subtree so the builder can place stock in it. */
export interface LocationSpec {
  name: string;
  code?: string;
  role?: string;
  fulfillment?: boolean;
  children?: LocationSpec[];
}

export interface WarehouseSpec {
  key: string;
  name: string;
  ownership: 'owned' | 'rented' | 'third_party';
  operatorName?: string;
  city: string;
  country: string;
  timezone?: string;
  fulfillment?: boolean;
  locations: LocationSpec[];
}

export interface SupplierSpec {
  key: string;
  name: string;
  leadTimeDays: number;
  city: string;
  country: string;
}

export interface PackInput {
  key: string;
  name: string;
  /** Base units, or inner packs when `inner` is set. */
  quantity: number;
  inner?: string;
  uses?: PackUse[];
  price?: string;
  barcode?: boolean;
}

export interface SupplyInput {
  supplier: string;
  /** Key of the pack the supplier sells, such as a case. */
  pack?: string;
  /** Cost per supplier unit (the pack, when there is one). */
  cost: string;
  moq?: number;
  sku?: string;
  preferred?: boolean;
}

export interface StockInput {
  warehouse: string;
  role: string;
  quantity: number;
}

export interface VariantInput {
  sku: string;
  /** Option value labels, in the product's option order. */
  options?: string[];
  price: string;
  attrs?: Attrs;
  /** ean13: a made-up GTIN; generated: the shop's internal code; a string: that Code 128 code. */
  barcode?: 'ean13' | 'generated' | string | null;
  packs?: PackInput[];
  supply?: SupplyInput[];
  stock?: StockInput[];
  status?: 'active' | 'archived';
  weight?: string;
}

export interface ProductInput {
  name: string;
  family: string;
  description?: string;
  status?: 'draft' | 'active' | 'archived';
  tags?: string[];
  attrs?: Attrs;
  options?: Array<{ name: string; values: string[] }>;
  variants: VariantInput[];
}

export interface VariantRef {
  id: string;
  sku: string;
  productId: string;
  options: string[];
}

export interface CatalogBuilder {
  rand(): number;
  int(min: number, max: number): number;
  pick<T>(list: readonly T[]): T;
  some<T>(list: readonly T[], min: number, max: number): T[];
  chance(p: number): boolean;
  /** A count multiplied by --scale, at least 1. */
  n(count: number): number;
  money(min: number, max: number, endings?: readonly string[]): string;
  /** Variants written so far in this shop. */
  readonly variants: number;
  product(p: ProductInput): VariantRef[];
  bundle(bundle: VariantRef, components: Array<{ variant: VariantRef; quantity: number }>): void;
  relate(field: string, from: VariantRef, to: VariantRef): void;
}

/** Inputs for the eight catalog query shapes of the Phase 1 benchmark (query-catalog.ts). */
export interface QueryHints {
  search: string;
  select: { field: string; values: string[] };
  measurementSort: string;
  range: { field: string; from: string; to: string };
  multi: { field: string; value: string };
  decimalSort: string;
  fields: string[];
  priceBelow: string;
}

export interface Persona {
  key: string;
  shopName: string;
  currency: string;
  timezone: string;
  /** Share of the 1,000,000 history events (seed-history.ts). */
  activityShare: number;
  /** Whether orders arrive through the Shopify connector. */
  shopify: boolean;
  fields: FieldSpec[];
  brands: string[];
  categories: string[];
  families: FamilySpec[];
  warehouses: WarehouseSpec[];
  suppliers: SupplierSpec[];
  query: QueryHints;
  build(b: CatalogBuilder): void;
}

// Shared helpers --------------------------------------------------------------------------------

const range = (n: number, from = 1) => Array.from({ length: n }, (_, i) => i + from);
const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Aisles × racks × bins, each level a location: the shape of most shelving. */
function shelving(
  aisles: string[],
  racks: number,
  bins: number,
  role: string,
  binLabel = 'Bin',
): LocationSpec[] {
  return aisles.map((a) => ({
    name: `Aisle ${a}`,
    code: a,
    children: range(racks).map((r) => ({
      name: `Rack ${a}${pad(r)}`,
      code: `${a}-${pad(r)}`,
      children: range(bins).map((s) => ({
        name: `${binLabel} ${a}-${pad(r)}-${s}`,
        code: `${a}-${pad(r)}-${s}`,
        role,
      })),
    })),
  }));
}

const area = (name: string, code: string, role: string, fulfillment = true): LocationSpec => ({
  name,
  code,
  role,
  fulfillment,
});

const TEXT = (key: string, label: string, level: FieldLevel, maxLength = 200): FieldSpec => ({
  key,
  label,
  type: 'text',
  level,
  config: { maxLength },
});
const SELECT = (key: string, label: string, level: FieldLevel, options: string[]): FieldSpec => ({
  key,
  label,
  type: 'single_select',
  level,
  options,
});
const MULTI = (key: string, label: string, level: FieldLevel, options: string[]): FieldSpec => ({
  key,
  label,
  type: 'multi_select',
  level,
  options,
});
const MEASURE = (
  key: string,
  label: string,
  level: FieldLevel,
  unitKind: 'weight' | 'length' | 'volume',
  defaultUnit: string,
): FieldSpec => ({ key, label, type: 'measurement', level, config: { unitKind, defaultUnit } });
const INT = (key: string, label: string, level: FieldLevel, min = '0', max = '100000') => ({
  key,
  label,
  type: 'integer' as const,
  level,
  config: { min, max },
});
const DEC = (key: string, label: string, level: FieldLevel, scale: number): FieldSpec => ({
  key,
  label,
  type: 'decimal',
  level,
  config: { scale },
});
const MONEY = (key: string, label: string, level: FieldLevel): FieldSpec => ({
  key,
  label,
  type: 'money',
  level,
  config: { scale: 2 },
});
const BOOL = (key: string, label: string, level: FieldLevel): FieldSpec => ({
  key,
  label,
  type: 'boolean',
  level,
});
const RICH = (key: string, label: string, level: FieldLevel): FieldSpec => ({
  key,
  label,
  type: 'rich_text',
  level,
});
const DATE = (key: string, label: string, level: FieldLevel): FieldSpec => ({
  key,
  label,
  type: 'date',
  level,
});

/** One item, drawn with probability proportional to its weight. */
function weighted<T>(b: CatalogBuilder, items: readonly T[], weight: (item: T) => number): T {
  const total = items.reduce((s, i) => s + weight(i), 0);
  let r = b.rand() * total;
  for (const item of items) {
    r -= weight(item);
    if (r < 0) return item;
  }
  return items[items.length - 1]!;
}

const date = (b: CatalogBuilder, fromYear: number, toYear: number) =>
  `${b.int(fromYear, toYear)}-${pad(b.int(1, 12))}-${pad(b.int(1, 28))}`;

// 1. The owner's store: trading cards and building sets -----------------------------------------

const TCG_SETS = [
  'Ember Tides',
  'Crystal Rift',
  'Storm Crown',
  'Verdant Echoes',
  'Obsidian Dawn',
  'Tidal Paradox',
  'Lunar Vault',
  'Gilded Frontier',
  'Shadow Bloom',
  'Prism Cascade',
  'Iron Summit',
  'Astral Hollow',
  'Wildfire Run',
  'Frostbound Legends',
  'Solar Rift',
  'Mythic Grove',
  'Thunder Coast',
  'Silver Reverie',
];
const ARCANA_SETS = [
  'Arcana Duel: Hollow Kings',
  'Arcana Duel: Glass Oath',
  'Arcana Duel: Rift Wardens',
  'Arcana Duel: Ninth Tide',
  'Arcana Duel: Ash Court',
  'Arcana Duel: Pale Comet',
];
const CREATURE_A = [
  'Blaze',
  'Frost',
  'Volt',
  'Moss',
  'Shade',
  'Tide',
  'Pyro',
  'Gale',
  'Rune',
  'Quartz',
  'Thorn',
  'Lumi',
  'Nox',
  'Sol',
  'Brine',
  'Cinder',
  'Drift',
  'Fang',
  'Glim',
  'Pebble',
];
const CREATURE_B = [
  'wing',
  'paw',
  'fin',
  'horn',
  'tail',
  'claw',
  'mane',
  'scale',
  'beak',
  'shell',
  'fox',
  'drake',
  'lynx',
  'owl',
  'moth',
  'toad',
];
const RARITIES = [
  'Common',
  'Uncommon',
  'Rare',
  'Holo rare',
  'Ultra rare',
  'Illustration rare',
  'Secret rare',
];
const BRICK_THEMES = [
  'City',
  'Space',
  'Castle',
  'Engineering',
  'Botanicals',
  'Racing',
  'Pirates',
  'Architecture',
  'Fantasy',
  'Railway',
];
const BRICK_NOUNS: Record<string, string[]> = {
  City: ['Harbour Lighthouse', 'Fire Station', 'Corner Bakery', 'Tram Depot', 'Police Outpost'],
  Space: ['Lunar Rover', 'Orbital Station', 'Cargo Shuttle', 'Mars Habitat', 'Comet Explorer'],
  Castle: ['Knight Outpost', 'Dragon Keep', 'Gatehouse', 'Siege Tower', 'Royal Stable'],
  Engineering: ['Crawler Crane', 'Rally Truck', 'Excavator', 'Off-road Buggy', 'Tow Truck'],
  Botanicals: ['Orchid', 'Bonsai Pine', 'Wildflower Bouquet', 'Succulents', 'Cherry Blossom'],
  Racing: ['Endurance Racer', 'Pit Stop', 'Hypercar', 'Formula Racer', 'Drift Coupe'],
  Pirates: ['Smuggler Cove', 'Galleon', 'Treasure Island', 'Harbour Fort', 'Shipwreck'],
  Architecture: ['Old Town Skyline', 'Grand Bridge', 'Clock Tower', 'Observatory', 'Opera House'],
  Fantasy: ['Wizard Tower', 'Enchanted Forest', 'Crystal Cavern', 'Floating Isle', 'Elf Village'],
  Railway: ['Steam Locomotive', 'Freight Yard', 'Signal Box', 'Sleeper Train', 'Mountain Line'],
};

const owner: Persona = {
  key: 'owner',
  shopName: 'Bench Cards and Bricks',
  currency: 'EUR',
  timezone: 'Europe/Bucharest',
  activityShare: 0.15,
  shopify: true,
  brands: ['Critter Clash TCG', 'Arcana Duel', 'Brickhaven', 'Studwork'],
  categories: [
    'Booster packs',
    'Elite trainer boxes',
    'Booster bundles',
    'Collection boxes',
    'Building sets',
    'Single cards',
    'Graded cards',
    'Used sets',
  ],
  fields: [
    SELECT('tcg_set', 'Set', 'product', [...TCG_SETS, ...ARCANA_SETS]),
    SELECT('language', 'Language', 'both', [
      'English',
      'Japanese',
      'German',
      'French',
      'Italian',
      'Spanish',
    ]),
    DATE('release_date', 'Release date', 'product'),
    MULTI('contents', 'Contents', 'product', [
      'Booster packs',
      'Promo card',
      'Card sleeves',
      'Dice',
      'Coin',
      'Damage counters',
      'Card dividers',
      'Minifigures',
      'Instructions',
    ]),
    MEASURE('package_weight', 'Package weight', 'both', 'weight', 'g'),
    TEXT('set_number', 'Set number', 'product', 20),
    SELECT('theme', 'Theme', 'product', BRICK_THEMES),
    INT('piece_count', 'Piece count', 'product', '1', '20000'),
    INT('age_from', 'Age from', 'product', '1', '18'),
    TEXT('card_number', 'Card number', 'product', 20),
    SELECT('rarity', 'Rarity', 'product', RARITIES),
    SELECT('card_condition', 'Card condition', 'variant', ['NM', 'LP', 'MP', 'HP', 'Damaged']),
    SELECT('grading_company', 'Grading company', 'variant', ['PSA', 'BGS', 'CGC', 'SGC']),
    DEC('grade', 'Grade', 'variant', 1),
    TEXT('certificate_number', 'Certificate number', 'variant', 30),
    SELECT('completeness', 'Completeness', 'variant', [
      'Complete',
      'Complete with box and manual',
      'Missing pieces',
      'Incomplete',
    ]),
    SELECT('box_condition', 'Box condition', 'variant', [
      'Sealed',
      'Opened',
      'Damaged box',
      'No box',
    ]),
    BOOL('sealed', 'Sealed', 'variant'),
    MONEY('rrp', 'RRP', 'variant'),
  ],
  families: [
    {
      name: 'Sealed TCG products',
      fields: ['tcg_set', 'language', 'release_date', 'contents', 'package_weight', 'rrp'],
      required: ['tcg_set'],
      options: [{ name: 'Language', values: ['English', 'Japanese', 'German'] }],
    },
    {
      name: 'Building sets',
      fields: ['set_number', 'theme', 'piece_count', 'age_from', 'package_weight', 'rrp'],
      required: ['set_number'],
    },
    {
      // I1: becomes the "Trading cards" starter family (plan 5.7), with one-of-a-kind variants.
      name: 'Trading cards',
      fields: [
        'tcg_set',
        'card_number',
        'rarity',
        'language',
        'card_condition',
        'grading_company',
        'grade',
        'certificate_number',
      ],
      required: ['tcg_set', 'card_number'],
    },
    {
      // I1: the "Building sets" starter family's opened and used items, one of a kind.
      name: 'Used sets',
      fields: ['set_number', 'theme', 'piece_count', 'completeness', 'box_condition', 'sealed'],
    },
  ],
  warehouses: [
    {
      key: 'home',
      name: 'Home warehouse',
      ownership: 'owned',
      city: 'Cluj-Napoca',
      country: 'RO',
      locations: [
        ...shelving(['A', 'B', 'C'], 6, 4, 'shelf', 'Shelf'),
        {
          name: 'Graded cabinet',
          code: 'GC',
          children: range(12).map((d) => area(`Drawer ${pad(d)}`, `GC-${pad(d)}`, 'cabinet')),
        },
        {
          name: 'Singles binders',
          code: 'SB',
          children: range(10).map((d) => area(`Binder ${pad(d)}`, `SB-${pad(d)}`, 'binder')),
        },
        area('Receiving', 'RCV', 'receiving', false),
        area('Packing desk', 'PACK', 'packing', false),
      ],
    },
  ],
  suppliers: [
    {
      key: 'hobby',
      name: 'Northwind Hobby Distribution',
      leadTimeDays: 7,
      city: 'Vienna',
      country: 'AT',
    },
    {
      key: 'bricks',
      name: 'Brick & Board Wholesale',
      leadTimeDays: 10,
      city: 'Budapest',
      country: 'HU',
    },
    { key: 'vault', name: 'Card Vault Imports', leadTimeDays: 21, city: 'Leipzig', country: 'DE' },
  ],
  query: {
    search: 'ember booster',
    select: { field: 'language', values: ['Japanese', 'German'] },
    measurementSort: 'package_weight',
    range: { field: 'piece_count', from: '500', to: '2000' },
    multi: { field: 'contents', value: 'Promo card' },
    decimalSort: 'grade',
    fields: ['tcg_set', 'language', 'rarity', 'rrp'],
    priceBelow: '20',
  },
  build(b) {
    let sku = 1;
    const next = (prefix: string) => `${prefix}-${pad(sku++, 5)}`;
    const sealedStock = (packsPerBox: number, boxes: number): StockInput[] =>
      boxes > 0 ? [{ warehouse: 'home', role: 'shelf', quantity: packsPerBox * boxes }] : [];

    // Booster packs by language; a booster box holds 36 packs and a case 6 boxes.
    for (const [i, set] of TCG_SETS.entries()) {
      const year = 2024 + Math.floor(i / 6);
      const languages = ['English', ...(b.chance(0.6) ? ['Japanese'] : [])].concat(
        b.chance(0.4) ? ['German'] : [],
      );
      b.product({
        name: `Critter Clash TCG: ${set} booster pack`,
        family: 'Sealed TCG products',
        attrs: {
          brand: 'Critter Clash TCG',
          category: 'Booster packs',
          tcg_set: set,
          release_date: date(b, year, year),
          contents: ['Booster packs'],
        },
        options: [{ name: 'Language', values: languages }],
        variants: languages.map((language) => {
          const boxCost = (b.int(80, 110) + 0.5).toFixed(2);
          return {
            sku: next('TCG'),
            options: [language],
            price: '5.49',
            attrs: { package_weight: '18 g', rrp: '5.49' },
            barcode: 'ean13',
            packs: [
              {
                key: 'box',
                name: 'Booster box',
                quantity: 36,
                uses: ['purchasing', 'counting', 'sales'],
                price: '159.00',
                barcode: true,
              },
              {
                key: 'case',
                name: 'Case',
                quantity: 6,
                inner: 'box',
                uses: ['purchasing', 'counting', 'transfer'],
                barcode: true,
              },
            ],
            supply: [
              {
                supplier: language === 'Japanese' ? 'vault' : 'hobby',
                pack: 'case',
                cost: (Number(boxCost) * 6).toFixed(2),
                moq: 1,
                preferred: true,
              },
            ],
            stock: sealedStock(36, b.int(0, 8)),
          };
        }),
      });
      // Elite Trainer Box: 9 packs and accessories; cases of 10.
      b.product({
        name: `Critter Clash TCG: ${set} Elite Trainer Box`,
        family: 'Sealed TCG products',
        attrs: {
          brand: 'Critter Clash TCG',
          category: 'Elite trainer boxes',
          tcg_set: set,
          release_date: date(b, year, year),
          contents: ['Booster packs', 'Promo card', 'Card sleeves', 'Dice', 'Card dividers'],
        },
        variants: [
          {
            sku: next('ETB'),
            price: b.money(49, 59, ['.90', '.99']),
            attrs: { package_weight: '980 g', language: 'English', rrp: '54.99' },
            barcode: 'ean13',
            packs: [
              {
                key: 'case',
                name: 'Case',
                quantity: 10,
                uses: ['purchasing', 'counting'],
                barcode: true,
              },
            ],
            supply: [{ supplier: 'hobby', pack: 'case', cost: '389.00', moq: 1, preferred: true }],
            stock: [{ warehouse: 'home', role: 'shelf', quantity: b.int(0, 24) }],
          },
        ],
      });
      if (b.chance(0.7)) {
        b.product({
          name: `Critter Clash TCG: ${set} booster bundle`,
          family: 'Sealed TCG products',
          attrs: {
            brand: 'Critter Clash TCG',
            category: 'Booster bundles',
            tcg_set: set,
            contents: ['Booster packs'],
          },
          variants: [
            {
              sku: next('BND'),
              price: '29.99',
              attrs: { package_weight: '160 g', language: 'English' },
              barcode: 'ean13',
              packs: [{ key: 'case', name: 'Case', quantity: 12, uses: ['purchasing'] }],
              supply: [{ supplier: 'hobby', pack: 'case', cost: '252.00', preferred: true }],
              stock: [{ warehouse: 'home', role: 'shelf', quantity: b.int(0, 30) }],
            },
          ],
        });
      }
      for (const kind of b.chance(0.5) ? ['Premium collection', 'Collector tin'] : []) {
        const creature = `${b.pick(CREATURE_A)}${b.pick(CREATURE_B)}`;
        b.product({
          name: `Critter Clash TCG: ${kind} — ${creature}`,
          family: 'Sealed TCG products',
          attrs: {
            brand: 'Critter Clash TCG',
            category: 'Collection boxes',
            tcg_set: set,
            contents: ['Booster packs', 'Promo card'],
          },
          variants: [
            {
              sku: next('COL'),
              price: b.money(19, 69, ['.99']),
              attrs: { package_weight: `${b.int(200, 1200)} g`, language: 'English' },
              barcode: 'ean13',
              packs: [{ key: 'case', name: 'Case', quantity: 6, uses: ['purchasing'] }],
              supply: [
                { supplier: 'hobby', pack: 'case', cost: b.money(90, 240), preferred: true },
              ],
              stock: [{ warehouse: 'home', role: 'shelf', quantity: b.int(0, 12) }],
            },
          ],
        });
      }
    }
    for (const set of ARCANA_SETS) {
      b.product({
        name: `${set} booster pack`,
        family: 'Sealed TCG products',
        attrs: { brand: 'Arcana Duel', category: 'Booster packs', tcg_set: set },
        variants: [
          {
            sku: next('ARC'),
            price: '4.49',
            attrs: { package_weight: '16 g', language: 'English' },
            barcode: 'ean13',
            packs: [
              { key: 'box', name: 'Booster box', quantity: 24, uses: ['purchasing', 'sales'] },
              { key: 'case', name: 'Case', quantity: 12, inner: 'box', uses: ['purchasing'] },
            ],
            supply: [{ supplier: 'hobby', pack: 'case', cost: '780.00', preferred: true }],
            stock: sealedStock(24, b.int(0, 5)),
          },
        ],
      });
    }

    // Building sets: one variant each, EAN on the box, shipper cartons of 3 or 4.
    const usedSets: Array<{ name: string; theme: string; number: string; pieces: number }> = [];
    for (let i = 0; i < b.n(160); i++) {
      const theme = b.pick(BRICK_THEMES);
      const pieces = b.int(80, 4200);
      const number = String(b.int(10000, 79999));
      const name = `${b.pick(['Brickhaven', 'Studwork'])} ${theme} ${b.pick(BRICK_NOUNS[theme]!)} ${number}`;
      if (i % 3 === 0) usedSets.push({ name, theme, number, pieces });
      const price = Math.max(9.99, Math.round(pieces * 0.11) - 0.01).toFixed(2);
      b.product({
        name,
        family: 'Building sets',
        tags: i < 20 ? ['new'] : [],
        attrs: {
          brand: name.startsWith('Brickhaven') ? 'Brickhaven' : 'Studwork',
          category: 'Building sets',
          set_number: number,
          theme,
          piece_count: pieces,
          age_from: b.pick([6, 8, 9, 10, 12, 18]),
          contents: ['Instructions', ...(b.chance(0.6) ? ['Minifigures'] : [])],
        },
        variants: [
          {
            sku: `BRK-${number}`,
            price,
            attrs: { package_weight: `${Math.round(pieces * 1.4 + 150)} g`, rrp: price },
            barcode: 'ean13',
            packs: b.chance(0.5)
              ? [{ key: 'shipper', name: 'Shipper carton', quantity: b.pick([3, 4]) }]
              : [],
            supply: [
              {
                supplier: 'bricks',
                cost: (Number(price) * 0.62).toFixed(2),
                moq: b.pick([1, 2, 3]),
                sku: `BB-${number}`,
                preferred: true,
              },
            ],
            stock: [{ warehouse: 'home', role: 'shelf', quantity: b.int(0, 9) }],
            weight: `${Math.round(pieces * 1.4 + 150)} g`,
          },
        ],
      });
    }

    // One-of-a-kind items: 650 single cards, 250 graded cards, and 100 used sets, each a product of
    // its own with a quantity of one. I1: mark these variants one of a kind (D5) and give graded
    // cards their certificate as a serial on a shared variant where the merchant prefers that.
    for (let i = 0; i < b.n(900); i++) {
      const graded = i % 18 < 5;
      const set = b.pick(TCG_SETS);
      const creature = `${b.pick(CREATURE_A)}${b.pick(CREATURE_B)}`;
      const number = `${pad(b.int(1, 230), 3)}/${b.pick([165, 182, 198, 207, 230])}`;
      const rarity = b.pick(RARITIES);
      const company = b.pick(['PSA', 'PSA', 'BGS', 'CGC', 'SGC']);
      const grade = graded ? b.pick(['10', '9.5', '9', '9', '8.5', '8', '7']) : null;
      const condition = b.pick(['NM', 'NM', 'NM', 'LP', 'LP', 'MP', 'HP']);
      const certificate = String(b.int(10_000_000, 99_999_999));
      b.product({
        name: graded
          ? `${company} ${grade} ${creature} ${number} — ${set}`
          : `${creature} ${number} ${rarity} — ${set} (${condition})`,
        family: 'Trading cards',
        attrs: {
          brand: 'Critter Clash TCG',
          category: graded ? 'Graded cards' : 'Single cards',
          tcg_set: set,
          card_number: number,
          rarity,
        },
        variants: [
          {
            sku: graded ? `GRD-${certificate}` : next('SGL'),
            price: graded ? b.money(40, 900, ['.00']) : b.money(1, 60, ['.00', '.50', '.99']),
            attrs: graded
              ? {
                  language: b.pick(['English', 'English', 'Japanese']),
                  grading_company: company,
                  grade,
                  certificate_number: certificate,
                }
              : {
                  language: b.pick(['English', 'English', 'Japanese', 'German']),
                  card_condition: condition,
                },
            barcode: 'generated',
            stock: [{ warehouse: 'home', role: graded ? 'cabinet' : 'binder', quantity: 1 }],
          },
        ],
      });
    }
    for (let i = 0; i < b.n(100); i++) {
      const s = usedSets[i % usedSets.length]!;
      const complete = b.pick(['Complete', 'Complete with box and manual', 'Missing pieces']);
      b.product({
        name: `Used — ${s.name} (${complete.toLowerCase()})`,
        family: 'Used sets',
        attrs: {
          brand: s.name.startsWith('Brickhaven') ? 'Brickhaven' : 'Studwork',
          category: 'Used sets',
          set_number: s.number,
          theme: s.theme,
          piece_count: s.pieces,
        },
        variants: [
          {
            sku: next('USED'),
            price: b.money(15, 250, ['.00']),
            attrs: {
              completeness: complete,
              box_condition: b.pick(['Opened', 'Damaged box', 'No box']),
              sealed: false,
            },
            barcode: 'generated',
            stock: [{ warehouse: 'home', role: 'shelf', quantity: 1 }],
          },
        ],
      });
    }
  },
};

// 2. Sports clothing ----------------------------------------------------------------------------

const SPORT_COLOURS = [
  'Black',
  'White',
  'Graphite',
  'Navy',
  'Olive',
  'Sand',
  'Coral',
  'Cobalt',
  'Burgundy',
  'Lime',
  'Stone',
  'Charcoal marl',
];
const SPORT_LINES: Array<{
  line: string;
  garments: string[];
  category: string;
  family: string;
  price: [number, number];
  activity: string[];
}> = [
  {
    line: 'Tempo',
    garments: ['Training Top', 'Long Sleeve Top', 'Tank'],
    category: 'Tops',
    family: 'Tops',
    price: [24, 45],
    activity: ['Gym', 'Running'],
  },
  {
    line: 'Pace',
    garments: ['Running Tee', 'Half Zip', 'Singlet'],
    category: 'Tops',
    family: 'Tops',
    price: [22, 55],
    activity: ['Running'],
  },
  {
    line: 'Flux',
    garments: ['Tapered Jogger', 'Track Pant', 'Cuffed Jogger'],
    category: 'Joggers',
    family: 'Bottoms',
    price: [39, 65],
    activity: ['Gym', 'Outdoor'],
  },
  {
    line: 'Sprint',
    garments: ['5" Running Short', '7" Training Short', '2-in-1 Short'],
    category: 'Shorts',
    family: 'Bottoms',
    price: [25, 42],
    activity: ['Running', 'Football'],
  },
  {
    line: 'Core',
    garments: ['7/8 Legging', 'Full Length Legging', 'Cycling Short'],
    category: 'Leggings',
    family: 'Bottoms',
    price: [35, 60],
    activity: ['Yoga', 'Gym', 'Cycling'],
  },
  {
    line: 'Lift',
    garments: ['Medium Support Bra', 'High Support Bra', 'Crop Bra'],
    category: 'Sports bras',
    family: 'Tops',
    price: [28, 48],
    activity: ['Gym', 'Running'],
  },
  {
    line: 'Shell',
    garments: ['Packable Wind Jacket', 'Insulated Vest', 'Rain Jacket'],
    category: 'Jackets',
    family: 'Outerwear',
    price: [59, 129],
    activity: ['Outdoor', 'Running'],
  },
];
const SPORT_MODIFIERS = [
  'Seamless',
  'Lightweight',
  'Thermal',
  'Mesh',
  'Ribbed',
  'Breathable',
  'Quick-dry',
  'Brushed',
  'Recycled',
  'Pro',
  'Essential',
  'Elite',
];
const SPORT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

const sports: Persona = {
  key: 'sports',
  shopName: 'Bench Stride Sportswear',
  currency: 'EUR',
  timezone: 'Europe/Berlin',
  activityShare: 0.18,
  shopify: true,
  brands: ['Stride', 'Stride Studio', 'Stride Trail'],
  categories: [
    'Tops',
    'Joggers',
    'Shorts',
    'Leggings',
    'Sports bras',
    'Jackets',
    'Socks',
    'Outfit sets',
  ],
  fields: [
    SELECT('material', 'Material', 'both', [
      'Recycled polyester',
      'Polyamide-elastane',
      'Cotton blend',
      'Merino wool',
      'Nylon ripstop',
    ]),
    SELECT('fit', 'Fit', 'product', ['Slim', 'Regular', 'Relaxed', 'Oversized']),
    SELECT('gender', 'Fit for', 'product', ['Women', 'Men', 'Unisex']),
    MULTI('activity', 'Activity', 'product', [
      'Running',
      'Gym',
      'Yoga',
      'Outdoor',
      'Football',
      'Cycling',
    ]),
    SELECT('drop', 'Drop', 'product', ['Core', 'SS26', 'AW26', 'SS27']),
    MEASURE('garment_weight', 'Garment weight', 'variant', 'weight', 'g'),
    INT('fabric_gsm', 'Fabric weight (g/m²)', 'product', '50', '600'),
    DEC('stretch_percent', 'Stretch (%)', 'product', 1),
    RICH('care_instructions', 'Care instructions', 'product'),
    BOOL('reflective', 'Reflective details', 'product'),
    DATE('launch_date', 'Launch date', 'product'),
    MONEY('rrp', 'RRP', 'variant'),
  ],
  families: [
    {
      name: 'Tops',
      templateKey: 'apparel',
      fields: ['material', 'fit', 'gender', 'activity', 'drop', 'fabric_gsm', 'care_instructions'],
      options: [
        { name: 'Size', values: SPORT_SIZES },
        { name: 'Colour', values: SPORT_COLOURS.slice(0, 6) },
      ],
    },
    {
      name: 'Bottoms',
      fields: ['material', 'fit', 'gender', 'activity', 'drop', 'stretch_percent'],
      options: [{ name: 'Size', values: SPORT_SIZES }],
    },
    {
      name: 'Outerwear',
      fields: ['material', 'fit', 'gender', 'drop', 'reflective', 'care_instructions'],
    },
    { name: 'Socks', fields: ['material', 'activity'] },
    { name: 'Outfit sets', fields: ['gender', 'activity', 'drop'] },
  ],
  warehouses: [
    {
      key: 'central',
      name: 'Central warehouse',
      ownership: 'owned',
      city: 'Kassel',
      country: 'DE',
      locations: [
        ...shelving(['A', 'B', 'C', 'D', 'E', 'F'], 8, 4, 'pick'),
        {
          name: 'Returns',
          code: 'RET',
          fulfillment: false,
          children: [
            area('Inspection bench', 'RET-INSP', 'returns', false),
            area('Quarantine cage', 'RET-Q', 'quarantine', false),
          ],
        },
        area('Goods-in', 'IN', 'receiving', false),
        area('Dispatch', 'OUT', 'dispatch', false),
      ],
    },
    {
      key: 'outlet',
      name: 'Outlet store',
      ownership: 'rented',
      city: 'Hamburg',
      country: 'DE',
      locations: [
        {
          name: 'Shop floor',
          code: 'FLOOR',
          children: range(10).map((r) => area(`Rail ${pad(r)}`, `R${pad(r)}`, 'floor')),
        },
        {
          name: 'Stockroom',
          code: 'STOCK',
          children: range(6).map((s) => area(`Shelf ${s}`, `S${s}`, 'stockroom')),
        },
      ],
    },
  ],
  suppliers: [
    {
      key: 'mill',
      name: 'Anatolia Knit Mills',
      leadTimeDays: 45,
      city: 'Bursa',
      country: 'TR',
    },
    { key: 'porto', name: 'Porto Activewear Lda', leadTimeDays: 30, city: 'Porto', country: 'PT' },
    { key: 'socks', name: 'Brno Hosiery s.r.o.', leadTimeDays: 20, city: 'Brno', country: 'CZ' },
  ],
  query: {
    search: 'tempo training',
    select: { field: 'material', values: ['Merino wool', 'Cotton blend'] },
    measurementSort: 'garment_weight',
    range: { field: 'fabric_gsm', from: '150', to: '300' },
    multi: { field: 'activity', value: 'Running' },
    decimalSort: 'stretch_percent',
    fields: ['material', 'fit', 'garment_weight', 'rrp'],
    priceBelow: '30',
  },
  build(b) {
    const target = b.n(4000);
    const bundleTarget = b.n(60);
    const tops: VariantRef[][] = [];
    const bottoms: VariantRef[][] = [];
    let style = 100;
    // Socks: three sizes in colours, sold singly and in cartons.
    for (let i = 0; i < b.n(12); i++) {
      const colours = b.some(SPORT_COLOURS, 2, 4);
      const sizes = ['35–38', '39–42', '43–46'];
      const code = style++;
      b.product({
        name: `Step ${b.pick(['Crew', 'Ankle', 'Trail', 'Compression'])} Sock ${b.pick(['', '3-pack '])}${code}`.replace(
          '  ',
          ' ',
        ),
        family: 'Socks',
        attrs: {
          brand: 'Stride',
          category: 'Socks',
          material: b.pick(['Merino wool', 'Cotton blend', 'Recycled polyester']),
          activity: b.some(['Running', 'Outdoor', 'Gym'], 1, 2),
        },
        options: [
          { name: 'Size', values: sizes },
          { name: 'Colour', values: colours },
        ],
        variants: sizes.flatMap((size) =>
          colours.map((colour) => ({
            sku: `STP-${code}-${colour.slice(0, 3).toUpperCase()}-${size.slice(0, 2)}`,
            options: [size, colour],
            price: '12.95',
            barcode: 'ean13',
            packs: [{ key: 'carton', name: 'Carton', quantity: 50, uses: ['purchasing'] }],
            supply: [
              { supplier: 'socks', pack: 'carton', cost: '140.00', moq: 2, preferred: true },
            ],
            stock: [{ warehouse: 'central', role: 'pick', quantity: b.int(0, 120) }],
          })),
        ),
      });
    }
    while (b.variants < target - bundleTarget * 4) {
      const line = b.pick(SPORT_LINES);
      const garment = b.pick(line.garments);
      const modifier = b.pick(SPORT_MODIFIERS);
      const code = style++;
      const colours = b.some(SPORT_COLOURS, 2, 5);
      const sizes = line.category === 'Sports bras' ? SPORT_SIZES.slice(0, 5) : SPORT_SIZES;
      const price = b.money(line.price[0], line.price[1], ['.95', '.00']);
      const drop = b.pick(['Core', 'Core', 'SS26', 'AW26', 'SS27']);
      const supplier = b.pick(['mill', 'porto']);
      const archived = drop === 'SS26' && b.chance(0.3);
      const refs = b.product({
        name: `${line.line} ${modifier} ${garment}`,
        family: line.family,
        status: archived ? 'archived' : 'active',
        tags: drop === 'SS27' ? ['new'] : [],
        attrs: {
          brand: b.pick(['Stride', 'Stride', 'Stride Studio', 'Stride Trail']),
          category: line.category,
          material: b.pick(['Recycled polyester', 'Polyamide-elastane', 'Cotton blend']),
          fit: b.pick(['Slim', 'Regular', 'Relaxed', 'Oversized']),
          gender: b.pick(['Women', 'Men', 'Unisex']),
          activity: b.some(line.activity, 1, line.activity.length),
          drop,
          fabric_gsm: b.int(110, 340),
          ...(line.family === 'Bottoms'
            ? { stretch_percent: `${b.int(5, 30)}.${b.int(0, 9)}` }
            : {}),
          ...(line.family !== 'Bottoms'
            ? { care_instructions: 'Wash at 30 °C inside out. **Do not tumble dry.**' }
            : {}),
          ...(line.category === 'Jackets' ? { reflective: b.chance(0.6) } : {}),
          launch_date: date(b, 2025, 2027),
        },
        options: [
          { name: 'Size', values: sizes },
          { name: 'Colour', values: colours },
        ],
        variants: colours.flatMap((colour) =>
          sizes.map((size) => ({
            sku: `STR-${code}-${colour
              .replace(/[^A-Za-z]/g, '')
              .slice(0, 4)
              .toUpperCase()}-${size}`,
            options: [size, colour],
            price,
            attrs: {
              garment_weight: `${b.int(90, 650)} g`,
              rrp: price,
            },
            barcode: 'ean13',
            packs: [
              { key: 'carton', name: 'Carton', quantity: b.pick([20, 40]), uses: ['purchasing'] },
            ],
            supply: [
              {
                supplier,
                pack: 'carton',
                cost: (Number(price) * 0.32 * 20).toFixed(2),
                moq: b.pick([1, 2, 5]),
                sku: `${supplier.toUpperCase()}-${code}-${size}`,
                preferred: true,
              },
            ],
            stock: archived
              ? []
              : [
                  { warehouse: 'central', role: 'pick', quantity: b.int(0, 60) },
                  ...(b.chance(0.3)
                    ? [
                        {
                          warehouse: 'outlet',
                          role: b.pick(['floor', 'stockroom']),
                          quantity: b.int(1, 8),
                        },
                      ]
                    : []),
                ],
          })),
        ),
      });
      if (!archived && line.family === 'Tops' && line.category !== 'Sports bras') tops.push(refs);
      if (!archived && line.family === 'Bottoms') bottoms.push(refs);
    }
    // Outfit sets: a top and a bottom in the same size, as bundles (G7, A36).
    for (let i = 0; i < bundleTarget && tops.length > 0 && bottoms.length > 0; i++) {
      const top = b.pick(tops);
      const bottom = b.pick(bottoms);
      const sizes = ['S', 'M', 'L', 'XL'];
      const refs = b.product({
        name: `Training set ${pad(i + 1, 3)}: ${b.pick(['Tempo', 'Pace'])} top + ${b.pick(['Flux', 'Sprint', 'Core'])} bottom`,
        family: 'Outfit sets',
        attrs: { brand: 'Stride', category: 'Outfit sets', activity: ['Gym'] },
        options: [{ name: 'Size', values: sizes }],
        variants: sizes.map((size) => ({
          sku: `SET-${pad(i + 1, 3)}-${size}`,
          options: [size],
          price: b.money(59, 99, ['.00', '.95']),
          barcode: 'ean13',
        })),
      });
      for (const ref of refs) {
        const size = ref.options[0]!;
        const t = top.find((v) => v.options[0] === size);
        const m = bottom.find((v) => v.options[0] === size);
        if (t && m)
          b.bundle(ref, [
            { variant: t, quantity: 1 },
            { variant: m, quantity: 1 },
          ]);
      }
    }
  },
};

// 3. Food ---------------------------------------------------------------------------------------

const FLAVOURS = [
  'Vanilla',
  'Chocolate',
  'Strawberry',
  'Banana',
  'Coffee',
  'Salted caramel',
  'Berry',
  'Mango',
  'Original',
  'Peanut',
  'Matcha',
  'Cinnamon roll',
];
const EU_ALLERGENS = ['Gluten', 'Milk', 'Soybeans', 'Nuts', 'Peanuts', 'Sesame', 'Eggs'];

const food: Persona = {
  key: 'food',
  shopName: 'Bench Fuel Kitchen',
  currency: 'EUR',
  timezone: 'Europe/Amsterdam',
  activityShare: 0.12,
  shopify: true,
  brands: ['Fuel Kitchen', 'Fuel Kitchen Sport'],
  categories: ['Drinkable meals', 'Bars', 'Powders', 'Meal pots'],
  fields: [
    MEASURE('net_weight', 'Net weight', 'variant', 'weight', 'g'),
    MEASURE('volume', 'Volume', 'variant', 'volume', 'ml'),
    RICH('ingredients', 'Ingredients', 'product'),
    MULTI('allergens', 'Allergens', 'product', EU_ALLERGENS),
    SELECT('storage', 'Storage requirements', 'product', ['Ambient', 'Chilled', 'Frozen']),
    INT('shelf_life_days', 'Shelf life (days)', 'both', '0', '3650'),
    SELECT('flavour', 'Flavour', 'variant', FLAVOURS),
    INT('kcal_per_serving', 'kcal per serving', 'variant', '0', '2000'),
    DEC('protein_per_serving', 'Protein per serving (g)', 'variant', 1),
    MULTI('diet', 'Diet', 'product', [
      'Vegan',
      'Gluten free',
      'Lactose free',
      'High protein',
      'Keto',
    ]),
    MONEY('rrp', 'RRP', 'variant'),
  ],
  families: [
    {
      name: 'Food',
      templateKey: 'food',
      fields: ['net_weight', 'ingredients', 'allergens', 'storage', 'shelf_life_days'],
      required: ['storage'],
    },
    {
      name: 'Drinkable meals',
      fields: [
        'volume',
        'ingredients',
        'allergens',
        'storage',
        'shelf_life_days',
        'flavour',
        'kcal_per_serving',
        'protein_per_serving',
        'diet',
      ],
      required: ['storage'],
      options: [{ name: 'Flavour', values: FLAVOURS.slice(0, 6) }],
    },
    {
      name: 'Bars and powders',
      fields: [
        'net_weight',
        'ingredients',
        'allergens',
        'storage',
        'shelf_life_days',
        'flavour',
        'kcal_per_serving',
        'protein_per_serving',
        'diet',
      ],
      required: ['storage'],
    },
  ],
  warehouses: [
    {
      key: 'main',
      name: 'Main warehouse',
      ownership: 'rented',
      city: 'Tilburg',
      country: 'NL',
      locations: [
        {
          name: 'Ambient store',
          code: 'AMB',
          children: shelving(['A', 'B', 'C', 'D'], 6, 3, 'ambient'),
        },
        {
          name: 'Chilled room',
          code: 'CHL',
          children: range(6).map((r) => area(`Chilled rack ${r}`, `CHL-${r}`, 'chilled')),
        },
        area('Quarantine', 'QUA', 'quarantine', false),
        area('Goods-in', 'IN', 'receiving', false),
      ],
    },
  ],
  suppliers: [
    {
      key: 'rhine',
      name: 'Rhine Co-Packing GmbH',
      leadTimeDays: 28,
      city: 'Duisburg',
      country: 'DE',
    },
    { key: 'alba', name: 'Alba Nutrition Labs', leadTimeDays: 21, city: 'Turin', country: 'IT' },
    { key: 'polder', name: 'Polder Bakery Foods', leadTimeDays: 14, city: 'Ede', country: 'NL' },
  ],
  query: {
    search: 'protein chocolate',
    select: { field: 'storage', values: ['Chilled', 'Frozen'] },
    measurementSort: 'net_weight',
    range: { field: 'shelf_life_days', from: '90', to: '365' },
    multi: { field: 'diet', value: 'Vegan' },
    decimalSort: 'protein_per_serving',
    fields: ['flavour', 'storage', 'net_weight', 'rrp'],
    priceBelow: '3',
  },
  build(b) {
    const target = b.n(300);
    // I1: every variant here becomes lot_expiry tracked, with about ten lots each (3,000 in all),
    // received with expiry dates and allocated earliest expiry first.
    const shelfLife = (days: number) => ({ shelf_life_days: days });
    for (const formula of ['Complete', 'Protein+', 'Light']) {
      for (const size of ['400 ml', '500 ml']) {
        const flavours = b.some(FLAVOURS, 8, 12);
        b.product({
          name: `Fuel Drink ${formula} ${size}`,
          family: 'Drinkable meals',
          attrs: {
            brand: 'Fuel Kitchen',
            category: 'Drinkable meals',
            storage: 'Ambient',
            ...shelfLife(b.int(180, 365)),
            allergens: ['Milk', 'Soybeans'],
            diet: formula === 'Protein+' ? ['High protein', 'Gluten free'] : ['Gluten free'],
            ingredients: 'Water, milk protein, oat flour, rapeseed oil, **vitamins and minerals**.',
          },
          options: [{ name: 'Flavour', values: flavours }],
          variants: flavours.map((flavour) => ({
            sku: `FD-${formula.slice(0, 2).toUpperCase()}-${size.slice(0, 3)}-${flavour.slice(0, 3).toUpperCase()}${b.int(10, 99)}`,
            options: [flavour],
            price: size === '400 ml' ? '2.95' : '3.45',
            attrs: {
              volume: size,
              flavour,
              kcal_per_serving: formula === 'Light' ? 250 : 400,
              protein_per_serving: formula === 'Protein+' ? '32.0' : '20.0',
              rrp: size === '400 ml' ? '2.95' : '3.45',
            },
            barcode: 'ean13',
            packs: [
              {
                key: 'six',
                name: '6-pack',
                quantity: 6,
                uses: ['sales', 'counting'],
                price: '16.50',
                barcode: true,
              },
              {
                key: 'twelve',
                name: '12-pack',
                quantity: 12,
                uses: ['sales', 'counting'],
                price: '31.00',
                barcode: true,
              },
              {
                key: 'case',
                name: 'Case',
                quantity: 2,
                inner: 'twelve',
                uses: ['purchasing', 'counting', 'transfer'],
                barcode: true,
              },
            ],
            supply: [{ supplier: 'rhine', pack: 'case', cost: '26.40', moq: 50, preferred: true }],
            stock: [{ warehouse: 'main', role: 'ambient', quantity: 24 * b.int(2, 40) }],
          })),
        });
      }
    }
    while (b.variants < target - 40) {
      const kind = b.pick(['Protein bar', 'Oat bar', 'Energy bar', 'Keto bar']);
      const flavours = b.some(FLAVOURS, 4, 8);
      const grams = b.pick([40, 45, 55, 60]);
      b.product({
        name: `Fuel ${kind} ${grams} g ${b.pick(['', 'Crunch', 'Soft bake', 'Double layer'])}`.trim(),
        family: 'Bars and powders',
        attrs: {
          brand: 'Fuel Kitchen Sport',
          category: 'Bars',
          storage: 'Ambient',
          ...shelfLife(b.int(120, 270)),
          allergens: b.some(EU_ALLERGENS, 1, 3),
          diet: b.some(['High protein', 'Vegan', 'Gluten free', 'Keto'], 1, 2),
        },
        options: [{ name: 'Flavour', values: flavours }],
        variants: flavours.map((flavour) => ({
          sku: `FB-${kind.slice(0, 3).toUpperCase()}-${grams}-${flavour.slice(0, 3).toUpperCase()}${b.int(100, 999)}`,
          options: [flavour],
          price: '2.49',
          attrs: {
            net_weight: `${grams} g`,
            flavour,
            kcal_per_serving: b.int(180, 260),
            protein_per_serving: `${b.int(8, 22)}.${b.int(0, 9)}`,
          },
          barcode: 'ean13',
          packs: [
            {
              key: 'box',
              name: 'Box of 12',
              quantity: 12,
              uses: ['sales', 'counting'],
              price: '27.90',
              barcode: true,
            },
            {
              key: 'case',
              name: 'Case',
              quantity: 8,
              inner: 'box',
              uses: ['purchasing', 'transfer'],
              barcode: true,
            },
          ],
          supply: [{ supplier: 'polder', pack: 'case', cost: '96.00', moq: 20, preferred: true }],
          stock: [{ warehouse: 'main', role: 'ambient', quantity: 96 * b.int(1, 12) }],
        })),
      });
    }
    while (b.variants < target) {
      const chilled = b.chance(0.4);
      const flavour = b.pick([
        'Thai green curry',
        'Chili sin carne',
        'Pasta bolognese',
        'Lentil dal',
        'Mushroom risotto',
      ]);
      b.product({
        name: `Fuel Meal Pot ${flavour}`,
        family: 'Food',
        attrs: {
          brand: 'Fuel Kitchen',
          category: 'Meal pots',
          storage: chilled ? 'Chilled' : 'Ambient',
          ...shelfLife(chilled ? b.int(14, 30) : b.int(180, 365)),
          allergens: b.some(EU_ALLERGENS, 1, 2),
        },
        variants: [
          {
            sku: `FM-${flavour.slice(0, 4).toUpperCase()}-${b.int(1000, 9999)}`,
            price: '4.95',
            attrs: { net_weight: `${b.pick([350, 400, 450])} g` },
            barcode: 'ean13',
            packs: [
              { key: 'case', name: 'Case', quantity: 8, uses: ['purchasing'], barcode: true },
            ],
            supply: [{ supplier: 'alba', pack: 'case', cost: '19.60', moq: 30, preferred: true }],
            stock: [
              {
                warehouse: 'main',
                role: chilled ? 'chilled' : 'ambient',
                quantity: 8 * b.int(2, 30),
              },
            ],
          },
        ],
      });
    }
  },
};

// 4. Cosmetics ----------------------------------------------------------------------------------

const DEPTHS = ['Fair', 'Light', 'Medium', 'Tan', 'Deep'];
const UNDERTONES = ['cool', 'neutral', 'warm', 'olive'];
const LIP_WORDS = [
  'Velvet',
  'Brick',
  'Rose',
  'Fig',
  'Cocoa',
  'Coral',
  'Plum',
  'Cherry',
  'Nude',
  'Berry',
];
const LIP_NOUNS = ['Kiss', 'Petal', 'Ember', 'Silk', 'Muse', 'Bloom', 'Dusk', 'Spice'];
const NAIL_WORDS = [
  'Midnight',
  'Sorbet',
  'Glacier',
  'Saffron',
  'Lagoon',
  'Orchid',
  'Moss',
  'Pearl',
  'Ruby',
  'Smoke',
];

const cosmetics: Persona = {
  key: 'cosmetics',
  shopName: 'Bench Lumen Skin',
  currency: 'EUR',
  timezone: 'Europe/Paris',
  activityShare: 0.15,
  shopify: true,
  brands: ['Lumen', 'Lumen Colour', 'Lumen Lab'],
  categories: [
    'Cleansers',
    'Serums',
    'Moisturisers',
    'Sun care',
    'Foundation',
    'Concealer',
    'Lipstick',
    'Nail polish',
    'Palettes',
    'Tools',
    'Gift sets',
  ],
  fields: [
    MULTI('skin_type', 'Skin type', 'product', [
      'Dry',
      'Oily',
      'Combination',
      'Sensitive',
      'Normal',
    ]),
    SELECT('finish', 'Finish', 'both', ['Matte', 'Satin', 'Dewy', 'Glossy', 'Shimmer']),
    SELECT('shade_family', 'Shade family', 'variant', DEPTHS),
    SELECT('undertone', 'Undertone', 'variant', ['Cool', 'Neutral', 'Warm', 'Olive']),
    MEASURE('volume', 'Volume', 'variant', 'volume', 'ml'),
    INT('spf', 'SPF', 'product', '0', '100'),
    INT('pao_months', 'Period after opening (months)', 'product', '1', '60'),
    DEC('active_percent', 'Active ingredient (%)', 'product', 2),
    BOOL('vegan', 'Vegan', 'product'),
    RICH('inci', 'Ingredients (INCI)', 'product'),
    MONEY('rrp', 'RRP', 'variant'),
  ],
  families: [
    {
      name: 'Skincare',
      fields: [
        'skin_type',
        'finish',
        'volume',
        'spf',
        'pao_months',
        'active_percent',
        'vegan',
        'inci',
      ],
      options: [{ name: 'Size', values: ['15 ml', '30 ml', '50 ml', '100 ml'] }],
    },
    {
      name: 'Make-up',
      fields: ['finish', 'shade_family', 'undertone', 'volume', 'pao_months', 'vegan', 'inci'],
      options: [{ name: 'Shade', values: [] }],
    },
    { name: 'Tools and accessories', fields: ['vegan'] },
    { name: 'Gift sets', fields: ['skin_type'] },
  ],
  warehouses: [
    {
      key: 'fc',
      name: 'Fulfilment centre',
      ownership: 'owned',
      city: 'Lyon',
      country: 'FR',
      locations: [
        ...shelving(['A', 'B', 'C', 'D', 'E'], 10, 2, 'pick'),
        area('Quarantine', 'QUA', 'quarantine', false),
        area('Returns inspection', 'RET', 'returns', false),
        area('Goods-in', 'IN', 'receiving', false),
      ],
    },
  ],
  suppliers: [
    { key: 'lys', name: 'Lys Cosmetic Lab', leadTimeDays: 35, city: 'Grasse', country: 'FR' },
    { key: 'pigment', name: 'Atelier Pigment SRL', leadTimeDays: 28, city: 'Milan', country: 'IT' },
    { key: 'tools', name: 'Nordic Pack Solutions', leadTimeDays: 14, city: 'Malmö', country: 'SE' },
  ],
  query: {
    search: 'velvet lipstick',
    select: { field: 'finish', values: ['Matte', 'Dewy'] },
    measurementSort: 'volume',
    range: { field: 'pao_months', from: '6', to: '12' },
    multi: { field: 'skin_type', value: 'Sensitive' },
    decimalSort: 'active_percent',
    fields: ['finish', 'shade_family', 'volume', 'rrp'],
    priceBelow: '15',
  },
  build(b) {
    const target = b.n(2000);
    // I1: lot_expiry tracking on skincare and complexion products (batch codes), about 2,000 lots.
    const minis: VariantRef[] = [];
    const caseOf = (cost: string, supplier: string): Pick<VariantInput, 'packs' | 'supply'> => ({
      packs: [
        {
          key: 'inner',
          name: 'Inner box',
          quantity: 6,
          uses: ['counting', 'transfer'],
          barcode: true,
        },
        {
          key: 'carton',
          name: 'Carton',
          quantity: 8,
          inner: 'inner',
          uses: ['purchasing'],
          barcode: true,
        },
      ],
      supply: [{ supplier, pack: 'carton', cost, moq: b.pick([2, 5, 10]), preferred: true }],
    });
    const skincare = [
      ['Cleanser', 'Cleansers'],
      ['Serum', 'Serums'],
      ['Moisturiser', 'Moisturisers'],
      ['Sun fluid', 'Sun care'],
      ['Eye cream', 'Moisturisers'],
      ['Toner', 'Cleansers'],
    ] as const;
    for (let i = 0; i < b.n(130); i++) {
      const [kind, category] = b.pick(skincare);
      const actives = b.pick([
        'Niacinamide',
        'Hyaluronic',
        'Vitamin C',
        'Retinal',
        'Ceramide',
        'Peptide',
        'Azelaic',
      ]);
      const sizes = b.some(['15 ml', '30 ml', '50 ml', '100 ml'], 1, 3);
      const refs = b.product({
        name: `Lumen ${actives} ${kind} ${pad(i + 1, 3)}`,
        family: 'Skincare',
        attrs: {
          brand: 'Lumen Lab',
          category,
          skin_type: b.some(['Dry', 'Oily', 'Combination', 'Sensitive', 'Normal'], 1, 3),
          finish: b.pick(['Matte', 'Satin', 'Dewy']),
          spf: kind === 'Sun fluid' ? b.pick([30, 50]) : 0,
          pao_months: b.pick([6, 12, 12, 24]),
          active_percent: `${b.int(1, 15)}.${pad(b.int(0, 99))}`,
          vegan: b.chance(0.7),
          inci: 'Aqua, Glycerin, Niacinamide, Sodium Hyaluronate, Panthenol, Phenoxyethanol.',
        },
        options: [{ name: 'Size', values: sizes }],
        variants: sizes.map((size) => {
          const price = b.money(14, 69, ['.00', '.90']);
          return {
            sku: `LUM-${pad(i + 1, 3)}-${size.replace(' ', '').toUpperCase()}`,
            options: [size],
            price,
            attrs: { volume: size, rrp: price },
            barcode: 'ean13',
            ...caseOf((Number(price) * 0.25 * 48).toFixed(2), 'lys'),
            stock: [{ warehouse: 'fc', role: 'pick', quantity: b.int(0, 150) }],
          };
        }),
      });
      for (const r of refs) if (r.options[0] === '15 ml') minis.push(r);
    }
    const shadeLines: Array<[string, string, number, () => string[]]> = [
      [
        'Foundation',
        'Foundation',
        12,
        () =>
          DEPTHS.flatMap((d, i) =>
            range(8).map((k) => `${(i + 1) * 100 + k * 10} ${d} ${UNDERTONES[k % 4]}`),
          ),
      ],
      [
        'Concealer',
        'Concealer',
        10,
        () => DEPTHS.flatMap((d, i) => range(5).map((k) => `${i + 1}.${k} ${d}`)).slice(0, 24),
      ],
      [
        'Lipstick',
        'Lipstick',
        14,
        () => LIP_WORDS.flatMap((w) => LIP_NOUNS.slice(0, 3).map((n) => `${w} ${n}`)),
      ],
      [
        'Nail polish',
        'Nail polish',
        6,
        () =>
          NAIL_WORDS.flatMap((w) =>
            ['Gloss', 'Cream', 'Shimmer', 'Jelly', 'Matte', 'Chrome'].map((f) => `${w} ${f}`),
          ),
      ],
    ];
    for (const [kind, category, count, shades] of shadeLines) {
      for (let i = 0; i < b.n(count) && b.variants < target - 120; i++) {
        const finish = b.pick(['Matte', 'Satin', 'Dewy', 'Glossy']);
        const list = shades();
        const code = `${kind.slice(0, 3).toUpperCase()}${pad(i + 1)}`;
        b.product({
          name: `Lumen ${b.pick(['Second Skin', 'Velvet', 'Glow', 'Long Wear', 'Soft Focus', 'Pure'])} ${kind}`,
          family: 'Make-up',
          attrs: {
            brand: 'Lumen Colour',
            category,
            finish,
            pao_months: b.pick([12, 18, 24]),
            vegan: b.chance(0.5),
            inci: 'Cyclopentasiloxane, Aqua, Titanium Dioxide, Iron Oxides, Dimethicone.',
          },
          options: [{ name: 'Shade', values: list }],
          variants: list.map((shade, k) => {
            const depth = DEPTHS[Math.min(4, Math.floor((k / list.length) * 5))]!;
            return {
              sku: `${code}-${pad(k + 1, 3)}`,
              options: [shade],
              price: kind === 'Nail polish' ? '9.90' : b.money(16, 42, ['.00', '.90']),
              attrs: {
                volume: kind === 'Lipstick' ? '4 ml' : kind === 'Nail polish' ? '11 ml' : '30 ml',
                ...(kind === 'Foundation' || kind === 'Concealer'
                  ? { shade_family: depth, undertone: b.pick(['Cool', 'Neutral', 'Warm', 'Olive']) }
                  : {}),
              },
              barcode: 'ean13',
              ...caseOf('120.00', 'pigment'),
              stock: [{ warehouse: 'fc', role: 'pick', quantity: b.int(0, 80) }],
            };
          }),
        });
      }
    }
    const giftSets = b.n(40);
    while (b.variants < target - giftSets) {
      const kind = b.pick([
        'Eyeshadow palette',
        'Brush set',
        'Sponge duo',
        'Make-up bag',
        'Cleansing balm',
      ]);
      const tool = kind !== 'Eyeshadow palette' && kind !== 'Cleansing balm';
      b.product({
        name: `Lumen ${kind} ${b.pick(['Dusk', 'Dawn', 'Nude', 'Smoky', 'Garden', 'Coast'])} ${b.int(10, 99)}`,
        family: tool ? 'Tools and accessories' : 'Make-up',
        attrs: { brand: 'Lumen', category: tool ? 'Tools' : 'Palettes', vegan: true },
        variants: [
          {
            sku: `LTL-${b.int(10000, 99999)}`,
            price: b.money(12, 49, ['.00', '.90']),
            barcode: 'ean13',
            supply: [
              {
                supplier: tool ? 'tools' : 'pigment',
                cost: b.money(3, 15),
                moq: 24,
                preferred: true,
              },
            ],
            stock: [{ warehouse: 'fc', role: 'pick', quantity: b.int(0, 60) }],
          },
        ],
      });
    }
    // Gift sets: three skincare minis each, as bundles (A36: "3 gift sets requested with 5 soaps").
    for (let i = 0; i < giftSets && minis.length >= 3; i++) {
      const [ref] = b.product({
        name: `Lumen Gift Set ${b.pick(['Glow', 'Calm', 'Renew', 'Travel', 'Discovery'])} ${pad(i + 1)}`,
        family: 'Gift sets',
        attrs: { brand: 'Lumen', category: 'Gift sets', skin_type: ['Normal'] },
        variants: [
          { sku: `GIFT-${pad(i + 1, 3)}`, price: b.money(29, 59, ['.00']), barcode: 'ean13' },
        ],
      });
      const parts = b.some(minis, 3, 3);
      b.bundle(
        ref!,
        parts.map((variant) => ({ variant, quantity: b.pick([1, 1, 2]) })),
      );
    }
  },
};

// 5. Spare parts --------------------------------------------------------------------------------

const PART_BRANDS = [
  'Kessler',
  'Nordtek',
  'Vantor',
  'Brixa',
  'Halden',
  'Orvin',
  'Tecnor',
  'Malvik',
  'Rautek',
  'Sendra',
  'Corvan',
  'Pellini',
];
const PART_SUPPLIERS: SupplierSpec[] = [
  {
    key: 'kessler',
    name: 'Kessler Industrial Supply',
    leadTimeDays: 5,
    city: 'Stuttgart',
    country: 'DE',
  },
  { key: 'nordtek', name: 'Nordtek Parts AB', leadTimeDays: 10, city: 'Gothenburg', country: 'SE' },
  { key: 'vantor', name: 'Vantor Components', leadTimeDays: 14, city: 'Lodz', country: 'PL' },
  { key: 'brixa', name: 'Brixa Hydraulics', leadTimeDays: 21, city: 'Brescia', country: 'IT' },
  { key: 'halden', name: 'Halden Electric', leadTimeDays: 7, city: 'Linz', country: 'AT' },
  { key: 'orvin', name: 'Orvin Seals & Gaskets', leadTimeDays: 12, city: 'Ghent', country: 'BE' },
  { key: 'tecnor', name: 'Tecnor Fasteners', leadTimeDays: 3, city: 'Eindhoven', country: 'NL' },
  {
    key: 'far',
    name: 'Far East Bearing Trading',
    leadTimeDays: 60,
    city: 'Rotterdam',
    country: 'NL',
  },
];

interface PartLine {
  family: string;
  category: string;
  weight: number;
  name: (b: CatalogBuilder) => {
    name: string;
    code: string;
    attrs: Attrs;
    variants?: Array<{ label: string; attrs: Attrs }>;
  };
  pack?: { name: string; quantity: number };
  price: [number, number];
  supplier: string;
  stock: [number, number];
}

const PART_LINES: PartLine[] = [
  {
    family: 'Bearings',
    category: 'Bearings',
    weight: 18,
    supplier: 'far',
    price: [4, 85],
    stock: [0, 40],
    name: (b) => {
      const series = b.pick(['60', '62', '63', '160', '22', '32']);
      const bore = b.int(0, 24);
      const seal = b.pick(['', '-ZZ', '-2RS', '-2RS C3', '-2Z']);
      const model = `${series}${pad(bore)}${seal}`;
      const inner = bore < 4 ? [10, 12, 15, 17][bore]! : bore * 5;
      return {
        name: `${b.pick(['Deep groove ball bearing', 'Angular contact bearing', 'Spherical roller bearing', 'Taper roller bearing'])} ${model}`,
        code: model.replace(/\s/g, ''),
        attrs: {
          inner_diameter: `${inner} mm`,
          outer_diameter: `${inner * 2 + b.int(4, 30)} mm`,
          width: `${b.int(6, 40)} mm`,
          material: 'Steel',
        },
      };
    },
    pack: { name: 'Box of 10', quantity: 10 },
  },
  {
    family: 'Filters',
    category: 'Filters',
    weight: 14,
    supplier: 'kessler',
    price: [6, 120],
    stock: [0, 30],
    name: (b) => {
      const kind = b.pick([
        'Oil filter',
        'Air filter',
        'Fuel filter',
        'Hydraulic return filter',
        'Cabin filter',
      ]);
      const code = `${kind
        .split(' ')
        .map((w) => w[0])
        .join('')
        .toUpperCase()}-${b.int(1000, 9999)}`;
      return {
        name: `${kind} ${code}`,
        code,
        attrs: { material: b.pick(['Steel', 'Polyamide', 'Aluminium']) },
      };
    },
  },
  {
    family: 'Belts and chains',
    category: 'Belts',
    weight: 8,
    supplier: 'nordtek',
    price: [5, 60],
    stock: [0, 25],
    name: (b) => {
      const profile = b.pick(['A', 'B', 'SPZ', 'SPA', 'XPZ']);
      const length = b.int(20, 120);
      return {
        name: `V-belt ${profile}${length}`,
        code: `${profile}${length}`,
        attrs: { width: `${b.pick([10, 13, 17])} mm` },
      };
    },
  },
  {
    family: 'Seals and O-rings',
    category: 'Seals',
    weight: 16,
    supplier: 'orvin',
    price: [0.2, 9],
    stock: [50, 2000],
    name: (b) => {
      const inner = b.int(3, 120);
      const cs = b.pick(['1.5', '2', '2.5', '3', '3.5', '5']);
      const material = b.pick(['NBR', 'FKM', 'EPDM', 'Silicone']);
      return {
        name: `O-ring ${inner} × ${cs} mm ${material}`,
        code: `OR-${inner}X${cs}-${material}`,
        attrs: {
          inner_diameter: `${inner} mm`,
          width: `${cs} mm`,
          material: material === 'Silicone' ? 'NBR' : material,
        },
      };
    },
    pack: { name: 'Bag of 50', quantity: 50 },
  },
  {
    family: 'Fasteners',
    category: 'Fasteners',
    weight: 14,
    supplier: 'tecnor',
    price: [0.05, 2],
    stock: [100, 5000],
    name: (b) => {
      const thread = b.pick(['M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M16']);
      const kind = b.pick([
        'Hex bolt',
        'Socket head screw',
        'Hex nut',
        'Washer',
        'Countersunk screw',
      ]);
      const length =
        kind === 'Hex nut' || kind === 'Washer'
          ? ''
          : ` × ${b.pick([10, 16, 20, 25, 30, 40, 50, 60, 80])}`;
      const grade = b.pick(['8.8 zinc', 'A2 stainless', 'A4 stainless', '10.9 black']);
      return {
        name: `${kind} ${thread}${length} ${grade}`,
        code: `${kind
          .split(' ')
          .map((w) => w[0])
          .join('')}-${thread}${length.replace(/[^0-9]/g, '')}-${grade.slice(0, 2).toUpperCase()}`,
        attrs: { thread, material: grade.includes('stainless') ? 'Stainless steel' : 'Steel' },
      };
    },
    pack: { name: 'Box of 100', quantity: 100 },
  },
  {
    family: 'Electrical',
    category: 'Electrical',
    weight: 12,
    supplier: 'halden',
    price: [3, 220],
    stock: [0, 20],
    name: (b) => {
      const kind = b.pick([
        'Contactor',
        'Relay',
        'Proximity sensor',
        'Limit switch',
        'Fuse holder',
        'Motor starter',
      ]);
      const volts = b.pick([12, 24, 110, 230, 400]);
      const code = `${kind.slice(0, 2).toUpperCase()}${volts}-${b.int(100, 999)}`;
      return { name: `${kind} ${volts} V ${code}`, code, attrs: { voltage: volts } };
    },
  },
  {
    family: 'Pumps',
    category: 'Pumps',
    weight: 5,
    supplier: 'brixa',
    price: [45, 900],
    stock: [0, 6],
    // I1: about 10% of the shop's variants (pumps, motors, controllers) are serial-tracked.
    name: (b) => {
      const kind = b.pick(['Water pump', 'Gear pump', 'Coolant pump', 'Vacuum pump']);
      const code = `${kind.split(' ')[0]!.slice(0, 2).toUpperCase()}P-${b.int(100, 999)}`;
      return { name: `${kind} ${code}`, code, attrs: { voltage: b.pick([12, 24, 230]) } };
    },
  },
  {
    family: 'Brakes',
    category: 'Brakes',
    weight: 7,
    supplier: 'vantor',
    price: [12, 180],
    stock: [0, 16],
    name: (b) => {
      const kind = b.pick([
        'Brake pad set front',
        'Brake pad set rear',
        'Brake disc',
        'Brake caliper',
      ]);
      const code = `BP-${b.int(1000, 9999)}`;
      return { name: `${kind} ${code}`, code, attrs: {} };
    },
  },
  {
    family: 'Hydraulics',
    category: 'Hydraulics',
    weight: 9,
    supplier: 'brixa',
    price: [6, 140],
    stock: [0, 30],
    name: (b) => {
      const size = b.pick(['1/4', '3/8', '1/2', '3/4', '1']);
      const kind = b.pick([
        'Hydraulic hose 2SN',
        'Quick coupling ISO-A',
        'Ball valve',
        'Pressure gauge',
      ]);
      const code = `HY-${kind.slice(0, 3).toUpperCase()}-${size.replace('/', '')}-${b.int(10, 99)}`;
      return {
        name: `${kind} ${size} in`,
        code,
        attrs: { thread: b.pick(['G1/4', 'G3/8', 'G1/2']) },
        variants: kind.startsWith('Hydraulic hose')
          ? ['0.5 m', '1 m', '1.5 m', '2 m', '3 m'].map((label) => ({ label, attrs: {} }))
          : undefined,
      };
    },
  },
  {
    family: 'Pneumatics',
    category: 'Pneumatics',
    weight: 7,
    supplier: 'nordtek',
    price: [8, 260],
    stock: [0, 20],
    name: (b) => {
      const kind = b.pick([
        'Pneumatic cylinder',
        'Solenoid valve 5/2',
        'Air regulator',
        'Push-in fitting',
      ]);
      const code = `PN-${b.int(1000, 9999)}`;
      return {
        name: `${kind} ${code}`,
        code,
        attrs: { thread: b.pick(['G1/4', 'G3/8', 'M6', 'M8']) },
        variants:
          kind === 'Pneumatic cylinder'
            ? ['25 mm stroke', '50 mm stroke', '100 mm stroke', '160 mm stroke'].map((label) => ({
                label,
                attrs: {},
              }))
            : undefined,
      };
    },
  },
];

const parts: Persona = {
  key: 'parts',
  shopName: 'Bench Partline Supply',
  currency: 'EUR',
  timezone: 'Europe/Vienna',
  activityShare: 0.25,
  shopify: false,
  brands: PART_BRANDS,
  categories: [...new Set(PART_LINES.map((l) => l.category))],
  fields: [
    TEXT('manufacturer_number', 'Manufacturer number', 'variant', 100),
    TEXT('oem_numbers', 'OEM cross-references', 'variant', 500),
    {
      key: 'replaces',
      label: 'Replaces',
      type: 'relationship',
      level: 'variant',
      config: { targetType: 'variant', relationKind: 'replaces', maxItems: 50 },
    },
    SELECT('condition', 'Condition', 'variant', ['New', 'Used', 'Refurbished']),
    SELECT('material', 'Material', 'both', [
      'Steel',
      'Stainless steel',
      'Brass',
      'NBR',
      'FKM',
      'EPDM',
      'Polyamide',
      'Aluminium',
    ]),
    MEASURE('inner_diameter', 'Inner diameter', 'variant', 'length', 'mm'),
    MEASURE('outer_diameter', 'Outer diameter', 'variant', 'length', 'mm'),
    MEASURE('width', 'Width', 'variant', 'length', 'mm'),
    INT('voltage', 'Voltage (V)', 'variant', '0', '1000'),
    SELECT('thread', 'Thread', 'variant', [
      'M4',
      'M5',
      'M6',
      'M8',
      'M10',
      'M12',
      'M16',
      'G1/4',
      'G3/8',
      'G1/2',
    ]),
    TEXT('customs_code', 'Customs code', 'product', 12),
    SELECT('origin', 'Country of origin', 'product', [
      'DE',
      'IT',
      'SE',
      'PL',
      'CN',
      'JP',
      'US',
      'CZ',
    ]),
    DEC('max_pressure_bar', 'Max pressure (bar)', 'variant', 1),
    MULTI('approvals', 'Approvals', 'product', ['CE', 'UKCA', 'ATEX', 'RoHS', 'REACH', 'UL']),
    BOOL('hazardous', 'Hazardous goods', 'product'),
    MONEY('rrp', 'List price', 'variant'),
  ],
  families: [
    {
      name: 'Spare parts',
      templateKey: 'spare_parts',
      fields: ['manufacturer_number', 'oem_numbers', 'replaces', 'condition'],
      required: ['condition'],
    },
    ...[...new Set(PART_LINES.map((l) => l.family))].map((name) => ({
      name,
      fields: [
        'manufacturer_number',
        'oem_numbers',
        'replaces',
        'condition',
        'material',
        'inner_diameter',
        'outer_diameter',
        'width',
        'voltage',
        'thread',
        'customs_code',
        'origin',
        'max_pressure_bar',
        'approvals',
      ],
      required: ['condition'],
    })),
  ],
  warehouses: [
    {
      key: 'main',
      name: 'Main warehouse',
      ownership: 'owned',
      city: 'Graz',
      country: 'AT',
      locations: [
        ...shelving(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], 10, 4, 'bin'),
        {
          name: 'Bulk store',
          code: 'BULK',
          children: range(20).map((p) => area(`Pallet place ${pad(p)}`, `P${pad(p)}`, 'bulk')),
        },
        area('Goods-in', 'IN', 'receiving', false),
        area('Dispatch', 'OUT', 'dispatch', false),
      ],
    },
    {
      key: 'depot',
      name: 'Branch depot',
      ownership: 'rented',
      city: 'Linz',
      country: 'AT',
      locations: [...shelving(['A', 'B'], 10, 4, 'bin'), area('Counter', 'CTR', 'counter')],
    },
  ],
  suppliers: PART_SUPPLIERS,
  query: {
    search: 'ball bearing',
    select: { field: 'material', values: ['Stainless steel', 'FKM'] },
    measurementSort: 'inner_diameter',
    range: { field: 'voltage', from: '12', to: '110' },
    multi: { field: 'approvals', value: 'ATEX' },
    decimalSort: 'max_pressure_bar',
    fields: ['manufacturer_number', 'material', 'inner_diameter', 'rrp'],
    priceBelow: '1',
  },
  build(b) {
    const target = b.n(20000);
    const byCategory = new Map<string, VariantRef[]>();
    const usedCodes = new Set<string>();
    const supplierKeys = PART_SUPPLIERS.map((s) => s.key);
    while (b.variants < target) {
      const line = weighted(b, PART_LINES, (l) => l.weight)!;
      const made = line.name(b);
      const brand = b.pick(PART_BRANDS);
      let code = `${brand.slice(0, 3).toUpperCase()}-${made.code}`;
      while (usedCodes.has(code)) code = `${code}-${b.int(1, 9)}`;
      usedCodes.add(code);
      const price = (line.price[0] + b.rand() * (line.price[1] - line.price[0])).toFixed(2);
      const options = made.variants;
      const supplier = b.chance(0.7) ? line.supplier : b.pick(supplierKeys);
      const second = b.chance(0.3) ? b.pick(supplierKeys.filter((k) => k !== supplier)) : null;
      const gtin = b.chance(0.6);
      const refs = b.product({
        name: `${brand} ${made.name}`,
        family: line.family,
        attrs: {
          brand,
          category: line.category,
          customs_code: String(b.int(84000000, 85999999)),
          origin: b.pick(['DE', 'IT', 'SE', 'PL', 'CN', 'JP', 'US', 'CZ']),
          ...(b.chance(0.3)
            ? { approvals: b.some(['CE', 'UKCA', 'ATEX', 'RoHS', 'REACH', 'UL'], 1, 3) }
            : {}),
          hazardous: false,
        },
        ...(options ? { options: [{ name: 'Version', values: options.map((o) => o.label) }] } : {}),
        variants: (options ?? [{ label: '', attrs: {} }]).map((o, i) => {
          const sku = options ? `${code}-${i + 1}` : code;
          const unitPrice = (Number(price) * (1 + i * 0.4)).toFixed(2);
          const cost = (Number(unitPrice) * 0.55 * (line.pack?.quantity ?? 1)).toFixed(2);
          return {
            sku,
            ...(options ? { options: [o.label] } : {}),
            price: unitPrice,
            attrs: {
              ...made.attrs,
              ...o.attrs,
              manufacturer_number: `${made.code}${options ? `-${i + 1}` : ''}`,
              ...(b.chance(0.4)
                ? {
                    oem_numbers: `${b.int(1000, 9999)}-${b.int(100, 999)}; ${b.int(10, 99)}.${b.int(1000, 9999)}`,
                  }
                : {}),
              condition: b.chance(0.95) ? 'New' : b.pick(['Used', 'Refurbished']),
              ...(line.family === 'Hydraulics' || line.family === 'Pneumatics'
                ? { max_pressure_bar: `${b.int(6, 400)}.0` }
                : {}),
              rrp: unitPrice,
            },
            barcode: gtin ? 'ean13' : sku,
            weight: `${b.int(5, 4000)} g`,
            ...(line.pack
              ? {
                  packs: [
                    {
                      key: 'pack',
                      name: line.pack.name,
                      quantity: line.pack.quantity,
                      uses: ['purchasing', 'counting', 'sales'] as PackUse[],
                    },
                  ],
                }
              : {}),
            supply: [
              {
                supplier,
                ...(line.pack ? { pack: 'pack' } : {}),
                cost,
                moq: b.pick([1, 5, 10, 25, 50]),
                sku: `${supplier.slice(0, 2).toUpperCase()}${b.int(100000, 999999)}`,
                preferred: true,
              },
              ...(second
                ? [
                    {
                      supplier: second,
                      cost: (Number(cost) * 1.08).toFixed(2),
                      moq: b.pick([1, 10, 100]),
                      sku: `${second.slice(0, 2).toUpperCase()}${b.int(100000, 999999)}`,
                    },
                  ]
                : []),
            ],
            stock: [
              ...(b.chance(0.65)
                ? [
                    {
                      warehouse: 'main',
                      role: b.chance(0.05) ? 'bulk' : 'bin',
                      quantity: b.int(line.stock[0], line.stock[1]),
                    },
                  ]
                : []),
              ...(b.chance(0.25)
                ? [
                    {
                      warehouse: 'depot',
                      role: 'bin',
                      quantity: b.int(line.stock[0], Math.ceil(line.stock[1] / 3)),
                    },
                  ]
                : []),
            ],
          };
        }),
      });
      // About one part in eight replaces an older part of the same kind.
      const seen = byCategory.get(line.category) ?? [];
      if (seen.length > 20 && b.chance(0.12)) {
        for (const ref of refs) b.relate('replaces', ref, b.pick(seen));
      }
      seen.push(...refs);
      byCategory.set(line.category, seen);
    }
  },
};

// 6. Fashion brand ------------------------------------------------------------------------------

const FASHION_COLOURS = [
  'Black',
  'Ivory',
  'Camel',
  'Navy',
  'Bordeaux',
  'Sage',
  'Ecru',
  'Chocolate',
  'Slate',
  'Rust',
];
const fashion: Persona = {
  key: 'fashion',
  shopName: 'Bench Maison Verre',
  currency: 'EUR',
  timezone: 'Europe/Rome',
  activityShare: 0.15,
  shopify: true,
  brands: ['Maison Verre', 'Verre Atelier', 'Verre Optique'],
  categories: [
    'Dresses',
    'Shirts',
    'Trousers',
    'Knitwear',
    'Coats',
    'Sunglasses',
    'Optical frames',
    'Bags',
    'Watches',
    'Rings',
    'Necklaces',
    'Earrings',
    'Gift boxes',
  ],
  fields: [
    SELECT('material', 'Material', 'both', [
      'Silk',
      'Linen',
      'Wool',
      'Cashmere',
      'Cotton poplin',
      'Leather',
      'Acetate',
      'Titanium',
      'Recycled nylon',
    ]),
    SELECT('collection', 'Collection', 'product', ['Permanent', 'SS26', 'AW26', 'Resort 27']),
    RICH('care_instructions', 'Care instructions', 'product'),
    SELECT('fit', 'Fit', 'product', ['Slim', 'Regular', 'Relaxed', 'Oversized']),
    SELECT('metal', 'Metal', 'variant', [
      '925 silver',
      '18k gold plated',
      '14k gold',
      'Stainless steel',
    ]),
    SELECT('stone', 'Stone', 'product', [
      'None',
      'Pearl',
      'Zirconia',
      'Onyx',
      'Moonstone',
      'Garnet',
    ]),
    SELECT('lens', 'Lens', 'variant', ['Polarised', 'Gradient', 'Mirror', 'Clear optical']),
    MEASURE('case_diameter', 'Case diameter', 'variant', 'length', 'mm'),
    MEASURE('frame_width', 'Frame width', 'product', 'length', 'mm'),
    INT('water_resistance_m', 'Water resistance (m)', 'product', '0', '1000'),
    SELECT('movement', 'Movement', 'product', ['Quartz', 'Automatic', 'Mechanical']),
    SELECT('made_in', 'Made in', 'product', ['Italy', 'Portugal', 'France', 'Romania', 'Spain']),
    DEC('heel_cm', 'Strap drop (cm)', 'product', 1),
    MULTI('occasion', 'Occasion', 'product', ['Everyday', 'Work', 'Evening', 'Travel', 'Ceremony']),
    BOOL('limited_edition', 'Limited edition', 'product'),
    MONEY('rrp', 'RRP', 'variant'),
  ],
  families: [
    {
      name: 'Clothing',
      templateKey: 'apparel',
      fields: ['material', 'collection', 'care_instructions', 'fit', 'made_in', 'occasion'],
      options: [
        { name: 'Size', values: ['34', '36', '38', '40', '42', '44'] },
        { name: 'Colour', values: FASHION_COLOURS.slice(0, 5) },
      ],
    },
    { name: 'Eyewear', fields: ['material', 'collection', 'lens', 'frame_width', 'made_in'] },
    { name: 'Bags', fields: ['material', 'collection', 'heel_cm', 'made_in', 'occasion'] },
    // I1: watches become serial-tracked (each unit's movement number).
    {
      name: 'Watches',
      fields: [
        'material',
        'collection',
        'case_diameter',
        'water_resistance_m',
        'movement',
        'limited_edition',
      ],
    },
    // I1: atelier pieces become one of a kind (D5).
    { name: 'Jewellery', fields: ['metal', 'stone', 'collection', 'occasion', 'limited_edition'] },
    { name: 'Gift boxes', fields: ['occasion'] },
  ],
  warehouses: [
    {
      key: 'warehouse',
      name: 'Central warehouse',
      ownership: 'owned',
      city: 'Bologna',
      country: 'IT',
      locations: [
        ...shelving(['A', 'B', 'C', 'D'], 8, 3, 'pick'),
        {
          name: 'Secure room',
          code: 'SEC',
          children: range(8).map((s) => area(`Safe drawer ${s}`, `SEC-${s}`, 'secure')),
        },
        area('Returns', 'RET', 'returns', false),
        area('Goods-in', 'IN', 'receiving', false),
      ],
    },
    {
      key: 'store',
      name: 'Flagship store',
      ownership: 'owned',
      city: 'Milan',
      country: 'IT',
      locations: [
        {
          name: 'Shop floor',
          code: 'FLOOR',
          children: range(8).map((r) => area(`Display ${r}`, `D${r}`, 'floor')),
        },
        {
          name: 'Stockroom',
          code: 'STOCK',
          children: range(6).map((s) => area(`Shelf ${s}`, `S${s}`, 'stockroom')),
        },
        area('Jewellery case', 'JC', 'secure'),
      ],
    },
    {
      key: 'partner',
      name: 'Partner fulfilment',
      ownership: 'third_party',
      operatorName: 'Partner Logistics BV',
      city: 'Venlo',
      country: 'NL',
      locations: [
        area('Inbound', 'P-IN', 'receiving', false),
        {
          name: 'Pick zone',
          code: 'P-PICK',
          children: range(12).map((z) => area(`Zone ${pad(z)}`, `P-${pad(z)}`, 'pick3pl')),
        },
      ],
    },
  ],
  suppliers: [
    { key: 'como', name: 'Como Silk Atelier', leadTimeDays: 40, city: 'Como', country: 'IT' },
    {
      key: 'leather',
      name: 'Ubrique Leather Works',
      leadTimeDays: 35,
      city: 'Ubrique',
      country: 'ES',
    },
    { key: 'optic', name: 'Cadore Optical', leadTimeDays: 30, city: 'Belluno', country: 'IT' },
    {
      key: 'time',
      name: 'Jura Timepieces SA',
      leadTimeDays: 50,
      city: 'La Chaux-de-Fonds',
      country: 'CH',
    },
    { key: 'gold', name: 'Valenza Goldsmiths', leadTimeDays: 25, city: 'Valenza', country: 'IT' },
  ],
  query: {
    search: 'silk dress',
    select: { field: 'collection', values: ['SS26', 'Resort 27'] },
    measurementSort: 'case_diameter',
    range: { field: 'water_resistance_m', from: '30', to: '100' },
    multi: { field: 'occasion', value: 'Evening' },
    decimalSort: 'heel_cm',
    fields: ['material', 'collection', 'metal', 'rrp'],
    priceBelow: '80',
  },
  build(b) {
    const target = b.n(4000);
    const stockFashion = (high: number): StockInput[] => [
      { warehouse: 'warehouse', role: 'pick', quantity: b.int(0, high) },
      ...(b.chance(0.25)
        ? [{ warehouse: 'store', role: b.pick(['floor', 'stockroom']), quantity: b.int(1, 4) }]
        : []),
      ...(b.chance(0.4)
        ? [{ warehouse: 'partner', role: 'pick3pl', quantity: b.int(0, high) }]
        : []),
    ];
    let style = 1;
    const jewellery: VariantRef[] = [];
    const lines: Array<[string, string, number]> = [
      ['Eyewear', 'Sunglasses', 0.06],
      ['Eyewear', 'Optical frames', 0.03],
      ['Bags', 'Bags', 0.06],
      ['Watches', 'Watches', 0.04],
      ['Jewellery', 'Rings', 0.06],
      ['Jewellery', 'Necklaces', 0.05],
      ['Jewellery', 'Earrings', 0.04],
    ];
    const clothes = ['Dresses', 'Shirts', 'Trousers', 'Knitwear', 'Coats'];
    while (b.variants < target - b.n(50)) {
      // The rest of the draw, about two thirds, is clothing.
      const line = weighted(b, [...lines, null], (l) =>
        l ? l[2] : 1 - lines.reduce((s, x) => s + x[2], 0),
      );
      const code = `MV${pad(style++, 4)}`;
      const collection = b.pick(['Permanent', 'SS26', 'AW26', 'Resort 27']);
      if (!line) {
        const category = b.pick(clothes);
        const sizes = ['34', '36', '38', '40', '42', '44', '46'].slice(0, b.int(4, 7));
        const colours = b.some(FASHION_COLOURS, 1, 4);
        const price = b.money(89, 590, ['.00']);
        const noun = {
          Dresses: 'dress',
          Shirts: 'shirt',
          Trousers: 'trousers',
          Knitwear: 'jumper',
          Coats: 'coat',
        }[category]!;
        const material = b.pick(['Silk', 'Linen', 'Wool', 'Cashmere', 'Cotton poplin']);
        b.product({
          name: `${b.pick(['Alba', 'Livia', 'Nera', 'Orsola', 'Vela', 'Clio', 'Rea', 'Ines'])} ${material.toLowerCase()} ${noun}`,
          family: 'Clothing',
          tags: collection === 'Resort 27' ? ['new'] : [],
          attrs: {
            brand: 'Maison Verre',
            category,
            material,
            collection,
            care_instructions: 'Dry clean only.',
            fit: b.pick(['Slim', 'Regular', 'Relaxed', 'Oversized']),
            made_in: b.pick(['Italy', 'Portugal', 'Romania']),
            occasion: b.some(['Everyday', 'Work', 'Evening', 'Travel', 'Ceremony'], 1, 2),
          },
          options: [
            { name: 'Size', values: sizes },
            { name: 'Colour', values: colours },
          ],
          variants: colours.flatMap((colour) =>
            sizes.map((size) => ({
              sku: `${code}-${colour.slice(0, 3).toUpperCase()}-${size}`,
              options: [size, colour],
              price,
              attrs: { rrp: price },
              barcode: 'ean13',
              supply: [
                {
                  supplier: 'como',
                  cost: (Number(price) * 0.3).toFixed(2),
                  moq: 10,
                  preferred: true,
                },
              ],
              stock: stockFashion(12),
            })),
          ),
        });
        continue;
      }
      const [family, category] = line;
      if (family === 'Eyewear') {
        const colours = b.some(['Tortoise', 'Black', 'Honey', 'Crystal', 'Gold', 'Gunmetal'], 2, 4);
        const sunglasses = category === 'Sunglasses';
        const price = b.money(140, 360, ['.00']);
        b.product({
          name: `${b.pick(['Riva', 'Sole', 'Lido', 'Brera', 'Capri'])} ${sunglasses ? 'sunglasses' : 'optical frame'} ${code}`,
          family,
          attrs: {
            brand: 'Verre Optique',
            category,
            material: b.pick(['Acetate', 'Titanium']),
            collection,
            frame_width: `${b.int(128, 148)} mm`,
            made_in: 'Italy',
          },
          options: [{ name: 'Frame', values: colours }],
          variants: colours.map((colour) => ({
            sku: `${code}-${colour.slice(0, 3).toUpperCase()}`,
            options: [colour],
            price,
            attrs: {
              lens: sunglasses ? b.pick(['Polarised', 'Gradient', 'Mirror']) : 'Clear optical',
              rrp: price,
            },
            barcode: 'ean13',
            supply: [
              {
                supplier: 'optic',
                cost: (Number(price) * 0.28).toFixed(2),
                moq: 6,
                preferred: true,
              },
            ],
            stock: stockFashion(15),
          })),
        });
      } else if (family === 'Bags') {
        const colours = b.some(FASHION_COLOURS, 2, 4);
        const price = b.money(190, 890, ['.00']);
        b.product({
          name: `${b.pick(['Mira', 'Tessa', 'Duna', 'Nola'])} ${b.pick(['tote', 'shoulder bag', 'clutch', 'crossbody', 'weekender'])}`,
          family,
          attrs: {
            brand: 'Maison Verre',
            category,
            material: 'Leather',
            collection,
            heel_cm: `${b.int(10, 60)}.${b.int(0, 9)}`,
            made_in: b.pick(['Italy', 'Spain']),
            occasion: b.some(['Everyday', 'Work', 'Evening', 'Travel'], 1, 2),
          },
          options: [{ name: 'Colour', values: colours }],
          variants: colours.map((colour) => ({
            sku: `${code}-${colour.slice(0, 3).toUpperCase()}`,
            options: [colour],
            price,
            attrs: { rrp: price },
            barcode: 'ean13',
            supply: [
              {
                supplier: 'leather',
                cost: (Number(price) * 0.33).toFixed(2),
                moq: 4,
                preferred: true,
              },
            ],
            stock: stockFashion(10),
          })),
        });
      } else if (family === 'Watches') {
        const dials = b.some(
          ['Black dial', 'Silver dial', 'Blue dial', 'Green dial', 'Champagne dial'],
          2,
          4,
        );
        const price = b.money(390, 2900, ['.00']);
        const diameter = b.pick([34, 36, 38, 40, 42]);
        b.product({
          name: `Verre ${b.pick(['Meridiana', 'Lanterna', 'Astra', 'Corsa'])} ${diameter} mm`,
          family,
          attrs: {
            brand: 'Maison Verre',
            category,
            material: b.pick(['Titanium', 'Leather']),
            collection,
            water_resistance_m: b.pick([30, 50, 100, 200]),
            movement: b.pick(['Quartz', 'Automatic', 'Mechanical']),
            limited_edition: b.chance(0.15),
          },
          options: [{ name: 'Dial', values: dials }],
          variants: dials.map((dial) => ({
            sku: `${code}-${dial.slice(0, 3).toUpperCase()}`,
            options: [dial],
            price,
            attrs: { case_diameter: `${diameter} mm`, rrp: price },
            barcode: 'ean13',
            supply: [
              { supplier: 'time', cost: (Number(price) * 0.4).toFixed(2), moq: 2, preferred: true },
            ],
            stock: [
              { warehouse: 'warehouse', role: 'secure', quantity: b.int(0, 6) },
              ...(b.chance(0.5)
                ? [{ warehouse: 'store', role: 'secure', quantity: b.int(1, 2) }]
                : []),
            ],
          })),
        });
      } else {
        const metals = b.some(['925 silver', '18k gold plated', '14k gold'], 1, 2);
        const sizes = category === 'Rings' ? ['50', '52', '54', '56', '58', '60'] : null;
        const price = b.money(65, 1200, ['.00']);
        const refs = b.product({
          name: `${b.pick(['Luna', 'Onda', 'Stella', 'Fiore', 'Goccia', 'Nodo'])} ${category.toLowerCase().replace(/s$/, '')} ${code}`,
          family: 'Jewellery',
          attrs: {
            brand: b.pick(['Maison Verre', 'Verre Atelier']),
            category,
            stone: b.pick(['None', 'Pearl', 'Zirconia', 'Onyx', 'Moonstone', 'Garnet']),
            collection,
            occasion: b.some(['Everyday', 'Evening', 'Ceremony'], 1, 2),
            limited_edition: b.chance(0.1),
          },
          options: sizes
            ? [
                { name: 'Metal', values: metals },
                { name: 'Size', values: sizes },
              ]
            : [{ name: 'Metal', values: metals }],
          variants: metals.flatMap((metal) =>
            (sizes ?? ['']).map((size) => ({
              sku: `${code}-${metal.slice(0, 2).toUpperCase()}${size ? `-${size}` : ''}`,
              options: size ? [metal, size] : [metal],
              price: metal === '14k gold' ? (Number(price) * 3).toFixed(2) : price,
              attrs: { metal, rrp: price },
              barcode: 'ean13',
              supply: [
                {
                  supplier: 'gold',
                  cost: (Number(price) * 0.35).toFixed(2),
                  moq: 3,
                  preferred: true,
                },
              ],
              stock: [
                { warehouse: 'warehouse', role: 'secure', quantity: b.int(0, 8) },
                ...(b.chance(0.3) ? [{ warehouse: 'store', role: 'secure', quantity: 1 }] : []),
              ],
            })),
          ),
        });
        if (category !== 'Rings') jewellery.push(...refs);
      }
    }
    // Gift boxes: a necklace with matching earrings, as bundles.
    for (let i = 0; i < b.n(50) && jewellery.length >= 2; i++) {
      const [ref] = b.product({
        name: `Gift box ${pad(i + 1, 3)}`,
        family: 'Gift boxes',
        attrs: { brand: 'Maison Verre', category: 'Gift boxes', occasion: ['Ceremony'] },
        variants: [
          { sku: `MVG-${pad(i + 1, 3)}`, price: b.money(150, 900, ['.00']), barcode: 'ean13' },
        ],
      });
      b.bundle(
        ref!,
        b.some(jewellery, 2, 2).map((variant) => ({ variant, quantity: 1 })),
      );
    }
  },
};

export const PERSONAS: Persona[] = [owner, sports, food, cosmetics, parts, fashion];
