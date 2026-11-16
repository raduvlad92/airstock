import {
  execute,
  hmacMediaDelivery,
  ops,
  sessionCaller,
  sweepMediaUploads,
  uuidv7,
} from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery, type SeededShop, seedShop } from '../../../test/helpers.ts';
import {
  fakeAvif,
  fakeCameraJpeg,
  fakeJpeg,
  fakePdf,
  fakePng,
  fakeWebp,
  fakeWebpLossy,
  sha256Hex,
} from '../../../test/media-fixtures.ts';
import { memoryMediaStore, nodeHasher } from '../src/media-memory.ts';
import { mcpSession } from './mcp-client.ts';
import { apiToken, json, type TestApp, testApp } from './setup.ts';

// Milestone N4 (plan Section 5.8, F11): upload with checks while streaming, browser-made
// derivatives, links with roles, order, and primary flags, signed delivery, access logging (Q1).

const KEY = 'test-media-signing-key-0123456789';
const store = memoryMediaStore();
let t: TestApp;
let shop: SeededShop;
let other: SeededShop;
let token: string;
let otherToken: string;

beforeAll(async () => {
  t = await testApp({
    media: { store, hasher: nodeHasher, signingKey: KEY, publicUrl: 'https://airstock.test' },
  });
  shop = await seedShop(t.db, t.sink, 'Media shop');
  other = await seedShop(t.db, t.sink, 'Other media shop');
  const scopes = ['shop:read', 'catalog:read', 'catalog:write'];
  token = (await apiToken(t, shop, scopes)).token;
  otherToken = (await apiToken(t, other, scopes, other.caller)).token;
});
afterAll(() => t.close());

function client(s: SeededShop, bearer: string) {
  return (path: string, body?: unknown, key = crypto.randomUUID()) => {
    const headers = new Headers({ authorization: `Bearer ${bearer}` });
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      headers.set('idempotency-key', key);
    }
    return t.app.request(`/api/v1/shops/${s.shopId}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
}
const rest = (path: string, body?: unknown) => client(shop, token)(path, body);

/** PUTs a part to an upload URL, as the dashboard or an API client would. */
function put(url: string, bytes: Uint8Array, contentType: string, bearer = token) {
  return t.app.request(new URL(url).pathname, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': contentType,
      'content-length': String(bytes.byteLength),
    },
    body: bytes,
  });
}

interface Intent {
  intentId: string;
  mediaId: string;
  uploads: Array<{ part: string; url: string }>;
}

async function startUpload(
  bytes: Uint8Array,
  contentType: string,
  fileName: string,
  extra: Record<string, unknown> = {},
): Promise<Intent> {
  const res = await rest('/media/uploads', {
    fileName,
    contentType,
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
    ...extra,
  });
  expect(res.status).toBe(201);
  return (await json(res)) as Intent;
}

const urlOf = (intent: Intent, part: string) => intent.uploads.find((u) => u.part === part)!.url;

/** A full image upload: original, 320 px thumbnail, 1,600 px display image. */
async function uploadImage(name = 'photo.png') {
  // Exactly the default limit on an original's longest side (D19).
  const original = fakePng(2048, 1365);
  const intent = await startUpload(original, 'image/png', name);
  expect((await put(urlOf(intent, 'original'), original, 'image/png')).status).toBe(200);
  expect((await put(urlOf(intent, 'thumbnail'), fakeWebp(320, 213), 'image/webp')).status).toBe(
    200,
  );
  expect((await put(urlOf(intent, 'display'), fakeWebp(1600, 1067), 'image/webp')).status).toBe(
    200,
  );
  return { intent, original };
}

async function product(name: string, colors?: string[]) {
  const created = await json(
    await rest('/items', { name, sku: `${name}-${crypto.randomUUID().slice(0, 6)}` }),
  );
  if (colors) {
    const res = await rest(`/products/${created.productId}/variants/generate`, {
      options: [{ name: 'Color', values: colors }],
      skuPattern: `${created.sku}-{color}`,
      mode: 'create',
    });
    expect(res.status).toBe(200);
  }
  const detail = await json(await rest(`/items/detail?productId=${created.productId}`));
  return {
    productId: created.productId as string,
    variantIds: (detail.item.variants as Array<{ id: string }>).map((v) => v.id),
  };
}

const events = (action: string) => t.sink.events.filter((e) => e.action === action);

describe('F11: pictures and attachments through the API', () => {
  it('uploads an image with derivatives, links it, orders it, and delivers it signed', async () => {
    const tee = await product('Tee', ['Black', 'White']);
    const [black, white] = tee.variantIds;
    const first = await uploadImage('front.png');
    const finalized = await rest(`/media/uploads/${first.intent.intentId}/finalize`, {
      productId: tee.productId,
      altText: 'Front of the tee',
    });
    expect(finalized.status).toBe(200);
    const done = await json(finalized);
    expect(done.media).toMatchObject({
      mediaId: first.intent.mediaId,
      kind: 'image',
      contentType: 'image/png',
      size: first.original.byteLength,
      sha256: sha256Hex(first.original),
      width: 2048,
      height: 1365,
      thumbnail: { contentType: 'image/webp', width: 320, height: 213 },
      display: { contentType: 'image/webp', width: 1600, height: 1067 },
    });
    // The first image of a scope becomes its primary picture.
    expect(done.links).toEqual([
      expect.objectContaining({ variantId: null, primary: true, role: 'primary', position: 0 }),
    ]);

    // A second picture, linked to the product and to the black variant as a swatch.
    const second = await uploadImage('back.png');
    await rest(`/media/uploads/${second.intent.intentId}/finalize`, {});
    const linked = await rest(`/media/${second.intent.mediaId}/links`, {
      productId: tee.productId,
      scope: 'both',
      variantIds: [black],
      role: 'Swatch',
    });
    expect(linked.status).toBe(200);
    expect((await json(linked)).links).toEqual([
      expect.objectContaining({ variantId: null, role: 'swatch', primary: false, position: 1 }),
      expect.objectContaining({ variantId: black, role: 'swatch', primary: true, position: 0 }),
    ]);
    // A PDF attachment on the product.
    const pdf = fakePdf();
    const manual = await startUpload(pdf, 'application/pdf', 'Care guide.pdf');
    expect(manual.uploads.map((u) => u.part)).toEqual(['original']);
    expect((await put(urlOf(manual, 'original'), pdf, 'application/pdf')).status).toBe(200);
    const attached = await json(
      await rest(`/media/uploads/${manual.intentId}/finalize`, {
        productId: tee.productId,
        role: 'care guide',
      }),
    );
    expect(attached.links[0]).toMatchObject({ role: 'care_guide', primary: false });
    expect(attached.media.thumbnail).toBeNull();

    // Reorder: the back first, then the front, then the guide.
    const order = [second.intent.mediaId, first.intent.mediaId, manual.mediaId];
    const reordered = await rest(`/products/${tee.productId}/media/order`, { order });
    expect(reordered.status).toBe(200);
    expect(
      (await rest(`/products/${tee.productId}/media/order`, { order: order.slice(1) })).status,
    ).toBe(400);
    // Make the back the product's primary picture; the front loses the flag.
    const updated = await rest(`/media/${second.intent.mediaId}/links/update`, {
      productId: tee.productId,
      primary: true,
      altText: 'Back of the tee',
    });
    expect((await json(updated)).link).toMatchObject({ primary: true, altText: 'Back of the tee' });

    t.sink.events.length = 0;
    const listed = await json(await rest(`/products/${tee.productId}/media`));
    expect(listed.product.links.map((l: { mediaId: string }) => l.mediaId)).toEqual(order);
    expect(listed.product.primaryMediaId).toBe(second.intent.mediaId);
    const byVariant = Object.fromEntries(
      listed.variants.map((v: { variantId: string }) => [v.variantId, v]),
    );
    // Black has its own primary; white inherits the product's.
    expect(byVariant[black!]).toMatchObject({
      primaryMediaId: second.intent.mediaId,
      primaryInherited: false,
      title: 'Black',
    });
    expect(byVariant[white!]).toMatchObject({
      primaryMediaId: second.intent.mediaId,
      primaryInherited: true,
      links: [],
    });
    expect(listed.media).toHaveLength(3);
    expect(listed.roles).toEqual(expect.arrayContaining(['primary', 'swatch', 'care_guide']));

    // Q1: one access event naming the media the list returned.
    const access = events('catalog.media.listed');
    expect(access).toHaveLength(1);
    expect((access[0]!.context as { mediaIds: string[] }).mediaIds.sort()).toEqual(
      [...order].sort(),
    );

    // Signed delivery: private cache, no event per image fetch.
    const front = listed.media.find((m: { mediaId: string }) => m.mediaId === first.intent.mediaId);
    const thumb = await t.app.request(
      new URL(front.thumbnail.url).pathname + new URL(front.thumbnail.url).search,
    );
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    expect(thumb.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/);
    expect(thumb.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await thumb.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(t.sink.events.filter((e) => e.action !== 'catalog.media.listed')).toEqual([]);
    // The original is not in the list; downloading it is its own operation and event.
    expect(JSON.stringify(listed)).not.toContain('/original?');
    const download = await json(await rest(`/media/${first.intent.mediaId}/original`));
    expect(events('catalog.media.original_downloaded')).toHaveLength(1);
    const file = await t.app.request(new URL(download.url).pathname + new URL(download.url).search);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toContain('attachment; filename="front.png"');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(first.original);

    // Gallery cards: primary picture per product and variant.
    const pictures = await json(
      await rest(`/media/primary?productIds=${tee.productId}&variantIds=${black},${white}`),
    );
    expect(pictures.pictures).toEqual([
      expect.objectContaining({ recordId: tee.productId, mediaId: second.intent.mediaId }),
      expect.objectContaining({
        recordId: black,
        mediaId: second.intent.mediaId,
        inherited: false,
      }),
      expect.objectContaining({ recordId: white, mediaId: second.intent.mediaId, inherited: true }),
    ]);
    expect(events('catalog.media.primary_viewed').at(-1)!.context).toMatchObject({
      mediaIds: [second.intent.mediaId],
    });

    // Removing the primary picture promotes the next image in that scope.
    const removed = await rest(`/media/${second.intent.mediaId}/links/remove`, {
      productId: tee.productId,
    });
    expect(removed.status).toBe(200);
    const after = await json(await rest(`/products/${tee.productId}/media`));
    expect(after.product.primaryMediaId).toBe(first.intent.mediaId);
    expect(after.variants.find((v: { variantId: string }) => v.variantId === black).links).toEqual(
      [],
    );
    // The file stays in the library, unlinked.
    const library = await json(await rest('/media?unlinked=true'));
    expect(library.media.map((m: { mediaId: string }) => m.mediaId)).toContain(
      second.intent.mediaId,
    );

    // Each change left an attributable event (F4: image reorder among them).
    for (const action of [
      'catalog.media.upload_started',
      'catalog.media.part_uploaded',
      'catalog.media.finalized',
      'catalog.media.linked',
      'catalog.media.reordered',
      'catalog.media.link_updated',
      'catalog.media.unlinked',
    ]) {
      const [row] = await ownerQuery<{ n: number }>(
        `select count(*)::int as n from audit_events where shop_id = $1 and action = $2
           and outcome = 'succeeded' and actor_type = 'api_credential'`,
        [shop.shopId, action],
      );
      expect(row!.n, action).toBeGreaterThan(0);
    }
  });

  it('refuses a wrong checksum and leaves no attachment', async () => {
    const bytes = fakePng(100, 100);
    const intent = await startUpload(bytes, 'image/png', 'bad.png');
    const tampered = bytes.slice();
    tampered[100] = tampered[100]! ^ 0xff;
    const res = await put(urlOf(intent, 'original'), tampered, 'image/png');
    expect(res.status).toBe(422);
    expect((await json(res)).code).toBe('checksum_mismatch');
    await expectFailed(intent, 'checksum_mismatch');
  });

  it('refuses a file whose content is not its declared type', async () => {
    const pdf = fakePdf();
    const intent = await startUpload(pdf, 'image/png', 'fake.png');
    const res = await put(urlOf(intent, 'original'), pdf, 'image/png');
    expect(res.status).toBe(422);
    expect((await json(res)).code).toBe('signature_mismatch');
    await expectFailed(intent, 'signature_mismatch');

    // An HTML page named like a JPEG is refused the same way.
    const page = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    const html = await startUpload(page, 'image/jpeg', 'x.jpg');
    expect((await json(await put(urlOf(html, 'original'), page, 'image/jpeg'))).code).toBe(
      'signature_mismatch',
    );
  });

  it('refuses oversize files, bodies longer than declared, and oversize derivatives', async () => {
    const big = await rest('/media/uploads', {
      fileName: 'huge.png',
      contentType: 'image/png',
      size: 20 * 1024 * 1024 + 1,
      sha256: 'a'.repeat(64),
    });
    expect(big.status).toBe(422);
    expect((await json(big)).code).toBe('file_too_large');
    const pdfLimit = await rest('/media/uploads', {
      fileName: 'manual.pdf',
      contentType: 'application/pdf',
      size: 50 * 1024 * 1024 + 1,
      sha256: 'a'.repeat(64),
    });
    expect((await json(pdfLimit)).code).toBe('file_too_large');

    const bytes = fakePng(100, 100);
    const intent = await startUpload(bytes, 'image/png', 'longer.png');
    const longer = new Uint8Array(bytes.byteLength + 10);
    longer.set(bytes);
    const res = await put(urlOf(intent, 'original'), longer, 'image/png');
    expect((await json(res)).code).toBe('size_mismatch');
    await expectFailed(intent, 'size_mismatch');

    const { intent: image } = await uploadImageWithout('display');
    const wide = await put(urlOf(image, 'display'), fakeWebp(2400, 1600), 'image/webp');
    expect(wide.status).toBe(422);
    expect((await json(wide)).code).toBe('derivative_too_large');
    await expectFailed(image, 'derivative_too_large');
  });

  it('accepts a JPEG derivative where the browser cannot make WebP, and refuses other types', async () => {
    const { intent } = await uploadImageWithout('display');
    // Sent without a Content-Length, as some HTTP/2 clients do: a derivative is read first.
    const noLength = await t.app.request(new URL(urlOf(intent, 'display')).pathname, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' },
      body: fakeJpeg(1600, 900),
    });
    expect(noLength.status).toBe(200);
    const done = await json(await rest(`/media/uploads/${intent.intentId}/finalize`, {}));
    expect(done.media.display).toMatchObject({ contentType: 'image/jpeg', width: 1600 });

    const { intent: png } = await uploadImageWithout('display');
    const wrong = await put(urlOf(png, 'display'), fakePng(1600, 900), 'image/png');
    expect(wrong.status).toBe(415);
    // Declared as WebP but a PNG inside.
    const lying = await put(urlOf(png, 'display'), fakePng(1600, 900), 'image/webp');
    expect((await json(lying)).code).toBe('signature_mismatch');
  });

  it('will not finalize before every part is uploaded', async () => {
    const original = fakePng(500, 500);
    const intent = await startUpload(original, 'image/png', 'partial.png');
    await put(urlOf(intent, 'original'), original, 'image/png');
    const res = await rest(`/media/uploads/${intent.intentId}/finalize`, {});
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({
      code: 'upload_incomplete',
      missing: ['thumbnail', 'display'],
    });
  });

  it('expires an unfinished upload: the sweep deletes its objects and nothing is attached', async () => {
    const { intent } = await uploadImage('abandoned.png');
    const keys = ['original', 'thumbnail', 'display'].map(
      (p) => `shops/${shop.shopId}/media/${intent.mediaId}/${p}`,
    );
    expect(keys.every((k) => store.objects.has(k))).toBe(true);
    await ownerQuery(
      `update media_upload_intents set expires_at = now() - interval '1 minute' where id = $1`,
      [intent.intentId],
    );
    const late = await rest(`/media/uploads/${intent.intentId}/finalize`, {});
    expect(late.status).toBe(409);
    expect((await json(late)).code).toBe('upload_expired');

    const swept = await sweepMediaUploads(t.db, (k) => store.delete(k));
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect(keys.some((k) => store.objects.has(k))).toBe(false);
    const [row] = await ownerQuery<{ status: string; cleaned: boolean }>(
      'select status, cleaned_at is not null as cleaned from media_upload_intents where id = $1',
      [intent.intentId],
    );
    expect(row).toEqual({ status: 'expired', cleaned: true });
    expect(
      await ownerQuery('select 1 from media_assets where id = $1', [intent.mediaId]),
    ).toHaveLength(0);
    const [event] = await ownerQuery<{ actor_type: string }>(
      `select actor_type from audit_events where action = 'catalog.media.upload_expired' and target_id = $1`,
      [intent.intentId],
    );
    expect(event?.actor_type).toBe('system');
    // Uploading to it now is refused too.
    expect((await put(urlOf(intent, 'original'), fakePng(10, 10), 'image/png')).status).toBe(409);
  });

  async function uploadImageWithout(part: 'display') {
    const original = fakePng(2000, 1000);
    const intent = await startUpload(original, 'image/png', `no-${part}.png`);
    expect((await put(urlOf(intent, 'original'), original, 'image/png')).status).toBe(200);
    expect((await put(urlOf(intent, 'thumbnail'), fakeWebp(320, 160), 'image/webp')).status).toBe(
      200,
    );
    return { intent };
  }

  async function expectFailed(intent: Intent, code: string) {
    const [row] = await ownerQuery<{ status: string; failure_code: string; cleaned: boolean }>(
      `select status, failure_code, cleaned_at is not null as cleaned
       from media_upload_intents where id = $1`,
      [intent.intentId],
    );
    expect(row).toEqual({ status: 'failed', failure_code: code, cleaned: true });
    expect([...store.objects.keys()].some((k) => k.includes(intent.mediaId))).toBe(false);
    const finalize = await rest(`/media/uploads/${intent.intentId}/finalize`, {});
    expect((await json(finalize)).code).toBe('upload_failed');
    expect(
      await ownerQuery('select 1 from media_assets where id = $1', [intent.mediaId]),
    ).toHaveLength(0);
    const [event] = await ownerQuery<{ error: { code: string } }>(
      `select error from audit_events where action = 'catalog.media.upload_failed' and target_id = $1`,
      [intent.intentId],
    );
    expect(event?.error.code).toBe(code);
  }
});

describe('A13: another shop’s media is unreachable', () => {
  it('refuses another shop’s intents, media, links, and signed URLs', async () => {
    const lamp = await product('Lamp');
    const { intent } = await uploadImage('lamp.png');
    await rest(`/media/uploads/${intent.intentId}/finalize`, { productId: lamp.productId });
    const theirs = client(other, otherToken);

    // Uploading to or finalizing this shop's intent from the other shop.
    const viaOtherShop = await t.app.request(
      `/api/v1/shops/${other.shopId}/media/uploads/${intent.intentId}/original`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${otherToken}`, 'content-length': '10' },
        body: new Uint8Array(10),
      },
    );
    expect(viaOtherShop.status).toBe(404);
    // A credential of the other shop on this shop's path.
    expect(
      (await put(urlOf(intent, 'original'), fakePng(1, 1), 'image/png', otherToken)).status,
    ).toBe(404);
    expect((await theirs(`/media/uploads/${intent.intentId}/finalize`, {})).status).toBe(404);

    // Reading, downloading, and linking this shop's media from the other shop.
    expect((await theirs(`/products/${lamp.productId}/media`)).status).toBe(404);
    expect((await theirs(`/media/${intent.mediaId}/original`)).status).toBe(404);
    const theirProduct = await json(await theirs('/items', { name: 'Theirs', sku: 'THEIRS-1' }));
    expect(
      (await theirs(`/media/${intent.mediaId}/links`, { productId: theirProduct.productId }))
        .status,
    ).toBe(404);
    expect(
      (await rest(`/media/${intent.mediaId}/links`, { productId: theirProduct.productId })).status,
    ).toBe(404);
    const found = await json(await theirs(`/media?mediaIds=${intent.mediaId}`));
    expect(found.media).toEqual([]);
    const pictures = await json(await theirs(`/media/primary?productIds=${lamp.productId}`));
    expect(pictures.pictures[0]).toMatchObject({ mediaId: null, thumbnail: null });

    // A signed link names its shop: moving it to the other shop breaks the signature.
    const listed = await json(await rest(`/products/${lamp.productId}/media`));
    const url = new URL(listed.media[0].thumbnail.url);
    const moved = url.pathname.replace(shop.shopId, other.shopId) + url.search;
    expect((await t.app.request(moved)).status).toBe(403);
    const otherPart = url.pathname.replace('/thumbnail', '/original') + url.search;
    expect((await t.app.request(otherPart)).status).toBe(403);
    const tampered = `${url.pathname}?exp=${url.searchParams.get('exp')}&sig=${'A'.repeat(43)}`;
    expect((await json(await t.app.request(tampered))).code).toBe('invalid_link');
  });

  it('refuses an expired signed link', async () => {
    const lamp = await product('Old lamp');
    const { intent } = await uploadImage('old.png');
    await rest(`/media/uploads/${intent.intentId}/finalize`, { productId: lamp.productId });
    const delivery = hmacMediaDelivery(KEY);
    const stale = await delivery.sign({
      shopId: shop.shopId,
      mediaId: intent.mediaId,
      part: 'thumbnail',
      ttlSeconds: 15 * 60,
      now: Date.now() - 60 * 60 * 1000,
    });
    const res = await t.app.request(stale.url);
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe('link_expired');
    const fresh = await delivery.sign({
      shopId: shop.shopId,
      mediaId: intent.mediaId,
      part: 'thumbnail',
      ttlSeconds: 15 * 60,
    });
    expect((await t.app.request(fresh.url)).status).toBe(200);
  });

  it('accepts only this shop’s media of the accepted kind in file fields', async () => {
    const field = await rest('/catalog/fields', {
      key: 'lifestyle_shots',
      label: 'Lifestyle shots',
      type: 'file',
      level: 'product',
      config: { accept: 'images' },
    });
    expect(field.status).toBe(201);
    const { intent } = await uploadImage('shot.png');
    await rest(`/media/uploads/${intent.intentId}/finalize`, {});
    const pdf = fakePdf();
    const doc = await startUpload(pdf, 'application/pdf', 'spec.pdf');
    await put(urlOf(doc, 'original'), pdf, 'application/pdf');
    await rest(`/media/uploads/${doc.intentId}/finalize`, {});

    const wrongKind = await rest('/items', {
      name: 'Vase',
      sku: 'VASE-1',
      fields: { lifestyle_shots: [doc.mediaId] },
    });
    expect(wrongKind.status).toBe(400);
    expect((await json(wrongKind)).errors[0].message).toContain('images only');

    const theirs = client(other, otherToken);
    const pdf2 = fakePdf();
    const theirsIntent = await json(
      await theirs('/media/uploads', {
        fileName: 'their.pdf',
        contentType: 'application/pdf',
        size: pdf2.byteLength,
        sha256: sha256Hex(pdf2),
      }),
    );
    await put(urlOf(theirsIntent as Intent, 'original'), pdf2, 'application/pdf', otherToken);
    await theirs(`/media/uploads/${theirsIntent.intentId}/finalize`, {});
    const otherShops = await rest('/items', {
      name: 'Vase',
      sku: 'VASE-2',
      fields: { lifestyle_shots: [theirsIntent.mediaId] },
    });
    expect(otherShops.status).toBe(400);
    expect((await json(otherShops)).errors[0].message).toContain('No media');

    const created = await rest('/items', {
      name: 'Vase',
      sku: 'VASE-3',
      fields: { lifestyle_shots: [intent.mediaId] },
    });
    expect(created.status).toBe(201);
    const item = await json(created);
    expect(item.item.product.fields.lifestyle_shots.value).toEqual([intent.mediaId]);
    const changed = await rest(`/items/${item.productId}/changes`, {
      changes: [{ field: 'lifestyle_shots', expected: [intent.mediaId], value: [doc.mediaId] }],
    });
    expect(changed.status).toBe(400);
  });
});

describe('manage_media over MCP', () => {
  it('lists, links, updates, reorders, and removes media, and cannot upload', async () => {
    const mcp = await mcpSession(t, shop, ['shop:read', 'catalog:read', 'catalog:write']);
    const call = (args: Record<string, unknown>) => mcp.call('manage_media', args);
    const { tools } = await mcp.client.listTools();
    const tool = tools.find((x) => x.name === 'manage_media')!;
    const actions = (tool.inputSchema.properties as { action: { enum: string[] } }).action.enum;
    expect(actions.sort()).toEqual([
      'download_original',
      'find',
      'link',
      'list',
      'primary_pictures',
      'remove',
      'reorder',
      'update_link',
    ]);

    const chair = await product('Chair', ['Oak', 'Walnut']);
    const a = await uploadImage('a.png');
    const b = await uploadImage('b.png');
    await rest(`/media/uploads/${a.intent.intentId}/finalize`, { productId: chair.productId });
    await rest(`/media/uploads/${b.intent.intentId}/finalize`, {});

    const linked = await call({
      action: 'link',
      mediaId: b.intent.mediaId,
      productId: chair.productId,
      scope: 'variants',
      variantIds: [chair.variantIds[1]],
      role: 'lifestyle',
    });
    expect(linked.error).toBe(false);
    expect(linked.body.links[0]).toMatchObject({ variantId: chair.variantIds[1], primary: true });
    const roled = await call({
      action: 'update_link',
      mediaId: a.intent.mediaId,
      productId: chair.productId,
      role: 'detail',
      altText: 'Chair, side view',
    });
    expect(roled.body.link).toMatchObject({ role: 'detail', altText: 'Chair, side view' });
    await call({ action: 'link', mediaId: b.intent.mediaId, productId: chair.productId });
    const reordered = await call({
      action: 'reorder',
      productId: chair.productId,
      order: [b.intent.mediaId, a.intent.mediaId],
    });
    expect(reordered.body.links.map((l: { mediaId: string }) => l.mediaId)).toEqual([
      b.intent.mediaId,
      a.intent.mediaId,
    ]);
    const listed = await call({ action: 'list', productId: chair.productId });
    expect(listed.body.product.links).toHaveLength(2);
    const primary = await call({ action: 'primary_pictures', variantIds: chair.variantIds });
    expect(primary.body.pictures.map((p: { inherited: boolean }) => p.inherited)).toEqual([
      true,
      false,
    ]);
    const removed = await call({
      action: 'remove',
      mediaId: b.intent.mediaId,
      productId: chair.productId,
      scope: 'variants',
    });
    expect(removed.body.links).toEqual([
      expect.objectContaining({ variantId: null, mediaId: b.intent.mediaId }),
    ]);
    const download = await call({ action: 'download_original', mediaId: a.intent.mediaId });
    expect(download.body.url).toContain('/original?exp=');
    const event = t.sink.events.at(-1)!;
    expect(event).toMatchObject({
      action: 'catalog.media.original_downloaded',
      source: 'mcp',
      actor_type: 'connection',
    });

    // A read-only connection cannot change links.
    const viewer = await mcpSession(t, shop, ['catalog:read']);
    const refused = await viewer.call('manage_media', {
      action: 'remove',
      mediaId: a.intent.mediaId,
      productId: chair.productId,
    });
    expect(refused.error).toBe(true);
    await viewer.close();
    await mcp.close();
  });

  it('keeps media off when no signing key is set', async () => {
    const off = await testApp({
      media: { store, hasher: nodeHasher, signingKey: null, publicUrl: '' },
    });
    try {
      const res = await off.app.request(`/api/v1/shops/${shop.shopId}/media/uploads`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          fileName: 'x.png',
          contentType: 'image/png',
          size: 10,
          sha256: 'a'.repeat(64),
        }),
      });
      expect(res.status).toBe(503);
      expect((await json(res)).code).toBe('media_unavailable');
    } finally {
      await off.close();
    }
  });
});

describe('D19: the largest original a shop keeps', () => {
  let limited: SeededShop;
  let send: ReturnType<typeof client>;
  let bearer: string;

  beforeAll(async () => {
    limited = await seedShop(t.db, t.sink, 'Original limit shop');
    bearer = (
      await apiToken(t, limited, ['shop:read', 'catalog:read', 'catalog:write'], limited.caller)
    ).token;
    send = client(limited, bearer);
  });

  async function begin(bytes: Uint8Array, contentType: string, fileName: string) {
    const res = await send('/media/uploads', {
      fileName,
      contentType,
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as Intent & {
      uploads: Array<{ part: string; maxSide: number | null }>;
    };
  }

  const setLimit = (mediaOriginalMaxSide: number | null, caller = limited.caller) =>
    execute({ db: t.db, audit: t.sink }, ops.updateShopSettings, {
      caller,
      shopId: limited.shopId,
      input: { mediaOriginalMaxSide },
      idempotencyKey: uuidv7(),
    });

  it('refuses an original above the shop’s limit, in every format it can read', async () => {
    const big = [
      [fakeJpeg(4032, 3024), 'image/jpeg', 'camera.jpg', 4032, 3024],
      [fakeCameraJpeg(3024, 4032), 'image/jpeg', 'exif.jpg', 3024, 4032],
      [fakePng(2049, 10), 'image/png', 'wide.png', 2049, 10],
      [fakeWebpLossy(3000, 2000), 'image/webp', 'lossy.webp', 3000, 2000],
      [fakeAvif(4096, 3072), 'image/avif', 'phone.avif', 4096, 3072],
    ] as const;
    for (const [bytes, type, name, width, height] of big) {
      const intent = await begin(bytes, type, name);
      // The limit is in the intent, so an API client knows it before sending the bytes.
      expect(intent.uploads.find((u) => u.part === 'original')?.maxSide).toBe(2048);
      const res = await put(urlOf(intent, 'original'), bytes, type, bearer);
      expect(res.status, name).toBe(422);
      expect(await json(res), name).toMatchObject({
        code: 'original_too_large',
        maxSide: 2048,
        width,
        height,
      });
      const [row] = await ownerQuery<{ status: string; failure_code: string }>(
        'select status, failure_code from media_upload_intents where id = $1',
        [intent.intentId],
      );
      expect(row).toEqual({ status: 'failed', failure_code: 'original_too_large' });
      expect([...store.objects.keys()].some((k) => k.includes(intent.mediaId))).toBe(false);
    }
  });

  it('accepts originals within the limit, GIFs, and PDFs as they are', async () => {
    const fine = [
      [fakeJpeg(2048, 1536), 'image/jpeg', 'edge.jpg'],
      [fakeAvif(2048, 2048), 'image/avif', 'square.avif'],
      [
        Uint8Array.from([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([0x00, 0x10, 0x00, 0x10])),
        'image/gif',
        'animated.gif',
      ],
      [fakePdf(), 'application/pdf', 'manual.pdf'],
    ] as const;
    for (const [bytes, type, name] of fine) {
      const intent = await begin(bytes, type, name);
      const original = intent.uploads.find((u) => u.part === 'original');
      expect(original?.maxSide, name).toBe(
        type.startsWith('image/') && type !== 'image/gif' ? 2048 : null,
      );
      expect((await put(urlOf(intent, 'original'), bytes, type, bearer)).status, name).toBe(200);
    }
  });

  it('follows the shop setting: managers change it, it is logged, and null keeps full size', async () => {
    const before = await execute({ db: t.db, audit: t.sink }, ops.getShopContext, {
      caller: limited.caller,
      shopId: limited.shopId,
      input: {},
    });
    expect(
      (before.result as { shop: { mediaOriginalMaxSide: number } }).shop.mediaOriginalMaxSide,
    ).toBe(2048);

    // Only shop.manage may change it; a catalog editor is refused.
    const [editor] = await ownerQuery<{ id: string }>(
      `insert into users (id, workos_user_id, email) values ($1, $2, $3) returning id`,
      [uuidv7(), `editor_${uuidv7()}`, `${uuidv7()}@example.test`],
    );
    await ownerQuery(
      `insert into memberships (shop_id, id, user_id, role) values ($1, $2, $3, 'catalog_editor')`,
      [limited.shopId, uuidv7(), editor!.id],
    );
    await expect(setLimit(4096, sessionCaller(editor!.id))).rejects.toMatchObject({ status: 403 });
    // Only the listed sizes.
    await expect(setLimit(3000)).rejects.toMatchObject({ code: 'validation_failed' });

    const changed = await setLimit(4096);
    expect(changed.result).toMatchObject({ mediaOriginalMaxSide: 4096 });
    const [event] = await ownerQuery<{ changes: unknown; actor_id: string }>(
      `select changes, actor_id from audit_events
       where shop_id = $1 and action = 'shop.settings.updated' and outcome = 'succeeded'`,
      [limited.shopId],
    );
    expect(event?.changes).toEqual({
      fields: { media_original_max_side: { from: 2048, to: 4096 } },
    });
    const photo = fakeJpeg(4032, 3024);
    const accepted = await begin(photo, 'image/jpeg', 'camera.jpg');
    expect(accepted.uploads.find((u) => u.part === 'original')?.maxSide).toBe(4096);
    expect((await put(urlOf(accepted, 'original'), photo, 'image/jpeg', bearer)).status).toBe(200);

    await setLimit(null);
    const huge = fakePng(9000, 6000);
    const full = await begin(huge, 'image/png', 'scan.png');
    expect(full.uploads.find((u) => u.part === 'original')?.maxSide).toBeNull();
    expect((await put(urlOf(full, 'original'), huge, 'image/png', bearer)).status).toBe(200);
    const after = await execute({ db: t.db, audit: t.sink }, ops.getShopContext, {
      caller: limited.caller,
      shopId: limited.shopId,
      input: {},
    });
    expect(
      (after.result as { shop: { mediaOriginalMaxSide: null } }).shop.mediaOriginalMaxSide,
    ).toBeNull();
  });
});
