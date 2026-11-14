import { z } from 'zod';
import { UUID_PATTERN } from './ids.ts';

export const Id = z.string().regex(UUID_PATTERN, 'Must be a lowercase UUID.');
export const Timestamp = z.string().describe('ISO 8601 timestamp in UTC.');
export const DecimalString = z.string().describe('Exact decimal as a string.');

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** SKU uniqueness rule (PRD 4.1): trim, collapse inner whitespace, upper case. */
export function normalizeSku(sku: string): string {
  return sku.trim().replace(/\s+/g, ' ').toUpperCase();
}

export const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();
