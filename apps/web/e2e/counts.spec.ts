import { expect, type Page, test } from '@playwright/test';

// Milestone I2 counts in a real browser: a quick count below reserved stock asks which claim to
// release, then a blind count session is entered and submitted (G5), under the CSP.

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

test('counts: a quick count below reserved, then a blind session', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) {
      violations.push(message.text());
    }
  });

  await page.goto('/__e2e/login?email=e2e-counts@example.test');
  await page.getByLabel('Shop name').fill('Counts shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByRole('grid', { name: 'Products' })).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3]!;

  const item = await call(page, `/shops/${shopId}/items`, { name: 'Booster', sku: 'BST-CT-1' });
  const locations = (await call(page, `/shops/${shopId}/locations`)) as {
    locations: Array<{ locationId: string }>;
  };
  const main = locations.locations[0]!.locationId;
  await call(page, `/shops/${shopId}/receipts`, {
    variantId: item.variantId,
    locationId: main,
    quantity: '10',
  });
  await call(page, `/shops/${shopId}/reservations`, {
    variantId: item.variantId,
    quantity: '6',
    externalRef: 'ORDER-9',
  });

  await page.goto(`/app/shops/${shopId}/inventory/counts`);
  await expect(page.getByText('No counts here.')).toBeVisible();
  const quick = page.locator('form', {
    has: page.getByRole('heading', { name: 'Count', exact: true }),
  });
  await quick.getByLabel('SKU').fill('BST-CT-1');
  await quick.getByLabel('Counted').fill('4');
  await quick.getByRole('button', { name: 'Save count' }).click();
  await expect(quick.getByText('2 reserved units need a decision.')).toBeVisible();
  await quick.getByLabel(/^Action/).selectOption('release');
  await quick.getByLabel('Units').fill('2');
  await quick.getByRole('button', { name: 'Apply with these choices' }).click();
  await expect(quick.getByText('Counted: -6.')).toBeVisible();

  // A blind count of the location: expected quantities stay hidden until submit.
  const start = page.locator('form', { has: page.getByRole('heading', { name: 'Start a count' }) });
  await start.getByLabel('Name').fill('Shelf check');
  await start.getByLabel(/Blind count/).check();
  await start.getByRole('button', { name: 'Start count' }).click();
  const detail = page.locator('section.panel', {
    has: page.getByRole('heading', { name: 'Shelf check' }),
  });
  const row = detail.getByRole('row').filter({ hasText: 'BST-CT-1' });
  await expect(row).toContainText('—');
  await row.getByLabel('Count BST-CT-1').fill('4');
  await detail.getByRole('button', { name: 'Save counts' }).click();
  await expect(detail.getByText('1 of 1')).toBeVisible();
  await detail.getByRole('button', { name: 'Submit count' }).click();
  await expect(detail.getByText('Submitted', { exact: true })).toBeVisible();

  const stock = (await call(page, `/shops/${shopId}/availability?variantId=${item.variantId}`)) as {
    totals: Record<string, string>;
  };
  expect(stock.totals).toMatchObject({
    onHand: '4.000000',
    reserved: '4.000000',
    available: '0.000000',
  });
  expect(violations).toEqual([]);
});
