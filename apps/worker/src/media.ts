import {
  AppError,
  auditEvent,
  errors,
  failUpload,
  hmacMediaDelivery,
  type MediaDelivery,
  markUploadsCleaned,
  mediaFiles,
  type OpenUpload,
  objectKey,
  openUpload,
  recordUploadPart,
  uploadRejected,
  verifyMediaLink,
} from '@airstock/core';
import type { Context, Hono } from 'hono';
import { type AppDeps, type AppEnv, problem } from './app.ts';

// Media upload and delivery on the Worker (plan Section 5.8, ADR 0015). Upload bodies stream
// straight into R2 while their SHA-256 is computed and their first bytes are checked; delivery
// serves signed links from R2. Storage and hashing are interfaces so Node tests run in memory.

const { DERIVATIVE_TYPES, imageSize, sniffType, SIGNATURE_BYTES, UPLOAD_PARTS } = mediaFiles;
type MediaType = mediaFiles.MediaType;
type UploadPart = mediaFiles.UploadPart;

export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  size: number;
  contentType: string;
  contentDisposition: string | null;
}

/** Private object storage for media: the EU R2 bucket in the Worker. */
export interface MediaStore {
  /** Stores exactly `size` bytes, or fails; with `sha256`, also fails when the hash differs. */
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    meta: { size: number; contentType: string; sha256?: string; contentDisposition?: string },
  ): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(keys: string[]): Promise<void>;
}

/**
 * SHA-256 fed chunk by chunk as the body passes: crypto.DigestStream in Workers, node:crypto in
 * tests. Hashing inside the stream keeps backpressure from storage, so a body is never buffered.
 */
export interface StreamHasher {
  write(chunk: Uint8Array): void | Promise<void>;
  digest(): Promise<ArrayBuffer>;
}

export interface MediaConfig {
  store: MediaStore;
  hasher(): StreamHasher;
  /** MEDIA_SIGNING_KEY; without it no links are signed and uploads are refused. */
  signingKey: string | null;
  /** Origin for absolute links, such as https://airstock.deletecookies.dev. */
  publicUrl: string;
}

const deliveries = new WeakMap<MediaConfig, MediaDelivery>();

/** The link signer handed to operations, or undefined when media delivery is off. */
export function mediaDelivery(deps: Pick<AppDeps, 'media'>): MediaDelivery | undefined {
  const config = deps.media;
  if (!config?.signingKey) return undefined;
  let delivery = deliveries.get(config);
  if (!delivery) {
    delivery = hmacMediaDelivery(config.signingKey, config.publicUrl);
    deliveries.set(config, delivery);
  }
  return delivery;
}

export function r2MediaStore(bucket: R2Bucket): MediaStore {
  return {
    async put(key, body, meta) {
      // R2 needs the length of a streamed body up front; the stream also fails on any other length.
      const fixed = new FixedLengthStream(meta.size);
      const piping = body.pipeTo(fixed.writable);
      const putting = bucket.put(key, fixed.readable, {
        httpMetadata: {
          contentType: meta.contentType,
          ...(meta.contentDisposition ? { contentDisposition: meta.contentDisposition } : {}),
        },
        ...(meta.sha256 ? { sha256: meta.sha256 } : {}),
      });
      const [pipe, put] = await Promise.allSettled([piping, putting]);
      if (pipe.status === 'rejected') throw pipe.reason;
      if (put.status === 'rejected') throw put.reason;
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return {
        body: object.body,
        size: object.size,
        contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
        contentDisposition: object.httpMetadata?.contentDisposition ?? null,
      };
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    },
  };
}

export function digestStreamHasher(): StreamHasher {
  const stream = new crypto.DigestStream('SHA-256');
  const writer = stream.getWriter();
  return {
    // A copy: the same chunk goes on to R2, whatever the digest stream does with what it is given.
    write: (chunk) => writer.write(chunk.slice()),
    async digest() {
      await writer.close();
      return stream.digest;
    },
  };
}

/** Reads a small body whose length was not sent, refusing it past `max` bytes. */
async function readAtMost(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw uploadRejected('file_too_large', `At most ${max} bytes.`, { maxBytes: max });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

/** Bytes kept from the start of a file: the signature and, for most images, the pixel size. */
const HEAD_BYTES = 256 * 1024;

const UPLOAD_PATH =
  /^\/api\/v1\/shops\/[^/]+\/media\/uploads\/[^/]+\/(original|thumbnail|display)$/;

/** Upload bodies stream past the app's 1 MB body limit; their own limits apply instead. */
export function isUploadRequest(method: string, path: string): boolean {
  return method === 'PUT' && UPLOAD_PATH.test(path);
}

/**
 * Counts bytes, keeps the head, and checks the signature as the body passes. A failure errors the
 * stream, so storage never completes the object.
 */
function inspector(upload: OpenUpload, accept: readonly MediaType[], hasher: StreamHasher) {
  let size = 0;
  let finished = false;
  let headLength = 0;
  const chunks: Uint8Array[] = [];
  let type: MediaType | null = null;
  let failure: AppError | null = null;
  const head = () => {
    const out = new Uint8Array(headLength);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  };
  const fail = (error: AppError): never => {
    failure = error;
    throw error;
  };
  const check = () => {
    const found = sniffType(head());
    if (!found || !accept.includes(found)) {
      fail(
        upload.part === 'original'
          ? uploadRejected(
              'signature_mismatch',
              `The file's content is not ${upload.contentType}. Check the file and its type.`,
            )
          : uploadRejected(
              'signature_mismatch',
              `The ${upload.part} image's content is not ${accept[0]}.`,
            ),
      );
    }
    type = found;
  };
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > upload.maxBytes) {
        fail(
          upload.part === 'original'
            ? uploadRejected('size_mismatch', 'The file is larger than declared.', {
                declared: upload.declaredSize,
              })
            : uploadRejected('file_too_large', `At most ${upload.maxBytes} bytes.`, {
                maxBytes: upload.maxBytes,
              }),
        );
      }
      if (headLength < HEAD_BYTES) {
        const piece = chunk.slice(0, HEAD_BYTES - headLength);
        chunks.push(piece);
        headLength += piece.byteLength;
      }
      if (type === null && headLength >= SIGNATURE_BYTES) check();
      await hasher.write(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      if (type === null) check();
      finished = true;
    },
  });
  return {
    stream,
    get failure() {
      return failure;
    },
    /** True once the whole body passed. */
    get finished() {
      return finished;
    },
    result: () => ({ size, type: type as MediaType | null, head: head() }),
  };
}

function contentDisposition(kind: 'attachment' | 'inline', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function mountMedia(app: Hono<AppEnv>, deps: AppDeps): void {
  app.put('/api/v1/shops/:shopId/media/uploads/:intentId/:part', (c) => receivePart(c, deps));
  app.get('/media/:shopId/:mediaId/:part', (c) => serveSigned(c, deps));
}

async function receivePart(c: Context<AppEnv>, deps: AppDeps): Promise<Response> {
  const requestId = c.get('requestId');
  const config = deps.media;
  if (!config || !mediaDelivery(deps)) {
    return problem(
      new AppError(
        503,
        'media_unavailable',
        'Media storage is not set up on this server.',
        'failed',
      ),
      requestId,
    );
  }
  const caller = c.get('caller');
  const db = c.get('db');
  const { shopId, intentId, part } = c.req.param() as Record<string, string>;
  let upload: OpenUpload;
  try {
    upload = await openUpload(db, caller, shopId!, intentId!, part!);
  } catch (error) {
    // Like the pipeline: a refused attempt by a known caller is still recorded.
    const appError = error instanceof AppError ? error : errors.internal();
    await c
      .get('audit')
      .send([
        auditEvent(
          {
            shopId: /^[0-9a-f-]{36}$/.test(shopId ?? '') ? shopId! : null,
            caller,
            requestId,
            attemptId: null,
            idempotencyKey: null,
          },
          {
            action: 'catalog.media.part_uploaded',
            phase: 'outcome',
            outcome: appError.outcome,
            target_type: 'media_upload',
            target_id: intentId ?? null,
            error: { code: appError.code, status: appError.status },
          },
        ),
      ])
      .catch((sendError) =>
        deps.logger.error('audit_failure_event_not_recorded', {
          requestId,
          error: String(sendError),
        }),
      );
    if (error instanceof AppError) return problem(error, requestId);
    throw error;
  }

  // Protocol mistakes are answered without failing the upload; the client can send again.
  const lengthHeader = c.req.header('content-length');
  const length = lengthHeader === undefined ? null : Number(lengthHeader);
  const body = c.req.raw.body;
  if (!body || length === 0) {
    return problem(errors.validation([{ path: 'body', message: 'Send the file.' }]), requestId);
  }
  // The original's type was declared; a derivative names its own, which its bytes must match.
  const declaredType = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const partType: MediaType | null =
    upload.part === 'original'
      ? upload.contentType
      : (DERIVATIVE_TYPES as readonly string[]).includes(declaredType)
        ? (declaredType as MediaType)
        : null;
  if (!partType) {
    return problem(
      new AppError(
        415,
        'unsupported_media_type',
        `Send the ${upload.part} image as ${DERIVATIVE_TYPES.join(' or ')}.`,
        'failed',
      ),
      requestId,
    );
  }

  const key = upload.key;
  let stored = false;
  try {
    if (upload.part === 'original' && length !== null && length !== upload.declaredSize) {
      throw uploadRejected('size_mismatch', 'The file size differs from the declared size.', {
        declared: upload.declaredSize,
        received: length,
      });
    }
    let source: ReadableStream<Uint8Array> = body;
    let size: number;
    if (upload.part === 'original') {
      size = upload.declaredSize;
    } else if (length !== null && Number.isSafeInteger(length)) {
      if (length > upload.maxBytes) {
        throw uploadRejected('file_too_large', `At most ${upload.maxBytes} bytes.`, {
          maxBytes: upload.maxBytes,
        });
      }
      size = length;
    } else {
      // Storage needs the length up front; a derivative without one is small enough to read first.
      const bytes = await readAtMost(body, upload.maxBytes);
      size = bytes.byteLength;
      source = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    }
    const hasher = config.hasher();
    const inspect = inspector(upload, [partType], hasher);
    const put = await config.store
      .put(key, source.pipeThrough(inspect.stream), {
        size,
        contentType: partType,
        ...(upload.part === 'original'
          ? {
              sha256: upload.sha256,
              contentDisposition: contentDisposition('attachment', upload.fileName),
            }
          : {}),
      })
      .then(
        () => ({ ok: true as const }),
        (reason: unknown) => ({ ok: false as const, reason }),
      );
    stored = put.ok;
    if (inspect.failure) throw inspect.failure;
    // The body stopped early (a dropped connection) or storage failed while reading it.
    if (!inspect.finished) throw put.ok ? new Error('The body ended early.') : put.reason;
    const seen = inspect.result();
    if (seen.size !== size) {
      throw uploadRejected('size_mismatch', 'The file size differs from the declared size.', {
        declared: size,
        received: seen.size,
      });
    }
    const sha256 = hex(await hasher.digest());
    if (upload.part === 'original' && sha256 !== upload.sha256) {
      throw uploadRejected(
        'checksum_mismatch',
        'The file’s SHA-256 differs from the declared one.',
        {
          declared: upload.sha256,
          received: sha256,
        },
      );
    }
    if (!put.ok) throw put.reason;
    const type = seen.type!;
    const pixels = upload.kind === 'image' ? imageSize(seen.head, type) : null;
    if (upload.maxSide !== null) {
      if (!pixels) throw uploadRejected('unreadable_image', 'The image size could not be read.');
      if (Math.max(pixels.width, pixels.height) > upload.maxSide) {
        throw uploadRejected(
          'derivative_too_large',
          `The ${upload.part} image can be at most ${upload.maxSide} px on its longest side.`,
          { maxSide: upload.maxSide, width: pixels.width, height: pixels.height },
        );
      }
    }
    const meta = {
      size: seen.size,
      sha256,
      contentType: type,
      width: pixels?.width ?? null,
      height: pixels?.height ?? null,
    };
    try {
      await recordUploadPart(db, caller, upload, meta, requestId);
    } catch (error) {
      // The intent stopped being pending while the bytes moved: nothing may keep them.
      await config.store.delete([key]).catch(() => {});
      throw error;
    }
    return c.json({ intentId: upload.intentId, part: upload.part, ...meta });
  } catch (error) {
    if (error instanceof AppError && error.status === 409) return problem(error, requestId);
    // Any other failure once bytes started to move fails the upload, so it cannot be finalized,
    // and deletes what it stored (PRD 4.5).
    const rejection =
      error instanceof AppError
        ? error
        : new AppError(
            422,
            'upload_interrupted',
            'The upload did not complete. Start it again.',
            'failed',
          );
    if (!(error instanceof AppError)) {
      deps.logger.error('media_upload_failed', { requestId, stored, error: String(error) });
    }
    const keys = await failUpload(db, caller, upload, rejection, requestId);
    try {
      await config.store.delete(keys);
      await markUploadsCleaned(db, upload.shopId, [upload.intentId]);
    } catch (cleanupError) {
      // The sweep deletes them later.
      deps.logger.error('media_cleanup_deferred', { requestId, error: String(cleanupError) });
    }
    return problem(rejection, requestId);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function serveSigned(c: Context<AppEnv>, deps: AppDeps): Promise<Response> {
  const requestId = c.get('requestId');
  const config = deps.media;
  const { shopId, mediaId, part } = c.req.param() as Record<string, string>;
  if (
    !config?.signingKey ||
    !UUID.test(shopId ?? '') ||
    !UUID.test(mediaId ?? '') ||
    !(UPLOAD_PARTS as readonly string[]).includes(part ?? '')
  ) {
    return problem(errors.notFound('Media'), requestId);
  }
  const exp = c.req.query('exp') ?? '';
  const verdict = await verifyMediaLink(config.signingKey, {
    shopId: shopId!,
    mediaId: mediaId!,
    part: part!,
    exp,
    sig: c.req.query('sig') ?? '',
  });
  if (verdict === 'invalid') {
    return problem(
      new AppError(403, 'invalid_link', 'This media link is not valid.', 'denied'),
      requestId,
    );
  }
  if (verdict === 'expired') {
    return problem(
      new AppError(403, 'link_expired', 'This media link has expired. Reload the page.', 'denied'),
      requestId,
    );
  }
  const object = await config.store.get(objectKey(shopId!, mediaId!, part as UploadPart));
  if (!object) return problem(errors.notFound('Media'), requestId);
  const maxAge = Math.max(0, Number(exp) - Math.floor(Date.now() / 1000));
  return new Response(object.body, {
    headers: {
      'content-type': object.contentType,
      'content-length': String(object.size),
      'cache-control': `private, max-age=${maxAge}`,
      'content-disposition':
        part === 'original' ? (object.contentDisposition ?? 'attachment') : 'inline',
      'x-content-type-options': 'nosniff',
      // Files are shown or saved, never run, even if a browser opens one directly.
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'x-request-id': requestId,
    },
  });
}
