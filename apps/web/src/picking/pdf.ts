import fontkit from '@pdf-lib/fontkit';
import {
  degrees,
  drawText,
  PDFDocument,
  type PDFFont,
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
import {
  FontLibrary,
  fetchFont,
  type LabelFonts,
  type LabelText,
  SYNTHETIC_BOLD,
} from '../labels/fonts.ts';
import { linePacks, type PickListView, sectionsOf } from './view.ts';

/**
 * A pick list as a PDF (plan 5.11, PRD 6.10), drawn in the browser with pdf-lib and the same
 * self-hosted Noto fonts as labels (ADR 0019), so names in any supported script print. The page
 * that prints loads this module with a dynamic import, keeping pdf-lib and fontkit out of the
 * main bundle. A4 portrait: lines grouped by location in walk order, each with a box to tick,
 * the quantity in base units and packs, SKU, name, lot or serial, and the order reference.
 */

const PT_PER_MM = 72 / 25.4;
const PAGE = { width: 210 * PT_PER_MM, height: 297 * PT_PER_MM };
const MARGIN = 14 * PT_PER_MM;
const SIZE = 9;
const ROW = 15;
const COLUMNS = [
  { key: 'tick', width: 16 },
  { key: 'qty', width: 80 },
  { key: 'sku', width: 84 },
  { key: 'name', width: 136 },
  { key: 'track', width: 106 },
  { key: 'order', width: 0 },
] as const;

let library: FontLibrary | null = null;

interface Cell {
  text: string;
  bold?: boolean;
}

function rowCells(line: PickListView['pickLines'][number]): Record<string, Cell> {
  return {
    qty: {
      text: `${line.remaining === line.quantity ? line.quantity : line.remaining} ${linePacks(line)}`,
      bold: true,
    },
    sku: { text: line.sku },
    name: {
      text: line.variantName ? `${line.productName} · ${line.variantName}` : line.productName,
    },
    track: {
      text: line.serial
        ? `SN ${line.serial}`
        : line.lotCode
          ? `Lot ${line.lotCode}${line.expiresOn ? ` ${line.expiresOn}` : ''}`
          : '',
    },
    order: { text: line.externalRef ?? '' },
  };
}

export async function buildPickListPdf(
  list: PickListView,
  options: { shopName: string; fonts?: FontLibrary } = { shopName: '' },
): Promise<Uint8Array> {
  library ??= new FontLibrary(fetchFont);
  const fonts = options.fonts ?? library;
  const sections = sectionsOf(list.pickLines.filter((l) => l.status === 'open'));
  const title = `Pick list ${list.number}`;
  const subtitle = [
    options.shopName,
    new Date(list.createdAt).toLocaleString(),
    `${list.orders} orders`,
    `${sections.reduce((n, s) => n + s.lines.length, 0)} lines to pick`,
    list.note ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
  const texts: LabelText[] = [
    { text: title, bold: true },
    { text: subtitle, bold: false },
    { text: 'Qty SKU Item Lot/serial Order Page of 0123456789', bold: true },
  ];
  for (const s of sections) {
    texts.push({ text: s.path, bold: true });
    for (const l of s.lines) {
      for (const cell of Object.values(rowCells(l)))
        texts.push({ text: cell.text, bold: Boolean(cell.bold) });
    }
  }
  const metrics = await fonts.fontsFor(texts);

  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('Airstock');
  doc.setProducer('Airstock');
  doc.registerFontkit(fontkit);
  const embedded = new Map<string, PDFFont>();
  const black = rgb(0, 0, 0);
  const grey = rgb(0.45, 0.45, 0.45);
  const upright = degrees(0);

  let names = new Map<PDFRef, PDFName>();
  let y = 0;
  const pages: PDFPage[] = [];
  const current = () => pages.at(-1)!;

  /** Cuts text with an ellipsis to fit a width in points. */
  const fit = (text: string, bold: boolean, size: number, width: number) => {
    let t = metrics.clean(text, bold);
    if (width <= 0 || metrics.width(t, size, bold) <= width) return t;
    const chars = [...t];
    while (chars.length > 1 && metrics.width(`${chars.join('')}…`, size, bold) > width) chars.pop();
    t = `${chars.join('')}…`;
    return t;
  };

  const text = async (
    target: PDFPage,
    value: string,
    x: number,
    baseline: number,
    size: number,
    bold: boolean,
    color = black,
  ) => {
    for (const run of metrics.line(value, bold).runs) {
      let font = embedded.get(run.face.file);
      if (!font) {
        font = await doc.embedFont(run.face.bytes, { subset: true });
        embedded.set(run.face.file, font);
      }
      let name = names.get(font.ref);
      if (!name) {
        name = target.node.newFontDictionary(font.name, font.ref);
        names.set(font.ref, name);
      }
      const ops = drawText(font.encodeText(run.text), {
        x: x + run.x * size,
        y: PAGE.height - baseline,
        size,
        font: name,
        color,
        rotate: upright,
        xSkew: upright,
        ySkew: upright,
      });
      const operators: PDFOperator[] = run.face.synthetic
        ? [
            pushGraphicsState(),
            setTextRenderingMode(TextRenderingMode.FillAndOutline),
            setLineWidth(size * SYNTHETIC_BOLD),
            setStrokingColor(color),
            ...ops,
            popGraphicsState(),
          ]
        : ops;
      target.pushOperators(...operators);
    }
  };

  const newPage = async () => {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    pages.push(page);
    names = new Map();
    y = MARGIN;
    await text(page, fit(title, true, 14, PAGE.width - 2 * MARGIN), MARGIN, y + 12, 14, true);
    y += 18;
    await text(
      page,
      fit(subtitle, false, 8, PAGE.width - 2 * MARGIN),
      MARGIN,
      y + 8,
      8,
      false,
      grey,
    );
    y += 18;
    let x = MARGIN;
    for (const [i, head] of ['', 'Qty', 'SKU', 'Item', 'Lot/serial', 'Order'].entries()) {
      await text(page, head, x, y + SIZE, 8, true, grey);
      x += COLUMNS[i]!.width;
    }
    y += 12;
  };

  await newPage();
  const bottom = PAGE.height - MARGIN - 14;
  const orderWidth = PAGE.width - 2 * MARGIN - COLUMNS.reduce((w, c) => w + c.width, 0);
  for (const section of sections) {
    if (y + ROW * 2 > bottom) await newPage();
    y += 4;
    await text(
      current(),
      fit(section.path, true, 10.5, PAGE.width - 2 * MARGIN),
      MARGIN,
      y + 11,
      10.5,
      true,
    );
    y += 16;
    for (const line of section.lines) {
      if (y + ROW > bottom) {
        await newPage();
        await text(
          current(),
          fit(`${section.path} (cont.)`, true, 10.5, PAGE.width - 2 * MARGIN),
          MARGIN,
          y + 11,
          10.5,
          true,
        );
        y += 16;
      }
      const p = current();
      // The box to tick.
      p.drawRectangle({
        x: MARGIN,
        y: PAGE.height - (y + 10),
        width: 8,
        height: 8,
        borderColor: black,
        borderWidth: 0.7,
      });
      const cells = rowCells(line);
      let x = MARGIN + COLUMNS[0].width;
      for (const col of COLUMNS.slice(1)) {
        const cell = cells[col.key]!;
        const width = col.width || orderWidth;
        await text(
          p,
          fit(cell.text, Boolean(cell.bold), SIZE, width - 6),
          x,
          y + SIZE,
          SIZE,
          Boolean(cell.bold),
        );
        x += col.width;
      }
      y += ROW;
    }
  }
  if (sections.length === 0) {
    await text(current(), 'Nothing left to pick.', MARGIN, y + 12, 10, false);
  }
  for (const [i, p] of pages.entries()) {
    names = new Map();
    const label = `Page ${i + 1} of ${pages.length}`;
    await text(
      p,
      label,
      PAGE.width - MARGIN - metrics.width(label, 8, false),
      PAGE.height - MARGIN + 4,
      8,
      false,
      grey,
    );
  }
  return doc.save();
}

export type { LabelFonts };
