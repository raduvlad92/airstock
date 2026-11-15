import {
  execute,
  hmacMediaDelivery,
  mediaFiles,
  ops,
  uuidv7,
  verifyMediaLink,
} from '@airstock/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appDatabase,
  MemoryAuditSink,
  ownerQuery,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';
import { fakeJpeg, fakePdf, fakePng, fakeWebp, sha256Hex } from '../../../test/media-fixtures.ts';

// Milestone N4: what files are accepted and how they are recognised, signed links, and tenant
// isolation of the media tables at the SQL layer (plan Section 5.8, A13).

const { fitWithin, imageSize, normalizeRole, sniffType } = mediaFiles;
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

describe('file signatures and pixel sizes', () => {
  it('recognises each accepted type by its bytes, whatever its name says', () => {
    expect(sniffType(fakePng(10, 10))).toBe('image/png');
    expect(sniffType(fakeJpeg(10, 10))).toBe('image/jpeg');
    expect(sniffType(fakeWebp(10, 10))).toBe('image/webp');
    expect(sniffType(ascii('GIF89a\x10\x00\x20\x00'))).toBe('image/gif');
    expect(sniffType(fakePdf())).toBe('application/pdf');
    const avif = Uint8Array.from([
      0,
      0,
      0,
      0x1c,
      ...ascii('ftypavif'),
      0,
      0,
      0,
      0,
      ...ascii('mif1miafavif'),
    ]);
    expect(sniffType(avif)).toBe('image/avif');
    // iPhone HEIC, SVG, and HTML are not accepted (R5: Safari converts HEIC first).
    const heic = Uint8Array.from([
      0,
      0,
      0,
      0x18,
      ...ascii('ftypheic'),
      0,
      0,
      0,
      0,
      ...ascii('mif1heic'),
    ]);
    expect(sniffType(heic)).toBeNull();
    expect(sniffType(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffType(ascii('<!doctype html>'))).toBeNull();
    expect(sniffType(new Uint8Array(0))).toBeNull();
  });

  it('reads pixel sizes from headers without decoding', () => {
    expect(imageSize(fakePng(3000, 2000), 'image/png')).toEqual({ width: 3000, height: 2000 });
    expect(imageSize(fakeJpeg(1600, 900), 'image/jpeg')).toEqual({ width: 1600, height: 900 });
    expect(imageSize(fakeWebp(320, 213), 'image/webp')).toEqual({ width: 320, height: 213 });
    expect(imageSize(ascii('GIF89a\x10\x00\x20\x00'), 'image/gif')).toEqual({
      width: 16,
      height: 32,
    });
    // Lossless WebP: signature 0x2f, then 14-bit width and height minus one.
    const bits = (100 - 1) | ((50 - 1) << 14);
    const vp8l = Uint8Array.from([
      ...ascii('RIFF'),
      0,
      0,
      0,
      0,
      ...ascii('WEBPVP8L'),
      0,
      0,
      0,
      0,
      0x2f,
      bits & 0xff,
      (bits >> 8) & 0xff,
      (bits >> 16) & 0xff,
      (bits >> 24) & 0xff,
      ...new Array(8).fill(0),
    ]);
    expect(imageSize(vp8l, 'image/webp')).toEqual({ width: 100, height: 50 });
    // A truncated header gives no size rather than a wrong one.
    expect(imageSize(fakePng(10, 10).slice(0, 20), 'image/png')).toBeNull();
    expect(imageSize(fakeJpeg(10, 10).slice(0, 12), 'image/jpeg')).toBeNull();
  });

  it('fits derivatives inside their longest side and never enlarges', () => {
    expect(fitWithin(4032, 3024, 320)).toEqual({ width: 320, height: 240 });
    expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(200, 100, 320)).toEqual({ width: 200, height: 100 });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20000 }),
        fc.integer({ min: 1, max: 20000 }),
        (w, h) => {
          const out = fitWithin(w, h, 320);
          return (
            Math.max(out.width, out.height) <= Math.max(320, 1) && out.width <= w && out.height <= h
          );
        },
      ),
    );
  });

  it('turns role names into slugs', () => {
    expect(normalizeRole('Dimension diagram')).toBe('dimension_diagram');
    expect(normalizeRole(' swatch ')).toBe('swatch');
    expect(normalizeRole('care-guide')).toBe('care_guide');
    expect(normalizeRole('123')).toBeNull();
    expect(normalizeRole('!!!')).toBeNull();
  });
});

describe('signed media links', () => {
  const key = 'core-test-media-key';
  const shopId = uuidv7();
  const mediaId = uuidv7();

  it('verifies its own links and nothing else', async () => {
    const delivery = hmacMediaDelivery(key, 'https://airstock.test/');
    const link = await delivery.sign({ shopId, mediaId, part: 'thumbnail', ttlSeconds: 900 });
    const url = new URL(link.url);
    expect(url.origin).toBe('https://airstock.test');
    expect(url.pathname).toBe(`/media/${shopId}/${mediaId}/thumbnail`);
    const exp = url.searchParams.get('exp')!;
    const sig = url.searchParams.get('sig')!;
    // At least 15 minutes, rounded up to a 5-minute step so repeat views share a browser cache.
    const validFor = Number(exp) * 1000 - Date.now();
    expect(validFor).toBeGreaterThanOrEqual(899_000);
    expect(validFor).toBeLessThanOrEqual(1200_000);
    expect(Number(exp) % 300).toBe(0);
    expect(await verifyMediaLink(key, { shopId, mediaId, part: 'thumbnail', exp, sig })).toBe('ok');
    for (const changed of [
      { shopId: uuidv7() },
      { mediaId: uuidv7() },
      { part: 'original' },
      { exp: String(Number(exp) + 300) },
      { sig: `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}` },
      { sig: 'not-base64' },
      { exp: '1e12' },
    ]) {
      expect(
        await verifyMediaLink(key, { shopId, mediaId, part: 'thumbnail', exp, sig, ...changed }),
      ).toBe('invalid');
    }
    expect(
      await verifyMediaLink('another-key', { shopId, mediaId, part: 'thumbnail', exp, sig }),
    ).toBe('invalid');
    expect(
      await verifyMediaLink(
        key,
        { shopId, mediaId, part: 'thumbnail', exp, sig },
        Number(exp) * 1000,
      ),
    ).toBe('expired');
  });

  it('gives the same link within a 5-minute step', async () => {
    const delivery = hmacMediaDelivery(key);
    const at = Math.floor(Date.now() / 300_000) * 300_000 + 1000;
    const a = await delivery.sign({ shopId, mediaId, part: 'display', ttlSeconds: 900, now: at });
    const b = await delivery.sign({
      shopId,
      mediaId,
      part: 'display',
      ttlSeconds: 900,
      now: at + 120_000,
    });
    expect(a.url).toBe(b.url);
  });
});

describe('media tables at the SQL layer (A13)', () => {
  const db = appDatabase();
  const sink = new MemoryAuditSink();
  let a: SeededShop;
  let b: SeededShop;
  let mediaA: string;
  let productB: string;

  beforeAll(async () => {
    a = await seedShop(db, sink, 'Media SQL A');
    b = await seedShop(db, sink, 'Media SQL B');
    const bytes = fakePdf();
    const run = (shop: SeededShop, op: (typeof ops)[keyof typeof ops], input: unknown) =>
      execute(
        { db, audit: sink, media: hmacMediaDelivery('k') },
        op as Parameters<typeof execute>[1],
        { caller: shop.caller, shopId: shop.shopId, input, idempotencyKey: uuidv7() },
      ).then((r) => r.result as Record<string, string>);
    const intent = await run(a, ops.createUpload, {
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
    mediaA = intent.mediaId!;
    // The bytes path is the Worker's; here the part is recorded as the route would.
    await ownerQuery(
      `update media_upload_intents set parts = jsonb_build_object('original',
         jsonb_build_object('size', $2::int, 'sha256', $3::text, 'contentType', 'application/pdf',
           'width', null, 'height', null))
       where id = $1`,
      [intent.intentId, bytes.byteLength, sha256Hex(bytes)],
    );
    await run(a, ops.finalizeUpload, { intentId: intent.intentId });
    productB = (await run(b, ops.createItem, { name: 'B', sku: `B-${uuidv7().slice(-6)}` }))
      .productId!;
  });
  afterAll(() => db.close());

  it('hides another shop’s media rows and refuses links to them', async () => {
    const seen = await db.transaction({ shopId: b.shopId, userId: b.userId }, async (tx) => ({
      assets: await tx.query('select id from media_assets where id = $1', [mediaA]),
      intents: await tx.query('select id from media_upload_intents where media_id = $1', [mediaA]),
    }));
    expect(seen).toEqual({ assets: [], intents: [] });
    // Even a hand-written insert cannot point shop B's link at shop A's media.
    await expect(
      db.transaction({ shopId: b.shopId, userId: b.userId }, (tx) =>
        tx.query(
          `insert into media_links (shop_id, id, media_id, product_id, role, position)
           values (app_shop_id(), $1, $2, $3, 'detail', 0)`,
          [uuidv7(), mediaA, productB],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    // Nor can it write a row for another shop.
    await expect(
      db.transaction({ shopId: b.shopId, userId: b.userId }, (tx) =>
        tx.query(
          `insert into media_links (shop_id, id, media_id, product_id, role, position)
           values ($1, $2, $3, $4, 'detail', 0)`,
          [a.shopId, uuidv7(), mediaA, productB],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a media record without an upload behind it', async () => {
    await expect(
      db.transaction({ shopId: a.shopId, userId: a.userId }, (tx) =>
        tx.query(
          `insert into media_assets (shop_id, id, kind, file_name, content_type, size_bytes, sha256, created_by)
           values (app_shop_id(), $1, 'image', 'x.png', 'image/png', 1, $2, 'test')`,
          [uuidv7(), 'a'.repeat(64)],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
