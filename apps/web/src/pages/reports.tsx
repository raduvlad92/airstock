import type { ops } from '@airstock/core';
import { multiply } from '@airstock/core/catalog/decimal';
import {
  GROUP_LABELS,
  MOVEMENT_TYPES,
  REPORT_TYPES,
  REPORTS,
  type ReportColumn,
  type ReportFilterKey,
  type ReportGroup,
  type ReportType,
} from '@airstock/core/reports';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { api, command, type Out } from '../api.ts';
import { useCatalogSchema } from '../catalog/schema.ts';
import {
  Badge,
  Card,
  Empty,
  ErrorNotice,
  Field,
  formatDateTime,
  formatDecimal,
  Loading,
  Notice,
  PageHeader,
  titleCase,
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';
import { downloadExport } from './imports.tsx';
import { useLocations, useWarehouses } from './warehouses.tsx';

type Result = Out<typeof ops.runStandardReport>;
type Saved = Out<typeof ops.listSavedReports>['savedReports'][number];
type ReportExport = Out<typeof ops.exportReport>['export'];
type Suppliers = Out<typeof ops.listSuppliers>;

/** The filters a report runs with, as the API takes them (every value a string). */
type Filters = Partial<Record<ReportFilterKey | 'groupBy' | 'sort', string>>;

export interface ReportsSearch {
  report?: ReportType;
  saved?: string;
}

export function parseReportsSearch(search: Record<string, unknown>): ReportsSearch {
  const out: ReportsSearch = {};
  if (
    typeof search.report === 'string' &&
    (REPORT_TYPES as readonly string[]).includes(search.report)
  )
    out.report = search.report as ReportType;
  if (typeof search.saved === 'string' && /^[0-9a-f-]{36}$/.test(search.saved))
    out.saved = search.saved;
  return out;
}

/** Reports (PRD 3.5): the eight standard reports, saved reports, and their CSV exports. */
export function ReportsPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const search = useSearch({ from: '/shops/$shopId/reports' });
  const saved = useSavedReports(shopId);
  const savedReport = search.saved
    ? saved.data?.savedReports.find((r) => r.id === search.saved)
    : undefined;
  if (search.saved && saved.isPending) return <Loading />;
  if (search.report || savedReport) {
    const type = savedReport?.report ?? search.report!;
    return (
      <ReportView
        key={`${type}:${savedReport?.id ?? ''}`}
        shopId={shopId}
        type={type}
        saved={savedReport}
      />
    );
  }
  return <ReportList shopId={shopId} />;
}

function useSavedReports(shopId: string) {
  return useQuery({
    queryKey: ['shop', shopId, 'saved-reports'],
    queryFn: () => api<Out<typeof ops.listSavedReports>>(`/shops/${shopId}/saved-reports`),
  });
}

function ReportList({ shopId }: { shopId: string }) {
  const context = useShopContext(shopId);
  const costs = can(context.data, 'costs.read');
  const saved = useSavedReports(shopId);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => command(`/shops/${shopId}/saved-reports/${id}/delete`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'saved-reports'] }),
  });
  return (
    <div className="stack">
      <PageHeader
        title="Reports"
        subtitle="Stock, movements, value, purchasing, lots, and shortages, within your locations. Save a report's filters to run it again, or export it as CSV."
      />
      <Card title="Standard reports">
        <ul className="report-list">
          {REPORT_TYPES.map((type) => {
            const info = REPORTS[type];
            const locked = info.costs === 'required' && !costs;
            return (
              <li key={type}>
                <div>
                  {locked ? (
                    <strong>{info.title}</strong>
                  ) : (
                    <Link
                      to="/shops/$shopId/reports"
                      params={{ shopId }}
                      search={{ report: type }}
                      className="report-link"
                    >
                      {info.title}
                    </Link>
                  )}
                  <p className="muted small-text">{info.summary}</p>
                </div>
                {locked ? <Badge tone="muted">Needs cost access</Badge> : null}
              </li>
            );
          })}
        </ul>
      </Card>
      <Card title="Saved reports">
        <ErrorNotice error={saved.error ?? remove.error} />
        {saved.isPending ? <Loading /> : null}
        {saved.data?.savedReports.length === 0 ? (
          <Empty>No saved reports yet. Open a report, set its filters, and save it.</Empty>
        ) : null}
        <ul className="plain-list">
          {(saved.data?.savedReports ?? []).map((r) => (
            <li key={r.id}>
              <span>
                <Link
                  to="/shops/$shopId/reports"
                  params={{ shopId }}
                  search={{ saved: r.id }}
                  className="report-link"
                >
                  {r.name}
                </Link>{' '}
                <span className="muted small-text">{r.title}</span>{' '}
                {r.shared ? <Badge tone="muted">Shared</Badge> : null}
              </span>
              {r.canEdit ? (
                <button
                  type="button"
                  className="small ghost"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm(`Delete the saved report "${r.name}"?`)) remove.mutate(r.id);
                  }}
                >
                  Delete
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
      {can(context.data, 'exports.run') ? <RecentReportExports shopId={shopId} /> : null}
    </div>
  );
}

function RecentReportExports({ shopId }: { shopId: string }) {
  const list = useQuery({
    queryKey: ['shop', shopId, 'report-exports'],
    queryFn: () => api<Out<typeof ops.listReportExports>>(`/shops/${shopId}/report-exports`),
    staleTime: 0,
    refetchInterval: (q) =>
      q.state.data?.exports.some((e) => e.status === 'pending' || e.status === 'running')
        ? 2000
        : false,
  });
  const download = useMutation({ mutationFn: downloadExport });
  if (list.data?.exports.length === 0) return null;
  return (
    <Card title="Recent report exports">
      <ErrorNotice error={list.error ?? download.error} />
      <ul className="plain-list">
        {(list.data?.exports ?? []).map((e) => (
          <li key={e.exportId}>
            <span>
              <span className="muted">{formatDateTime(e.createdAt)}</span> {e.name ?? e.title}{' '}
              <ExportStatus job={e} />
            </span>
            {e.status === 'completed' && e.downloadPath ? (
              <button
                type="button"
                className="small ghost"
                onClick={() => download.mutate(e.downloadPath!)}
                disabled={download.isPending}
              >
                Download
              </button>
            ) : e.status === 'completed' ? (
              <span className="muted small-text">Expired</span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ExportStatus({ job }: { job: ReportExport }) {
  return (
    <>
      <Badge tone={job.status === 'completed' ? 'ok' : job.status === 'failed' ? 'error' : 'muted'}>
        {job.status}
      </Badge>{' '}
      {job.rowCount !== null ? <span className="small-text">{job.rowCount} rows</span> : null}
      {job.error ? <span className="small-text error-text"> {job.error}</span> : null}
    </>
  );
}

function sameFilters(a: Filters, b: Filters): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Filters>;
  return [...keys].every((k) => (a[k] ?? '') === (b[k] ?? ''));
}

/** The saved filters as form values. */
function toFilters(saved: Saved | undefined): Filters {
  const out: Filters = {};
  for (const [key, value] of Object.entries(saved?.filters ?? {})) {
    if (value !== null && value !== undefined) out[key as keyof Filters] = String(value);
  }
  return out;
}

function ReportView({
  shopId,
  type,
  saved,
}: {
  shopId: string;
  type: ReportType;
  saved: Saved | undefined;
}) {
  const info = REPORTS[type];
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Filters>(() => toFilters(saved));
  const [applied, setApplied] = useState<Filters>(() => toFilters(saved));
  const set = (key: keyof Filters, value: string) =>
    setDraft((d) => {
      const next = { ...d };
      if (value === '') delete next[key];
      else next[key] = value;
      return next;
    });
  const query = useMemo(
    () => Object.fromEntries(Object.entries(applied).filter(([, v]) => v !== undefined)),
    [applied],
  );
  // A saved report runs as saved (and is recorded as that report's run) until its filters change.
  const asSaved = saved && sameFilters(applied, toFilters(saved)) ? saved : undefined;
  const result = useInfiniteQuery({
    queryKey: ['shop', shopId, 'report', type, asSaved?.id ?? null, query],
    queryFn: ({ pageParam }) =>
      api<Result>(
        asSaved
          ? `/shops/${shopId}/saved-reports/${asSaved.id}/run`
          : `/shops/${shopId}/reports/${type}`,
        { query: { ...query, cursor: pageParam, limit: 100 } },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const first = result.data?.pages[0];
  const rows = result.data?.pages.flatMap((p) => p.rows) ?? [];
  const apply = (e?: FormEvent) => {
    e?.preventDefault();
    setApplied(draft);
  };
  const sortBy = (key: string) => {
    const current = applied.sort ?? first?.sort;
    const next = current === key ? `-${key}` : key;
    setDraft((d) => ({ ...d, sort: next }));
    setApplied((a) => ({ ...a, sort: next }));
  };
  return (
    <div className="stack">
      <PageHeader
        title={saved?.name ?? info.title}
        subtitle={
          <>
            <Link to="/shops/$shopId/reports" params={{ shopId }} search={{}}>
              All reports
            </Link>
            {' · '}
            {saved ? `${info.title}. ` : ''}
            {info.summary}
          </>
        }
      />
      <Card>
        <form className="inline-form report-filters" onSubmit={apply}>
          <ReportFilters shopId={shopId} type={type} draft={draft} set={set} />
          <button type="submit" className="primary">
            Run report
          </button>
        </form>
      </Card>
      {first?.partial ? (
        <Notice>
          You can see some locations only: rows and totals cover just those locations.
        </Notice>
      ) : null}
      <Card
        title={first ? `${first.rowCount} ${first.rowCount === 1 ? 'row' : 'rows'}` : 'Results'}
        actions={
          <div className="page-actions">
            <ExportButton shopId={shopId} type={type} saved={asSaved} filters={applied} />
            <SaveButton
              shopId={shopId}
              type={type}
              saved={saved}
              filters={applied}
              onSaved={(id) =>
                navigate({
                  to: '/shops/$shopId/reports',
                  params: { shopId },
                  search: { saved: id },
                })
              }
            />
          </div>
        }
      >
        <ErrorNotice error={result.error} />
        {result.isPending ? <Loading label="Running the report…" /> : null}
        {first && first.ignoredFilters.length > 0 ? (
          <p className="muted small-text">
            Not used by this report: {first.ignoredFilters.join(', ')}.
          </p>
        ) : null}
        {first ? (
          <ReportTable result={first} rows={rows} sort={first.sort} onSort={sortBy} />
        ) : null}
        {first && rows.length === 0 ? <Empty>No rows match these filters.</Empty> : null}
        {result.hasNextPage ? (
          <button
            type="button"
            className="small"
            disabled={result.isFetchingNextPage}
            onClick={() => result.fetchNextPage()}
          >
            {result.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </button>
        ) : null}
      </Card>
    </div>
  );
}

function ReportFilters({
  shopId,
  type,
  draft,
  set,
}: {
  shopId: string;
  type: ReportType;
  draft: Filters;
  set: (key: keyof Filters, value: string) => void;
}) {
  const info = REPORTS[type];
  const takes = (key: ReportFilterKey) => info.filters.includes(key);
  const warehouses = useWarehouses(shopId);
  const locations = useLocations(shopId);
  const schema = useCatalogSchema(shopId);
  const suppliers = useQuery({
    queryKey: ['shop', shopId, 'suppliers', 'report-filter'],
    queryFn: () => api<Suppliers>(`/shops/${shopId}/suppliers`, { query: { limit: 200 } }),
    enabled: takes('supplierId'),
  });
  const category = schema.data?.fields.find((f) => f.key === 'category');
  const value = (key: keyof Filters) => draft[key] ?? '';
  return (
    <>
      {info.groups.length > 1 ? (
        <Field label="Rows per">
          <select
            value={value('groupBy') || info.defaultGroup}
            onChange={(e) => {
              set('groupBy', e.target.value === info.defaultGroup ? '' : e.target.value);
              set('sort', '');
            }}
          >
            {info.groups.map((g: ReportGroup) => (
              <option key={g} value={g}>
                {GROUP_LABELS[g]}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {takes('at') ? (
        <Field label="Value on">
          <input
            type="date"
            value={value('at')}
            placeholder="Today"
            onChange={(e) => set('at', e.target.value)}
          />
        </Field>
      ) : null}
      {takes('from') ? (
        <Field label="From">
          <input type="date" value={value('from')} onChange={(e) => set('from', e.target.value)} />
        </Field>
      ) : null}
      {takes('to') ? (
        <Field label="To">
          <input type="date" value={value('to')} onChange={(e) => set('to', e.target.value)} />
        </Field>
      ) : null}
      {takes('days') ? (
        <Field label="Expiring within (days)">
          <input
            type="number"
            min={0}
            max={3650}
            value={value('days') || '30'}
            onChange={(e) => set('days', e.target.value === '30' ? '' : e.target.value)}
          />
        </Field>
      ) : null}
      {takes('movementType') ? (
        <Field label="Movement">
          <select
            value={value('movementType')}
            onChange={(e) => set('movementType', e.target.value)}
          >
            <option value="">Every type</option>
            {MOVEMENT_TYPES.map((m) => (
              <option key={m} value={m}>
                {titleCase(m)}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {takes('warehouseId') ? (
        <Field label="Warehouse">
          <select value={value('warehouseId')} onChange={(e) => set('warehouseId', e.target.value)}>
            <option value="">Every warehouse</option>
            {(warehouses.data?.warehouses ?? []).map((w) => (
              <option key={w.warehouseId} value={w.warehouseId}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {takes('locationId') ? (
        <Field label="Location">
          <select value={value('locationId')} onChange={(e) => set('locationId', e.target.value)}>
            <option value="">Every location</option>
            {(locations.data?.locations ?? [])
              .filter((l) => !draft.warehouseId || l.warehouseId === draft.warehouseId)
              .map((l) => (
                <option key={l.locationId} value={l.locationId}>
                  {l.path}
                </option>
              ))}
          </select>
        </Field>
      ) : null}
      {takes('condition') ? (
        <Field label="Condition">
          <select value={value('condition')} onChange={(e) => set('condition', e.target.value)}>
            <option value="">Every condition</option>
            {['sellable', 'quarantine', 'damaged', 'repair', 'supplier_return'].map((c) => (
              <option key={c} value={c}>
                {titleCase(c)}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {takes('familyId') && (schema.data?.families.length ?? 0) > 0 ? (
        <Field label="Family">
          <select value={value('familyId')} onChange={(e) => set('familyId', e.target.value)}>
            <option value="">Every family</option>
            {(schema.data?.families ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {takes('categoryId') && category && category.options.length > 0 ? (
        <Field label="Category">
          <select value={value('categoryId')} onChange={(e) => set('categoryId', e.target.value)}>
            <option value="">Every category</option>
            {category.options
              .filter((o) => !o.archived)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
          </select>
        </Field>
      ) : null}
      {takes('supplierId') && (suppliers.data?.suppliers.length ?? 0) > 0 ? (
        <Field label="Supplier">
          <select value={value('supplierId')} onChange={(e) => set('supplierId', e.target.value)}>
            <option value="">Every supplier</option>
            {(suppliers.data?.suppliers ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {takes('search') ? (
        <Field label="Item">
          <input
            type="search"
            value={value('search')}
            placeholder="SKU or product name"
            onChange={(e) => set('search', e.target.value)}
          />
        </Field>
      ) : null}
      {takes('overdueOnly') ? (
        <label className="check">
          <input
            type="checkbox"
            checked={draft.overdueOnly === 'true'}
            onChange={(e) => set('overdueOnly', e.target.checked ? 'true' : '')}
          />{' '}
          Overdue only
        </label>
      ) : null}
    </>
  );
}

/** Money for display: rounded to cents (stored values keep 6 places). */
function formatMoney(value: string, currency: string): string {
  const cents = multiply(value, '1', 2);
  const [whole, fraction = ''] = cents.split('.');
  return `${currency} ${whole}.${fraction.padEnd(2, '0')}`;
}

function cell(col: ReportColumn, value: unknown, currency: string): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (col.type) {
    case 'quantity':
      return formatDecimal(String(value));
    case 'money':
      return formatMoney(String(value), currency);
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'datetime':
      return formatDateTime(String(value));
    default:
      return col.key === 'condition' || col.key === 'type' || col.key === 'status'
        ? titleCase(String(value))
        : String(value);
  }
}

const numeric = (col: ReportColumn) =>
  col.type === 'quantity' || col.type === 'money' || col.type === 'integer';

function ReportTable({
  result,
  rows,
  sort,
  onSort,
}: {
  result: Result;
  rows: Result['rows'];
  sort: string;
  onSort: (key: string) => void;
}) {
  if (rows.length === 0) return null;
  const sortKey = sort.replace(/^-/, '');
  return (
    <div className="table-wrap">
      <table className="table compact report-table">
        <thead>
          <tr>
            {result.columns.map((col) => (
              <th key={col.key} className={numeric(col) ? 'num' : undefined}>
                {col.key === 'packs' ? (
                  col.label
                ) : (
                  <button type="button" className="link-button" onClick={() => onSort(col.key)}>
                    {col.label}
                    {sortKey === col.key ? (sort.startsWith('-') ? ' ↓' : ' ↑') : ''}
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.key)}>
              {result.columns.map((col) => (
                <td key={col.key} className={numeric(col) ? 'num' : undefined}>
                  {cell(col, row[col.key], result.currency)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="report-total">
            {result.columns.map((col, i) => (
              <td key={col.key} className={numeric(col) ? 'num' : undefined}>
                {i === 0
                  ? result.partial
                    ? 'Total (your locations)'
                    : 'Total'
                  : result.totals[col.key] !== undefined
                    ? cell(col, result.totals[col.key], result.currency)
                    : ''}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ExportButton({
  shopId,
  type,
  saved,
  filters,
}: {
  shopId: string;
  type: ReportType;
  saved: Saved | undefined;
  filters: Filters;
}) {
  const context = useShopContext(shopId);
  const queryClient = useQueryClient();
  const [exportId, setExportId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () =>
      command<Out<typeof ops.exportReport>>(`/shops/${shopId}/report-exports`, {
        ...(saved ? { savedReportId: saved.id } : { report: type }),
        filters: exportFilters(filters),
      }),
    onSuccess: (res) => {
      setExportId(res.export.exportId);
      void queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'report-exports'] });
    },
  });
  const job = useQuery({
    queryKey: ['shop', shopId, 'export', exportId],
    queryFn: () => api<Out<typeof ops.getExport>>(`/shops/${shopId}/exports/${exportId}`),
    enabled: exportId !== null,
    refetchInterval: (q) =>
      q.state.data && ['completed', 'failed'].includes(q.state.data.export.status) ? false : 1500,
  });
  const download = useMutation({ mutationFn: downloadExport });
  const ready = job.data?.export.status === 'completed' ? job.data.export.downloadPath : null;
  useEffect(() => {
    if (ready) download.mutate(ready);
    // Download once, when the file becomes ready.
  }, [ready]);
  if (!can(context.data, 'exports.run')) return null;
  const status = job.data?.export.status;
  return (
    <span className="toolbar">
      <button
        type="button"
        className="small"
        disabled={start.isPending || status === 'pending' || status === 'running'}
        onClick={() => start.mutate()}
      >
        {status === 'pending' || status === 'running' ? 'Exporting…' : 'Export CSV'}
      </button>
      {status === 'failed' ? (
        <span className="small-text error-text">{job.data?.export.error ?? 'Export failed.'}</span>
      ) : null}
      <ErrorNotice error={start.error ?? download.error} />
    </span>
  );
}

/** Filters as the export takes them: typed values, not query strings. */
function exportFilters(filters: Filters): Record<string, unknown> {
  const out: Record<string, unknown> = { ...filters };
  if (filters.days !== undefined) out.days = Number(filters.days);
  if (filters.overdueOnly !== undefined) out.overdueOnly = filters.overdueOnly === 'true';
  return out;
}

function SaveButton({
  shopId,
  type,
  saved,
  filters,
  onSaved,
}: {
  shopId: string;
  type: ReportType;
  saved: Saved | undefined;
  filters: Filters;
  onSaved: (id: string) => void;
}) {
  const context = useShopContext(shopId);
  const manage = can(context.data, 'reports.manage');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(saved?.name ?? '');
  const [shared, setShared] = useState(saved?.shared ?? false);
  const [asNew, setAsNew] = useState(!saved?.canEdit);
  const save = useMutation({
    mutationFn: () =>
      command<Out<typeof ops.saveReport>>(`/shops/${shopId}/saved-reports`, {
        ...(saved && !asNew ? { savedReportId: saved.id, expectedVersion: saved.version } : {}),
        name,
        report: type,
        filters: exportFilters(filters),
        shared,
      }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'saved-reports'] });
      setOpen(false);
      onSaved(res.savedReport.id);
    },
  });
  if (!open) {
    return (
      <button type="button" className="small ghost" onClick={() => setOpen(true)}>
        {saved?.canEdit ? 'Save changes' : 'Save report'}
      </button>
    );
  }
  return (
    <form
      className="toolbar"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <input
        aria-label="Report name"
        value={name}
        placeholder="Name, such as Weekly stock value"
        maxLength={100}
        required
        onChange={(e) => setName(e.target.value)}
      />
      {manage ? (
        <label className="check small-text">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />{' '}
          Share with the shop
        </label>
      ) : null}
      {saved?.canEdit ? (
        <label className="check small-text">
          <input type="checkbox" checked={asNew} onChange={(e) => setAsNew(e.target.checked)} /> As
          a new report
        </label>
      ) : null}
      <button type="submit" className="small primary" disabled={save.isPending || !name.trim()}>
        Save
      </button>
      <button type="button" className="small ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
      <ErrorNotice error={save.error} />
    </form>
  );
}
