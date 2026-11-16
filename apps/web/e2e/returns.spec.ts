import { expect, type Page, test } from '@playwright/test';

// Milestone I2 returns in a real browser: an order of 6 comes back, is received into quarantine
// at another warehouse, and inspection releases 4 to sellable and keeps 2 damaged (A07).

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

test('returns: create, receive into quarantine, inspect 4 sellable and 2 damaged', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) {
      violations.push(message.text());
    }
  });

  await page.goto('/__e2e/login?email=e2e-returns@example.test');
  await page.getByLabel('Shop name').fill('Returns shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByRole('grid', { name: 'Products' })).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3]!;

  const item = await call(page, `/shops/${shopId}/items`, { name: 'LEGO set', sku: 'LEGO-RT-1' });
  const locations = (await call(page, `/shops/${shopId}/locations`)) as {
    locations: Array<{ locationId: string }>;
  };
  await call(page, `/shops/${shopId}/receipts`, {
    variantId: item.variantId,
    locationId: locations.locations[0]!.locationId,
    quantity: '10',
  });
  const order = await call(page, `/shops/${shopId}/reservations`, {
    variantId: item.variantId,
    quantity: '6',
    externalRef: '1001',
  });
  await call(page, `/shops/${shopId}/reservations/${order.reservationId}/fulfill`, {});
  const centre = await call(page, `/shops/${shopId}/warehouses`, { name: 'Returns centre' });
  await call(page, `/shops/${shopId}/locations`, { warehouseId: centre.warehouseId, name: 'Dock' });

  await page.goto(`/app/shops/${shopId}/inventory/returns`);
  await expect(page.getByText('No returns here.')).toBeVisible();
  const form = page.locator('section.panel', {
    has: page.getByRole('heading', { name: 'New return' }),
  });
  await form.getByLabel('Order').fill('1001');
  await form.getByLabel('Reason').fill('Box damaged in shipping');
  await form.getByLabel('SKU').fill('LEGO-RT-1');
  await form.getByLabel('Quantity').fill('6');
  await form.getByRole('button', { name: 'Create return' }).click();

  const detail = page.locator('section.panel', {
    has: page.getByRole('heading', { name: /^Return / }),
  });
  await expect(detail.getByText('Authorized', { exact: true })).toBeVisible();
  await detail.getByLabel(/^Arrives at/).selectOption({ label: 'Returns centre/Dock' });
  await detail.getByRole('button', { name: 'Receive' }).click();
  await expect(detail.getByText('Received', { exact: true })).toBeVisible();

  await detail.getByLabel('LEGO-RT-1 units').fill('4');
  await detail.getByRole('button', { name: 'Record inspection' }).click();
  await expect(detail.getByText('Inspecting', { exact: true })).toBeVisible();
  await detail.getByLabel(/^LEGO-RT-1 result/).selectOption('damaged');
  await detail.getByRole('button', { name: 'Record inspection' }).click();
  await expect(detail.getByText('Completed', { exact: true })).toBeVisible();
  await expect(detail.getByRole('row').filter({ hasText: 'LEGO-RT-1' })).toContainText('66042');

  const stock = (await call(page, `/shops/${shopId}/availability?variantId=${item.variantId}`)) as {
    totals: Record<string, string>;
  };
  expect(stock.totals).toMatchObject({
    available: '8.000000',
    damaged: '2.000000',
    quarantined: '0.000000',
  });
  expect(violations).toEqual([]);
});
