import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, rgb } from 'pdf-lib';
import type { FontLibrary, LabelFonts, LabelText } from './fonts.ts';

/**
 * The purchase order PDF (D11), drawn in the Worker with pdf-lib and the same Noto fonts as labels
 * (ADR 0019), so supplier names, product names, and notes print in any script the label fonts
 * cover. A4 portrait; lines continue on further pages with the table header repeated.
 */

export interface PurchaseOrderPdfLine {
  sku: string;
  supplierSku: string | null;
  description: string;
  packName: string | null;
  /** Base units per pack, when the line is in packs. */
  packFactor: string | null;
  /** As ordered: packs when the line has a pack, else base units. */
  quantity: string;
  unitCost: string | null;
  lineTotal: string | null;
}

export interface PurchaseOrderPdfInput {
  number: string;
  status: string;
  currency: string;
  shopName: string;
  /** YYYY-MM-DD: the date printed as the order date. */
  orderDate: string;
  expectedOn: string | null;
  supplierReference: string | null;
  notes: string | null;
  supplier: {
    name: string;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
  };
  deliverTo: { name: string; address: string | null; location: string | null };
  lines: PurchaseOrderPdfLine[];
  total: string | null;
  /** False when the person downloading may not see costs: the cost columns are left out. */
  showCosts: boolean;
}

export interface PurchaseOrderPdf {
  bytes: Uint8Array;
  pages: number;
  /** Characters no font has; they print as "?". */
  missing: string[];
}

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 42;
const INK = rgb(0.11, 0.11, 0.1);
const MUTED = rgb(0.42, 0.41, 0.38);
const RULE = rgb(0.82, 0.81, 0.78);
const ACCENT = rgb(0.12, 0.37, 0.29);

/** A decimal string as printed: no trailing zeros. */
export function quantityText(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

/** A decimal string rounded half to even to 2 places, for money (ADR 0022: cents only on display). */
export function moneyText(value: string): string {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const digits = BigInt(whole + fraction.padEnd(6, '0').slice(0, 6));
  // 6 places to 2: divide by 10^4, half to even.
  const q = digits / 10000n;
  const r = digits % 10000n;
  const rounded = r > 5000n || (r === 5000n && q % 2n === 1n) ? q + 1n : q;
  const text = rounded.toString().padStart(3, '0');
  const out = `${text.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${text.slice(-2)}`;
  return negative && rounded !== 0n ? `-${out}` : out;
}

interface Painter {
  fonts: LabelFonts;
  embedded: Map<string, PDFFont>;
}

function textWidth(p: Painter, text: string, size: number, bold: boolean): number {
  return p.fonts.width(p.fonts.clean(text, bold), size, bold);
}

function draw(
  p: Painter,
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number,
  bold = false,
  color = INK,
): void {
  const clean = p.fonts.clean(text, bold);
  if (!clean) return;
  for (const run of p.fonts.line(clean, bold).runs) {
    const font = p.embedded.get(run.face.file)!;
    page.drawText(run.text, { x: x + run.x * size, y, size, font, color });
  }
}

function drawRight(
  p: Painter,
  page: PDFPage,
  text: string,
  right: number,
  y: number,
  size: number,
  bold = false,
): void {
  draw(p, page, text, right - textWidth(p, text, size, bold), y, size, bold);
}

/** Words onto lines no wider than `width`; a word longer than a line is cut with an ellipsis. */
function wrap(p: Painter, text: string, size: number, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(p, candidate, size, false) <= width || !current) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  const fitted = lines.slice(0, maxLines).map((line) => {
    if (textWidth(p, line, size, false) <= width) return line;
    let cut = line;
    while (cut.length > 1 && textWidth(p, `${cut}…`, size, false) > width) cut = cut.slice(0, -1);
    return `${cut}…`;
  });
  if (lines.length > maxLines) {
    let last = fitted[maxLines - 1]!;
    while (last.length > 1 && textWidth(p, `${last}…`, size, false) > width)
      last = last.slice(0, -1);
    fitted[maxLines - 1] = `${last.replace(/…$/, '')}…`;
  }
  return fitted;
}

interface Column {
  key: 'n' | 'item' | 'pack' | 'qty' | 'cost' | 'total';
  title: string;
  width: number;
  align: 'left' | 'right';
}

export async function renderPurchaseOrderPdf(
  input: PurchaseOrderPdfInput,
  library: FontLibrary,
): Promise<PurchaseOrderPdf> {
  const texts: LabelText[] = [];
  const regular = (t: string | null | undefined) => {
    if (t) texts.push({ text: t, bold: false });
  };
  const bold = (t: string | null | undefined) => {
    if (t) texts.push({ text: t, bold: true });
  };
  bold('Purchase order');
  bold(input.number);
  bold(input.shopName);
  bold(input.supplier.name);
  bold(input.deliverTo.name);
  for (const t of [
    input.supplier.contactName,
    input.supplier.email,
    input.supplier.phone,
    input.supplier.address,
    input.deliverTo.address,
    input.deliverTo.location,
    input.supplierReference,
    input.notes,
  ])
    regular(t);
  for (const line of input.lines) {
    regular(line.description);
    regular(line.sku);
    regular(line.supplierSku);
    regular(line.packName);
  }
  regular('0123456789.,:-–×#/ ()…?ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
  bold('0123456789.,:-– ()ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
  const fonts = await library.fontsFor(texts);

  const doc = await PDFDocument.create();
  doc.setTitle(`Purchase order ${input.number}`);
  doc.setSubject(`${input.shopName} — ${input.supplier.name}`);
  doc.setCreator('Airstock');
  doc.setProducer('Airstock');
  doc.registerFontkit(fontkit);
  const embedded = new Map<string, PDFFont>();
  for (const face of [...fonts.regular, ...fonts.bold]) {
    if (!embedded.has(face.file))
      embedded.set(face.file, await doc.embedFont(face.bytes, { subset: true }));
  }
  const p: Painter = { fonts, embedded };

  const right = PAGE.width - MARGIN;
  const contentWidth = right - MARGIN;
  const columns: Column[] = input.showCosts
    ? [
        { key: 'n', title: '#', width: 22, align: 'left' },
        { key: 'item', title: 'Item', width: contentWidth - 22 - 92 - 58 - 72 - 78, align: 'left' },
        { key: 'pack', title: 'Pack', width: 92, align: 'left' },
        { key: 'qty', title: 'Quantity', width: 58, align: 'right' },
        { key: 'cost', title: `Unit (${input.currency})`, width: 72, align: 'right' },
        { key: 'total', title: `Total (${input.currency})`, width: 78, align: 'right' },
      ]
    : [
        { key: 'n', title: '#', width: 22, align: 'left' },
        { key: 'item', title: 'Item', width: contentWidth - 22 - 110 - 70, align: 'left' },
        { key: 'pack', title: 'Pack', width: 110, align: 'left' },
        { key: 'qty', title: 'Quantity', width: 70, align: 'right' },
      ];
  const columnX = new Map<Column['key'], number>();
  {
    let x = MARGIN;
    for (const c of columns) {
      columnX.set(c.key, x);
      x += c.width;
    }
  }

  const pages: PDFPage[] = [];
  let page = doc.addPage([PAGE.width, PAGE.height]);
  pages.push(page);
  let y = PAGE.height - MARGIN;

  // Heading.
  draw(p, page, 'Purchase order', MARGIN, y - 18, 20, true, ACCENT);
  drawRight(p, page, input.number, right, y - 18, 20, true);
  y -= 40;
  if (input.status === 'draft') {
    draw(p, page, 'DRAFT – not yet sent', MARGIN, y, 9, true, MUTED);
    y -= 14;
  }
  const facts: Array<[string, string]> = [
    ['Order date', input.orderDate],
    ['Expected', input.expectedOn ?? '—'],
    ['Currency', input.currency],
  ];
  if (input.supplierReference) facts.push(['Supplier reference', input.supplierReference]);
  for (const [label, value] of facts) {
    draw(p, page, label, MARGIN, y, 9, false, MUTED);
    draw(p, page, value, MARGIN + 110, y, 9);
    y -= 13;
  }
  y -= 10;

  // Supplier and destination blocks.
  const half = contentWidth / 2;
  const block = (x: number, title: string, lines: Array<string | null>, heading: string) => {
    let by = y;
    draw(p, page, title, x, by, 8, true, MUTED);
    by -= 14;
    draw(p, page, heading, x, by, 10, true);
    by -= 13;
    for (const line of lines) {
      if (!line) continue;
      for (const part of wrap(p, line, 9, half - 16, 3)) {
        draw(p, page, part, x, by, 9);
        by -= 12;
      }
    }
    return by;
  };
  const supplierEnd = block(
    MARGIN,
    'SUPPLIER',
    [
      input.supplier.contactName,
      input.supplier.address,
      input.supplier.email,
      input.supplier.phone,
    ],
    input.supplier.name,
  );
  const deliverEnd = block(
    MARGIN + half,
    'DELIVER TO',
    [
      input.shopName,
      input.deliverTo.address,
      input.deliverTo.location ? `Receiving: ${input.deliverTo.location}` : null,
    ],
    input.deliverTo.name,
  );
  y = Math.min(supplierEnd, deliverEnd) - 12;

  if (input.notes) {
    draw(p, page, 'NOTES', MARGIN, y, 8, true, MUTED);
    y -= 13;
    for (const part of wrap(p, input.notes, 9, contentWidth, 8)) {
      draw(p, page, part, MARGIN, y, 9);
      y -= 12;
    }
    y -= 8;
  }

  const tableHeader = () => {
    page.drawLine({
      start: { x: MARGIN, y: y + 4 },
      end: { x: right, y: y + 4 },
      thickness: 0.8,
      color: INK,
    });
    y -= 9;
    for (const c of columns) {
      const x = columnX.get(c.key)!;
      if (c.align === 'right') drawRight(p, page, c.title, x + c.width - 4, y, 8, true);
      else draw(p, page, c.title, x, y, 8, true);
    }
    y -= 7;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: right, y },
      thickness: 0.5,
      color: RULE,
    });
    y -= 12;
  };
  tableHeader();

  const itemWidth = columns.find((c) => c.key === 'item')!.width - 8;
  for (const [index, line] of input.lines.entries()) {
    const description = wrap(p, line.description, 9, itemWidth, 2);
    const codes = line.supplierSku ? `${line.sku} · supplier ${line.supplierSku}` : line.sku;
    const pack = line.packName
      ? `${line.packName}${line.packFactor ? ` (${quantityText(line.packFactor)})` : ''}`
      : 'Units';
    const packLines = wrap(p, pack, 8.5, columns.find((c) => c.key === 'pack')!.width - 6, 2);
    const height = Math.max(description.length * 11 + 11, packLines.length * 11) + 6;
    if (y - height < MARGIN + 40) {
      page = doc.addPage([PAGE.width, PAGE.height]);
      pages.push(page);
      y = PAGE.height - MARGIN - 10;
      tableHeader();
    }
    const top = y;
    draw(p, page, String(index + 1), columnX.get('n')!, top, 9, false, MUTED);
    let ly = top;
    for (const part of description) {
      draw(p, page, part, columnX.get('item')!, ly, 9);
      ly -= 11;
    }
    draw(p, page, codes, columnX.get('item')!, ly, 7.5, false, MUTED);
    let py = top;
    for (const part of packLines) {
      draw(p, page, part, columnX.get('pack')!, py, 8.5);
      py -= 11;
    }
    const qty = columns.find((c) => c.key === 'qty')!;
    drawRight(p, page, quantityText(line.quantity), columnX.get('qty')! + qty.width - 4, top, 9);
    if (input.showCosts) {
      const cost = columns.find((c) => c.key === 'cost')!;
      const total = columns.find((c) => c.key === 'total')!;
      drawRight(
        p,
        page,
        line.unitCost === null ? '—' : moneyText(line.unitCost),
        columnX.get('cost')! + cost.width - 4,
        top,
        9,
      );
      drawRight(
        p,
        page,
        line.lineTotal === null ? '—' : moneyText(line.lineTotal),
        columnX.get('total')! + total.width - 4,
        top,
        9,
      );
    }
    y = top - height + 2;
    page.drawLine({
      start: { x: MARGIN, y: y + 6 },
      end: { x: right, y: y + 6 },
      thickness: 0.4,
      color: RULE,
    });
    y -= 6;
  }

  if (input.showCosts) {
    if (y < MARGIN + 50) {
      page = doc.addPage([PAGE.width, PAGE.height]);
      pages.push(page);
      y = PAGE.height - MARGIN - 10;
    }
    y -= 6;
    const label = `Total (${input.currency})`;
    drawRight(p, page, input.total === null ? '—' : moneyText(input.total), right - 4, y, 11, true);
    drawRight(p, page, label, right - 100, y, 10, true);
  }

  for (const [index, pg] of pages.entries()) {
    draw(p, pg, `${input.number} · ${input.shopName}`, MARGIN, MARGIN - 18, 7.5, false, MUTED);
    drawRight(p, pg, `Page ${index + 1} of ${pages.length}`, right, MARGIN - 18, 7.5);
  }

  return { bytes: await doc.save(), pages: pages.length, missing: fonts.missing };
}
