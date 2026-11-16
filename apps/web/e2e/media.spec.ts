import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { expect, type Page, test } from '@playwright/test';
import pg from 'pg';

// Milestone N4 (F11) in a real browser: the dashboard makes the WebP derivatives with a canvas,
// uploads every part, and shows the signed thumbnail under the CSP (img-src 'self').

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

/** A real RGB PNG with a gradient, so the browser decodes and resizes it. */
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
    const at = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      rows[at + 1 + x * 3] = (x * 255) / width;
      rows[at + 2 + x * 3] = (y * 255) / height;
      rows[at + 3 + x * 3] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signs in, creates a shop with one product, and opens the product's Pictures tab. */
async function openPictures(page: Page, email: string, shopName: string): Promise<string> {
  await page.goto(`/__e2e/login?email=${email}`);
  await page.getByLabel('Shop name').fill(shopName);
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByRole('grid', { name: 'Products' })).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3]!;
  await page.evaluate(
    async ([shop]) => {
      const res = await fetch(`/api/v1/shops/${shop}/items`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-airstock-request': '1',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({ name: 'Oak chair', sku: 'CHAIR-E2E-1' }),
      });
      if (!res.ok) throw new Error(await res.text());
    },
    [shopId],
  );
  await page.reload();
  await page.getByRole('gridcell').filter({ hasText: 'Oak chair' }).first().click();
  await page.getByRole('grid', { name: 'Products' }).press('Shift+Enter');
  const panel = page.getByRole('complementary', { name: 'Product details' });
  await expect(panel.getByRole('heading', { name: 'Oak chair' })).toBeVisible();
  await panel.getByRole('tab', { name: 'Pictures' }).click();
  await expect(page.getByText('No pictures or attachments yet.')).toBeVisible();
  return shopId;
}

test('a picture uploads with browser-made derivatives and shows as a signed thumbnail', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) {
      violations.push(message.text());
    }
  });

  const shopId = await openPictures(page, 'e2e-media@example.test', 'Media shop');

  const original = png(2000, 1500);
  await page.getByLabel('Choose files').setInputFiles({
    name: 'chair.png',
    mimeType: 'image/png',
    buffer: original,
  });
  const thumbnail = page.locator('.media-thumb img');
  await expect(thumbnail).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Primary', { exact: true })).toBeVisible();
  // The signed thumbnail loaded from the Worker under the page's CSP.
  await expect
    .poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(320);

  await page.getByLabel('Alt text').fill('Oak chair, front');
  await page.getByLabel('Alt text').press('Enter');
  await expect(page.locator('.media-thumb img[alt="Oak chair, front"]')).toBeVisible();

  // The gallery card shows the primary picture, fetched in one batched read.
  await page.getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('button', { name: 'Gallery' }).click();
  const card = page.locator('.gallery-image img[alt="Oak chair, front"]');
  await expect(card).toBeVisible();
  await expect.poll(() => card.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);

  const [asset] = await query<{
    id: string;
    size_bytes: string;
    sha256: string;
    width: number;
    derivatives: Record<string, { contentType: string; width: number; height: number }>;
  }>('select id, size_bytes, sha256, width, derivatives from media_assets where shop_id = $1', [
    shopId,
  ]);
  expect(Number(asset!.size_bytes)).toBe(original.byteLength);
  expect(asset!.sha256).toBe(createHash('sha256').update(original).digest('hex'));
  expect(asset!.width).toBe(2000);
  expect(asset!.derivatives.thumbnail).toMatchObject({
    contentType: 'image/webp',
    width: 320,
    height: 240,
  });
  expect(asset!.derivatives.display).toMatchObject({ width: 1600, height: 1200 });

  // Q1: each list request recorded one event naming the media it returned.
  const listed = await query<{ media: string[] }>(
    `select array(select jsonb_array_elements_text(context->'mediaIds')) as media
     from audit_events where shop_id = $1 and action = 'catalog.media.listed'
     order by occurred_at desc limit 1`,
    [shopId],
  );
  expect(listed[0]?.media).toEqual([asset!.id]);
  const actions = await query<{ action: string }>(
    `select distinct action from audit_events where shop_id = $1 and action like 'catalog.media.%'`,
    [shopId],
  );
  expect(actions.map((a) => a.action)).toEqual(
    expect.arrayContaining([
      'catalog.media.upload_started',
      'catalog.media.part_uploaded',
      'catalog.media.finalized',
      'catalog.media.link_updated',
      'catalog.media.primary_viewed',
    ]),
  );
  expect(violations).toEqual([]);
});

test('an original larger than the shop keeps is shrunk in the browser before upload (D19)', async ({
  page,
}) => {
  const shopId = await openPictures(page, 'e2e-media-limit@example.test', 'Limit shop');
  type Asset = {
    file_name: string;
    content_type: string;
    size_bytes: string;
    sha256: string;
    width: number;
    height: number;
    derivatives: Record<string, { width: number; height: number }>;
  };
  const assets = () =>
    query<Asset>(
      `select file_name, content_type, size_bytes, sha256, width, height, derivatives
       from media_assets where shop_id = $1 order by created_at`,
      [shopId],
    );

  // The default keeps 2,048 px: a 3,000 px PNG arrives as a 2,048 px PNG, hashed after shrinking.
  const wide = png(3000, 2000);
  await page.getByLabel('Choose files').setInputFiles({
    name: 'wide.png',
    mimeType: 'image/png',
    buffer: wide,
  });
  await expect(page.locator('.media-thumb img')).toHaveCount(1, { timeout: 30_000 });
  const [shrunk] = await assets();
  expect(shrunk).toMatchObject({
    file_name: 'wide.png',
    content_type: 'image/png',
    width: 2048,
    height: 1365,
  });
  expect(shrunk!.sha256).not.toBe(createHash('sha256').update(wide).digest('hex'));
  expect(shrunk!.derivatives.display).toMatchObject({ width: 1600, height: 1066 });

  // A manager chooses 1,024 px in the shop settings; the next upload follows it.
  await page.goto(`/app/shops/${shopId}/settings/shop`);
  const setting = page.getByLabel('Largest original');
  await expect(setting).toHaveValue('2048');
  await setting.selectOption('1024');
  await expect
    .poll(
      async () =>
        (
          await query<{ n: number }>(
            'select media_original_max_side as n from shops where id = $1',
            [shopId],
          )
        )[0]?.n,
    )
    .toBe(1024);
  const [product] = await query<{ id: string }>('select id from products where shop_id = $1', [
    shopId,
  ]);
  await page.goto(`/app/shops/${shopId}/products?item=${product!.id}`);
  await page
    .getByRole('complementary', { name: 'Product details' })
    .getByRole('tab', { name: 'Pictures' })
    .click();
  await expect(page.locator('.media-thumb img')).toHaveCount(1);
  await page.getByLabel('Choose files').setInputFiles({
    name: 'tall.png',
    mimeType: 'image/png',
    buffer: png(1200, 1800),
  });
  await expect(page.locator('.media-thumb img')).toHaveCount(2, { timeout: 30_000 });
  const [, second] = await assets();
  expect(second).toMatchObject({ width: 683, height: 1024 });
  // The display image is never larger than the original it was made from.
  expect(second!.derivatives.display).toMatchObject({ width: 683, height: 1024 });
});
