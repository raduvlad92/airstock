import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';

// Alerts in the dashboard (D12): a reorder rule set on the product's Stock tab, an order that
// takes stock below its point, the badge and the Alerts page, acknowledgement, and drafting a
// purchase order from low stock.

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

test('a low-stock alert shows in the badge, is acknowledged, and drafts an order', async ({
  page,
}) => {
  await page.goto('/__e2e/login?email=e2e-alerts@example.test');
  await page.getByLabel('Shop name').fill('Alerts shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByText('No products yet. Add one to start.')).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3]!;
  const call = api(page, shopId);

  const supplier = await call<{ supplier: { id: string } }>('/suppliers', { name: 'Tea Co' });
  const item = await call<{ variantId: string; productId: string }>('/items', {
    name: 'Green tea',
    sku: 'TEA-1',
  });
  await call('/supplier-items', {
    supplierId: supplier.supplier.id,
    variantId: item.variantId,
    minimumOrderQuantity: '10',
    preferred: true,
  });
  const locations = await call<{ locations: Array<{ locationId: string }> }>('/locations');
  await call('/receipts', {
    variantId: item.variantId,
    locationId: locations.locations[0]!.locationId,
    quantity: '8',
  });

  // The rule, from the product's Stock tab.
  await page.goto(`/app/shops/${shopId}/products?item=${item.productId}`);
  await page.getByRole('tab', { name: 'Stock' }).click();
  await page.getByRole('button', { name: 'Add rule' }).click();
  await page.getByRole('textbox', { name: 'Reorder point' }).fill('5');
  await page.getByRole('textbox', { name: 'Reorder quantity' }).fill('6');
  await page.getByRole('button', { name: 'Add rule', exact: true }).last().click();
  await expect(page.getByText('At or below 5, order 6')).toBeVisible();

  // An order takes available to 4: one alert.
  await call('/reservations', { variantId: item.variantId, quantity: '4' });
  await page.goto(`/app/shops/${shopId}/alerts`);
  await expect(page.getByRole('link', { name: /Alerts\s*1/ })).toBeVisible();
  await expect(page.getByText('Low stock: TEA-1 at')).toBeVisible();
  await page.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(
    page.locator('.alert-item').getByText('Acknowledged', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('1 open alerts')).toHaveCount(0);

  // Draft from low stock: 6 units, raised to the supplier's minimum of 10.
  await page.getByRole('link', { name: 'Draft from low stock' }).click();
  await page.getByRole('button', { name: 'Draft from low stock' }).click();
  await expect(page.getByRole('heading', { name: /Tea Co/ })).toBeVisible();
  await expect(page.getByLabel('Quantity for TEA-1')).toHaveValue('10');
  await page.getByRole('button', { name: 'Save 1 draft' }).click();
  await expect(page.locator('.panel', { hasText: 'PO-0001 · Tea Co' })).toBeVisible();
});
