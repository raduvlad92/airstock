import type { ops } from '@airstock/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
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
import { useMutation } from '../mutation.ts';
import { useLocations } from './warehouses.tsx';

// Transfers between locations and warehouses, and moves inside one (plan D8, PRD 6.4). Each
// line shows its planned, cancelled, dispatched, received, and resolved quantities; the status
// is a summary of them.

type Transfer = Out<typeof ops.getTransfer>;
type TransferList = Out<typeof ops.listTransfers>;
type Variants = Out<typeof ops.searchVariants>;

const STATUS_TONE: Record<string, string> = {
  draft: 'muted',
  ready: '',
  partially_dispatched: 'warn',
  dispatched: 'warn',
  partially_received: 'warn',
  received: 'ok',
  cancelled: 'muted',
  exception: 'error',
};

export function TransferStatus({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? ''}>{titleCase(status)}</Badge>;
}

/** Looks up variants by SKU, in order; throws with the SKUs that are not found. */
export async function variantsBySku(shopId: string, skus: string[]): Promise<string[]> {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const sku of skus) {
    const found = await api<Variants>(`/shops/${shopId}/variants`, { query: { sku, limit: 1 } });
    const v = found.variants[0];
    if (v && v.sku.toUpperCase() === sku.toUpperCase()) ids.push(v.variantId);
    else missing.push(sku);
  }
  if (missing.length > 0) throw new Error(`No variant with SKU ${missing.join(', ')}.`);
  return ids;
}

export interface LineDraft {
  sku: string;
  quantity: string;
  lotCode: string;
}

const emptyLine = (): LineDraft => ({ sku: '', quantity: '', lotCode: '' });

/** Rows of SKU, quantity, and optional lot, for transfers, moves, and returns. */
export function LinesEditor({
  lines,
  onChange,
  lotColumn = true,
}: {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  lotColumn?: boolean;
}) {
  const set = (i: number, patch: Partial<LineDraft>) =>
    onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="stack">
      {lines.map((l, i) => (
        <div className="inline-form" key={i}>
          <Field label="SKU">
            <input
              value={l.sku}
              onChange={(e) => set(i, { sku: e.target.value })}
              required
              maxLength={100}
            />
          </Field>
          <Field label="Quantity">
            <input
              value={l.quantity}
              onChange={(e) => set(i, { quantity: e.target.value })}
              inputMode="decimal"
              required
              size={6}
            />
          </Field>
          {lotColumn ? (
            <Field label="Lot">
              <input
                value={l.lotCode}
                onChange={(e) => set(i, { lotCode: e.target.value })}
                placeholder="Any lot"
                maxLength={100}
                size={10}
              />
            </Field>
          ) : null}
          {lines.length > 1 ? (
            <button
              type="button"
              className="small ghost"
              onClick={() => onChange(lines.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
      <div>
        <button
          type="button"
          className="small ghost"
          onClick={() => onChange([...lines, emptyLine()])}
        >
          Add a line
        </button>
      </div>
    </div>
  );
}

export function useStockLocations(shopId: string) {
  const locations = useLocations(shopId);
  const active = (locations.data?.locations ?? []).filter((l) => l.status === 'active');
  return { all: active, leaves: active.filter((l) => l.holdsStockAllowed), query: locations };
}

export function TransfersPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const search = useSearch({ from: '/shops/$shopId/inventory/transfers' });
  const navigate = useNavigate({ from: '/shops/$shopId/inventory/transfers' });
  const context = useShopContext(shopId);
  const [status, setStatus] = useState('open');
  const list = useQuery({
    queryKey: ['shop', shopId, 'transfers', status],
    queryFn: () =>
      api<TransferList>(`/shops/${shopId}/transfers`, { query: { status, limit: 100 } }),
  });
  const select = (transferId: string | undefined) =>
    navigate({ search: transferId ? { transfer: transferId } : {} });
  const canTransfer = can(context.data, 'inventory.transfer');
  return (
    <>
      {search.transfer ? (
        <TransferDetail
          shopId={shopId}
          transferId={search.transfer}
          onClose={() => select(undefined)}
        />
      ) : null}
      <Card title="Transfers">
        <div className="inline-form">
          <Field label="Show">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="open">Open</option>
              <option value="exception">Exceptions</option>
              <option value="closed">Received or cancelled</option>
              <option value="all">All</option>
            </select>
          </Field>
        </div>
        <ErrorNotice error={list.error} />
        {list.isPending ? <Loading /> : null}
        {list.data && list.data.transfers.length === 0 ? <Empty>No transfers here.</Empty> : null}
        {list.data && list.data.transfers.length > 0 ? (
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Transfer</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Status</th>
                  <th className="num">Planned</th>
                  <th className="num">In transit</th>
                  <th className="num">Received</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {list.data.transfers.map((t) => (
                  <tr key={t.transferId}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => select(t.transferId)}
                      >
                        {t.reference ?? t.transferId.slice(-8)}
                      </button>{' '}
                      {t.kind === 'move' ? <Badge tone="muted">Move</Badge> : null}
                    </td>
                    <td>{t.from.path}</td>
                    <td>{t.to.path}</td>
                    <td>
                      <TransferStatus status={t.status} />
                    </td>
                    <td className="num">{formatDecimal(t.totals.planned)}</td>
                    <td className="num">{formatDecimal(t.totals.inTransit)}</td>
                    <td className="num">{formatDecimal(t.totals.received)}</td>
                    <td>{formatDateTime(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      {canTransfer ? (
        <div className="form-columns">
          <NewTransferForm shopId={shopId} onCreated={select} />
          <MoveForm shopId={shopId} />
        </div>
      ) : null}
    </>
  );
}

function useTransfersRefresh(shopId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'transfers'] }),
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'transfer'] }),
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'availability'] }),
    ]);
}

function NewTransferForm({
  shopId,
  onCreated,
}: {
  shopId: string;
  onCreated: (transferId: string) => void;
}) {
  const { all } = useStockLocations(shopId);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [ready, setReady] = useState(true);
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const refresh = useTransfersRefresh(shopId);
  const fromId = from || all[0]?.locationId || '';
  const toId = to || all.find((l) => l.locationId !== fromId)?.locationId || '';
  const create = useMutation({
    mutationFn: async () => {
      const ids = await variantsBySku(
        shopId,
        lines.map((l) => l.sku.trim()),
      );
      return command<Out<typeof ops.createTransfer>>(`/shops/${shopId}/transfers`, {
        fromLocationId: fromId,
        toLocationId: toId,
        lines: lines.map((l, i) => ({
          variantId: ids[i],
          quantity: l.quantity.trim(),
          ...(l.lotCode.trim() ? { lotCode: l.lotCode.trim() } : {}),
        })),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ready,
      });
    },
    onSuccess: async (res) => {
      setLines([emptyLine()]);
      setReference('');
      setNote('');
      await refresh();
      onCreated(res.transfer.transferId);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <form className="stack mini-form" onSubmit={submit}>
      <h3>New transfer</h3>
      <Field label="From">
        <select value={fromId} onChange={(e) => setFrom(e.target.value)}>
          {all.map((l) => (
            <option key={l.locationId} value={l.locationId}>
              {l.path}
            </option>
          ))}
        </select>
      </Field>
      <Field label="To">
        <select value={toId} onChange={(e) => setTo(e.target.value)}>
          {all.map((l) => (
            <option key={l.locationId} value={l.locationId}>
              {l.path}
            </option>
          ))}
        </select>
      </Field>
      <LinesEditor lines={lines} onChange={setLines} />
      <Field label="Reference">
        <input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="Your transfer number"
          maxLength={200}
        />
      </Field>
      <Field label="Note">
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} />
        Hold the stock at the source now
      </label>
      <button type="submit" disabled={create.isPending || all.length < 2}>
        Create transfer
      </button>
      <ErrorNotice error={create.error} />
    </form>
  );
}

function MoveForm({ shopId }: { shopId: string }) {
  const { all, leaves } = useStockLocations(shopId);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const refresh = useTransfersRefresh(shopId);
  const fromId = from || all[0]?.locationId || '';
  const fromWarehouse = all.find((l) => l.locationId === fromId)?.warehouseId;
  const targets = leaves.filter((l) => l.warehouseId === fromWarehouse && l.locationId !== fromId);
  const toId = to && targets.some((l) => l.locationId === to) ? to : (targets[0]?.locationId ?? '');
  const move = useMutation({
    mutationFn: async () => {
      const ids = await variantsBySku(
        shopId,
        lines.map((l) => l.sku.trim()),
      );
      return command<Out<typeof ops.moveStock>>(`/shops/${shopId}/moves`, {
        fromLocationId: fromId,
        toLocationId: toId,
        lines: lines.map((l, i) => ({
          variantId: ids[i],
          quantity: l.quantity.trim(),
          ...(l.lotCode.trim() ? { lotCode: l.lotCode.trim() } : {}),
        })),
      });
    },
    onSuccess: async () => {
      setLines([emptyLine()]);
      await refresh();
    },
  });
  return (
    <form
      className="stack mini-form"
      onSubmit={(e) => {
        e.preventDefault();
        move.mutate();
      }}
    >
      <h3>Move within a warehouse</h3>
      <Field label="From">
        <select value={fromId} onChange={(e) => setFrom(e.target.value)}>
          {all.map((l) => (
            <option key={l.locationId} value={l.locationId}>
              {l.path}
            </option>
          ))}
        </select>
      </Field>
      <Field label="To">
        <select value={toId} onChange={(e) => setTo(e.target.value)}>
          {targets.map((l) => (
            <option key={l.locationId} value={l.locationId}>
              {l.path}
            </option>
          ))}
        </select>
      </Field>
      <LinesEditor lines={lines} onChange={setLines} />
      <button type="submit" disabled={move.isPending || !toId}>
        Move now
      </button>
      <ErrorNotice error={move.error} />
      {move.data ? <Notice tone="ok">Moved.</Notice> : null}
    </form>
  );
}

// Detail ----------------------------------------------------------------------------------------

function TransferDetail({
  shopId,
  transferId,
  onClose,
}: {
  shopId: string;
  transferId: string;
  onClose: () => void;
}) {
  const context = useShopContext(shopId);
  const detail = useQuery({
    queryKey: ['shop', shopId, 'transfer', transferId],
    queryFn: () => api<Transfer>(`/shops/${shopId}/transfers/${transferId}`),
  });
  const t = detail.data;
  const canTransfer = can(context.data, 'inventory.transfer');
  const canAdjust = can(context.data, 'inventory.adjust');
  return (
    <Card
      title={t ? `Transfer ${t.reference ?? t.transferId.slice(-8)}` : 'Transfer'}
      actions={
        <button type="button" className="small ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <ErrorNotice error={detail.error} />
      {detail.isPending ? <Loading /> : null}
      {t ? (
        <>
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              <TransferStatus status={t.status} />
            </dd>
            <dt>From</dt>
            <dd>{t.from.path}</dd>
            <dt>To</dt>
            <dd>{t.to.path}</dd>
            {t.trackingReference ? (
              <>
                <dt>Tracking</dt>
                <dd>{t.trackingReference}</dd>
              </>
            ) : null}
            {t.note ? (
              <>
                <dt>Note</dt>
                <dd>{t.note}</dd>
              </>
            ) : null}
            <dt>Created</dt>
            <dd>{formatDateTime(t.createdAt)}</dd>
          </dl>
          {t.exception.open ? <Notice>Exception: {t.exception.note}</Notice> : null}
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Condition</th>
                  <th className="num">Planned</th>
                  <th className="num">Cancelled</th>
                  <th className="num">Held</th>
                  <th className="num">Dispatched</th>
                  <th className="num">In transit</th>
                  <th className="num">Received</th>
                  <th className="num">Resolved</th>
                </tr>
              </thead>
              <tbody>
                {t.lines.map((l) => (
                  <tr key={l.lineId}>
                    <td>
                      {l.sku}
                      {l.lotCode ? ` · ${l.lotCode}` : ''}
                      {l.entered ? (
                        <span className="muted">
                          {' '}
                          ({formatDecimal(l.entered.quantity)} × {l.entered.packName})
                        </span>
                      ) : null}
                      {l.inTransitUnits.some((u) => u.lotCode || u.serial) ? (
                        <div className="muted">
                          In transit:{' '}
                          {l.inTransitUnits
                            .map((u) => u.serial ?? `${u.lotCode} × ${formatDecimal(u.quantity)}`)
                            .join(', ')}
                        </div>
                      ) : null}
                    </td>
                    <td>{titleCase(l.condition)}</td>
                    <td className="num">{formatDecimal(l.planned)}</td>
                    <td className="num">{formatDecimal(l.cancelled)}</td>
                    <td className="num">{formatDecimal(l.held)}</td>
                    <td className="num">{formatDecimal(l.dispatched)}</td>
                    <td className="num">{formatDecimal(l.inTransit)}</td>
                    <td className="num">{formatDecimal(l.received)}</td>
                    <td className="num">{formatDecimal(l.resolved)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canTransfer ? (
            <TransferActions shopId={shopId} transfer={t} canAdjust={canAdjust} />
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

type Step = 'dispatch' | 'receive' | 'cancel' | 'resolve';

function TransferActions({
  shopId,
  transfer: t,
  canAdjust,
}: {
  shopId: string;
  transfer: Transfer;
  canAdjust: boolean;
}) {
  const refresh = useTransfersRefresh(shopId);
  const { leaves } = useStockLocations(shopId);
  const destinations = leaves.filter(
    (l) => l.locationId === t.to.locationId || l.path.startsWith(`${t.to.path}/`),
  );
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [locationId, setLocationId] = useState('');
  const [condition, setCondition] = useState('');
  const [resolution, setResolution] = useState('lost');
  const [note, setNote] = useState('');
  const path = `/shops/${shopId}/transfers/${t.transferId}`;
  const items = () => {
    const chosen = t.lines
      .filter((l) => (quantities[l.lineId] ?? '').trim() !== '')
      .map((l) => ({ variantId: l.variantId, quantity: quantities[l.lineId]!.trim() }));
    return chosen.length > 0 ? { items: chosen } : {};
  };
  const act = useMutation({
    mutationFn: (step: Step | 'ready' | 'exception') => {
      if (step === 'ready') return command(`${path}/ready`, {});
      if (step === 'exception') return command(`${path}/exception`, { note: note.trim() });
      if (step === 'receive') {
        const dest = locationId || destinations[0]?.locationId;
        return command(`${path}/receive`, {
          ...items(),
          ...(dest && dest !== t.to.locationId ? { locationId: dest } : {}),
          ...(condition ? { condition } : {}),
        });
      }
      if (step === 'resolve') return command(`${path}/resolve`, { ...items(), resolution });
      return command(`${path}/${step}`, items());
    },
    onSuccess: async () => {
      setQuantities({});
      setNote('');
      await refresh();
    },
  });
  const held = Number(t.totals.held) > 0;
  const transit = Number(t.totals.inTransit) > 0;
  const open = !['received', 'cancelled'].includes(t.status);
  if (!open) return null;
  return (
    <div className="stack">
      {t.status === 'draft' ? (
        <div className="form-actions">
          <button type="button" disabled={act.isPending} onClick={() => act.mutate('ready')}>
            Make ready (hold the stock)
          </button>
          <button
            type="button"
            className="ghost"
            disabled={act.isPending}
            onClick={() => act.mutate('cancel')}
          >
            Cancel transfer
          </button>
        </div>
      ) : null}
      {t.status !== 'draft' && (held || transit) ? (
        <>
          <h3>Quantities for the next step</h3>
          <div className="inline-form">
            {t.lines.map((l) => (
              <Field key={l.lineId} label={l.sku}>
                <input
                  value={quantities[l.lineId] ?? ''}
                  onChange={(e) => setQuantities({ ...quantities, [l.lineId]: e.target.value })}
                  inputMode="decimal"
                  placeholder="All"
                  size={6}
                />
              </Field>
            ))}
          </div>
          <div className="form-actions">
            {held ? (
              <button type="button" disabled={act.isPending} onClick={() => act.mutate('dispatch')}>
                Dispatch
              </button>
            ) : null}
            {held ? (
              <button
                type="button"
                className="ghost"
                disabled={act.isPending}
                onClick={() => act.mutate('cancel')}
              >
                Cancel the rest
              </button>
            ) : null}
          </div>
          {transit ? (
            <div className="inline-form">
              <Field label="Receive at">
                <select
                  value={locationId || destinations[0]?.locationId || ''}
                  onChange={(e) => setLocationId(e.target.value)}
                >
                  {destinations.map((l) => (
                    <option key={l.locationId} value={l.locationId}>
                      {l.path}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Condition">
                <select value={condition} onChange={(e) => setCondition(e.target.value)}>
                  <option value="">As sent</option>
                  <option value="sellable">Sellable</option>
                  <option value="quarantine">Quarantine</option>
                  <option value="damaged">Damaged</option>
                </select>
              </Field>
              <button
                type="button"
                disabled={act.isPending || destinations.length === 0}
                onClick={() => act.mutate('receive')}
              >
                Receive
              </button>
            </div>
          ) : null}
          {transit ? (
            <div className="inline-form">
              <Field label="Problem">
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What is missing or damaged"
                  maxLength={2000}
                />
              </Field>
              <button
                type="button"
                className="ghost"
                disabled={act.isPending || note.trim() === ''}
                onClick={() => act.mutate('exception')}
              >
                Report exception
              </button>
              {canAdjust ? (
                <>
                  <Field label="Resolve as">
                    <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                      <option value="lost">Lost in transit</option>
                      <option value="damaged">Destroyed in transit</option>
                      <option value="short">Never shipped</option>
                    </select>
                  </Field>
                  <button
                    type="button"
                    className="danger"
                    disabled={act.isPending}
                    onClick={() => act.mutate('resolve')}
                  >
                    Write off in-transit units
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      <ErrorNotice error={act.error} />
    </div>
  );
}
