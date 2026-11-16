import { expect, type Page, test } from '@playwright/test';

// Milestone I2 transfers in a real browser: create a ready transfer to another warehouse,
// dispatch part, receive it, cancel the rest, and move stock between two shelves, under the CSP.

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

test('transfers: ready, dispatch, receive, cancel, and a move', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) {
      violations.push(message.text());
    }
  });

  await page.goto('/__e2e/login?email=e2e-transfers@example.test');
  await page.getByLabel('Shop name').fill('Transfers shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByRole('grid', { name: 'Products' })).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3]!;

  const item = await call(page, `/shops/${shopId}/items`, { name: 'Booster box', sku: 'BOX-TR-1' });
  const locations = (await call(page, `/shops/${shopId}/locations`)) as {
    locations: Array<{ locationId: string; warehouseId: string }>;
  };
  const main = locations.locations[0]!;
  const shelf = await call(page, `/shops/${shopId}/locations`, {
    warehouseId: main.warehouseId,
    name: 'Shelf B2',
  });
  const store = await call(page, `/shops/${shopId}/warehouses`, { name: 'Store' });
  await call(page, `/shops/${shopId}/locations`, {
    warehouseId: store.warehouseId,
    name: 'Front',
  });
  await call(page, `/shops/${shopId}/receipts`, {
    variantId: item.variantId,
    locationId: main.locationId,
    quantity: '10',
  });

  await page.goto(`/app/shops/${shopId}/inventory/transfers`);
  await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
  await expect(page.getByText('No transfers here.')).toBeVisible();

  // A ready transfer of 6 to the store.
  const form = page.locator('form', { has: page.getByRole('heading', { name: 'New transfer' }) });
  await form.getByLabel(/^To/).selectOption({ label: 'Store/Front' });
  await form.getByLabel('SKU').fill('BOX-TR-1');
  await form.getByLabel('Quantity').fill('6');
  await form.getByLabel('Reference').fill('TR-E2E');
  await form.getByRole('button', { name: 'Create transfer' }).click();
  const detail = page.locator('section.panel', {
    has: page.getByRole('heading', { name: 'Transfer TR-E2E' }),
  });
  await expect(detail.getByText('Ready', { exact: true })).toBeVisible();

  // Dispatch 4, receive them, cancel the remaining 2.
  await detail.getByLabel('BOX-TR-1').fill('4');
  await detail.getByRole('button', { name: 'Dispatch' }).click();
  await expect(detail.getByText('Partially dispatched')).toBeVisible();
  await detail.getByRole('button', { name: 'Receive' }).click();
  await expect(detail.getByText('Partially received')).toBeVisible();
  await detail.getByRole('button', { name: 'Cancel the rest' }).click();
  await expect(detail.getByText('Received', { exact: true })).toBeVisible();
  const line = detail.getByRole('row').filter({ hasText: 'BOX-TR-1' });
  await expect(line).toContainText('Sellable6204040');

  // Move 2 from the main location to shelf B2, in one step.
  const move = page.locator('form', {
    has: page.getByRole('heading', { name: 'Move within a warehouse' }),
  });
  await move.getByLabel(/^To/).selectOption({ value: String(shelf.locationId) });
  await move.getByLabel('SKU').fill('BOX-TR-1');
  await move.getByLabel('Quantity').fill('2');
  await move.getByRole('button', { name: 'Move now' }).click();
  await expect(move.getByText('Moved.')).toBeVisible();
  await page.getByLabel(/^Show/).selectOption('closed');
  await expect(page.getByRole('row').filter({ hasText: 'Move' })).toContainText('Shelf B2');

  const stock = (await call(page, `/shops/${shopId}/availability?variantId=${item.variantId}`)) as {
    totals: { onHand: string; inTransit: string };
  };
  expect(stock.totals).toMatchObject({ onHand: '10.000000', inTransit: '0.000000' });
  expect(violations).toEqual([]);
});
