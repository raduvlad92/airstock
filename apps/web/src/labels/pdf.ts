import { LABEL_LAYOUTS, type LabelLayout, type LabelLayoutKey } from '@airstock/core/labels';
import fontkit from '@pdf-lib/fontkit';
import {
  concatTransformationMatrix,
  degrees,
  drawObject,
  drawText,
  PDFDocument,
  type PDFFont,
  type PDFHexString,
  type PDFName,
  type PDFOperator,
  type PDFPage,
  type PDFRef,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineWidth,
  setStrokingColor,
  setTextRenderingMode,
  TextRenderingMode,
} from 'pdf-lib';
import { type BarcodeBitmap, barcodeBitmap } from './barcode.ts';
import type { PrintJob, PrintLabel } from './content.ts';
import {
  FontLibrary,
  fetchFont,
  type LabelFonts,
  type LabelText,
  SYNTHETIC_BOLD,
} from './fonts.ts';

/**
 * Label PDFs (D9, ADR 0019), drawn in the browser. The labels page loads this module with a
 * dynamic import, so bwip-js, pdf-lib, and fontkit stay out of the main bundle.
 *
 * Each barcode is one grey image XObject made by the rasterizer, embedded once and placed on
 * every copy. Text uses self-hosted Noto fonts (fonts.ts), embedded as subsets.
 */

export type { LabelFonts };
export { barcodeBitmap, FontLibrary };

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
  /** Width in points of one line of text at a size, as the label fonts draw it. */
  width(text: string, size: number, bold: boolean): number;
  /** The text as it prints, with "?" for characters no label font has. */
  clean(text: string, bold: boolean): string;
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
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const words = new Intl.Segmenter(undefined, { granularity: 'word' });
/** Scripts written without spaces between words. */
const NO_SPACES = /[\p{scx=Hani}\p{scx=Hira}\p{scx=Kana}\p{scx=Thai}\p{scx=Laoo}\p{scx=Khmr}]/u;

/** Shortens text to fit `fits`, from the end or (for paths) from the start. */
function ellipsize(text: string, fits: (s: string) => boolean, keepEnd: boolean): string {
  if (fits(text)) return text;
  // Cut between user-perceived characters, never inside one.
  const chars = Array.from(graphemes.segment(text), (s) => s.segment);
  let lo = 0;
  let hi = chars.length;
  const cut = (n: number) =>
    keepEnd
      ? `${ELLIPSIS}${chars
          .slice(chars.length - n)
          .join('')
          .trimStart()}`
      : `${chars.slice(0, n).join('').trimEnd()}${ELLIPSIS}`;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(cut(mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '' : cut(lo);
}

/** Where a line may break: after spaces and slashes, and between words of scripts without spaces. */
function breakable(text: string): string[] {
  const parts: string[] = [];
  for (const part of text.split(/(?<=[\s/])/)) {
    if (!NO_SPACES.test(part)) {
      parts.push(part);
      continue;
    }
    const start = parts.length;
    for (const { segment, isWordLike } of words.segment(part)) {
      // Punctuation and spaces stay with the word before them.
      if (!isWordLike && parts.length > start) parts[parts.length - 1] += segment;
      else parts.push(segment);
    }
  }
  return parts;
}

/** Greedy line breaks; lines keep their spacing so they join back. */
function breakLines(text: string, fits: (s: string) => boolean, fromEnd: boolean): string[] {
  const parts = breakable(text);
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
    for (const text of wrapText(m.clean(label.title, true), 2, fits, label.keepEnd))
      lines.push({ text, size: titleSize, bold: true });
  }
  for (const line of label.lines) {
    const bold = Boolean(line.strong);
    const text = m.clean(line.text, bold);
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
    const text = m.clean(code, false);
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

let browserFonts: FontLibrary | null = null;
const defaultFonts = () => (browserFonts ??= new FontLibrary(fetchFont));

/** Everything a set of labels prints as text, with its weight. */
export function labelTexts(labels: PrintLabel[]): LabelText[] {
  const texts: LabelText[] = [];
  for (const label of labels) {
    if (label.title) texts.push({ text: label.title, bold: true });
    for (const line of label.lines) texts.push({ text: line.text, bold: Boolean(line.strong) });
    if (label.barcode) texts.push({ text: label.barcode.code, bold: false });
  }
  return texts;
}

/**
 * The fonts these labels need, loaded, as metrics: for the on-screen preview. Its `missing` lists
 * the characters no label font has.
 */
export function labelMetrics(labels: PrintLabel[], fonts = defaultFonts()): Promise<LabelFonts> {
  return fonts.fontsFor(labelTexts(labels));
}

/** Draws a planned label on a canvas in points, glyph by glyph, as the PDF draws it. */
export function paintLabel(ctx: CanvasRenderingContext2D, plan: LabelPlan, fonts: LabelFonts) {
  for (const op of plan.ops) {
    if (op.kind === 'text') {
      for (const run of fonts.line(op.text, op.bold).runs) {
        const scale = op.size / run.face.font.unitsPerEm;
        let x = op.x + run.x * op.size;
        for (const glyph of run.glyphs) {
          ctx.save();
          ctx.translate(x, op.baseline);
          ctx.scale(scale, -scale);
          ctx.beginPath();
          glyph.path.toFunction()(ctx);
          ctx.fill();
          if (run.face.synthetic) {
            ctx.lineWidth = SYNTHETIC_BOLD * run.face.font.unitsPerEm;
            ctx.stroke();
          }
          ctx.restore();
          x += glyph.advanceWidth * scale;
        }
      }
      continue;
    }
    const image = new ImageData(op.bitmap.width, op.bitmap.height);
    op.bitmap.pixels.forEach((v, i) => {
      image.data.set([v, v, v, 255], i * 4);
    });
    const tile = document.createElement('canvas');
    tile.width = op.bitmap.width;
    tile.height = op.bitmap.height;
    tile.getContext('2d')?.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tile, op.x, op.top, op.width, op.height);
  }
}

export interface LabelPdf {
  bytes: Uint8Array;
  labels: number;
  pages: number;
  /** Labels whose barcode is too dense to print reliably at this size. */
  dense: number;
  /** Codes that could not be drawn in their symbology. */
  failed: string[];
  /** Characters no label font has; they print as "?". */
  missing: string[];
}

/** Lays the labels out on sheets (or one per page for thermal rolls) and returns the PDF. */
export async function buildLabelPdf(job: PrintJob, fonts = defaultFonts()): Promise<LabelPdf> {
  const layout = LABEL_LAYOUTS[job.layout satisfies LabelLayoutKey];
  const metrics = await fonts.fontsFor(labelTexts(job.labels));
  const plans = job.labels.map((label) => planLabel(label, layout, metrics));
  const doc = await PDFDocument.create();
  doc.setTitle('Labels');
  doc.setCreator('Airstock');
  doc.setProducer('Airstock');
  doc.registerFontkit(fontkit);
  // Only the font files the plans draw with, each embedded once as a subset of its glyphs.
  const files = new Map<string, Uint8Array>();
  for (const plan of plans)
    for (const op of plan.ops)
      if (op.kind === 'text')
        for (const run of metrics.line(op.text, op.bold).runs)
          files.set(run.face.file, run.face.bytes);
  const embedded = new Map<string, PDFFont>();
  for (const [file, bytes] of files)
    embedded.set(file, await doc.embedFont(bytes, { subset: true }));
  const encoded = new Map<string, PDFHexString>();
  const encode = (font: PDFFont, file: string, text: string) => {
    const key = `${file}\u0000${text}`;
    let hex = encoded.get(key);
    if (!hex) {
      hex = font.encodeText(text);
      encoded.set(key, hex);
    }
    return hex;
  };

  const pt = PT_PER_MM;
  const pageWidth = layout.page.width * pt;
  const pageHeight = layout.page.height * pt;
  const perPage = layout.columns * layout.rows;
  const images = new Map<string, PDFRef>();
  const black = rgb(0, 0, 0);
  const upright = degrees(0);

  let page: PDFPage | null = null;
  let names = new Map<PDFRef, PDFName>();
  let slot = 0;
  let pages = 0;
  let count = 0;
  let dense = 0;
  const failed = new Set<string>();

  for (const [index, label] of job.labels.entries()) {
    const plan = plans[index]!;
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
          for (const run of metrics.line(op.text, op.bold).runs) {
            const font = embedded.get(run.face.file)!;
            const ref = font.ref;
            let name = names.get(ref);
            if (!name) {
              name = page.node.newFontDictionary(font.name, ref);
              names.set(ref, name);
            }
            const text = drawText(encode(font, run.face.file, run.text), {
              x: x0 + op.x + run.x * op.size,
              y: pageHeight - (y0 + op.baseline),
              size: op.size,
              font: name,
              color: black,
              rotate: upright,
              xSkew: upright,
              ySkew: upright,
            });
            const operators: PDFOperator[] = run.face.synthetic
              ? [
                  pushGraphicsState(),
                  setTextRenderingMode(TextRenderingMode.FillAndOutline),
                  setLineWidth(op.size * SYNTHETIC_BOLD),
                  setStrokingColor(black),
                  ...text,
                  popGraphicsState(),
                ]
              : text;
            page.pushOperators(...operators);
          }
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
  return {
    bytes: await doc.save(),
    labels: count,
    pages,
    dense,
    failed: [...failed],
    missing: metrics.missing,
  };
}
