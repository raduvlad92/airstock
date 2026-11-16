import {
  fitWithin,
  isMediaType,
  MEDIA_LIMITS,
  type MediaType,
  maxBytes,
  mediaKind,
  originalLimitApplies,
  SIGNATURE_BYTES,
  sniffType,
} from '@airstock/core/media';

/**
 * Prepares a picked file for upload (D6): the real type from its bytes, its SHA-256, and for
 * images a 320 px thumbnail and a 1,600 px display image in WebP, made here so the server spends no
 * CPU on images. Browsers that cannot encode WebP (older Safari) send JPEG instead. A picture
 * larger than the shop keeps is shrunk before it is hashed (D19).
 */

/** A file that cannot be uploaded, with a message for the person who picked it. */
export class PrepareError extends Error {
  override name = 'PrepareError';
}

/** Decoding and encoding, behind an interface so tests can stand in for canvas. */
export interface Imaging {
  decode(file: Blob): Promise<{ width: number; height: number; source: unknown; close(): void }>;
  encode(
    source: unknown,
    width: number,
    height: number,
    type: string,
    quality: number,
  ): Promise<Blob>;
}

export const browserImaging: Imaging = {
  async decode(file) {
    // Turned upright by its EXIF orientation, so a re-encoded original keeps the right way up.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      close: () => bitmap.close(),
    };
  },
  encode(source, width, height, type, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return Promise.reject(new PrepareError('This browser cannot resize pictures.'));
    context.imageSmoothingQuality = 'high';
    context.drawImage(source as CanvasImageSource, 0, 0, width, height);
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new PrepareError('The picture could not be resized.')),
        type,
        quality,
      ),
    );
  },
};

export interface PreparedFile {
  original: Blob;
  fileName: string;
  contentType: MediaType;
  sha256: string;
  derivatives: { thumbnail: Blob; display: Blob } | null;
}

export const ACCEPT =
  'image/jpeg,image/png,image/webp,image/avif,image/gif,image/heic,image/heif,application/pdf';

const HEIC = /\.(heic|heif)$/i;
const EXTENSION = /\.[A-Za-z0-9]{1,5}$/;

/** How to re-encode an original before upload; null sends the file as it is. */
export interface OriginalPlan {
  width: number;
  height: number;
  type: 'image/jpeg' | 'image/png' | 'image/webp';
  quality: number;
}

/**
 * Whether an original must shrink to the shop's limit (D19), and to what. JPEG stays JPEG, PNG
 * stays PNG, and WebP stays WebP; AVIF becomes WebP, which canvases can encode. GIFs (perhaps
 * animated), documents, pictures within the limit, and shops that keep full size (null) send the
 * file untouched. Re-encoding drops the file's metadata, GPS included.
 */
export function planOriginal(
  type: MediaType,
  width: number,
  height: number,
  maxSide: number | null,
): OriginalPlan | null {
  if (maxSide === null || !originalLimitApplies(type)) return null;
  if (Math.max(width, height) <= maxSide) return null;
  const target = type === 'image/jpeg' || type === 'image/png' ? type : 'image/webp';
  return { ...fitWithin(width, height, maxSide), type: target, quality: 0.9 };
}

/** Encodes a shrunk original; a browser that cannot encode WebP sends JPEG instead. */
async function encodeOriginal(imaging: Imaging, source: unknown, plan: OriginalPlan) {
  const blob = await imaging.encode(source, plan.width, plan.height, plan.type, plan.quality);
  if (blob.type === plan.type) return blob;
  const jpeg = await imaging.encode(source, plan.width, plan.height, 'image/jpeg', plan.quality);
  if (jpeg.type !== 'image/jpeg') {
    throw new PrepareError('This browser could not shrink the picture.');
  }
  return jpeg;
}

const EXTENSIONS: Record<OriginalPlan['type'], string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

function renamed(fileName: string, from: MediaType, to: MediaType): string {
  if (from === to) return fileName;
  const ext = EXTENSIONS[to as OriginalPlan['type']] ?? '';
  return EXTENSION.test(fileName) ? fileName.replace(EXTENSION, ext) : `${fileName}${ext}`;
}

export interface PrepareOptions {
  /** The shop's limit on an original's longest side (D19); null keeps full size. */
  originalMaxSide?: number | null;
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Encodes one derivative, preferring WebP and falling back to JPEG. */
export async function encodeDerivative(
  imaging: Imaging,
  image: { width: number; height: number; source: unknown },
  maxSide: number,
): Promise<Blob> {
  const size = fitWithin(image.width, image.height, maxSide);
  const webp = await imaging.encode(image.source, size.width, size.height, 'image/webp', 0.82);
  if (webp.type === 'image/webp') return webp;
  // A browser that cannot encode WebP returns PNG instead, which the server does not take.
  return imaging.encode(image.source, size.width, size.height, 'image/jpeg', 0.85);
}

export async function prepareFile(
  file: File,
  imaging: Imaging = browserImaging,
  options: PrepareOptions = {},
): Promise<PreparedFile> {
  const maxSide = options.originalMaxSide ?? null;
  const head = new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer());
  const sniffed = sniffType(head);
  const fileName = file.name || 'file';
  const heic = !sniffed && (HEIC.test(fileName) || /^image\/hei[cf]$/.test(file.type));
  if (!heic && (!sniffed || !isMediaType(sniffed))) {
    throw new PrepareError(`${fileName}: use a JPEG, PNG, WebP, AVIF, or GIF picture, or a PDF.`);
  }
  if (!heic && mediaKind(sniffed!) === 'document') {
    checkBytes(file, sniffed!, fileName);
    return {
      original: file,
      fileName,
      contentType: sniffed!,
      sha256: await sha256Hex(file),
      derivatives: null,
    };
  }

  const image = await imaging.decode(file).catch(() => null);
  if (!image) {
    // iPhone photos (R5): Safari decodes HEIC, so it can send a JPEG; other browsers cannot.
    throw new PrepareError(
      heic
        ? `${fileName}: this browser cannot read HEIC photos. Export it as JPEG, or use Safari.`
        : `${fileName}: this browser cannot read the picture.`,
    );
  }
  try {
    let original: Blob = file;
    let type: MediaType = sniffed ?? 'image/jpeg';
    let name = fileName;
    // The original's size after any shrinking; derivatives are never larger than it.
    let size = { width: image.width, height: image.height };
    if (heic) {
      const plan = planOriginal('image/jpeg', image.width, image.height, maxSide);
      size = plan ?? size;
      original = await imaging.encode(image.source, size.width, size.height, 'image/jpeg', 0.92);
      if (original.type !== 'image/jpeg') {
        throw new PrepareError(`${fileName}: this browser could not convert the photo to JPEG.`);
      }
      name = fileName.replace(HEIC, '.jpg');
    } else {
      const plan = planOriginal(type, image.width, image.height, maxSide);
      if (plan) {
        original = await encodeOriginal(imaging, image.source, plan);
        name = renamed(fileName, type, original.type as MediaType);
        type = original.type as MediaType;
        size = plan;
      }
    }
    checkBytes(original, type, name);
    const scaled = { ...size, source: image.source };
    const derivatives = {
      thumbnail: await encodeDerivative(imaging, scaled, MEDIA_LIMITS.thumbnail.maxSide),
      display: await encodeDerivative(imaging, scaled, MEDIA_LIMITS.display.maxSide),
    };
    return {
      original,
      fileName: name,
      contentType: type,
      sha256: await sha256Hex(original),
      derivatives,
    };
  } finally {
    image.close();
  }
}

function checkBytes(blob: Blob, type: MediaType, fileName: string): void {
  const limit = maxBytes(type);
  if (blob.size > limit) {
    throw new PrepareError(`${fileName} is larger than ${limit / 1024 / 1024} MB.`);
  }
  if (blob.size === 0) throw new PrepareError(`${fileName} is empty.`);
}
