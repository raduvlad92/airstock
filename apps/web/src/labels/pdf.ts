import { LABEL_LAYOUTS, type LabelLayout, type LabelLayoutKey } from '@airstock/core/labels';
import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  type PDFFont,
  type PDFName,
  type PDFPage,
  type PDFRef,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  StandardFonts,
} from 'pdf-lib';
import { type BarcodeBitmap, barcodeBitmap } from './barcode.ts';
import type { PrintJob, PrintLabel } from './content.ts';

/**
 * Label PDFs (D9, ADR 0019), drawn in the browser. The labels page loads this module with a
 * dynamic import, so bwip-js and pdf-lib stay out of the main bundle.
 *
 * Each barcode is one grey image XObject made by the rasterizer, embedded once and placed on
 * every copy. Text uses the standard Helvetica fonts, so nothing is downloaded or embedded.
 */

export { barcodeBitmap };

/** PDF user space is 1/72 inch. */
export const PT_PER_MM = 72 / 25.4;

/** Below these module widths (mm) a printed symbol stops scanning reliably. */
const MIN_MODULE = { linear: 0.19, matrix: 0.25 };
/** Above these, a symbol only wastes label space. */
const MAX_MODULE = { linear: 0.5, matrix: 1 };
const MAX_BAR_HEIGHT_MM = 22;
const MIN_FONT = 5;
const GAP_MM = 1;

export interface Metrics {
  /** Width in points of text in Helvetica (or Helvetica Bold) at a size. */
  width(text: string, size: number, bold: boolean): number;
  /** Replaces characters the standard fonts cannot draw. */
  clean(text: string): string;
}

/** Positions are label-local points from the label's top-left corner. */
export type DrawOp =
  | { kind: 'text'; x: number; baseline: number; size: number; bold: boolean; text: string }
  | {
      kind: 'barcode';
      key: string;
      x: number;
      top: number;
      width: number;
      height: number;
      bitmap: BarcodeBitmap;
      /** Module width in millimetres as placed. */
      moduleMm: number;
    };

export interface LabelPlan {
  ops: DrawOp[];
  /** The barcode is placed with modules narrower than a printer can render reliably. */
  dense: boolean;
  /** The code could not be encoded in its symbology. */
  failed: boolean;
}

interface Line {
  text: string;
  size: number;
  bold: boolean;
}

const ELLIPSIS = '…';

/** Shortens text to fit `fits`, from the end or (for paths) from the start. */
function ellipsize(text: string, fits: (s: string) => boolean, keepEnd: boolean): string {
  if (fits(text)) return text;
  let lo = 0;
  let hi = text.length;
  const cut = (n: number) =>
    keepEnd
      ? `${ELLIPSIS}${text.slice(text.length - n).trimStart()}`
      : `${text.slice(0, n).trimEnd()}${ELLIPSIS}`;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(cut(mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '' : cut(lo);
}

/** Greedy line breaks after spaces and slashes; lines keep their spacing so they join back. */
function breakLines(text: string, fits: (s: string) => boolean, fromEnd: boolean): string[] {
  const parts = text.split(/(?<=[\s/])/);
  const seq = fromEnd ? [...parts].reverse() : parts;
  const out: string[] = [];
  let current = '';
  for (const part of seq) {
    const next = fromEnd ? part + current : current + part;
    if (current === '' || fits(next.trim())) current = next;
    else {
      out.push(current);
      current = part;
    }
  }
  if (current) out.push(current);
  return fromEnd ? out.reverse() : out;
}

/** At most `maxLines` lines; the text that does not fit is cut with an ellipsis. */
export function wrapText(
  text: string,
  maxLines: number,
  fits: (s: string) => boolean,
  keepEnd = false,
): string[] {
  const raw = breakLines(text.trim(), fits, keepEnd);
  if (raw.length <= maxLines) return raw.map((l) => ellipsize(l.trim(), fits, keepEnd));
  const keep = maxLines - 1;
  if (keepEnd) {
    const rest = raw
      .slice(0, raw.length - keep)
      .join('')
      .trim();
    return [ellipsize(rest, fits, true), ...raw.slice(raw.length - keep).map((l) => l.trim())];
  }
  const rest = raw.slice(keep).join('').trim();
  return [...raw.slice(0, keep).map((l) => l.trim()), ellipsize(rest, fits, false)];
}

/** The text block at a base size: a title of up to two lines, then one line per field. */
function textLines(label: PrintLabel, size: number, width: number, m: Metrics): Line[] {
  const lines: Line[] = [];
  if (label.title) {
    const titleSize = size * 1.15;
    const fits = (s: string) => m.width(s, titleSize, true) <= width;
    for (const text of wrapText(m.clean(label.title), 2, fits, label.keepEnd))
      lines.push({ text, size: titleSize, bold: true });
  }
  for (const line of label.lines) {
    const bold = Boolean(line.strong);
    const text = m.clean(line.text);
    // A long line shrinks a little before it is cut.
    let s = size;
    while (m.width(text, s, bold) > width && s > Math.max(MIN_FONT, size * 0.85)) s -= 0.25;
    lines.push({
      text: ellipsize(text, (t) => m.width(t, s, bold) <= width, false),
      size: s,
      bold,
    });
  }
  return lines.filter((l) => l.text !== '');
}

const blockHeight = (lines: Line[]) => lines.reduce((h, l) => h + l.size * 1.2, 0);

/** The largest text block that fits `height`, shrinking the font and then dropping last lines. */
function fitText(label: PrintLabel, base: number, width: number, height: number, m: Metrics) {
  let lines: Line[] = [];
  for (let size = base; size >= MIN_FONT; size -= 0.5) {
    lines = textLines(label, size, width, m);
    if (blockHeight(lines) <= height) return lines;
  }
  while (lines.length > 0 && blockHeight(lines) > height) lines = lines.slice(0, -1);
  return lines;
}

/** Where everything on one label goes. Pure, so the preview and the PDF agree. */
export function planLabel(label: PrintLabel, layout: LabelLayout, m: Metrics): LabelPlan {
  const pt = PT_PER_MM;
  const left = layout.padding * pt;
  const top = layout.padding * pt;
  const width = (layout.labelWidth - 2 * layout.padding) * pt;
  const height = (layout.labelHeight - 2 * layout.padding) * pt;
  const base = Math.min(10, Math.max(6, layout.labelHeight * 0.24));
  const gap = GAP_MM * pt;
  const ops: DrawOp[] = [];
  let dense = false;
  let failed = false;

  let bitmap: BarcodeBitmap | null = null;
  if (label.barcode) {
    try {
      bitmap = barcodeBitmap(label.barcode.symbology, label.barcode.code);
    } catch {
      failed = true;
    }
  }
  const hasText = Boolean(label.title) || label.lines.length > 0;
  const placeText = (lines: Line[], x: number, y: number) => {
    let cursor = y;
    for (const l of lines) {
      ops.push({ kind: 'text', x, baseline: cursor + l.size * 0.9, ...l });
      cursor += l.size * 1.2;
    }
  };
  // The code in plain text under the symbol, when it fits whole.
  const readable = (code: string, x: number, symbolWidth: number) => {
    const size = Math.max(MIN_FONT, base * 0.8);
    const text = m.clean(code);
    const w = m.width(text, size, false);
    return w <= symbolWidth ? { text, size, x: x + (symbolWidth - w) / 2 } : null;
  };

  if (!bitmap || !label.barcode) {
    placeText(fitText(label, base, width, height, m), left, top);
    return { ops, dense, failed };
  }
  const key = `${label.barcode.symbology}:${label.barcode.code}`;

  if (bitmap.linear) {
    const module = Math.min(width / bitmap.modules, MAX_MODULE.linear * pt);
    const barWidth = module * bitmap.modules;
    const barX = left + (width - barWidth) / 2;
    const human = readable(label.barcode.code, barX, barWidth);
    const humanHeight = human ? human.size * 1.1 : 0;
    const minBars = Math.min(8 * pt, height * 0.4);
    const lines = hasText
      ? fitText(label, base, width, height - minBars - humanHeight - gap, m)
      : [];
    const textHeight = blockHeight(lines);
    const bars = Math.min(
      MAX_BAR_HEIGHT_MM * pt,
      height - humanHeight - (lines.length ? textHeight + gap : 0),
    );
    placeText(lines, left, top);
    const barTop = top + height - humanHeight - bars;
    ops.push({
      kind: 'barcode',
      key,
      x: barX,
      top: barTop,
      width: barWidth,
      height: bars,
      bitmap,
      moduleMm: module / pt,
    });
    if (human)
      ops.push({
        kind: 'text',
        x: human.x,
        baseline: barTop + bars + human.size * 0.95,
        size: human.size,
        bold: false,
        text: human.text,
      });
    dense = module / pt < MIN_MODULE.linear;
    return { ops, dense, failed };
  }

  // A matrix symbol is square: beside the text on the right, or centred on its own.
  const code = label.barcode.code;
  let side = Math.min(
    height,
    hasText ? width * 0.45 : width,
    bitmap.modules * MAX_MODULE.matrix * pt,
  );
  const humanLine = Math.max(MIN_FONT, base * 0.8) * 1.1;
  let withHuman = readable(code, 0, side) !== null;
  // The plain text goes rather than shrink the symbol by more than a little.
  if (withHuman && side + humanLine > height) {
    if (height - humanLine < side * 0.85) withHuman = false;
    else side = height - humanLine;
  }
  const human = withHuman
    ? readable(code, hasText ? left + width - side : left + (width - side) / 2, side)
    : null;
  const x = hasText ? left + width - side : left + (width - side) / 2;
  const qrTop = top + (height - side - (human ? humanLine : 0)) / 2;
  ops.push({
    kind: 'barcode',
    key,
    x,
    top: qrTop,
    width: side,
    height: side,
    bitmap,
    moduleMm: side / bitmap.modules / pt,
  });
  if (human)
    ops.push({
      kind: 'text',
      x: human.x,
      baseline: qrTop + side + human.size * 0.95,
      size: human.size,
      bold: false,
      text: human.text,
    });
  if (hasText) placeText(fitText(label, base, width - side - gap, height, m), left, top);
  dense = side / bitmap.modules / pt < MIN_MODULE.matrix;
  return { ops, dense, failed };
}

function fontMetrics(regular: PDFFont, bold: PDFFont): Metrics {
  const sets = [regular, bold].map((f) => new Set(f.getCharacterSet()));
  const drawable = (ch: string) => sets.every((s) => s.has(ch.codePointAt(0)!));
  return {
    width: (text, size, b) => (b ? bold : regular).widthOfTextAtSize(text, size),
    clean(text) {
      let out = '';
      for (const ch of text.replace(/\s+/g, ' ')) {
        if (drawable(ch)) {
          out += ch;
          continue;
        }
        // "ș" prints as "s"; what has no Latin form prints as "?".
        const plain = ch.normalize('NFD').replace(/\p{M}/gu, '');
        out += plain && [...plain].every(drawable) ? plain : '?';
      }
      return out;
    },
  };
}

let previewMetrics: Promise<Metrics> | null = null;

/** Font metrics without building a PDF, for the on-screen preview. */
export function labelMetrics(): Promise<Metrics> {
  previewMetrics ??= (async () => {
    const doc = await PDFDocument.create();
    return fontMetrics(
      await doc.embedFont(StandardFonts.Helvetica),
      await doc.embedFont(StandardFonts.HelveticaBold),
    );
  })();
  return previewMetrics;
}

export interface LabelPdf {
  bytes: Uint8Array;
  labels: number;
  pages: number;
  /** Labels whose barcode is too dense to print reliably at this size. */
  dense: number;
  /** Codes that could not be drawn in their symbology. */
  failed: string[];
}

/** Lays the labels out on sheets (or one per page for thermal rolls) and returns the PDF. */
export async function buildLabelPdf(job: PrintJob): Promise<LabelPdf> {
  const layout = LABEL_LAYOUTS[job.layout satisfies LabelLayoutKey];
  const doc = await PDFDocument.create();
  doc.setTitle('Labels');
  doc.setCreator('Airstock');
  doc.setProducer('Airstock');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const metrics = fontMetrics(regular, bold);
  const pt = PT_PER_MM;
  const pageWidth = layout.page.width * pt;
  const pageHeight = layout.page.height * pt;
  const perPage = layout.columns * layout.rows;
  const images = new Map<string, PDFRef>();
  const black = rgb(0, 0, 0);

  let page: PDFPage | null = null;
  let names = new Map<PDFRef, PDFName>();
  let slot = 0;
  let pages = 0;
  let count = 0;
  let dense = 0;
  const failed = new Set<string>();

  for (const label of job.labels) {
    const plan = planLabel(label, layout, metrics);
    if (plan.failed && label.barcode) failed.add(label.barcode.code);
    for (let copy = 0; copy < label.copies; copy++) {
      if (!page || slot === perPage) {
        page = doc.addPage([pageWidth, pageHeight]);
        names = new Map();
        slot = pages === 0 ? Math.min(Math.max(0, job.skip ?? 0), perPage - 1) : 0;
        pages++;
      }
      const col = slot % layout.columns;
      const row = Math.floor(slot / layout.columns);
      const x0 = (layout.marginLeft + col * (layout.labelWidth + layout.gapX)) * pt;
      const y0 = (layout.marginTop + row * (layout.labelHeight + layout.gapY)) * pt;
      for (const op of plan.ops) {
        if (op.kind === 'text') {
          page.drawText(op.text, {
            x: x0 + op.x,
            y: pageHeight - (y0 + op.baseline),
            size: op.size,
            font: op.bold ? bold : regular,
            color: black,
          });
          continue;
        }
        let ref = images.get(op.key);
        if (!ref) {
          ref = doc.context.register(
            doc.context.flateStream(op.bitmap.pixels, {
              Type: 'XObject',
              Subtype: 'Image',
              Width: op.bitmap.width,
              Height: op.bitmap.height,
              ColorSpace: 'DeviceGray',
              BitsPerComponent: 8,
              // Hard module edges when a viewer or printer scales the image.
              Interpolate: false,
            }),
          );
          images.set(op.key, ref);
        }
        let name = names.get(ref);
        if (!name) {
          name = page.node.newXObject('Image', ref);
          names.set(ref, name);
        }
        page.pushOperators(
          pushGraphicsState(),
          concatTransformationMatrix(
            op.width,
            0,
            0,
            op.height,
            x0 + op.x,
            pageHeight - (y0 + op.top + op.height),
          ),
          drawObject(name),
          popGraphicsState(),
        );
      }
      if (plan.dense) dense++;
      count++;
      slot++;
    }
  }
  if (count === 0) throw new Error('There are no labels to print.');
  return { bytes: await doc.save(), labels: count, pages, dense, failed: [...failed] };
}
