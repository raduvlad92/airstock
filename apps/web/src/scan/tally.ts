import { add, compare, multiply, normalize } from '@airstock/core/catalog/decimal';
import { formatDecimal } from '../components/ui.tsx';
import type { ScanItem, ScanStock } from './resolve.ts';

/**
 * A quantity being scanned in for one item (count, move, receive against a PO): each scan adds
 * one of what was scanned, a unit or a pack such as a case, and the person can type the number.
 * The pack is kept while every scan is of that pack; mixing a case with loose units switches the
 * tally to units, so it always reads as one exact quantity.
 */
export type Pack = ScanItem['packs'][number];

export interface Tally {
  pack: Pack | null;
  /** In the pack when one is set, otherwise in base units; as typed. */
  quantity: string;
}

export const DECIMAL = /^\d+(\.\d{1,6})?$/;

/** The typed quantity, or 0 while it is not a number yet. */
export function typed(quantity: string): string {
  return DECIMAL.test(quantity) ? quantity : '0';
}

export function baseUnits(t: Tally): string {
  const q = typed(t.quantity);
  return normalize(t.pack ? multiply(q, t.pack.baseQuantity) : q);
}

/** One more of what was scanned. A tally still at 0 takes the scanned pack. */
export function addScan(t: Tally, scanned: Pack | null): Tally {
  const q = typed(t.quantity);
  if (compare(q, '0') === 0) return { pack: scanned, quantity: '1' };
  if ((t.pack?.packId ?? null) === (scanned?.packId ?? null)) {
    return { pack: t.pack, quantity: normalize(add(q, '1')) };
  }
  // Mixed: count in units from now on.
  return {
    pack: null,
    quantity: normalize(add(baseUnits(t), scanned ? scanned.baseQuantity : '1')),
  };
}

/** Changes the pack the quantity is entered in, keeping the number typed. */
export function withPack(t: Tally, pack: Pack | null): Tally {
  return { ...t, pack };
}

export function step(t: Tally, delta: '1' | '-1', min = '0'): Tally {
  const next = normalize(add(typed(t.quantity), delta));
  return { ...t, quantity: compare(next, min) < 0 ? min : next };
}

/** "3 × Case (6) = 18 units", "1 unit": the quantity and pack, shown before every commit. */
export function describeTally(t: Tally): string {
  const base = baseUnits(t);
  const units = `${formatDecimal(base)} ${base === '1' ? 'unit' : 'units'}`;
  if (!t.pack) return units;
  return `${formatDecimal(typed(t.quantity))} × ${t.pack.name} (${formatDecimal(t.pack.baseQuantity)}) = ${units}`;
}

/** The stock positions of an item at one location, outside transit. */
export function positionsAt(stock: ScanStock | null, locationId: string) {
  return (stock?.positions ?? []).filter((p) => p.locationId === locationId && !p.inTransit);
}

/** Sum of on hand and reserved at one location (sellable stock), for "on record here". */
export function recordedAt(
  stock: ScanStock | null,
  locationId: string,
  lotCode?: string | null,
): { onHand: string; reserved: string; available: string } | null {
  if (!stock) return null;
  const here = positionsAt(stock, locationId).filter(
    (p) =>
      p.condition === 'sellable' &&
      (lotCode === undefined || lotCode === null || lotCode === ''
        ? true
        : (p.lotCode ?? '').toUpperCase() === lotCode.trim().toUpperCase()),
  );
  return here.reduce(
    (sum, p) => ({
      onHand: normalize(add(sum.onHand, p.onHand)),
      reserved: normalize(add(sum.reserved, p.reserved)),
      available: normalize(add(sum.available, p.available)),
    }),
    { onHand: '0', reserved: '0', available: '0' },
  );
}

/** The lot codes an item has at a location, in the order the stock read lists them. */
export function lotsAt(stock: ScanStock | null, locationId: string): string[] {
  return [
    ...new Set(
      positionsAt(stock, locationId)
        .map((p) => p.lotCode)
        .filter((c): c is string => c !== null),
    ),
  ];
}

export function isLotTracked(item: { trackingMode: string }): boolean {
  return item.trackingMode === 'lot' || item.trackingMode === 'lot_expiry';
}

export function sameCode(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}
