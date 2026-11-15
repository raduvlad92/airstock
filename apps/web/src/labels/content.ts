import type { ops } from '@airstock/core';
import type { Symbology } from '@airstock/core/barcodes';
import type { LabelLayoutKey } from '@airstock/core/labels';
import type { Out } from '../api.ts';
import { formatDecimal } from '../components/ui.tsx';

/**
 * What goes on each printed label, built from `labels.items.render` or `labels.locations.render`
 * (ADR 0019). Pure, so the page can show it before the PDF code loads and tests can build it.
 */

export type ItemLabels = Out<typeof ops.renderItemLabels>;
export type LocationLabels = Out<typeof ops.renderLocationLabels>;

export interface PrintLabel {
  copies: number;
  /** The bold first lines: a product name or a location path. */
  title: string | null;
  /** Shorten the title from its start: a location path ends with the most specific part. */
  keepEnd?: boolean;
  lines: Array<{ text: string; strong?: boolean }>;
  barcode: { symbology: Symbology; code: string } | null;
}

export interface PrintJob {
  layout: LabelLayoutKey;
  labels: PrintLabel[];
  /** Positions already used on the first sheet, so a partly used sheet can be fed again. */
  skip?: number;
}

export function itemPrintLabels(data: ItemLabels): PrintLabel[] {
  const show = new Set(data.template.fields);
  return data.labels.map((l) => {
    const lines: PrintLabel['lines'] = [];
    for (const field of data.template.fields) {
      if (field === 'sku' && l.sku) lines.push({ text: l.sku });
      if (field === 'options' && l.options) lines.push({ text: l.options });
      if (field === 'pack' && l.pack) lines.push({ text: l.pack });
      if (field === 'price' && l.price !== null)
        lines.push({ text: `${formatDecimal(l.price, 2)} ${data.currency}`, strong: true });
    }
    return {
      copies: l.copies,
      title: show.has('name') ? l.name : null,
      lines,
      barcode: show.has('barcode') ? l.barcode : null,
    };
  });
}

export function locationPrintLabels(data: LocationLabels): PrintLabel[] {
  const show = new Set(data.template.fields);
  return data.labels.map((l) => {
    const lines: PrintLabel['lines'] = [];
    for (const field of data.template.fields) {
      if (field === 'code' && l.code) lines.push({ text: l.code, strong: true });
      if (field === 'warehouse') lines.push({ text: l.warehouse });
    }
    return {
      copies: l.copies,
      title: show.has('path') ? l.path : null,
      keepEnd: true,
      lines,
      barcode: show.has('barcode') ? l.barcode : null,
    };
  });
}
