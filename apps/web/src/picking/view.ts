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
