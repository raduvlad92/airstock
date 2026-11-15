import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
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

test('a picture uploads with browser-made derivatives and shows as a signed thumbnail', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) {
      violations.push(message.text());
    }
  });

  await page.goto('/__e2e/login?email=e2e-media@example.test');
  await page.getByLabel('Shop name').fill('Media shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByRole('grid', { name: 'Products' })).toBeVisible();
  const shopId = new URL(page.url()).pathname.split('/')[3];
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
