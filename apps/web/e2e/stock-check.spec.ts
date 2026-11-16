import { expect, test } from '@playwright/test';

test('an owner reviews and repairs a stock check problem, and the next check resolves the alert', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text()))
      violations.push(m.text());
  });
  await page.goto('/__e2e/login?email=e2e-stock-check@example.test');
  await page.getByLabel('Shop name').fill('Stock check shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByText('No products yet. Add one to start.')).toBeVisible();
  const shopId = /\/shops\/([0-9a-f-]{36})\//.exec(page.url())![1]!;

  // A balance the history does not explain, found by the scheduled check.
  const drift = await page.request.get(`/__e2e/stock-check?action=drift&shopId=${shopId}`);
  expect(await drift.json()).toMatchObject({ problems: 2, alert: 'opened' });

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Stock check' }).click();
  await expect(page.getByText('2 problems').first()).toBeVisible();
  await expect(page.getByText('Open', { exact: true })).toBeVisible();
  const problems = page.getByRole('table', { name: 'Stock problems' });
  await expect(problems.getByRole('row')).toHaveCount(3);

  // Each repair is previewed, then committed with a reason.
  for (const title of [
    'On hand differs from the stock history',
    'The quantity behind the average cost differs from stock',
  ]) {
    await problems
      .getByRole('row', { name: new RegExp(title) })
      .getByRole('button', { name: 'Preview repair' })
      .click();
    const panel = page.getByRole('region', { name: 'Repair preview' });
    await expect(panel.getByText('10 → 13')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Repair' })).toBeDisabled();
    await panel.getByLabel('Reason').fill('Counted the shelf: 13 lamps.');
    await panel.getByRole('button', { name: 'Repair' }).click();
    await expect(page.getByText('Repaired.')).toBeVisible();
  }
  await expect(page.getByText('Stock adds up: no problems right now.')).toBeVisible();
  await expect(page.getByText('The alert closes at the next scheduled check.')).toBeVisible();

  const next = await page.request.get(`/__e2e/stock-check?shopId=${shopId}`);
  expect(await next.json()).toMatchObject({ problems: 0, alert: 'resolved' });
  await page.reload();
  await expect(page.getByText(/^Resolved /)).toBeVisible();
  expect(violations).toEqual([]);
});
