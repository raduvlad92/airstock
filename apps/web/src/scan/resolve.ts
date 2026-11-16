import type { ops } from '@airstock/core';
import { parseLocationCode } from '@airstock/core/barcodes';
import { api, type Out } from '../api.ts';

/**
 * What a scanned code stands for. A location label (LOC: and the location's ID) sets the current
 * location; a barcode names a variant or one of its packs; anything else is unknown, which the
 * page offers to attach or create.
 */
export type BarcodeMatch = NonNullable<Out<typeof ops.lookupBarcode>['match']>;
export type LocationRow = Out<typeof ops.listLocations>['locations'][number];

export type Resolved =
  | { kind: 'location'; code: string; location: LocationRow }
  | { kind: 'item'; code: string; match: BarcodeMatch }
  | { kind: 'unknown'; code: string; normalized: string };

export async function resolveScan(
  shopId: string,
  code: string,
  locations: () => Promise<LocationRow[]>,
): Promise<Resolved> {
  const text = code.trim();
  const locationId = parseLocationCode(text);
  if (locationId) {
    const location = (await locations()).find((l) => l.locationId === locationId);
    if (location) return { kind: 'location', code: text, location };
    return { kind: 'unknown', code: text, normalized: text.toUpperCase() };
  }
  const found = await api<Out<typeof ops.lookupBarcode>>(`/shops/${shopId}/barcodes/lookup`, {
    query: { code: text },
  });
  if (found.match) return { kind: 'item', code: text, match: found.match };
  // A typed location code ("A-03") also works, when no barcode has that text.
  const byCode = (await locations()).find(
    (l) => l.code && l.code.toUpperCase() === text.toUpperCase() && l.holdsStockAllowed,
  );
  if (byCode) return { kind: 'location', code: text, location: byCode };
  return { kind: 'unknown', code: text, normalized: found.normalized };
}
