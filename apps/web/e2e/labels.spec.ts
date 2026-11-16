import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalizeBarcode, parseLocationCode } from '@airstock/core/barcodes';
import { expect, type Page, test } from '@playwright/test';
import { readLabelPdf } from '../test/pdf-images.ts';
import { decodeGrey } from '../test/zxing.ts';

// F8, A33 in a real browser: labels drawn by the dashboard under its CSP, saved as a PDF, and
// every barcode in that file decoded with the vendored zxing-wasm and resolved to its record.
// Decoding runs in the test process with the same zxing-reader.js and zxing_reader.wasm that the
// scanner at /app/scan loads, so the check reads the PDF file itself.

function api(page: Page, shopId: string) {
  return async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await page.request.fetch(`/api/v1/shops/${shopId}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-airstock-request': '1',
        ...(body === undefined ? {} : { 'idempotency-key': randomUUID() }),
      },
      ...(body === undefined ? {} : { data: body }),
    });
    expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
    return (await res.json()) as T;
  };
}

interface Packaging {
  packsVersion: number;
  barcodesVersion: number;
  packs: Array<{ id: string; name: string }>;
}

/** Every barcode in a downloaded label PDF, decoded. */
async function decodePdf(path: string) {
  const pdf = await readLabelPdf(new Uint8Array(await readFile(path)));
  const texts: string[] = [];
  for (const image of pdf.images) {
    const found = await decodeGrey(image);
    expect(found, `image ${image.ref} decodes to one symbol`).toHaveLength(1);
    texts.push(found[0]!.text);
  }
  return { pdf, texts };
}

test('every barcode on printed labels decodes back to its record', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) {
      violations.push(message.text());
    }
  });

  await page.goto('/__e2e/login?email=e2e-labels@example.test');
  await page.getByLabel('Shop name').fill('Label shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByText('No products yet. Add one to start.')).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3]!;
  const call = api(page, shopId);

  // Four variants: EAN-13 and UPC-A as entered, Code 128 and QR generated; and a case of mugs
  // with its own generated code. The bowl's name has a Romanian "ș".
  const variants: Record<string, string> = {};
  for (const [key, sku, name] of [
    ['Bowl', 'BOWL-1', 'Bol roșu'],
    ['Lamp', 'LAMP-1', 'Lamp'],
    ['Mug', 'MUG-1', 'Mug'],
    ['Plate', 'PLATE-1', 'Plate'],
  ] as const) {
    const created = await call<{ variantId: string }>('/items', {
      name,
      sku,
      price: '12.50',
      acknowledgeSimilar: true,
    });
    variants[key] = created.variantId;
  }
  const packaging = (variantId: string) => call<Packaging>(`/variants/${variantId}/packaging`);
  await call(`/variants/${variants.Mug}/barcodes`, {
    barcodesVersion: (await packaging(variants.Mug!)).barcodesVersion,
    barcodes: [{ code: '4006381333931', symbology: 'ean13' }],
  });
  await call(`/variants/${variants.Lamp}/barcodes`, {
    barcodesVersion: (await packaging(variants.Lamp!)).barcodesVersion,
    barcodes: [{ code: '036000291452', symbology: 'upca' }],
  });
  await call(`/variants/${variants.Plate}/barcodes/generate`, { symbology: 'code128' });
  await call(`/variants/${variants.Bowl}/barcodes/generate`, { symbology: 'qr' });
  const withCase = await call<{ packaging: Packaging }>(`/variants/${variants.Mug}/packs`, {
    packsVersion: (await packaging(variants.Mug!)).packsVersion,
    packs: [{ name: 'Case', quantity: '12' }],
  });
  const caseId = withCase.packaging.packs[0]!.id;
  await call(`/variants/${variants.Mug}/barcodes/generate`, {
    symbology: 'code128',
    packId: caseId,
  });
  const { warehouses } = await call<{ warehouses: Array<{ warehouseId: string }> }>('/warehouses');
  const { locationId } = await call<{ locationId: string }>('/locations', {
    warehouseId: warehouses[0]!.warehouseId,
    name: 'Shelf A',
    code: 'A-01',
  });

  // Select the four rows in the grid and print them.
  await page.reload();
  const grid = page.getByRole('grid', { name: 'Products' });
  await grid.getByRole('gridcell', { name: 'BOWL-1' }).click();
  await grid.getByRole('gridcell', { name: 'PLATE-1' }).click({ modifiers: ['Shift'] });
  await page.getByRole('link', { name: 'Print labels (4)' }).click();
  await expect(page.getByRole('heading', { name: 'Labels' })).toBeVisible();
  const entries = page.locator('table.label-entries tbody tr');
  await expect(entries).toHaveCount(4);
  // The mug's row becomes its case; the single mug is added back from the search.
  const mugRow = entries.filter({ hasText: 'MUG-1' });
  await mugRow.getByLabel('Pack').focus();
  await expect(mugRow.getByRole('option', { name: 'Case (12)' })).toBeAttached();
  await mugRow.getByLabel('Pack').selectOption({ label: 'Case (12)' });
  await page.getByLabel('Find products').fill('Mug');
  await page
    .getByRole('listitem')
    .filter({ hasText: 'MUG-1' })
    .getByRole('button', { name: 'Add' })
    .click();
  await expect(entries).toHaveCount(5);
  await entries.filter({ hasText: 'LAMP-1' }).getByLabel('Copies').fill('3');
  await expect(page.getByText('7 labels on 1 sheet')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Preview of the first label' })).toBeVisible();

  const [items] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download PDF' }).click(),
  ]);
  expect(items.suggestedFilename()).toMatch(/^labels-\d{4}-\d{2}-\d{2}\.pdf$/);
  await expect(page.getByText(/7 labels on 1 page/)).toBeVisible();
  const printed = await decodePdf((await items.path())!);
  expect(printed.pdf.placements).toHaveLength(7);
  expect(printed.texts).toHaveLength(5);
  // The name prints as typed, in an embedded font, and the page warned about nothing.
  expect(printed.pdf.texts.map((t) => t.text)).toContain('Bol roșu');
  await expect(page.getByText(/No label font has/)).toHaveCount(0);

  // Each decoded code resolves, through lookup_barcode, to the variant or pack it was printed for.
  const resolved = new Set<string>();
  for (const text of printed.texts) {
    const { match } = await call<{
      match: { variantId: string; packId: string | null; baseQuantity: string } | null;
    }>(`/barcodes/lookup?code=${encodeURIComponent(text)}`);
    expect(match, `lookup of ${text}`).not.toBeNull();
    resolved.add(`${match!.variantId}:${match!.packId ?? ''}`);
  }
  expect(resolved).toEqual(
    new Set([
      `${variants.Bowl}:`,
      `${variants.Lamp}:`,
      `${variants.Mug}:`,
      `${variants.Plate}:`,
      `${variants.Mug}:${caseId}`,
    ]),
  );
  expect(printed.texts.map(normalizeBarcode)).toEqual(
    expect.arrayContaining([normalizeBarcode('036000291452'), normalizeBarcode('4006381333931')]),
  );

  // A location label carries a QR code of the location's ID.
  await page.getByRole('button', { name: 'Location labels' }).click();
  await page.getByLabel('Main stock/A-01 · Shelf A').check();
  await expect(page.getByText('1 label on 1 sheet')).toBeVisible();
  const [locations] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download PDF' }).click(),
  ]);
  const shelf = await decodePdf((await locations.path())!);
  expect(shelf.texts.map(parseLocationCode)).toEqual([locationId]);

  expect(violations).toEqual([]);
});
