import { add, divide, multiply, subtract } from './decimal.ts';

/**
 * Measurement units (plan Section 5.3). Values keep the unit entered; a canonical value in grams,
 * millimetres, millilitres, or degrees Celsius is stored alongside for filtering and sorting.
 */
export const UNIT_KINDS = ['weight', 'length', 'volume', 'temperature'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** Exact factors to the canonical unit (international avoirdupois pound, inch, US fluid ounce). */
export const UNITS: Record<UnitKind, Record<string, string>> = {
  weight: { g: '1', kg: '1000', oz: '28.349523125', lb: '453.59237' },
  length: { mm: '1', cm: '10', m: '1000', in: '25.4', ft: '304.8' },
  volume: { ml: '1', l: '1000', 'fl oz': '29.5735295625' },
  temperature: { '°C': '1', '°F': '1' },
};

export const CANONICAL_UNIT: Record<UnitKind, string> = {
  weight: 'g',
  length: 'mm',
  volume: 'ml',
  temperature: '°C',
};

export const DISPLAY_UNITS: Record<'metric' | 'imperial', Record<UnitKind, string>> = {
  metric: { weight: 'kg', length: 'cm', volume: 'l', temperature: '°C' },
  imperial: { weight: 'lb', length: 'in', volume: 'fl oz', temperature: '°F' },
};

export function unitKind(unit: string): UnitKind | null {
  for (const kind of UNIT_KINDS) if (unit in UNITS[kind]) return kind;
  return null;
}

/** The value in the canonical unit of its kind, to 6 decimal places. */
export function toCanonical(value: string, unit: string): string {
  const kind = unitKind(unit);
  if (!kind) throw new Error(`Unknown unit ${unit}`);
  if (kind === 'temperature') {
    return unit === '°F'
      ? divide(multiply(subtract(value, '32'), '5', 12), '9')
      : multiply(value, '1');
  }
  return multiply(value, UNITS[kind][unit]!);
}

/** Converts a canonical value to `unit`, to 6 decimal places (for display). */
export function fromCanonical(canonical: string, unit: string): string {
  const kind = unitKind(unit);
  if (!kind) throw new Error(`Unknown unit ${unit}`);
  if (kind === 'temperature') {
    return unit === '°F'
      ? add(divide(multiply(canonical, '9', 12), '5'), '32')
      : multiply(canonical, '1');
  }
  return divide(canonical, UNITS[kind][unit]!);
}
