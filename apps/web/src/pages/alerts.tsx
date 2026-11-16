import type { ops } from '@airstock/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, command, type Out } from '../api.ts';
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
import { useMutation } from '../mutation.ts';

type Alerts = Out<typeof ops.listAlerts>;
type Alert = Alerts['alerts'][number];
type Summary = Out<typeof ops.alertSummary>;
type Preferences = Out<typeof ops.getAlertPreferences>;

const KIND_LABELS: Record<string, string> = {
  low_stock: 'Low stock',
  lot_expiring: 'Lots nearing expiry',
  shortage: 'Shortages',
  reconciliation_mismatch: 'Stock check problems',
  shopify_sync: 'Shopify sync',
};

const STATUS_FILTERS = [
  ['active', 'Open and acknowledged'],
  ['open', 'Open'],
  ['acknowledged', 'Acknowledged'],
  ['resolved', 'Resolved'],
  ['all', 'All'],
] as const;

/** Open alerts the member follows in the app: the badge in the shell (D12). */
export function useAlertSummary(shopId: string, enabled = true) {
  return useQuery({
    queryKey: ['shop', shopId, 'alerts', 'summary'],
    queryFn: () => api<Summary>(`/shops/${shopId}/alerts/summary`),
    refetchInterval: 60_000,
    enabled,
  });
}

export function AlertCount({ shopId }: { shopId: string }) {
  const summary = useAlertSummary(shopId);
  const open = summary.data?.open ?? 0;
  if (open === 0) return null;
  return (
    <span className="nav-count" role="img" aria-label={`${open} open alerts`}>
      {open > 99 ? '99+' : open}
    </span>
  );
}

function useAlertsRefresh(shopId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'alerts'] });
}

export function AlertsPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const context = useShopContext(shopId);
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number][0]>('active');
  const [kind, setKind] = useState('');
  const alerts = useQuery({
    queryKey: ['shop', shopId, 'alerts', 'list', status, kind],
    queryFn: () =>
      api<Alerts>(`/shops/${shopId}/alerts`, {
        query: { status, kind: kind || undefined, limit: 100 },
      }),
    refetchInterval: 60_000,
  });
  return (
    <div className="stack">
      <PageHeader
        title="Alerts"
        subtitle="Low stock, lots nearing expiry, shortages, and stock check problems, within your locations."
      />
      <Card
        title="Alerts"
        actions={
          <div className="page-actions">
            <select
              aria-label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              {STATUS_FILTERS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Every kind</option>
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        }
      >
        <ErrorNotice error={alerts.error} />
        {alerts.isPending ? <Loading /> : null}
        {alerts.data && alerts.data.alerts.length === 0 ? (
          <Empty>Nothing needs attention.</Empty>
        ) : null}
        <ul className="alert-list">
          {(alerts.data?.alerts ?? []).map((a) => (
            <AlertRow
              key={a.id}
              shopId={shopId}
              alert={a}
              canManage={can(context.data, 'alerts.manage')}
              canPurchase={can(context.data, 'purchasing.manage')}
            />
          ))}
        </ul>
      </Card>
      <PreferencesCard shopId={shopId} canManage={can(context.data, 'alerts.manage')} />
    </div>
  );
}

function AlertRow({
  shopId,
  alert,
  canManage,
  canPurchase,
}: {
  shopId: string;
  alert: Alert;
  canManage: boolean;
  canPurchase: boolean;
}) {
  const refresh = useAlertsRefresh(shopId);
  const acknowledge = useMutation({
    mutationFn: () => command(`/shops/${shopId}/alerts/${alert.id}/acknowledge`, {}),
    onSuccess: refresh,
  });
  const d = alert.details as Record<string, string | number | boolean | null | undefined>;
  return (
    <li className={`alert-item ${alert.status}`}>
      <div className="alert-main">
        <strong>{alert.title}</strong>
        <div className="muted small-text">
          {KIND_LABELS[alert.kind] ?? titleCase(alert.kind)} · opened{' '}
          {formatDateTime(alert.openedAt)}
          {alert.resolvedAt ? ` · resolved ${formatDateTime(alert.resolvedAt)}` : ''}
          {alert.resolution ? ` (${titleCase(alert.resolution)})` : ''}
        </div>
        {alert.kind === 'low_stock' ? (
          <div className="small-text">
            Available {formatDecimal(String(d.available ?? ''))} · on order{' '}
            {formatDecimal(String(d.onOrder ?? ''))} · reorder point{' '}
            {formatDecimal(String(d.reorderPoint ?? ''))}
          </div>
        ) : null}
        {alert.kind === 'lot_expiring' ? (
          <div className="small-text">{formatDecimal(String(d.onHand ?? ''))} units in stock</div>
        ) : null}
      </div>
      <div className="page-actions">
        <Badge
          tone={alert.status === 'open' ? 'warn' : alert.status === 'resolved' ? 'ok' : 'muted'}
        >
          {titleCase(alert.status)}
        </Badge>
        {alert.kind === 'low_stock' && alert.status !== 'resolved' && canPurchase ? (
          <Link to="/shops/$shopId/purchasing" params={{ shopId }} className="small-text">
            Draft from low stock
          </Link>
        ) : null}
        {alert.kind === 'reconciliation_mismatch' && alert.status !== 'resolved' ? (
          <Link to="/shops/$shopId/inventory" params={{ shopId }} className="small-text">
            Review the stock check
          </Link>
        ) : null}
        {canManage && alert.status === 'open' ? (
          <button
            type="button"
            className="small ghost"
            disabled={acknowledge.isPending}
            onClick={() => acknowledge.mutate()}
          >
            Acknowledge
          </button>
        ) : null}
      </div>
      <ErrorNotice error={acknowledge.error} />
    </li>
  );
}

function PreferencesCard({ shopId, canManage }: { shopId: string; canManage: boolean }) {
  const prefs = useQuery({
    queryKey: ['shop', shopId, 'alerts', 'preferences'],
    queryFn: () => api<Preferences>(`/shops/${shopId}/alert-preferences`),
  });
  const refresh = useAlertsRefresh(shopId);
  const [draft, setDraft] = useState<Record<string, { inApp: boolean; email: boolean }>>({});
  const [days, setDays] = useState('');
  useEffect(() => {
    if (!prefs.data) return;
    setDraft(
      Object.fromEntries(
        prefs.data.preferences.map((p) => [p.kind, { inApp: p.inApp, email: p.email }]),
      ),
    );
    setDays(String(prefs.data.lotExpiryAlertDays));
  }, [prefs.data]);
  const save = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/alert-preferences`, {
        preferences: Object.entries(draft).map(([kind, p]) => ({ kind, ...p })),
      }),
    onSuccess: refresh,
  });
  const saveDays = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/alert-settings`, { lotExpiryAlertDays: Number(days) }),
    onSuccess: refresh,
  });
  return (
    <Card title="My alerts">
      <ErrorNotice error={prefs.error} />
      {prefs.isPending ? <Loading /> : null}
      {prefs.data ? (
        <>
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>In the app</th>
                  <th>By email</th>
                </tr>
              </thead>
              <tbody>
                {prefs.data.preferences.map((p) => (
                  <tr key={p.kind}>
                    <td>{KIND_LABELS[p.kind] ?? titleCase(p.kind)}</td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${KIND_LABELS[p.kind]} in the app`}
                        checked={draft[p.kind]?.inApp ?? p.inApp}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            [p.kind]: { ...(draft[p.kind] ?? p), inApp: e.target.checked },
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${KIND_LABELS[p.kind]} by email`}
                        checked={draft[p.kind]?.email ?? p.email}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            [p.kind]: { ...(draft[p.kind] ?? p), email: e.target.checked },
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small-text">
            You get alerts only for the locations you can access. Email comes once when an alert
            opens.
          </p>
          <div className="form-actions">
            <button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
              Save my alerts
            </button>
          </div>
          <ErrorNotice error={save.error} />
          {save.isSuccess ? <Notice tone="ok">Saved.</Notice> : null}
          {canManage ? (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                saveDays.mutate();
              }}
            >
              <Field label="Lot expiry alert (days)">
                <input
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  inputMode="numeric"
                  placeholder="Alert this many days before a lot expires"
                  required
                />
              </Field>
              <button type="submit" className="small" disabled={saveDays.isPending}>
                Save for the shop
              </button>
              <ErrorNotice error={saveDays.error} />
            </form>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
