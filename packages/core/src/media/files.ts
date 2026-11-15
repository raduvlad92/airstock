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

/**
 * Pixel size from an image's header, without decoding it. Null when the header is not in
 * `head` (a JPEG with a long EXIF block, say) or the type keeps it elsewhere (AVIF).
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
