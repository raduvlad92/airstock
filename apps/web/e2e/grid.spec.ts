import { createHash } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';

// N3 done-when: the grid's keyboard, conflict, and bulk paths in a real browser (A09, A10, A17),
// and 10,000 variants scroll without loading the whole catalog (F12).

const admin =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/postgres';
const ownerUrl = new URL(admin);
ownerUrl.pathname = `/${process.env.E2E_DB_NAME ?? `airstock_e2e_${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 8)}`}`;

async function query<R>(sql: string, params: unknown[] = []): Promise<R[]> {
  const client = new pg.Client({ connectionString: ownerUrl.toString() });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as R[];
  } finally {
    await client.end();
  }
}

/** Calls the API from the page, as the dashboard does. */
async function apiCall<T>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(`/api/v1${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'x-airstock-request': '1',
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return res.json();
    },
    { path, body },
  ) as Promise<T>;
}

async function newShop(page: Page, email: string): Promise<string> {
  await page.goto(`/__e2e/login?email=${email}`);
  await page.getByLabel('Shop name').fill(`Grid shop ${email}`);
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByRole('grid', { name: 'Products' })).toBeVisible();
  return new URL(page.url()).pathname.split('/')[3]!;
}

const cell = (page: Page, row: number, col: number) => page.locator(`#cell-${row}-${col}`);

test('keyboard editing, a conflict resolved, and a pasted bulk edit', async ({ page }) => {
  const shopId = await newShop(page, 'grid-keys@example.test');
  const names = ['Anchor mug', 'Birch stool', 'Cedar box', 'Delta lamp'];
  const created: Array<{ productId: string; variantId: string }> = [];
  for (const [i, name] of names.entries()) {
    created.push(
      await apiCall(page, `/shops/${shopId}/items`, { name, sku: `G-${i}`, price: '10' }),
    );
  }
  await page.reload();
  const grid = page.getByRole('grid', { name: 'Products' });
  await expect(cell(page, 3, 0)).toContainText('Delta lamp');

  // Columns: Name, SKU, Options, Price… Move to SKU of the first row with the keyboard and edit it.
  await cell(page, 0, 0).click();
  await grid.press('ArrowRight');
  await expect(cell(page, 0, 1)).toHaveClass(/active/);
  await grid.press('Enter');
  const editor = page.getByRole('textbox', { name: 'SKU' });
  await expect(editor).toHaveValue('G-0');
  await editor.fill('G-0-NEW');
  await editor.press('Enter');
  await expect(cell(page, 0, 1)).toContainText('G-0-NEW');
  await expect(cell(page, 1, 1)).toHaveClass(/active/);
  // Typing starts an edit with that character (price of the second row: two columns right).
  await grid.press('ArrowRight');
  await grid.press('ArrowRight');
  await grid.press('2');
  await page.getByRole('textbox', { name: 'Price' }).press('Enter');
  await expect(cell(page, 1, 3)).toContainText('2.00');

  // Someone else changes the third row's price meanwhile (A09); our edit conflicts.
  await apiCall(page, `/shops/${shopId}/items/${created[2]!.productId}/changes`, {
    changes: [{ variantId: created[2]!.variantId, field: 'price', expected: '10', value: '11' }],
  });
  await cell(page, 2, 3).click();
  await grid.press('Enter');
  await page.getByRole('textbox', { name: 'Price' }).fill('15');
  await page.getByRole('textbox', { name: 'Price' }).press('Enter');
  await expect(cell(page, 2, 3)).toHaveClass(/state-conflict/);
  // The status bar explains the conflict for the active cell.
  await cell(page, 2, 3).click();
  await expect(page.getByText(/changed to “11”/)).toBeVisible();
  await page.getByRole('button', { name: 'Keep mine' }).click();
  await expect(cell(page, 2, 3)).not.toHaveClass(/state-conflict/);
  await expect(cell(page, 2, 3)).toContainText('15.00');

  // Pasting three prices previews a bulk edit; applying it saves all three (D4).
  await cell(page, 0, 3).click();
  await grid.evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/plain', '5\n6\n7');
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  const dialog = page.getByRole('dialog', { name: 'Review 3 changes' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('row')).toHaveCount(4);
  await dialog.getByRole('button', { name: 'Apply 3 records' }).click();
  await expect(dialog).toBeHidden();
  await expect(cell(page, 2, 3)).toContainText('7.00');

  // Fill down: select the SKU... price of rows 0-3 and press Ctrl+D; a stale preview is re-made (A17).
  await cell(page, 0, 3).click();
  await grid.press('Shift+ArrowDown');
  await grid.press('Shift+ArrowDown');
  await grid.press('Shift+ArrowDown');
  await grid.press('Control+d');
  const fill = page.getByRole('dialog', { name: 'Review 3 changes' });
  await expect(fill.getByRole('row')).toHaveCount(4);
  await apiCall(page, `/shops/${shopId}/items/${created[3]!.productId}/changes`, {
    changes: [{ variantId: created[3]!.variantId, field: 'price', expected: '10', value: '99' }],
  });
  await fill.getByRole('button', { name: 'Apply 3 records' }).click();
  await expect(fill.getByText('Some records changed since the first preview')).toBeVisible();
  await expect(fill.getByRole('cell', { name: '99' })).toBeVisible();
  await fill.getByRole('button', { name: 'Apply 3 records' }).click();
  await expect(fill).toBeHidden();
  const prices = await query<{ price: string }>(
    `select price::text from variants where id = any($1) order by sku`,
    [created.map((c) => c.variantId)],
  );
  expect(prices.map((p) => Number(p.price))).toEqual([5, 5, 5, 5]);
});

test('interface and server events are recorded with the grid (A10)', async ({ page }) => {
  const shopId = await newShop(page, 'grid-events@example.test');
  await apiCall(page, `/shops/${shopId}/items`, { name: 'Event lamp', sku: 'EV-1', price: '10' });
  await page.reload();
  await expect(cell(page, 0, 0)).toContainText('Event lamp');
  // Resize the SKU column, open the detail panel, switch to the gallery and back.
  const handle = page.getByRole('separator', { name: 'Resize SKU' });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 5, { steps: 4 });
  await page.mouse.up();
  await cell(page, 0, 0).click();
  await page.getByRole('grid', { name: 'Products' }).press('Shift+Enter');
  await expect(page.getByRole('complementary', { name: 'Product details' })).toBeVisible();
  await page.getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('button', { name: 'Gallery' }).click();
  await page.getByRole('button', { name: 'Grid' }).click();
  await page.getByRole('button', { name: 'Filters' }).click();
  await page.getByRole('button', { name: 'Add filter' }).click();
  await page.getByLabel('Value').fill('lamp');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Name contains lamp')).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await query<{ action: string }>(
            `select distinct action from audit_events where shop_id = $1 and action like any(array['client.%', 'catalog.items.queried'])`,
            [shopId],
          )
        ).map((r) => r.action),
      { timeout: 15_000 },
    )
    .toEqual(
      expect.arrayContaining([
        'client.grid.column_resized',
        'client.detail_panel.opened',
        'client.detail_panel.closed',
        'client.view.type_switched',
        'catalog.items.queried',
      ]),
    );
  const [filtered] = await query<{ context: { filter: unknown[] } }>(
    `select context from audit_events where shop_id = $1 and action = 'catalog.items.queried'
       and jsonb_array_length(context->'filter') > 0 limit 1`,
    [shopId],
  );
  expect(filtered!.context.filter).toEqual([{ field: 'name', op: 'contains', value: 'lamp' }]);
});

test('10,000 variants scroll without loading the whole catalog (F12)', async ({ page }) => {
  const shopId = await newShop(page, 'grid-scale@example.test');
  await query(
    `with p as (
       insert into products (shop_id, id, name)
       select $1, gen_random_uuid(), 'Scale item ' || lpad(n::text, 5, '0') from generate_series(1, 10000) n
       returning id, name)
     insert into variants (shop_id, id, product_id, sku, sku_normalized, price, is_default)
     select $1, gen_random_uuid(), p.id, 'SC-' || right(p.name, 5), 'SC-' || right(p.name, 5), 9.5, true from p`,
    [shopId],
  );
  await page.reload();
  const grid = page.getByRole('grid', { name: 'Products' });
  await expect(page.getByText('10,000 variants')).toBeVisible();
  await expect(cell(page, 0, 0)).toContainText('Scale item 00001');
  // Scroll far down in steps; pages load as needed, and only visible rows are in the DOM.
  const scroller = page.locator('.grid-scroll');
  for (let i = 0; i < 12; i++) {
    await scroller.evaluate((el) => {
      el.scrollTop += 4000;
    });
    await page.waitForTimeout(150);
  }
  const rendered = await page.locator('.grid-row').count();
  expect(rendered).toBeLessThan(80);
  await cell(page, 0, 0).waitFor({ state: 'detached' });
  await grid.focus();
  const fetched = await page.evaluate(
    () =>
      performance.getEntriesByType('resource').filter((e) => e.name.includes('/items/query'))
        .length,
  );
  // A page is 50 rows: far fewer requests than the whole catalog would need.
  expect(fetched).toBeLessThan(40);
  expect(fetched).toBeGreaterThan(1);
});
