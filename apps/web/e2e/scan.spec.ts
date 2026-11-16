import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';

// The scanning app at /app/scan (plan D13) in a real browser, under the app's CSP. Cameras are
// hard to drive in CI, so codes arrive the way a keyboard-wedge scanner sends them: fast
// keystrokes ending in Enter, with no field focused, and typed into the scan field.

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

/** A keyboard-wedge scanner: a few milliseconds between keys, then Enter, with nothing focused. */
async function wedge(page: Page, code: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.type(code, { delay: 4 });
  await page.keyboard.press('Enter');
}

test('the scan page looks codes up from a keyboard-wedge scanner and the scan field', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) {
      violations.push(message.text());
    }
  });

  await page.goto('/__e2e/login?email=e2e-scan@example.test');
  await page.getByLabel('Shop name').fill('Scan shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByText('No products yet. Add one to start.')).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3]!;
  const call = api(page, shopId);

  const created = await call<{ variantId: string }>('/items', {
    name: 'Booster box',
    sku: 'BOX-1',
    price: '120',
    barcode: '4006381333931',
    acknowledgeSimilar: true,
  });
  const { warehouses } = await call<{ warehouses: Array<{ warehouseId: string }> }>('/warehouses');
  const { locationId } = await call<{ locationId: string }>('/locations', {
    warehouseId: warehouses[0]!.warehouseId,
    name: 'Shelf A',
    code: 'A-01',
  });

  // The dashboard links to the scanner; with one shop it opens straight on that shop.
  await page.getByRole('link', { name: 'Scan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Look up' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Scan flows' })).toBeVisible();

  // A location label sets the current location.
  await wedge(page, `LOC:${locationId.toUpperCase()}`);
  // Paths are built from location codes where a location has one.
  await expect(page.getByRole('status')).toHaveText('Location: Main stock/A-01');
  await expect(page.locator('.scan-location strong')).toHaveText('Main stock/A-01');

  // A product barcode shows the item and its stock.
  await wedge(page, '4006381333931');
  await expect(page.getByRole('heading', { name: 'Booster box' })).toBeVisible();
  await expect(page.getByText('Single unit')).toBeVisible();
  await expect(page.getByText(/No stock anywhere/)).toBeVisible();

  // Slow typing is a person, not a scanner: nothing happens.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.type('999', { delay: 150 });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Booster box' })).toBeVisible();

  // The scan field takes a typed code, or a wedge scanner's keys when it has focus.
  await page.getByRole('textbox', { name: 'Code' }).fill('NO-SUCH-CODE');
  await page.getByRole('button', { name: 'Go' }).click();
  await expect(page.getByRole('heading', { name: 'Unknown code' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Code' }).focus();
  await page.keyboard.type('4006381333931', { delay: 4 });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Booster box' })).toBeVisible();

  // Receive: the location stays set; scanning the item twice makes it 2, shown before the commit.
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(
    page.getByText('Scan the item or its case to receive into Main stock/A-01.'),
  ).toBeVisible();
  await wedge(page, '4006381333931');
  await expect(page.getByText('1 unit → Main stock/A-01')).toBeVisible();
  await wedge(page, '4006381333931');
  await expect(page.getByText('2 units → Main stock/A-01')).toBeVisible();
  await page.getByRole('button', { name: 'Receive 2' }).click();
  await expect(page.getByRole('status')).toHaveText('Received 2 × BOX-1 into Main stock/A-01.');
  const stock = await call<{ totals: { onHand: string } }>(
    `/availability?variantId=${created.variantId}`,
  );
  expect(stock.totals.onHand).toBe('2.000000');

  // An unknown code is created as a new item from the phone.
  await page.getByRole('button', { name: 'Look up' }).click();
  await wedge(page, 'NEW-ITEM-77');
  await page.getByRole('button', { name: 'Create new item' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Sleeves');
  await page.getByRole('button', { name: 'Create with this code' }).click();
  await expect(page.getByRole('heading', { name: 'Sleeves' })).toBeVisible();

  // Flows not built yet say so.
  await page.getByRole('button', { name: 'Count' }).click();
  await expect(page.getByText(/coming soon/)).toBeVisible();

  expect(violations).toEqual([]);
});
