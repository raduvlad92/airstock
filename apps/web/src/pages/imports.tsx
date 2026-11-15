import type { ops } from '@airstock/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ApiError, api, command, type Out } from '../api.ts';
import { useCatalogSchema } from '../catalog/schema.ts';
import {
  Badge,
  Card,
  Empty,
  ErrorNotice,
  Field,
  formatDateTime,
  Loading,
  Notice,
  PageHeader,
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';
import { useLocations } from './warehouses.tsx';

type ImportOut = Out<typeof ops.getImport>['import'];
type Preview = Out<typeof ops.previewImport>;
type Rows = Out<typeof ops.listImportRows>;

const BUILTINS: Array<[string, string]> = [
  ['ignore', 'Ignore'],
  ['product', 'Product key (groups variants)'],
  ['name', 'Name'],
  ['sku', 'SKU'],
  ['price', 'Price'],
  ['description', 'Description'],
  ['status', 'Status'],
  ['family', 'Family'],
  ['tags', 'Tags'],
  ['weight', 'Weight'],
  ['dimensions', 'Dimensions'],
];

/** Uploads a file to the import's upload path, as the API takes it: the raw CSV. */
async function uploadFile(path: string, file: File) {
  const res = await fetch(path, {
    method: 'PUT',
    headers: { 'x-airstock-request': '1', 'content-type': 'text/csv' },
    body: file,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(
      res.status,
      String(body.code ?? 'http_error'),
      String(body.title ?? 'Upload failed'),
      body,
    );
  }
}

export function ImportsPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const context = useShopContext(shopId);
  const queryClient = useQueryClient();
  const allowed = can(context.data, 'imports.run');
  const [current, setCurrent] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['shop', shopId, 'imports'],
    queryFn: () => api<Out<typeof ops.listImports>>(`/shops/${shopId}/imports`),
  });
  const start = useMutation({
    mutationFn: async (file: File) => {
      const created = await command<{ importId: string; uploadPath: string }>(
        `/shops/${shopId}/imports`,
        { fileName: file.name },
      );
      await uploadFile(created.uploadPath, file);
      return created.importId;
    },
    onSuccess: async (importId) => {
      setCurrent(importId);
      await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'imports'] });
    },
  });
  return (
    <>
      <PageHeader
        title="Import products"
        subtitle="CSV files of up to 20 MB and 50,000 rows. Rows whose SKU exists update that variant; the rest create products."
        actions={
          <Link to="/shops/$shopId/products" params={{ shopId }} className="button-link">
            Back to products
          </Link>
        }
      />
      {!allowed ? <Notice>You need the imports.run permission to import.</Notice> : null}
      {allowed ? (
        <Card title="New import">
          <Field label="CSV file (UTF-8, comma or semicolon)">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) start.mutate(file);
              }}
            />
          </Field>
          {start.isPending ? <p className="muted">Uploading…</p> : null}
          <ErrorNotice error={start.error} />
        </Card>
      ) : null}
      {current ? <ImportWizard key={current} shopId={shopId} importId={current} /> : null}
      <Card title="Recent imports">
        <ErrorNotice error={list.error} />
        {list.isPending ? <Loading /> : null}
        {list.data?.imports.length === 0 ? <Empty>No imports yet.</Empty> : null}
        <ul className="plain-list">
          {list.data?.imports.map((i) => (
            <li key={i.importId}>
              <span>
                <strong>{i.fileName}</strong>{' '}
                <span className="muted">{formatDateTime(i.createdAt)}</span>{' '}
                <Badge
                  tone={i.status === 'completed' ? 'ok' : i.status === 'failed' ? 'error' : 'muted'}
                >
                  {i.status}
                </Badge>
              </span>
              <button type="button" className="small ghost" onClick={() => setCurrent(i.importId)}>
                Open
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function ImportWizard({ shopId, importId }: { shopId: string; importId: string }) {
  const schema = useCatalogSchema(shopId);
  const locations = useLocations(shopId);
  const queryClient = useQueryClient();
  const [mapping, setMapping] = useState<Record<string, string> | null>(null);
  const job = useQuery({
    queryKey: ['shop', shopId, 'import', importId],
    queryFn: () => api<Out<typeof ops.getImport>>(`/shops/${shopId}/imports/${importId}`),
    // Follow a running import until it finishes.
    refetchInterval: (q) => (q.state.data?.import.status === 'committing' ? 2000 : false),
  });
  const columns = useMutation({
    mutationFn: () => command<Preview>(`/shops/${shopId}/imports/${importId}/preview`, {}),
    onSuccess: (res) => setMapping(res.suggestedMapping),
  });
  const preview = useMutation({
    mutationFn: () => command<Preview>(`/shops/${shopId}/imports/${importId}/preview`, { mapping }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'import', importId] }),
  });
  const commit = useMutation({
    mutationFn: () => command(`/shops/${shopId}/imports/${importId}/commit`, {}),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'import', importId] }),
  });
  const imp: ImportOut | undefined = job.data?.import;
  // The catalog changed: lists and details show the imported records next time.
  useEffect(() => {
    if (imp?.status === 'completed')
      void queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'items'] });
  }, [imp?.status, queryClient, shopId]);
  const header = imp?.header ?? columns.data?.import.header ?? null;
  const targets: Array<[string, string]> = [
    ...BUILTINS,
    ...(schema.data?.fields ?? [])
      .filter((f) => f.status === 'active' && f.type !== 'file')
      .map((f) => [`field:${f.key}`, f.label] as [string, string]),
    ...(locations.data?.locations ?? [])
      .filter((l) => l.holdsStockAllowed && l.status === 'active')
      .map((l) => [`stock:${l.locationId}`, `Opening stock at ${l.path}`] as [string, string]),
  ];
  if (!imp) return <Loading />;
  const done = imp.status === 'completed' || imp.status === 'failed';
  return (
    <Card
      title={`Import: ${imp.fileName}`}
      actions={<Badge tone={done ? 'ok' : 'muted'}>{imp.status}</Badge>}
    >
      <ErrorNotice error={job.error ?? columns.error ?? preview.error ?? commit.error} />
      {imp.status === 'uploaded' && !mapping ? (
        <button type="button" onClick={() => columns.mutate()} disabled={columns.isPending}>
          Read the columns
        </button>
      ) : null}
      {mapping && header && (imp.status === 'uploaded' || imp.status === 'previewed') ? (
        <div className="stack">
          <p className="muted">
            Match each column to a field. Columns named like <code>option:Size</code> become variant
            options; rows sharing a product key become variants of one product.
          </p>
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Goes to</th>
                </tr>
              </thead>
              <tbody>
                {header.map((h) => (
                  <tr key={h}>
                    <td>
                      <code>{h}</code>
                    </td>
                    <td>
                      <select
                        aria-label={`Target for ${h}`}
                        value={mapping[h] ?? 'ignore'}
                        onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })}
                      >
                        {targets.map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                        {mapping[h]?.startsWith('option:') ? (
                          <option value={mapping[h]}>Option {mapping[h]!.slice(7)}</option>
                        ) : null}
                        {!mapping[h]?.startsWith('option:') ? (
                          <option value={`option:${h}`}>Option “{h}”</option>
                        ) : null}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <button type="button" onClick={() => preview.mutate()} disabled={preview.isPending}>
              {preview.isPending ? 'Checking every row…' : 'Preview'}
            </button>
          </div>
        </div>
      ) : null}
      {imp.status === 'previewed' ? (
        <div className="stack">
          <dl className="facts stats">
            <dt>Rows</dt>
            <dd>{imp.counts.rows ?? 0}</dd>
            <dt>New products</dt>
            <dd>{imp.counts.newProducts ?? 0}</dd>
            <dt>Creates</dt>
            <dd>{imp.counts.creates ?? 0}</dd>
            <dt>Updates</dt>
            <dd>{imp.counts.updates ?? 0}</dd>
            <dt>Errors</dt>
            <dd>{imp.counts.errors ?? 0}</dd>
          </dl>
          {(preview.data?.problems.length ?? 0) > 0 ? (
            <ProblemList problems={preview.data!.problems} />
          ) : null}
          <div className="form-actions">
            <button
              type="button"
              onClick={() => commit.mutate()}
              disabled={
                commit.isPending || (imp.counts.creates ?? 0) + (imp.counts.updates ?? 0) === 0
              }
            >
              Import {(imp.counts.creates ?? 0) + (imp.counts.updates ?? 0)} rows
            </button>
            {(imp.counts.errors ?? 0) > 0 ? (
              <span className="muted">Rows with errors are skipped.</span>
            ) : null}
          </div>
        </div>
      ) : null}
      {imp.status === 'committing' ? (
        <p>
          Importing… {imp.checkpoint > 0 ? `up to row ${imp.checkpoint}` : 'starting'} of{' '}
          {imp.rowCount}.
        </p>
      ) : null}
      {done ? <ImportResult shopId={shopId} imp={imp} /> : null}
    </Card>
  );
}

function ProblemList({
  problems,
}: {
  problems: Array<{ rowNumber: number; errors: string[]; warnings: string[] }>;
}) {
  return (
    <div className="table-wrap bulk-lines">
      <table className="table compact">
        <thead>
          <tr>
            <th>Row</th>
            <th>Problem</th>
          </tr>
        </thead>
        <tbody>
          {problems.map((p) => (
            <tr key={p.rowNumber}>
              <td className="num">{p.rowNumber}</td>
              <td>
                {p.errors.map((e) => (
                  <div key={e} className="error-text">
                    {e}
                  </div>
                ))}
                {p.warnings.map((w) => (
                  <div key={w} className="muted">
                    {w}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImportResult({ shopId, imp }: { shopId: string; imp: ImportOut }) {
  const rows = useQuery({
    queryKey: ['shop', shopId, 'import-rows', imp.importId],
    queryFn: () =>
      api<Rows>(`/shops/${shopId}/imports/${imp.importId}/rows`, {
        query: { only: 'problems', limit: 200 },
      }),
  });
  return (
    <div className="stack">
      {imp.status === 'failed' ? (
        <p className="notice error">{imp.error}</p>
      ) : (
        <Notice tone="ok">Imported {imp.counts.done ?? 0} rows.</Notice>
      )}
      <dl className="facts stats">
        <dt>Done</dt>
        <dd>{imp.counts.done ?? 0}</dd>
        <dt>Skipped</dt>
        <dd>{imp.counts.skipped ?? 0}</dd>
        <dt>Failed</dt>
        <dd>{imp.counts.failed ?? 0}</dd>
      </dl>
      {rows.data && rows.data.rows.length > 0 ? (
        <ProblemList
          problems={rows.data.rows.map((r) => ({
            rowNumber: r.rowNumber,
            errors: r.errors,
            warnings: r.warnings,
          }))}
        />
      ) : null}
    </div>
  );
}

/** Exports what the products page shows (plan 5.12): a job, then a download for 24 hours. */
export function ExportButton({
  shopId,
  query,
}: {
  shopId: string;
  query: Record<string, unknown>;
}) {
  const [exportId, setExportId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => command<Out<typeof ops.createExport>>(`/shops/${shopId}/exports`, query),
    onSuccess: (res) => setExportId(res.export.exportId),
  });
  const job = useQuery({
    queryKey: ['shop', shopId, 'export', exportId],
    queryFn: () => api<Out<typeof ops.getExport>>(`/shops/${shopId}/exports/${exportId}`),
    enabled: Boolean(exportId),
    refetchInterval: (q) =>
      q.state.data?.export.status === 'completed' || q.state.data?.export.status === 'failed'
        ? false
        : 1500,
  });
  const download = useMutation({
    mutationFn: async () => {
      // The session needs the custom header, so the file is fetched and saved from memory.
      const res = await fetch(job.data!.export.downloadPath!, {
        headers: { 'x-airstock-request': '1' },
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('The download is no longer available.');
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
        'airstock-export.csv';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  });
  const status = job.data?.export.status;
  return (
    <span className="export-control">
      {!exportId || status === 'failed' ? (
        <button
          type="button"
          className="ghost small"
          onClick={() => start.mutate()}
          disabled={start.isPending}
        >
          Export CSV
        </button>
      ) : status === 'completed' ? (
        <button type="button" className="small" onClick={() => download.mutate()}>
          Download {job.data?.export.rowCount} rows
        </button>
      ) : (
        <span className="muted small-text">Exporting…</span>
      )}
      {start.error || download.error ? (
        <span className="error-text small-text">{(start.error ?? download.error)!.message}</span>
      ) : null}
    </span>
  );
}
