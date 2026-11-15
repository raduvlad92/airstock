import type { Tx } from '@airstock/db';

/**
 * Barcode rules (plan Section 5.4, PRD 4.7, ADR 0019). Pure functions, so the dashboard runs the
 * same checks (`@airstock/core/barcodes`), plus the owner lookup every create path uses to block a
 * duplicate.
 *
 * Uniqueness is on the normalized code, because a scanner reports text, not who printed it: GTINs
 * (EAN-13, EAN-8, UPC-A, or a digit string with a valid GTIN check digit in any symbology) are
 * padded to 14 digits, so UPC-A 036000291452 and EAN-13 0036000291452 are the same code. Every
 * other code is trimmed and upper-cased.
 */

export const SYMBOLOGIES = ['ean13', 'ean8', 'upca', 'code128', 'qr', 'other'] as const;
export type Symbology = (typeof SYMBOLOGIES)[number];

/** Symbologies "generate barcode" can produce. */
export const GENERATED_SYMBOLOGIES = ['code128', 'qr'] as const;
export type GeneratedSymbology = (typeof GENERATED_SYMBOLOGIES)[number];

export const SYMBOLOGY_LABELS: Record<Symbology, string> = {
  ean13: 'EAN-13',
  ean8: 'EAN-8',
  upca: 'UPC-A',
  code128: 'Code 128',
  qr: 'QR code',
  other: 'Other',
};

export const BARCODE_LIMITS = {
  codeLength: 200,
  code128Length: 80,
  perVariant: 50,
} as const;

const GTIN_DIGITS: Partial<Record<Symbology, number>> = { ean13: 13, ean8: 8, upca: 12 };

/** The GS1 check digit for the digits before it: weights 3, 1, 3, … from the right, mod 10. */
export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** An 8, 12, 13, or 14 digit string whose last digit is its GS1 check digit. */
export function isValidGtin(digits: string): boolean {
  if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) return false;
  return gtinCheckDigit(digits.slice(0, -1)) === Number(digits.at(-1));
}

/** How a typed, imported, or scanned code is matched against stored barcodes. */
export function normalizeBarcode(text: string): string {
  const t = text.trim();
  if (isValidGtin(t)) return t.padStart(14, '0');
  return t.toUpperCase();
}

export type BarcodeCheck =
  | { ok: true; code: string; normalized: string }
  | { ok: false; message: string };

/** Validates a code for its symbology; returns the code to store and its normalized form. */
export function checkBarcode(input: string, symbology: Symbology): BarcodeCheck {
  const fail = (message: string): BarcodeCheck => ({ ok: false, message });
  let code = input.trim();
  if (code === '') return fail('A barcode needs a value.');
  if (code.length > BARCODE_LIMITS.codeLength)
    return fail(`At most ${BARCODE_LIMITS.codeLength} characters.`);
  const digits = GTIN_DIGITS[symbology];
  if (digits) {
    // People type GTINs in groups ("4 006381 333931").
    code = code.replace(/[\s-]/g, '');
    const name = SYMBOLOGY_LABELS[symbology];
    if (!/^\d+$/.test(code)) return fail(`An ${name} has digits only.`);
    if (code.length !== digits) return fail(`An ${name} has ${digits} digits.`);
    const expected = gtinCheckDigit(code.slice(0, -1));
    if (expected !== Number(code.at(-1))) {
      return fail(`The check digit should be ${expected}. Check the number.`);
    }
  } else if (symbology === 'code128') {
    if (code.length > BARCODE_LIMITS.code128Length)
      return fail(`A Code 128 barcode holds at most ${BARCODE_LIMITS.code128Length} characters.`);
    if (!/^[\x20-\x7e]+$/.test(code))
      return fail('Code 128 takes letters, digits, spaces, and common symbols (ASCII).');
  }
  return { ok: true, code, normalized: normalizeBarcode(code) };
}

/** Generated internal codes: a prefix and the shop's sequence, never a URL (PRD 4.7). */
export const INTERNAL_CODE_PREFIX = 'AS';

export function internalCode(sequence: number | bigint | string): string {
  return `${INTERNAL_CODE_PREFIX}${String(sequence).padStart(8, '0')}`;
}

/** A location label's code: the location's ID, which stays the same when it is renamed. */
export function locationCode(locationId: string): string {
  return `LOC:${locationId.toUpperCase()}`;
}

/** The location ID in a scanned location code, or null. */
export function parseLocationCode(text: string): string | null {
  const m = /^LOC:([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})$/i.exec(
    text.trim(),
  );
  return m ? m[1]!.toLowerCase() : null;
}

export interface BarcodeOwner {
  barcodeId: string;
  code: string;
  symbology: Symbology;
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  packId: string | null;
  packName: string | null;
  /** Base units the scanned item stands for: the pack's base quantity, or 1. */
  baseQuantity: string;
}

/**
 * Who holds a normalized code in the current shop (row-level security limits it to that shop).
 * Every create path calls this before writing, so a duplicate is refused with a link to the
 * existing record; the unique index catches a concurrent insert.
 */
export async function findBarcodeOwner(tx: Tx, normalized: string): Promise<BarcodeOwner | null> {
  const [owner] = await findBarcodeOwners(tx, [normalized]);
  return owner ?? null;
}

export async function findBarcodeOwners(tx: Tx, normalized: string[]): Promise<BarcodeOwner[]> {
  if (normalized.length === 0) return [];
  const rows = await tx.query<{
    id: string;
    code: string;
    symbology: Symbology;
    variant_id: string;
    product_id: string;
    sku: string;
    product_name: string;
    pack_id: string | null;
    pack_name: string | null;
    base_quantity: string;
    code_normalized: string;
  }>(
    `select b.id, b.code, b.symbology, b.variant_id, v.product_id, v.sku, p.name as product_name,
       b.pack_id, k.name as pack_name, coalesce(k.base_quantity, 1::numeric(20, 6))::text as base_quantity,
       b.code_normalized
     from barcodes b
     join variants v on v.shop_id = b.shop_id and v.id = b.variant_id
     join products p on p.shop_id = v.shop_id and p.id = v.product_id
     left join packs k on k.shop_id = b.shop_id and k.id = b.pack_id
     where b.code_normalized = any($1::text[])`,
    [normalized],
  );
  const order = new Map(normalized.map((n, i) => [n, i]));
  return rows
    .sort((a, b) => order.get(a.code_normalized)! - order.get(b.code_normalized)!)
    .map((r) => ({
      barcodeId: r.id,
      code: r.code,
      symbology: r.symbology,
      variantId: r.variant_id,
      productId: r.product_id,
      sku: r.sku,
      productName: r.product_name,
      packId: r.pack_id,
      packName: r.pack_name,
      baseQuantity: r.base_quantity,
    }));
}
