import { createHash, randomBytes } from 'node:crypto';

// Files whose headers are real and whose bodies are random: the server checks signatures and
// reads pixel sizes from headers, but never decodes an image.

function concat(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.byteLength, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.byteLength;
  }
  return out;
}

const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u24le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const u16be = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function fakePng(width: number, height: number, padding = 256): Uint8Array {
  return concat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    u32be(13),
    text('IHDR'),
    u32be(width),
    u32be(height),
    [8, 6, 0, 0, 0],
    randomBytes(padding),
  );
}

export function fakeWebp(width: number, height: number, padding = 256): Uint8Array {
  return concat(
    text('RIFF'),
    [0, 0, 0, 0],
    text('WEBP'),
    text('VP8X'),
    [10, 0, 0, 0],
    [0, 0, 0, 0],
    u24le(width - 1),
    u24le(height - 1),
    randomBytes(padding),
  );
}

export function fakeJpeg(width: number, height: number, padding = 256): Uint8Array {
  return concat(
    [0xff, 0xd8, 0xff, 0xe0],
    u16be(16),
    text('JFIF'),
    [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, 0xc0],
    u16be(17),
    [8],
    u16be(height),
    u16be(width),
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    randomBytes(padding),
  );
}

export function fakePdf(padding = 512): Uint8Array {
  return concat(text('%PDF-1.7\n'), randomBytes(padding));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
