import { expect, test } from '@playwright/test';

// N7 in the dashboard: upload, map, preview, import, and export with a download (F10).

test('imports a CSV with variants and exports it back', async ({ page }) => {
  await page.goto('/__e2e/login?email=e2e-import@example.test');
  await page.getByLabel('Shop name').fill('Import shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByRole('grid', { name: 'Products' })).toBeVisible();
  await page.getByRole('link', { name: 'Import' }).click();

  const csv = [
    'product,name,sku,price,option:Size',
    'TEE,Plain tee,TEE-S,15,S',
    'TEE,Plain tee,TEE-M,15,M',
    ',Mug,MUG-1,8,',
    ',Bad,BAD-1,abc,',
  ].join('\n');
  await page
    .getByLabel('CSV file (UTF-8, comma or semicolon)')
    .setInputFiles({ name: 'catalog.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Read the columns' }).click();
  await expect(page.getByLabel('Target for sku')).toHaveValue('sku');
  await expect(page.getByLabel('Target for option:Size')).toHaveValue('option:Size');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('Use a price such as 19.90.')).toBeVisible();
  await page.getByRole('button', { name: 'Import 3 rows' }).click();
  await expect(page.getByText('Imported 3 rows.')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('link', { name: 'Back to products' }).click();
  await expect(page.getByText('3 variants')).toBeVisible();
  await expect(page.getByRole('gridcell', { name: 'TEE-M' })).toBeVisible();

  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download 3 rows' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^airstock-variants-.*\.csv$/);
  const text = await (await file.createReadStream())
    .toArray()
    .then((chunks) => Buffer.concat(chunks).toString('utf8'));
  expect(text).toContain('TEE-M');
  expect(text).toContain('option:Size');
});
