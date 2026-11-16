import { expect, test } from '@playwright/test';

// Milestone I1 in a real browser: the product's Stock tab tracks a variant by lot, receives two
// lots, reserves (earliest expiry first), fulfills part, and releases the rest, under the CSP.

test('the stock tab receives lots, reserves, fulfills, and releases', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) {
      violations.push(message.text());
    }
  });

  await page.goto('/__e2e/login?email=e2e-stock@example.test');
  await page.getByLabel('Shop name').fill('Stock shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByRole('grid', { name: 'Products' })).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3];
  await page.evaluate(
    async ([shop]) => {
      const res = await fetch(`/api/v1/shops/${shop}/items`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-airstock-request': '1',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({ name: 'Protein bar', sku: 'BAR-E2E-1' }),
      });
      if (!res.ok) throw new Error(await res.text());
    },
    [shopId],
  );
  await page.reload();
  await page.getByRole('gridcell').filter({ hasText: 'Protein bar' }).first().click();
  await page.getByRole('grid', { name: 'Products' }).press('Shift+Enter');
  const panel = page.getByRole('complementary', { name: 'Product details' });
  await expect(panel.getByRole('heading', { name: 'Protein bar' })).toBeVisible();
  await panel.getByRole('tab', { name: 'Stock' }).click();
  await expect(panel.getByText('No stock recorded yet.')).toBeVisible();

  // Track by lot with expiry, then receive two lots.
  await panel.getByLabel('Tracking').selectOption('lot_expiry');
  await panel.getByRole('button', { name: 'Save stock settings' }).click();
  const receive = panel.locator('form', { has: page.getByRole('heading', { name: 'Receive' }) });
  await expect(receive.getByLabel('Lot')).toBeVisible();
  for (const [lot, expires, quantity] of [
    ['LATE', '2031-03-31', '6'],
    ['EARLY', '2030-01-31', '4'],
  ] as const) {
    await receive.getByLabel('Quantity').fill(quantity);
    await receive.getByLabel('Lot').fill(lot);
    await receive.getByLabel('Expires').fill(expires);
    await receive.getByRole('button', { name: 'Receive' }).click();
    await expect(receive.getByText(`Received ${quantity}.`)).toBeVisible();
  }
  const facts = panel.locator('dl.stats');
  await expect(facts).toContainText('On hand10');
  await expect(panel.getByRole('cell', { name: 'EARLY · 2030-01-31' })).toBeVisible();

  // Reserve 5: the earliest lot first, then the later one.
  const reserve = panel.locator('form', { has: page.getByRole('heading', { name: 'Reserve' }) });
  await reserve.getByLabel('Quantity').fill('5');
  await reserve.getByLabel('Reference').fill('ORDER-1');
  await reserve.getByRole('button', { name: 'Reserve' }).click();
  const row = panel.getByRole('row').filter({ hasText: 'ORDER-1' });
  await expect(row).toContainText('EARLY');
  await expect(row).toContainText('LATE');
  await expect(facts).toContainText('Reserved5');

  // Fulfill 2, then release the rest.
  await row.getByLabel('Quantity').fill('2');
  await row.getByRole('button', { name: 'Fulfill' }).click();
  await expect(facts).toContainText('On hand8');
  await expect(facts).toContainText('Reserved3');
  await row.getByRole('button', { name: 'Release' }).click();
  await expect(facts).toContainText('Reserved0');
  await expect(facts).toContainText('Available8');
  await expect(panel.getByText('Open reservations')).toHaveCount(0);
  expect(violations).toEqual([]);
});
