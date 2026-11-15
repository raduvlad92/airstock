// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodeDerivative,
  type Imaging,
  PrepareError,
  prepareFile,
} from '../src/components/media/derivatives.ts';
import { MediaManager, mediaEntries } from '../src/components/media/MediaManager.tsx';

// Milestone N4: the browser-side derivative logic (D6) and the media manager.

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const bytes = (head: number[], size = 256) => {
  const out = new Uint8Array(size);
  out.set(head);
  return out;
};

/** Stands in for createImageBitmap and canvas; records what was encoded. */
function fakeImaging(
  width: number,
  height: number,
  opts: { webp?: boolean; decodes?: boolean } = {},
): Imaging & { calls: Array<{ width: number; height: number; type: string }> } {
  const calls: Array<{ width: number; height: number; type: string }> = [];
  return {
    calls,
    async decode() {
      if (opts.decodes === false) throw new Error('cannot decode');
      return { width, height, source: {}, close() {} };
    },
    async encode(_source, w, h, type) {
      calls.push({ width: w, height: h, type });
      // A browser without a WebP encoder answers with PNG.
      const actual = type === 'image/webp' && opts.webp === false ? 'image/png' : type;
      return new Blob([new Uint8Array(w)], { type: actual });
    },
  };
}

describe('derivatives made in the browser', () => {
  it('makes a 320 px thumbnail and a 1,600 px display image in WebP', async () => {
    const imaging = fakeImaging(4032, 3024);
    const file = new File([bytes(PNG)], 'photo.png', { type: 'image/png' });
    const prepared = await prepareFile(file, imaging);
    expect(prepared.contentType).toBe('image/png');
    expect(prepared.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(imaging.calls).toEqual([
      { width: 320, height: 240, type: 'image/webp' },
      { width: 1600, height: 1200, type: 'image/webp' },
    ]);
    expect(prepared.derivatives?.thumbnail.type).toBe('image/webp');
  });

  it('falls back to JPEG where the browser cannot encode WebP, and never enlarges', async () => {
    const imaging = fakeImaging(200, 100, { webp: false });
    const blob = await encodeDerivative(imaging, { width: 200, height: 100, source: {} }, 1600);
    expect(blob.type).toBe('image/jpeg');
    expect(imaging.calls.at(-1)).toEqual({ width: 200, height: 100, type: 'image/jpeg' });
  });

  it('uses the type the bytes show, not the file name', async () => {
    const file = new File([bytes(JPEG)], 'really-a-jpeg.png', { type: 'image/png' });
    expect((await prepareFile(file, fakeImaging(10, 10))).contentType).toBe('image/jpeg');
  });

  it('converts HEIC where the browser can read it, and asks for JPEG where it cannot', async () => {
    const heic = () =>
      new File(
        [bytes([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])],
        'IMG_1.HEIC',
        {
          type: 'image/heic',
        },
      );
    const safari = fakeImaging(4032, 3024);
    const converted = await prepareFile(heic(), safari);
    expect(converted).toMatchObject({ contentType: 'image/jpeg', fileName: 'IMG_1.jpg' });
    expect(safari.calls[0]).toEqual({ width: 4032, height: 3024, type: 'image/jpeg' });
    await expect(prepareFile(heic(), fakeImaging(1, 1, { decodes: false }))).rejects.toThrow(
      /cannot read HEIC/,
    );
  });

  it('sends PDFs as they are and refuses other files', async () => {
    const pdf = new File([bytes([0x25, 0x50, 0x44, 0x46, 0x2d])], 'spec.pdf', {
      type: 'application/pdf',
    });
    const imaging = fakeImaging(1, 1);
    expect((await prepareFile(pdf, imaging)).derivatives).toBeNull();
    expect(imaging.calls).toEqual([]);
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', {
      type: 'image/svg+xml',
    });
    await expect(prepareFile(svg, imaging)).rejects.toBeInstanceOf(PrepareError);
  });
});

const SHOP = '0196f3a0-0000-7000-8000-000000000001';
const PRODUCT = '0196f3a0-0000-7000-8000-000000000002';
const VARIANTS = ['0196f3a0-0000-7000-8000-0000000000a1', '0196f3a0-0000-7000-8000-0000000000a2'];
const MEDIA = ['0196f3a0-0000-7000-8000-0000000000b1', '0196f3a0-0000-7000-8000-0000000000b2'];

const link = (mediaId: string, position: number, extra: Record<string, unknown> = {}) => ({
  linkId: `${mediaId.slice(0, -2)}c${position}`,
  mediaId,
  productId: PRODUCT,
  variantId: null,
  role: 'detail',
  roleLabel: 'Detail',
  position,
  primary: false,
  altText: null,
  ...extra,
});

const mediaItem = (mediaId: string, fileName: string) => ({
  mediaId,
  kind: 'image',
  fileName,
  contentType: 'image/png',
  size: 2048,
  sha256: 'a'.repeat(64),
  width: 1000,
  height: 800,
  createdAt: '2026-11-15T10:00:00.000Z',
  thumbnail: {
    url: `/media/${SHOP}/${mediaId}/thumbnail?exp=1&sig=x`,
    contentType: 'image/webp',
    size: 100,
    width: 320,
    height: 256,
  },
  display: null,
});

const productMedia = {
  productId: PRODUCT,
  product: {
    primaryMediaId: MEDIA[0],
    links: [
      link(MEDIA[0]!, 0, {
        primary: true,
        role: 'primary',
        roleLabel: 'Primary',
        altText: 'Front',
      }),
      link(MEDIA[1]!, 1),
    ],
  },
  variants: [
    {
      variantId: VARIANTS[0],
      sku: 'TS-BLACK',
      title: 'Black',
      primaryMediaId: MEDIA[1],
      primaryInherited: false,
      links: [link(MEDIA[1]!, 0, { variantId: VARIANTS[0], primary: true })],
    },
    {
      variantId: VARIANTS[1],
      sku: 'TS-WHITE',
      title: 'White',
      primaryMediaId: MEDIA[0],
      primaryInherited: true,
      links: [],
    },
  ],
  media: [mediaItem(MEDIA[0]!, 'front.png'), mediaItem(MEDIA[1]!, 'back.png')],
  roles: ['primary', 'lifestyle', 'detail'],
  limits: { mediaPerProduct: 50, imageBytes: 20971520, documentBytes: 52428800 },
};

function mockApi() {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname.replace('/api/v1', '');
      calls.push({
        path,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (path === `/shops/${SHOP}`) {
        return Response.json({
          shop: { id: SHOP, name: 'Shop', currency: 'EUR', timezone: 'Europe/Berlin' },
          role: 'owner',
          permissions: ['catalog.read', 'catalog.write'],
        });
      }
      if (path === `/shops/${SHOP}/products/${PRODUCT}/media`) return Response.json(productMedia);
      return Response.json({ links: [] });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('media manager', () => {
  it('orders product pictures first, then files only some variants show', () => {
    const entries = mediaEntries(productMedia as never);
    expect(entries.map((e) => e.media.fileName)).toEqual(['front.png', 'back.png']);
    expect(entries[1]!.variantLinks.map((l) => l.variantId)).toEqual([VARIANTS[0]]);
  });

  it('shows thumbnails and the primary picture, and reorders and links variants', async () => {
    const calls = mockApi();
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MediaManager shopId={SHOP} productId={PRODUCT} />
      </QueryClientProvider>,
    );
    const front = await screen.findByAltText('Front');
    expect(front.getAttribute('src')).toBe(productMedia.media[0]!.thumbnail.url);
    expect(screen.getByText('Primary')).toBeTruthy();
    expect(await screen.findByLabelText('Choose files')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Move front.png down' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/media/order'))?.body).toEqual({
        order: [MEDIA[1], MEDIA[0]],
      }),
    );

    // The white variant gets the back picture as its own.
    const white = screen.getAllByLabelText('White')[1]!;
    fireEvent.click(white);
    await waitFor(() =>
      expect(calls.find((c) => c.path === `/shops/${SHOP}/media/${MEDIA[1]}/links`)?.body).toEqual({
        productId: PRODUCT,
        scope: 'variants',
        variantIds: [VARIANTS[1]],
      }),
    );
  });
});
