import type { ops } from '@airstock/core';
import type { Out } from '../api.ts';

/** A pick list as the API returns it, and helpers shared by the page, the phone, and the PDF. */
export type PickListView = Out<typeof ops.getPickList>;
export type PickLineView = PickListView['pickLines'][number];

/** "(1 Case + 1)" for a line whose quantity fills whole packs; empty when it does not. */
export function linePacks(line: Pick<PickLineView, 'inPacks'>): string {
  const { packs, looseUnits } = line.inPacks;
  if (packs.length === 0) return '';
  const parts = packs.map((p) => `${p.count} ${p.name}`);
  if (looseUnits !== '0') parts.push(looseUnits);
  return `(${parts.join(' + ')})`;
}

/** Lines grouped by location, in walk order (the API sorts them by location path). */
export function sectionsOf(
  lines: PickLineView[],
): Array<{ path: string; locationId: string; lines: PickLineView[] }> {
  const out: Array<{ path: string; locationId: string; lines: PickLineView[] }> = [];
  for (const line of lines) {
    const last = out.at(-1);
    if (last && last.locationId === line.locationId) last.lines.push(line);
    else out.push({ path: line.locationPath, locationId: line.locationId, lines: [line] });
  }
  return out;
}

type Completed = Out<typeof ops.completePickList>;

const RECORDED: Record<Completed['recordedOnly'][number]['reason'], string> = {
  shopify: 'Shopify order(s) recorded, fulfilled from Shopify',
  not_fulfilling: 'order(s) recorded without fulfilling',
  bundle_incomplete: 'bundle order(s) not fulfilled: some components are not on this list',
  expired: 'expired reservation(s) not fulfilled: their units are available again',
  not_open: 'order(s) released or fulfilled in the meantime',
};

/** What completion recorded without fulfilling, grouped by why: "2 Shopify order(s) recorded…". */
export function recordedSummary(recordedOnly: Completed['recordedOnly']): string[] {
  const counts = new Map<keyof typeof RECORDED, number>();
  for (const r of recordedOnly) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => `${n} ${RECORDED[reason]}`);
}
