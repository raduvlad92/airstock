/**
 * Exact decimal arithmetic on strings, for unit conversion and comparisons in TypeScript. Values
 * never pass through binary floating point (PRD 4.2); stock arithmetic stays in PostgreSQL.
 */

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

interface Scaled {
  units: bigint;
  scale: number;
}

export function isDecimal(value: string): boolean {
  return DECIMAL.test(value);
}

function parse(value: string): Scaled {
  if (!DECIMAL.test(value)) throw new Error(`Not a decimal: ${value}`);
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const units = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
  return { units, scale: fraction.length };
}

function rescale(a: Scaled, scale: number): bigint {
  return a.units * 10n ** BigInt(scale - a.scale);
}

/** Rounds half away from zero to `scale` places and drops trailing zeros. */
function format(units: bigint, scale: number, places: number): string {
  let value = units;
  let s = scale;
  if (s > places) {
    const divisor = 10n ** BigInt(s - places);
    const half = divisor / 2n;
    value = value >= 0n ? (value + half) / divisor : (value - half) / divisor;
    s = places;
  }
  const negative = value < 0n;
  let digits = (negative ? -value : value).toString().padStart(s + 1, '0');
  let out = s > 0 ? `${digits.slice(0, -s)}.${digits.slice(-s)}` : digits;
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  digits = out;
  return negative && digits !== '0' ? `-${digits}` : digits;
}

export function decimalScale(value: string): number {
  const dot = value.indexOf('.');
  return dot === -1 ? 0 : value.length - dot - 1;
}

/** a × b, rounded to `places` decimal places. */
export function multiply(a: string, b: string, places = 6): string {
  const x = parse(a);
  const y = parse(b);
  return format(x.units * y.units, x.scale + y.scale, places);
}

/** a ÷ b, rounded to `places` decimal places. */
export function divide(a: string, b: string, places = 6): string {
  const x = parse(a);
  const y = parse(b);
  if (y.units === 0n) throw new Error('Division by zero');
  // Scale the numerator so the quotient keeps places + 1 digits before rounding.
  const extra = places + 1 + y.scale;
  const numerator = x.units * 10n ** BigInt(extra);
  return format(numerator / y.units, x.scale + extra - y.scale, places);
}

export function add(a: string, b: string): string {
  const x = parse(a);
  const y = parse(b);
  const scale = Math.max(x.scale, y.scale);
  return format(rescale(x, scale) + rescale(y, scale), scale, scale);
}

export function subtract(a: string, b: string): string {
  return add(a, b.startsWith('-') ? b.slice(1) : `-${b}`);
}

/** -1, 0, or 1. */
export function compare(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  const scale = Math.max(x.scale, y.scale);
  const d = rescale(x, scale) - rescale(y, scale);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/** Canonical text: no trailing zeros, no negative zero. */
export function normalize(value: string): string {
  const x = parse(value);
  return format(x.units, x.scale, x.scale);
}

/** True when `value` is an integer multiple of 10^-scale (fits the quantity scale). */
export function fitsScale(value: string, scale: number): boolean {
  return decimalScale(normalize(value)) <= scale;
}
