import type { Symbology } from '@airstock/core/barcodes';
import { normalizeBarcode } from '@airstock/core/barcodes';
import { LABEL_LAYOUT_KEYS, LABEL_LAYOUTS } from '@airstock/core/labels';
import bwip from 'bwip-js/node';
import { describe, expect, it } from 'vitest';
import { barcodeBitmap, PIXELS_PER_MODULE } from '../src/labels/barcode.ts';
import {
  type ItemLabels,
  itemPrintLabels,
  locationPrintLabels,
  type PrintLabel,
} from '../src/labels/content.ts';
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
    const pdf = await buildLabelPdf({ layout: 'a4_3x8', labels });
    expect(pdf).toMatchObject({ labels: 10, pages: 1, dense: 0, failed: [] });
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
    const pdf = await buildLabelPdf({
      layout,
      labels: CODES.map(([symbology, code]) => label({ symbology, code })),
    });
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
    const pdf = await buildLabelPdf({
      layout: 'a4_4x10',
      skip: 38,
      labels: [label({ symbology: 'code128', code: 'AS00000042' }, { copies: 3 })],
    });
    const read = await readLabelPdf(pdf.bytes);
    expect(pdf.pages).toBe(2);
    expect(read.placements.map((p) => p.page)).toEqual([0, 0, 1]);
    // Position 39 is the bottom row, third column.
    const layout = LABEL_LAYOUTS.a4_4x10;
    expect(read.placements[0]!.x).toBeGreaterThan(2 * layout.labelWidth * PT_PER_MM);
    expect(read.placements[0]!.y).toBeLessThan(layout.labelHeight * PT_PER_MM);
  });

  it('keeps text inside the label: long text wraps, shrinks, and is cut', async () => {
    const metrics = await labelMetrics();
    const long = 'Extra long product name with a great many words that cannot fit on one label';
    for (const key of LABEL_LAYOUT_KEYS) {
      const layout = LABEL_LAYOUTS[key];
      for (const barcode of [
        null,
        { symbology: 'ean13' as const, code: '4006381333931' },
        { symbology: 'qr' as const, code: 'AS00000043' },
      ]) {
        const plan = planLabel(
          label(barcode, {
            title: long,
            lines: [
              { text: 'SKU-THAT-IS-VERY-LONG-INDEED-0000000001' },
              { text: 'Midnight blue / Extra extra large / Organic cotton' },
              { text: '1234567.89 EUR', strong: true },
              { text: 'Case · 12 each' },
            ],
          }),
          layout,
          metrics,
        );
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
            // Helvetica capitals rise 0.72 of the size above the baseline.
            const below = t.baseline - t.size * 0.72 >= symbol.top + symbol.height - 0.01;
            expect(beside || above || below).toBe(true);
          }
        }
      }
    }
  });

  it('cuts location paths from the start, so the most specific part stays', async () => {
    const metrics = await labelMetrics();
    const fits = (s: string) => metrics.width(s, 8, true) <= 100;
    const lines = wrapText(
      'Main warehouse/Aisle 12/Rack 4/Shelf 3/Bin 17 with a long name',
      2,
      fits,
      true,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith('…')).toBe(true);
    expect(lines.join(' ')).toContain('Bin 17 with a long name');
    for (const l of lines) expect(fits(l)).toBe(true);
  });

  it('prints text the standard fonts lack without failing', async () => {
    const metrics = await labelMetrics();
    expect(metrics.clean('Rochie roșie, mărimea 38 – 名前 €')).toBe(
      'Rochie rosie, marimea 38 – ?? €',
    );
    const pdf = await buildLabelPdf({
      layout: 'thermal_50x25',
      labels: [label({ symbology: 'qr', code: 'Größe ș 名前' }, { title: 'Ceașcă 名前 🎉' })],
    });
    expect(pdf.labels).toBe(1);
  });

  it('says when a code is too long to print at the label size', async () => {
    const pdf = await buildLabelPdf({
      layout: 'thermal_50x25',
      labels: [
        label({ symbology: 'code128', code: 'A long Code 128 value ~ with lowercase text' }),
      ],
    });
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
