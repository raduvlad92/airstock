import type { ops } from '@airstock/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { api, command, type Out } from '../api.ts';
import {
  belowReserved,
  type Choice,
  ClaimChoices,
  MovedSinceReadReview,
  movedSinceRead,
  type PositionRead,
} from '../components/count-review.tsx';
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
import { useStockLocations, variantsBySku } from './transfers.tsx';

// Counts and adjustments (plan D10, PRD 6.6): count sessions (optionally blind), entry, review
// after a movement, submit; quick counts of a shelf; adjustments with a reason. A count below
// reserved stock asks, per claim, to release it or move it to other stock.

type Session = Out<typeof ops.getCount>;
type Sessions = Out<typeof ops.listCounts>;

function useCountsRefresh(shopId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'counts'] }),
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'count'] }),
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'availability'] }),
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'reservations'] }),
    ]);
}

/**
 * A one-line count: the quantity on one shelf, posted as a count correction (D10). Used on the
 * Counts tab and in a product's stock panel.
 */
/** A stock panel position, as the count form reads it. */
export interface ReadPosition {
  locationId: string;
  condition: string;
  lotId: string | null;
  lotCode: string | null;
  serial: string | null;
  inTransit: boolean;
  onHand: string;
  version: number;
}

/**
 * What a count of one shelf is based on, from the positions shown: the sellable position there
 * (of the lot typed, for lots). Null when it cannot be told (a lot not given).
 */
export function readFor(
  positions: ReadPosition[],
  locationId: string,
  lots: boolean,
  lotCode: string,
): PositionRead | null {
  if (lots && !lotCode.trim()) return null;
  // Lot codes match as the server matches them: trimmed, spaces collapsed, any case.
  const norm = (code: string) => code.trim().replace(/\s+/g, ' ').toUpperCase();
  const p = positions.find(
    (x) =>
      x.locationId === locationId &&
      x.condition === 'sellable' &&
      !x.inTransit &&
      x.serial === null &&
      (lots ? norm(x.lotCode ?? '') === norm(lotCode) : x.lotId === null),
  );
  return p ? { version: p.version, onHand: p.onHand } : { version: null, onHand: '0' };
}

/**
 * A one-line count: the quantity on one shelf, posted as a count correction (D10). Used on the
 * Counts tab and in a product's stock panel. With the panel's positions, it sends what it read:
 * if the shelf moved since, the person reviews the count before anything changes.
 */
export function QuickCountForm({
  shopId,
  variantId,
  lots = false,
  positions,
}: {
  shopId: string;
  variantId?: string;
  lots?: boolean;
  positions?: ReadPosition[];
}) {
  const { leaves } = useStockLocations(shopId);
  const refresh = useCountsRefresh(shopId);
  const [locationId, setLocationId] = useState('');
  const [sku, setSku] = useState('');
  const [counted, setCounted] = useState('');
  const [lotCode, setLotCode] = useState('');
  const at = locationId || leaves[0]?.locationId || '';
  const count = useMutation({
    mutationFn: async (attempt: {
      counted: string;
      read: PositionRead | null;
      choices: Choice[];
    }) => {
      const id = variantId ?? (await variantsBySku(shopId, [sku.trim()]))[0];
      return command<Out<typeof ops.quickCount>>(`/shops/${shopId}/counts/quick`, {
        locationId: at,
        counts: [
          {
            variantId: id,
            counted: attempt.counted,
            ...(lotCode.trim() ? { lotCode: lotCode.trim() } : {}),
            ...(attempt.read ? { read: attempt.read } : {}),
          },
        ],
        ...(attempt.choices.length > 0 ? { reservationChoices: attempt.choices } : {}),
      });
    },
    onSuccess: async () => {
      setCounted('');
      await refresh();
    },
  });
  const last = count.variables;
  const problems = belowReserved(count.error);
  const moved = movedSinceRead(count.error)?.[0];
  return (
    <form
      className="stack mini-form"
      onSubmit={(e) => {
        e.preventDefault();
        count.mutate({
          counted: counted.trim(),
          read: positions ? readFor(positions, at, lots, lotCode) : null,
          choices: [],
        });
      }}
    >
      <h3>Count</h3>
      <Field label="Shelf">
        <select value={at} onChange={(e) => setLocationId(e.target.value)}>
          {leaves.map((l) => (
            <option key={l.locationId} value={l.locationId}>
              {l.path}
            </option>
          ))}
        </select>
      </Field>
      {variantId ? null : (
        <Field label="SKU">
          <input value={sku} onChange={(e) => setSku(e.target.value)} required maxLength={100} />
        </Field>
      )}
      <Field label="Counted">
        <input
          value={counted}
          onChange={(e) => setCounted(e.target.value)}
          inputMode="decimal"
          required
          placeholder="Units on the shelf"
        />
      </Field>
      {lots ? (
        <Field label="Lot">
          <input
            value={lotCode}
            onChange={(e) => setLotCode(e.target.value)}
            placeholder="The lot counted"
            maxLength={100}
          />
        </Field>
      ) : null}
      <button type="submit" disabled={count.isPending || !at}>
        Save count
      </button>
      {moved && last ? (
        <MovedSinceReadReview
          problem={moved}
          counted={last.counted}
          pending={count.isPending}
          onRetry={(c, read) => count.mutate({ counted: c, read, choices: [] })}
        />
      ) : problems && last ? (
        <ClaimChoices
          problems={problems}
          pending={count.isPending}
          onRetry={(choices) => count.mutate({ ...last, choices })}
        />
      ) : (
        <ErrorNotice error={count.error} />
      )}
      {count.data ? (
        <Notice tone="ok">
          {count.data.changes.length === 0
            ? 'Counted: no difference.'
            : `Counted: ${count.data.changes.map((c) => (c.delta.startsWith('-') ? c.delta : `+${c.delta}`)).join(', ')}.`}
        </Notice>
      ) : null}
    </form>
  );
}

const REASONS = [
  ['damage', 'Damage'],
  ['loss_or_theft', 'Loss or theft'],
  ['found', 'Found'],
  ['write_off', 'Write-off'],
  ['sample', 'Sample'],
  ['supplier_return', 'Supplier return'],
  ['count_correction', 'Count correction'],
  ['other', 'Other'],
] as const;

function AdjustForm({ shopId }: { shopId: string }) {
  const { leaves } = useStockLocations(shopId);
  const refresh = useCountsRefresh(shopId);
  const [locationId, setLocationId] = useState('');
  const [sku, setSku] = useState('');
  const [direction, setDirection] = useState('remove');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('damage');
  const [note, setNote] = useState('');
  const at = locationId || leaves[0]?.locationId || '';
  const adjust = useMutation({
    mutationFn: async (choices: Choice[]) => {
      const [variantId] = await variantsBySku(shopId, [sku.trim()]);
      return command<Out<typeof ops.adjustStock>>(`/shops/${shopId}/adjustments`, {
        locationId: at,
        adjustmentReason: reason,
        adjustments: [{ variantId, direction, quantity: quantity.trim() }],
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(choices.length > 0 ? { reservationChoices: choices } : {}),
      });
    },
    onSuccess: async () => {
      setQuantity('');
      setNote('');
      await refresh();
    },
  });
  const problems = belowReserved(adjust.error);
  return (
    <form
      className="stack mini-form"
      onSubmit={(e) => {
        e.preventDefault();
        adjust.mutate([]);
      }}
    >
      <h3>Adjust</h3>
      <Field label="Shelf">
        <select value={at} onChange={(e) => setLocationId(e.target.value)}>
          {leaves.map((l) => (
            <option key={l.locationId} value={l.locationId}>
              {l.path}
            </option>
          ))}
        </select>
      </Field>
      <Field label="SKU">
        <input value={sku} onChange={(e) => setSku(e.target.value)} required maxLength={100} />
      </Field>
      <Field label="Change">
        <select value={direction} onChange={(e) => setDirection(e.target.value)}>
          <option value="remove">Remove</option>
          <option value="add">Add</option>
        </select>
      </Field>
      <Field label="Quantity">
        <input
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          inputMode="decimal"
          required
        />
      </Field>
      <Field label="Reason">
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          {REASONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Note">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={reason === 'other' ? 'What happened (needed)' : 'Optional'}
          required={reason === 'other'}
          maxLength={2000}
        />
      </Field>
      <button type="submit" disabled={adjust.isPending || !at}>
        Adjust stock
      </button>
      {problems ? (
        <ClaimChoices
          problems={problems}
          pending={adjust.isPending}
          onRetry={(c) => adjust.mutate(c)}
        />
      ) : (
        <ErrorNotice error={adjust.error} />
      )}
      {adjust.data ? <Notice tone="ok">Adjusted.</Notice> : null}
    </form>
  );
}

export function CountsPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const search = useSearch({ from: '/shops/$shopId/inventory/counts' });
  const navigate = useNavigate({ from: '/shops/$shopId/inventory/counts' });
  const context = useShopContext(shopId);
  const [status, setStatus] = useState('open');
  const list = useQuery({
    queryKey: ['shop', shopId, 'counts', status],
    queryFn: () => api<Sessions>(`/shops/${shopId}/counts`, { query: { status, limit: 100 } }),
  });
  const select = (sessionId: string | undefined) =>
    navigate({ search: sessionId ? { count: sessionId } : {} });
  return (
    <>
      {search.count ? (
        <CountDetail shopId={shopId} sessionId={search.count} onClose={() => select(undefined)} />
      ) : null}
      <Card title="Count sessions">
        <div className="inline-form">
          <Field label="Show">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="open">Open</option>
              <option value="submitted">Submitted</option>
              <option value="all">All</option>
            </select>
          </Field>
        </div>
        <ErrorNotice error={list.error} />
        {list.isPending ? <Loading /> : null}
        {list.data && list.data.counts.length === 0 ? <Empty>No counts here.</Empty> : null}
        {list.data && list.data.counts.length > 0 ? (
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Count</th>
                  <th>Location</th>
                  <th>Status</th>
                  <th className="num">Lines</th>
                  <th className="num">Counted</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {list.data.counts.map((c) => (
                  <tr key={c.sessionId}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => select(c.sessionId)}
                      >
                        {c.name ?? (c.quick ? 'Quick count' : c.sessionId.slice(-8))}
                      </button>{' '}
                      {c.blind ? <Badge tone="muted">Blind</Badge> : null}
                    </td>
                    <td>{c.location?.path ?? 'Chosen positions'}</td>
                    <td>{titleCase(c.status)}</td>
                    <td className="num">{c.totals.lines}</td>
                    <td className="num">{c.totals.counted}</td>
                    <td>{formatDateTime(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      <div className="form-columns">
        {can(context.data, 'inventory.count') ? (
          <StartCountForm shopId={shopId} onStarted={select} />
        ) : null}
        {can(context.data, 'inventory.count') ? <QuickCountForm shopId={shopId} /> : null}
        {can(context.data, 'inventory.adjust') ? <AdjustForm shopId={shopId} /> : null}
      </div>
    </>
  );
}

function StartCountForm({
  shopId,
  onStarted,
}: {
  shopId: string;
  onStarted: (sessionId: string) => void;
}) {
  const { all } = useStockLocations(shopId);
  const refresh = useCountsRefresh(shopId);
  const [locationId, setLocationId] = useState('');
  const [name, setName] = useState('');
  const [blind, setBlind] = useState(false);
  const at = locationId || all[0]?.locationId || '';
  const start = useMutation({
    mutationFn: () =>
      command<Out<typeof ops.startCount>>(`/shops/${shopId}/counts`, {
        locationId: at,
        blind,
        ...(name.trim() ? { name: name.trim() } : {}),
      }),
    onSuccess: async (res) => {
      setName('');
      await refresh();
      onStarted(res.sessionId);
    },
  });
  return (
    <form
      className="stack mini-form"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate();
      }}
    >
      <h3>Start a count</h3>
      <Field label="Location">
        <select value={at} onChange={(e) => setLocationId(e.target.value)}>
          {all.map((l) => (
            <option key={l.locationId} value={l.locationId}>
              {l.path}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Such as Aisle A, November"
          maxLength={200}
        />
      </Field>
      <label className="check">
        <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
        Blind count (hide expected quantities)
      </label>
      <button type="submit" disabled={start.isPending || !at}>
        Start count
      </button>
      <ErrorNotice error={start.error} />
    </form>
  );
}

function CountDetail({
  shopId,
  sessionId,
  onClose,
}: {
  shopId: string;
  sessionId: string;
  onClose: () => void;
}) {
  const context = useShopContext(shopId);
  const refresh = useCountsRefresh(shopId);
  const detail = useQuery({
    queryKey: ['shop', shopId, 'count', sessionId],
    queryFn: () => api<Session>(`/shops/${shopId}/counts/${sessionId}`),
  });
  const s = detail.data;
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [reviews, setReviews] = useState<Record<string, string>>({});
  const path = `/shops/${shopId}/counts/${sessionId}`;
  const record = useMutation({
    mutationFn: () =>
      command(`${path}/record`, {
        counts: (s?.lines ?? [])
          .filter((l) => (counts[l.lineId] ?? '').trim() !== '')
          .map((l) => ({
            variantId: l.variantId,
            locationId: l.locationId,
            condition: l.condition,
            ...(l.lotCode ? { lotCode: l.lotCode } : {}),
            ...(l.serial
              ? Number(counts[l.lineId]) > 0
                ? { serials: [l.serial] }
                : { counted: '0' }
              : { counted: counts[l.lineId]!.trim() }),
          })),
      }),
    onSuccess: async () => {
      setCounts({});
      await refresh();
    },
  });
  const submit = useMutation({
    mutationFn: (choices: Choice[]) =>
      command<Out<typeof ops.submitCount>>(`${path}/submit`, {
        reviews: Object.entries(reviews)
          .filter(([, r]) => r !== '')
          .map(([lineId, resolution]) => ({ lineId, resolution })),
        ...(choices.length > 0 ? { reservationChoices: choices } : {}),
      }),
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: () => command(`${path}/cancel`, {}),
    onSuccess: refresh,
  });
  const canCount = can(context.data, 'inventory.count');
  const open = s?.status === 'open';
  const problems = belowReserved(submit.error);
  return (
    <Card
      title={s ? (s.name ?? (s.quick ? 'Quick count' : `Count ${s.sessionId.slice(-8)}`)) : 'Count'}
      actions={
        <button type="button" className="small ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <ErrorNotice error={detail.error} />
      {detail.isPending ? <Loading /> : null}
      {s ? (
        <>
          <dl className="facts">
            <dt>Status</dt>
            <dd>{titleCase(s.status)}</dd>
            <dt>Location</dt>
            <dd>{s.location?.path ?? 'Chosen positions'}</dd>
            <dt>Counted</dt>
            <dd>
              {s.totals.counted} of {s.totals.lines}
            </dd>
          </dl>
          {s.totals.needsReview > 0 ? (
            <Notice>
              {s.totals.needsReview} counted{' '}
              {s.totals.needsReview === 1 ? 'line has' : 'lines have'} moved since counting:
              recount, or choose how to post them.
            </Notice>
          ) : null}
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Shelf</th>
                  <th className="num">Expected</th>
                  <th className="num">Counted</th>
                  <th>Status</th>
                  {open && canCount ? <th>Enter</th> : null}
                </tr>
              </thead>
              <tbody>
                {s.lines.map((l) => (
                  <tr key={l.lineId}>
                    <td>
                      {l.sku}
                      {l.lotCode ? ` · ${l.lotCode}` : ''}
                      {l.serial ? ` · ${l.serial}` : ''}
                      {l.condition !== 'sellable' ? ` · ${titleCase(l.condition)}` : ''}
                      {l.needsReview ? (
                        <div className="muted">
                          Moved since counted:{' '}
                          {l.movementsSince
                            .map((m) => `${titleCase(m.kind)} ${formatDecimal(m.quantity)}`)
                            .join(', ')}
                          {open && canCount ? (
                            <select
                              aria-label={`Review ${l.sku}`}
                              value={reviews[l.lineId] ?? ''}
                              onChange={(e) =>
                                setReviews({ ...reviews, [l.lineId]: e.target.value })
                              }
                            >
                              <option value="">Decide…</option>
                              <option value="keep_count">Keep my count</option>
                              <option value="apply_movements">Count plus movements since</option>
                            </select>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td>{l.locationPath}</td>
                    <td className="num">{l.expected === null ? '—' : formatDecimal(l.expected)}</td>
                    <td className="num">{formatDecimal(l.counted)}</td>
                    <td>
                      {l.status === 'posted' && l.postedDelta && l.postedDelta !== '0.000000'
                        ? `Posted ${formatDecimal(l.postedDelta)}`
                        : titleCase(l.status)}
                    </td>
                    {open && canCount ? (
                      <td>
                        <input
                          aria-label={`Count ${l.sku}`}
                          value={counts[l.lineId] ?? ''}
                          onChange={(e) => setCounts({ ...counts, [l.lineId]: e.target.value })}
                          inputMode="decimal"
                          placeholder={l.serial ? '1 or 0' : 'Units'}
                          size={6}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {open && canCount ? (
            <div className="form-actions">
              <button type="button" disabled={record.isPending} onClick={() => record.mutate()}>
                Save counts
              </button>
              <button
                type="button"
                disabled={submit.isPending || s.totals.counted === 0}
                onClick={() => submit.mutate([])}
              >
                Submit count
              </button>
              <button
                type="button"
                className="ghost"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel count
              </button>
            </div>
          ) : null}
          <ErrorNotice error={record.error} />
          {problems ? (
            <ClaimChoices
              problems={problems}
              pending={submit.isPending}
              onRetry={(c) => submit.mutate(c)}
            />
          ) : (
            <ErrorNotice error={submit.error} />
          )}
          <ErrorNotice error={cancel.error} />
        </>
      ) : null}
    </Card>
  );
}
