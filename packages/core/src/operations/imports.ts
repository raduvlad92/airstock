import type { Database, Tx } from '@airstock/db';
import { z } from 'zod';
import { type AuditEvent, type AuditSink, auditEvent, INSERT_AUDIT_EVENTS_SQL } from '../audit.ts';
import type { Caller, Membership } from '../caller.ts';
import { displayValue } from '../catalog/fields.ts';
import {
  IMPORT_LIMITS,
  type Mapping,
  previewRows,
  type RowData,
  readFile,
  suggestMapping,
} from '../catalog/imports.ts';
import { loadFields, shopSettings, visible } from '../catalog/store.ts';
import { CsvError, csvLine } from '../csv.ts';
import { AppError, errors } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import { effectivePermissions, isRole } from '../permissions.ts';
import type { Logger } from '../pipeline.ts';
import { defineOperation, type FileAccess, type HandlerContext } from '../registry.ts';
import { Id, iso, normalizeSku } from '../schemas.ts';
import { QueryInput, runQuery } from './catalog-query.ts';

// Imports and exports (plan Section 5.12, decision D10, ADR 0018).

const TOOL = 'import_export';
const IMPORT_EXCEPTION = 'Needs an uploaded file: imports start in the dashboard or the API.';

export const importFileKey = (shopId: string, importId: string) =>
  `shops/${shopId}/imports/${importId}/source.csv`;
export const exportFileKey = (shopId: string, exportId: string) =>
  `shops/${shopId}/exports/${exportId}.csv`;

interface StoredCaller {
  kind: Caller['kind'];
  id: string;
  userId: string | null;
  clientId?: string;
  grantId?: string;
  scopes: 'all' | string[];
  source: Caller['source'];
}

function storeCaller(caller: Caller): StoredCaller {
  return {
    kind: caller.kind,
    id: caller.id,
    userId: caller.userId,
    ...(caller.clientId ? { clientId: caller.clientId } : {}),
    ...(caller.grantId ? { grantId: caller.grantId } : {}),
    scopes: caller.scopes === 'all' ? 'all' : [...caller.scopes],
    source: caller.source,
  };
}

function requireFiles(ctx: HandlerContext): FileAccess {
  if (!ctx.files)
    throw new AppError(503, 'files_unavailable', 'File storage is not available here.', 'failed');
  return ctx.files;
}

const ImportOut = z.object({
  importId: Id,
  fileName: z.string(),
  status: z.string(),
  header: z.array(z.string()).nullable(),
  mapping: z.record(z.string(), z.string()).nullable(),
  rowCount: z.number().nullable(),
  counts: z.record(z.string(), z.number()),
  checkpoint: z.number(),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

interface ImportRow {
  id: string;
  file_name: string;
  status: string;
  header: string[] | null;
  mapping: Mapping | null;
  row_count: number | null;
  counts: Record<string, number>;
  checkpoint: number;
  error: string | null;
  created_at: Date;
  completed_at: Date | null;
  caller: StoredCaller;
  delimiter: ',' | ';' | null;
}

async function loadImport(tx: Tx, importId: string, lock = false): Promise<ImportRow> {
  const [row] = await tx.query<ImportRow>(
    `select id, file_name, status, header, mapping, row_count, counts, checkpoint, error, created_at,
       completed_at, caller, delimiter
     from import_jobs where id = $1${lock ? ' for update' : ''}`,
    [importId],
  );
  if (!row) throw errors.notFound('Import');
  return row;
}

function importOut(r: ImportRow) {
  return {
    importId: r.id,
    fileName: r.file_name,
    status: r.status,
    header: r.header,
    mapping: r.mapping,
    rowCount: r.row_count,
    counts: r.counts,
    checkpoint: r.checkpoint,
    error: r.error,
    createdAt: iso(r.created_at) as string,
    completedAt: iso(r.completed_at),
  };
}

export const createImport = defineOperation({
  id: 'imports.create',
  summary: 'Start a CSV import',
  description: `Creates the import and returns where to upload the file (PUT, UTF-8 CSV, comma or semicolon, up to ${IMPORT_LIMITS.bytes / 1024 / 1024} MB and ${IMPORT_LIMITS.rows.toLocaleString('en')} rows).`,
  kind: 'command',
  scope: 'shop',
  input: z.object({ fileName: z.string().trim().min(1).max(200) }),
  output: z.object({ importId: Id, uploadPath: z.string() }),
  permission: 'imports.run',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.import.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/imports', status: 201 },
  mcp: { exception: IMPORT_EXCEPTION },
  async handler(ctx, input) {
    const importId = ctx.newId();
    await ctx.tx.query(
      `insert into import_jobs (shop_id, id, caller, file_key, file_name) values (app_shop_id(), $1, $2, $3, $4)`,
      [
        importId,
        JSON.stringify(storeCaller(ctx.caller)),
        importFileKey(ctx.shopId, importId),
        input.fileName,
      ],
    );
    return {
      result: { importId, uploadPath: `/api/v1/shops/${ctx.shopId}/imports/${importId}/file` },
      audit: { targetType: 'import', targetId: importId, changes: { fileName: input.fileName } },
    };
  },
});

export const recordImportUpload = defineOperation({
  id: 'imports.upload.record',
  summary: 'Record that an import file was uploaded',
  description:
    'Called by the upload route after the file is stored; checks that the import is still waiting for its file.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ importId: Id, sizeBytes: z.number().int().min(1).max(IMPORT_LIMITS.bytes) }),
  output: z.object({ importId: Id, status: z.string() }),
  permission: 'imports.run',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.import.uploaded' },
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/imports/{importId}/uploaded' },
  mcp: { exception: IMPORT_EXCEPTION },
  async handler(ctx, input) {
    const job = await loadImport(ctx.tx, input.importId, true);
    if (!['uploading', 'uploaded', 'previewed'].includes(job.status)) {
      throw errors.conflict('import_closed', 'This import was already committed. Start a new one.');
    }
    await ctx.tx.query(
      `update import_jobs set status = 'uploaded', size_bytes = $2, header = null, mapping = null, row_count = null,
         counts = '{}', updated_at = now(), version = version + 1 where id = $1`,
      [input.importId, input.sizeBytes],
    );
    await ctx.tx.query('delete from import_rows where import_id = $1', [input.importId]);
    return {
      result: { importId: input.importId, status: 'uploaded' },
      audit: {
        targetType: 'import',
        targetId: input.importId,
        changes: { sizeBytes: input.sizeBytes },
      },
    };
  },
});

const ProblemRow = z.object({
  rowNumber: z.number(),
  action: z.string(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const previewImport = defineOperation({
  id: 'imports.preview',
  summary: 'Map an import’s columns and validate every row',
  description:
    'Without a mapping, returns the columns and a suggested mapping. With one, validates every row without writing: creates (new SKUs), updates (matched by SKU), errors, and likely duplicates. Targets: product, name, description, status, family, tags, sku, barcode, price, weight, dimensions, field:<key>, option:<name>, stock:<locationId>, ignore.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    importId: Id,
    mapping: z.record(z.string().max(200), z.string().max(200)).optional(),
    delimiter: z.enum([',', ';']).optional(),
  }),
  output: z.object({
    import: ImportOut,
    suggestedMapping: z.record(z.string(), z.string()),
    problems: z.array(ProblemRow).describe('The first 100 rows with errors or warnings.'),
  }),
  permission: 'imports.run',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.import.previewed' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/imports/{importId}/preview' },
  mcp: { exception: IMPORT_EXCEPTION },
  async handler(ctx, input) {
    const job = await loadImport(ctx.tx, input.importId, true);
    if (job.status !== 'uploaded' && job.status !== 'previewed') {
      throw errors.conflict(
        'import_not_ready',
        job.status === 'uploading'
          ? 'Upload the file first.'
          : 'This import was already committed.',
      );
    }
    const text = await requireFiles(ctx).get(importFileKey(ctx.shopId, input.importId));
    if (text === null)
      throw errors.conflict('import_file_missing', 'The file is missing. Upload it again.');
    let parsed: ReturnType<typeof readFile>;
    try {
      parsed = readFile(text, input.delimiter);
    } catch (error) {
      throw errors.unprocessable(
        'csv_invalid',
        error instanceof CsvError ? error.message : 'The file is not a readable CSV.',
      );
    }
    if (parsed.rows.length > IMPORT_LIMITS.rows) {
      throw errors.unprocessable(
        'too_many_rows',
        `An import has at most ${IMPORT_LIMITS.rows.toLocaleString('en')} rows.`,
      );
    }
    const fields = visible(await loadFields(ctx.tx), ctx.membership);
    const suggested = suggestMapping(parsed.header, fields);
    if (!input.mapping) {
      await ctx.tx.query(
        `update import_jobs set header = $2, delimiter = $3, row_count = $4, updated_at = now() where id = $1`,
        [input.importId, JSON.stringify(parsed.header), parsed.delimiter, parsed.rows.length],
      );
      return {
        result: {
          import: importOut({ ...job, header: parsed.header, row_count: parsed.rows.length }),
          suggestedMapping: suggested,
          problems: [],
        },
        audit: {
          targetType: 'import',
          targetId: input.importId,
          outcome: 'no_change' as const,
          context: { columns: parsed.header.length },
        },
      };
    }
    const { currency } = await shopSettings(ctx.tx);
    const families = await ctx.tx.query<{ id: string; name: string; status: string }>(
      'select id, name, status from product_families',
    );
    const locations = await ctx.tx.query<{ id: string; path: string }>(
      `select l.id, l.path from locations l
       where l.status = 'active' and not exists (select 1 from locations c where c.shop_id = l.shop_id and c.parent_id = l.id)
         and ($1::uuid[] is null or l.path_ids && $1::uuid[])`,
      [ctx.locationScope],
    );
    let rows: Awaited<ReturnType<typeof previewRows>>;
    try {
      rows = await previewRows(
        {
          tx: ctx.tx,
          fields,
          currency,
          families,
          locations: new Map(locations.map((l) => [l.id, { path: l.path }])),
        },
        parsed.header,
        parsed.rows,
        input.mapping,
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw errors.unprocessable('mapping_invalid', (error as Error).message);
    }
    await ctx.tx.query('delete from import_rows where import_id = $1', [input.importId]);
    for (let i = 0; i < rows.length; i += 1000) {
      await ctx.tx.query(
        `insert into import_rows (shop_id, import_id, row_number, group_key, action, status, data, errors, warnings,
           product_id, variant_id)
         select app_shop_id(), $1, x.row_number, x.group_key, x.action, case when x.action = 'error' then 'skipped' else 'pending' end,
           x.data, x.errors, x.warnings, x.product_id, x.variant_id
         from jsonb_to_recordset($2::jsonb) as x(row_number int, group_key text, action text, data jsonb, errors jsonb,
           warnings jsonb, product_id uuid, variant_id uuid)`,
        [
          input.importId,
          JSON.stringify(
            rows.slice(i, i + 1000).map((r) => ({
              row_number: r.rowNumber,
              group_key: r.groupKey,
              action: r.action,
              data: r.data,
              errors: r.errors,
              warnings: r.warnings,
              product_id: r.productId,
              variant_id: r.variantId,
            })),
          ),
        ],
      );
    }
    const counts = {
      rows: rows.length,
      creates: rows.filter((r) => r.action === 'create').length,
      updates: rows.filter((r) => r.action === 'update').length,
      errors: rows.filter((r) => r.action === 'error').length,
      warnings: rows.filter((r) => r.warnings.length > 0).length,
      newProducts: new Set(rows.filter((r) => r.action === 'create').map((r) => r.groupKey)).size,
      stockRows: rows.filter((r) => r.data?.stock.length).length,
    };
    await ctx.tx.query(
      `update import_jobs set status = 'previewed', header = $2, mapping = $3, delimiter = $4, row_count = $5, counts = $6,
         updated_at = now(), version = version + 1 where id = $1`,
      [
        input.importId,
        JSON.stringify(parsed.header),
        JSON.stringify(input.mapping),
        parsed.delimiter,
        rows.length,
        JSON.stringify(counts),
      ],
    );
    const updated = await loadImport(ctx.tx, input.importId);
    return {
      result: {
        import: importOut(updated),
        suggestedMapping: suggested,
        problems: rows
          .filter((r) => r.errors.length || r.warnings.length)
          .slice(0, 100)
          .map((r) => ({
            rowNumber: r.rowNumber,
            action: r.action,
            errors: r.errors,
            warnings: r.warnings,
          })),
      },
      audit: {
        targetType: 'import',
        targetId: input.importId,
        context: { mapping: input.mapping, counts },
      },
    };
  },
});

export const commitImport = defineOperation({
  id: 'imports.commit',
  summary: 'Commit a previewed import',
  description:
    'Writes the valid rows of the last preview in chunks, as a job; rows with errors are skipped. Opening stock is received with the reason "opening stock". Follow progress with get_import.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ importId: Id }),
  output: z.object({ import: ImportOut }),
  permission: 'imports.run',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.import.committed' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/imports/{importId}/commit' },
  mcp: { exception: IMPORT_EXCEPTION },
  async handler(ctx, input) {
    const job = await loadImport(ctx.tx, input.importId, true);
    if (job.status !== 'previewed') {
      throw errors.conflict(
        'import_not_previewed',
        'Preview the import with a mapping before committing it.',
      );
    }
    if (!ctx.membership || !hasPermission(ctx.membership, 'catalog.write')) {
      throw errors.forbidden('Requires the catalog.write permission.');
    }
    await ctx.tx.query(
      `update import_jobs set status = 'committing', committed_at = now(), updated_at = now(), version = version + 1,
         caller = $2 where id = $1`,
      [input.importId, JSON.stringify(storeCaller(ctx.caller))],
    );
    const updated = await loadImport(ctx.tx, input.importId);
    return {
      result: { import: importOut(updated) },
      // The import's parent event: chunks and records link to it by importId.
      audit: {
        targetType: 'import',
        targetId: input.importId,
        changes: { counts: job.counts, mapping: job.mapping },
      },
      outbox: [{ topic: 'catalog.import.run', payload: { importId: input.importId } }],
    };
  },
});

function hasPermission(membership: Membership, permission: 'catalog.write'): boolean {
  return effectivePermissions(membership).has(permission);
}

export const getImport = defineOperation({
  id: 'imports.get',
  summary: 'Get an import’s status and totals',
  kind: 'read',
  scope: 'shop',
  input: z.object({ importId: Id }),
  output: z.object({ import: ImportOut }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.import.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/imports/{importId}' },
  mcp: { tool: TOOL, action: 'get_import', readOnly: true, destructive: false },
  async handler(ctx, input) {
    return {
      result: { import: importOut(await loadImport(ctx.tx, input.importId)) },
      audit: { targetType: 'import', targetId: input.importId },
    };
  },
});

export const listImports = defineOperation({
  id: 'imports.list',
  summary: 'List recent imports',
  kind: 'read',
  scope: 'shop',
  input: z.object({}),
  output: z.object({ imports: z.array(ImportOut) }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.imports.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/imports' },
  mcp: { tool: TOOL, action: 'list_imports', readOnly: true, destructive: false },
  async handler(ctx) {
    const rows = await ctx.tx.query<ImportRow>(
      `select id, file_name, status, header, mapping, row_count, counts, checkpoint, error, created_at, completed_at, caller, delimiter
       from import_jobs order by created_at desc limit 50`,
    );
    return {
      result: { imports: rows.map(importOut) },
      audit: { targetType: 'import', targetId: 'list' },
    };
  },
});

export const listImportRows = defineOperation({
  id: 'imports.rows.list',
  summary: 'List the per-row results of an import',
  description:
    'Each row’s action (create, update, error), status after commit, errors, warnings, and the records it wrote.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    importId: Id,
    only: z.enum(['all', 'problems', 'failed']).default('all'),
    afterRow: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  output: z.object({
    rows: z.array(
      z.object({
        rowNumber: z.number(),
        action: z.string(),
        status: z.string(),
        errors: z.array(z.string()),
        warnings: z.array(z.string()),
        productId: Id.nullable(),
        variantId: Id.nullable(),
        stocked: z.boolean(),
      }),
    ),
    nextAfterRow: z.number().nullable(),
  }),
  permission: 'catalog.read',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.import_rows.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/imports/{importId}/rows' },
  mcp: { tool: TOOL, action: 'import_rows', readOnly: true, destructive: false },
  async handler(ctx, input) {
    await loadImport(ctx.tx, input.importId);
    const rows = await ctx.tx.query<{
      row_number: number;
      action: string;
      status: string;
      errors: string[] | null;
      warnings: string[] | null;
      product_id: string | null;
      variant_id: string | null;
      stocked: boolean;
    }>(
      `select row_number, action, status, errors, warnings, product_id, variant_id, stocked from import_rows
       where import_id = $1 and row_number > $2
         and ($3 = 'all' or ($3 = 'failed' and status = 'failed')
           or ($3 = 'problems' and (jsonb_array_length(coalesce(errors, '[]')) > 0 or jsonb_array_length(coalesce(warnings, '[]')) > 0)))
       order by row_number limit $4`,
      [input.importId, input.afterRow, input.only, input.limit + 1],
    );
    const page = rows.slice(0, input.limit);
    return {
      result: {
        rows: page.map((r) => ({
          rowNumber: r.row_number,
          action: r.action,
          status: r.status,
          errors: r.errors ?? [],
          warnings: r.warnings ?? [],
          productId: r.product_id,
          variantId: r.variant_id,
          stocked: r.stocked,
        })),
        nextAfterRow: rows.length > input.limit ? (page.at(-1)?.row_number ?? null) : null,
      },
      audit: { targetType: 'import', targetId: input.importId },
    };
  },
});

// The import job --------------------------------------------------------------------------

export interface JobDeps {
  db: Database;
  audit: AuditSink;
  files: FileAccess;
  logger?: Logger;
  /** Test-only fault injection: runs after a chunk commits, before its receipts. */
  afterChunk?: (chunk: number) => Promise<void> | void;
}

interface PendingRow {
  row_number: number;
  group_key: string;
  action: 'create' | 'update';
  data: RowData;
  product_id: string | null;
  variant_id: string | null;
}

/** Rebuilds the caller who committed, with their membership as it is now. */
async function jobCaller(db: Database, shopId: string, stored: StoredCaller): Promise<Caller> {
  const [m] = await db.transaction({ shopId, userId: null, readOnly: true }, (tx) =>
    tx.query<{ id: string; role: string; all_locations: boolean; scope_ids: string[] }>(
      `select m.id, m.role, m.all_locations,
         coalesce(array(select s.scope_id from membership_location_scopes s where s.shop_id = m.shop_id and s.membership_id = m.id), '{}') as scope_ids
       from memberships m where m.user_id = $1 and m.status = 'active'`,
      [stored.userId],
    ),
  );
  if (!m || !isRole(m.role))
    throw errors.forbidden('The member who started this is no longer in the shop.');
  return {
    kind: stored.kind,
    id: stored.id,
    userId: stored.userId,
    boundShopId: shopId,
    membership: {
      id: m.id,
      role: m.role,
      allLocations: m.all_locations,
      locationScopeIds: m.scope_ids,
    },
    scopes: stored.scopes === 'all' ? 'all' : new Set(stored.scopes as never[]),
    ...(stored.clientId ? { clientId: stored.clientId } : {}),
    ...(stored.grantId ? { grantId: stored.grantId } : {}),
    // Everything the job writes is attributed to the import.
    source: 'import',
  };
}

/**
 * Commits an import in chunks of about 200 rows per transaction (D10). Each chunk writes its
 * records, the rows' outcomes, one change event per record, and the checkpoint; opening stock is
 * received after the chunk with an idempotency key per row and location, so a resumed import
 * never creates or receives twice. Returns 'more' when the time budget ran out.
 */
export async function runImportJob(
  deps: JobDeps,
  shopId: string,
  importId: string,
  budgetMs = 20_000,
): Promise<'done' | 'more' | 'missing'> {
  const started = Date.now();
  const job = await deps.db.transaction({ shopId, userId: null }, async (tx) => {
    const [row] = await tx.query<ImportRow>(
      `update import_jobs set updated_at = now() where id = $1 and status = 'committing'
       returning id, file_name, status, header, mapping, row_count, counts, checkpoint, error, created_at, completed_at, caller, delimiter`,
      [importId],
    );
    return row ?? null;
  });
  if (!job) return 'missing';
  let caller: Caller;
  try {
    caller = await jobCaller(deps.db, shopId, job.caller);
  } catch (error) {
    await finish(deps, shopId, importId, 'failed', (error as Error).message);
    return 'done';
  }
  const requestId = uuidv7();
  const base = { shopId, caller, requestId, attemptId: null, idempotencyKey: null };
  let chunk = 0;
  while (Date.now() - started < budgetMs) {
    const rows = await deps.db.transaction({ shopId, userId: caller.userId }, async (tx) => {
      const pending = await tx.query<PendingRow>(
        `with g as (
           select group_key, min(row_number) as first from import_rows
           where import_id = $1 and status = 'pending' group by group_key order by first limit $2)
         select r.row_number, r.group_key, r.action, r.data, r.product_id, r.variant_id
         from import_rows r join g on g.group_key = r.group_key
         where r.import_id = $1 and r.status = 'pending' order by g.first, r.row_number`,
        [importId, IMPORT_LIMITS.chunkRows],
      );
      // Whole groups only, up to the chunk size (at least one group).
      const take: PendingRow[] = [];
      for (const r of pending) {
        const newGroup = take.length === 0 || take.at(-1)!.group_key !== r.group_key;
        if (newGroup && take.length >= IMPORT_LIMITS.chunkRows) break;
        take.push(r);
      }
      if (take.length === 0) return take;
      await commitChunk(tx, importId, take, base);
      return take;
    });
    if (rows.length === 0) {
      await finish(deps, shopId, importId, 'completed', null, base);
      return 'done';
    }
    chunk++;
    await deps.afterChunk?.(chunk);
  }
  return 'more';
}

async function finish(
  deps: JobDeps,
  shopId: string,
  importId: string,
  status: 'completed' | 'failed',
  error: string | null,
  base?: Parameters<typeof auditEvent>[0],
) {
  const counts = await deps.db.transaction({ shopId, userId: null }, async (tx) => {
    const [c] = await tx.query<{
      done: number;
      failed: number;
      skipped: number;
      stock_failed: number;
    }>(
      `select count(*) filter (where status = 'done')::int as done, count(*) filter (where status = 'failed')::int as failed,
         count(*) filter (where status = 'skipped')::int as skipped,
         count(*) filter (where status = 'done' and errors is not null and jsonb_array_length(errors) > 0)::int as stock_failed
       from import_rows where import_id = $1`,
      [importId],
    );
    await tx.query(
      `update import_jobs set status = $2, error = $3, completed_at = now(), updated_at = now(),
         counts = counts || $4::jsonb, version = version + 1 where id = $1`,
      [importId, status, error, JSON.stringify(c)],
    );
    return c!;
  });
  if (base) {
    await deps.audit.send([
      auditEvent(base, {
        action: 'catalog.import.completed',
        phase: 'outcome',
        outcome: 'succeeded',
        target_type: 'import',
        target_id: importId,
        changes: counts,
      }),
    ]);
  }
}

/** Writes one chunk set-based: a few statements for up to 200 rows (risk R4). */
async function commitChunk(
  tx: Tx,
  importId: string,
  rows: PendingRow[],
  base: Parameters<typeof auditEvent>[0],
) {
  const events: AuditEvent[] = [];
  const outcomes: Array<{
    row_number: number;
    status: string;
    errors: string[] | null;
    product_id: string | null;
    variant_id: string | null;
  }> = [];
  const receipts: Array<{
    key: string;
    row_number: number;
    variant_id: string;
    location_id: string;
    quantity: string;
  }> = [];
  const stockFor = (r: PendingRow, variantId: string) => {
    for (const st of r.data.stock) {
      receipts.push({
        key: `import:${importId}:${r.row_number}:${st.locationId}`,
        row_number: r.row_number,
        variant_id: variantId,
        location_id: st.locationId,
        quantity: st.quantity,
      });
    }
  };
  const event = (fields: Partial<AuditEvent> & Pick<AuditEvent, 'action'>) =>
    events.push(auditEvent(base, { phase: 'outcome', outcome: 'succeeded', ...fields }));
  // SKUs taken since the preview fail their rows instead of the chunk.
  const createSkus = rows
    .filter((r) => r.action === 'create')
    .map((r) => normalizeSku(r.data.variant.sku));
  const taken = new Set(
    (
      await tx.query<{ sku_normalized: string }>(
        'select sku_normalized from variants where sku_normalized = any($1::text[])',
        [createSkus],
      )
    ).map((r) => r.sku_normalized),
  );
  const products: unknown[] = [];
  const options: unknown[] = [];
  const optionValues: unknown[] = [];
  const variants: unknown[] = [];
  const relations: unknown[] = [];
  const groups = new Map<string, PendingRow[]>();
  for (const r of rows) groups.set(r.group_key, [...(groups.get(r.group_key) ?? []), r]);
  for (const group of groups.values()) {
    if (group[0]!.action !== 'create') continue;
    if (group.some((r) => taken.has(normalizeSku(r.data.variant.sku)))) {
      for (const r of group) {
        outcomes.push({
          row_number: r.row_number,
          status: 'failed',
          errors: ['A SKU of this product was used by another record after the preview.'],
          product_id: null,
          variant_id: null,
        });
      }
      continue;
    }
    const first = group[0]!.data;
    const productId = uuidv7();
    products.push({
      id: productId,
      name: first.product.name,
      description: first.product.description ?? null,
      status: first.product.status ?? 'active',
      family_id: first.product.familyId ?? null,
      tags: first.product.tags ?? [],
      attributes: first.product.attributes,
    });
    const names = [...new Set(group.flatMap((r) => r.data.options.map((o) => o.name)))];
    const valueIds = new Map<string, string>();
    for (const [position, name] of names.entries()) {
      const optionId = uuidv7();
      options.push({ id: optionId, product_id: productId, name, position });
      const labels: string[] = [];
      for (const r of group) {
        const v = r.data.options.find((o) => o.name === name)!.value;
        if (!labels.some((l) => l.toLowerCase() === v.toLowerCase())) labels.push(v);
      }
      for (const [i, label] of labels.entries()) {
        const id = uuidv7();
        valueIds.set(`${name}\u0000${label.toLowerCase()}`, id);
        optionValues.push({ id, option_id: optionId, label, position: i });
      }
    }
    for (const [i, r] of group.entries()) {
      const variantId = uuidv7();
      const ids = r.data.options
        .map((o) => valueIds.get(`${o.name}\u0000${o.value.toLowerCase()}`)!)
        .sort();
      variants.push({
        id: variantId,
        product_id: productId,
        sku: r.data.variant.sku,
        sku_normalized: normalizeSku(r.data.variant.sku),
        price: r.data.variant.price ?? null,
        is_default: i === 0,
        option_value_ids: ids,
        attributes: r.data.variant.attributes,
        weight: r.data.variant.weight ?? null,
        dimensions: r.data.variant.dimensions ?? null,
      });
      for (const rel of r.data.relations) {
        for (const [p, target] of rel.targets.entries()) {
          relations.push({
            id: uuidv7(),
            field_id: rel.fieldId,
            source_type: rel.record,
            source_id: rel.record === 'product' ? productId : variantId,
            target_id: target,
            position: p,
          });
        }
      }
      outcomes.push({
        row_number: r.row_number,
        status: 'done',
        errors: null,
        product_id: productId,
        variant_id: variantId,
      });
      stockFor(r, variantId);
      event({
        action: 'catalog.variant.imported',
        target_type: 'variant',
        target_id: variantId,
        changes: {
          importId,
          row: r.row_number,
          productId,
          sku: r.data.variant.sku,
          price: r.data.variant.price ?? null,
          options: r.data.options,
        },
      });
    }
    event({
      action: 'catalog.product.imported',
      target_type: 'product',
      target_id: productId,
      changes: {
        importId,
        rows: group.map((r) => r.row_number),
        name: first.product.name,
        variants: group.length,
      },
    });
  }
  const insert = async (table: string, list: unknown[], columns: string, types: string) => {
    if (list.length === 0) return;
    await tx.query(
      `insert into ${table} (shop_id, ${columns}) select app_shop_id(), ${columns} from jsonb_to_recordset($1::jsonb) as x(${types})`,
      [JSON.stringify(list)],
    );
  };
  await insert(
    'products',
    products,
    'id, name, description, status, family_id, tags, attributes',
    'id uuid, name text, description text, status text, family_id uuid, tags text[], attributes jsonb',
  );
  await insert(
    'product_options',
    options,
    'id, product_id, name, position',
    'id uuid, product_id uuid, name text, position smallint',
  );
  await insert(
    'product_option_values',
    optionValues,
    'id, option_id, label, position',
    'id uuid, option_id uuid, label text, position int',
  );
  await insert(
    'variants',
    variants,
    'id, product_id, sku, sku_normalized, price, is_default, option_value_ids, attributes, weight, dimensions',
    'id uuid, product_id uuid, sku text, sku_normalized text, price numeric, is_default boolean, option_value_ids uuid[], attributes jsonb, weight jsonb, dimensions jsonb',
  );
  // Updates: matched by SKU. Values merge into the record; empty cells changed nothing.
  const updates = rows.filter((r) => r.action === 'update');
  if (updates.length > 0) {
    await tx.query(
      `update variants v set
         price = case when x.has_price then x.price else v.price end,
         weight = coalesce(x.weight, v.weight),
         dimensions = coalesce(x.dimensions, v.dimensions),
         attributes = v.attributes || x.attributes,
         version = v.version + 1, updated_at = now()
       from jsonb_to_recordset($1::jsonb) as x(id uuid, has_price boolean, price numeric, weight jsonb, dimensions jsonb, attributes jsonb)
       where v.id = x.id`,
      [
        JSON.stringify(
          updates.map((r) => ({
            id: r.variant_id,
            has_price: 'price' in r.data.variant,
            price: r.data.variant.price ?? null,
            weight: r.data.variant.weight ?? null,
            dimensions: r.data.variant.dimensions ?? null,
            attributes: r.data.variant.attributes,
          })),
        ),
      ],
    );
    // Product values come from the first row of each product.
    const byProduct = new Map<string, PendingRow>();
    for (const r of updates) if (!byProduct.has(r.product_id!)) byProduct.set(r.product_id!, r);
    const productRows = [...byProduct.values()].filter(
      (r) =>
        Object.keys(r.data.product).some((k) => k !== 'attributes') ||
        Object.keys(r.data.product.attributes).length,
    );
    if (productRows.length > 0) {
      await tx.query(
        `update products p set
           name = coalesce(x.name, p.name),
           description = case when x.has_description then x.description else p.description end,
           status = coalesce(x.status, p.status),
           family_id = case when x.has_family then x.family_id else p.family_id end,
           tags = coalesce(x.tags, p.tags),
           attributes = p.attributes || x.attributes,
           version = p.version + 1, updated_at = now()
         from jsonb_to_recordset($1::jsonb) as x(id uuid, name text, has_description boolean, description text, status text,
           has_family boolean, family_id uuid, tags text[], attributes jsonb)
         where p.id = x.id and p.status <> 'archived'`,
        [
          JSON.stringify(
            productRows.map((r) => ({
              id: r.product_id,
              name: r.data.product.name ?? null,
              has_description: 'description' in r.data.product,
              description: r.data.product.description ?? null,
              status: r.data.product.status ?? null,
              has_family: 'familyId' in r.data.product,
              family_id: r.data.product.familyId ?? null,
              tags: r.data.product.tags ?? null,
              attributes: r.data.product.attributes,
            })),
          ),
        ],
      );
    }
    for (const r of updates) {
      for (const rel of r.data.relations) {
        const source = rel.record === 'product' ? r.product_id! : r.variant_id!;
        await tx.query('delete from record_relations where field_id = $1 and source_id = $2', [
          rel.fieldId,
          source,
        ]);
        for (const [p, target] of rel.targets.entries()) {
          relations.push({
            id: uuidv7(),
            field_id: rel.fieldId,
            source_type: rel.record,
            source_id: source,
            target_id: target,
            position: p,
          });
        }
      }
      const fields: Record<string, unknown> = {
        ...(r.data.variant.price !== undefined ? { price: { to: r.data.variant.price } } : {}),
        ...(r.data.variant.barcode ? { barcode: { added: r.data.variant.barcode.code } } : {}),
        ...Object.fromEntries(
          Object.entries(r.data.variant.attributes).map(([id, v]) => [id, { to: v }]),
        ),
      };
      outcomes.push({
        row_number: r.row_number,
        status: 'done',
        errors: null,
        product_id: r.product_id,
        variant_id: r.variant_id,
      });
      stockFor(r, r.variant_id!);
      event({
        action: 'catalog.variant.changed',
        target_type: 'variant',
        target_id: r.variant_id!,
        changes: { importId, row: r.row_number, fields },
      });
    }
  }
  await insert(
    'record_relations',
    relations,
    'id, field_id, source_type, source_id, target_type, target_id, position',
    'id uuid, field_id uuid, source_type text, source_id uuid, target_type text, target_id uuid, position int',
  );
  // Barcodes from a barcode column, for the variants this chunk created or updated. The preview
  // refused codes another record holds; one taken since then is skipped, not moved.
  const variantOf = new Map(
    outcomes.filter((o) => o.status === 'done').map((o) => [o.row_number, o.variant_id]),
  );
  const barcodes = rows.flatMap((r) => {
    const b = r.data.variant.barcode;
    const variantId = variantOf.get(r.row_number);
    return b && variantId
      ? [
          {
            id: uuidv7(),
            variant_id: variantId,
            symbology: b.symbology,
            code: b.code,
            normalized: b.normalized,
          },
        ]
      : [];
  });
  if (barcodes.length > 0) {
    await tx.query(
      `with x as (
         select * from jsonb_to_recordset($1::jsonb)
           as x(id uuid, variant_id uuid, symbology text, code text, normalized text)),
       added as (
         insert into barcodes (shop_id, id, variant_id, symbology, code, code_normalized, position)
         select app_shop_id(), x.id, x.variant_id, x.symbology, x.code, x.normalized,
           coalesce((select max(b.position) + 1 from barcodes b where b.variant_id = x.variant_id), 0)
         from x
         on conflict (shop_id, code_normalized) do nothing
         returning variant_id)
       insert into variant_packaging (shop_id, variant_id, barcodes_version)
       select app_shop_id(), variant_id, 1 from added group by variant_id
       on conflict (shop_id, variant_id)
       do update set barcodes_version = variant_packaging.barcodes_version + 1`,
      [JSON.stringify(barcodes)],
    );
  }
  const received = await receiveOpeningStock(tx, receipts, base, importId);
  for (const e of received.events) events.push(e);
  await tx.query(
    `with o as (
       update import_rows r set stocked = x.row_number = any($5::int[]), status = x.status, errors = coalesce(x.errors, r.errors), product_id = coalesce(x.product_id, r.product_id),
         variant_id = coalesce(x.variant_id, r.variant_id)
       from jsonb_to_recordset($2::jsonb) as x(row_number int, status text, errors jsonb, product_id uuid, variant_id uuid)
       where r.import_id = $1 and r.row_number = x.row_number),
     a as (${INSERT_AUDIT_EVENTS_SQL.replace('$1', '$3')})
     update import_jobs set checkpoint = greatest(checkpoint, $4), updated_at = now() where id = $1`,
    [
      importId,
      JSON.stringify(outcomes),
      JSON.stringify(events),
      Math.max(...rows.map((r) => r.row_number)),
      received.rows,
    ],
  );
  if (received.outbox.length > 0) {
    await tx.query(
      `insert into outbox_events (shop_id, id, topic, payload)
       select app_shop_id(), x.id, 'inventory.availability_changed', x.payload from jsonb_to_recordset($1::jsonb) as x(id uuid, payload jsonb)`,
      [JSON.stringify(received.outbox)],
    );
  }
}

/**
 * Opening stock (plan 5.12) as receipts written with the chunk: the same idempotency records
 * receive_stock uses (operation inventory.receipts.create, a key per import row and location), the
 * same operations, positions, and ledger entries, and a receipt event each. A key already claimed
 * means that receipt was made: a resumed import never receives twice. Being in the chunk's
 * transaction, records and their stock commit together (risk R4: about one statement per chunk
 * instead of nine per receipt).
 */
async function receiveOpeningStock(
  tx: Tx,
  receipts: Array<{
    key: string;
    row_number: number;
    variant_id: string;
    location_id: string;
    quantity: string;
  }>,
  base: Parameters<typeof auditEvent>[0],
  importId: string,
): Promise<{
  rows: number[];
  events: AuditEvent[];
  outbox: Array<{ id: string; payload: unknown }>;
}> {
  if (receipts.length === 0) return { rows: [], events: [], outbox: [] };
  // Locations must still take stock: active, without children.
  const locations = [...new Set(receipts.map((r) => r.location_id))];
  const usable = new Set(
    (
      await tx.query<{ id: string }>(
        `select l.id from locations l where l.id = any($1::uuid[]) and l.status = 'active'
           and not exists (select 1 from locations c where c.shop_id = l.shop_id and c.parent_id = l.id)`,
        [locations],
      )
    ).map((l) => l.id),
  );
  const input = receipts
    .filter((r) => usable.has(r.location_id))
    .sort((a, b) => (a.variant_id + a.location_id < b.variant_id + b.location_id ? -1 : 1))
    .map((r) => ({ ...r, operation_id: uuidv7(), position_id: uuidv7(), entry_id: uuidv7() }));
  const callerId = `${base.caller.kind}:${base.caller.id}`;
  const made = await tx.query<{
    key: string;
    operation_id: string;
    position_id: string;
    on_hand: string;
  }>(
    `with input as (
       select * from jsonb_to_recordset($1::jsonb) as x(key text, row_number int, variant_id uuid, location_id uuid,
         quantity numeric, operation_id uuid, position_id uuid, entry_id uuid)),
     claimed as (
       insert into idempotency_records (shop_id, caller_id, operation_id, key, request_hash, status, response, completed_at,
         result_operation_id)
       select app_shop_id(), $2, 'inventory.receipts.create', i.key, 'import:' || $5, 'completed',
         jsonb_build_object('operationId', i.operation_id), now(), i.operation_id
       from input i
       on conflict do nothing returning key),
     fresh as (select i.* from input i join claimed c on c.key = i.key),
     ops as (
       insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, external_ref, reason)
       select app_shop_id(), f.operation_id, 'receipt', $3, $4, 'import', 'import ' || $5, 'opening stock' from fresh f),
     pos as (
       insert into inventory_positions (shop_id, id, variant_id, location_id, condition, on_hand)
       select app_shop_id(), min(f.position_id::text)::uuid, f.variant_id, f.location_id, 'sellable', sum(f.quantity)
       from fresh f group by f.variant_id, f.location_id
       on conflict on constraint inventory_positions_identity
       do update set on_hand = inventory_positions.on_hand + excluded.on_hand,
         version = inventory_positions.version + 1, updated_at = now()
       returning id, variant_id, location_id, on_hand),
     entries as (
       insert into inventory_entries (shop_id, id, operation_id, position_id, variant_id, location_id, delta)
       select app_shop_id(), f.entry_id, f.operation_id, p.id, f.variant_id, f.location_id, f.quantity
       from fresh f join pos p on p.variant_id = f.variant_id and p.location_id = f.location_id)
     select f.key, f.operation_id, p.id as position_id, p.on_hand::text as on_hand
     from fresh f join pos p on p.variant_id = f.variant_id and p.location_id = f.location_id`,
    [JSON.stringify(input), callerId, base.caller.kind, base.caller.id, importId],
  );
  const byKey = new Map(input.map((r) => [r.key, r]));
  const events = made.map((m) => {
    const r = byKey.get(m.key)!;
    return auditEvent(base, {
      action: 'inventory.receipt.created',
      phase: 'outcome',
      outcome: 'succeeded',
      target_type: 'variant',
      target_id: r.variant_id,
      operation_id: m.operation_id,
      location_ids: [r.location_id],
      idempotency_key: r.key,
      reason: 'opening stock',
      external_ref: `import ${importId}`,
      changes: {
        positionId: m.position_id,
        condition: 'sellable',
        quantity: r.quantity,
        importId,
        row: r.row_number,
      },
    });
  });
  // One availability event for the chunk, naming its positions: the Shopify push resolves the
  // mapped ones in one query. An event per variant made a 10,000-row import 10,000 outbox rows
  // that held up every other shop's events behind them.
  const positionIds = [...new Set(made.map((m) => m.position_id))];
  return {
    // Rows whose receipts were made now or before; a row with an unusable location keeps stocked false.
    rows: [...new Set(input.map((r) => r.row_number))],
    events,
    outbox: positionIds.length > 0 ? [{ id: uuidv7(), payload: { positionIds } }] : [],
  };
}

// Exports --------------------------------------------------------------------------------

const ExportOut = z.object({
  exportId: Id,
  status: z.string(),
  rowCount: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  downloadUntil: z.string().nullable(),
  downloadPath: z
    .string()
    .nullable()
    .describe(
      'An API path, not a link to share: the file downloads in the dashboard (Products, then Import, Recent exports) while signed in.',
    ),
});

interface ExportRow {
  id: string;
  status: string;
  row_count: number | null;
  error: string | null;
  created_at: Date;
  completed_at: Date | null;
  download_until: Date | null;
  file_deleted_at: Date | null;
  caller: StoredCaller;
  query: z.infer<typeof ExportQuery>;
}

function exportOut(shopId: string, r: ExportRow) {
  const downloadable =
    r.status === 'completed' &&
    !r.file_deleted_at &&
    r.download_until &&
    new Date(r.download_until) > new Date();
  return {
    exportId: r.id,
    status: r.status,
    rowCount: r.row_count,
    error: r.error,
    createdAt: iso(r.created_at) as string,
    completedAt: iso(r.completed_at),
    downloadUntil: iso(r.download_until),
    downloadPath: downloadable ? `/api/v1/shops/${shopId}/exports/${r.id}/file` : null,
  };
}

const ExportQuery = QueryInput.pick({
  mode: true,
  search: true,
  filter: true,
  sort: true,
  fields: true,
  archived: true,
});

async function loadExport(tx: Tx, exportId: string): Promise<ExportRow> {
  const [row] = await tx.query<ExportRow>(
    `select id, status, row_count, error, created_at, completed_at, download_until, file_deleted_at, caller, query
     from export_jobs where id = $1`,
    [exportId],
  );
  if (!row) throw errors.notFound('Export');
  return row;
}

export const createExport = defineOperation({
  id: 'exports.create',
  summary: 'Export products or variants as CSV',
  description:
    'Exports what a catalog query returns (the same mode, search, filter, sort, and fields), in a format the import accepts. Runs as a job; the file is ready for 24 hours and deleted after 7 days. The person downloads it in the Airstock dashboard: Products, then Import, under Recent exports (or through the API).',
  kind: 'command',
  scope: 'shop',
  input: ExportQuery.partial(),
  output: z.object({ export: ExportOut }),
  permission: 'exports.run',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.export.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/exports', status: 201 },
  mcp: { tool: TOOL, action: 'start_export', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const exportId = ctx.newId();
    const query = {
      mode: input.mode ?? 'variants',
      archived: input.archived ?? 'exclude',
      ...input,
    };
    await ctx.tx.query(
      `insert into export_jobs (shop_id, id, caller, query) values (app_shop_id(), $1, $2, $3)`,
      [exportId, JSON.stringify(storeCaller(ctx.caller)), JSON.stringify(query)],
    );
    const row = await loadExport(ctx.tx, exportId);
    return {
      result: { export: exportOut(ctx.shopId, row) },
      audit: { targetType: 'export', targetId: exportId, changes: { query } },
      outbox: [{ topic: 'catalog.export.run', payload: { exportId } }],
    };
  },
});

export const getExport = defineOperation({
  id: 'exports.get',
  summary: 'Get an export’s status',
  kind: 'read',
  scope: 'shop',
  input: z.object({ exportId: Id }),
  output: z.object({ export: ExportOut }),
  permission: 'exports.run',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.export.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/exports/{exportId}' },
  mcp: { tool: TOOL, action: 'get_export', readOnly: true, destructive: false },
  async handler(ctx, input) {
    return {
      result: { export: exportOut(ctx.shopId, await loadExport(ctx.tx, input.exportId)) },
      audit: { targetType: 'export', targetId: input.exportId },
    };
  },
});

export const listExports = defineOperation({
  id: 'exports.list',
  summary: 'List recent exports',
  kind: 'read',
  scope: 'shop',
  input: z.object({}),
  output: z.object({ exports: z.array(ExportOut) }),
  permission: 'exports.run',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.exports.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/exports' },
  mcp: {
    exception:
      'The dashboard lists exports; MCP clients follow the export they started with get_export.',
  },
  async handler(ctx) {
    const rows = await ctx.tx.query<ExportRow>(
      `select id, status, row_count, error, created_at, completed_at, download_until, file_deleted_at, caller, query
       from export_jobs order by created_at desc limit 50`,
    );
    return {
      result: { exports: rows.map((r) => exportOut(ctx.shopId, r)) },
      audit: { targetType: 'export', targetId: 'list' },
    };
  },
});

export const downloadExport = defineOperation({
  id: 'exports.download',
  summary: 'Record an export download and return its file',
  description: 'Used by the download route; each download is its own event (plan 5.12).',
  kind: 'command',
  scope: 'shop',
  input: z.object({ exportId: Id }),
  output: z.object({ fileKey: z.string(), fileName: z.string() }),
  permission: 'exports.run',
  connectionScope: 'catalog:read',
  audit: { action: 'catalog.export.downloaded' },
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/exports/{exportId}/download' },
  mcp: { exception: 'Binary download: the file comes from the dashboard or the API.' },
  async handler(ctx, input) {
    const row = await loadExport(ctx.tx, input.exportId);
    if (row.status !== 'completed')
      throw errors.conflict('export_not_ready', 'The export is not ready yet.');
    if (row.file_deleted_at || !row.download_until || new Date(row.download_until) <= new Date()) {
      throw errors.conflict('export_expired', 'This download has expired. Export again.');
    }
    return {
      result: {
        fileKey: exportFileKey(ctx.shopId, input.exportId),
        fileName: `airstock-${row.query.mode}-${input.exportId.slice(-8)}.csv`,
      },
      audit: { targetType: 'export', targetId: input.exportId, context: { rows: row.row_count } },
    };
  },
});

/**
 * Writes the export file: the caller's query, page by page, as importable CSV. Field visibility
 * and location scope are the caller's, as when they query.
 */
export async function runExportJob(
  deps: JobDeps,
  shopId: string,
  exportId: string,
): Promise<'done' | 'missing'> {
  const job = await deps.db.transaction({ shopId, userId: null }, async (tx) => {
    const [row] = await tx.query<ExportRow>(
      `update export_jobs set status = 'running' where id = $1 and status in ('pending', 'running')
       returning id, status, row_count, error, created_at, completed_at, download_until, file_deleted_at, caller, query`,
      [exportId],
    );
    return row ?? null;
  });
  if (!job) return 'missing';
  try {
    const caller = await jobCaller(deps.db, shopId, job.caller);
    const membership = caller.membership!;
    const locationScope = membership.allLocations ? null : membership.locationScopeIds;
    const mode = job.query.mode ?? 'variants';
    const lines: string[] = [];
    let count = 0;
    let cursor: string | undefined;
    let columns: { fields: Awaited<ReturnType<typeof loadFields>>; options: string[] } | null =
      null;
    do {
      const page = await deps.db.transaction(
        { shopId, userId: caller.userId, readOnly: true },
        async (tx) => {
          const ctx = {
            tx,
            shopId,
            caller,
            membership,
            requestId: uuidv7(),
            attemptId: null,
            locationScope,
            newId: () => uuidv7(),
            event: (f: Pick<AuditEvent, 'action' | 'outcome'> & Partial<AuditEvent>) =>
              auditEvent(
                { shopId, caller, requestId: uuidv7(), attemptId: null, idempotencyKey: null },
                { phase: 'outcome', ...f },
              ),
          } satisfies HandlerContext;
          const fields = visible(await loadFields(tx), membership).filter((f) => f.type !== 'file');
          const wanted = job.query.fields?.length
            ? fields.filter((f) => job.query.fields!.includes(f.key))
            : fields;
          const result = await runQuery(ctx, {
            mode,
            archived: job.query.archived ?? 'exclude',
            ...(job.query.search ? { search: job.query.search } : {}),
            ...(job.query.filter ? { filter: job.query.filter } : {}),
            ...(job.query.sort ? { sort: job.query.sort } : {}),
            fields: [
              ...wanted.map((f) => f.key),
              'weight',
              ...(mode === 'variants' ? ['available'] : []),
            ],
            limit: 200,
            ...(cursor ? { cursor } : {}),
          });
          const productIds = [...new Set(result.rows.map((r) => r.productId))];
          const options = await tx.query<{
            product_id: string;
            name: string;
            position: number;
            values: Array<{ id: string; label: string }>;
          }>(
            `select o.product_id, o.name, o.position,
             coalesce((select json_agg(json_build_object('id', v.id, 'label', v.label)) from product_option_values v where v.option_id = o.id), '[]') as values
           from product_options o where o.product_id = any($1::uuid[]) order by o.position`,
            [productIds],
          );
          const families = await tx.query<{ id: string; name: string }>(
            'select id, name from product_families',
          );
          const variantOptions =
            mode === 'variants'
              ? await tx.query<{ id: string; option_value_ids: string[] }>(
                  'select id, option_value_ids from variants where id = any($1::uuid[])',
                  [result.rows.map((r) => r.variantId)],
                )
              : [];
          // The variant's own first barcode, so an export imports back unchanged.
          const barcodes =
            mode === 'variants'
              ? await tx.query<{ variant_id: string; code: string }>(
                  `select distinct on (variant_id) variant_id, code from barcodes
                   where variant_id = any($1::uuid[]) and pack_id is null
                   order by variant_id, position`,
                  [result.rows.map((r) => r.variantId)],
                )
              : [];
          // The preferred supplier and its SKU, without costs (they need costs.read, ADR 0019).
          const suppliers =
            mode === 'variants'
              ? await tx.query<{ variant_id: string; name: string; supplier_sku: string | null }>(
                  `select distinct on (si.variant_id) si.variant_id, s.name, si.supplier_sku
                   from supplier_items si join suppliers s on s.shop_id = si.shop_id and s.id = si.supplier_id
                   where si.variant_id = any($1::uuid[]) and si.status = 'active'
                   order by si.variant_id, si.preferred desc, si.id`,
                  [result.rows.map((r) => r.variantId)],
                )
              : [];
          return { result, wanted, options, families, variantOptions, barcodes, suppliers };
        },
      );
      if (!columns) {
        columns = { fields: page.wanted, options: [] };
      }
      for (const o of page.options)
        if (!columns.options.includes(o.name)) columns.options.push(o.name);
      for (const r of page.result.rows) {
        const vo = page.variantOptions.find((v) => v.id === r.variantId)?.option_value_ids ?? [];
        const optionCells = columns.options.map((name) => {
          const option = page.options.find((o) => o.product_id === r.productId && o.name === name);
          return option?.values.find((v) => vo.includes(v.id))?.label ?? '';
        });
        const weight = r.values.weight?.value as { value: string; unit: string } | null | undefined;
        lines.push(
          csvLine([
            r.productId,
            r.name,
            r.sku ?? '',
            page.barcodes.find((b) => b.variant_id === r.variantId)?.code ?? '',
            page.suppliers.find((x) => x.variant_id === r.variantId)?.name ?? '',
            page.suppliers.find((x) => x.variant_id === r.variantId)?.supplier_sku ?? '',
            r.price ?? r.priceRange?.min ?? '',
            r.productStatus,
            page.families.find((f) => f.id === r.familyId)?.name ?? '',
            r.tags.join(', '),
            weight && r.values.weight?.source === 'own' ? `${weight.value} ${weight.unit}` : '',
            ...optionCells,
            ...columns.fields.map((f) =>
              exportCell(
                f,
                r.values[f.key]?.source === 'inherited' ? null : r.values[f.key]?.value,
              ),
            ),
            r.available ?? '',
          ]),
        );
        count++;
      }
      cursor = page.result.nextCursor ?? undefined;
    } while (cursor && count < 200_000);
    const header = csvLine([
      'product',
      'name',
      'sku',
      'barcode',
      'supplier',
      'supplier_sku',
      'price',
      'status',
      'family',
      'tags',
      'weight',
      ...(columns?.options ?? []).map((o) => `option:${o}`),
      ...(columns?.fields ?? []).map((f) => f.key),
      'available',
    ]);
    // Byte-order mark: spreadsheets then read the file as UTF-8.
    await deps.files.put(
      exportFileKey(shopId, exportId),
      `﻿${[header, ...lines].join('\r\n')}\r\n`,
      'text/csv; charset=utf-8',
    );
    await deps.db.transaction({ shopId, userId: null }, (tx) =>
      tx.query(
        `update export_jobs set status = 'completed', file_key = $2, row_count = $3, completed_at = now(),
           download_until = now() + interval '24 hours', delete_after = now() + interval '7 days' where id = $1`,
        [exportId, exportFileKey(shopId, exportId), count],
      ),
    );
    await deps.audit.send([
      auditEvent(
        { shopId, caller, requestId: uuidv7(), attemptId: null, idempotencyKey: null },
        {
          action: 'catalog.export.completed',
          phase: 'outcome',
          outcome: 'succeeded',
          target_type: 'export',
          target_id: exportId,
          changes: { rows: count },
        },
      ),
    ]);
  } catch (error) {
    if (error instanceof AppError) {
      await deps.db.transaction({ shopId, userId: null }, (tx) =>
        tx.query(`update export_jobs set status = 'failed', error = $2 where id = $1`, [
          exportId,
          error.message,
        ]),
      );
      return 'done';
    }
    throw error;
  }
  return 'done';
}

/** A stored value as the import reads it back: labels, "1.2 kg", amounts, yes or no. */
function exportCell(def: { type: string; key: string }, value: unknown): string {
  if (value === null || value === undefined) return '';
  switch (def.type) {
    case 'single_select':
    case 'multi_select':
      return displayValue(def as never, value)?.replace(/, /g, '; ') ?? '';
    case 'boolean':
      return value ? 'yes' : 'no';
    case 'money':
      return (value as { amount: string }).amount;
    case 'measurement': {
      const m = value as { value: string; unit: string };
      return `${m.value} ${m.unit}`;
    }
    case 'relationship':
      return (value as string[]).join('; ');
    default:
      return String(value);
  }
}

/** Export files past their 7 days are deleted; the history stays (plan 5.12). */
export async function sweepExportFiles(db: Database, files: FileAccess): Promise<number> {
  const due = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query<{ shop_id: string; id: string; file_key: string }>(
      'select shop_id, id, file_key from expired_export_files($1)',
      [100],
    ),
  );
  for (const e of due) {
    await files.delete(e.file_key);
    await db.transaction({ shopId: e.shop_id, userId: null }, (tx) =>
      tx.query('update export_jobs set file_deleted_at = now() where id = $1', [e.id]),
    );
  }
  return due.length;
}
