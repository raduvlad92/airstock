import { z } from 'zod';

/**
 * Quantities and money travel as decimal strings and are computed in PostgreSQL numeric,
 * so no value passes through binary floating point (PRD 4.2).
 */
const DECIMAL_RE = /^(0|[1-9]\d{0,13})(\.\d{1,6})?$/;

export const PositiveDecimal = z
  .string()
  .regex(DECIMAL_RE, 'Use a decimal string such as "12" or "2.5", with at most 6 decimal places.')
  .refine((v) => /[1-9]/.test(v), 'Must be greater than zero.')
  .describe('Decimal string greater than zero, at most 14 integer digits and 6 decimal places.');

export const NonNegativeDecimal = z
  .string()
  .regex(DECIMAL_RE, 'Use a decimal string such as "12" or "2.5", with at most 6 decimal places.')
  .describe('Decimal string, zero or more, at most 14 integer digits and 6 decimal places.');

export function decimalScale(value: string): number {
  const dot = value.indexOf('.');
  return dot === -1 ? 0 : value.length - dot - 1;
}
