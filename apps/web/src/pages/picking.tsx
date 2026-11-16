import type { ops } from '@airstock/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { type FormEvent, Fragment, useState } from 'react';
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
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';
import { linePacks, type PickListView, sectionsOf } from '../picking/view.ts';
import { useWarehouses } from './warehouses.tsx';

type Lists = Out<typeof ops.listPickLists>;
type Completed = Out<typeof ops.completePickList>;

type PdfModule = typeof import('../picking/pdf.ts');
let pdfModule: Promise<PdfModule> | null = null;

/** Saves bytes as a file. A blob: URL works under the dashboard CSP: downloads are navigations. */
function saveFile(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Pick lists in the dashboard (plan 5.11): build one from open reservations, print it as a PDF,
 * check progress, and complete it. Picking itself happens on the phone (/app/scan, Pick).
 */
export function PickingPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const context = useShopContext(shopId);
  const [status, setStatus] = useState<'open' | 'completed' | 'all'>('open');
  const [selected, setSelected] = useState<string | null>(null);
  const lists = useQuery({
    queryKey: ['shop', shopId, 'pick-lists', status],
    queryFn: () => api<Lists>(`/shops/${shopId}/pick-lists`, { query: { status } }),
  });
  const canPick = can(context.data, 'picking.run');
  return (
    <>
      <PageHeader
        title="Picking"
        subtitle={
          <>
            Pick lists from open reservations, walked in location order. Work them on the phone
            under{' '}
            <Link to="/scan" search={{ shop: shopId, flow: 'pick' }}>
              Scan → Pick
            </Link>
            .
          </>
        }
      />
      {canPick ? <NewPickList shopId={shopId} onCreated={(id) => setSelected(id)} /> : null}
      <Card
        title="Pick lists"
        actions={
          <select
            aria-label="Show"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            <option value="open">Open</option>
            <option value="completed">Completed</option>
            <option value="all">All</option>
          </select>
        }
      >
        {lists.isPending ? <Loading /> : null}
        <ErrorNotice error={lists.error} />
        {lists.data && lists.data.pickLists.length === 0 ? <Empty>No pick lists.</Empty> : null}
        {lists.data && lists.data.pickLists.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>List</th>
                  <th>Created</th>
                  <th>Orders</th>
                  <th>Lines</th>
                  <th>Open</th>
                  <th>Short</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {lists.data.pickLists.map((l) => (
                  <tr
                    key={l.pickListId}
                    className={l.pickListId === selected ? 'selected' : undefined}
                  >
                    <td>
                      <button
                        type="button"
                        className="button-link"
                        onClick={() => setSelected(l.pickListId)}
                      >
                        Pick list {l.number}
                      </button>
                      {l.note ? <span className="muted"> · {l.note}</span> : null}
                    </td>
                    <td>{formatDateTime(l.createdAt)}</td>
                    <td>{l.orders}</td>
                    <td>{l.lines}</td>
                    <td>{l.openLines}</td>
                    <td>{l.shortLines ? <Badge tone="warn">{l.shortLines}</Badge> : 0}</td>
                    <td>{l.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      {selected ? (
        <PickListDetail
          key={selected}
          shopId={shopId}
          shopName={context.data?.shop.name ?? ''}
          pickListId={selected}
          canPick={canPick}
          canFulfill={can(context.data, 'inventory.fulfill')}
        />
      ) : null}
    </>
  );
}

function NewPickList({ shopId, onCreated }: { shopId: string; onCreated: (id: string) => void }) {
  const queryClient = useQueryClient();
  const warehouses = useWarehouses(shopId);
  const [warehouseId, setWarehouseId] = useState('');
  const [channel, setChannel] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [orders, setOrders] = useState('');
  const [note, setNote] = useState('');
  const create = useMutation({
    mutationFn: () => {
      const refs = orders
        .split(/[\n,]/)
        .map((o) => o.trim())
        .filter(Boolean);
      return command<PickListView>(`/shops/${shopId}/pick-lists`, {
        ...(warehouseId ? { warehouseId } : {}),
        ...(channel.trim() ? { channel: channel.trim() } : {}),
        ...(from ? { createdFrom: from } : {}),
        ...(to ? { createdTo: to } : {}),
        ...(refs.length ? { orders: refs } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    },
    onSuccess: async (list) => {
      await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'pick-lists'] });
      onCreated(list.pickListId);
      setOrders('');
      setNote('');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const active = (warehouses.data?.warehouses ?? []).filter((w) => w.status === 'active');
  return (
    <Card title="New pick list">
      <form className="form-grid" onSubmit={submit}>
        <Field label="Warehouse">
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">All warehouses</option>
            {active.map((w) => (
              <option key={w.warehouseId} value={w.warehouseId}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Channel">
          <input
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            placeholder="All channels, or one such as default"
            maxLength={100}
          />
        </Field>
        <Field label="Reserved from">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Reserved to">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Orders">
          <textarea
            value={orders}
            onChange={(e) => setOrders(e.target.value)}
            rows={3}
            placeholder="All open orders, or one reference per line (shopify:order/123)"
          />
        </Field>
        <Field label="Note">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
        <div className="form-actions">
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Building…' : 'Build pick list'}
          </button>
        </div>
        <ErrorNotice error={create.error} />
      </form>
    </Card>
  );
}

function PickListDetail({
  shopId,
  shopName,
  pickListId,
  canPick,
  canFulfill,
}: {
  shopId: string;
  shopName: string;
  pickListId: string;
  canPick: boolean;
  canFulfill: boolean;
}) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['shop', shopId, 'pick-list', pickListId],
    queryFn: () => api<PickListView>(`/shops/${shopId}/pick-lists/${pickListId}`),
  });
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<unknown>(null);
  const [done, setDone] = useState<Completed | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'pick-list', pickListId] }),
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'pick-lists'] }),
    ]);
  const complete = useMutation({
    mutationFn: (leaveOpen: boolean) =>
      command<Completed>(`/shops/${shopId}/pick-lists/${pickListId}/complete`, {
        fulfill: canFulfill,
        leaveOpen,
      }),
    onSuccess: async (result) => {
      setDone(result);
      await refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: () => command(`/shops/${shopId}/pick-lists/${pickListId}/cancel`, {}),
    onSuccess: refresh,
  });
  const print = async () => {
    if (!list.data) return;
    setPrinting(true);
    setPrintError(null);
    try {
      pdfModule ??= import('../picking/pdf.ts');
      const { buildPickListPdf } = await pdfModule;
      const bytes = await buildPickListPdf(list.data, { shopName });
      saveFile(bytes, `pick-list-${list.data.number}.pdf`);
    } catch (error) {
      pdfModule = null;
      setPrintError(error);
    } finally {
      setPrinting(false);
    }
  };
  if (list.isPending) return <Loading />;
  if (list.error) return <ErrorNotice error={list.error} />;
  const data = list.data;
  const sections = sectionsOf(data.pickLines);
  const open = data.status === 'open';
  return (
    <Card
      title={`Pick list ${data.number}`}
      actions={
        <div className="page-actions">
          <button type="button" className="ghost" onClick={print} disabled={printing}>
            {printing ? 'Preparing…' : 'Download PDF'}
          </button>
          {open && canPick ? (
            <>
              <button
                type="button"
                onClick={() => complete.mutate(data.openLines > 0)}
                disabled={complete.isPending}
              >
                {data.openLines > 0
                  ? `Complete, leaving ${data.openLines} open`
                  : canFulfill
                    ? 'Complete and fulfill'
                    : 'Complete'}
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                Cancel list
              </button>
            </>
          ) : null}
        </div>
      }
    >
      <p className="muted">
        {data.orders} orders · {data.lines} lines · {data.openLines} to pick
        {data.shortLines ? ` · ${data.shortLines} short` : ''} · {data.status}
        {data.partial ? ' · only your locations are shown' : ''}
      </p>
      <ErrorNotice error={printError ?? complete.error ?? cancel.error} />
      {done ? (
        <Notice tone="ok">
          Completed: {done.fulfilled.length} fulfillment(s) recorded
          {done.recordedOnly.length
            ? `, ${done.recordedOnly.length} Shopify order(s) recorded only`
            : ''}
          {done.short ? `, ${done.short} short line(s) still reserved` : ''}.
        </Notice>
      ) : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Qty</th>
              <th>SKU</th>
              <th>Item</th>
              <th>Lot or serial</th>
              <th>Order</th>
              <th>Picked</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((s) => (
              <Fragment key={s.locationId}>
                <tr className="group-row">
                  <th colSpan={7}>{s.path}</th>
                </tr>
                {s.lines.map((l) => (
                  <tr key={l.lineId}>
                    <td>
                      <strong>{formatDecimal(l.quantity)}</strong> {linePacks(l)}
                    </td>
                    <td className="mono">{l.sku}</td>
                    <td>
                      {l.productName}
                      {l.variantName ? ` · ${l.variantName}` : ''}
                    </td>
                    <td>
                      {l.serial
                        ? `SN ${l.serial}`
                        : l.lotCode
                          ? `${l.lotCode}${l.expiresOn ? ` (${l.expiresOn})` : ''}`
                          : '—'}
                    </td>
                    <td className="mono">{l.externalRef ?? '—'}</td>
                    <td>
                      {formatDecimal(l.picked)}
                      {l.short !== '0' ? ` (${formatDecimal(l.short)} short)` : ''}
                    </td>
                    <td>
                      <Badge
                        tone={
                          l.status === 'short' ? 'warn' : l.status === 'open' ? undefined : 'ok'
                        }
                      >
                        {l.status}
                      </Badge>
                      {!l.fulfillOnComplete ? <span className="muted"> · Shopify</span> : null}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
