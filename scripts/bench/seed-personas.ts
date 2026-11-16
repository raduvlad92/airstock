/**
 * Persona benchmark seed (Phase 2 plan, milestone I0, Section 7.2): the six shops in
 * `personas.ts`, each with its fields, families, warehouses and location tree, suppliers, catalog,
 * packs, barcodes, bundles, supplier items, relations, members, and opening stock.
 *
 *   DATABASE_OWNER_URL=postgres://… tsx scripts/bench/seed-personas.ts \
 *     [--scale 1] [--only owner --only food] [--seed 42] [--days 91] [--out seed-personas.json]
 *     [--check]   (with DATABASE_APP_URL: reads every shop back through the product's operations)
 *
 * Rows are written directly as the database owner in large batches, like seed-catalog.ts, but
 * values go through the product's own encoders (fields, barcodes, packs, SKUs), and opening stock
 * follows the import's receipt path: an operation, a position, a ledger entry with its unit cost,
 * and a completed idempotency record per variant and location, so the ledger reconciles with the
 * balances. Where the schema has milestone I1's stock engine (migration 0017), it also writes the
 * moving-average cost and its history, and runs I1's reconciler; columns and tables a schema lacks
 * are left out. The catalog is dated `--days` ago, where seed-history.ts starts the activity. No audit
 * events are written here; seed-history.ts writes the history, including the import itself.
 *
 * Shop names start with "Bench ". A shop that already exists is left as it is and reported, so a
 * rerun only adds what is missing. To reseed: cleanup.ts --names 'Bench %' --yes.
 *
 * Deterministic for a given --seed and --scale, apart from IDs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { gtinCheckDigit, normalizeBarcode } from '../../packages/core/src/catalog/barcodes.ts';
import {
  encodeValue,
  type FieldDefinition,
  type FieldLevel,
} from '../../packages/core/src/catalog/fields.ts';
import { resolvePacks } from '../../packages/core/src/catalog/packs.ts';
import { uuidv7 } from '../../packages/core/src/ids.ts';
import { normalizeSku } from '../../packages/core/src/schemas.ts';
import {
  type Attrs,
  type CatalogBuilder,
  type LocationSpec,
  PERSONAS,
  type Persona,
  type ProductInput,
  type QueryHints,
  type VariantRef,
} from './personas.ts';

const { values: args } = parseArgs({
  options: {
    scale: { type: 'string', default: '1' },
    only: { type: 'string', multiple: true, default: [] },
    seed: { type: 'string', default: '42' },
    days: { type: 'string', default: '91' },
    out: { type: 'string', default: 'seed-personas.json' },
    check: { type: 'boolean', default: false },
  },
});
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('Set DATABASE_OWNER_URL.');
const scale = Number(args.scale);
const unknown = args.only.filter((k) => !PERSONAS.some((p) => p.key === k));
if (unknown.length > 0)
  throw new Error(`Unknown persona: ${unknown.join(', ')}. Use ${PERSONAS.map((p) => p.key)}.`);
const chosen = PERSONAS.filter((p) => args.only.length === 0 || args.only.includes(p.key));

/** The catalog's import time: the start of the history, at 09:00 UTC. */
const start = new Date(Date.now() - Number(args.days) * 86_400_000);
start.setUTCHours(9, 0, 0, 0);
const startIso = start.toISOString();

// Random numbers: mulberry32, seeded per persona so --only gives the same shop as a full run.
function rng(seed: string) {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = Record<string, unknown>;

/** Column names and types for each table, in insert order (foreign keys before their users). */
const TABLES: Array<[string, string]> = [
  [
    'memberships',
    'id uuid, user_id uuid, role text, all_locations boolean, created_at timestamptz',
  ],
  ['membership_location_scopes', 'membership_id uuid, scope_id uuid'],
  [
    'api_credentials',
    'id uuid, membership_id uuid, name text, secret_hash text, scopes text[], created_at timestamptz, last_used_at timestamptz',
  ],
  [
    'connection_grants',
    'id uuid, membership_id uuid, client_id text, client_name text, scopes text[], created_at timestamptz, last_used_at timestamptz, bound_at timestamptz',
  ],
  [
    'warehouses',
    'id uuid, name text, ownership text, operator_name text, timezone text, address jsonb, contact jsonb, fulfillment_eligible boolean, created_at timestamptz, updated_at timestamptz',
  ],
  [
    'locations',
    'id uuid, warehouse_id uuid, parent_id uuid, name text, code text, path text, path_ids uuid[], fulfillment_eligible boolean, created_at timestamptz, updated_at timestamptz',
  ],
  [
    'field_definitions',
    'id uuid, key text, label text, type text, level text, config jsonb, is_system boolean, created_at timestamptz, updated_at timestamptz',
  ],
  ['field_options', 'id uuid, field_id uuid, label text, position integer'],
  [
    'product_families',
    'id uuid, name text, description text, template_key text, created_at timestamptz, updated_at timestamptz',
  ],
  ['family_fields', 'family_id uuid, field_id uuid, required boolean, position integer'],
  [
    'family_option_suggestions',
    'id uuid, family_id uuid, name text, position integer, values jsonb',
  ],
  [
    'suppliers',
    'id uuid, name text, contact_name text, email text, phone text, website text, address text, currency text, lead_time_days integer, created_at timestamptz, updated_at timestamptz',
  ],
  [
    'products',
    'id uuid, name text, description text, status text, family_id uuid, tags text[], attributes jsonb, created_at timestamptz, updated_at timestamptz',
  ],
  ['product_options', 'id uuid, product_id uuid, name text, position smallint'],
  ['product_option_values', 'id uuid, option_id uuid, label text, position integer'],
  [
    'variants',
    'id uuid, product_id uuid, sku text, sku_normalized text, price numeric, is_default boolean, status text, option_value_ids uuid[], attributes jsonb, weight jsonb, created_at timestamptz, updated_at timestamptz',
  ],
  ['variant_packaging', 'variant_id uuid, packs_version integer, barcodes_version integer'],
  [
    'packs',
    'id uuid, variant_id uuid, name text, quantity numeric, inner_pack_id uuid, base_quantity numeric, uses text[], price numeric, position integer, created_at timestamptz, updated_at timestamptz',
  ],
  [
    'pack_versions',
    'id uuid, pack_id uuid, version integer, name text, quantity numeric, inner_pack_id uuid, base_quantity numeric, uses text[], price numeric, status text, created_at timestamptz',
  ],
  [
    'barcodes',
    'id uuid, variant_id uuid, pack_id uuid, symbology text, code text, code_normalized text, source text, position integer, created_at timestamptz',
  ],
  ['barcode_sequences', 'last_value bigint'],
  ['bundles', 'id uuid, variant_id uuid, version integer, active boolean'],
  ['bundle_versions', 'id uuid, bundle_id uuid, version integer'],
  [
    'bundle_components',
    'id uuid, bundle_version_id uuid, position integer, variant_id uuid, pack_id uuid, pack_version integer, quantity numeric, base_quantity numeric',
  ],
  [
    'supplier_items',
    'id uuid, supplier_id uuid, variant_id uuid, pack_id uuid, supplier_sku text, supplier_sku_normalized text, last_cost numeric, last_cost_at timestamptz, minimum_order_quantity numeric, preferred boolean, created_at timestamptz, updated_at timestamptz',
  ],
  [
    'record_relations',
    'id uuid, field_id uuid, source_type text, source_id uuid, target_type text, target_id uuid, position integer',
  ],
  [
    'inventory_operations',
    'id uuid, kind text, actor_type text, actor_id text, source text, external_ref text, reason text, occurred_at timestamptz',
  ],
  [
    'inventory_positions',
    'id uuid, variant_id uuid, location_id uuid, condition text, on_hand numeric, version bigint, received_at timestamptz, created_at timestamptz, updated_at timestamptz',
  ],
  [
    'inventory_entries',
    'id uuid, operation_id uuid, position_id uuid, variant_id uuid, location_id uuid, delta numeric, unit_cost numeric, cost_basis text, created_at timestamptz',
  ],
  // Moving-average cost (milestone I1, migration 0017): skipped on an older schema.
  [
    'variant_cost_history',
    'id uuid, variant_id uuid, operation_id uuid, occurred_at timestamptz, kind text, quantity_delta numeric, unit_cost numeric, quantity_after numeric, average_after numeric',
  ],
  [
    'variant_costs',
    'variant_id uuid, quantity numeric, average_cost numeric, updated_at timestamptz',
  ],
  [
    'idempotency_records',
    'caller_id text, operation_id text, key text, request_hash text, status text, response jsonb, created_at timestamptz, completed_at timestamptz, result_operation_id uuid',
  ],
];

const ROLES = [
  ['owner', 'Owner'],
  ['manager', 'Shop manager'],
  ['inventory_operator', 'Warehouse lead'],
  ['inventory_operator', 'Picker'],
  ['catalog_editor', 'Catalog editor'],
  ['viewer', 'Accountant'],
] as const;

interface ShopOut {
  key: string;
  shopId: string;
  name: string;
  existed: boolean;
  counts: Record<string, number>;
  query: QueryHints & { sku: string };
}

/** Builds one persona's rows in memory. */
class ShopSeed {
  readonly shopId = uuidv7(start.getTime());
  readonly rows = new Map<string, Row[]>(TABLES.map(([t]) => [t, []]));
  readonly users: Row[] = [];
  readonly ownerUserId = uuidv7(start.getTime());
  private readonly rand: () => number;
  private readonly defs = new Map<string, FieldDefinition>();
  private readonly families = new Map<string, string>();
  private readonly suppliers = new Map<string, string>();
  /** Leaf locations by warehouse key and role. */
  private readonly leaves = new Map<string, string[]>();
  private readonly skus = new Set<string>();
  private readonly codes = new Set<string>();
  private readonly supplierSkus = new Set<string>();
  private readonly variantAttrs = new Map<string, Row>();
  private readonly variantPrice = new Map<string, string>();
  private ean = 0;
  private generated = 0;
  private variantCount = 0;
  private renamedSkus = 0;
  readonly importId = uuidv7(start.getTime());
  private receiptRow = 0;
  /** Stock by variant and location, merged, with the unit cost of the first line. */
  private readonly stock = new Map<
    string,
    { variantId: string; locationId: string; quantity: number; cost: string }
  >();
  firstSku = '';

  constructor(
    readonly persona: Persona,
    readonly index: number,
  ) {
    this.rand = rng(`${args.seed}:${persona.key}`);
  }

  private push(table: string, row: Row) {
    this.rows.get(table)!.push(row);
  }

  // Random helpers shared with the persona builders.
  int = (min: number, max: number) => min + Math.floor(this.rand() * (max - min + 1));
  pick = <T>(list: readonly T[]): T => list[Math.floor(this.rand() * list.length)]!;
  some = <T>(list: readonly T[], min: number, max: number): T[] => {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy.slice(0, Math.min(copy.length, this.int(min, max)));
  };

  setup() {
    const p = this.persona;
    const at = { created_at: startIso, updated_at: startIso };
    // Members: the owner plus the people a shop of this kind has, one of them scoped to a
    // single warehouse when there are several (location scope, PRD 2.4).
    const memberships: Array<{ id: string; userId: string; role: string }> = [];
    for (const [i, [role, title]] of ROLES.entries()) {
      const userId = i === 0 ? this.ownerUserId : uuidv7(start.getTime());
      this.users.push({
        id: userId,
        workos_user_id: `bench_${userId}`,
        email: `bench-${p.key}-${i}@example.test`,
        display_name: `${title} (${p.shopName})`,
      });
      const id = uuidv7(start.getTime());
      memberships.push({ id, userId, role });
      const scoped = title === 'Picker' && p.warehouses.length > 1;
      this.push('memberships', {
        id,
        user_id: userId,
        role,
        all_locations: !scoped,
        created_at: startIso,
      });
    }
    const owner = memberships[0]!;
    this.push('api_credentials', {
      id: uuidv7(start.getTime()),
      membership_id: memberships[1]!.id,
      name: p.shopify ? 'n8n workflows' : 'ERP sync',
      secret_hash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      scopes: [
        'shop:read',
        'catalog:read',
        'catalog:write',
        'inventory:read',
        'inventory:write',
        'activity:read',
      ],
      created_at: startIso,
      last_used_at: null,
    });
    this.push('connection_grants', {
      id: uuidv7(start.getTime()),
      membership_id: owner.id,
      client_id: 'https://chatgpt.com/oauth/client.json',
      client_name: 'ChatGPT',
      scopes: [
        'shop:read',
        'catalog:read',
        'catalog:write',
        'inventory:read',
        'inventory:write',
        'activity:read',
      ],
      created_at: startIso,
      last_used_at: null,
      bound_at: startIso,
    });

    for (const w of p.warehouses) {
      const id = uuidv7(start.getTime());
      this.push('warehouses', {
        id,
        name: w.name,
        ownership: w.ownership,
        operator_name: w.operatorName ?? null,
        timezone: w.timezone ?? null,
        address: { line1: `${this.int(1, 200)} Industrial Road`, city: w.city, country: w.country },
        contact:
          w.ownership === 'owned'
            ? null
            : { name: 'Site contact', email: `site-${w.key}@example.test` },
        fulfillment_eligible: w.fulfillment ?? true,
        ...at,
      });
      if (memberships[3] && p.warehouses.length > 1 && w === p.warehouses[1]) {
        this.push('membership_location_scopes', {
          membership_id: memberships[3].id,
          scope_id: id,
        });
      }
      const walk = (
        specs: LocationSpec[],
        parent: { id: string; path: string; pathIds: string[] } | null,
        role: string | undefined,
      ) => {
        for (const s of specs) {
          const lid = uuidv7(start.getTime());
          const label = s.code ?? s.name;
          const path = parent ? `${parent.path}/${label}` : `${w.name}/${label}`;
          const pathIds = parent ? [...parent.pathIds, lid] : [id, lid];
          this.push('locations', {
            id: lid,
            warehouse_id: id,
            parent_id: parent?.id ?? null,
            name: s.name,
            code: s.code ?? null,
            path,
            path_ids: pathIds,
            fulfillment_eligible: s.fulfillment ?? true,
            ...at,
          });
          const r = s.role ?? role;
          if (s.children?.length) walk(s.children, { id: lid, path, pathIds }, r);
          else if (r) {
            const key = `${w.key}:${r}`;
            this.leaves.set(key, [...(this.leaves.get(key) ?? []), lid]);
          }
        }
      };
      walk(w.locations, null, undefined);
    }

    // Fields: brand and category (system), then the persona's own.
    const fieldSpecs = [
      {
        key: 'brand',
        label: 'Brand',
        type: 'single_select' as const,
        level: 'product' as FieldLevel,
        options: p.brands,
        system: true,
      },
      {
        key: 'category',
        label: 'Category',
        type: 'single_select' as const,
        level: 'product' as FieldLevel,
        options: p.categories,
        system: true,
      },
      ...p.fields.map((f) => ({ ...f, system: false })),
    ];
    for (const f of fieldSpecs) {
      const id = uuidv7(start.getTime());
      const options = (f.options ?? []).map((label, position) => ({
        id: uuidv7(start.getTime()),
        label,
        position,
        archived: false,
      }));
      this.defs.set(f.key, {
        id,
        key: f.key,
        label: f.label,
        type: f.type,
        level: f.level,
        config: f.config ?? {},
        defaultValue: null,
        visibility: 'everyone',
        status: 'active',
        isSystem: f.system,
        version: 1,
        options,
      });
      this.push('field_definitions', {
        id,
        key: f.key,
        label: f.label,
        type: f.type,
        level: f.level,
        config: f.config ?? {},
        is_system: f.system,
        ...at,
      });
      for (const o of options)
        this.push('field_options', {
          id: o.id,
          field_id: id,
          label: o.label,
          position: o.position,
        });
    }
    for (const fam of p.families) {
      const id = uuidv7(start.getTime());
      this.families.set(fam.name, id);
      this.push('product_families', {
        id,
        name: fam.name,
        description: null,
        template_key: fam.templateKey ?? null,
        ...at,
      });
      for (const [position, key] of fam.fields.entries()) {
        const def = this.defs.get(key);
        if (!def) throw new Error(`${p.key}: family ${fam.name} names unknown field ${key}.`);
        this.push('family_fields', {
          family_id: id,
          field_id: def.id,
          required: fam.required?.includes(key) ?? false,
          position,
        });
      }
      for (const [position, o] of (fam.options ?? []).entries()) {
        this.push('family_option_suggestions', {
          id: uuidv7(start.getTime()),
          family_id: id,
          name: o.name,
          position,
          values: o.values,
        });
      }
    }
    for (const s of p.suppliers) {
      const id = uuidv7(start.getTime());
      this.suppliers.set(s.key, id);
      this.push('suppliers', {
        id,
        name: s.name,
        contact_name: 'Sales desk',
        email: `orders-${s.key}@example.test`,
        phone: `+${this.int(30, 49)} ${this.int(100, 999)} ${this.int(100000, 999999)}`,
        website: `https://${s.key}.example.test`,
        address: `${this.int(1, 90)} Commerce Street, ${s.city}, ${s.country}`,
        currency: p.currency,
        lead_time_days: s.leadTimeDays,
        ...at,
      });
    }
  }

  /** Encodes attribute values typed as a person would, keyed by field ID. */
  private encode(attrs: Attrs | undefined, level: 'product' | 'variant', what: string): Row {
    const out: Row = {};
    for (const [key, input] of Object.entries(attrs ?? {})) {
      const def = this.defs.get(key);
      if (!def) throw new Error(`${this.persona.key}: ${what} uses unknown field ${key}.`);
      if (def.level !== 'both' && def.level !== level)
        throw new Error(`${this.persona.key}: ${key} is a ${def.level} field, not ${level}.`);
      const encoded = encodeValue(def, input, { currency: this.persona.currency });
      if (!encoded.ok)
        throw new Error(
          `${this.persona.key}: ${what} ${key}=${JSON.stringify(input)}: ${encoded.message}`,
        );
      if (encoded.value !== null) out[def.id] = encoded.value;
    }
    return out;
  }

  private measurement(text: string | undefined): Row | null {
    if (!text) return null;
    const def = { type: 'measurement', config: {}, options: [] } as unknown as FieldDefinition;
    const encoded = encodeValue(def, text, { currency: this.persona.currency });
    if (!encoded.ok) throw new Error(`${this.persona.key}: weight ${text}: ${encoded.message}`);
    return encoded.value as Row;
  }

  private barcode(variantId: string, packId: string | null, kind: string, position: number) {
    let code: string;
    let symbology: string;
    let source = 'entered';
    if (kind === 'ean13') {
      // Prefix 2 is restricted circulation: never a real product's GTIN.
      const body = `2${this.index}${String(++this.ean).padStart(10, '0')}`;
      code = `${body}${gtinCheckDigit(body)}`;
      symbology = 'ean13';
    } else if (kind === 'generated') {
      code = `AS${String(++this.generated).padStart(8, '0')}`;
      symbology = 'code128';
      source = 'generated';
    } else {
      code = kind;
      symbology = 'code128';
    }
    const normalized = normalizeBarcode(code);
    if (this.codes.has(normalized)) return;
    this.codes.add(normalized);
    this.push('barcodes', {
      id: uuidv7(start.getTime()),
      variant_id: variantId,
      pack_id: packId,
      symbology,
      code,
      code_normalized: normalized,
      source,
      position,
      created_at: startIso,
    });
  }

  private uniqueSku(sku: string): string {
    let candidate = sku;
    for (let i = 2; this.skus.has(normalizeSku(candidate)); i++) candidate = `${sku}-${i}`;
    if (candidate !== sku) this.renamedSkus++;
    this.skus.add(normalizeSku(candidate));
    return candidate;
  }

  private leaf(warehouse: string, role: string, anchor: number): string {
    const list = this.leaves.get(`${warehouse}:${role}`);
    if (!list?.length)
      throw new Error(`${this.persona.key}: no ${role} locations in ${warehouse}.`);
    return list[anchor % list.length]!;
  }

  product(p: ProductInput): VariantRef[] {
    const familyId = this.families.get(p.family);
    if (!familyId) throw new Error(`${this.persona.key}: unknown family ${p.family}.`);
    const productId = uuidv7(start.getTime());
    this.push('products', {
      id: productId,
      name: p.name,
      description: p.description ?? null,
      status: p.status ?? 'active',
      family_id: familyId,
      tags: p.tags ?? [],
      attributes: this.encode(p.attrs, 'product', p.name),
      created_at: startIso,
      updated_at: startIso,
    });
    // Option values by label, per option position.
    const valueIds: Array<Map<string, string>> = [];
    for (const [position, o] of (p.options ?? []).entries()) {
      const optionId = uuidv7(start.getTime());
      this.push('product_options', { id: optionId, product_id: productId, name: o.name, position });
      const byLabel = new Map<string, string>();
      for (const [i, label] of o.values.entries()) {
        const id = uuidv7(start.getTime());
        byLabel.set(label, id);
        this.push('product_option_values', { id, option_id: optionId, label, position: i });
      }
      valueIds.push(byLabel);
    }
    const anchors = new Map<string, number>();
    const refs: VariantRef[] = [];
    for (const [vi, v] of p.variants.entries()) {
      const id = uuidv7(start.getTime());
      const sku = this.uniqueSku(v.sku);
      if (!this.firstSku) this.firstSku = sku;
      const options = v.options ?? [];
      const optionValueIds = options.map((label, i) => {
        const value = valueIds[i]?.get(label);
        if (!value) throw new Error(`${this.persona.key}: ${p.name} has no option value ${label}.`);
        return value;
      });
      const attributes = this.encode(v.attrs, 'variant', `${p.name} ${sku}`);
      this.variantAttrs.set(id, attributes);
      this.variantPrice.set(id, v.price);
      const archived = v.status === 'archived' || p.status === 'archived';
      this.push('variants', {
        id,
        product_id: productId,
        sku,
        sku_normalized: normalizeSku(sku),
        price: v.price,
        is_default: vi === 0,
        status: archived ? 'archived' : 'active',
        option_value_ids: optionValueIds,
        attributes,
        weight: this.measurement(v.weight),
        created_at: startIso,
        updated_at: startIso,
      });
      this.variantCount++;
      refs.push({ id, sku, productId, options });

      // Packs, resolved to base quantities with the product's own resolver.
      const packIds = new Map<string, { id: string; base: string }>();
      if (v.packs?.length) {
        const resolved = resolvePacks(
          v.packs.map((k) => ({
            key: k.key,
            name: k.name,
            quantity: String(k.quantity),
            inner: k.inner ?? null,
          })),
          0,
        );
        if (!resolved.ok) throw new Error(`${this.persona.key}: ${sku}: ${resolved.message}`);
        for (const k of v.packs) {
          packIds.set(k.key, { id: uuidv7(start.getTime()), base: resolved.base.get(k.key)! });
        }
        for (const [position, k] of v.packs.entries()) {
          const pack = packIds.get(k.key)!;
          const row = {
            id: pack.id,
            variant_id: id,
            name: k.name,
            quantity: String(k.quantity),
            inner_pack_id: k.inner ? packIds.get(k.inner)!.id : null,
            base_quantity: pack.base,
            uses: k.uses ?? ['purchasing', 'counting'],
            price: k.price ?? null,
            position,
          };
          this.push('packs', { ...row, created_at: startIso, updated_at: startIso });
          const { variant_id: _, position: __, ...version } = row;
          this.push('pack_versions', {
            ...version,
            id: uuidv7(start.getTime()),
            pack_id: pack.id,
            version: 1,
            status: 'active',
            created_at: startIso,
          });
        }
      }
      let barcodes = 0;
      if (v.barcode) this.barcode(id, null, v.barcode, barcodes++);
      for (const k of v.packs ?? []) {
        if (k.barcode) this.barcode(id, packIds.get(k.key)!.id, 'ean13', barcodes++);
      }
      if (packIds.size > 0 || barcodes > 0) {
        this.push('variant_packaging', {
          variant_id: id,
          packs_version: packIds.size > 0 ? 1 : 0,
          barcodes_version: barcodes > 0 ? 1 : 0,
        });
      }

      let unitCost: string | null = null;
      for (const s of v.supply ?? []) {
        const supplierId = this.suppliers.get(s.supplier);
        if (!supplierId) throw new Error(`${this.persona.key}: unknown supplier ${s.supplier}.`);
        const pack = s.pack ? packIds.get(s.pack) : undefined;
        if (s.pack && !pack) throw new Error(`${this.persona.key}: ${sku} has no pack ${s.pack}.`);
        let supplierSku = s.sku ?? null;
        if (supplierSku) {
          const base = supplierSku;
          for (let i = 2; this.supplierSkus.has(`${s.supplier}:${normalizeSku(supplierSku)}`); i++)
            supplierSku = `${base}-${i}`;
          this.supplierSkus.add(`${s.supplier}:${normalizeSku(supplierSku)}`);
        }
        this.push('supplier_items', {
          id: uuidv7(start.getTime()),
          supplier_id: supplierId,
          variant_id: id,
          pack_id: pack?.id ?? null,
          supplier_sku: supplierSku,
          supplier_sku_normalized: supplierSku ? normalizeSku(supplierSku) : null,
          last_cost: s.cost,
          last_cost_at: startIso,
          minimum_order_quantity: s.moq ? String(s.moq) : null,
          preferred: s.preferred ?? false,
          created_at: startIso,
          updated_at: startIso,
        });
        if (s.preferred || unitCost === null)
          unitCost = (Number(s.cost) / Number(pack?.base ?? '1')).toFixed(6);
      }
      for (const st of v.stock ?? []) {
        if (st.quantity <= 0 || archived) continue;
        const anchorKey = `${st.warehouse}:${st.role}`;
        if (!anchors.has(anchorKey)) anchors.set(anchorKey, this.int(0, 10_000));
        const locationId = this.leaf(st.warehouse, st.role, anchors.get(anchorKey)! + vi);
        const key = `${id}:${locationId}`;
        const prior = this.stock.get(key);
        if (prior) prior.quantity += st.quantity;
        else
          this.stock.set(key, {
            variantId: id,
            locationId,
            quantity: st.quantity,
            cost: unitCost ?? (Number(v.price) * 0.45).toFixed(6),
          });
      }
    }
    return refs;
  }

  bundle(bundle: VariantRef, components: Array<{ variant: VariantRef; quantity: number }>) {
    const bundleId = uuidv7(start.getTime());
    const versionId = uuidv7(start.getTime());
    this.push('bundles', { id: bundleId, variant_id: bundle.id, version: 1, active: true });
    this.push('bundle_versions', { id: versionId, bundle_id: bundleId, version: 1 });
    const seen = new Set<string>();
    for (const [position, c] of components.entries()) {
      if (seen.has(c.variant.id) || c.variant.id === bundle.id) continue;
      seen.add(c.variant.id);
      this.push('bundle_components', {
        id: uuidv7(start.getTime()),
        bundle_version_id: versionId,
        position,
        variant_id: c.variant.id,
        pack_id: null,
        pack_version: null,
        quantity: String(c.quantity),
        base_quantity: String(c.quantity),
      });
    }
  }

  relate(field: string, from: VariantRef, to: VariantRef) {
    const def = this.defs.get(field);
    if (def?.type !== 'relationship') throw new Error(`${field} is not a relationship.`);
    if (from.id === to.id) return;
    const attrs = this.variantAttrs.get(from.id)!;
    const list = (attrs[def.id] as string[] | undefined) ?? [];
    if (list.includes(to.id)) return;
    // The attributes object is the one in the variant row, so the row sees the change.
    attrs[def.id] = [...list, to.id];
    this.push('record_relations', {
      id: uuidv7(start.getTime()),
      field_id: def.id,
      source_type: 'variant',
      source_id: from.id,
      target_type: 'variant',
      target_id: to.id,
      position: list.length,
    });
  }

  builder(): CatalogBuilder {
    const self = this;
    return {
      rand: this.rand,
      int: this.int,
      pick: this.pick,
      some: this.some,
      chance: (p) => this.rand() < p,
      n: (count) => Math.max(1, Math.round(count * scale)),
      money: (min, max, endings = ['.00', '.50', '.90', '.99']) =>
        `${this.int(min, max)}${this.pick(endings)}`,
      get variants() {
        return self.variantCount;
      },
      product: (p) => this.product(p),
      bundle: (b, c) => this.bundle(b, c),
      relate: (f, a, b) => this.relate(f, a, b),
    };
  }

  /** Opening stock along the import's receipt path (imports.ts, receiveOpeningStock). */
  receipts() {
    const callerId = `user:${this.ownerUserId}`;
    const costs = new Map<string, { quantity: number; average: number }>();
    const sorted = [...this.stock.values()].sort((a, b) =>
      a.variantId + a.locationId < b.variantId + b.locationId ? -1 : 1,
    );
    for (const s of sorted) {
      const operationId = uuidv7(start.getTime());
      const positionId = uuidv7(start.getTime());
      const row = ++this.receiptRow;
      this.push('inventory_operations', {
        id: operationId,
        kind: 'receipt',
        actor_type: 'user',
        actor_id: this.ownerUserId,
        source: 'import',
        external_ref: `import ${this.importId}`,
        reason: 'opening stock',
        occurred_at: startIso,
      });
      this.push('inventory_positions', {
        id: positionId,
        variant_id: s.variantId,
        location_id: s.locationId,
        condition: 'sellable',
        on_hand: String(s.quantity),
        version: 0,
        received_at: startIso,
        created_at: startIso,
        updated_at: startIso,
      });
      this.push('inventory_entries', {
        id: uuidv7(start.getTime()),
        operation_id: operationId,
        position_id: positionId,
        variant_id: s.variantId,
        location_id: s.locationId,
        delta: String(s.quantity),
        unit_cost: s.cost,
        cost_basis: 'entered',
        created_at: startIso,
      });
      // As apply_stock_cost does for a receipt with a cost: the moving average and its history.
      const c = costs.get(s.variantId) ?? { quantity: 0, average: 0 };
      const quantity = c.quantity + s.quantity;
      const average = (c.quantity * c.average + s.quantity * Number(s.cost)) / quantity;
      costs.set(s.variantId, { quantity, average });
      this.push('variant_cost_history', {
        id: uuidv7(start.getTime()),
        variant_id: s.variantId,
        operation_id: operationId,
        occurred_at: startIso,
        kind: 'receipt',
        quantity_delta: String(s.quantity),
        unit_cost: s.cost,
        quantity_after: String(quantity),
        average_after: average.toFixed(6),
      });
      this.push('idempotency_records', {
        caller_id: callerId,
        operation_id: 'inventory.receipts.create',
        key: `import:${this.importId}:${row}:${s.locationId}`,
        request_hash: `import:${this.importId}`,
        status: 'completed',
        response: { operationId },
        created_at: startIso,
        completed_at: startIso,
        result_operation_id: operationId,
      });
    }
    for (const [variantId, c] of costs) {
      this.push('variant_costs', {
        variant_id: variantId,
        quantity: String(c.quantity),
        average_cost: c.average.toFixed(6),
        updated_at: startIso,
      });
    }
    if (this.generated > 0) this.push('barcode_sequences', { last_value: this.generated });
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [t, rows] of this.rows) if (rows.length > 0) out[t] = rows.length;
    out.renamed_skus = this.renamedSkus;
    return out;
  }
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

// The seed runs on the schema it finds: columns and tables a migration has not added yet are
// left out, so the same seed works before and after milestone I1's stock engine.
const existingColumns = new Map<string, Set<string>>();
for (const r of (
  await q(
    `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
  )
).rows as Array<{ table_name: string; column_name: string }>) {
  existingColumns.set(
    r.table_name,
    (existingColumns.get(r.table_name) ?? new Set()).add(r.column_name),
  );
}
const skipped = new Set<string>();

async function insert(table: string, columns: string, shopId: string, rows: Row[]) {
  const present = existingColumns.get(table);
  const cols = columns
    .split(',')
    .map((c) => c.trim().split(/\s+/))
    .filter(([n]) => {
      if (present?.has(n!)) return true;
      if (rows.length > 0) skipped.add(present ? `${table}.${n}` : table);
      return false;
    });
  if (!present || rows.length === 0) return;
  const names = cols.map(([n]) => `"${n}"`).join(', ');
  const types = cols.map(([n, ...t]) => `"${n}" ${t.join(' ')}`).join(', ');
  for (let i = 0; i < rows.length; i += 2000) {
    await q(
      `insert into ${table} (shop_id, ${names}) select $1, ${names} from jsonb_to_recordset($2::jsonb) as x(${types})`,
      [shopId, JSON.stringify(rows.slice(i, i + 2000))],
    );
  }
}

const out: ShopOut[] = [];
const started = performance.now();
for (const [index, persona] of PERSONAS.entries()) {
  if (!chosen.includes(persona)) continue;
  const existing = await q('select id from shops where name = $1', [persona.shopName]);
  if (existing.rows.length > 0) {
    const shopId = existing.rows[0].id as string;
    const counts = await q(
      `select (select count(*) from variants where shop_id = $1)::int as variants,
         (select count(*) from products where shop_id = $1)::int as products,
         (select min(sku) from variants where shop_id = $1 and status = 'active') as sku`,
      [shopId],
    );
    const c = counts.rows[0];
    console.log(`${persona.shopName}: exists (${c.variants} variants), left as it is.`);
    out.push({
      key: persona.key,
      shopId,
      name: persona.shopName,
      existed: true,
      counts: { variants: c.variants, products: c.products },
      query: { ...persona.query, sku: c.sku },
    });
    continue;
  }
  const t0 = performance.now();
  const seed = new ShopSeed(persona, index);
  seed.setup();
  persona.build(seed.builder());
  seed.receipts();
  await q('begin');
  try {
    for (const u of seed.users) {
      await q(
        'insert into users (id, workos_user_id, email, display_name, created_at) values ($1, $2, $3, $4, $5)',
        [u.id, u.workos_user_id, u.email, u.display_name, startIso],
      );
    }
    await q(
      'insert into shops (id, name, currency, timezone, created_by, created_at) values ($1, $2, $3, $4, $5, $6)',
      [
        seed.shopId,
        persona.shopName,
        persona.currency,
        persona.timezone,
        seed.ownerUserId,
        startIso,
      ],
    );
    for (const [table, columns] of TABLES) {
      await insert(table, columns, seed.shopId, seed.rows.get(table)!);
    }
    await q('commit');
  } catch (error) {
    await q('rollback');
    throw error;
  }
  const counts = seed.counts();
  console.log(
    `${persona.shopName}: ${counts.products} products, ${counts.variants} variants, ${counts.barcodes ?? 0} barcodes, ${counts.packs ?? 0} packs, ${counts.supplier_items ?? 0} supplier items, ${counts.inventory_positions ?? 0} positions, ${counts.locations} locations in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );
  out.push({
    key: persona.key,
    shopId: seed.shopId,
    name: persona.shopName,
    existed: false,
    counts,
    query: { ...persona.query, sku: seed.firstSku },
  });
}
await q(
  'analyze products; analyze variants; analyze inventory_positions; analyze barcodes; analyze supplier_items; analyze locations; analyze record_relations',
);

// The ledger must reconcile with the balances, as the property tests require (A21).
const mismatch = await q(
  `select count(*)::int as n from inventory_positions p
   where p.shop_id = any($1::uuid[])
     and p.on_hand <> coalesce((select sum(e.delta) from inventory_entries e
       where e.shop_id = p.shop_id and e.position_id = p.id), 0)`,
  [out.map((s) => s.shopId)],
);
console.log(`Positions whose ledger does not sum to on hand: ${mismatch.rows[0].n}`);
if (skipped.size > 0) console.log(`Not in this schema, so not written: ${[...skipped].join(', ')}`);
if (existingColumns.has('variant_costs')) {
  // Milestone I1's reconciler checks the whole database, other shops included.
  const problems = await q(
    'select problem, count(*)::int as n from stock_reconciliation_problems() group by problem',
  );
  console.log(
    `Stock reconciliation (whole database): ${problems.rows.length === 0 ? 'no problems' : JSON.stringify(problems.rows)}`,
  );
}
await client.end();

if (args.check) await check(out);

await writeFile(
  args.out,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      catalogDate: startIso,
      scale,
      seconds: Number(((performance.now() - started) / 1000).toFixed(1)),
      shops: out,
    },
    null,
    2,
  ),
);
console.log(`Done in ${((performance.now() - started) / 1000).toFixed(1)} s; wrote ${args.out}.`);

/** Reads each shop back through the product's own read operations, as its owner would. */
async function check(shops: ShopOut[]) {
  const appUrl = process.env.DATABASE_APP_URL;
  if (!appUrl) throw new Error('--check needs DATABASE_APP_URL.');
  const { execute, ops } = await import('../../packages/core/src/index.ts');
  const { PgDatabase, poolSource } = await import('../../packages/db/src/index.ts');
  const db = new PgDatabase(poolSource(appUrl, 2));
  const audit = { send: async () => {} };
  let failures = 0;
  for (const shop of shops) {
    const [m] = await db.transaction({ shopId: shop.shopId, userId: null, readOnly: true }, (tx) =>
      tx.query<{ id: string; user_id: string }>(
        `select id, user_id from memberships where role = 'owner' limit 1`,
      ),
    );
    const caller = {
      kind: 'api_credential' as const,
      id: 'bench-check',
      userId: m!.user_id,
      boundShopId: shop.shopId,
      membership: { id: m!.id, role: 'owner' as const, allLocations: true, locationScopeIds: [] },
      scopes: 'all' as const,
      source: 'api' as const,
    };
    const [sample] = await db.transaction(
      { shopId: shop.shopId, userId: null, readOnly: true },
      (tx) =>
        tx.query<{ variant_id: string; code: string; bundle: string | null }>(
          `select p.variant_id, b.code,
             (select variant_id::text from bundles where active limit 1) as bundle
           from inventory_positions p join barcodes b on b.variant_id = p.variant_id limit 1`,
        ),
    );
    const run = async (label: string, op: Parameters<typeof execute>[1], input: unknown) => {
      try {
        await execute({ db, audit }, op, { caller, shopId: shop.shopId, input });
      } catch (error) {
        failures++;
        console.error(`  ${shop.name}: ${label} failed: ${(error as Error).message}`);
      }
    };
    await run('describe_catalog', ops.describeCatalog, {});
    await run('query items', ops.queryItems, { limit: 50, fields: shop.query.fields });
    await run('item detail', ops.getItem, { sku: shop.query.sku });
    await run('availability', ops.getAvailability, { variantId: sample!.variant_id });
    await run('packaging', ops.getPackaging, { variantId: sample!.variant_id });
    await run('barcode lookup', ops.lookupBarcode, { code: sample!.code });
    await run('locations', ops.listLocations, {});
    await run('supplier items', ops.listSupplierItems, { variantId: sample!.variant_id });
    if (sample!.bundle)
      await run('bundle availability', ops.getBundleAvailability, { variantId: sample!.bundle });
  }
  await db.close();
  console.log(
    `Read-back check: ${failures === 0 ? 'every read succeeded' : `${failures} failed`}.`,
  );
  if (failures > 0) process.exitCode = 1;
}
