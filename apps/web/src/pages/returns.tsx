import type { ops } from '@airstock/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
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
  titleCase,
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';
import { type LineDraft, LinesEditor, useStockLocations, variantsBySku } from './transfers.tsx';

// Returns (plan D9, PRD 6.5): request, authorize, receive into quarantine, inspect. No refunds:
// those belong to the sales channel.

type Return = Out<typeof ops.getReturn>;
type ReturnList = Out<typeof ops.listReturns>;

const STATUS_TONE: Record<string, string> = {
  requested: 'muted',
  authorized: '',
  in_transit: 'warn',
  received: 'warn',
  inspecting: 'warn',
  completed: 'ok',
  cancelled: 'muted',
  exception: 'error',
};

function ReturnStatus({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? ''}>{titleCase(status)}</Badge>;
}

const emptyLine = (): LineDraft => ({ sku: '', quantity: '', lotCode: '' });

export function ReturnsPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const search = useSearch({ from: '/shops/$shopId/inventory/returns' });
  const navigate = useNavigate({ from: '/shops/$shopId/inventory/returns' });
  const context = useShopContext(shopId);
  const [status, setStatus] = useState('open');
  const list = useQuery({
    queryKey: ['shop', shopId, 'returns', status],
    queryFn: () => api<ReturnList>(`/shops/${shopId}/returns`, { query: { status, limit: 100 } }),
  });
  const select = (returnId: string | undefined) =>
    navigate({ search: returnId ? { return: returnId } : {} });
  return (
    <>
      {search.return ? (
        <ReturnDetail shopId={shopId} returnId={search.return} onClose={() => select(undefined)} />
      ) : null}
      <Card title="Returns">
        <div className="inline-form">
          <Field label="Show">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="open">Open</option>
              <option value="exception">Needs review</option>
              <option value="closed">Completed or cancelled</option>
              <option value="all">All</option>
            </select>
          </Field>
        </div>
        <ErrorNotice error={list.error} />
        {list.isPending ? <Loading /> : null}
        {list.data && list.data.returns.length === 0 ? <Empty>No returns here.</Empty> : null}
        {list.data && list.data.returns.length > 0 ? (
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Return</th>
                  <th>Order</th>
                  <th>Status</th>
                  <th className="num">Expected</th>
                  <th className="num">Received</th>
                  <th className="num">Back on sale</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {list.data.returns.map((r) => (
                  <tr key={r.returnId}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => select(r.returnId)}
                      >
                        {r.reference ?? r.returnId.slice(-8)}
                      </button>
                    </td>
                    <td>{r.orderRef ?? '—'}</td>
                    <td>
                      <ReturnStatus status={r.status} />
                    </td>
                    <td className="num">{formatDecimal(r.totals.expected)}</td>
                    <td className="num">{formatDecimal(r.totals.received)}</td>
                    <td className="num">{formatDecimal(r.totals.sellable)}</td>
                    <td>{formatDateTime(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      {can(context.data, 'returns.manage') ? (
        <NewReturnForm shopId={shopId} onCreated={select} />
      ) : null}
    </>
  );
}

function useReturnsRefresh(shopId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'returns'] }),
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'return'] }),
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'availability'] }),
    ]);
}

function NewReturnForm({
  shopId,
  onCreated,
}: {
  shopId: string;
  onCreated: (returnId: string) => void;
}) {
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [orderRef, setOrderRef] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [authorize, setAuthorize] = useState(true);
  const refresh = useReturnsRefresh(shopId);
  const create = useMutation({
    mutationFn: async () => {
      const ids = await variantsBySku(
        shopId,
        lines.map((l) => l.sku.trim()),
      );
      return command<Out<typeof ops.createReturn>>(`/shops/${shopId}/returns`, {
        lines: lines.map((l, i) => ({ variantId: ids[i], quantity: l.quantity.trim() })),
        ...(orderRef.trim() ? { orderRef: orderRef.trim() } : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        authorize,
      });
    },
    onSuccess: async (res) => {
      setLines([emptyLine()]);
      setOrderRef('');
      setReference('');
      setReason('');
      await refresh();
      onCreated(res.return.returnId);
    },
  });
  return (
    <Card title="New return">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="inline-form">
          <Field label="Order">
            <input
              value={orderRef}
              onChange={(e) => setOrderRef(e.target.value)}
              placeholder="Order number, such as 1001"
              maxLength={200}
            />
          </Field>
          <Field label="RMA">
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Your return number"
              maxLength={200}
            />
          </Field>
          <Field label="Reason">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why it came back"
              maxLength={500}
            />
          </Field>
        </div>
        <LinesEditor lines={lines} onChange={setLines} lotColumn={false} />
        <label className="check">
          <input
            type="checkbox"
            checked={authorize}
            onChange={(e) => setAuthorize(e.target.checked)}
          />
          Authorize now
        </label>
        <div>
          <button type="submit" disabled={create.isPending}>
            Create return
          </button>
        </div>
        <ErrorNotice error={create.error} />
      </form>
    </Card>
  );
}

function ReturnDetail({
  shopId,
  returnId,
  onClose,
}: {
  shopId: string;
  returnId: string;
  onClose: () => void;
}) {
  const context = useShopContext(shopId);
  const detail = useQuery({
    queryKey: ['shop', shopId, 'return', returnId],
    queryFn: () => api<Return>(`/shops/${shopId}/returns/${returnId}`),
  });
  const r = detail.data;
  return (
    <Card
      title={r ? `Return ${r.reference ?? r.returnId.slice(-8)}` : 'Return'}
      actions={
        <button type="button" className="small ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <ErrorNotice error={detail.error} />
      {detail.isPending ? <Loading /> : null}
      {r ? (
        <>
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              <ReturnStatus status={r.status} />
            </dd>
            <dt>Order</dt>
            <dd>{r.orderRef ?? '—'}</dd>
            {r.reason ? (
              <>
                <dt>Reason</dt>
                <dd>{r.reason}</dd>
              </>
            ) : null}
            <dt>Received at</dt>
            <dd>{r.location?.path ?? '—'}</dd>
            <dt>Created</dt>
            <dd>{formatDateTime(r.createdAt)}</dd>
          </dl>
          {r.exception.open ? <Notice>Needs review: {r.exception.note}</Notice> : null}
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th className="num">Expected</th>
                  <th className="num">Received</th>
                  <th className="num">To inspect</th>
                  <th className="num">Sellable</th>
                  <th className="num">Damaged</th>
                  <th className="num">Repair</th>
                  <th className="num">Supplier</th>
                  <th className="num">Disposed</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.lineId}>
                    <td>
                      {l.sku}
                      {l.units.some((u) => u.serial || u.lotCode) ? (
                        <div className="muted">
                          {l.units
                            .map(
                              (u) =>
                                `${u.serial ?? u.lotCode}${u.matched === false ? ' (review)' : ''}`,
                            )
                            .join(', ')}
                        </div>
                      ) : null}
                    </td>
                    <td className="num">{formatDecimal(l.expected)}</td>
                    <td className="num">{formatDecimal(l.received)}</td>
                    <td className="num">{formatDecimal(l.uninspected)}</td>
                    <td className="num">{formatDecimal(l.sellable)}</td>
                    <td className="num">{formatDecimal(l.damaged)}</td>
                    <td className="num">{formatDecimal(l.repair)}</td>
                    <td className="num">{formatDecimal(l.supplierReturn)}</td>
                    <td className="num">{formatDecimal(l.disposed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {can(context.data, 'returns.manage') ? <ReturnActions shopId={shopId} ret={r} /> : null}
        </>
      ) : null}
    </Card>
  );
}

function ReturnActions({ shopId, ret: r }: { shopId: string; ret: Return }) {
  const refresh = useReturnsRefresh(shopId);
  const { leaves } = useStockLocations(shopId);
  const [locationId, setLocationId] = useState('');
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});
  const [serials, setSerials] = useState<Record<string, string>>({});
  const [lots, setLots] = useState<Record<string, string>>({});
  const [inspectQty, setInspectQty] = useState<Record<string, string>>({});
  const [disposition, setDisposition] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const path = `/shops/${shopId}/returns/${r.returnId}`;
  const act = useMutation({
    mutationFn: (step: 'authorize' | 'receive' | 'inspect' | 'complete' | 'cancel' | 'clear') => {
      if (step === 'receive') {
        const items = r.lines
          .filter((l) => Number(l.expected) > Number(l.received))
          .map((l) => {
            const list = (serials[l.lineId] ?? '')
              .split(/[\s,]+/)
              .map((s) => s.trim())
              .filter(Boolean);
            return {
              variantId: l.variantId,
              ...(list.length > 0 ? { serials: list } : {}),
              ...((receiveQty[l.lineId] ?? '').trim() && list.length === 0
                ? { quantity: receiveQty[l.lineId]!.trim() }
                : {}),
              ...((lots[l.lineId] ?? '').trim() ? { lotCode: lots[l.lineId]!.trim() } : {}),
            };
          });
        const at = r.location?.locationId ?? (locationId || leaves[0]?.locationId);
        return command(`${path}/receive`, {
          items,
          ...(r.location ? {} : at ? { locationId: at } : {}),
        });
      }
      if (step === 'inspect') {
        const inspections = r.lines
          .filter((l) => Number(l.uninspected) > 0)
          .map((l) => ({
            variantId: l.variantId,
            disposition: disposition[l.lineId] ?? 'sellable',
            ...((inspectQty[l.lineId] ?? '').trim()
              ? { quantity: inspectQty[l.lineId]!.trim() }
              : {}),
          }));
        return command(`${path}/inspect`, { inspections });
      }
      if (step === 'clear') return command(`${path}/exception`, { note: note.trim(), open: false });
      return command(`${path}/${step}`, {});
    },
    onSuccess: async () => {
      setReceiveQty({});
      setSerials({});
      setInspectQty({});
      setNote('');
      await refresh();
    },
  });
  if (r.status === 'completed' || r.status === 'cancelled') return null;
  const expecting = r.lines.some((l) => Number(l.expected) > Number(l.received));
  const inspecting = r.lines.some((l) => Number(l.uninspected) > 0);
  const received = Number(r.totals.received) > 0;
  return (
    <div className="stack">
      {!r.authorizedAt || !received ? (
        <div className="form-actions">
          {!r.authorizedAt ? (
            <button type="button" disabled={act.isPending} onClick={() => act.mutate('authorize')}>
              Authorize
            </button>
          ) : null}
          {!received ? (
            <button
              type="button"
              className="ghost"
              disabled={act.isPending}
              onClick={() => act.mutate('cancel')}
            >
              Cancel return
            </button>
          ) : null}
        </div>
      ) : null}
      {expecting ? (
        <>
          <h3>Receive into quarantine</h3>
          {r.location ? null : (
            <Field label="Arrives at">
              <select
                value={locationId || leaves[0]?.locationId || ''}
                onChange={(e) => setLocationId(e.target.value)}
              >
                {leaves.map((l) => (
                  <option key={l.locationId} value={l.locationId}>
                    {l.path}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {r.lines
            .filter((l) => Number(l.expected) > Number(l.received))
            .map((l) => (
              <div className="inline-form" key={l.lineId}>
                <Field label={`${l.sku} quantity`}>
                  <input
                    value={receiveQty[l.lineId] ?? ''}
                    onChange={(e) => setReceiveQty({ ...receiveQty, [l.lineId]: e.target.value })}
                    inputMode="decimal"
                    placeholder="All expected"
                    size={8}
                  />
                </Field>
                <Field label={`${l.sku} serials`}>
                  <input
                    value={serials[l.lineId] ?? ''}
                    onChange={(e) => setSerials({ ...serials, [l.lineId]: e.target.value })}
                    placeholder="Serials, if tracked"
                  />
                </Field>
                <Field label={`${l.sku} lot`}>
                  <input
                    value={lots[l.lineId] ?? ''}
                    onChange={(e) => setLots({ ...lots, [l.lineId]: e.target.value })}
                    placeholder="Lot, if tracked"
                    size={10}
                  />
                </Field>
              </div>
            ))}
          <div>
            <button type="button" disabled={act.isPending} onClick={() => act.mutate('receive')}>
              Receive
            </button>
          </div>
        </>
      ) : null}
      {inspecting ? (
        <>
          <h3>Inspect</h3>
          {r.lines
            .filter((l) => Number(l.uninspected) > 0)
            .map((l) => (
              <div className="inline-form" key={l.lineId}>
                <Field label={`${l.sku} result`}>
                  <select
                    value={disposition[l.lineId] ?? 'sellable'}
                    onChange={(e) => setDisposition({ ...disposition, [l.lineId]: e.target.value })}
                  >
                    <option value="sellable">Sellable</option>
                    <option value="damaged">Damaged</option>
                    <option value="repair">Repair</option>
                    <option value="supplier_return">Supplier return</option>
                    <option value="disposal">Dispose</option>
                  </select>
                </Field>
                <Field label={`${l.sku} units`}>
                  <input
                    value={inspectQty[l.lineId] ?? ''}
                    onChange={(e) => setInspectQty({ ...inspectQty, [l.lineId]: e.target.value })}
                    inputMode="decimal"
                    placeholder={`All ${formatDecimal(l.uninspected)}`}
                    size={8}
                  />
                </Field>
              </div>
            ))}
          <div>
            <button type="button" disabled={act.isPending} onClick={() => act.mutate('inspect')}>
              Record inspection
            </button>
          </div>
        </>
      ) : null}
      {r.exception.open ? (
        <div className="inline-form">
          <Field label="Review note">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What you checked"
              maxLength={2000}
            />
          </Field>
          <button
            type="button"
            disabled={act.isPending || note.trim() === ''}
            onClick={() => act.mutate('clear')}
          >
            Mark reviewed
          </button>
        </div>
      ) : null}
      {received && !inspecting && expecting && !r.exception.open ? (
        <div className="form-actions">
          <button
            type="button"
            className="ghost"
            disabled={act.isPending}
            onClick={() => act.mutate('complete')}
          >
            Complete with what arrived
          </button>
        </div>
      ) : null}
      <ErrorNotice error={act.error} />
    </div>
  );
}
