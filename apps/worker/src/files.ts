import { errors, execute, IMPORT_LIMITS, ops } from '@airstock/core';
import type { Context, Hono } from 'hono';
import { type AppDeps, type AppEnv, fileAccess, problem } from './app.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Import uploads and export downloads (plan Section 5.12). Both sit under /api/v1, so the caller is
 * authenticated like any API call; the registry operations they run check permissions and record
 * the events.
 */
export function mountFileRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const pipeline = (c: Context<AppEnv>) => ({
    db: c.get('db'),
    audit: c.get('audit'),
    logger: deps.logger,
    ...fileAccess(deps),
  });

  app.put('/api/v1/shops/:shopId/imports/:importId/file', async (c) => {
    const { shopId, importId } = c.req.param();
    const requestId = c.get('requestId');
    if (!UUID.test(importId)) return problem(errors.notFound('Import'), requestId);
    if (!deps.files) return problem(errors.serviceUnavailable(), requestId);
    const declared = Number(c.req.header('content-length') ?? Number.NaN);
    if (!Number.isFinite(declared) || declared > IMPORT_LIMITS.bytes) {
      return problem(
        errors.validation([
          {
            path: 'body',
            message: `Send the file with a Content-Length of at most ${IMPORT_LIMITS.bytes / 1024 / 1024} MB.`,
          },
        ]),
        requestId,
      );
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length === 0 || bytes.length > IMPORT_LIMITS.bytes) {
      return problem(
        errors.validation([{ path: 'body', message: 'The file is empty or too large.' }]),
        requestId,
      );
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      return problem(
        errors.validation([
          { path: 'body', message: 'Save the file as UTF-8 CSV and upload it again.' },
        ]),
        requestId,
      );
    }
    // Permission and state first, so a refused caller never writes a file.
    await execute(pipeline(c), ops.recordImportUpload, {
      caller: c.get('caller'),
      shopId,
      input: { importId, sizeBytes: bytes.length },
      requestId,
    });
    await deps.files.put(
      `shops/${shopId}/imports/${importId}/source.csv`,
      text,
      'text/csv; charset=utf-8',
    );
    return c.json({ importId, sizeBytes: bytes.length });
  });

  app.get('/api/v1/shops/:shopId/exports/:exportId/file', async (c) => {
    const { shopId, exportId } = c.req.param();
    const requestId = c.get('requestId');
    if (!UUID.test(exportId)) return problem(errors.notFound('Export'), requestId);
    if (!deps.files) return problem(errors.serviceUnavailable(), requestId);
    const res = await execute(pipeline(c), ops.downloadExport, {
      caller: c.get('caller'),
      shopId,
      input: { exportId },
      requestId,
    });
    const { fileKey, fileName } = res.result as { fileKey: string; fileName: string };
    const body = await deps.files.get(fileKey);
    if (body === null) return problem(errors.notFound('Export file'), requestId);
    return new Response(body, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${fileName}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });
}
