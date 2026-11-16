import { expect, test } from '@playwright/test';

// I5 (D15): the Activity page filters the history, follows one request from attempt to
// outcome, and exports what it shows as a logged job.

test('filters the activity history, follows a request, and exports it', async ({ page }) => {
  await page.goto('/__e2e/login?email=e2e-activity@example.test');
  await page.getByLabel('Shop name').fill('Activity shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByText('No products yet. Add one to start.')).toBeVisible();
  await page.getByRole('button', { name: 'Add product' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Desk lamp');
  await page.getByRole('textbox', { name: 'SKU' }).fill('LAMP-ACT-1');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('gridcell', { name: 'LAMP-ACT-1' })).toBeVisible();

  await page.getByRole('link', { name: 'Activity' }).click();
  const table = page.getByRole('table', { name: 'Activity' });
  await expect(table).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Action' })
    .selectOption({ label: 'Catalog: products, fields, imports, exports' });
  await expect(page).toHaveURL(/action=catalog/);
  const created = table.getByRole('row').filter({ hasText: 'catalog.item.created' }).first();
  await expect(created).toBeVisible();
  // Only catalog actions are listed.
  for (const code of await table.locator('tbody td:nth-child(2) code').allTextContents()) {
    expect(code.startsWith('catalog.')).toBe(true);
  }

  // The request that created the product, from attempt to outcome.
  await created.getByTitle('Follow this request from attempt to outcome').click();
  const request = page.locator('section', {
    has: page.getByRole('heading', { name: 'Request' }),
  });
  await expect(request.getByText('succeeded')).toBeVisible({ timeout: 15_000 });
  await expect(request.getByText('catalog.item.created')).toBeVisible();
  await expect(page.getByText(/One request/)).toBeVisible();

  // The filtered history as CSV, through the export job.
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await expect(page.getByRole('button', { name: /^Download \d+ rows$/ })).toBeVisible({
    timeout: 15_000,
  });

  // Clearing the filters shows the whole history again, this page's own reads included.
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).not.toHaveURL(/action=/);
  await expect(table.getByText('activity.viewed').first()).toBeVisible();
});
