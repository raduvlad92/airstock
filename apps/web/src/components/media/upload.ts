import type { ops } from '@airstock/core';
import { ApiError, command, type Out } from '../../api.ts';
import type { PreparedFile } from './derivatives.ts';

type Intent = Out<typeof ops.createUpload>;
export type Finalized = Out<typeof ops.finalizeUpload>;

/**
 * Sends one part with the session cookie and the custom header, like every /api/v1 call. XHR rather
 * than fetch, because only XHR reports upload progress.
 */
function putPart(
  url: string,
  body: Blob,
  contentType: string,
  onProgress: (loaded: number) => void,
): Promise<void> {
  // Same origin as the page whatever host the API named, so the session cookie goes along.
  const target = new URL(url, window.location.origin);
  const path = `${target.pathname}${target.search}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', path);
    xhr.setRequestHeader('x-airstock-request', '1');
    xhr.setRequestHeader('content-type', contentType);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(body.size);
        resolve();
        return;
      }
      let problem: Record<string, unknown> = {};
      try {
        problem = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        // Not a problem document; the status says enough.
      }
      reject(
        new ApiError(
          xhr.status,
          typeof problem.code === 'string' ? problem.code : 'http_error',
          typeof problem.title === 'string' ? problem.title : `Upload failed (${xhr.status})`,
          problem,
        ),
      );
    };
    xhr.onerror = () => reject(new Error('The upload was interrupted. Check the connection.'));
    xhr.send(body);
  });
}

/**
 * Declares the file, uploads its parts, and finalizes it with a link to the product. Progress is
 * the share of all bytes sent, from 0 to 1.
 */
export async function uploadToProduct(
  shopId: string,
  productId: string,
  file: PreparedFile,
  onProgress: (share: number) => void,
): Promise<Finalized> {
  const intent = await command<Intent>(`/shops/${shopId}/media/uploads`, {
    fileName: file.fileName,
    contentType: file.contentType,
    size: file.original.size,
    sha256: file.sha256,
    productId,
  });
  const blobs: Record<string, Blob> = {
    original: file.original,
    ...(file.derivatives ?? {}),
  };
  const total = Object.values(blobs).reduce((n, b) => n + b.size, 0);
  const sent: Record<string, number> = {};
  for (const upload of intent.uploads) {
    const blob = blobs[upload.part];
    if (!blob) throw new Error(`Nothing to send for the ${upload.part}.`);
    const type = upload.part === 'original' ? file.contentType : blob.type;
    await putPart(upload.url, blob, type, (loaded) => {
      sent[upload.part] = loaded;
      onProgress(Object.values(sent).reduce((n, v) => n + v, 0) / total);
    });
  }
  return command<Finalized>(`/shops/${shopId}/media/uploads/${intent.intentId}/finalize`, {
    productId,
  });
}
