/**
 * What media Airstock accepts and how a file is recognised (plan Section 5.8, ADR 0015). Pure
 * functions with no dependencies, so the dashboard runs the same checks before it uploads.
 */

export const IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
] as const;
export const DOCUMENT_TYPES = ['application/pdf'] as const;
export const MEDIA_TYPES = [...IMAGE_TYPES, ...DOCUMENT_TYPES] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export type MediaKind = 'image' | 'document';

/** The browser makes these; the server checks their signature, bytes, and pixel size (D6). */
export const DERIVATIVE_TYPES = ['image/webp', 'image/jpeg'] as const;
export type DerivativeType = (typeof DERIVATIVE_TYPES)[number];

export const UPLOAD_PARTS = ['original', 'thumbnail', 'display'] as const;
export type UploadPart = (typeof UPLOAD_PARTS)[number];
export type DerivativePart = Exclude<UploadPart, 'original'>;

export const MEDIA_LIMITS = {
  imageBytes: 20 * 1024 * 1024,
  documentBytes: 50 * 1024 * 1024,
  mediaPerProduct: 50,
  /** Longest side in pixels and largest file of each derivative. */
  thumbnail: { maxSide: 320, maxBytes: 1024 * 1024 },
  display: { maxSide: 1600, maxBytes: 5 * 1024 * 1024 },
  /** Upload intents and signed delivery links. */
  intentSeconds: 15 * 60,
  linkSeconds: 15 * 60,
  originalLinkSeconds: 5 * 60,
  altTextLength: 1000,
} as const;

/**
 * The longest side a shop may keep for an image original, in pixels (plan D19). The dashboard
 * shrinks larger pictures before uploading them, and the upload refuses a larger original from
 * any client. A shop can also keep full size (null).
 */
export const ORIGINAL_MAX_SIDES = [1024, 2048, 4096] as const;
export type OriginalMaxSide = (typeof ORIGINAL_MAX_SIDES)[number];
export const DEFAULT_ORIGINAL_MAX_SIDE: OriginalMaxSide = 2048;

/**
 * Whether the shop's original limit applies to a type: every image except GIF, which may be
 * animated and is kept as it is.
 */
export function originalLimitApplies(type: MediaType): boolean {
  return mediaKind(type) === 'image' && type !== 'image/gif';
}

/** Suggested roles (PRD 4.5); merchants can use any other. */
export const STARTER_ROLES = [
  'primary',
  'lifestyle',
  'detail',
  'packaging',
  'dimension_diagram',
  'swatch',
] as const;

export function mediaKind(type: MediaType): MediaKind {
  return (DOCUMENT_TYPES as readonly string[]).includes(type) ? 'document' : 'image';
}

export function isMediaType(value: string): value is MediaType {
  return (MEDIA_TYPES as readonly string[]).includes(value);
}

export function maxBytes(type: MediaType): number {
  return mediaKind(type) === 'image' ? MEDIA_LIMITS.imageBytes : MEDIA_LIMITS.documentBytes;
}

/** "Dimension diagram" → "dimension_diagram"; null when nothing usable is left. */
export function normalizeRole(input: string): string | null {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 50);
  return /^[a-z][a-z0-9_]{0,49}$/.test(slug) ? slug : null;
}

/** "dimension_diagram" → "Dimension diagram". */
export function roleLabel(role: string): string {
  const text = role.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Bytes needed to recognise any accepted type. */
export const SIGNATURE_BYTES = 32;

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  bytes.length >= at + text.length && [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));

/**
 * The type a file's first bytes show (its magic number), whatever it claims to be. Null for
 * anything not accepted, including HEIC, SVG, and HTML.
 */
export function sniffType(head: Uint8Array): MediaType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return 'image/jpeg';
  if (
    head.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)
  )
    return 'image/png';
  if (ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a')) return 'image/gif';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return 'image/webp';
  if (ascii(head, 4, 'ftyp')) {
    // ISO base media file: the major brand, then compatible brands, name AVIF.
    const size = readU32(head, 0);
    const end = Math.min(head.length, size >= 16 ? size : 32);
    for (let at = 8; at + 4 <= end; at += 4) {
      if (at === 12) continue; // the minor version, not a brand
      if (ascii(head, at, 'avif') || ascii(head, at, 'avis')) return 'image/avif';
    }
    return null;
  }
  if (ascii(head, 0, '%PDF-')) return 'application/pdf';
  return null;
}

function readU32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);

interface Box {
  type: string;
  /** Where the box's content starts, after its header. */
  start: number;
  end: number;
}

/** The ISO base media boxes between `from` and `to`; the last may run past the bytes given. */
function boxesIn(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= Math.min(to, b.length)) {
    let size = readU32(b, at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > b.length) break;
      size = readU32(b, at + 8) * 2 ** 32 + readU32(b, at + 12);
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header) break;
    const type = String.fromCharCode(b[at + 4]!, b[at + 5]!, b[at + 6]!, b[at + 7]!);
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

/**
 * An AVIF's size from the `ispe` property of its primary item: `meta` names the item (`pitm`),
 * `ipma` lists its properties, and `ipco` holds them. Null when any of these is missing or not in
 * `head`, rather than a guess.
 */
function avifSize(head: Uint8Array): { width: number; height: number } | null {
  const complete = (box: Box | undefined): box is Box => !!box && box.end <= head.length;
  const meta = boxesIn(head, 0, head.length).find((x) => x.type === 'meta');
  if (!complete(meta)) return null;
  // meta, pitm, ipma, and ispe are full boxes: one byte of version and three of flags first.
  const inMeta = boxesIn(head, meta.start + 4, meta.end);
  const pitm = inMeta.find((x) => x.type === 'pitm');
  const iprp = inMeta.find((x) => x.type === 'iprp');
  if (!complete(pitm) || !complete(iprp)) return null;
  const primary =
    head[pitm.start] === 0 ? u16be(head, pitm.start + 4) : readU32(head, pitm.start + 4);
  const inIprp = boxesIn(head, iprp.start, iprp.end);
  const ipco = inIprp.find((x) => x.type === 'ipco');
  if (!complete(ipco)) return null;
  const properties = boxesIn(head, ipco.start, ipco.end);
  for (const ipma of inIprp.filter((x) => x.type === 'ipma' && x.end <= head.length)) {
    const version = head[ipma.start]!;
    const wideIndex = (head[ipma.start + 3]! & 1) === 1;
    let at = ipma.start + 8;
    const entries = readU32(head, ipma.start + 4);
    for (let e = 0; e < entries && at < ipma.end; e++) {
      const item = version < 1 ? u16be(head, at) : readU32(head, at);
      at += version < 1 ? 2 : 4;
      const count = head[at]!;
      at += 1;
      for (let i = 0; i < count; i++) {
        const index = wideIndex ? u16be(head, at) & 0x7fff : head[at]! & 0x7f;
        at += wideIndex ? 2 : 1;
        const property = properties[index - 1];
        if (item === primary && property?.type === 'ispe' && property.start + 12 <= head.length) {
          const width = readU32(head, property.start + 4);
          const height = readU32(head, property.start + 8);
          return width > 0 && height > 0 ? { width, height } : null;
        }
      }
    }
  }
  return null;
}

/**
 * Pixel size from an image's header, without decoding it: JPEG start of frame, PNG IHDR, WebP
 * VP8, VP8L, or VP8X, GIF screen size, and AVIF `ispe`. Null when the header is not in `head` (a
 * JPEG with a long EXIF block, say) or cannot be read simply.
 */
export function imageSize(
  head: Uint8Array,
  type: MediaType,
): { width: number; height: number } | null {
  const size = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : null;
  switch (type) {
    case 'image/png':
      // The IHDR chunk always comes first.
      return head.length >= 24 && ascii(head, 12, 'IHDR')
        ? size(readU32(head, 16), readU32(head, 20))
        : null;
    case 'image/gif':
      return head.length >= 10 ? size(u16le(head, 6), u16le(head, 8)) : null;
    case 'image/webp': {
      if (head.length < 30) return null;
      if (ascii(head, 12, 'VP8X')) return size(u24le(head, 24) + 1, u24le(head, 27) + 1);
      if (ascii(head, 12, 'VP8L')) {
        if (head[20] !== 0x2f) return null;
        const bits = head[21]! | (head[22]! << 8) | (head[23]! << 16) | (head[24]! << 24);
        return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (ascii(head, 12, 'VP8 ')) {
        // A keyframe starts with the start code 9d 01 2a.
        if (head[23] !== 0x9d || head[24] !== 0x01 || head[25] !== 0x2a) return null;
        return size(u16le(head, 26) & 0x3fff, u16le(head, 28) & 0x3fff);
      }
      return null;
    }
    case 'image/jpeg': {
      let at = 2;
      while (at + 9 < head.length) {
        if (head[at] !== 0xff) return null;
        const marker = head[at + 1]!;
        if (marker === 0xff) {
          at++;
          continue;
        }
        // Start-of-frame markers carry the size; C4 (DHT), C8, and CC are not frames.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return size(u16be(head, at + 7), u16be(head, at + 5));
        if (marker === 0xd9 || marker === 0xda) return null;
        at += 2 + u16be(head, at + 2);
      }
      return null;
    }
    case 'image/avif':
      return avifSize(head);
    default:
      return null;
  }
}

/** Width and height scaled so the longest side is at most `maxSide`, never enlarged. */
export function fitWithin(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
