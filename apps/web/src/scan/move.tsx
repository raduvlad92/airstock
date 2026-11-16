import type { ops } from '@airstock/core';
import { compare } from '@airstock/core/catalog/decimal';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { command, errorMessage, type Out } from '../api.ts';
import { formatDecimal } from '../components/ui.tsx';
import { useMutation } from '../mutation.ts';
import type { CurrentLocation, ScanEnv } from './flows.ts';
import { useScanHandler } from './flows.ts';
import { applyLineScan, type ItemLine, LineEditor, lineSummary, lineUnits } from './item-line.tsx';
import { isLotTracked, lotsAt, recordedAt, typed } from './tally.ts';

type Moved = Out<typeof ops.moveStock>;

/** What is missing before a line can move, if anything. */
function moveProblem(line: ItemLine, fromId: string): string | null {
  if (line.item.trackingMode === 'serial') {
    return line.serials.length === 0 ? `Scan the serial of each ${line.item.sku} to move.` : null;
  }
  if (!/^\d+(\.\d{1,6})?$/.test(line.tally.quantity) || compare(lineUnits(line), '0') <= 0) {
    return `How many ${line.item.sku}? Scan each one or type the number.`;
  }
  if (isLotTracked(line.item) && !line.lotCode.trim() && lotsAt(line.stock, fromId).length !== 1) {
    return `Which lot of ${line.item.sku}? Choose or scan it.`;
  }
  return null;
}

function moveLine(line: ItemLine, fromId: string) {
  const lots = lotsAt(line.stock, fromId);
  const lotCode =
    line.lotCode.trim() || (isLotTracked(line.item) && lots.length === 1 ? lots[0]! : '');
  if (line.item.trackingMode === 'serial') {
    return {
      variantId: line.item.variantId,
      quantity: String(line.serials.length),
      serials: line.serials,
    };
  }
  return {
    variantId: line.item.variantId,
    quantity: typed(line.tally.quantity),
    ...(line.tally.pack ? { packId: line.tally.pack.packId } : {}),
    ...(isLotTracked(line.item) && lotCode ? { lotCode } : {}),
  };
}

/**
 * Move (plan D8, 5.4, 5.12): inside one warehouse, scan the shelf the stock is on, then the items
 * (each scan adds one, a case adds a case, serials one by one), then the destination's label, and
 * confirm. It is one command (inventory.moves.create) that holds, dispatches, and receives
 * together, recorded as a completed transfer.
 */
export function MoveFlow({ env }: { env: ScanEnv }) {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState<CurrentLocation | null>(env.location);
  const [to, setTo] = useState<CurrentLocation | null>(null);
  const [lines, setLinesState] = useState<ItemLine[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const setLines = (next: ItemLine[]) => {
    key.current = crypto.randomUUID();
    setLinesState(next);
  };

  // Before any item is scanned, the move starts from the current location.
  useEffect(() => {
    if (lines.length === 0 && !to) setFrom(env.location);
  }, [env.location, lines.length, to]);

  const reset = () => {
    setLines([]);
    setActive(null);
    setTo(null);
  };

  const move = useMutation({
    mutationFn: () =>
      command<Moved>(
        `/shops/${env.shopId}/moves`,
        {
          fromLocationId: from!.locationId,
          toLocationId: to!.locationId,
          lines: lines.map((l) => moveLine(l, from!.locationId)),
        },
        key.current,
      ),
    onSuccess: () => {
      env.feedback(
        'ok',
        `Moved ${lines.map((l) => lineSummary(l)).join('; ')} from ${from!.path} to ${to!.path}.`,
      );
      reset();
      void queryClient.invalidateQueries({ queryKey: ['shop', env.shopId] });
    },
    onError: (error) => {
      key.current = crypto.randomUUID();
      env.feedback('error', errorMessage(error));
    },
  });

  useScanHandler((scan) => {
    if (scan.kind === 'location') {
      const loc: CurrentLocation = {
        locationId: scan.location.locationId,
        path: scan.location.path,
        warehouseId: scan.location.warehouseId,
      };
      if (lines.length === 0) {
        setFrom(loc);
        setTo(null);
        env.feedback('ok', `Moving from ${loc.path}. Scan the items.`);
      } else if (loc.locationId === from?.locationId) {
        setTo(null);
        env.feedback('notice', `The items are at ${loc.path} now. Scan where they go.`);
      } else if (from && loc.warehouseId !== from.warehouseId) {
        env.feedback(
          'error',
          `${loc.path} is in another warehouse. A move stays inside one; use a transfer in the dashboard.`,
        );
      } else {
        setTo(loc);
        env.feedback('ok', `To ${loc.path}. Check and confirm.`);
      }
      return true;
    }
    if (!from) {
      env.feedback('error', 'Scan the label of the shelf you are taking from first.');
      return true;
    }
    if (scan.kind === 'item' && scan.item.matchedBy === 'serial' && scan.item.serial) {
      const at = scan.item.serial.locationId;
      if (at !== from.locationId) {
        env.feedback(
          'error',
          `${scan.item.serial.serial} is ${at ? `at ${scan.item.serial.locationPath}` : scan.item.serial.status.replaceAll('_', ' ')}, not at ${from.path}.`,
        );
        return true;
      }
    }
    const next = applyLineScan(lines, active, scan, { unknownSerials: false });
    if (next.lines !== lines) setLines(next.lines);
    setActive(next.active);
    env.feedback(next.tone, next.message);
    return true;
  });

  const blocked = from
    ? (lines.map((l) => moveProblem(l, from.locationId)).find(Boolean) ?? null)
    : null;
  const units = lines.reduce((n, l) => n + Number(lineUnits(l)), 0);
  return (
    <div className="scan-card">
      <h2>Move</h2>
      <dl className="scan-route">
        <div>
          <dt>From</dt>
          <dd>{from ? from.path : <span className="muted">scan a location label</span>}</dd>
        </div>
        <div>
          <dt>To</dt>
          <dd>
            {to ? (
              to.path
            ) : (
              <span className="muted">
                {lines.length > 0 ? 'scan the destination label' : 'after the items'}
              </span>
            )}
          </dd>
        </div>
      </dl>
      {from && lines.length === 0 ? (
        <p className="muted">Scan each item to move: every scan adds one, a case adds a case.</p>
      ) : null}
      {lines.length > 0 && from ? (
        <ul className="scan-count-lines" aria-label="Items to move">
          {lines.map((line) => {
            const here = recordedAt(
              line.stock,
              from.locationId,
              isLotTracked(line.item) ? line.lotCode : undefined,
            );
            const short = here && compare(lineUnits(line), here.available) > 0;
            return line.id === active ? (
              <li key={line.id} className="open">
                <LineEditor
                  env={env}
                  line={line}
                  locationId={from.locationId}
                  note={here ? `Available here: ${formatDecimal(here.available)}` : null}
                  quantityLabel="Quantity"
                  serialHint="Scan the serial of each unit you take."
                  onChange={(next) => setLines(lines.map((l) => (l.id === next.id ? next : l)))}
                  onRemove={() => {
                    setLines(lines.filter((l) => l.id !== line.id));
                    setActive(null);
                  }}
                />
                {short ? (
                  <p className="notice">
                    Only {formatDecimal(here!.available)} available here; reserved units stay put.
                  </p>
                ) : null}
              </li>
            ) : (
              <li key={line.id}>
                <button type="button" className="scan-line-row" onClick={() => setActive(line.id)}>
                  <span>{line.item.productName}</span>
                  <span className="scan-line-status">{lineSummary(line)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {lines.length > 0 && from ? (
        <>
          <p className="scan-confirm" aria-live="polite">
            {lines.map((l) => lineSummary(l)).join('; ')} · {from.path} → {to ? to.path : '?'}
          </p>
          {blocked ? <p className="notice error">{blocked}</p> : null}
          <div className="scan-actions">
            <button
              type="button"
              disabled={!to || blocked !== null || move.isPending}
              onClick={() => move.mutate()}
            >
              {move.isPending
                ? 'Moving…'
                : to
                  ? `Move ${formatDecimal(String(units))} ${units === 1 ? 'unit' : 'units'} to ${to.path}`
                  : 'Scan the destination label'}
            </button>
            <button type="button" className="secondary" onClick={reset}>
              Clear
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
