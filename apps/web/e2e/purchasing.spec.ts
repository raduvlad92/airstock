import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';

// Purchasing in the dashboard (D11): draft an order from the supplier's items, record it as sent,
// download its PDF, receive part of a line, and close the rest. Stock and on order follow.

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

test('an owner drafts, sends, receives part of, and closes a purchase order', async ({ page }) => {
  await page.goto('/__e2e/login?email=e2e-purchasing@example.test');
  await page.getByLabel('Shop name').fill('Purchasing shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByText('No products yet. Add one to start.')).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3]!;
  const call = api(page, shopId);

  const supplier = await call<{ supplier: { id: string } }>('/suppliers', {
    name: 'Ceramica Ștefan',
    email: 'comenzi@example.test',
  });
  const item = await call<{ variantId: string }>('/items', { name: 'Bol roșu', sku: 'BOL-1' });
  const packs = await call<{ packaging: { packs: Array<{ id: string }> } }>(
    `/variants/${item.variantId}/packs`,
    { packsVersion: 0, packs: [{ name: 'Case', quantity: '12' }] },
  );
  await call('/supplier-items', {
    supplierId: supplier.supplier.id,
    variantId: item.variantId,
    packId: packs.packaging.packs[0]!.id,
    supplierSku: 'CS-BOL',
    lastCost: '30',
    preferred: true,
  });

  await page.getByRole('link', { name: 'Purchasing' }).click();
  await expect(page.getByText('No purchase orders here yet.')).toBeVisible();
  await page.getByRole('button', { name: 'New purchase order' }).click();
  await page
    .getByRole('combobox', { name: 'Supplier', exact: true })
    .selectOption({ label: 'Ceramica Ștefan' });
  await page
    .getByRole('combobox', { name: 'Add from this supplier' })
    .selectOption({ label: 'Bol roșu · BOL-1 (Case)' });
  await page.getByLabel('Quantity for Bol roșu · BOL-1').fill('4');
  await page.getByRole('button', { name: 'Save draft' }).click();

  const panel = page.locator('.panel', { hasText: 'PO-0001 · Ceramica Ștefan' });
  await expect(panel.getByText('Draft', { exact: true })).toBeVisible();
  await expect(panel.getByText('4 × Case (48 units)')).toBeVisible();
  await expect(panel.getByText('120.00 EUR')).toBeVisible();

  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await panel.getByLabel('Email the PDF to the supplier').uncheck();
  await panel.getByRole('button', { name: 'Mark as sent' }).click();
  await expect(panel.getByText('Recorded as sent')).toBeVisible();

  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download PDF' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('PO-0001.pdf');
  const bytes = await readFile((await file.path())!);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

  await panel.getByRole('button', { name: 'Receive' }).click();
  await panel.getByLabel('Quantity (Case)').fill('2');
  await panel.getByRole('combobox', { name: 'Location', exact: true }).selectOption({ index: 0 });
  await panel.getByRole('button', { name: 'Receive', exact: true }).last().click();
  await expect(panel.getByText('Partially received', { exact: true })).toBeVisible();

  const stock = await call<{ totals: { onHand: string; onOrder: string } }>(
    `/availability?variantId=${item.variantId}`,
  );
  expect(stock.totals).toMatchObject({ onHand: '24.000000', onOrder: '24' });

  page.once('dialog', (dialog) => void dialog.accept());
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel.getByText('Closed', { exact: true })).toBeVisible();
  const after = await call<{ totals: { onOrder: string } }>(
    `/availability?variantId=${item.variantId}`,
  );
  expect(after.totals.onOrder).toBe('0');
});
