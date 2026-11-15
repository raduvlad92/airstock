import { expect, test } from '@playwright/test';
import pg from 'pg';

const admin =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/postgres';
const ownerUrl = new URL(admin);
ownerUrl.pathname = '/airstock_e2e';

async function query<R>(sql: string, params: unknown[] = []): Promise<R[]> {
  const client = new pg.Client({ connectionString: ownerUrl.toString() });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as R[];
  } finally {
    await client.end();
  }
}

test('the React shell runs under the CSP, works against /api/v1, and reports page views', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) {
      violations.push(message.text());
    }
  });

  await page.goto('/__e2e/login?email=e2e-shell@example.test');
  await expect(page.getByRole('heading', { name: 'Your shops' })).toBeVisible();
  await page.getByLabel('Shop name').fill('E2E shop');
  await page.getByRole('button', { name: 'Create shop' }).click();

  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  await expect(page.getByText('No products yet.')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Desk lamp');
  await page.getByLabel('SKU').fill('LAMP-E2E-1');
  await page.getByLabel('Price').fill('39.90');
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page.getByRole('cell', { name: 'LAMP-E2E-1' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText('20 per second')).toBeVisible();
  await page.getByRole('link', { name: 'Warehouses' }).click();
  await expect(page.getByRole('heading', { name: 'Main stock' })).toBeVisible();

  const shopId = new URL(page.url()).pathname.split('/')[3];
  // The page views reach the activity history within one flush interval (5 s).
  await expect
    .poll(
      async () =>
        (
          await query<{ route: string }>(
            `select context->'details'->>'route' as route from audit_events
             where shop_id = $1 and action = 'client.page.viewed' order by occurred_at`,
            [shopId],
          )
        ).map((r) => r.route),
      { timeout: 15_000 },
    )
    .toEqual(
      expect.arrayContaining([
        '/shops/$shopId/products',
        '/shops/$shopId/settings/shop',
        '/shops/$shopId/warehouses',
      ]),
    );

  expect(violations).toEqual([]);
});

test('a phone-sized screen has no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__e2e/login?email=e2e-phone@example.test');
  await page.getByLabel('Shop name').fill('Phone shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
