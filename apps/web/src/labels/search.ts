import { LABEL_LIMITS, type LabelKind } from '@airstock/core/labels';

/** The labels page's URL search: what the products grid and the barcode editor link to. */
export interface LabelsSearch {
  /** Comma-separated variant IDs, each optionally followed by ":" and a pack ID. */
  variants?: string;
  kind?: LabelKind;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseLabelsSearch(search: Record<string, unknown>): LabelsSearch {
  const out: LabelsSearch = {};
  if (typeof search.variants === 'string') {
    const valid = search.variants
      .split(',')
      .filter(
        (entry) => entry.split(':').every((id) => UUID.test(id)) && entry.split(':').length <= 2,
      );
    if (valid.length) out.variants = valid.slice(0, LABEL_LIMITS.entries).join(',');
  }
  if (search.kind === 'location' || search.kind === 'item') out.kind = search.kind;
  return out;
}
