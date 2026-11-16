import { expect, type Page, test } from '@playwright/test';

// G5 in a real browser: the products grid shows on hand at one shelf, a number typed there is a
// one-line count, a shelf that moved since it was read asks before anything changes, and the
// count is in the activity history. G6: the lot trace in the stock panel exports as CSV.

async function call(page: Page, path: string, body?: unknown): Promise<Record<string, unknown>> {
  return page.evaluate(
    async ([p, b]) => {
      const res = await fetch(`/api/v1${p}`, {
        method: b === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          'x-airstock-request': '1',
          'idempotency-key': crypto.randomUUID(),
        },
        ...(b === undefined ? {} : { body: JSON.stringify(b) }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    [path, body] as const,
  );
}

const cell = (page: Page, row: number, col: number) => page.locator(`#cell-${row}-${col}`);

async function newShop(page: Page, email: string, name: string): Promise<string> {
  await page.goto(`/__e2e/login?email=${email}`);
  await page.getByLabel('Shop name').fill(name);
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByRole('grid', { name: 'Products' })).toBeVisible();
  return new URL(page.url()).pathname.split('/')[3]!;
}

test('a quantity typed in the grid is a count, reviewed when the shelf moved', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) {
      violations.push(message.text());
    }
  });
  const shopId = await newShop(page, 'e2e-grid-count@example.test', 'Grid count shop');
  const item = await call(page, `/shops/${shopId}/items`, { name: 'Sleeve box', sku: 'GRID-CT-1' });
  const locations = (await call(page, `/shops/${shopId}/locations`)) as {
    locations: Array<{ locationId: string; path: string; holdsStockAllowed: boolean }>;
  };
  const shelf = locations.locations.find((l) => l.holdsStockAllowed)!;
  await call(page, `/shops/${shopId}/receipts`, {
    variantId: item.variantId,
    locationId: shelf.locationId,
    quantity: '10',
  });

  await page.goto(`/app/shops/${shopId}/products`);
  const grid = page.getByRole('grid', { name: 'Products' });
  await expect(cell(page, 0, 0)).toContainText('Sleeve box');
  await page.getByRole('combobox', { name: 'Stock at' }).selectOption({
    label: `On hand at ${shelf.path}`,
  });
  const header = page.getByRole('columnheader', { name: `On hand · ${shelf.path}` });
  await expect(header).toBeVisible();
  const col = Number(await header.getAttribute('aria-colindex')) - 1;
  await expect(cell(page, 0, col)).toHaveText('10');

  // Keyboard as in every other cell: move there, type, Enter.
  await cell(page, 0, 0).click();
  for (let i = 0; i < col; i++) await grid.press('ArrowRight');
  await expect(cell(page, 0, col)).toHaveClass(/active/);
  await grid.press('7');
  await page.getByRole('textbox', { name: `On hand · ${shelf.path}` }).press('Enter');
  await expect(cell(page, 0, col)).toHaveText('7');
  await expect(cell(page, 0, col)).not.toHaveClass(/state-/);
  const stock = (await call(page, `/shops/${shopId}/availability?variantId=${item.variantId}`)) as {
    totals: { onHand: string };
  };
  expect(stock.totals.onHand).toBe('7.000000');

  // Someone receives 5 while the grid still shows 7: the next count asks first.
  await call(page, `/shops/${shopId}/receipts`, {
    variantId: item.variantId,
    locationId: shelf.locationId,
    quantity: '5',
  });
  await cell(page, 0, col).click();
  await grid.press('3');
  await page.getByRole('textbox', { name: `On hand · ${shelf.path}` }).press('Enter');
  await expect(cell(page, 0, col)).toHaveClass(/state-review/);
  await expect(
    page.getByText(/Stock moved here since you read it: on hand was 7, now 12/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Keep my count (3)' }).click();
  await expect(cell(page, 0, col)).toHaveText('3');
  await expect(cell(page, 0, col)).not.toHaveClass(/state-/);

  // Both counts are in the history as quick counts.
  await page.goto(`/app/shops/${shopId}/activity`);
  const table = page.getByRole('table', { name: 'Activity' });
  await expect(table.getByText('inventory.count.quick').first()).toBeVisible();
  expect(await table.getByText('inventory.count.quick').count()).toBeGreaterThanOrEqual(2);
  expect(violations).toEqual([]);
});

test('the lot trace in the stock panel exports as CSV', async ({ page }) => {
  const shopId = await newShop(page, 'e2e-lot-trace@example.test', 'Lot trace shop');
  const item = await call(page, `/shops/${shopId}/items`, { name: 'Oat milk', sku: 'LOT-TR-1' });
  await call(page, `/shops/${shopId}/variants/${item.variantId}/stock-settings`, {
    trackingMode: 'lot_expiry',
  });
  const locations = (await call(page, `/shops/${shopId}/locations`)) as {
    locations: Array<{ locationId: string; holdsStockAllowed: boolean }>;
  };
  const shelf = locations.locations.find((l) => l.holdsStockAllowed)!;
  await call(page, `/shops/${shopId}/receipts`, {
    variantId: item.variantId,
    locationId: shelf.locationId,
    quantity: '6',
    lotCode: 'OAT-0425',
    expiresOn: '2030-04-25',
  });
  const r = await call(page, `/shops/${shopId}/reservations`, {
    variantId: item.variantId,
    quantity: '2',
    externalRef: 'shop:order/77',
  });
  await call(page, `/shops/${shopId}/reservations/${r.reservationId}/fulfill`, {});

  await page.goto(`/app/shops/${shopId}/inventory`);
  await page.getByLabel('SKU').fill('LOT-TR-1');
  await page.getByRole('button', { name: 'Show stock' }).click();
  await page.getByRole('button', { name: 'Trace lot OAT-0425' }).click();
  const trace = page.locator('section.panel', {
    has: page.getByRole('heading', { name: 'Lot trace · OAT-0425' }),
  });
  await expect(trace.getByText('shop:order/77 (2)')).toBeVisible();
  await expect(trace.getByRole('table', { name: 'Lot movements' }).getByRole('row')).toHaveCount(3);
  const download = page.waitForEvent('download');
  await trace.getByRole('button', { name: 'Export CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^airstock-lot-trace-OAT-0425-[0-9a-f]{8}\.csv$/);
  const text = await (await file.createReadStream()).toArray();
  const csv = Buffer.concat(text).toString('utf8');
  expect(csv).toContain('occurred_at,lot,sku,expires_on,movement,quantity');
  expect(csv).toContain('shop:order/77');
});
