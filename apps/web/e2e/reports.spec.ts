import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type Download, expect, type Locator, type Page, test } from '@playwright/test';

// Reports in the dashboard (D15): the list of the eight reports, stock on hand with packs and
// totals, inventory value, saving a report and opening it from the list, and a CSV export. Then
// the other six (G13): each opened, run with one filter, checked against a seeded row, and
// exported as CSV; and a member without costs.read sees no cost columns.

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

test('runs stock on hand and inventory value, saves a report, and exports CSV', async ({
  page,
}) => {
  await page.goto('/__e2e/login?email=e2e-reports@example.test');
  await page.getByLabel('Shop name').fill('Reports shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByText('No products yet. Add one to start.')).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3]!;
  const call = api(page, shopId);

  const item = await call<{ variantId: string }>('/items', { name: 'Booster box', sku: 'BB-1' });
  await call(`/variants/${item.variantId}/packs`, {
    packsVersion: 0,
    packs: [{ name: 'Case', quantity: '6' }],
  });
  const locations = await call<{ locations: Array<{ locationId: string }> }>('/locations');
  await call('/receipts', {
    variantId: item.variantId,
    locationId: locations.locations[0]!.locationId,
    quantity: '14',
    unitCost: '95',
  });

  await page.goto(`/app/shops/${shopId}/reports`);
  await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
  const main = page.getByRole('main');
  for (const title of [
    'Stock on hand',
    'Low stock',
    'Movements',
    'Inventory value',
    'Cost of goods',
    'Purchasing',
    'Expiring lots',
    'Shortages',
  ]) {
    await expect(main.getByRole('link', { name: title, exact: true })).toBeVisible();
  }

  await main.getByRole('link', { name: 'Stock on hand', exact: true }).click();
  const table = page.locator('.report-table');
  await expect(table.getByRole('cell', { name: '2 × Case (6) + 2' })).toBeVisible();
  await expect(table.locator('tfoot')).toContainText('Total');
  await expect(table.locator('tfoot')).toContainText('EUR 1330.00');

  // Rows per variant, saved and opened again from the list.
  await page.getByLabel('Rows per').selectOption('variant');
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(table.getByRole('button', { name: 'Sellable' })).toBeVisible();
  await page.getByRole('button', { name: 'Save report' }).click();
  await page.getByLabel('Report name').fill('Stock per item');
  await page.getByRole('checkbox', { name: 'Share with the shop' }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Stock per item' })).toBeVisible();
  await page.getByRole('link', { name: 'All reports' }).click();
  await expect(page.locator('.plain-list').getByText('Shared')).toBeVisible();
  await main.getByRole('link', { name: 'Stock per item' }).click();
  await expect(table.getByRole('button', { name: 'Sellable' })).toBeVisible();

  // The CSV export runs as a job and downloads when ready.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/^airstock-report-stock_on_hand-.*\.csv$/);

  // Inventory value today, by location.
  await page.getByRole('link', { name: 'All reports' }).click();
  await main.getByRole('link', { name: 'Inventory value', exact: true }).click();
  await expect(table.locator('tfoot')).toContainText('EUR 1330.00');
  await expect(
    page.getByRole('navigation', { name: 'Shop' }).getByRole('link', { name: 'Reports' }),
  ).toBeVisible();
});

/** A date `days` from today, as the report filters and lots take it. */
function day(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * One warehouse with two shelves and five items, seeded through the API so every report has a
 * row to find and one its filter leaves out:
 * - BB-1: 14 received on A-01 at 95, 2 fulfilled; 6 on an overdue purchase order at 90.
 * - DB-1: 5 received on B-01 at 10, 1 fulfilled; 4 on an order expected later; an order 2 short.
 * - SL-1: 3 received at 2, below its reorder point of 10.
 * - PM-1: 1 received, an order for 3 (2 short), below its reorder point of 2.
 * - OAT-1: lot L-SOON (5 on A-01) expires in 10 days, lot L-LATER (4 on B-01) in 200.
 */
async function seed(page: Page, who: string) {
  await page.goto(`/__e2e/login?email=e2e-${who}@example.test`);
  await page.getByLabel('Shop name').fill(`${who} shop`);
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByText('No products yet. Add one to start.')).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3]!;
  const call = api(page, shopId);

  const { warehouses } = await call<{ warehouses: Array<{ warehouseId: string }> }>('/warehouses');
  const warehouseId = warehouses[0]!.warehouseId;
  const shelf: Record<string, string> = {};
  for (const code of ['A-01', 'B-01']) {
    shelf[code] = (
      await call<{ locationId: string }>('/locations', { warehouseId, name: code, code })
    ).locationId;
  }
  const items: Record<string, string> = {};
  for (const [sku, name] of [
    ['BB-1', 'Booster box'],
    ['DB-1', 'Deck box'],
    ['SL-1', 'Card sleeves'],
    ['PM-1', 'Playmat'],
    ['OAT-1', 'Oat milk'],
  ] as const) {
    items[sku] = (
      await call<{ variantId: string }>('/items', { name, sku, acknowledgeSimilar: true })
    ).variantId;
  }
  const receive = (sku: string, at: string, quantity: string, unitCost: string, lot = {}) =>
    call('/receipts', { variantId: items[sku], locationId: shelf[at], quantity, unitCost, ...lot });
  const fulfill = async (sku: string, quantity: string, order: string) => {
    const r = await call<{ reservationId: string }>('/reservations', {
      variantId: items[sku],
      quantity,
      purpose: 'external_order',
      externalRef: order,
    });
    await call(`/reservations/${r.reservationId}/fulfill`, {});
  };
  await receive('BB-1', 'A-01', '14', '95');
  await fulfill('BB-1', '2', 'api:order/1');
  await receive('DB-1', 'B-01', '5', '10');
  await fulfill('DB-1', '1', 'api:order/2');
  await receive('SL-1', 'A-01', '3', '2');
  await receive('PM-1', 'A-01', '1', '20');
  await call(`/variants/${items['OAT-1']}/stock-settings`, { trackingMode: 'lot_expiry' });
  await receive('OAT-1', 'A-01', '5', '1.5', { lotCode: 'L-SOON', expiresOn: day(10) });
  await receive('OAT-1', 'B-01', '4', '1.5', { lotCode: 'L-LATER', expiresOn: day(200) });

  for (const [sku, reorderPoint, reorderQuantity] of [
    ['SL-1', '10', '30'],
    ['PM-1', '2', '5'],
  ] as const) {
    await call('/reorder-rules', {
      variantId: items[sku],
      warehouseId,
      reorderPoint,
      reorderQuantity,
    });
  }
  const { supplier } = await call<{ supplier: { id: string } }>('/suppliers', {
    name: 'Card Distributor',
  });
  for (const [sku, quantity, unitCost, expectedOn] of [
    ['BB-1', '6', '90', day(-3)],
    ['DB-1', '4', '8', day(20)],
  ] as const) {
    const order = await call<{ id: string }>('/purchase-orders', {
      supplierId: supplier.id,
      warehouseId,
      expectedOn,
      lines: [{ variantId: items[sku], quantity, packId: null, unitCost }],
    });
    await call(`/purchase-orders/${order.id}/send`, { email: false });
  }
  // Orders from the Shopify connector that stock does not cover (only connectors record them).
  for (const [sku, quantity, ref] of [
    ['PM-1', '3', 'shop:order/1001'],
    ['DB-1', '6', 'shop:order/1002'],
  ] as const) {
    const res = await page.request.get(
      `/__e2e/shortage?shopId=${shopId}&variantId=${items[sku]}&quantity=${quantity}&externalRef=${encodeURIComponent(ref)}`,
    );
    expect(res.ok(), await res.text()).toBe(true);
  }
  return { shopId, call, items, shelf };
}

/** A report filter's control, by its field label alone (a label's text also has its options). */
function filter(page: Page, label: string): Locator {
  return page
    .locator('label.field')
    .filter({ has: page.locator('.field-label').getByText(label, { exact: true }) })
    .locator('select, input');
}

/** The cell under `column` in the row that contains `rowText`. */
async function cellAt(table: Locator, rowText: string, column: string): Promise<Locator> {
  const headers = (await table.locator('thead th').allTextContents()).map((h) =>
    h.replace(/ [↑↓]$/, ''),
  );
  const i = headers.indexOf(column);
  expect(i, `${column} in ${headers.join(', ')}`).toBeGreaterThanOrEqual(0);
  return table.locator('tbody tr').filter({ hasText: rowText }).locator('td').nth(i);
}

/** Exports the report on screen and returns its CSV lines, after checking the file name. */
async function exportCsv(page: Page, report: string): Promise<string[]> {
  const download: Promise<Download> = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(new RegExp(`^airstock-report-${report}-.*\\.csv$`));
  const csv = await readFile((await file.path())!, 'utf8');
  return csv
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n');
}

async function openReport(page: Page, shopId: string, title: string) {
  await page.goto(`/app/shops/${shopId}/reports`);
  await page.getByRole('main').getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

test('runs the other six reports with a filter each, checks a seeded row, and exports CSV', async ({
  page,
}) => {
  const { shopId } = await seed(page, 'reports-six');
  const table = page.locator('.report-table');
  const rows = table.locator('tbody tr');
  const run = () => page.getByRole('button', { name: 'Run report' }).click();

  // Low stock: both rules are low; the item filter keeps the sleeves.
  await openReport(page, shopId, 'Low stock');
  await expect(rows).toHaveCount(2);
  await filter(page, 'Item').fill('sleeves');
  await run();
  await expect(rows).toHaveCount(1);
  await expect(await cellAt(table, 'SL-1', 'Available')).toHaveText('3');
  await expect(await cellAt(table, 'SL-1', 'Reorder point')).toHaveText('10');
  await expect(await cellAt(table, 'SL-1', 'Needed')).toHaveText('30');
  let csv = await exportCsv(page, 'low_stock');
  expect(csv[0]).toMatch(/^SKU,Product,Warehouse,Location,Available,On order,Reorder point,/);
  expect(csv.filter((l) => l.startsWith('SL-1,Card sleeves,Main stock,'))).toHaveLength(1);
  expect(csv.join('\n')).not.toContain('PM-1');

  // Movements: only fulfillments, by variant.
  await openReport(page, shopId, 'Movements');
  await expect(rows).toHaveCount(5);
  await filter(page, 'Movement').selectOption('fulfillment');
  await run();
  await expect(rows).toHaveCount(2);
  await expect(await cellAt(table, 'BB-1', 'Fulfilled')).toHaveText('-2');
  await expect(await cellAt(table, 'BB-1', 'Received')).toHaveText('0');
  await expect(await cellAt(table, 'BB-1', 'Net value')).toHaveText('EUR -190.00');
  await expect(await cellAt(table, 'DB-1', 'Fulfilled')).toHaveText('-1');
  csv = await exportCsv(page, 'movements');
  expect(csv[0]).toContain('Net value (EUR)');
  expect(csv.slice(1, -1).map((l) => l.split(',')[0])).toEqual(['BB-1', 'DB-1']);
  expect(csv.at(-1)).toMatch(/^Total,/);

  // Cost of goods: the fulfillments from A-01 only.
  await openReport(page, shopId, 'Cost of goods');
  await expect(rows).toHaveCount(2);
  await filter(page, 'Location').selectOption({ label: 'Main stock/A-01' });
  await run();
  await expect(rows).toHaveCount(1);
  await expect(await cellAt(table, 'BB-1', 'Units fulfilled')).toHaveText('2');
  await expect(await cellAt(table, 'BB-1', 'Average unit cost')).toHaveText('EUR 95.00');
  await expect(await cellAt(table, 'BB-1', 'Cost of goods')).toHaveText('EUR 190.00');
  await expect(table.locator('tfoot')).toContainText('EUR 190.00');
  csv = await exportCsv(page, 'cost_of_goods');
  expect(csv[0]).toBe(
    'SKU,Product,Units fulfilled,Average unit cost (EUR),Cost of goods (EUR),Units without a cost',
  );
  expect(csv[1]).toBe('BB-1,Booster box,2,95,190,0');
  expect(csv).toHaveLength(3);

  // Purchasing: both orders are open; only the first is overdue.
  await openReport(page, shopId, 'Purchasing');
  await expect(rows).toHaveCount(2);
  await page.getByRole('checkbox', { name: 'Overdue only' }).check();
  await run();
  await expect(rows).toHaveCount(1);
  await expect(await cellAt(table, 'PO-0001', 'Supplier')).toHaveText('Card Distributor');
  await expect(await cellAt(table, 'PO-0001', 'SKU')).toHaveText('BB-1');
  await expect(await cellAt(table, 'PO-0001', 'Overdue')).toHaveText('Yes');
  await expect(await cellAt(table, 'PO-0001', 'On order')).toHaveText('6');
  await expect(await cellAt(table, 'PO-0001', 'Open value')).toHaveText('EUR 540.00');
  csv = await exportCsv(page, 'purchasing');
  expect(csv.filter((l) => l.startsWith('PO-0001,Card Distributor,'))).toHaveLength(1);
  expect(csv.join('\n')).not.toContain('PO-0002');

  // Expiring lots: 30 days shows the near lot; a year shows both.
  await openReport(page, shopId, 'Expiring lots');
  await expect(rows).toHaveCount(1);
  await expect(await cellAt(table, 'L-SOON', 'Expires')).toHaveText(day(10));
  await filter(page, 'Expiring within (days)').fill('365');
  await run();
  await expect(rows).toHaveCount(2);
  await expect(await cellAt(table, 'L-LATER', 'Expires')).toHaveText(day(200));
  await expect(await cellAt(table, 'L-LATER', 'Locations')).toHaveText('Main stock/B-01');
  await expect(await cellAt(table, 'L-LATER', 'On hand')).toHaveText('4');
  await expect(await cellAt(table, 'L-LATER', 'Value')).toHaveText('EUR 6.00');
  csv = await exportCsv(page, 'expiring_lots');
  expect(csv.slice(1, -1).map((l) => l.split(',')[2])).toEqual(['L-SOON', 'L-LATER']);

  // Shortages: two open orders; the item filter keeps the playmat's.
  await openReport(page, shopId, 'Shortages');
  await expect(rows).toHaveCount(2);
  await filter(page, 'Item').fill('PM-1');
  await run();
  await expect(rows).toHaveCount(1);
  await expect(await cellAt(table, 'PM-1', 'Order')).toHaveText('shop:order/1001');
  await expect(await cellAt(table, 'PM-1', 'Ordered')).toHaveText('3');
  await expect(await cellAt(table, 'PM-1', 'Short')).toHaveText('2');
  csv = await exportCsv(page, 'shortages');
  expect(csv).toHaveLength(3);
  expect(csv[1]).toMatch(/^shop:order\/1001,[^,]+,PM-1,Playmat,3,2,/);
});

test('a member without costs.read sees no cost columns or cost reports', async ({
  page,
  browser,
}) => {
  const { shopId, call } = await seed(page, 'reports-costs');
  const { invitationId } = await call<{ invitationId: string }>('/invitations', {
    email: 'e2e-reports-viewer@example.test',
    role: 'viewer',
  });
  // The owner sees the purchasing costs.
  await openReport(page, shopId, 'Purchasing');
  const ownerHeaders = page.locator('.report-table thead th');
  await expect(ownerHeaders.filter({ hasText: 'Open value' })).toHaveCount(1);

  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await viewer.goto('/__e2e/login?email=e2e-reports-viewer@example.test');
  await viewer.goto(`/invitations/${invitationId}`);
  await viewer.getByRole('button', { name: 'Accept invitation' }).click();
  await viewer.waitForURL(/\/app/);

  await viewer.goto(`/app/shops/${shopId}/reports`);
  const list = viewer.getByRole('main').locator('.report-list');
  for (const title of ['Inventory value', 'Cost of goods']) {
    const row = list.locator('li').filter({ hasText: title });
    await expect(row.getByText('Needs cost access')).toBeVisible();
    await expect(row.getByRole('link')).toHaveCount(0);
  }
  await openReport(viewer, shopId, 'Purchasing');
  const table = viewer.locator('.report-table');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(await cellAt(table, 'PO-0001', 'On order')).toHaveText('6');
  const headers = (await table.locator('thead th').allTextContents()).join(', ');
  expect(headers).not.toMatch(/Unit cost|Open value/);
  // No exports either: a viewer does not hold exports.run.
  await expect(viewer.getByRole('button', { name: 'Export CSV' })).toHaveCount(0);

  await openReport(viewer, shopId, 'Stock on hand');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  expect((await table.locator('thead th').allTextContents()).join(', ')).not.toContain('Value');
  await viewerContext.close();
});
