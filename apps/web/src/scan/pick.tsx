import type { ops } from '@airstock/core';
import { add, compare, normalize } from '@airstock/core/catalog/decimal';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, command, errorMessage, type Out } from '../api.ts';
import { formatDecimal } from '../components/ui.tsx';
import { can } from '../context.tsx';
import {
  linePacks,
  type PickLineView,
  type PickListView,
  recordedSummary,
} from '../picking/view.ts';
import { type ScanEnv, useScanHandler } from './flows.ts';
import { ScanField } from './scan-field.tsx';

type Lists = Out<typeof ops.listPickLists>;
type Picked = Out<typeof ops.recordPick>;
type Shorted = Out<typeof ops.recordShortPick>;
type Completed = Out<typeof ops.completePickList>;

const DECIMAL = /^\d+(\.\d{1,6})?$/;

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: the open list is not remembered.
  }
}

/**
 * Pick (plan 5.11, PRD 6.10) on the phone: choose or build a pick list, then for each line scan
 * the location, scan the item, and confirm the quantity. Picks never change stock. Scanning
 * another lot or serial moves the allocation there first (the server reallocates). A short pick
 * records what was found and flags the line for a count. Finishing the list fulfills manual and
 * API reservations; Shopify orders are fulfilled from Shopify.
 */
export function PickFlow({ env }: { env: ScanEnv }) {
  const key = `airstock.scan.pick.${env.shopId}`;
  const [listId, setListId] = useState<string | null>(() => remembered(key));
  const choose = (id: string | null) => {
    remember(key, id);
    setListId(id);
  };
  if (!listId) return <PickListChooser env={env} onChoose={choose} />;
  return <PickWalk key={listId} env={env} listId={listId} onLeave={() => choose(null)} />;
}

function PickListChooser({ env, onChoose }: { env: ScanEnv; onChoose: (id: string) => void }) {
  const queryClient = useQueryClient();
  const lists = useQuery({
    queryKey: ['shop', env.shopId, 'pick-lists', 'open'],
    queryFn: () => api<Lists>(`/shops/${env.shopId}/pick-lists`, { query: { status: 'open' } }),
  });
  const canPick = can(env.shop, 'picking.run');
  const create = useMutation({
    mutationFn: (filters: { orders?: string[]; warehouseId?: string }) =>
      command<PickListView>(`/shops/${env.shopId}/pick-lists`, filters),
    onSuccess: async (list) => {
      await queryClient.invalidateQueries({ queryKey: ['shop', env.shopId, 'pick-lists'] });
      env.feedback('ok', `Pick list ${list.number}: ${list.lines} lines.`);
      onChoose(list.pickListId);
    },
    onError: (error) => env.feedback('error', errorMessage(error)),
  });
  return (
    <div className="scan-card">
      <h2>Pick</h2>
      {lists.data && lists.data.pickLists.length > 0 ? (
        <ul className="scan-choices" aria-label="Open pick lists">
          {lists.data.pickLists.map((l) => (
            <li key={l.pickListId}>
              <button type="button" className="scan-choice" onClick={() => onChoose(l.pickListId)}>
                <strong>Pick list {l.number}</strong>
                <span className="muted">
                  {l.openLines} of {l.lines} to pick · {l.orders} orders
                  {l.note ? ` · ${l.note}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : lists.isPending ? (
        <p className="muted">Loading…</p>
      ) : (
        <p className="muted">No open pick list.</p>
      )}
      {canPick ? (
        <div className="scan-actions">
          <button
            type="button"
            disabled={create.isPending}
            onClick={() =>
              create.mutate(env.location ? { warehouseId: env.location.warehouseId } : {})
            }
          >
            {create.isPending ? 'Building…' : 'New list: every open order'}
          </button>
          <ScanField
            label="Order"
            placeholder="Or one order's reference"
            button="Build"
            onSubmit={(ref) => create.mutate({ orders: [ref] })}
          />
        </div>
      ) : null}
    </div>
  );
}

interface Target {
  /** The scanned unit's serial, when it is not the line's. */
  serial?: string;
  /** The lot actually taken, when it is not the line's. */
  lotCode?: string;
}

function PickWalk({ env, listId, onLeave }: { env: ScanEnv; listId: string; onLeave: () => void }) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['shop', env.shopId, 'pick-list', listId],
    queryFn: () => api<PickListView>(`/shops/${env.shopId}/pick-lists/${listId}`),
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const [scanned, setScanned] = useState<{
    lineId: string;
    quantity: string;
    target: Target;
  } | null>(null);
  const [shortFound, setShortFound] = useState<string | null>(null);
  const [lastShort, setLastShort] = useState<
    (Shorted['count'] & { path: string; sku: string; lotCode: string | null }) | null
  >(null);
  const [completed, setCompleted] = useState<Completed | null>(null);
  const key = useRef(crypto.randomUUID());

  const lines = list.data?.pickLines ?? [];
  const open = lines.filter((l) => l.status === 'open');
  const current = open.find((l) => l.lineId === chosen) ?? open[0] ?? null;
  const here = current !== null && env.location?.locationId === current.locationId;
  const pending = scanned && current && scanned.lineId === current.lineId ? scanned : null;

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['shop', env.shopId, 'pick-list', listId] }),
      queryClient.invalidateQueries({ queryKey: ['shop', env.shopId, 'pick-lists'] }),
    ]);
  const done = () => {
    key.current = crypto.randomUUID();
    setScanned(null);
    setShortFound(null);
    setChosen(null);
  };

  const pick = useMutation({
    mutationFn: (p: { line: PickLineView; quantity: string; target: Target }) =>
      command<Picked>(
        `/shops/${env.shopId}/pick-lists/${listId}/picks`,
        {
          lineId: p.line.lineId,
          quantity: p.quantity,
          ...(p.target.lotCode ? { lotCode: p.target.lotCode } : {}),
          ...(p.target.serial ? { serial: p.target.serial } : {}),
        },
        key.current,
      ),
    onSuccess: async (r, p) => {
      env.feedback(
        'ok',
        `Picked ${formatDecimal(p.quantity)} × ${p.line.sku}${r.reallocated ? ' (from the scanned lot or serial)' : ''}. ${r.openLines} to go.`,
      );
      done();
      await refresh();
    },
    onError: (error) => env.feedback('error', errorMessage(error)),
  });
  const short = useMutation({
    mutationFn: (p: { line: PickLineView; found: string }) =>
      command<Shorted>(
        `/shops/${env.shopId}/pick-lists/${listId}/short-picks`,
        { lineId: p.line.lineId, found: p.found },
        key.current,
      ),
    onSuccess: async (r, p) => {
      env.feedback(
        'notice',
        `Short: ${formatDecimal(r.count.missing)} × ${p.line.sku} not found at ${p.line.locationPath}. Flagged for a count.`,
      );
      setLastShort({
        ...r.count,
        path: p.line.locationPath,
        sku: p.line.sku,
        lotCode: p.line.lotCode,
      });
      done();
      await refresh();
    },
    onError: (error) => env.feedback('error', errorMessage(error)),
  });
  const finish = useMutation({
    mutationFn: () =>
      command<Completed>(
        `/shops/${env.shopId}/pick-lists/${listId}/complete`,
        { fulfill: can(env.shop, 'inventory.fulfill') },
        key.current,
      ),
    onSuccess: async (r) => {
      key.current = crypto.randomUUID();
      setCompleted(r);
      env.feedback('ok', `Pick list done: ${r.fulfilled.length} fulfillment(s) recorded.`);
      await refresh();
    },
    onError: (error) => env.feedback('error', errorMessage(error)),
  });

  useScanHandler((scan) => {
    if (!current) return false;
    if (scan.kind === 'location') {
      if (scan.location.locationId === current.locationId) {
        env.feedback('ok', `At ${current.locationPath}. Scan the item.`);
        return true;
      }
      const there = open.find((l) => l.locationId === scan.location.locationId);
      if (there) {
        setChosen(there.lineId);
        env.feedback('ok', `At ${there.locationPath}. Scan the item.`);
      } else {
        env.feedback(
          'error',
          `Nothing to pick at ${scan.location.path}. Next: ${current.locationPath}.`,
        );
      }
      return true;
    }
    if (!here) {
      env.feedback('error', `Scan the location label of ${current.locationPath} first.`);
      return true;
    }
    if (scan.kind === 'unknown') {
      if (current.lotCode !== null || current.lotId !== null) {
        // A lot code scanned from the carton: the lot actually taken.
        const lotCode = scan.code;
        setScanned({
          lineId: current.lineId,
          quantity: pending?.quantity ?? '1',
          target: { ...(pending?.target ?? {}), lotCode },
        });
        env.feedback('ok', `Lot ${lotCode}.`);
        return true;
      }
      env.feedback('error', `No item has the code ${scan.code}.`);
      return true;
    }
    const item = scan.item;
    let line = current;
    if (item.variantId !== current.variantId) {
      const other = open.find(
        (l) => l.locationId === current.locationId && l.variantId === item.variantId,
      );
      if (!other) {
        env.feedback('error', `Wrong item: this stop needs ${current.sku}.`);
        return true;
      }
      setChosen(other.lineId);
      line = other;
    }
    const target: Target = { ...(pending?.lineId === line.lineId ? pending.target : {}) };
    if (item.serial && item.serial.serial !== line.serial) target.serial = item.serial.serial;
    const step = item.pack ? item.pack.baseQuantity : '1';
    const before = pending?.lineId === line.lineId ? pending.quantity : '0';
    let quantity = normalize(add(before, step));
    if (compare(quantity, line.remaining) > 0) quantity = line.remaining;
    setScanned({ lineId: line.lineId, quantity, target });
    env.feedback('ok');
    return true;
  });

  if (list.isPending) return <p className="muted">Loading the pick list…</p>;
  if (list.error) {
    return (
      <div className="scan-card">
        <p className="notice error">{errorMessage(list.error)}</p>
        <button type="button" className="secondary" onClick={onLeave}>
          Other lists
        </button>
      </div>
    );
  }
  const data = list.data;
  if (completed || data.status !== 'open') {
    return (
      <div className="scan-card">
        <h2>
          Pick list {data.number} is {completed ? 'complete' : data.status}
        </h2>
        {completed ? (
          <p>
            {completed.fulfilled.length} fulfillment(s) recorded
            {recordedSummary(completed.recordedOnly)
              .map((part) => `; ${part}`)
              .join('')}
            {completed.short ? `; ${completed.short} short line(s) stay reserved for a count` : ''}.
          </p>
        ) : null}
        <button type="button" onClick={onLeave}>
          Pick lists
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="scan-card">
        <div className="scan-pick-progress">
          <strong>Pick list {data.number}</strong>
          <span>
            {open.length} of {data.lines} to pick
          </span>
        </div>
        {current ? (
          <>
            <p className="muted">{here ? 'Pick here' : 'Go to'}</p>
            <p className="scan-pick-stop">{current.locationPath}</p>
            <h2>
              {current.productName}
              {current.variantName ? <span className="muted"> · {current.variantName}</span> : null}
            </h2>
            <p className="scan-meta">
              <span className="mono">{current.sku}</span>
              {current.lotCode ? <span>Lot {current.lotCode}</span> : null}
              {current.serial ? <span className="mono">SN {current.serial}</span> : null}
              {current.externalRef ? <span className="mono">{current.externalRef}</span> : null}
            </p>
            <p className="scan-confirm" aria-live="polite">
              {pending
                ? `${formatDecimal(pending.quantity)} of ${formatDecimal(current.remaining)} ${linePacks(current)}`
                : `Take ${formatDecimal(current.remaining)} ${linePacks(current)}`}
              {pending?.target.lotCode ? ` · lot ${pending.target.lotCode}` : ''}
              {pending?.target.serial ? ` · SN ${pending.target.serial}` : ''}
            </p>
            {!here ? (
              <div className="scan-actions">
                <p className="muted">Scan the location label, then the item.</p>
              </div>
            ) : shortFound !== null ? (
              <div className="scan-actions">
                <input
                  aria-label="Found"
                  inputMode="decimal"
                  value={shortFound}
                  onChange={(e) => setShortFound(e.target.value.replace(',', '.'))}
                />
                <button
                  type="button"
                  disabled={!DECIMAL.test(shortFound) || short.isPending}
                  onClick={() => short.mutate({ line: current, found: shortFound })}
                >
                  {`Only ${formatDecimal(DECIMAL.test(shortFound) ? shortFound : '0')} found`}
                </button>
                <button type="button" className="secondary" onClick={() => setShortFound(null)}>
                  Back
                </button>
              </div>
            ) : (
              <div className="scan-actions">
                {pending ? (
                  <button
                    type="button"
                    disabled={pick.isPending}
                    onClick={() =>
                      pick.mutate({
                        line: current,
                        quantity: pending.quantity,
                        target: pending.target,
                      })
                    }
                  >
                    {`Confirm ${formatDecimal(pending.quantity)}`}
                  </button>
                ) : (
                  <p className="muted">Scan the item to pick it.</p>
                )}
                <div className="scan-actions two">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      setScanned({
                        lineId: current.lineId,
                        quantity: current.remaining,
                        target: pending?.target ?? {},
                      })
                    }
                  >
                    All {formatDecimal(current.remaining)}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setShortFound(pending?.quantity ?? '0')}
                  >
                    Short…
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="scan-actions">
            <p>Every line is picked{data.shortLines ? ` (${data.shortLines} short)` : ''}.</p>
            <button type="button" disabled={finish.isPending} onClick={() => finish.mutate()}>
              {can(env.shop, 'inventory.fulfill') ? 'Finish and fulfill' : 'Finish'}
            </button>
          </div>
        )}
        {lastShort ? (
          <div className="scan-actions">
            {/* Count opens on the short line's shelf with the item listed (ADR 0026). */}
            <button
              type="button"
              className="secondary"
              onClick={() =>
                env.startFlow('count', {
                  reason: 'short_pick',
                  positionId: lastShort.positionId,
                  locationId: lastShort.locationId,
                  locationPath: lastShort.path,
                  variantId: lastShort.variantId,
                  missing: lastShort.missing,
                  sku: lastShort.sku,
                  ...(lastShort.lotCode ? { lotCode: lastShort.lotCode } : {}),
                })
              }
            >
              Count that shelf
            </button>
          </div>
        ) : null}
      </div>
      <ul className="scan-pick-lines" aria-label="Lines">
        {lines
          .filter((l) => l.status !== 'moved')
          .map((l) => (
            <li key={l.lineId}>
              <button
                type="button"
                className={current?.lineId === l.lineId ? 'current' : undefined}
                disabled={l.status !== 'open'}
                onClick={() => setChosen(l.lineId)}
              >
                <span>
                  {l.locationPath} · {l.sku}
                </span>
                <span className="muted">
                  {formatDecimal(l.quantity)} {linePacks(l)} {l.externalRef ?? ''}
                </span>
                <span className="scan-line-status">
                  {l.status === 'open' ? formatDecimal(l.remaining) : l.status}
                </span>
              </button>
            </li>
          ))}
      </ul>
      <button type="button" className="secondary" onClick={onLeave}>
        Other lists
      </button>
    </>
  );
}
