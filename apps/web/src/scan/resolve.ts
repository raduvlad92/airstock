import type { ops } from '@airstock/core';
import { api, type Out } from '../api.ts';

/**
 * What a scanned code stands for, from the server's scan lookup (warehouse.scan.lookup): a
 * location label or code, a variant or pack barcode, a serial or certificate number, or a SKU.
 * Each lookup is one logged read.
 */
export type ScanLookup = Out<typeof ops.scanLookup>;
export type ScanItem = NonNullable<ScanLookup['item']>;
export type ScanLocation = NonNullable<ScanLookup['location']>;
export type ScanStock = NonNullable<ScanLookup['stock']>;

export type Resolved =
  | { kind: 'location'; code: string; location: ScanLocation }
  | { kind: 'item'; code: string; item: ScanItem; stock: ScanStock | null }
  | { kind: 'unknown'; code: string };

export async function resolveScan(shopId: string, code: string): Promise<Resolved> {
  const found = await api<ScanLookup>(`/shops/${shopId}/scan`, { query: { code: code.trim() } });
  if (found.kind === 'location' && found.location) {
    return { kind: 'location', code: found.code, location: found.location };
  }
  if (found.kind === 'item' && found.item) {
    return { kind: 'item', code: found.code, item: found.item, stock: found.stock };
  }
  return { kind: 'unknown', code: found.code };
}

/** "3 × Case (6) = 18 units": the quantity and pack, shown before every commit. */
export function describeQuantity(
  quantity: string,
  pack: { name: string; baseQuantity: string } | null,
  base: (q: string) => string,
): string {
  if (!pack) return `${quantity} ${quantity === '1' ? 'unit' : 'units'}`;
  return `${quantity} × ${pack.name} (${pack.baseQuantity}) = ${base(quantity)} units`;
}
