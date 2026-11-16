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

const u16le = (n: number) => [n & 0xff, (n >>> 8) & 0xff];

/** An ISO base media box: size, type, and content. */
function box(type: string, ...content: Array<Uint8Array | number[]>): Uint8Array {
  const body = concat(...content);
  return concat(u32be(8 + body.byteLength), text(type), body);
}

/** A full box: version and flags before the content. */
function fullBox(
  type: string,
  version: number,
  flags: number,
  ...content: Array<Uint8Array | number[]>
): Uint8Array {
  return box(
    type,
    [version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff],
    ...content,
  );
}

const ispe = (width: number, height: number) => fullBox('ispe', 0, 0, u32be(width), u32be(height));

/**
 * An AVIF whose primary item (ID 1) is `width` × `height`. Like a camera's grid image, it also
 * has smaller tile items (ID 2 and 3) whose `ispe` comes first in `ipco`, so only the primary
 * item's association gives the right size.
 */
export function fakeAvif(width: number, height: number, padding = 256): Uint8Array {
  const tile = ispe(Math.ceil(width / 2), height);
  const ipco = box('ipco', tile, ispe(width, height));
  // Items 2 and 3 use property 1 (the tile size); item 1 uses property 2. Flags 0: 7-bit indices.
  const ipma = fullBox(
    'ipma',
    0,
    0,
    u32be(3),
    u16be(2),
    [1, 0x81],
    u16be(3),
    [1, 0x81],
    u16be(1),
    [1, 0x82],
  );
  const meta = fullBox(
    'meta',
    0,
    0,
    fullBox('hdlr', 0, 0, u32be(0), text('pict'), new Uint8Array(13)),
    fullBox('pitm', 0, 0, u16be(1)),
    box('iprp', ipco, ipma),
  );
  return concat(
    box('ftyp', text('avif'), u32be(0), text('mif1miafavif')),
    meta,
    box('mdat', randomBytes(padding)),
  );
}

/** Lossy WebP (VP8): a keyframe start code, then 14-bit width and height. */
export function fakeWebpLossy(width: number, height: number, padding = 256): Uint8Array {
  return concat(
    text('RIFF'),
    [0, 0, 0, 0],
    text('WEBP'),
    text('VP8 '),
    [0, 0, 0, 0],
    [0x30, 0x01, 0x00],
    [0x9d, 0x01, 0x2a],
    u16le(width),
    u16le(height),
    randomBytes(padding),
  );
}

/** A progressive JPEG (SOF2) with an EXIF block before its frame header, as cameras write. */
export function fakeCameraJpeg(width: number, height: number, exifBytes = 4096): Uint8Array {
  return concat(
    [0xff, 0xd8],
    [0xff, 0xe1],
    u16be(2 + exifBytes),
    text('Exif'),
    [0, 0],
    randomBytes(exifBytes - 6),
    [0xff, 0xc2],
    u16be(17),
    [8],
    u16be(height),
    u16be(width),
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    randomBytes(256),
  );
}
