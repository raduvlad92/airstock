import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  type PDFObject,
  PDFRawStream,
  PDFRef,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  FontLibrary,
  moneyText,
  type PurchaseOrderPdfInput,
  quantityText,
  renderPurchaseOrderPdf,
} from '../src/index.ts';

// The purchase order PDF (D11): supplier, destination, lines, and totals, in any script the label
// fonts cover (ADR 0019). Text is read back out of the file through each font's ToUnicode map, so
// the test proves what the PDF holds.

const FONTS = new URL('../../../apps/worker/public/assets/fonts/', import.meta.url);
const loaded: string[] = [];
const library = () =>
  new FontLibrary(async (file) => {
    loaded.push(file);
    return new Uint8Array(await readFile(new URL(file, FONTS)));
  });

function bytesOf(stream: PDFRawStream): Uint8Array {
  const flate = stream.dict.get(PDFName.of('Filter')) === PDFName.of('FlateDecode');
  return flate ? new Uint8Array(inflateSync(stream.contents)) : stream.contents;
}

/** Every run of text drawn, per page, decoded through its font's ToUnicode map. */
async function readText(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const fonts = new Map<string, { baseFont: string; unicode: Map<number, string> }>();
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || object instanceof PDFRawStream) continue;
    if (object.get(PDFName.of('Subtype')) !== PDFName.of('Type0')) continue;
    const unicode = new Map<number, string>();
    const cmap = doc.context.lookup(object.get(PDFName.of('ToUnicode'))) as PDFRawStream;
    const text = new TextDecoder('latin1').decode(bytesOf(cmap));
    for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)> <([0-9a-fA-F]+)>/g)) {
        const units = m[2]!.match(/.{4}/g)!.map((h) => Number.parseInt(h, 16));
        unicode.set(Number.parseInt(m[1]!, 16), String.fromCharCode(...units));
      }
    }
    fonts.set(ref.toString(), {
      baseFont: (object.get(PDFName.of('BaseFont')) as PDFName).decodeText(),
      unicode,
    });
  }
  const pages: string[][] = [];
  for (const page of doc.getPages()) {
    const names = new Map<string, string>();
    for (const [name, value] of page.node
      .Resources()
      ?.lookupMaybe(PDFName.of('Font'), PDFDict)
      ?.entries() ?? []) {
      if (value instanceof PDFRef) names.set(name.asString(), value.toString());
    }
    const contents = page.node.Contents();
    const streams: PDFObject[] =
      contents instanceof PDFArray
        ? contents.asArray().map((r) => doc.context.lookup(r)!)
        : contents
          ? [contents]
          : [];
    const content = streams
      .map((s) => new TextDecoder('latin1').decode(bytesOf(s as PDFRawStream)))
      .join('\n');
    const runs: string[] = [];
    for (const m of content.matchAll(/(\/\S+) [\d.]+ Tf[\s\S]*?<([0-9A-Fa-f]*)> Tj/g)) {
      const font = fonts.get(names.get(m[1]!) ?? '');
      if (!font) throw new Error(`Unknown font ${m[1]}`);
      const glyphs = (m[2]!.match(/.{4}/g) ?? []).map((h) => Number.parseInt(h, 16));
      runs.push(glyphs.map((g) => font.unicode.get(g) ?? '�').join(''));
    }
    pages.push(runs);
  }
  return { pages, fonts: [...fonts.values()].map((f) => f.baseFont) };
}

function order(overrides: Partial<PurchaseOrderPdfInput> = {}): PurchaseOrderPdfInput {
  return {
    number: 'PO-0042',
    status: 'sent',
    currency: 'EUR',
    shopName: 'Atelier Ștefan',
    orderDate: '2026-11-16',
    expectedOn: '2026-11-30',
    supplierReference: 'SO-77',
    notes: 'Livrare doar dimineața. Палети по 40 кашона.',
    supplier: {
      name: 'Θεσσαλονίκη Supplies',
      contactName: 'Ana Popescu',
      email: 'orders@example.test',
      phone: '+40 700 000 000',
      address: 'Strada Mare 1, 300000 Timișoara, RO',
    },
    deliverTo: { name: 'Main warehouse', address: 'Hafenstraße 5, Hamburg', location: 'Main/A1' },
    lines: [
      {
        sku: 'BOL-RS-01',
        supplierSku: 'TH-9001',
        description: 'Bol roșu – mare',
        packName: 'Case',
        packFactor: '24.000000',
        quantity: '3.000000',
        unitCost: '48.000000',
        lineTotal: '144.000000',
      },
      {
        sku: 'TEA-CN-02',
        supplierSku: null,
        description: '茶杯 白色',
        packName: null,
        packFactor: null,
        quantity: '10',
        unitCost: '2.345000',
        lineTotal: '23.450000',
      },
    ],
    total: '167.450000',
    showCosts: true,
    ...overrides,
  };
}

describe('purchase order PDF (D11)', () => {
  it('prints the supplier, destination, lines, and totals, in every script used', async () => {
    loaded.length = 0;
    const pdf = await renderPurchaseOrderPdf(order(), library());
    expect(pdf.missing).toEqual([]);
    expect(pdf.pages).toBe(1);
    const read = await readText(pdf.bytes);
    const text = read.pages.flat().join('\n');
    for (const expected of [
      'Purchase order',
      'PO-0042',
      'Θεσσαλονίκη Supplies',
      'Ana Popescu',
      'orders@example.test',
      'Strada Mare 1, 300000 Timișoara, RO',
      'Main warehouse',
      'Receiving: Main/A1',
      'Atelier Ștefan',
      'SO-77',
      'Палети по 40 кашона.',
      'Bol roșu – mare',
      'BOL-RS-01 · supplier TH-9001',
      'Case (24)',
      '茶杯 白色',
      '48.00',
      '144.00',
      '2.34',
      '23.45',
      '167.45',
      'Total (EUR)',
      'Page 1 of 1',
    ]) {
      expect(text, expected).toContain(expected);
    }
    // Noto Sans for Latin, Greek, and Cyrillic; the CJK font only because a line needs it.
    expect(loaded).toContain('NotoSansSC-Regular.ttf');
    expect(loaded).not.toContain('NotoSansArabic-Regular.ttf');
    expect(read.fonts.some((f) => f.includes('NotoSansSC'))).toBe(true);
  });

  it('leaves the cost columns out for a member without costs.read', async () => {
    const pdf = await renderPurchaseOrderPdf(
      order({
        showCosts: false,
        total: null,
        lines: order().lines.map((l) => ({ ...l, unitCost: null, lineTotal: null })),
      }),
      library(),
    );
    const text = (await readText(pdf.bytes)).pages.flat().join('\n');
    expect(text).toContain('Bol roșu – mare');
    expect(text).not.toContain('Total (EUR)');
    expect(text).not.toContain('144.00');
  });

  it('prints right-to-left supplier names and marks a draft', async () => {
    const pdf = await renderPurchaseOrderPdf(
      order({
        status: 'draft',
        supplier: { ...order().supplier, name: 'مورد الشرق', address: 'רחוב הרצל 1, תל אביב' },
      }),
      library(),
    );
    expect(pdf.missing).toEqual([]);
    const read = await readText(pdf.bytes);
    expect(read.pages.flat().join('\n')).toContain('DRAFT – not yet sent');
    expect(read.fonts.some((f) => f.includes('NotoSansArabic'))).toBe(true);
    expect(read.fonts.some((f) => f.includes('NotoSansHebrew'))).toBe(true);
  });

  it('continues long orders on further pages with the header repeated', async () => {
    const line = order().lines[0]!;
    const pdf = await renderPurchaseOrderPdf(
      order({ lines: Array.from({ length: 60 }, (_, i) => ({ ...line, sku: `SKU-${i + 1}` })) }),
      library(),
    );
    expect(pdf.pages).toBeGreaterThan(1);
    const read = await readText(pdf.bytes);
    expect(read.pages[1]!.join('\n')).toContain('Quantity');
    expect(read.pages.flat().join('\n')).toContain('SKU-60 · supplier TH-9001');
    expect(read.pages.at(-1)!.join('\n')).toContain(`Page ${pdf.pages} of ${pdf.pages}`);
  });

  it('rounds money half to even at cents and prints quantities without trailing zeros', () => {
    expect(moneyText('2.345000')).toBe('2.34');
    expect(moneyText('2.355000')).toBe('2.36');
    expect(moneyText('1234567.5')).toBe('1,234,567.50');
    expect(moneyText('0')).toBe('0.00');
    expect(quantityText('3.000000')).toBe('3');
    expect(quantityText('2.500000')).toBe('2.5');
  });
});
