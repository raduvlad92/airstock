/**
 * Fills a staging shop for a ChatGPT run (Phase 2 plan Section 7.4, milestone I7): sealed
 * Pokémon TCG products in nested packs, LEGO sets, one-of-a-kind graded cards, lot-tracked food,
 * one warehouse with shelves A1 and B2, three suppliers with supplier items, reorder rules that
 * leave three items low, fulfilled and reserved orders, and cost history. The prompts and their
 * expected answers are in docs/chatgpt-runs/phase-2.json and docs/phase-2-status.md Section 6;
 * apps/worker/test/chatgpt-run.test.ts runs this script, the prompts, and the harness end to end.
 *
 *   AIRSTOCK_TOKEN=ask_… pnpm chatgpt-run:shop --shop <shop ID> --phase opening|later|all \
 *     [--base https://airstock.deletecookies.dev]
 *
 * - `opening`: the catalog, warehouse, suppliers, and opening stock at the older costs.
 * - `later`: newer deliveries at higher costs, the orders, a move, and the reorder rules. Run it
 *   two minutes or more after `opening`: it values the stock at the last whole minute before it
 *   starts (refusing if the opening step was still running then) and prints that moment and both
 *   values for prompt 8.
 * - `all`: both, waiting for the next whole minute in between (a dry-run shop).
 *
 * The shop is new and empty (created in the dashboard; its ID is in the address /app/shops/<ID>).
 * The token is an API credential of that shop with every scope, read from the environment and
 * never printed. Only the REST API is used: no database access. Each command carries an
 * idempotency key made from the shop and the step, so running a phase again with the same
 * credential repeats nothing.
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

type Json = Record<string, unknown>;

/** Where to seed: an Airstock base URL, the shop, and an API credential's token. */
export interface SeedTarget {
  base: string;
  shopId: string;
  token: string;
  /** Defaults to the global fetch; tests pass the app's own handler. */
  fetch?: (request: Request) => Promise<Response>;
}

export type SeedPhase = 'opening' | 'later' | 'all';

/** The REST calls of one run, each command with an idempotency key made from the shop and step. */
function client(target: SeedTarget) {
  const base = `${target.base.replace(/\/$/, '')}/api/v1/shops/${target.shopId}`;
  const send = target.fetch ?? ((request: Request) => fetch(request));
  async function api<T = Json>(method: string, path: string, body?: unknown, step?: string) {
    for (let attempt = 0; ; attempt++) {
      const res = await send(
        new Request(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${target.token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(method === 'POST'
              ? { 'idempotency-key': `chatgpt-run:${target.shopId}:${step ?? path}` }
              : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      const text = await res.text();
      if ((res.status === 429 || res.status === 503) && attempt < 8) {
        const wait = Number(res.headers.get('retry-after'));
        await new Promise((r) => setTimeout(r, (wait > 0 ? wait : attempt + 1) * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`${method} ${path} (${step ?? ''}): ${res.status} ${text}`);
      return (text ? JSON.parse(text) : {}) as T;
    }
  }
  return {
    post: <T = Json>(path: string, body: unknown, step: string) => api<T>('POST', path, body, step),
    get: <T = Json>(path: string) => api<T>('GET', path),
  };
}
type Client = ReturnType<typeof client>;

/** An EAN-13 in the restricted-circulation range (prefix 20), so it is no real product's code. */
function ean13(n: number): string {
  const body = `20${String(n).padStart(10, '0')}`;
  const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

// The catalog -----------------------------------------------------------------------------------

interface Pack {
  name: string;
  quantity: string;
  innerPack?: string;
  uses: string[];
  barcode?: string;
}
interface Item {
  key: string;
  name: string;
  sku: string;
  price: string;
  family?: string;
  tags?: string[];
  fields?: Json;
  barcode: string;
  packs?: Pack[];
  lots?: boolean;
  supplier: 'tcg' | 'lego' | 'food';
  supplierSku: string;
  /** The pack the supplier sells, and its price per pack. */
  supplierPack?: string;
  lastCost: string;
}

const SUPPLIERS = {
  tcg: {
    name: 'Nordwind TCG Distribution',
    contactName: 'Order desk',
    email: 'orders@nordwind-tcg.example',
    currency: 'EUR',
    leadTimeDays: 7,
    notes: 'The Pokémon distributor. Sells sealed product by the case.',
  },
  lego: {
    name: 'Brickhouse Wholesale',
    contactName: 'Sales',
    email: 'sales@brickhouse.example',
    currency: 'EUR',
    leadTimeDays: 10,
  },
  food: {
    name: 'Fresh Fuel Foods',
    contactName: 'Customer service',
    email: 'trade@freshfuel.example',
    currency: 'EUR',
    leadTimeDays: 5,
  },
} as const;

const ITEMS: Item[] = [
  {
    key: 'ssp_bb',
    name: 'Pokémon TCG Surging Sparks Booster Box',
    sku: 'PKM-SSP-BB',
    price: '159.90',
    tags: ['Pokémon TCG', 'Sealed', 'Scarlet & Violet'],
    barcode: ean13(1001),
    packs: [
      {
        name: 'Case',
        quantity: '6',
        uses: ['purchasing', 'counting', 'transfer'],
        barcode: ean13(1002),
      },
      { name: 'Pallet', quantity: '40', innerPack: 'Case', uses: ['purchasing', 'transfer'] },
    ],
    supplier: 'tcg',
    supplierSku: 'NW-SV08-BB',
    supplierPack: 'Case',
    lastCost: '552.00',
  },
  {
    key: 'pre_etb',
    name: 'Pokémon TCG Prismatic Evolutions Elite Trainer Box',
    sku: 'PKM-PRE-ETB',
    price: '89.90',
    tags: ['Pokémon TCG', 'Sealed', 'Scarlet & Violet'],
    barcode: ean13(1011),
    packs: [
      {
        name: 'Case',
        quantity: '10',
        uses: ['purchasing', 'counting', 'transfer'],
        barcode: ean13(1012),
      },
    ],
    supplier: 'tcg',
    supplierSku: 'NW-SV85-ETB',
    supplierPack: 'Case',
    lastCost: '540.00',
  },
  {
    key: 'pika_box',
    name: 'Pokémon TCG Pikachu ex Box',
    sku: 'PKM-PIKA-EXBOX',
    price: '24.90',
    tags: ['Pokémon TCG', 'Sealed', 'Collection box'],
    barcode: ean13(1021),
    packs: [
      {
        name: 'Case',
        quantity: '12',
        uses: ['purchasing', 'counting', 'transfer'],
        barcode: ean13(1022),
      },
    ],
    supplier: 'tcg',
    supplierSku: 'NW-PIKA-EXBOX',
    supplierPack: 'Case',
    lastCost: '174.00',
  },
  {
    key: 'upc_151',
    name: 'Pokémon TCG Scarlet & Violet 151 Ultra-Premium Collection',
    sku: 'PKM-151-UPC',
    price: '149.90',
    tags: ['Pokémon TCG', 'Sealed', 'Collection box'],
    barcode: ean13(1031),
    supplier: 'tcg',
    supplierSku: 'NW-SV35-UPC',
    lastCost: '108.00',
  },
  {
    key: 'falcon',
    name: 'LEGO Star Wars Millennium Falcon (75192)',
    sku: 'LEGO-75192',
    price: '849.99',
    family: 'Building sets',
    tags: ['LEGO'],
    fields: {
      set_number: '75192',
      theme: 'Star Wars',
      piece_count: 7541,
      sealed_state: 'Sealed',
      completeness: 'Complete',
      box_condition: 'New',
    },
    barcode: ean13(2001),
    supplier: 'lego',
    supplierSku: 'BH-75192',
    lastCost: '655.00',
  },
  {
    key: 'rivendell',
    name: 'LEGO Icons The Lord of the Rings: Rivendell (10316)',
    sku: 'LEGO-10316',
    price: '499.99',
    family: 'Building sets',
    tags: ['LEGO'],
    fields: {
      set_number: '10316',
      theme: 'Icons',
      piece_count: 6167,
      sealed_state: 'Sealed',
      completeness: 'Complete',
      box_condition: 'New',
    },
    barcode: ean13(2011),
    supplier: 'lego',
    supplierSku: 'BH-10316',
    lastCost: '370.00',
  },
  {
    key: 'daytona',
    name: 'LEGO Technic Ferrari Daytona SP3 (42143)',
    sku: 'LEGO-42143',
    price: '449.99',
    family: 'Building sets',
    tags: ['LEGO'],
    fields: {
      set_number: '42143',
      theme: 'Technic',
      piece_count: 3778,
      sealed_state: 'Sealed',
      completeness: 'Complete',
      box_condition: 'Like new',
    },
    barcode: ean13(2021),
    supplier: 'lego',
    supplierSku: 'BH-42143',
    lastCost: '335.00',
  },
  {
    key: 'galaxy',
    name: 'LEGO Icons Galaxy Explorer (10497)',
    sku: 'LEGO-10497',
    price: '99.99',
    family: 'Building sets',
    tags: ['LEGO'],
    fields: {
      set_number: '10497',
      theme: 'Icons',
      piece_count: 1254,
      sealed_state: 'Sealed',
      completeness: 'Complete',
      box_condition: 'New',
    },
    barcode: ean13(2031),
    supplier: 'lego',
    supplierSku: 'BH-10497',
    lastCost: '70.00',
  },
  {
    key: 'shake',
    name: 'Protein Shake Chocolate 500 ml',
    sku: 'FOOD-SHAKE-CHOC',
    price: '3.49',
    family: 'Food',
    fields: {
      net_weight: '530 g',
      storage: 'Ambient',
      allergens: ['Milk', 'Soybeans'],
      shelf_life_days: 180,
    },
    barcode: ean13(3001),
    packs: [
      { name: 'Tray', quantity: '12', uses: ['purchasing', 'counting'], barcode: ean13(3002) },
    ],
    lots: true,
    supplier: 'food',
    supplierSku: 'FF-SHAKE-CH-12',
    supplierPack: 'Tray',
    lastCost: '23.40',
  },
  {
    key: 'bar',
    name: 'Protein Bar Peanut Butter 60 g',
    sku: 'FOOD-BAR-PB',
    price: '2.29',
    family: 'Food',
    fields: {
      net_weight: '60 g',
      storage: 'Ambient',
      allergens: ['Peanuts', 'Milk'],
      shelf_life_days: 270,
    },
    barcode: ean13(3011),
    packs: [
      {
        name: 'Box',
        quantity: '12',
        uses: ['purchasing', 'counting', 'sales'],
        barcode: ean13(3012),
      },
    ],
    lots: true,
    supplier: 'food',
    supplierSku: 'FF-BAR-PB-12',
    supplierPack: 'Box',
    lastCost: '11.40',
  },
  {
    key: 'granola',
    name: 'Berry Crunch Granola 400 g',
    sku: 'FOOD-GRAN-BERRY',
    price: '4.99',
    family: 'Food',
    fields: {
      net_weight: '400 g',
      storage: 'Ambient',
      allergens: ['Gluten', 'Nuts'],
      shelf_life_days: 240,
    },
    barcode: ean13(3021),
    lots: true,
    supplier: 'food',
    supplierSku: 'FF-GRAN-BERRY',
    lastCost: '2.55',
  },
];

/** One-of-a-kind graded cards, added with quick add (one unit each). */
const GRADED = [
  {
    key: 'umbreon',
    name: 'Umbreon VMAX 215/203 Evolving Skies PSA 10',
    certificate: '84731629',
    price: '1450.00',
    unitCost: '1100.00',
    fields: {
      game: 'Pokémon',
      set_name: 'Evolving Skies',
      card_number: '215/203',
      rarity: 'Secret rare',
      card_language: 'English',
      card_condition: 'NM',
      grading_company: 'PSA',
      grade: '10',
      certificate_number: '84731629',
    },
  },
  {
    key: 'gengar',
    name: 'Gengar & Mimikyu GX 165/181 Team Up PSA 9',
    certificate: '71920453',
    price: '520.00',
    unitCost: '390.00',
    fields: {
      game: 'Pokémon',
      set_name: 'Team Up',
      card_number: '165/181',
      rarity: 'Secret rare',
      card_language: 'English',
      card_condition: 'NM',
      grading_company: 'PSA',
      grade: '9',
      certificate_number: '71920453',
    },
  },
  {
    key: 'mew',
    name: 'Mew ex 232/091 Paldean Fates CGC 9.5',
    certificate: '4182736015',
    price: '310.00',
    unitCost: '215.00',
    fields: {
      game: 'Pokémon',
      set_name: 'Paldean Fates',
      card_number: '232/091',
      rarity: 'Secret rare',
      card_language: 'English',
      card_condition: 'NM',
      grading_company: 'CGC',
      grade: '9.5',
      certificate_number: '4182736015',
    },
  },
];

// Setup -----------------------------------------------------------------------------------------

interface Ids {
  warehouseId: string;
  receiving: string;
  a1: string;
  b2: string;
  suppliers: Record<keyof typeof SUPPLIERS, string>;
  variants: Record<string, string>;
  packs: Record<string, Record<string, string>>;
}

async function catalog({ post, get }: Client): Promise<Ids> {
  for (const template of ['building_sets', 'food', 'trading_cards']) {
    await post('/catalog/templates', { template }, `template:${template}`).catch((e: Error) => {
      // Adding a template twice is refused; the family is there either way.
      if (!/409|already/.test(e.message)) throw e;
    });
  }

  const { warehouses } = await get<{ warehouses: Array<{ warehouseId: string; name: string }> }>(
    '/warehouses',
  );
  const warehouseId = warehouses[0]!.warehouseId;
  const warehouse = await get<{ warehouse: { version: number; name: string } }>(
    `/warehouses/${warehouseId}`,
  );
  if (warehouse.warehouse.name !== 'Main warehouse') {
    await post(
      `/warehouses/${warehouseId}`,
      { expectedVersion: warehouse.warehouse.version, name: 'Main warehouse' },
      'warehouse:rename',
    );
  }
  type Loc = { locationId: string; name: string; code: string | null; version: number };
  let { locations } = await get<{ locations: Loc[] }>('/locations');
  const main = locations.find((l) => l.name === 'Main stock');
  if (main) {
    await post(
      `/locations/${main.locationId}`,
      { expectedVersion: main.version, name: 'Receiving', code: 'RCV' },
      'location:receiving',
    );
  }
  for (const code of ['A1', 'B2']) {
    if (!locations.some((l) => l.code === code)) {
      await post(
        '/locations',
        { warehouseId, name: `Shelf ${code}`, code, fulfillmentEligible: true },
        `location:${code}`,
      );
    }
  }
  ({ locations } = await get<{ locations: Loc[] }>('/locations'));
  const byCode = (code: string) => locations.find((l) => l.code === code)!.locationId;

  const suppliers = {} as Ids['suppliers'];
  const existing = (await get<{ suppliers: Array<{ id: string; name: string }> }>('/suppliers'))
    .suppliers;
  for (const [key, supplier] of Object.entries(SUPPLIERS) as Array<
    [keyof typeof SUPPLIERS, (typeof SUPPLIERS)[keyof typeof SUPPLIERS]]
  >) {
    suppliers[key] =
      existing.find((s) => s.name === supplier.name)?.id ??
      (await post<{ supplier: { id: string } }>('/suppliers', supplier, `supplier:${key}`)).supplier
        .id;
  }

  const variants: Record<string, string> = {};
  const packs: Record<string, Record<string, string>> = {};
  for (const item of ITEMS) {
    const created = await post<{ variantId: string }>(
      '/items',
      {
        name: item.name,
        sku: item.sku,
        price: item.price,
        status: 'active',
        ...(item.family ? { family: item.family } : {}),
        ...(item.tags ? { tags: item.tags } : {}),
        ...(item.fields ? { fields: item.fields } : {}),
        acknowledgeSimilar: true,
      },
      `item:${item.key}`,
    );
    const variantId = created.variantId;
    variants[item.key] = variantId;
    let packaging = await get<{
      packsVersion: number;
      barcodesVersion: number;
      packs: Array<{ id: string; name: string; status: string }>;
      barcodes: unknown[];
    }>(`/variants/${variantId}/packaging`);
    if (item.packs && packaging.packs.filter((p) => p.status === 'active').length === 0) {
      await post(
        `/variants/${variantId}/packs`,
        {
          packsVersion: packaging.packsVersion,
          packs: item.packs.map((p) => ({
            name: p.name,
            quantity: p.quantity,
            uses: p.uses,
            ...(p.innerPack ? { innerPack: p.innerPack } : {}),
          })),
        },
        `packs:${item.key}`,
      );
      packaging = await get(`/variants/${variantId}/packaging`);
    }
    packs[item.key] = Object.fromEntries(packaging.packs.map((p) => [p.name, p.id]));
    // Set once: a second run would send a newer version under the same idempotency key.
    if (packaging.barcodes.length === 0) {
      await post(
        `/variants/${variantId}/barcodes`,
        {
          barcodesVersion: packaging.barcodesVersion,
          barcodes: [
            { code: item.barcode, symbology: 'ean13' },
            ...(item.packs ?? [])
              .filter((p) => p.barcode)
              .map((p) => ({
                code: p.barcode,
                symbology: 'ean13',
                packId: packs[item.key]![p.name],
              })),
          ],
        },
        `barcodes:${item.key}`,
      );
    }
    if (item.lots) {
      await post(
        `/variants/${variantId}/stock-settings`,
        { trackingMode: 'lot_expiry', sellByMarginDays: 5 },
        `tracking:${item.key}`,
      );
    }
    await post(
      '/supplier-items',
      {
        supplierId: suppliers[item.supplier],
        variantId,
        supplierSku: item.supplierSku,
        lastCost: item.lastCost,
        preferred: true,
        ...(item.supplierPack ? { packId: packs[item.key]![item.supplierPack] } : {}),
        ...(item.supplierPack ? { minimumOrderQuantity: '1' } : {}),
      },
      `supplier-item:${item.key}`,
    );
  }
  return {
    warehouseId,
    receiving: byCode('RCV'),
    a1: byCode('A1'),
    b2: byCode('B2'),
    suppliers,
    variants,
    packs,
  };
}

/** Looks up what `catalog` made, for the later phase. */
async function load({ get }: Client): Promise<Ids> {
  const { warehouses } = await get<{ warehouses: Array<{ warehouseId: string }> }>('/warehouses');
  const { locations } = await get<{
    locations: Array<{ locationId: string; code: string | null }>;
  }>('/locations');
  if (!locations.some((l) => l.code === 'A1')) {
    throw new Error('This shop has no shelf A1 yet: run --phase opening first.');
  }
  const byCode = (code: string) => locations.find((l) => l.code === code)!.locationId;
  const { suppliers: list } = await get<{ suppliers: Array<{ id: string; name: string }> }>(
    '/suppliers',
  );
  const suppliers = Object.fromEntries(
    Object.entries(SUPPLIERS).map(([k, s]) => [k, list.find((x) => x.name === s.name)!.id]),
  ) as Ids['suppliers'];
  const variants: Record<string, string> = {};
  const packs: Record<string, Record<string, string>> = {};
  for (const item of ITEMS) {
    const { item: detail } = await get<{ item: { variants: Array<{ id: string; sku: string }> } }>(
      `/items/detail?sku=${encodeURIComponent(item.sku)}`,
    );
    const variantId = detail.variants.find((v) => v.sku === item.sku)!.id;
    variants[item.key] = variantId;
    const packaging = await get<{ packs: Array<{ id: string; name: string }> }>(
      `/variants/${variantId}/packaging`,
    );
    packs[item.key] = Object.fromEntries(packaging.packs.map((p) => [p.name, p.id]));
  }
  return {
    warehouseId: warehouses[0]!.warehouseId,
    receiving: byCode('RCV'),
    a1: byCode('A1'),
    b2: byCode('B2'),
    suppliers,
    variants,
    packs,
  };
}

// Phases ----------------------------------------------------------------------------------------

async function opening({ post }: Client, ids: Ids) {
  const v = ids.variants;
  const receive = (key: string, step: string, body: Json) =>
    post('/receipts', { variantId: v[key], ...body }, `receipt:${step}`);
  const tcg = ids.suppliers.tcg;
  const lego = ids.suppliers.lego;
  const food = ids.suppliers.food;
  // Opening stock at the older costs.
  await receive('ssp_bb', 'ssp_bb:1', {
    locationId: ids.a1,
    quantity: '1',
    packId: ids.packs.ssp_bb!.Case,
    unitCost: '528.00',
    costPer: 'pack',
    supplierId: tcg,
    reference: 'NW-INV-24871',
  });
  await receive('pre_etb', 'pre_etb:1', {
    locationId: ids.a1,
    quantity: '5',
    unitCost: '52.00',
    supplierId: tcg,
    reference: 'NW-INV-24871',
  });
  await receive('pika_box', 'pika_box:1', {
    locationId: ids.a1,
    quantity: '3',
    unitCost: '14.00',
    supplierId: tcg,
    reference: 'NW-INV-24871',
  });
  await receive('upc_151', 'upc_151:1', {
    locationId: ids.b2,
    quantity: '3',
    unitCost: '105.00',
    supplierId: tcg,
    reference: 'NW-INV-24871',
  });
  await receive('falcon', 'falcon:1', {
    locationId: ids.b2,
    quantity: '3',
    unitCost: '640.00',
    supplierId: lego,
    reference: 'BH-2026-1187',
  });
  await receive('rivendell', 'rivendell:1', {
    locationId: ids.b2,
    quantity: '5',
    unitCost: '365.00',
    supplierId: lego,
    reference: 'BH-2026-1187',
  });
  await receive('daytona', 'daytona:1', {
    locationId: ids.b2,
    quantity: '1',
    unitCost: '330.00',
    supplierId: lego,
    reference: 'BH-2026-1187',
  });
  await receive('galaxy', 'galaxy:1', {
    locationId: ids.a1,
    quantity: '6',
    unitCost: '68.00',
    supplierId: lego,
    reference: 'BH-2026-1187',
  });
  await receive('shake', 'shake:L-2311', {
    locationId: ids.a1,
    quantity: '12',
    unitCost: '1.85',
    lotCode: 'L-2311',
    expiresOn: '2026-12-10',
    producedOn: '2026-06-10',
    supplierId: food,
    reference: 'FF-DN-55102',
  });
  await receive('bar', 'bar:L-2315', {
    locationId: ids.a1,
    quantity: '4',
    packId: ids.packs.bar!.Box,
    unitCost: '0.95',
    lotCode: 'L-2315',
    expiresOn: '2027-01-20',
    supplierId: food,
    reference: 'FF-DN-55102',
  });
  await receive('granola', 'granola:L-2309', {
    locationId: ids.a1,
    quantity: '6',
    unitCost: '2.40',
    lotCode: 'L-2309',
    expiresOn: '2026-12-02',
    supplierId: food,
    reference: 'FF-DN-55102',
  });
  for (const card of GRADED) {
    await post(
      '/quick-add',
      {
        locationId: ids.a1,
        name: card.name,
        barcode: card.certificate,
        price: card.price,
        family: 'Trading cards',
        fields: card.fields,
        unitCost: card.unitCost,
        status: 'active',
      },
      `quick-add:${card.key}`,
    );
  }
}

async function later({ post }: Client, ids: Ids) {
  const v = ids.variants;
  const tcg = ids.suppliers.tcg;
  const food = ids.suppliers.food;
  // Newer deliveries at higher costs: the moving average moves.
  await post(
    '/receipts',
    {
      variantId: v.ssp_bb,
      locationId: ids.a1,
      quantity: '2',
      packId: ids.packs.ssp_bb!.Case,
      unitCost: '552.00',
      costPer: 'pack',
      supplierId: tcg,
      reference: 'NW-INV-25310',
    },
    'receipt:ssp_bb:2',
  );
  await post(
    '/receipts',
    {
      variantId: v.shake,
      locationId: ids.a1,
      quantity: '1',
      packId: ids.packs.shake!.Tray,
      unitCost: '23.40',
      costPer: 'pack',
      lotCode: 'L-2402',
      expiresOn: '2027-02-26',
      producedOn: '2026-08-26',
      supplierId: food,
      reference: 'FF-DN-55488',
    },
    'receipt:shake:L-2402',
  );
  await post(
    '/receipts',
    {
      variantId: v.granola,
      locationId: ids.a1,
      quantity: '10',
      unitCost: '2.55',
      lotCode: 'L-2401',
      expiresOn: '2027-04-30',
      supplierId: food,
      reference: 'FF-DN-55488',
    },
    'receipt:granola:L-2401',
  );

  // Six booster boxes to shelf B2.
  await post(
    '/moves',
    {
      fromLocationId: ids.a1,
      toLocationId: ids.b2,
      lines: [{ variantId: v.ssp_bb, quantity: '6' }],
      reason: 'Restock the display shelf',
    },
    'move:ssp_bb',
  );

  // Orders: 1001 to 1003 fulfilled, 1004 and 1005 reserved and waiting to be picked.
  const order = async (
    ref: string,
    lines: Array<{ key: string; quantity: string; lotCode?: string; locationId?: string }>,
    fulfill: boolean,
  ) => {
    for (const [i, line] of lines.entries()) {
      const { reservationId } = await post<{ reservationId: string }>(
        '/reservations',
        {
          variantId: v[line.key],
          quantity: line.quantity,
          purpose: 'external_order',
          externalRef: ref,
          channel: 'manual',
          ...(line.lotCode ? { lotCode: line.lotCode } : {}),
          ...(line.locationId ? { locationId: line.locationId } : {}),
        },
        `reserve:${ref}:${i}`,
      );
      if (fulfill) {
        await post(
          `/reservations/${reservationId}/fulfill`,
          { reference: `Order ${ref}` },
          `fulfill:${ref}:${i}`,
        );
      }
    }
  };
  await order('1001', [{ key: 'falcon', quantity: '1' }], true);
  await order(
    '1002',
    [
      { key: 'upc_151', quantity: '1' },
      { key: 'ssp_bb', quantity: '2', locationId: ids.a1 },
    ],
    true,
  );
  await order('1003', [{ key: 'shake', quantity: '4', lotCode: 'L-2311' }], true);
  await order(
    '1004',
    [
      { key: 'pika_box', quantity: '2', locationId: ids.a1 },
      { key: 'galaxy', quantity: '1', locationId: ids.a1 },
    ],
    false,
  );
  await order('1005', [{ key: 'ssp_bb', quantity: '2', locationId: ids.b2 }], false);

  // Reorder rules for the whole warehouse: three items end up at or below their point.
  const rules: Array<[string, string, string, keyof Ids['suppliers']]> = [
    ['ssp_bb', '6', '12', 'tcg'],
    ['pre_etb', '6', '10', 'tcg'],
    ['pika_box', '4', '12', 'tcg'],
    ['rivendell', '2', '3', 'lego'],
    ['falcon', '1', '2', 'lego'],
    ['shake', '24', '48', 'food'],
    ['bar', '24', '48', 'food'],
  ];
  for (const [key, point, quantity, supplier] of rules) {
    await post(
      '/reorder-rules',
      {
        variantId: v[key],
        warehouseId: ids.warehouseId,
        reorderPoint: point,
        reorderQuantity: quantity,
        preferredSupplierId: ids.suppliers[supplier],
      },
      `rule:${key}`,
    );
  }
}

// Main ------------------------------------------------------------------------------------------

interface ValueReport {
  totals: Record<string, string>;
  currency: string;
  at: string | null;
}

/** The shop's stock value from the inventory value report, now or at a moment. */
async function stockValue({ get }: Client, at?: string): Promise<string> {
  const report = await get<ValueReport>(
    `/reports/inventory_value${at ? `?at=${encodeURIComponent(at)}` : ''}`,
  );
  return `${report.totals.value ?? '?'} ${report.currency}`;
}

/** A whole minute in the shop's time zone, as a person would say it ("17 Nov, 14:05"). */
function localMinute(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

export interface SeedResult {
  /** For prompt 8: a moment between the phases, when the stock value differed from now. */
  valueMoment: { at: string; local: string; value: string } | null;
  valueNow: string;
}

/**
 * Seeds one phase (or both) and reports the values for prompt 8. With `all`, it waits for the
 * next whole minute between the phases unless `waitForMinute` is false (tests), so the moment
 * between them can be said in whole minutes.
 */
export async function seedRunShop(
  target: SeedTarget,
  phase: SeedPhase,
  {
    log = console.log,
    waitForMinute = true,
  }: { log?: (line: string) => void; waitForMinute?: boolean } = {},
): Promise<SeedResult> {
  const api = client(target);
  const { shop } = await api.get<{ shop: { name: string; timezone: string } }>('');
  let moment: Date | null = null;
  if (phase === 'opening' || phase === 'all') {
    const ids = await catalog(api);
    await opening(api, ids);
    const done = new Date();
    log(
      `Opening phase done at ${localMinute(done, shop.timezone)} (${shop.timezone}), in "${shop.name}".`,
    );
    if (phase === 'all') {
      moment = new Date(Math.ceil((done.getTime() + 1) / 60_000) * 60_000);
      if (waitForMinute) {
        await new Promise((r) => setTimeout(r, moment!.getTime() - Date.now() + 1000));
      } else {
        moment = done;
      }
    }
  }
  let valueMoment: SeedResult['valueMoment'] = null;
  if (phase === 'later' || phase === 'all') {
    // The moment for prompt 8: the last whole minute before this phase, which must be after the
    // opening phase ended (the value then equals the value now, before this phase writes).
    if (!moment) moment = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
    const before = await stockValue(api);
    const then = await stockValue(api, moment.toISOString());
    if (then !== before) {
      throw new Error(
        `The value at ${moment.toISOString()} (${then}) differs from the value now (${before}): the opening phase was still running then. Wait two minutes after it and run --phase later again.`,
      );
    }
    const ids = await load(api);
    await later(api, ids);
    valueMoment = {
      at: moment.toISOString(),
      local: localMinute(moment, shop.timezone),
      value: then,
    };
    log(`Later phase done at ${localMinute(new Date(), shop.timezone)}.`);
  }
  const valueNow = await stockValue(api);
  if (valueMoment) {
    log(
      `Prompt 8: ask for the value at ${valueMoment.local} (${shop.timezone}; ${valueMoment.at}): ${valueMoment.value} then, ${valueNow} now (before the run's own changes).`,
    );
  } else {
    log(`Stock value now: ${valueNow}.`);
  }
  return { valueMoment, valueNow };
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      base: { type: 'string', default: 'https://airstock.deletecookies.dev' },
      shop: { type: 'string' },
      phase: { type: 'string', default: 'all' },
    },
  });
  const token = process.env.AIRSTOCK_TOKEN;
  if (!token || !args.shop) throw new Error('Needs AIRSTOCK_TOKEN and --shop.');
  if (!['opening', 'later', 'all'].includes(args.phase ?? '')) {
    throw new Error('--phase is opening, later, or all.');
  }
  await seedRunShop({ base: args.base!, shopId: args.shop, token }, args.phase as SeedPhase);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
