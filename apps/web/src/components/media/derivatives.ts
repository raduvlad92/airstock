import {
  fitWithin,
  isMediaType,
  MEDIA_LIMITS,
  type MediaType,
  maxBytes,
  mediaKind,
  SIGNATURE_BYTES,
  sniffType,
} from '@airstock/core/media';

/**
 * Prepares a picked file for upload (D6): the real type from its bytes, its SHA-256, and for
 * images a 320 px thumbnail and a 1,600 px display image in WebP, made here so the server spends no
 * CPU on images. Browsers that cannot encode WebP (older Safari) send JPEG instead.
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
    const bitmap = await createImageBitmap(file);
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
): Promise<PreparedFile> {
  const head = new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer());
  let type = sniffType(head);
  let original: Blob = file;
  let fileName = file.name || 'file';

  if (!type && (HEIC.test(fileName) || /^image\/hei[cf]$/.test(file.type))) {
    // iPhone photos (R5): Safari decodes HEIC, so it can send a JPEG; other browsers cannot.
    const decoded = await imaging.decode(file).catch(() => null);
    if (!decoded) {
      throw new PrepareError(
        `${fileName}: this browser cannot read HEIC photos. Export it as JPEG, or use Safari.`,
      );
    }
    try {
      original = await imaging.encode(
        decoded.source,
        decoded.width,
        decoded.height,
        'image/jpeg',
        0.92,
      );
    } finally {
      decoded.close();
    }
    if (original.type !== 'image/jpeg') {
      throw new PrepareError(`${fileName}: this browser could not convert the photo to JPEG.`);
    }
    type = 'image/jpeg';
    fileName = fileName.replace(HEIC, '.jpg');
  }
  if (!type || !isMediaType(type)) {
    throw new PrepareError(`${fileName}: use a JPEG, PNG, WebP, AVIF, or GIF picture, or a PDF.`);
  }
  const limit = maxBytes(type);
  if (original.size > limit) {
    throw new PrepareError(`${fileName} is larger than ${limit / 1024 / 1024} MB.`);
  }
  if (original.size === 0) throw new PrepareError(`${fileName} is empty.`);

  let derivatives: PreparedFile['derivatives'] = null;
  if (mediaKind(type) === 'image') {
    const image = await imaging.decode(original).catch(() => null);
    if (!image) throw new PrepareError(`${fileName}: this browser cannot read the picture.`);
    try {
      derivatives = {
        thumbnail: await encodeDerivative(imaging, image, MEDIA_LIMITS.thumbnail.maxSide),
        display: await encodeDerivative(imaging, image, MEDIA_LIMITS.display.maxSide),
      };
    } finally {
      image.close();
    }
  }
  return { original, fileName, contentType: type, sha256: await sha256Hex(original), derivatives };
}
