import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { readLabelPdf } from '../test/pdf-images.ts';

// A41, pick half, in a real browser under the app's CSP: a pick list for 20 orders built in the
// dashboard and printed as a PDF, then worked on the scan page with a keyboard-wedge scanner:
// location, item, confirm; one short pick, handed over to Count, which keeps the units already
// picked and moves the short order to other stock; finishing fulfills, and only then does stock
// drop for the picked orders.

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

test('a pick list for 20 orders is printed, picked by scanning, and fulfilled at the end', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) {
      violations.push(message.text());
    }
  });

  await page.goto('/__e2e/login?email=e2e-pick@example.test');
  await page.getByLabel('Shop name').fill('Pick shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByText('No products yet. Add one to start.')).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3]!;
  const call = api(page, shopId);

  const { warehouses } = await call<{ warehouses: Array<{ warehouseId: string }> }>('/warehouses');
  const warehouseId = warehouses[0]!.warehouseId;
  const shelves: Record<string, string> = {};
  for (const code of ['B-01', 'A-01', 'C-01']) {
    shelves[code] = (
      await call<{ locationId: string }>('/locations', { warehouseId, name: code, code })
    ).locationId;
  }
  const products = [
    { sku: 'CARD-1', barcode: '4006381333931', shelf: 'A-01' },
    { sku: 'BOX-1', barcode: '5901234123457', shelf: 'B-01' },
  ];
  const variants: Record<string, string> = {};
  for (const p of products) {
    const created = await call<{ variantId: string }>('/items', {
      name: p.sku === 'CARD-1' ? 'Pikachu card' : 'Booster box',
      sku: p.sku,
      barcode: p.barcode,
      acknowledgeSimilar: true,
    });
    variants[p.sku] = created.variantId;
    await call('/receipts', {
      variantId: created.variantId,
      locationId: shelves[p.shelf],
      quantity: '20',
    });
  }
  // 5 more cards on C-01, free for the short order's claim (the orders take A-01's first).
  await call('/receipts', {
    variantId: variants['CARD-1'],
    locationId: shelves['C-01'],
    quantity: '5',
  });
  // 20 orders of one unit, alternating cards and boxes.
  for (let i = 1; i <= 20; i++) {
    await call('/reservations', {
      variantId: variants[i % 2 ? 'CARD-1' : 'BOX-1'],
      quantity: '1',
      purpose: 'external_order',
      externalRef: `api:order/${1000 + i}`,
    });
  }

  // The dashboard builds the list and prints it.
  await page.getByRole('link', { name: 'Picking' }).click();
  await page.getByRole('button', { name: 'Build pick list' }).click();
  await expect(page.getByRole('heading', { name: 'Pick list 1' })).toBeVisible();
  await expect(page.getByText('20 orders · 20 lines · 20 to pick')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download PDF' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('pick-list-1.pdf');
  const pdf = await readLabelPdf(new Uint8Array(await readFile((await download.path())!)));
  const printed = pdf.texts.map((t) => t.text);
  expect(printed).toContain('Pick list 1');
  // Walk order: shelf A-01 before B-01, even though B-01 was created first.
  expect(printed.filter((t) => /^Main stock\/[AB]-01$/.test(t))).toEqual([
    'Main stock/A-01',
    'Main stock/B-01',
  ]);
  expect(printed).toContain('api:order/1020');

  // Work it on the phone with a wedge scanner.
  const stockBefore = await call<{ totals: { onHand: string } }>(
    `/availability?variantId=${variants['CARD-1']}`,
  );
  await page.goto(`/app/scan?shop=${shopId}&flow=pick`);
  await page.getByRole('button', { name: /Pick list 1/ }).click();
  await expect(page.getByText('Go to', { exact: true })).toBeVisible();
  await expect(page.locator('.scan-pick-stop')).toHaveText('Main stock/A-01');

  // An item before its location is refused; the label first, then the card.
  await wedge(page, '4006381333931');
  await expect(page.getByRole('alert')).toHaveText(
    'Scan the location label of Main stock/A-01 first.',
  );
  await wedge(page, `LOC:${shelves['A-01']!.toUpperCase()}`);
  await expect(page.getByText('Pick here', { exact: true })).toBeVisible();
  // A wrong item at this stop is refused.
  await wedge(page, '5901234123457');
  await expect(page.getByRole('alert')).toHaveText('Wrong item: this stop needs CARD-1.');
  for (let i = 0; i < 9; i++) {
    await wedge(page, '4006381333931');
    await expect(page.locator('.scan-confirm')).toHaveText(/^1 of 1/);
    await page.getByRole('button', { name: 'Confirm 1' }).click();
    await expect(page.getByText(`${19 - i} of 20 to pick`)).toBeVisible();
  }
  // The tenth card is not on the shelf: a short pick.
  await wedge(page, '4006381333931');
  await page.getByRole('button', { name: 'Short…' }).click();
  await page.getByRole('textbox', { name: 'Found' }).fill('0');
  await page.getByRole('button', { name: 'Only 0 found' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Short: 1 × CARD-1 not found at Main stock/A-01. Flagged for a count.',
  );
  // Picking, short pick included, changed nothing in stock.
  const during = await call<{ totals: { onHand: string } }>(
    `/availability?variantId=${variants['CARD-1']}`,
  );
  expect(during.totals.onHand).toBe(stockBefore.totals.onHand);
  const { pickLists } = await call<{ pickLists: Array<{ pickListId: string }> }>(
    '/pick-lists?status=open',
  );
  const { pickLines } = await call<{
    pickLines: Array<{ status: string; externalRef: string; sku: string; short: string }>;
  }>(`/pick-lists/${pickLists[0]!.pickListId}`);
  const shorted = pickLines.filter((l) => l.status === 'short');
  expect(shorted).toEqual([expect.objectContaining({ sku: 'CARD-1', short: '1', picked: '0' })]);

  // The short line hands over to Count with its shelf and the item listed. The 9 cards picked
  // from the shelf are in the tote, still on record there: the count adds them to the 0 found.
  await page.getByRole('button', { name: 'Count that shelf' }).click();
  await expect(
    page.getByText(
      'Short pick: 1 × CARD-1 missing at Main stock/A-01. Count what is on the shelf. The 9 already picked from it are added.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'To confirm' })).toHaveText(
    'CARD-1: 0 units + 9 picked',
  );
  await page.getByRole('button', { name: 'Confirm count of 1 item' }).click();
  // Only the short order's unit needs a decision; it is listed first.
  await expect(
    page.getByText('CARD-1 at Main stock/A-01: 1 reserved unit needs a decision (0 chosen)'),
  ).toBeVisible();
  const claim = page.locator('.scan-claim-list li').first();
  await expect(claim).toContainText(`${shorted[0]!.externalRef} 1 reserved · short pick`);
  await claim.getByRole('button', { name: 'Move to other stock' }).click();
  await page.getByRole('button', { name: 'Apply with these choices' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Counted at Main stock/A-01: CARD-1 -11. 1 reserved claim(s) settled.',
  );
  const counted = await call<{
    positions: Array<{ locationPath: string; onHand: string; reserved: string }>;
  }>(`/availability?variantId=${variants['CARD-1']}`);
  expect(
    Object.fromEntries(counted.positions.map((p) => [p.locationPath, [p.onHand, p.reserved]])),
  ).toEqual({
    'Main stock/A-01': ['9.000000', '9.000000'],
    'Main stock/C-01': ['5.000000', '1.000000'],
  });
  await page.getByRole('button', { name: 'Pick', exact: true }).click();

  // The boxes, on the next shelf.
  await expect(page.locator('.scan-pick-stop')).toHaveText('Main stock/B-01');
  await wedge(page, `LOC:${shelves['B-01']!.toUpperCase()}`);
  for (let i = 0; i < 10; i++) {
    await wedge(page, '5901234123457');
    await page.getByRole('button', { name: 'Confirm 1' }).click();
    await expect(page.getByText(`${9 - i} of 20 to pick`)).toBeVisible();
  }
  await page.getByRole('button', { name: 'Finish and fulfill' }).click();
  await expect(page.getByRole('heading', { name: 'Pick list 1 is complete' })).toBeVisible();
  await expect(
    page.getByText(/19 fulfillment\(s\) recorded; 1 short line\(s\) stay reserved/),
  ).toBeVisible();

  // Fulfillment at the end is what lowers stock: the 9 picked cards leave A-01, and the short
  // order stays reserved on C-01 for the next list; 10 boxes left.
  const cards = await call<{ totals: { onHand: string; reserved: string } }>(
    `/availability?variantId=${variants['CARD-1']}`,
  );
  expect(cards.totals).toMatchObject({ onHand: '5.000000', reserved: '1.000000' });
  const boxes = await call<{ totals: { onHand: string } }>(
    `/availability?variantId=${variants['BOX-1']}`,
  );
  expect(boxes.totals.onHand).toBe('10.000000');
  expect(violations).toEqual([]);
});
