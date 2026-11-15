import { createHash } from 'node:crypto';
import type { MediaStore, StreamHasher } from './media.ts';

/**
 * In-memory media storage with R2's checks (exact length, optional SHA-256), and a SHA-256 stream
 * on node:crypto: for Node tests and the end-to-end server, where R2 and DigestStream do not exist.
 */
export function memoryMediaStore(): MediaStore & {
  objects: Map<
    string,
    { bytes: Uint8Array; contentType: string; contentDisposition: string | null }
  >;
} {
  const objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string; contentDisposition: string | null }
  >();
  return {
    objects,
    async put(key, body, meta) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
        if (size > meta.size) throw new Error('Body is longer than its declared length.');
      }
      if (size !== meta.size) throw new Error('Body is shorter than its declared length.');
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      if (meta.sha256 && createHash('sha256').update(bytes).digest('hex') !== meta.sha256) {
        throw new Error('The SHA-256 checksum did not match.');
      }
      objects.set(key, {
        bytes,
        contentType: meta.contentType,
        contentDisposition: meta.contentDisposition ?? null,
      });
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(object.bytes);
            controller.close();
          },
        }),
        size: object.bytes.byteLength,
        contentType: object.contentType,
        contentDisposition: object.contentDisposition,
      };
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
  };
}

export function nodeHasher(): StreamHasher {
  const hash = createHash('sha256');
  let resolve: (value: ArrayBuffer) => void = () => {};
  const digest = new Promise<ArrayBuffer>((r) => {
    resolve = r;
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      hash.update(chunk);
    },
    close() {
      const out = hash.digest();
      resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
    },
  });
  return { writable, digest };
}
