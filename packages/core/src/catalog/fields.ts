import { compare, decimalScale, isDecimal, normalize } from './decimal.ts';
import { toCanonical, UNIT_KINDS, UNITS, type UnitKind, unitKind } from './units.ts';

/**
 * Custom field types and the one value encoder every write path uses: dashboard, API, MCP, and
 * import (plan Section 5.2, ADR 0012). Pure functions with no dependencies, so the dashboard can
 * run the same checks before it sends anything.
 */
export const FIELD_TYPES = [
  'text',
  'rich_text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'timestamp',
  'single_select',
  'multi_select',
  'money',
  'measurement',
  'file',
  'relationship',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_LEVELS = ['product', 'variant', 'both'] as const;
export type FieldLevel = (typeof FIELD_LEVELS)[number];

export const RELATION_TARGETS = ['product', 'variant'] as const;

/** Validation rules by type. Every property is optional in input; defaults apply. */
export interface FieldConfig {
  /** text, rich_text */
  maxLength?: number;
  /** integer, decimal, money, measurement (on the entered value) */
  min?: string;
  max?: string;
  /** decimal, money: decimal places allowed */
  scale?: number;
  /** measurement */
  unitKind?: UnitKind;
  defaultUnit?: string;
  /** multi_select, file, relationship */
  maxItems?: number;
  /** relationship: what the related records are and what the relation means */
  targetType?: 'product' | 'variant';
  relationKind?: string;
  /** file: which media are accepted */
  accept?: 'images' | 'documents' | 'any';
}

export interface FieldOption {
  id: string;
  label: string;
  position: number;
  archived: boolean;
}

export interface FieldDefinition {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  level: FieldLevel;
  config: FieldConfig;
  defaultValue: unknown;
  visibility: 'everyone' | 'restricted';
  status: 'active' | 'archived';
  isSystem: boolean;
  version: number;
  options: FieldOption[];
}

/** Limits (plan Section 5.2), visible in describe_catalog. */
export const FIELD_LIMITS = {
  activeFieldsPerShop: 300,
  optionsPerSelectField: 500,
  attributeBytesPerRecord: 32 * 1024,
  textLength: 10_000,
  richTextLength: 50_000,
  multiSelectItems: 50,
  fileItems: 50,
  relationItems: 500,
} as const;

/** Keys of built-in record fields; a custom field cannot use them. */
export const RESERVED_KEYS = new Set([
  'id',
  'name',
  'description',
  'status',
  'family',
  'tags',
  'sku',
  'price',
  'weight',
  'dimensions',
  'base_unit',
  'quantity_scale',
  'tracking_mode',
  'options',
  'option_values',
  'barcode',
  'barcodes',
  'has_picture',
  'has_shipping_package',
  'has_barcode',
  'supplier_sku',
  'packs',
  'media',
  'stock',
  'created_at',
  'updated_at',
  'version',
]);

export type Encoded = { ok: true; value: unknown } | { ok: false; message: string };

export interface EncodeContext {
  /** The shop's currency; money values must use it (V0). */
  currency: string;
  /** The record's current stored value, so an archived option it already has stays allowed. */
  current?: unknown;
}

const ok = (value: unknown): Encoded => ({ ok: true, value });
const fail = (message: string): Encoded => ({ ok: false, message });

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

function isValidDate(text: string): boolean {
  const m = DATE.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === text;
}

function decimalInput(input: unknown): string | null {
  if (typeof input === 'number' && Number.isFinite(input)) return normalize(String(input));
  if (typeof input === 'string') {
    const text = input.trim().replace(/^\+/, '');
    if (isDecimal(text)) return normalize(text);
  }
  return null;
}

function checkRange(value: string, config: FieldConfig): string | null {
  if (config.min !== undefined && compare(value, config.min) < 0)
    return `Must be at least ${config.min}.`;
  if (config.max !== undefined && compare(value, config.max) > 0)
    return `Must be at most ${config.max}.`;
  return null;
}

function optionFor(
  def: FieldDefinition,
  input: unknown,
  current: Set<string>,
): FieldOption | string {
  if (typeof input !== 'string' || input.trim() === '') return 'Choose an option.';
  const text = input.trim();
  const option =
    def.options.find((o) => o.id === text) ??
    def.options.find((o) => !o.archived && o.label.toLowerCase() === text.toLowerCase()) ??
    def.options.find((o) => o.label.toLowerCase() === text.toLowerCase());
  if (!option) return `"${text}" is not an option of ${def.label}.`;
  if (option.archived && !current.has(option.id)) return `"${option.label}" is archived.`;
  return option;
}

function currentIds(current: unknown): Set<string> {
  if (typeof current === 'string') return new Set([current]);
  if (Array.isArray(current))
    return new Set(current.filter((v): v is string => typeof v === 'string'));
  return new Set();
}

function idList(input: unknown, max: number, what: string): Encoded {
  const list = typeof input === 'string' ? [input] : input;
  if (!Array.isArray(list)) return fail(`Use a list of ${what} IDs.`);
  const ids = [...new Set(list.map((v) => (typeof v === 'string' ? v.trim() : v)))];
  if (!ids.every((v): v is string => typeof v === 'string' && UUID.test(v)))
    return fail(`Use ${what} IDs.`);
  if (ids.length > max) return fail(`At most ${max} items.`);
  return ok(ids);
}

/** Parses "1.2 kg" or {value, unit}. */
function measurementInput(input: unknown): { value: string; unit: string } | null {
  if (typeof input === 'string') {
    const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*(.+?)\s*$/.exec(input);
    if (!m) return null;
    const value = decimalInput(m[1]);
    return value === null ? null : { value, unit: m[2]! };
  }
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const value = decimalInput(o.value);
    return value !== null && typeof o.unit === 'string' ? { value, unit: o.unit.trim() } : null;
  }
  return null;
}

/**
 * Validates `input` against the definition and returns the stored form. Null (or an empty string
 * or list) means no value. Accepts the forms people and imports send: option labels as well as
 * IDs, numbers as strings, "1.2 kg" for measurements, yes/no for booleans.
 */
export function encodeValue(def: FieldDefinition, input: unknown, ctx: EncodeContext): Encoded {
  if (input === null || input === undefined) return ok(null);
  if (
    typeof input === 'string' &&
    input.trim() === '' &&
    def.type !== 'text' &&
    def.type !== 'rich_text'
  )
    return ok(null);
  if (Array.isArray(input) && input.length === 0) return ok(null);
  const c = def.config;
  switch (def.type) {
    case 'text':
    case 'rich_text': {
      if (typeof input !== 'string') return fail('Use text.');
      const limit =
        c.maxLength ??
        (def.type === 'text' ? FIELD_LIMITS.textLength : FIELD_LIMITS.richTextLength);
      const text = def.type === 'text' ? input.trim() : input.replace(/\s+$/, '');
      if (text === '') return ok(null);
      if (text.length > limit) return fail(`At most ${limit} characters.`);
      return ok(text);
    }
    case 'integer': {
      const n =
        typeof input === 'number'
          ? input
          : typeof input === 'string' && /^\s*[+-]?\d+\s*$/.test(input)
            ? Number(input)
            : Number.NaN;
      if (!Number.isSafeInteger(n)) return fail('Use a whole number.');
      const range = checkRange(String(n), c);
      return range ? fail(range) : ok(n);
    }
    case 'decimal': {
      const value = decimalInput(input);
      if (value === null) return fail('Use a number such as 12.5.');
      const scale = c.scale ?? 2;
      if (decimalScale(value) > scale) return fail(`At most ${scale} decimal places.`);
      const range = checkRange(value, c);
      return range ? fail(range) : ok(value);
    }
    case 'boolean': {
      if (typeof input === 'boolean') return ok(input);
      if (typeof input === 'string') {
        const t = input.trim().toLowerCase();
        if (['true', 'yes', '1', 'y'].includes(t)) return ok(true);
        if (['false', 'no', '0', 'n'].includes(t)) return ok(false);
      }
      return fail('Use true or false.');
    }
    case 'date': {
      if (typeof input !== 'string' || !isValidDate(input.trim()))
        return fail('Use a date as YYYY-MM-DD.');
      return ok(input.trim());
    }
    case 'timestamp': {
      if (typeof input !== 'string' || !TIMESTAMP_ZONE.test(input.trim()))
        return fail('Use an ISO 8601 time with a time zone, such as 2026-11-15T10:00:00Z.');
      const ms = Date.parse(input.trim());
      if (Number.isNaN(ms)) return fail('Not a valid time.');
      return ok(new Date(ms).toISOString());
    }
    case 'single_select': {
      const option = optionFor(def, input, currentIds(ctx.current));
      return typeof option === 'string' ? fail(option) : ok(option.id);
    }
    case 'multi_select': {
      const list = typeof input === 'string' ? input.split(/\s*[;|]\s*/).filter(Boolean) : input;
      if (!Array.isArray(list)) return fail('Use a list of options.');
      const current = currentIds(ctx.current);
      const chosen: FieldOption[] = [];
      for (const item of list) {
        const option = optionFor(def, item, current);
        if (typeof option === 'string') return fail(option);
        if (!chosen.some((o) => o.id === option.id)) chosen.push(option);
      }
      const max = c.maxItems ?? FIELD_LIMITS.multiSelectItems;
      if (chosen.length > max) return fail(`At most ${max} options.`);
      // Stored in option order, so equal sets compare equal.
      return ok(chosen.sort((a, b) => a.position - b.position).map((o) => o.id));
    }
    case 'money': {
      const raw =
        input && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : { amount: input };
      const amount = decimalInput(raw.amount);
      if (amount === null) return fail('Use an amount such as 12.50.');
      const currency = typeof raw.currency === 'string' ? raw.currency.toUpperCase() : ctx.currency;
      if (currency !== ctx.currency) return fail(`Use the shop currency, ${ctx.currency}.`);
      const scale = c.scale ?? 2;
      if (decimalScale(amount) > scale) return fail(`At most ${scale} decimal places.`);
      const range = checkRange(amount, c);
      return range ? fail(range) : ok({ amount, currency });
    }
    case 'measurement': {
      const m = measurementInput(input);
      if (!m) return fail('Use a value and a unit, such as "1.2 kg".');
      const kind = unitKind(m.unit);
      if (!kind || (c.unitKind && kind !== c.unitKind)) {
        const allowed = Object.keys(UNITS[c.unitKind ?? 'weight']).join(', ');
        return fail(`Use one of these units: ${allowed}.`);
      }
      const range = checkRange(m.value, c);
      if (range) return fail(range);
      return ok({ value: m.value, unit: m.unit, canonical: toCanonical(m.value, m.unit) });
    }
    case 'file':
      return idList(input, c.maxItems ?? FIELD_LIMITS.fileItems, 'media');
    case 'relationship':
      return idList(input, c.maxItems ?? FIELD_LIMITS.relationItems, c.targetType ?? 'record');
  }
}

/** The stored form with set order removed, for compare-and-set (D3). */
export function comparable(def: Pick<FieldDefinition, 'type'>, value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (def.type === 'measurement' && typeof value === 'object') {
    const m = value as { value: string; unit: string };
    return JSON.stringify([normalize(m.value), m.unit]);
  }
  if (def.type === 'money' && typeof value === 'object') {
    const m = value as { amount: string; currency: string };
    return JSON.stringify([normalize(m.amount), m.currency]);
  }
  if (def.type === 'decimal' && typeof value === 'string' && isDecimal(value))
    return normalize(value);
  if (
    (def.type === 'relationship' || def.type === 'file' || def.type === 'multi_select') &&
    Array.isArray(value)
  )
    return JSON.stringify([...value].sort());
  return JSON.stringify(value);
}

/** Human text for a stored value: option labels, "1.2 kg", "12.50 EUR". */
export function displayValue(def: FieldDefinition, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  switch (def.type) {
    case 'single_select':
      return def.options.find((o) => o.id === value)?.label ?? String(value);
    case 'multi_select':
      return (value as string[])
        .map((id) => def.options.find((o) => o.id === id)?.label ?? id)
        .join(', ');
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'money': {
      const m = value as { amount: string; currency: string };
      return `${m.amount} ${m.currency}`;
    }
    case 'measurement': {
      const m = value as { value: string; unit: string };
      return `${m.value} ${m.unit}`;
    }
    case 'file':
    case 'relationship':
      return `${(value as string[]).length} linked`;
    default:
      return String(value);
  }
}

/** Valid configuration for a type, with defaults; a message when the input is not acceptable. */
export function normalizeConfig(type: FieldType, input: FieldConfig): FieldConfig | string {
  const c: FieldConfig = {};
  const num = (v: string | undefined, what: string): string | null => {
    if (v === undefined) return null;
    if (!isDecimal(String(v))) throw new Error(`${what} must be a number.`);
    return normalize(String(v));
  };
  try {
    switch (type) {
      case 'text':
      case 'rich_text': {
        const limit = type === 'text' ? FIELD_LIMITS.textLength : FIELD_LIMITS.richTextLength;
        const max = input.maxLength ?? limit;
        if (!Number.isInteger(max) || max < 1 || max > limit)
          return `maxLength must be 1 to ${limit}.`;
        c.maxLength = max;
        break;
      }
      case 'integer':
      case 'decimal':
      case 'money': {
        const min = num(input.min, 'min');
        const max = num(input.max, 'max');
        if (min !== null) c.min = min;
        if (max !== null) c.max = max;
        if (min !== null && max !== null && compare(min, max) > 0)
          return 'min is greater than max.';
        if (type !== 'integer') {
          const scale = input.scale ?? (type === 'money' ? 2 : 2);
          if (!Number.isInteger(scale) || scale < 0 || scale > 6) return 'scale must be 0 to 6.';
          c.scale = scale;
        }
        break;
      }
      case 'measurement': {
        const kind = input.unitKind;
        if (!kind || !(UNIT_KINDS as readonly string[]).includes(kind))
          return `unitKind must be one of ${UNIT_KINDS.join(', ')}.`;
        c.unitKind = kind;
        const unit = input.defaultUnit ?? Object.keys(UNITS[kind])[0]!;
        if (!(unit in UNITS[kind])) return `defaultUnit must be a ${kind} unit.`;
        c.defaultUnit = unit;
        const min = num(input.min, 'min');
        const max = num(input.max, 'max');
        if (min !== null) c.min = min;
        if (max !== null) c.max = max;
        break;
      }
      case 'multi_select': {
        const max = input.maxItems ?? FIELD_LIMITS.multiSelectItems;
        if (!Number.isInteger(max) || max < 1 || max > FIELD_LIMITS.multiSelectItems)
          return `maxItems must be 1 to ${FIELD_LIMITS.multiSelectItems}.`;
        c.maxItems = max;
        break;
      }
      case 'file': {
        const max = input.maxItems ?? 10;
        if (!Number.isInteger(max) || max < 1 || max > FIELD_LIMITS.fileItems)
          return `maxItems must be 1 to ${FIELD_LIMITS.fileItems}.`;
        c.maxItems = max;
        c.accept = input.accept ?? 'any';
        break;
      }
      case 'relationship': {
        c.targetType = input.targetType ?? 'product';
        if (!(RELATION_TARGETS as readonly string[]).includes(c.targetType))
          return 'targetType must be product or variant.';
        const kind = (input.relationKind ?? 'related_to').trim();
        if (!/^[a-z][a-z0-9_]{0,49}$/.test(kind))
          return 'relationKind must be a slug such as compatible_with.';
        c.relationKind = kind;
        const max = input.maxItems ?? 100;
        if (!Number.isInteger(max) || max < 1 || max > FIELD_LIMITS.relationItems)
          return `maxItems must be 1 to ${FIELD_LIMITS.relationItems}.`;
        c.maxItems = max;
        break;
      }
      default:
        break;
    }
  } catch (error) {
    return (error as Error).message;
  }
  return c;
}

/**
 * Safe type changes (plan Section 5.2). Anything else needs a new field and an import-style copy.
 */
export const SAFE_CONVERSIONS: Record<string, FieldType[]> = {
  integer: ['decimal'],
  single_select: ['multi_select'],
  text: ['rich_text'],
  decimal: ['money', 'measurement'],
};

/** Converts one stored value for a safe type change. */
export function convertValue(
  from: FieldType,
  to: FieldType,
  value: unknown,
  opts: { currency: string; unit?: string },
): unknown {
  if (value === null || value === undefined) return value;
  if (from === 'integer' && to === 'decimal') return normalize(String(value));
  if (from === 'single_select' && to === 'multi_select') return [value];
  if (from === 'text' && to === 'rich_text') return value;
  if (from === 'decimal' && to === 'money') return { amount: value, currency: opts.currency };
  if (from === 'decimal' && to === 'measurement' && opts.unit) {
    return { value, unit: opts.unit, canonical: toCanonical(String(value), opts.unit) };
  }
  throw new Error(`Cannot convert ${from} to ${to}.`);
}
