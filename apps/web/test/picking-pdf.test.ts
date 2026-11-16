import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FontLibrary } from '../src/labels/fonts.ts';
import { buildPickListPdf } from '../src/picking/pdf.ts';
import {
  linePacks,
  type PickLineView,
  type PickListView,
  sectionsOf,
} from '../src/picking/view.ts';
import { readLabelPdf } from './pdf-images.ts';

// The printed pick list (plan 5.11): drawn in the browser with pdf-lib and the Noto label fonts,
// lines grouped by location in walk order, each with quantity and packs, SKU, name, lot or
// serial, and order reference. The text is read back out of the PDF file.

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../worker/public/assets/fonts');
const fonts = new FontLibrary(async (file) => new Uint8Array(await readFile(join(FONT_DIR, file))));

const id = (n: number) => `0196f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

function line(n: number, over: Partial<PickLineView> = {}): PickLineView {
  return {
    lineId: id(n),
    sequence: n,
    status: 'open',
    locationId: id(1000 + Math.floor((n - 1) / 5)),
    locationPath: `Main stock/A-${String(Math.floor((n - 1) / 5) + 1).padStart(2, '0')}`,
    variantId: id(2000 + n),
    productName: `Booster box ${n}`,
    variantName: null,
    sku: `BOX-${n}`,
    quantity: '1',
    inPacks: { packs: [], looseUnits: '1' },
    picked: '0',
    short: '0',
    moved: '0',
    remaining: '1',
    lotId: null,
    lotCode: null,
    expiresOn: null,
    serialId: null,
    serial: null,
    reservationId: id(3000 + n),
    allocationId: id(4000 + n),
    positionId: id(5000 + n),
    externalRef: `api:order/${1000 + n}`,
    fulfillOnComplete: true,
    ...over,
  };
}

function list(lines: PickLineView[]): PickListView {
  return {
    pickListId: id(1),
    number: 4,
    status: 'open',
    filters: {},
    note: null,
    createdAt: '2026-11-16T09:00:00.000Z',
    completedAt: null,
    lines: lines.length,
    openLines: lines.length,
    shortLines: 0,
    orders: lines.length,
    version: 1,
    partial: false,
    pickLines: lines,
  };
}

describe('pick list PDF', () => {
  it('prints every open line under its location, in walk order', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => line(i + 1));
    lines[0] = line(1, {
      productName: 'Bol roșu',
      quantity: '7',
      remaining: '7',
      inPacks: { packs: [{ packId: id(9), name: 'Case', count: '1' }], looseUnits: '1' },
      lotCode: 'L-2311',
      expiresOn: '2027-03-31',
    });
    lines[1] = line(2, { serial: '84731629' });
    lines[2] = line(3, { status: 'picked', remaining: '0', picked: '1' });
    const bytes = await buildPickListPdf(list(lines), { shopName: 'Card shop', fonts });
    const pdf = await readLabelPdf(bytes);
    const texts = pdf.texts.map((t) => t.text);
    expect(texts).toContain('Pick list 4');
    expect(texts).toContain('Bol roșu');
    expect(texts).toContain('7 (1 Case + 1)');
    expect(texts).toContain('Lot L-2311 2027-03-31');
    expect(texts).toContain('SN 84731629');
    expect(texts).toContain('api:order/1060');
    // A picked line is not printed again.
    expect(texts).not.toContain('BOX-3');
    // Sixty lines take two pages, and the locations come in path order.
    const pages = new Set(pdf.texts.map((t) => t.page));
    expect(pages.size).toBe(2);
    expect(texts.filter((t) => t.startsWith('Page '))).toEqual(['Page 1 of 2', 'Page 2 of 2']);
    const headings = pdf.texts
      .filter((t) => /^Main stock\/A-\d\d$/.test(t.text))
      .map((t) => t.text);
    expect(headings).toEqual([...headings].sort());
    expect(headings).toHaveLength(12);
  });

  it('groups lines by location and spells out packs', () => {
    const sections = sectionsOf([line(1), line(2), line(6)]);
    expect(sections.map((s) => [s.path, s.lines.length])).toEqual([
      ['Main stock/A-01', 2],
      ['Main stock/A-02', 1],
    ]);
    expect(linePacks({ inPacks: { packs: [], looseUnits: '3' } })).toBe('');
    expect(
      linePacks({
        inPacks: { packs: [{ packId: id(9), name: 'Case', count: '2' }], looseUnits: '0' },
      }),
    ).toBe('(2 Case)');
  });
});
