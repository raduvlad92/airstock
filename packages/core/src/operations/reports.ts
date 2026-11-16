import type { Database, Tx } from '@airstock/db';
import { z } from 'zod';
import { auditEvent } from '../audit.ts';
import { csvLine } from '../csv.ts';
import { AppError, errors } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import { effectivePermissions, type Permission } from '../permissions.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import {
  MOVEMENT_TYPES,
  REPORT_GROUPS,
  REPORT_TYPES,
  REPORTS,
  type ReportColumn,
  type ReportType,
} from '../reports/catalog.ts';
import {
  REPORT_PAGE_MAX,
  REPORT_STATEMENT_TIMEOUT_MS,
  type ReportFilters,
  type ReportResult,
  runReport,
  tooLarge,
} from '../reports/run.ts';
import { Id, iso } from '../schemas.ts';
import { insertWebhookEvents, webhookEvent } from '../webhooks/events.ts';
import {
  exportFileKey,
  type JobDeps,
  jobCaller,
  type StoredCaller,
  storeCaller,
} from './imports.ts';
import { Flag, isSet, StockCondition } from './inventory.ts';

// Reports (PRD 3.5, plan Section 5.15, D15): the eight standard reports as reads, saved reports
// private to their owner or shared with the shop, and CSV exports through the export jobs
// (ADR 0018). Location scope applies to every report, and costs need costs.read.

const TOOL = 'run_report';

const Report = z
  .enum(REPORT_TYPES)
  .describe(
    'stock_on_hand: units by variant, location, condition, and lot with packs. low_stock: rules at or below their reorder point, with on order and a suggested reorder. movements: receipts, transfers, fulfillments, adjustments, returns, and counts over a period. inventory_value: units times moving average cost, now or at a past date (needs costs.read). cost_of_goods: cost of fulfilled units over a period (needs costs.read). purchasing: open purchase orders, on order, overdue. expiring_lots: lots expiring within days. shortages: open shortages from accepted orders.',
  );

/**
 * The filters every report shares, flat so MCP clients read one schema. Each report takes some
 * of them (REPORTS[type].filters); the others are left out and named in `ignoredFilters`.
 */
const FilterFields = {
  warehouseId: Id.optional().describe('Only this warehouse.'),
  locationId: Id.optional().describe('Only this location and the locations inside it.'),
  familyId: Id.optional().describe('Only products of this family.'),
  categoryId: Id.optional().describe('Only products in this category (a Category option ID).'),
  supplierId: Id.optional().describe(
    'Only variants this supplier sells; for purchasing, only this supplier’s orders.',
  ),
  variantId: Id.optional().describe('Only this variant.'),
  search: z.string().trim().min(1).max(200).optional().describe('Part of a SKU or product name.'),
  condition: StockCondition.optional().describe('stock_on_hand: only this stock condition.'),
  at: z
    .string()
    .max(40)
    .optional()
    .describe(
      'inventory_value: value at this moment. A date (2026-12-01) means the end of that day in the shop’s time zone; now when left out.',
    ),
  from: z
    .string()
    .max(40)
    .optional()
    .describe(
      'movements, cost_of_goods: start of the period. A date means the start of that day in the shop’s time zone; 30 days before `to` when left out.',
    ),
  to: z
    .string()
    .max(40)
    .optional()
    .describe(
      'movements, cost_of_goods: end of the period. A date includes that whole day; a time is exclusive; now when left out.',
    ),
  days: z.coerce
    .number()
    .int()
    .min(0)
    .max(3650)
    .optional()
    .describe('expiring_lots: lots expiring within this many days (default 30), and expired ones.'),
  movementType: z
    .enum(MOVEMENT_TYPES)
    .optional()
    .describe('movements: only this type of movement.'),
  overdueOnly: Flag.optional().describe('purchasing: only lines past their expected date.'),
  groupBy: z
    .enum(REPORT_GROUPS)
    .optional()
    .describe(
      'Rows per: stock_on_hand position (default), variant, location; movements variant (default), location, type, entry; inventory_value location (default), warehouse, category, family, variant; cost_of_goods variant (default), location, warehouse, category, family; purchasing line (default), order, variant, supplier; expiring_lots lot (default), position; shortages order (default), variant.',
    ),
  sort: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe('A column key from the result’s columns; prefix "-" for descending.'),
};

const FilterObject = z.object(FilterFields);
type FilterInput = z.infer<typeof FilterObject>;

const Cursor = z
  .string()
  .max(2000)
  .optional()
  .describe('nextCursor from the previous page of the same run.');
const Limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(REPORT_PAGE_MAX)
  .default(100)
  .describe(`Rows per page, at most ${REPORT_PAGE_MAX}.`);

const ColumnOut = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['text', 'quantity', 'money', 'integer', 'date', 'datetime', 'boolean']),
  cost: z.boolean().optional(),
  total: z.boolean().optional(),
});

const ResultOut = z.object({
  report: z.enum(REPORT_TYPES),
  title: z.string(),
  groupBy: z.enum(REPORT_GROUPS),
  groupLabel: z.string(),
  sort: z.string(),
  columns: z.array(ColumnOut).describe('Cost columns appear only with costs.read.'),
  rows: z
    .array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .describe(
      'One object per row, keyed by column key, plus the row’s `key`. Decimals are exact strings.',
    ),
  totals: z
    .record(z.string(), z.string())
    .describe('Sums over every row the filters select, not only this page.'),
  rowCount: z.number(),
  nextCursor: z.string().nullable(),
  partial: z
    .boolean()
    .describe('True when your access is limited to some locations: totals cover only those.'),
  costVisible: z.boolean(),
  currency: z.string(),
  at: z.string().nullable().describe('inventory_value: the moment valued.'),
  from: z.string().nullable(),
  to: z.string().nullable(),
  days: z.number().nullable(),
  ignoredFilters: z.array(z.string()).describe('Filters this report does not take.'),
});

function permissions(ctx: Pick<HandlerContext, 'membership'>): ReadonlySet<Permission> {
  return ctx.membership ? effectivePermissions(ctx.membership) : new Set();
}

const canSeeCosts = (ctx: Pick<HandlerContext, 'membership'>) => permissions(ctx).has('costs.read');

/** The filters as stored and run: only those given, flags as booleans. */
function cleanFilters(input: Partial<FilterInput>): ReportFilters {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(FilterFields) as Array<keyof FilterInput>) {
    const value = input[key];
    if (value === undefined) continue;
    out[key] = key === 'overdueOnly' ? isSet(value as z.infer<typeof Flag>) : value;
  }
  return out as ReportFilters;
}

/** Checks what can be checked before running: the grouping and the cost permission. */
function checkDefinition(report: ReportType, filters: ReportFilters, costs: boolean): void {
  const info = REPORTS[report];
  if (info.costs === 'required' && !costs) {
    throw errors.forbidden(
      `The ${info.title.toLowerCase()} report shows costs; it needs costs.read.`,
    );
  }
  if (filters.groupBy && !info.groups.includes(filters.groupBy)) {
    throw errors.validation([
      {
        path: 'groupBy',
        message: `${info.title} groups by ${info.groups.map((g) => `"${g}"`).join(', ')}.`,
      },
    ]);
  }
}

/** Runs a report in the caller's request, within the statement budget (D15). */
async function runInRequest(
  ctx: HandlerContext,
  report: ReportType,
  filters: ReportFilters,
  page: { cursor?: string | undefined; limit: number },
): Promise<ReportResult> {
  await ctx.tx.query(`select set_config('statement_timeout', $1, true)`, [
    String(REPORT_STATEMENT_TIMEOUT_MS),
  ]);
  try {
    return await runReport(
      { tx: ctx.tx, locationScope: ctx.locationScope, costs: canSeeCosts(ctx) },
      report,
      filters,
      page,
    );
  } catch (error) {
    if ((error as { code?: string }).code === '57014') throw tooLarge();
    throw error;
  }
}

/** What the run's access event records: the report, its filters, and what it returned. */
function runContext(result: ReportResult, filters: ReportFilters, extra: object = {}) {
  return {
    report: result.report,
    filters,
    groupBy: result.groupBy,
    sort: result.sort,
    rows: result.rows.length,
    rowCount: result.rowCount,
    partial: result.partial,
    costVisible: result.costVisible,
    ...extra,
  };
}

export const runStandardReport = defineOperation({
  id: 'reports.run',
  summary: 'Run a standard report',
  description:
    'Use this when someone asks for a report or a summary across many items: stock on hand, what is running low, movements over a period, what the stock is worth now or on a past date (inventory_value with `at`), cost of goods sold, open purchase orders, expiring lots, or shortages. Returns columns, rows (keyset pages), and totals over all rows. Not for one variant’s live stock (get_stock). Totals cover only your locations when `partial` is true; costs and values need costs.read.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ report: Report, ...FilterFields, cursor: Cursor, limit: Limit }),
  output: ResultOut,
  permission: 'reports.run',
  connectionScope: 'inventory:read',
  audit: { action: 'reports.report.run' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/reports/{report}' },
  mcp: { tool: TOOL, action: 'run', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const filters = cleanFilters(input);
    const result = await runInRequest(ctx, input.report, filters, {
      cursor: input.cursor,
      limit: input.limit,
    });
    return {
      result,
      audit: {
        targetType: 'report',
        targetId: input.report,
        context: runContext(result, filters, input.cursor ? { page: 'next' } : {}),
      },
    };
  },
});

// Saved reports -----------------------------------------------------------------------------

const SavedReportOut = z.object({
  id: Id,
  name: z.string(),
  report: z.enum(REPORT_TYPES),
  title: z.string().describe('The standard report it runs.'),
  filters: z.record(z.string(), z.unknown()),
  shared: z.boolean(),
  mine: z.boolean(),
  canEdit: z.boolean(),
  version: z.number(),
  updatedAt: z.string(),
});
type SavedReportView = z.infer<typeof SavedReportOut>;

interface SavedRow {
  id: string;
  name: string;
  report: ReportType;
  filters: ReportFilters;
  shared: boolean;
  owner_membership_id: string;
  version: number;
  updated_at: Date;
}

const SAVED_COLUMNS = 'id, name, report, filters, shared, owner_membership_id, version, updated_at';

function savedView(ctx: HandlerContext, r: SavedRow): SavedReportView {
  const mine = r.owner_membership_id === ctx.membership?.id;
  return {
    id: r.id,
    name: r.name,
    report: r.report,
    title: REPORTS[r.report].title,
    filters: r.filters as Record<string, unknown>,
    shared: r.shared,
    mine,
    canEdit: mine || (r.shared && permissions(ctx).has('reports.manage')),
    version: r.version,
    updatedAt: iso(r.updated_at)!,
  };
}

/** Another member's private report does not exist for the caller. */
async function loadSaved(ctx: HandlerContext, id: string, lock = false): Promise<SavedRow> {
  const [row] = await ctx.tx.query<SavedRow>(
    `select ${SAVED_COLUMNS} from saved_reports where id = $1 ${lock ? 'for update' : ''}`,
    [id],
  );
  if (!row || (!row.shared && row.owner_membership_id !== ctx.membership?.id)) {
    throw errors.notFound('Saved report');
  }
  return row;
}

/** A private report changes only by its owner; a shared one also by reports.manage. */
function assertCanEdit(ctx: HandlerContext, row: SavedRow, what: string): void {
  if (row.owner_membership_id === ctx.membership?.id) return;
  if (!permissions(ctx).has('reports.manage')) {
    throw errors.forbidden(`${what} a report another member shared needs reports.manage.`);
  }
}

const SAVED_EXCEPTION =
  'Saved reports are named and shared in the dashboard or through the API; over MCP, run_report lists and runs them.';

export const listSavedReports = defineOperation({
  id: 'reports.saved.list',
  summary: 'List saved reports',
  description:
    'Use this when someone asks which reports they saved, or before running one by name: your saved reports and those shared with the shop, with their report type and filters.',
  kind: 'read',
  scope: 'shop',
  input: z.object({ report: Report.optional() }),
  output: z.object({ savedReports: z.array(SavedReportOut) }),
  permission: 'reports.run',
  connectionScope: 'inventory:read',
  audit: { action: 'reports.saved_reports.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/saved-reports' },
  mcp: { tool: TOOL, action: 'list_saved', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const rows = await ctx.tx.query<SavedRow>(
      `select ${SAVED_COLUMNS} from saved_reports
       where (shared or owner_membership_id = $1) and ($2::text is null or report = $2)
       order by lower(name), id limit 200`,
      [ctx.membership!.id, input.report ?? null],
    );
    return {
      result: { savedReports: rows.map((r) => savedView(ctx, r)) },
      audit: { targetType: 'saved_report', targetId: 'list', context: { input } },
    };
  },
});

export const runSavedReport = defineOperation({
  id: 'reports.saved.run',
  summary: 'Run a saved report',
  description:
    'Use this to run a report someone saved (find it with list_saved). Filters given here replace the saved ones for this run only, such as `at` for the value on another date.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    savedReportId: Id.describe('The saved report.'),
    ...FilterFields,
    cursor: Cursor,
    limit: Limit,
  }),
  output: ResultOut.extend({ savedReport: SavedReportOut }),
  permission: 'reports.run',
  connectionScope: 'inventory:read',
  audit: { action: 'reports.saved_report.run' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/saved-reports/{savedReportId}/run' },
  mcp: { tool: TOOL, action: 'run_saved', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const saved = await loadSaved(ctx, input.savedReportId);
    const filters = { ...saved.filters, ...cleanFilters(input) };
    const result = await runInRequest(ctx, saved.report, filters, {
      cursor: input.cursor,
      limit: input.limit,
    });
    return {
      result: { ...result, savedReport: savedView(ctx, saved) },
      audit: {
        targetType: 'saved_report',
        targetId: saved.id,
        context: runContext(result, filters, { savedReportId: saved.id, name: saved.name }),
      },
    };
  },
});

export const saveReport = defineOperation({
  id: 'reports.saved.save',
  summary: 'Save a report',
  description:
    'Without savedReportId, saves a new report: a standard report with its filters and a name. Private unless shared; sharing, and changing or deleting a report another member shared, needs reports.manage.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    savedReportId: Id.optional(),
    expectedVersion: z.number().int().optional(),
    name: z.string().trim().min(1).max(100),
    report: Report,
    filters: FilterObject.default({}),
    shared: z.boolean().default(false),
  }),
  output: z.object({ savedReport: SavedReportOut }),
  permission: 'reports.run',
  connectionScope: 'inventory:read',
  audit: { action: 'reports.saved_report.saved' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/saved-reports' },
  mcp: { exception: SAVED_EXCEPTION },
  async handler(ctx, input) {
    const filters = cleanFilters(input.filters);
    checkDefinition(input.report, filters, canSeeCosts(ctx));
    const manage = permissions(ctx).has('reports.manage');
    const definition = { name: input.name, report: input.report, filters, shared: input.shared };
    if (!input.savedReportId) {
      if (input.shared && !manage)
        throw errors.forbidden('Sharing a report with the shop needs reports.manage.');
      const id = ctx.newId();
      await ctx.tx.query(
        `insert into saved_reports (shop_id, id, owner_membership_id, name, report, filters, shared)
         values (app_shop_id(), $1, $2, $3, $4, $5, $6)`,
        [id, ctx.membership!.id, input.name, input.report, JSON.stringify(filters), input.shared],
      );
      return {
        result: { savedReport: savedView(ctx, await loadSaved(ctx, id)) },
        audit: { targetType: 'saved_report', targetId: id, changes: definition },
      };
    }
    const row = await loadSaved(ctx, input.savedReportId, true);
    assertCanEdit(ctx, row, 'Changing');
    if (input.shared !== row.shared && !manage) {
      throw errors.forbidden(
        input.shared
          ? 'Sharing a report with the shop needs reports.manage.'
          : 'Making a shared report private needs reports.manage.',
      );
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
      throw errors.conflict('version_conflict', 'The report changed since you opened it.', {
        currentVersion: row.version,
      });
    }
    await ctx.tx.query(
      `update saved_reports set name = $2, report = $3, filters = $4, shared = $5,
         version = version + 1, updated_at = now()
       where id = $1`,
      [row.id, input.name, input.report, JSON.stringify(filters), input.shared],
    );
    return {
      result: { savedReport: savedView(ctx, await loadSaved(ctx, row.id)) },
      audit: {
        targetType: 'saved_report',
        targetId: row.id,
        changes: {
          from: { name: row.name, report: row.report, filters: row.filters, shared: row.shared },
          to: definition,
        },
      },
    };
  },
});

export const deleteSavedReport = defineOperation({
  id: 'reports.saved.delete',
  summary: 'Delete a saved report',
  kind: 'command',
  scope: 'shop',
  input: z.object({ savedReportId: Id }),
  output: z.object({ deleted: z.boolean() }),
  permission: 'reports.run',
  connectionScope: 'inventory:read',
  audit: { action: 'reports.saved_report.deleted' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/saved-reports/{savedReportId}/delete' },
  mcp: { exception: SAVED_EXCEPTION },
  async handler(ctx, input) {
    const row = await loadSaved(ctx, input.savedReportId, true);
    assertCanEdit(ctx, row, 'Deleting');
    await ctx.tx.query('delete from saved_reports where id = $1', [row.id]);
    return {
      result: { deleted: true },
      audit: {
        targetType: 'saved_report',
        targetId: row.id,
        changes: { name: row.name, report: row.report, shared: row.shared },
      },
    };
  },
});

// CSV exports ---------------------------------------------------------------------------------

const ReportExportOut = z.object({
  exportId: Id,
  report: z.enum(REPORT_TYPES),
  title: z.string(),
  savedReportId: Id.nullable(),
  name: z.string().nullable().describe('The saved report’s name, when it was one.'),
  status: z.string(),
  rowCount: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  downloadUntil: z.string().nullable(),
  downloadPath: z
    .string()
    .nullable()
    .describe('An API path: the file downloads in the dashboard (Reports) while signed in.'),
});

interface ReportQuery {
  report: ReportType;
  filters: ReportFilters;
  savedReportId: string | null;
  name: string | null;
}

interface ReportExportRow {
  id: string;
  status: string;
  row_count: number | null;
  error: string | null;
  created_at: Date;
  completed_at: Date | null;
  download_until: Date | null;
  file_deleted_at: Date | null;
  caller: StoredCaller;
  query: ReportQuery;
}

const EXPORT_COLUMNS =
  'id, status, row_count, error, created_at, completed_at, download_until, file_deleted_at, caller, query';

function reportExportOut(shopId: string, r: ReportExportRow): z.infer<typeof ReportExportOut> {
  const downloadable =
    r.status === 'completed' &&
    !r.file_deleted_at &&
    r.download_until &&
    new Date(r.download_until) > new Date();
  return {
    exportId: r.id,
    report: r.query.report,
    title: REPORTS[r.query.report].title,
    savedReportId: r.query.savedReportId,
    name: r.query.name,
    status: r.status,
    rowCount: r.row_count,
    error: r.error,
    createdAt: iso(r.created_at)!,
    completedAt: iso(r.completed_at),
    downloadUntil: iso(r.download_until),
    downloadPath: downloadable ? `/api/v1/shops/${shopId}/exports/${r.id}/file` : null,
  };
}

export const REPORT_EXPORT_TOPIC = 'reports.export.run';

const EXPORT_EXCEPTION =
  'Report files are exported and downloaded in the dashboard (Reports) or through the API; over MCP, run_report returns the rows.';

export const exportReport = defineOperation({
  id: 'reports.export',
  summary: 'Export a report as CSV',
  description:
    'Starts a job that writes every row of a standard or saved report to a CSV file, with a totals line. The file can be downloaded for 24 hours and is deleted after 7 days; each download is logged. Location scope and costs.read apply as when running the report. The file downloads from the export file route, which needs catalog:read for an API credential, as for catalog exports.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    report: Report.optional().describe('A standard report; or give savedReportId.'),
    savedReportId: Id.optional(),
    filters: FilterObject.default({}).describe(
      'The report’s filters; for a saved report, these replace the saved ones.',
    ),
  }),
  output: z.object({ export: ReportExportOut }),
  permission: 'exports.run',
  connectionScope: 'inventory:read',
  audit: { action: 'reports.export.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/report-exports', status: 201 },
  mcp: { exception: EXPORT_EXCEPTION },
  async handler(ctx, input) {
    if (!permissions(ctx).has('reports.run'))
      throw errors.forbidden('Exporting a report needs reports.run.');
    let query: ReportQuery;
    if (input.savedReportId) {
      const saved = await loadSaved(ctx, input.savedReportId);
      query = {
        report: saved.report,
        filters: { ...saved.filters, ...cleanFilters(input.filters) },
        savedReportId: saved.id,
        name: saved.name,
      };
    } else if (input.report) {
      query = {
        report: input.report,
        filters: cleanFilters(input.filters),
        savedReportId: null,
        name: null,
      };
    } else {
      throw errors.validation([{ path: 'report', message: 'Give a report or a savedReportId.' }]);
    }
    checkDefinition(query.report, query.filters, canSeeCosts(ctx));
    const exportId = ctx.newId();
    await ctx.tx.query(
      `insert into export_jobs (shop_id, id, kind, caller, query) values (app_shop_id(), $1, 'report', $2, $3)`,
      [exportId, JSON.stringify(storeCaller(ctx.caller)), JSON.stringify(query)],
    );
    const [row] = await ctx.tx.query<ReportExportRow>(
      `select ${EXPORT_COLUMNS} from export_jobs where id = $1`,
      [exportId],
    );
    return {
      result: { export: reportExportOut(ctx.shopId, row!) },
      audit: { targetType: 'export', targetId: exportId, changes: { ...query } },
      outbox: [{ topic: REPORT_EXPORT_TOPIC, payload: { exportId } }],
    };
  },
});

export const listReportExports = defineOperation({
  id: 'reports.exports.list',
  summary: 'List recent report exports',
  kind: 'read',
  scope: 'shop',
  input: z.object({}),
  output: z.object({ exports: z.array(ReportExportOut) }),
  permission: 'exports.run',
  connectionScope: 'inventory:read',
  audit: { action: 'reports.exports.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/report-exports' },
  mcp: { exception: EXPORT_EXCEPTION },
  async handler(ctx) {
    const rows = await ctx.tx.query<ReportExportRow>(
      `select ${EXPORT_COLUMNS} from export_jobs where kind = 'report'
       order by created_at desc limit 50`,
    );
    return {
      result: { exports: rows.map((r) => reportExportOut(ctx.shopId, r)) },
      audit: { targetType: 'export', targetId: 'list' },
    };
  },
});

/** Exports read every row; each page has this many. */
const EXPORT_PAGE = 5_000;
/** A file holds at most this many rows; the last line says when it stopped there. */
const EXPORT_MAX_ROWS = 200_000;
/** A job's statements may run this long (an interactive run stops at 25 seconds). */
const EXPORT_STATEMENT_TIMEOUT_MS = 300_000;

/** One CSV cell: exact decimals, yes or no, and dates as the API gives them. */
function csvCell(col: ReportColumn, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (col.type === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

/**
 * Writes a report export (D15): the report run as the member who started it (their location
 * scope and cost permission now), page by page in one read-only transaction, then the CSV with a
 * totals line. Logged like catalog exports: completion here, each download by the file route.
 */
export async function runReportExportJob(
  deps: Pick<JobDeps, 'db' | 'audit' | 'files'>,
  shopId: string,
  exportId: string,
): Promise<'done' | 'missing'> {
  const job = await deps.db.transaction({ shopId, userId: null }, async (tx) => {
    const [row] = await tx.query<ReportExportRow>(
      `update export_jobs set status = 'running'
       where id = $1 and kind = 'report' and status in ('pending', 'running')
       returning ${EXPORT_COLUMNS}`,
      [exportId],
    );
    return row ?? null;
  });
  if (!job) return 'missing';
  const { report, filters } = job.query;
  try {
    const caller = await jobCaller(deps.db, shopId, job.caller);
    const membership = caller.membership!;
    const granted = effectivePermissions(membership);
    if (!granted.has('reports.run') || !granted.has('exports.run'))
      throw errors.forbidden('The member who started this export can no longer run reports.');
    const costs = granted.has('costs.read');
    const locationScope = membership.allLocations ? null : membership.locationScopeIds;
    const { first, rows, truncated } = await deps.db.transaction(
      { shopId, userId: caller.userId, readOnly: true },
      async (tx) => {
        await tx.query(`select set_config('statement_timeout', $1, true)`, [
          String(EXPORT_STATEMENT_TIMEOUT_MS),
        ]);
        const env = { tx, locationScope, costs };
        let cursor: string | undefined;
        let first: ReportResult | null = null;
        const all: ReportResult['rows'] = [];
        do {
          const page = await runReport(env, report, filters, { cursor, limit: EXPORT_PAGE });
          first ??= page;
          all.push(...page.rows);
          cursor = page.nextCursor ?? undefined;
        } while (cursor && all.length < EXPORT_MAX_ROWS);
        return { first: first!, rows: all, truncated: cursor !== undefined };
      },
    );
    const columns = first.columns;
    const label = (col: ReportColumn) =>
      col.type === 'money' ? `${col.label} (${first.currency})` : col.label;
    const lines = [csvLine(columns.map(label))];
    for (const row of rows) lines.push(csvLine(columns.map((col) => csvCell(col, row[col.key]))));
    const totalLabel = first.partial ? 'Total (your locations only)' : 'Total';
    lines.push(
      csvLine(columns.map((col, i) => (i === 0 ? totalLabel : (first.totals[col.key] ?? null)))),
    );
    if (truncated)
      lines.push(csvLine([`Stopped after ${EXPORT_MAX_ROWS} rows. Narrow the filters.`]));
    await deps.files.put(
      exportFileKey(shopId, exportId),
      `﻿${lines.join('\r\n')}\r\n`,
      'text/csv; charset=utf-8',
    );
    await deps.db.transaction({ shopId, userId: null }, async (tx) => {
      await tx.query(
        `update export_jobs set status = 'completed', file_key = $2, row_count = $3, completed_at = now(),
           download_until = now() + interval '24 hours', delete_after = now() + interval '7 days'
         where id = $1`,
        [exportId, exportFileKey(shopId, exportId), rows.length],
      );
      await insertWebhookEvents(
        tx,
        [webhookEvent('job.completed', { kind: 'export', id: exportId })],
        uuidv7,
      );
    });
    await deps.audit.send([
      auditEvent(
        { shopId, caller, requestId: uuidv7(), attemptId: null, idempotencyKey: null },
        {
          action: 'reports.export.completed',
          phase: 'outcome',
          outcome: 'succeeded',
          target_type: 'export',
          target_id: exportId,
          changes: { rows: rows.length, truncated },
          context: { report, filters, partial: first.partial, costVisible: first.costVisible },
        },
      ),
    ]);
  } catch (error) {
    const known =
      error instanceof AppError
        ? error
        : (error as { code?: string }).code === '57014'
          ? tooLarge()
          : null;
    if (!known) throw error;
    const message =
      known.code === 'validation_failed'
        ? (known.extra.errors as Array<{ message: string }> | undefined)
            ?.map((e) => e.message)
            .join(' ') || known.message
        : ((known.extra.detail as string | undefined) ?? known.message);
    await failExport(deps.db, shopId, exportId, message);
  }
  return 'done';
}

async function failExport(db: Database, shopId: string, exportId: string, message: string) {
  await db.transaction({ shopId, userId: null }, async (tx: Tx) => {
    await tx.query(`update export_jobs set status = 'failed', error = $2 where id = $1`, [
      exportId,
      message,
    ]);
    await insertWebhookEvents(
      tx,
      [webhookEvent('job.completed', { kind: 'export', id: exportId })],
      uuidv7,
    );
  });
}

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const reportsOperations = [
  runStandardReport,
  runSavedReport,
  listSavedReports,
  saveReport,
  deleteSavedReport,
  exportReport,
  listReportExports,
] as const;
