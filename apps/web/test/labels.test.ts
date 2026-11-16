import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Symbology } from '@airstock/core/barcodes';
import { normalizeBarcode } from '@airstock/core/barcodes';
import { LABEL_LAYOUT_KEYS, LABEL_LAYOUTS } from '@airstock/core/labels';
import fontkit from '@pdf-lib/fontkit';
import bwip from 'bwip-js/node';
import { describe, expect, it } from 'vitest';
import { barcodeBitmap, PIXELS_PER_MODULE } from '../src/labels/barcode.ts';
import {
  type ItemLabels,
  itemPrintLabels,
  locationPrintLabels,
  type PrintLabel,
} from '../src/labels/content.ts';
import { evenGlyphs, FontLibrary } from '../src/labels/fonts.ts';
import { buildLabelPdf, labelMetrics, PT_PER_MM, planLabel, wrapText } from '../src/labels/pdf.ts';
import { readLabelPdf } from './pdf-images.ts';
import { decodeGrey } from './zxing.ts';

// D9, F8, A33: the label renderer. Every barcode the PDF carries is the rasterizer's bitmap,
// placed inside its label, and decodes back to the stored code.

const CODES: Array<[Symbology, string]> = [
  ['ean13', '4006381333931'],
  ['upca', '036000291452'],
  ['ean8', '96385074'],
  ['code128', 'AS00000042'],
  ['qr', 'AS00000043'],
  ['qr', 'LOC:0196F3A0-0000-7000-8000-0000000000B1'],
  ['other', 'SUP-77/a'],
  ['other', 'Größe ș 名前'],
];

/** The label fonts as the Worker serves them, read from disk. */
const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../worker/public/assets/fonts');
const fontFile = async (file: string) => new Uint8Array(await readFile(join(FONT_DIR, file)));
const fromDisk = (fetched?: string[]) =>
  new FontLibrary(async (file) => {
    fetched?.push(file);
    return fontFile(file);
  });
const fonts = fromDisk();

const label = (barcode: PrintLabel['barcode'], extra: Partial<PrintLabel> = {}): PrintLabel => ({
  copies: 1,
  title: 'Ceramic mug, speckled glaze',
  lines: [{ text: 'MUG-01' }, { text: 'Blue / Large' }, { text: '12.50 EUR', strong: true }],
  barcode,
  ...extra,
});

/** Runs of dark and light, in modules, across the first row of a linear bitmap. */
function moduleRuns(pixels: Uint8Array, width: number): number[] {
  const runs: number[] = [];
  let value = pixels[0];
  let length = 0;
  for (let x = 0; x < width; x++) {
    if (pixels[x] === value) length++;
    else {
      runs.push(length / PIXELS_PER_MODULE);
      value = pixels[x];
      length = 1;
    }
  }
  runs.push(length / PIXELS_PER_MODULE);
  return runs;
}

describe('barcode rasterizer', () => {
  it('draws the bars bwip-js encodes, between quiet zones', () => {
    for (const [symbology, bcid, code] of [
      ['ean13', 'ean13', '4006381333931'],
      ['upca', 'upca', '036000291452'],
      ['ean8', 'ean8', '96385074'],
      ['code128', 'code128', 'AS00000042'],
    ] as const) {
      const bitmap = barcodeBitmap(symbology, code);
      const { sbs } = (bwip.raw(bcid, code, '') as Array<{ sbs: number[] }>)[0]!;
      const runs = moduleRuns(bitmap.pixels, bitmap.width);
      expect(bitmap.linear).toBe(true);
      expect(runs[0]).toBeGreaterThanOrEqual(11);
      expect(runs.at(-1)).toBeGreaterThanOrEqual(11);
      expect(runs.slice(1, -1)).toEqual(sbs);
      // Both rows of the band are identical.
      expect(bitmap.pixels.slice(bitmap.width)).toEqual(bitmap.pixels.slice(0, bitmap.width));
    }
  });

  it('draws the QR modules bwip-js encodes, with a four-module quiet zone', () => {
    for (const code of ['AS00000043', 'LOC:0196F3A0-0000-7000-8000-0000000000B1', 'Ünïcode ✓']) {
      const bitmap = barcodeBitmap('qr', code);
      const [matrix] = bwip.raw('qrcode', code, '') as Array<{
        pixs: number[];
        pixx: number;
        pixy: number;
      }>;
      expect(bitmap.modules).toBe(matrix!.pixx + 8);
      expect(bitmap.height).toBe((matrix!.pixy + 8) * PIXELS_PER_MODULE);
      for (let y = 0; y < bitmap.modules; y++) {
        for (let x = 0; x < bitmap.modules; x++) {
          const inside = y >= 4 && x >= 4 && y < matrix!.pixy + 4 && x < matrix!.pixx + 4;
          const dark = inside && matrix!.pixs[(y - 4) * matrix!.pixx + (x - 4)] === 1;
          // Every pixel of the module has the module's colour.
          for (let dy = 0; dy < PIXELS_PER_MODULE; dy++)
            for (let dx = 0; dx < PIXELS_PER_MODULE; dx++) {
              const p =
                bitmap.pixels[
                  (y * PIXELS_PER_MODULE + dy) * bitmap.width + x * PIXELS_PER_MODULE + dx
                ];
              if (p !== (dark ? 0 : 255)) throw new Error(`QR module ${x},${y} of ${code}`);
            }
        }
      }
    }
  });

  it('prints "other" codes as Code 128 when they fit it, else as QR', () => {
    expect(barcodeBitmap('other', 'SUP-77/a').linear).toBe(true);
    expect(barcodeBitmap('other', 'Größe').linear).toBe(false);
    expect(() => barcodeBitmap('ean13', '123')).toThrow();
  });
});

describe('label PDF', () => {
  it('embeds exactly the rasterizer bitmaps, once per code, inside each label', async () => {
    const labels = CODES.map(([symbology, code], i) =>
      label({ symbology, code }, { copies: i === 0 ? 3 : 1 }),
    );
    const pdf = await buildLabelPdf({ layout: 'a4_3x8', labels }, fonts);
    expect(pdf).toMatchObject({ labels: 10, pages: 1, dense: 0, failed: [], missing: [] });
    const read = await readLabelPdf(pdf.bytes);
    expect(read.pages).toBe(1);
    expect(read.images).toHaveLength(CODES.length);
    expect(read.placements).toHaveLength(10);

    const layout = LABEL_LAYOUTS.a4_3x8;
    const pageHeight = layout.page.height * PT_PER_MM;
    const byRef = new Map(read.images.map((img) => [img.ref, img]));
    const expected = CODES.map(([s, c]) => barcodeBitmap(s, c));
    for (const [slot, placement] of read.placements.entries()) {
      const image = byRef.get(placement.ref)!;
      const index = slot < 3 ? 0 : slot - 2;
      const bitmap = expected[index]!;
      expect([image.width, image.height]).toEqual([bitmap.width, bitmap.height]);
      expect(Buffer.from(image.pixels).equals(Buffer.from(bitmap.pixels))).toBe(true);
      // Within the label's padding: slot n is column n % 3, row n / 3.
      const col = slot % layout.columns;
      const row = Math.floor(slot / layout.columns);
      const left = (col * layout.labelWidth + layout.padding) * PT_PER_MM;
      const right = ((col + 1) * layout.labelWidth - layout.padding) * PT_PER_MM;
      const top =
        pageHeight - (layout.marginTop + row * layout.labelHeight + layout.padding) * PT_PER_MM;
      const bottom =
        pageHeight -
        (layout.marginTop + (row + 1) * layout.labelHeight - layout.padding) * PT_PER_MM;
      expect(placement.x).toBeGreaterThanOrEqual(left - 0.01);
      expect(placement.x + placement.width).toBeLessThanOrEqual(right + 0.01);
      expect(placement.y).toBeGreaterThanOrEqual(bottom - 0.01);
      expect(placement.y + placement.height).toBeLessThanOrEqual(top + 0.01);
      // Square modules for QR; whole modules across for every symbol.
      const module = placement.width / bitmap.modules / PT_PER_MM;
      expect(module).toBeGreaterThanOrEqual(0.19);
      if (!bitmap.linear) expect(placement.height).toBeCloseTo(placement.width, 3);
    }
  });

  it.each(LABEL_LAYOUT_KEYS)('every barcode on %s labels decodes to its code', async (layout) => {
    const pdf = await buildLabelPdf(
      { layout, labels: CODES.map(([symbology, code]) => label({ symbology, code })) },
      fonts,
    );
    const read = await readLabelPdf(pdf.bytes);
    const perPage = LABEL_LAYOUTS[layout].columns * LABEL_LAYOUTS[layout].rows;
    expect(read.pages).toBe(Math.ceil(CODES.length / perPage));
    const decoded = new Set<string>();
    for (const image of read.images) {
      const found = await decodeGrey(image);
      expect(found).toHaveLength(1);
      decoded.add(normalizeBarcode(found[0]!.text));
    }
    expect(decoded).toEqual(new Set(CODES.map(([, code]) => normalizeBarcode(code))));
  });

  it('starts a partly used sheet at a later position', async () => {
    const pdf = await buildLabelPdf(
      {
        layout: 'a4_4x10',
        skip: 38,
        labels: [label({ symbology: 'code128', code: 'AS00000042' }, { copies: 3 })],
      },
      fonts,
    );
    const read = await readLabelPdf(pdf.bytes);
    expect(pdf.pages).toBe(2);
    expect(read.placements.map((p) => p.page)).toEqual([0, 0, 1]);
    // Position 39 is the bottom row, third column.
    const layout = LABEL_LAYOUTS.a4_4x10;
    expect(read.placements[0]!.x).toBeGreaterThan(2 * layout.labelWidth * PT_PER_MM);
    expect(read.placements[0]!.y).toBeLessThan(layout.labelHeight * PT_PER_MM);
  });

  it('keeps text inside the label: long text wraps, shrinks, and is cut', async () => {
    const long = 'Extra long product name with a great many words that cannot fit on one label';
    const symbols = [
      null,
      { symbology: 'ean13' as const, code: '4006381333931' },
      { symbology: 'qr' as const, code: 'AS00000043' },
    ];
    const labels = symbols.map((barcode) =>
      label(barcode, {
        title: long,
        lines: [
          { text: 'SKU-THAT-IS-VERY-LONG-INDEED-0000000001' },
          { text: 'Midnight blue / Extra extra large / Organic cotton' },
          { text: '1234567.89 EUR', strong: true },
          { text: 'Case · 12 each' },
        ],
      }),
    );
    const metrics = await labelMetrics(labels, fonts);
    for (const key of LABEL_LAYOUT_KEYS) {
      const layout = LABEL_LAYOUTS[key];
      for (const one of labels) {
        const plan = planLabel(one, layout, metrics);
        const right = (layout.labelWidth - layout.padding) * PT_PER_MM;
        const bottom = (layout.labelHeight - layout.padding) * PT_PER_MM;
        const texts = plan.ops.filter((o) => o.kind === 'text');
        expect(texts.length).toBeGreaterThan(0);
        for (const op of plan.ops) {
          if (op.kind === 'text') {
            expect(op.x).toBeGreaterThanOrEqual(layout.padding * PT_PER_MM - 0.01);
            expect(op.x + metrics.width(op.text, op.size, op.bold)).toBeLessThanOrEqual(
              right + 0.01,
            );
            expect(op.baseline).toBeLessThanOrEqual(bottom + 0.01);
            expect(op.size).toBeGreaterThanOrEqual(5);
          } else {
            expect(op.x + op.width).toBeLessThanOrEqual(right + 0.01);
            expect(op.top + op.height).toBeLessThanOrEqual(bottom + 0.01);
          }
        }
        // Text never runs into the barcode.
        const symbol = plan.ops.find((o) => o.kind === 'barcode');
        if (symbol?.kind === 'barcode') {
          for (const t of texts) {
            const beside = t.x + metrics.width(t.text, t.size, t.bold) <= symbol.x + 0.01;
            const above = t.baseline <= symbol.top + 0.01;
            // Noto Sans capitals rise 0.714 of the size above the baseline.
            const below = t.baseline - t.size * 0.72 >= symbol.top + symbol.height - 0.01;
            expect(beside || above || below).toBe(true);
          }
        }
      }
    }
  });

  it('cuts location paths from the start, so the most specific part stays', async () => {
    const path = 'Main warehouse/Aisle 12/Rack 4/Shelf 3/Bin 17 with a long name';
    const metrics = await labelMetrics([label(null, { title: path, keepEnd: true })], fonts);
    const fits = (s: string) => metrics.width(s, 8, true) <= 100;
    const lines = wrapText(path, 2, fits, true);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith('…')).toBe(true);
    expect(lines.join(' ')).toContain('Bin 17 with a long name');
    for (const l of lines) expect(fits(l)).toBe(true);
  });

  it('prints Romanian, Polish, Greek, and Cyrillic names exactly, in the Noto Sans glyphs', async () => {
    const names = [
      'Rochie roșie, mărimea 38',
      'Cană țărănească ăâî ĂÂÎȘȚ',
      'Żółta łódź, źdźbło',
      'Κούπα κεραμική, μπλε',
      'Кружка, ґанок, їжак',
    ];
    const labels = names.map((name) => label(null, { title: name, lines: [{ text: name }] }));
    const metrics = await labelMetrics(labels, fonts);
    expect(metrics.missing).toEqual([]);
    for (const name of names) expect(metrics.clean(name, true)).toBe(name);
    const pdf = await buildLabelPdf({ layout: 'thermal_100x50', labels }, fonts);
    expect(pdf.missing).toEqual([]);

    const read = await readLabelPdf(pdf.bytes);
    // Each name is drawn whole, once in bold as the title and once in regular.
    for (const name of names) {
      expect(read.texts.filter((t) => t.text === name)).toHaveLength(2);
    }
    expect(read.fonts.map((f) => f.baseFont.split('-').slice(0, 2).join('-')).sort()).toEqual([
      'NotoSans-Bold',
      'NotoSans-Regular',
    ]);
    // The subsets hold the same outlines as the fonts they came from: a misplaced glyph record
    // would draw another letter, or nothing.
    for (const font of read.fonts) {
      const file = font.baseFont.includes('Bold') ? 'NotoSans-Bold.ttf' : 'NotoSans-Regular.ttf';
      const source = fontkit.create(await fontFile(file));
      const subset = fontkit.create(font.program);
      expect(font.unicode.size).toBeGreaterThan(30);
      for (const [id, text] of font.unicode) {
        expect(subset.getGlyph(id).path.toSVG(), text).toBe(
          source.glyphForCodePoint(text.codePointAt(0)!).path.toSVG(),
        );
      }
    }
  });

  it('lists the characters no font has, which print as "?"', async () => {
    const labels = [label({ symbology: 'qr', code: 'Größe ș 名前' }, { title: 'Ceașcă 🎉 한글' })];
    const metrics = await labelMetrics(labels, fonts);
    expect(metrics.missing).toEqual(['🎉', '한', '글']);
    expect(metrics.clean('Ceașcă 🎉 한글', true)).toBe('Ceașcă ? ??');
    // Invisible characters are dropped, not reported: a variation selector, a zero-width joiner.
    expect(metrics.clean('Mug\u{FE0F} A\u200DB', false)).toBe('Mug AB');
    const pdf = await buildLabelPdf({ layout: 'thermal_100x50', labels }, fonts);
    expect(pdf.missing).toEqual(['🎉', '한', '글']);
    const read = await readLabelPdf(pdf.bytes);
    expect(read.texts.map((t) => t.text)).toContain('Ceașcă ? ??');
    expect(read.texts.map((t) => t.text).join(' ')).toContain('名前');
  });

  it('fetches a script’s font only when a label has its characters', async () => {
    const fetched: string[] = [];
    const library = fromDisk(fetched);
    await buildLabelPdf(
      {
        layout: 'a4_3x8',
        labels: [label({ symbology: 'code128', code: 'AS00000042' }, { title: 'Rochie roșie' })],
      },
      library,
    );
    await labelMetrics([label(null, { title: 'Κούπα', lines: [{ text: 'Кружка' }] })], library);
    expect(fetched).toEqual(['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf']);
    await labelMetrics([label(null, { title: null, lines: [{ text: 'قميص أحمر' }] })], library);
    expect(fetched.slice(2)).toEqual(['NotoSansArabic-Regular.ttf']);
    await labelMetrics([label(null, { title: 'חולצה', lines: [] })], library);
    expect(fetched.slice(3)).toEqual(['NotoSansHebrew-Bold.ttf']);
    // Chinese has no bold file: bold text outlines the regular glyphs.
    const cjk = await labelMetrics(
      [label(null, { title: '陶瓷杯', lines: [{ text: 'เสื้อ' }, { text: 'कमीज़' }] })],
      library,
    );
    expect(fetched.slice(4).sort()).toEqual([
      'NotoSansDevanagari-Regular.ttf',
      'NotoSansSC-Regular.ttf',
      'NotoSansThai-Regular.ttf',
    ]);
    expect(cjk.line('陶瓷杯', true).runs.map((r) => [r.face.file, r.face.synthetic])).toEqual([
      ['NotoSansSC-Regular.ttf', true],
    ]);
    expect(cjk.missing).toEqual([]);
  });

  it('orders right-to-left text with the bidi algorithm', async () => {
    const lines = [
      'قميص أحمر (كبير) XL',
      'חולצה מידה 42',
      'سعر ١٢٣',
      'Size מידה 42',
      'Rochie roșie',
    ];
    const metrics = await labelMetrics(
      [label(null, { lines: lines.map((text) => ({ text })) })],
      fonts,
    );
    /** The characters of the glyphs, left to right as drawn. */
    const drawn = (text: string) =>
      metrics
        .line(text, false)
        .runs.flatMap((r) => r.glyphs.map((g) => String.fromCodePoint(...g.codePoints)))
        .join('');
    const backwards = (text: string) => [...text].reverse().join('');
    // Brackets are mirrored, and Latin and numbers keep their own direction.
    expect(drawn(lines[0]!)).toBe(`XL (${backwards('كبير')}) ${backwards('قميص أحمر')}`);
    expect(drawn(lines[1]!)).toBe(`42 ${backwards('חולצה מידה')}`);
    expect(drawn(lines[2]!)).toBe(`١٢٣ ${backwards('سعر')}`);
    expect(drawn(lines[3]!)).toBe(`Size 42 ${backwards('מידה')}`);
    expect(drawn(lines[4]!)).toBe('Rochie roșie');
    // Noto Sans Arabic has no brackets or Latin, so those come from Noto Sans.
    expect(metrics.line(lines[0]!, false).runs.map((r) => [r.face.file, r.text])).toEqual([
      ['NotoSans-Regular.ttf', 'XL'],
      ['NotoSans-Regular.ttf', ' ('],
      ['NotoSansArabic-Regular.ttf', 'كبير'],
      ['NotoSans-Regular.ttf', ')'],
      ['NotoSansArabic-Regular.ttf', 'قميص أحمر '],
    ]);
  });

  it('pads odd-length glyph records, keeping every outline', async () => {
    const raw = await fontFile('NotoSans-Regular.ttf');
    const padded = evenGlyphs(raw);
    expect(padded).not.toBe(raw);
    const before = fontkit.create(raw);
    const after = fontkit.create(padded);
    expect(after.numGlyphs).toBe(before.numGlyphs);
    for (let id = 0; id < before.numGlyphs; id++)
      expect(after.getGlyph(id).path.toSVG()).toBe(before.getGlyph(id).path.toSVG());
    // A font with no odd records comes back unchanged.
    const thai = await fontFile('NotoSansThai-Regular.ttf');
    expect(evenGlyphs(thai)).toBe(thai);
  });

  it('breaks lines between words in scripts written without spaces', async () => {
    const metrics = await labelMetrics([label(null, { title: '陶瓷杯中文名称，白色' })], fonts);
    const fits = (s: string) => metrics.width(s, 10, true) <= 60;
    const lines = wrapText('陶瓷杯中文名称，白色', 2, fits);
    expect(lines).toHaveLength(2);
    expect(lines.join('')).toBe('陶瓷杯中文名称，白色');
    for (const l of lines) expect(fits(l)).toBe(true);
  });

  it('says when a code is too long to print at the label size', async () => {
    const pdf = await buildLabelPdf(
      {
        layout: 'thermal_50x25',
        labels: [
          label({ symbology: 'code128', code: 'A long Code 128 value ~ with lowercase text' }),
        ],
      },
      fonts,
    );
    expect(pdf.dense).toBe(1);
  });
});

describe('label content', () => {
  const items: ItemLabels = {
    template: { name: 'Custom', layout: 'a4_3x8', fields: ['price', 'name', 'sku', 'pack'] },
    currency: 'EUR',
    total: 2,
    missingBarcodes: 1,
    labels: [
      {
        kind: 'pack',
        variantId: '0196f3a0-0000-7000-8000-000000000011',
        packId: '0196f3a0-0000-7000-8000-000000000012',
        copies: 2,
        name: 'Mug',
        sku: 'MUG-01',
        options: 'Blue',
        price: '150',
        pack: 'Case · 12 each',
        barcode: { symbology: 'code128', code: 'AS00000001' },
      },
    ],
  };

  it('shows the template fields in its order, and the barcode only when chosen', () => {
    expect(itemPrintLabels(items)).toEqual([
      {
        copies: 2,
        title: 'Mug',
        lines: [
          { text: '150.00 EUR', strong: true },
          { text: 'MUG-01' },
          { text: 'Case · 12 each' },
        ],
        barcode: null,
      },
    ]);
    expect(
      locationPrintLabels({
        template: { name: 'Bins', layout: 'a4_3x8', fields: ['path', 'code', 'barcode'] },
        total: 1,
        labels: [
          {
            locationId: '0196f3a0-0000-7000-8000-0000000000b1',
            copies: 1,
            path: 'Main/A/1',
            code: 'A-01',
            warehouse: 'Main',
            barcode: { symbology: 'qr', code: 'LOC:0196F3A0-0000-7000-8000-0000000000B1' },
          },
        ],
      }),
    ).toEqual([
      {
        copies: 1,
        title: 'Main/A/1',
        keepEnd: true,
        lines: [{ text: 'A-01', strong: true }],
        barcode: { symbology: 'qr', code: 'LOC:0196F3A0-0000-7000-8000-0000000000B1' },
      },
    ]);
  });
});
