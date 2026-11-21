import { randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { expect, type Page, test } from '@playwright/test';

// The phone flows of milestone I4b in a real browser, under the app's CSP: count, move, receive
// against a purchase order, lots captured while scanning (G11), and quick add. Codes arrive the
// way a keyboard-wedge scanner sends them (fast keys ending in Enter, nothing focused), as in the
// I4a scan tests.

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

async function wedge(page: Page, code: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.type(code, { delay: 4 });
  await page.keyboard.press('Enter');
}

function cspWatch(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) {
      violations.push(message.text());
    }
  });
  return violations;
}

/** Signs in a new user with a new shop, an item, and shelves; returns the API caller. */
async function setup(page: Page, who: string, shelves: string[]) {
  await page.goto(`/__e2e/login?email=e2e-${who}@example.test`);
  await page.getByLabel('Shop name').fill(`${who} shop`);
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByText('No products yet. Add one to start.')).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3]!;
  const call = api(page, shopId);
  const { variantId } = await call<{ variantId: string }>('/items', {
    name: 'Booster box',
    sku: 'BOX-1',
    price: '120',
    barcode: '4006381333931',
    acknowledgeSimilar: true,
  });
  const { warehouses } = await call<{ warehouses: Array<{ warehouseId: string }> }>('/warehouses');
  const warehouseId = warehouses[0]!.warehouseId;
  const ids: Record<string, string> = {};
  for (const code of shelves) {
    const { locationId } = await call<{ locationId: string }>('/locations', {
      warehouseId,
      name: `Shelf ${code}`,
      code,
    });
    ids[code] = locationId;
  }
  return { shopId, call, variantId, warehouseId, shelves: ids };
}

const label = (id: string) => `LOC:${id.toUpperCase()}`;

interface Availability {
  totals: { onHand: string; reserved: string };
  positions: Array<{
    locationPath: string;
    onHand: string;
    lotCode: string | null;
    expiresOn: string | null;
  }>;
}

const OAT_BARCODE = '5901234123457';

/** A second item, tracked by lot with expiry. */
async function lotItem(call: ReturnType<typeof api>): Promise<string> {
  const { variantId } = await call<{ variantId: string }>('/items', {
    name: 'Oat milk',
    sku: 'OAT-1',
    barcode: OAT_BARCODE,
    acknowledgeSimilar: true,
  });
  await call(`/variants/${variantId}/stock-settings`, { trackingMode: 'lot_expiry' });
  return variantId;
}

/** Each position as "path · lot (expiry): on hand". */
function lotPositions(stock: Availability): string[] {
  return stock.positions
    .map((p) => `${p.locationPath} · ${p.lotCode} (${p.expiresOn}): ${p.onHand}`)
    .sort();
}

test('count: a quick count of a shelf by scanning asks before releasing reserved units', async ({
  page,
}) => {
  const violations = cspWatch(page);
  const { shopId, call, variantId, shelves } = await setup(page, 'scan-count', ['A-01']);
  await call('/receipts', { variantId, locationId: shelves['A-01'], quantity: '5' });
  await call('/reservations', {
    variantId,
    quantity: '3',
    purpose: 'external_order',
    externalRef: 'api:order/1',
  });

  await page.goto(`/app/scan?shop=${shopId}&flow=count`);
  await expect(page.getByRole('heading', { name: 'Quick count' })).toBeVisible();
  await wedge(page, label(shelves['A-01']!));
  await expect(page.getByRole('heading', { name: 'Count Main stock/A-01' })).toBeVisible();
  // Two boxes on the shelf: each scan adds one, read back before anything is posted.
  await wedge(page, '4006381333931');
  await wedge(page, '4006381333931');
  await expect(page.getByRole('list', { name: 'To confirm' })).toHaveText('BOX-1: 2 units');
  await expect(page.getByText('On record here: 5 (3 reserved)')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm count of 1 item' }).click();

  // Two left with three reserved: the order's claim needs a decision.
  await expect(page.getByRole('heading', { name: 'Reserved stock' })).toBeVisible();
  await expect(page.getByText(/1 reserved unit needs a decision/)).toBeVisible();
  await page.getByRole('button', { name: 'Release' }).click();
  await page.getByRole('button', { name: 'Apply with these choices' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Counted at Main stock/A-01: BOX-1 -3. 1 reserved claim(s) settled.',
  );
  const after = await call<Availability>(`/availability?variantId=${variantId}`);
  expect(after.totals).toMatchObject({ onHand: '2.000000', reserved: '2.000000' });
  expect(violations).toEqual([]);
});

test('move: from a shelf to another by scanning both labels and the items', async ({ page }) => {
  const violations = cspWatch(page);
  const { shopId, call, variantId, shelves } = await setup(page, 'scan-move', ['A-01', 'B-01']);
  await call('/receipts', { variantId, locationId: shelves['A-01'], quantity: '6' });

  await page.goto(`/app/scan?shop=${shopId}&flow=move`);
  await expect(page.getByRole('heading', { name: 'Move' })).toBeVisible();
  await wedge(page, label(shelves['A-01']!));
  await expect(page.getByRole('status')).toHaveText('Moving from Main stock/A-01. Scan the items.');
  await wedge(page, '4006381333931');
  await wedge(page, '4006381333931');
  await expect(page.getByText('Available here: 6')).toBeVisible();
  await expect(page.locator('.scan-confirm').last()).toHaveText(
    'BOX-1: 2 units · Main stock/A-01 → ?',
  );
  await wedge(page, label(shelves['B-01']!));
  await page.getByRole('button', { name: 'Move 2 units to Main stock/B-01' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Moved BOX-1: 2 units from Main stock/A-01 to Main stock/B-01.',
  );
  const after = await call<Availability>(`/availability?variantId=${variantId}`);
  expect(Object.fromEntries(after.positions.map((p) => [p.locationPath, p.onHand]))).toMatchObject({
    'Main stock/A-01': '4.000000',
    'Main stock/B-01': '2.000000',
  });
  expect(violations).toEqual([]);
});

test('receive: against a purchase order line, with the over-receipt confirmed', async ({
  page,
}) => {
  const violations = cspWatch(page);
  const { shopId, call, variantId, warehouseId, shelves } = await setup(page, 'scan-po', ['A-01']);
  const { supplier } = await call<{ supplier: { id: string } }>('/suppliers', {
    name: 'Card Distributor',
  });
  const order = await call<{ id: string }>('/purchase-orders', {
    supplierId: supplier.id,
    warehouseId,
    lines: [{ variantId, quantity: '2', packId: null }],
  });
  await call(`/purchase-orders/${order.id}/send`, { email: false });

  await page.goto(`/app/scan?shop=${shopId}&flow=receive`);
  await page.getByRole('button', { name: 'Purchase order' }).click();
  await expect(page.getByRole('heading', { name: 'Receive a purchase order' })).toBeVisible();
  await wedge(page, label(shelves['A-01']!));
  await page.getByRole('button', { name: /PO-0001 · Card Distributor/ }).click();
  await expect(
    page.getByRole('button', { name: 'BOX-1: ordered 2, received 0, open 2' }),
  ).toBeVisible();
  for (let i = 0; i < 3; i++) await wedge(page, '4006381333931');
  await expect(page.locator('.scan-confirm')).toHaveText('3 units → Main stock/A-01');
  const receive = page.getByRole('button', { name: 'Receive 3 (1 over)' });
  await expect(receive).toBeDisabled();
  await page.getByRole('checkbox', { name: /This is 1 more than the 2 still open/ }).check();
  await receive.click();
  await expect(page.getByRole('status')).toHaveText('Received 3 × BOX-1 against PO-0001.');
  await expect(
    page.getByRole('button', { name: 'BOX-1: ordered 2, received 3, open 0' }),
  ).toBeVisible();

  const po = await call<{
    status: string;
    lines: Array<{ received: string; overReceived: string }>;
  }>(`/purchase-orders/${order.id}`);
  expect(po.status).toBe('received');
  expect(po.lines[0]).toMatchObject({ received: '3.000000', overReceived: '1.000000' });
  expect(violations).toEqual([]);
});

test('receive: a lot code and its expiry captured while scanning, then found at the shelf', async ({
  page,
}) => {
  const violations = cspWatch(page);
  const { shopId, call, shelves } = await setup(page, 'scan-lot', ['A-01']);
  const oat = await lotItem(call);

  await page.goto(`/app/scan?shop=${shopId}&flow=receive`);
  await expect(page.getByRole('heading', { name: 'Receive' })).toBeVisible();
  await wedge(page, label(shelves['A-01']!));
  await expect(
    page.getByText('Scan the item or its case to receive into Main stock/A-01.'),
  ).toBeVisible();
  await wedge(page, OAT_BARCODE);
  await expect(page.locator('.scan-confirm')).toHaveText('1 unit → Main stock/A-01');
  // The carton's lot code is no item: with the lot still empty, it is the lot.
  await wedge(page, 'L-2311');
  await expect(page.getByRole('status')).toHaveText('Lot L-2311.');
  await expect(page.getByRole('textbox', { name: 'Lot' })).toHaveValue('L-2311');
  await wedge(page, OAT_BARCODE);
  await expect(page.locator('.scan-confirm')).toHaveText('2 units · lot L-2311 → Main stock/A-01');
  // A lot with expiry needs its date first.
  const receive = page.getByRole('button', { name: 'Receive 2' });
  await expect(receive).toBeDisabled();
  await page.getByLabel('Expiry date').fill('2030-04-25');
  await receive.click();
  await expect(page.getByRole('status')).toHaveText('Received 2 × OAT-1 into Main stock/A-01.');

  // Looking the item up shows the lot with its expiry at that shelf.
  await page
    .getByRole('navigation', { name: 'Scan flows' })
    .getByRole('button', { name: 'Look up' })
    .click();
  await wedge(page, OAT_BARCODE);
  await expect(page.getByRole('heading', { name: 'Oat milk' })).toBeVisible();
  await expect(page.getByText('Lots with expiry')).toBeVisible();
  const stockHere = page.getByRole('list', { name: 'Stock per location' }).getByRole('listitem');
  await expect(stockHere).toHaveCount(1);
  await expect(stockHere).toHaveText('Main stock/A-01Lot L-2311 (exp. 2030-04-25) · 2');
  const after = await call<Availability>(`/availability?variantId=${oat}`);
  expect(lotPositions(after)).toEqual(['Main stock/A-01 · L-2311 (2030-04-25): 2.000000']);
  expect(violations).toEqual([]);
});

test('move: a shelf with two lots asks which one, and the scanned lot moves', async ({ page }) => {
  const violations = cspWatch(page);
  const { shopId, call, shelves } = await setup(page, 'scan-lot-move', ['A-01', 'B-01']);
  const oat = await lotItem(call);
  for (const [lotCode, expiresOn, quantity] of [
    ['L-A', '2030-01-31', '4'],
    ['L-B', '2030-06-30', '3'],
  ]) {
    await call('/receipts', {
      variantId: oat,
      locationId: shelves['A-01'],
      quantity,
      lotCode,
      expiresOn,
    });
  }

  await page.goto(`/app/scan?shop=${shopId}&flow=move`);
  await expect(page.getByRole('heading', { name: 'Move' })).toBeVisible();
  await wedge(page, label(shelves['A-01']!));
  await expect(page.getByRole('status')).toHaveText('Moving from Main stock/A-01. Scan the items.');
  await wedge(page, OAT_BARCODE);
  await expect(page.getByText('Which lot of OAT-1? Choose or scan it.')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Lot' })).toHaveValue('');
  // The lot code scanned from the carton chooses it.
  await wedge(page, 'L-B');
  await expect(page.getByRole('status')).toHaveText('Lot L-B.');
  await expect(page.getByRole('combobox', { name: 'Lot' })).toHaveValue('L-B');
  await expect(page.getByText('Available here: 3')).toBeVisible();
  await wedge(page, OAT_BARCODE);
  await wedge(page, label(shelves['B-01']!));
  await expect(page.locator('.scan-confirm').last()).toHaveText(
    'OAT-1: 2 units · lot L-B · Main stock/A-01 → Main stock/B-01',
  );
  await page.getByRole('button', { name: 'Move 2 units to Main stock/B-01' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Moved OAT-1: 2 units · lot L-B from Main stock/A-01 to Main stock/B-01.',
  );

  // The lot keeps its expiry on the new shelf; the other lot did not move.
  const after = await call<Availability>(`/availability?variantId=${oat}`);
  expect(lotPositions(after)).toEqual([
    'Main stock/A-01 · L-A (2030-01-31): 4.000000',
    'Main stock/A-01 · L-B (2030-06-30): 1.000000',
    'Main stock/B-01 · L-B (2030-06-30): 2.000000',
  ]);
  expect(violations).toEqual([]);
});

/** A small real PNG, so the browser decodes it and makes the derivatives. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rows[y * (width * 3 + 1) + 1 + x * 3] = (x * 255) / width;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('quick add: a graded card with a picture, its certificate, and family fields', async ({
  page,
}) => {
  const violations = cspWatch(page);
  const { shopId, call, shelves } = await setup(page, 'scan-quick-add', ['A-01']);

  await page.goto(`/app/scan?shop=${shopId}&flow=quick-add`);
  await expect(page.getByRole('heading', { name: 'One-of-a-kind item' })).toBeVisible();
  await wedge(page, label(shelves['A-01']!));
  // The owner adds the Trading cards starter family from here; it is then chosen.
  await page.getByRole('button', { name: 'Add the Trading cards family' }).click();
  await expect(page.getByRole('combobox', { name: 'Family' })).toHaveValue(/.+/);
  await expect(page.getByRole('combobox', { name: 'Grading company' })).toBeVisible();

  await page.getByLabel('Take picture', { exact: true }).setInputFiles({
    name: 'slab.png',
    mimeType: 'image/png',
    buffer: png(800, 600),
  });
  await expect(page.locator('.scan-picture-strip li')).toContainText('Ready');
  await wedge(page, 'PSA-E2E-0001');
  await expect(page.getByRole('textbox', { name: 'Certificate number' })).toHaveValue(
    'PSA-E2E-0001',
  );
  await page.getByRole('textbox', { name: 'Name' }).fill('Charizard Holo');
  await page.getByRole('combobox', { name: 'Condition' }).selectOption({ label: 'NM' });
  await page.getByRole('combobox', { name: 'Grading company' }).selectOption({ label: 'PSA' });
  await page.getByRole('textbox', { name: 'Grade' }).fill('9.5');
  await page.getByRole('textbox', { name: 'Price' }).fill('450');
  await page.getByRole('textbox', { name: 'Cost' }).fill('300');
  await expect(page.getByRole('checkbox', { name: /List on Shopify/ })).toBeDisabled();
  await expect(page.locator('.scan-confirm')).toHaveText(
    '1 unit of Charizard Holo at 450 EUR → Main stock/A-01 · 1 picture',
  );
  await page.getByRole('button', { name: 'Add 1 unit' }).click();
  await expect(page.getByRole('heading', { name: 'Added Charizard Holo' })).toBeVisible();
  await expect(page.locator('.scan-picture-strip li')).toContainText('Linked');

  // Scanning the slab now finds it: one of a kind, one unit on the shelf, with its picture.
  const found = await call<{
    kind: string;
    item: { productId: string; variantId: string; oneOfAKind: boolean };
    stock: { totals: { onHand: string } };
  }>('/scan?code=PSA-E2E-0001');
  expect(found.kind).toBe('item');
  expect(found.item.oneOfAKind).toBe(true);
  expect(found.stock.totals.onHand).toBe('1.000000');
  const media = await call<{ product: { links: unknown[] } }>(
    `/products/${found.item.productId}/media`,
  );
  expect(media.product.links).toHaveLength(1);
  expect(violations).toEqual([]);
});
