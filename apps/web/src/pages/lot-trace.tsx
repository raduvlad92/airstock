import type { ops } from '@airstock/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, command, type Out } from '../api.ts';
import {
  Card,
  Empty,
  ErrorNotice,
  formatDateTime,
  formatDecimal,
  Loading,
  Notice,
  titleCase,
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';
import { useMutation } from '../mutation.ts';
import { downloadExport } from './imports.tsx';

type Trace = Out<typeof ops.traceLot>;

/**
 * One lot from its receipt to every order (plan 5.7, G6): where it came from, the orders that got
 * it, every movement since, and the same trace as a CSV file.
 */
export function LotTrace({
  shopId,
  lotId,
  onClose,
}: {
  shopId: string;
  lotId: string;
  onClose: () => void;
}) {
  const trace = useQuery({
    queryKey: ['shop', shopId, 'lot-trace', lotId],
    queryFn: () => api<Trace>(`/shops/${shopId}/lots/trace`, { query: { lotId } }),
  });
  const t = trace.data;
  return (
    <Card
      title={t ? `Lot trace · ${t.lot.code}` : 'Lot trace'}
      actions={
        <span className="toolbar">
          <LotTraceExportButton shopId={shopId} lotId={lotId} />
          <button type="button" className="small ghost" onClick={onClose}>
            Close
          </button>
        </span>
      }
    >
      <ErrorNotice error={trace.error} />
      {trace.isPending ? <Loading /> : null}
      {t ? (
        <>
          {t.partial ? (
            <Notice>Movements and totals cover only the locations you can access.</Notice>
          ) : null}
          <dl className="facts">
            <dt>SKU</dt>
            <dd>{t.lot.sku}</dd>
            <dt>Expires</dt>
            <dd>{t.lot.expiresOn ?? '—'}</dd>
            <dt>Supplier</dt>
            <dd>{t.lot.supplierName ?? '—'}</dd>
            <dt>Purchase order</dt>
            <dd>{t.lot.purchaseOrderRef ?? '—'}</dd>
            <dt>Received</dt>
            <dd>{formatDecimal(t.totals.received)}</dd>
            <dt>Fulfilled</dt>
            <dd>{formatDecimal(t.totals.fulfilled)}</dd>
            <dt>On hand</dt>
            <dd>{formatDecimal(t.totals.onHand)}</dd>
          </dl>
          {t.orders.length > 0 ? (
            <p>
              <strong>Orders:</strong>{' '}
              {t.orders
                .map((o) => `${o.externalRef ?? 'No reference'} (${formatDecimal(o.quantity)})`)
                .join(', ')}
            </p>
          ) : null}
          {t.movements.length > 0 ? (
            <div className="table-wrap">
              <table className="table compact" aria-label="Lot movements">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Movement</th>
                    <th className="num">Quantity</th>
                    <th>Location</th>
                    <th>Order</th>
                    <th>Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {t.movements.map((m, i) => (
                    <tr key={`${m.operationId}-${i}`}>
                      <td>{formatDateTime(m.occurredAt)}</td>
                      <td>{titleCase(m.kind)}</td>
                      <td className="num">{formatDecimal(m.quantity)}</td>
                      <td>{m.locationPath}</td>
                      <td>{m.externalRef ?? '—'}</td>
                      <td>{m.reference ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No movements at your locations.</Empty>
          )}
        </>
      ) : null}
    </Card>
  );
}

/** Starts the lot trace export, follows the job, and downloads the file once it is ready. */
export function LotTraceExportButton({ shopId, lotId }: { shopId: string; lotId: string }) {
  const context = useShopContext(shopId);
  const queryClient = useQueryClient();
  const [exportId, setExportId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () =>
      command<Out<typeof ops.exportLotTrace>>(`/shops/${shopId}/lots/trace/exports`, { lotId }),
    onSuccess: (res) => {
      setExportId(res.export.exportId);
      void queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'exports'] });
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
  const running = start.isPending || status === 'pending' || status === 'running';
  return (
    <>
      <button type="button" className="small" disabled={running} onClick={() => start.mutate()}>
        {running ? 'Exporting…' : 'Export CSV'}
      </button>
      {status === 'completed' ? <span className="small-text muted">Downloaded</span> : null}
      {status === 'failed' ? (
        <span className="small-text error-text">{job.data?.export.error ?? 'Export failed.'}</span>
      ) : null}
      <ErrorNotice error={start.error ?? download.error} />
    </>
  );
}
