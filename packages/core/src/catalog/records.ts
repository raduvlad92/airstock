import type { Tx } from '@airstock/db';
import { normalizeSku } from '../schemas.ts';
import { decimalScale, isDecimal, normalize } from './decimal.ts';
import {
  comparable,
  displayValue,
  type Encoded,
  encodeValue,
  FIELD_LIMITS,
  type FieldDefinition,
} from './fields.ts';
import { toCanonical, unitKind } from './units.ts';

/**
 * Products, variants, and their values (plan Section 5.1). Built-in fields have columns; custom
 * fields live in `attributes` keyed by field ID. A variant inherits weight, dimensions, and fields
 * of level `both` from its product: no key inherits, JSON null clears, any value is its own.
 */

export type RecordType = 'product' | 'variant';

export interface BuiltinField {
  key: string;
  level: RecordType | 'both';
  column: string;
  /** Stored as jsonb (weight, dimensions, tags are text[]). */
  kind: 'text' | 'json' | 'array' | 'number';
  encode(input: unknown): Encoded;
  comparable(value: unknown): string;
}

const ok = (value: unknown): Encoded => ({ ok: true, value });
const fail = (message: string): Encoded => ({ ok: false, message });
const plain = (v: unknown) => JSON.stringify(v ?? null);

const WEIGHT_DEF: FieldDefinition = {
  id: 'weight',
  key: 'weight',
  label: 'Weight',
  type: 'measurement',
  level: 'both',
  config: { unitKind: 'weight', min: '0' },
  defaultValue: null,
  visibility: 'everyone',
  status: 'active',
  isSystem: true,
  version: 1,
  options: [],
};

function encodeWeight(input: unknown): Encoded {
  return encodeValue(WEIGHT_DEF, input, { currency: 'XXX' });
}

/** {length, width, height, unit} or "120 x 60 x 75 cm". */
export function encodeDimensions(input: unknown): Encoded {
  if (input === null || input === undefined || input === '') return ok(null);
  let raw: Record<string, unknown>;
  if (typeof input === 'string') {
    const m =
      /^\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(
        input,
      );
    if (!m) return fail('Use length × width × height and a unit, such as "120 x 60 x 75 cm".');
    raw = { length: m[1], width: m[2], height: m[3], unit: m[4] };
  } else if (typeof input === 'object' && !Array.isArray(input)) {
    raw = input as Record<string, unknown>;
  } else {
    return fail('Use {length, width, height, unit}.');
  }
  const unit = typeof raw.unit === 'string' ? raw.unit.trim() : '';
  if (unitKind(unit) !== 'length') return fail('Use a length unit: mm, cm, m, in, or ft.');
  const out: Record<string, unknown> = { unit };
  const canonical: Record<string, string> = {};
  for (const side of ['length', 'width', 'height'] as const) {
    const v = typeof raw[side] === 'number' ? String(raw[side]) : raw[side];
    if (typeof v !== 'string' || !isDecimal(v.trim()) || v.trim().startsWith('-')) {
      return fail(`${side} must be a positive number.`);
    }
    out[side] = normalize(v.trim());
    canonical[side] = toCanonical(out[side] as string, unit);
  }
  out.canonical = canonical;
  return ok(out);
}

function measurementComparable(v: unknown): string {
  return comparable({ type: 'measurement' }, v);
}

function dimensionsComparable(v: unknown): string {
  if (!v || typeof v !== 'object') return 'null';
  const d = v as Record<string, string>;
  return JSON.stringify(
    [d.length, d.width, d.height, d.unit].map((x) => (x && isDecimal(x) ? normalize(x) : x)),
  );
}

function text(min: number, max: number, nullable: boolean) {
  return (input: unknown): Encoded => {
    if (input === null || input === undefined)
      return nullable ? ok(null) : fail('A value is required.');
    if (typeof input !== 'string') return fail('Use text.');
    const t = input.trim();
    if (t === '' && nullable) return ok(null);
    if (t.length < min) return fail('A value is required.');
    if (t.length > max) return fail(`At most ${max} characters.`);
    return ok(t);
  };
}

export function encodeTags(input: unknown): Encoded {
  if (input === null || input === undefined) return ok([]);
  const list = typeof input === 'string' ? input.split(',') : input;
  if (!Array.isArray(list)) return fail('Use a list of tags.');
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') return fail('Tags are text.');
    const tag = item.trim().replace(/\s+/g, ' ');
    if (!tag) continue;
    if (tag.length > 100) return fail('A tag has at most 100 characters.');
    if (!out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  if (out.length > 50) return fail('At most 50 tags.');
  return ok(out);
}

export function encodePrice(input: unknown): Encoded {
  if (input === null || input === undefined || input === '') return ok(null);
  const t =
    typeof input === 'number' ? String(input) : typeof input === 'string' ? input.trim() : '';
  if (!isDecimal(t) || t.startsWith('-')) return fail('Use a price such as 19.90.');
  // Stored prices read back with trailing zeros ("5.000000"); only significant places count.
  const n = normalize(t);
  if (decimalScale(n) > 4) return fail('At most 4 decimal places.');
  if (n.replace('.', '').replace(/^0+/, '').length > 18) return fail('Too large.');
  return ok(n);
}

export const BUILTIN_FIELDS: BuiltinField[] = [
  {
    key: 'name',
    level: 'product',
    column: 'name',
    kind: 'text',
    encode: text(1, 500, false),
    comparable: plain,
  },
  {
    key: 'description',
    level: 'product',
    column: 'description',
    kind: 'text',
    encode: text(0, FIELD_LIMITS.richTextLength, true),
    comparable: plain,
  },
  {
    key: 'status',
    level: 'product',
    column: 'status',
    kind: 'text',
    encode: (v) =>
      v === 'draft' || v === 'active'
        ? ok(v)
        : fail('Use draft or active; archive with its own action.'),
    comparable: plain,
  },
  {
    key: 'family',
    level: 'product',
    column: 'family_id',
    kind: 'text',
    encode: (v) =>
      v === null || v === undefined || v === ''
        ? ok(null)
        : typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v)
          ? ok(v)
          : fail('Use a family ID.'),
    comparable: plain,
  },
  {
    key: 'tags',
    level: 'product',
    column: 'tags',
    kind: 'array',
    encode: encodeTags,
    comparable: (v) =>
      JSON.stringify(((v as string[] | null) ?? []).map((t) => t.toLowerCase()).sort()),
  },
  {
    key: 'weight',
    level: 'both',
    column: 'weight',
    kind: 'json',
    encode: encodeWeight,
    comparable: measurementComparable,
  },
  {
    key: 'dimensions',
    level: 'both',
    column: 'dimensions',
    kind: 'json',
    encode: encodeDimensions,
    comparable: dimensionsComparable,
  },
  {
    key: 'sku',
    level: 'variant',
    column: 'sku',
    kind: 'text',
    encode: text(1, 100, false),
    comparable: (v) => JSON.stringify(typeof v === 'string' ? normalizeSku(v) : v),
  },
  {
    key: 'price',
    level: 'variant',
    column: 'price',
    kind: 'text',
    encode: encodePrice,
    comparable: (v) => (typeof v === 'string' && isDecimal(v) ? normalize(v) : plain(v)),
  },
  {
    key: 'baseUnit',
    level: 'variant',
    column: 'base_unit',
    kind: 'text',
    encode: text(1, 20, false),
    comparable: plain,
  },
  {
    key: 'quantityScale',
    level: 'variant',
    column: 'quantity_scale',
    kind: 'number',
    encode: (v) => {
      const n = typeof v === 'string' ? Number(v) : v;
      return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6
        ? ok(n)
        : fail('Use 0 to 6.');
    },
    comparable: plain,
  },
  {
    key: 'trackingMode',
    level: 'variant',
    column: 'tracking_mode',
    kind: 'text',
    encode: (v) => (v === 'none' ? ok('none') : fail('Lot and serial tracking arrive in Phase 2.')),
    comparable: plain,
  },
];

export function builtin(key: string, recordType: RecordType): BuiltinField | undefined {
  return BUILTIN_FIELDS.find(
    (f) => f.key === key && (f.level === recordType || f.level === 'both'),
  );
}

// Reading ------------------------------------------------------------------------------------

export interface FieldValue {
  value: unknown;
  display: string | null;
  /** own: set on this record; inherited: from the product; cleared: explicitly empty on the variant. */
  source: 'own' | 'inherited' | 'cleared' | 'none';
}

export interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'archived';
  family_id: string | null;
  tags: string[];
  attributes: Record<string, unknown>;
  weight: unknown;
  dimensions: unknown;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  price: string | null;
  base_unit: string;
  quantity_scale: number;
  tracking_mode: string;
  is_default: boolean;
  status: 'active' | 'archived';
  option_value_ids: string[];
  attributes: Record<string, unknown>;
  weight: unknown;
  dimensions: unknown;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface OptionRow {
  id: string;
  name: string;
  position: number;
  values: Array<{ id: string; label: string; position: number }>;
}

export const PRODUCT_COLUMNS = `id, name, description, status, family_id, tags, attributes, weight, dimensions,
  version, created_at, updated_at`;
/**
 * The pg driver reads SQL NULL and JSON null both as null, so a variant's explicitly cleared weight
 * or dimensions (JSON null) is read as the string 'cleared'; SQL NULL (inherit) stays null.
 */
export const VARIANT_COLUMNS = `id, product_id, sku, price::text as price, base_unit, quantity_scale, tracking_mode,
  is_default, status, option_value_ids, attributes,
  case when weight = 'null'::jsonb then to_jsonb('cleared'::text) else weight end as weight,
  case when dimensions = 'null'::jsonb then to_jsonb('cleared'::text) else dimensions end as dimensions,
  version, created_at, updated_at`;

/** A variant's weight or dimensions: its own, cleared, or inherited from the product. */
export function inheritableValue(own: unknown, productValue: unknown): FieldValue {
  if (own === 'cleared') return { value: null, display: null, source: 'cleared' };
  const { value, source } = variantValue(
    own !== null && own !== undefined,
    own,
    productValue,
    true,
  );
  return { value, display: null, source };
}

export async function loadOptions(tx: Tx, productId: string): Promise<OptionRow[]> {
  return tx.query<OptionRow>(
    `select o.id, o.name, o.position,
       coalesce((select json_agg(json_build_object('id', v.id, 'label', v.label, 'position', v.position)
           order by v.position, v.id)
         from product_option_values v where v.shop_id = o.shop_id and v.option_id = o.id), '[]') as values
     from product_options o where o.product_id = $1 order by o.position`,
    [productId],
  );
}

/** A variant's own value, the product's, or nothing: the three states of an inherited field. */
export function variantValue(
  ownKeyPresent: boolean,
  own: unknown,
  productValue: unknown,
  inheritable: boolean,
): { value: unknown; source: FieldValue['source'] } {
  if (ownKeyPresent)
    return own === null ? { value: null, source: 'cleared' } : { value: own, source: 'own' };
  if (inheritable && productValue !== null && productValue !== undefined) {
    return { value: productValue, source: 'inherited' };
  }
  return { value: null, source: 'none' };
}

/**
 * The effective value of a custom field on a record, for display and compare-and-set. Relations
 * are keyed `${fieldId}:${recordId}`.
 */
export function effectiveCustom(
  def: FieldDefinition,
  recordType: RecordType,
  recordId: string,
  product: Pick<ProductRow, 'attributes'>,
  variant: Pick<VariantRow, 'attributes'> | null,
  relations: Map<string, string[]>,
): FieldValue {
  if (def.type === 'relationship') {
    const value = relations.get(`${def.id}:${recordId}`) ?? null;
    return { value, display: displayValue(def, value), source: value ? 'own' : 'none' };
  }
  if (recordType === 'product') {
    const value = product.attributes[def.id] ?? null;
    return { value, display: displayValue(def, value), source: value === null ? 'none' : 'own' };
  }
  const { value, source } = variantValue(
    def.id in variant!.attributes,
    variant!.attributes[def.id],
    product.attributes[def.id],
    def.level === 'both',
  );
  return { value, display: displayValue(def, value), source };
}

export function variantTitle(options: OptionRow[], valueIds: string[]): string {
  const labels = options
    .map((o) => o.values.find((v) => valueIds.includes(v.id))?.label)
    .filter((l): l is string => Boolean(l));
  return labels.join(' / ');
}

export function attributesSize(attributes: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(attributes)).length;
}
