import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';

// Reports in the dashboard (D15): the list of the eight reports, stock on hand with packs and
// totals, inventory value, saving a report and opening it from the list, and a CSV export.

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

test('runs stock on hand and inventory value, saves a report, and exports CSV', async ({
  page,
}) => {
  await page.goto('/__e2e/login?email=e2e-reports@example.test');
  await page.getByLabel('Shop name').fill('Reports shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByText('No products yet. Add one to start.')).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3]!;
  const call = api(page, shopId);

  const item = await call<{ variantId: string }>('/items', { name: 'Booster box', sku: 'BB-1' });
  await call(`/variants/${item.variantId}/packs`, {
    packsVersion: 0,
    packs: [{ name: 'Case', quantity: '6' }],
  });
  const locations = await call<{ locations: Array<{ locationId: string }> }>('/locations');
  await call('/receipts', {
    variantId: item.variantId,
    locationId: locations.locations[0]!.locationId,
    quantity: '14',
    unitCost: '95',
  });

  await page.goto(`/app/shops/${shopId}/reports`);
  await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
  const main = page.getByRole('main');
  for (const title of [
    'Stock on hand',
    'Low stock',
    'Movements',
    'Inventory value',
    'Cost of goods',
    'Purchasing',
    'Expiring lots',
    'Shortages',
  ]) {
    await expect(main.getByRole('link', { name: title, exact: true })).toBeVisible();
  }

  await main.getByRole('link', { name: 'Stock on hand', exact: true }).click();
  const table = page.locator('.report-table');
  await expect(table.getByRole('cell', { name: '2 × Case (6) + 2' })).toBeVisible();
  await expect(table.locator('tfoot')).toContainText('Total');
  await expect(table.locator('tfoot')).toContainText('EUR 1330.00');

  // Rows per variant, saved and opened again from the list.
  await page.getByLabel('Rows per').selectOption('variant');
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(table.getByRole('button', { name: 'Sellable' })).toBeVisible();
  await page.getByRole('button', { name: 'Save report' }).click();
  await page.getByLabel('Report name').fill('Stock per item');
  await page.getByRole('checkbox', { name: 'Share with the shop' }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Stock per item' })).toBeVisible();
  await page.getByRole('link', { name: 'All reports' }).click();
  await expect(page.locator('.plain-list').getByText('Shared')).toBeVisible();
  await main.getByRole('link', { name: 'Stock per item' }).click();
  await expect(table.getByRole('button', { name: 'Sellable' })).toBeVisible();

  // The CSV export runs as a job and downloads when ready.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/^airstock-report-stock_on_hand-.*\.csv$/);

  // Inventory value today, by location.
  await page.getByRole('link', { name: 'All reports' }).click();
  await main.getByRole('link', { name: 'Inventory value', exact: true }).click();
  await expect(table.locator('tfoot')).toContainText('EUR 1330.00');
  await expect(
    page.getByRole('navigation', { name: 'Shop' }).getByRole('link', { name: 'Reports' }),
  ).toBeVisible();
});
