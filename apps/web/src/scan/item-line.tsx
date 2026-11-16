import { formatDecimal } from '../components/ui.tsx';
import type { ScanEnv } from './flows.ts';
import type { Resolved, ScanItem, ScanStock } from './resolve.ts';
import { ScanField } from './scan-field.tsx';
import {
  addScan,
  baseUnits,
  describeTally,
  isLotTracked,
  lotsAt,
  sameCode,
  step,
  type Tally,
  withPack,
} from './tally.ts';

/**
 * One item being scanned in a count or a move: a tally in units or a pack, the lot, or the
 * serials seen. Shared by Count and Move, which differ only in what they post.
 */
export interface ItemLine {
  id: string;
  item: ScanItem;
  stock: ScanStock | null;
  tally: Tally;
  lotCode: string;
  serials: string[];
}

export function newLine(item: ScanItem, stock: ScanStock | null): ItemLine {
  return {
    id: crypto.randomUUID(),
    item,
    stock,
    tally: { pack: null, quantity: '0' },
    lotCode: '',
    serials: [],
  };
}

/** Base units on the line: the tally, or one per serial. */
export function lineUnits(line: ItemLine): string {
  return line.item.trackingMode === 'serial' ? String(line.serials.length) : baseUnits(line.tally);
}

/** "BOX-1: 2 × Case (6) = 12 units · lot L1", shown before the commit. */
export function lineSummary(line: ItemLine): string {
  const what =
    line.item.trackingMode === 'serial'
      ? `${line.serials.length} ${line.serials.length === 1 ? 'serial' : 'serials'}`
      : describeTally(line.tally);
  return `${line.item.sku}: ${what}${line.lotCode ? ` · lot ${line.lotCode}` : ''}`;
}

export interface LineScan {
  lines: ItemLine[];
  active: string | null;
  tone: 'ok' | 'error' | 'notice';
  message?: string;
}

/**
 * Applies a scan to a list of lines: the same item adds one (a case adds a case), a serial joins
 * its item's line, and an unknown code is a serial or a lot code when the open line needs one.
 * Returns the lines, the line now open, and what to tell the person.
 */
export function applyLineScan(
  lines: ItemLine[],
  activeId: string | null,
  scan: Exclude<Resolved, { kind: 'location' }>,
  options: { unknownSerials: boolean } = { unknownSerials: true },
): LineScan {
  const active = lines.find((l) => l.id === activeId) ?? null;
  const replace = (next: ItemLine) => lines.map((l) => (l.id === next.id ? next : l));
  const addSerial = (line: ItemLine, serial: string): LineScan => {
    if (line.serials.some((s) => sameCode(s, serial))) {
      return { lines, active: line.id, tone: 'error', message: `${serial} is already listed.` };
    }
    const next = { ...line, serials: [...line.serials, serial] };
    const list = lines.some((l) => l.id === line.id) ? replace(next) : [...lines, next];
    return { lines: list, active: line.id, tone: 'ok', message: `Serial ${serial}.` };
  };
  if (scan.kind === 'unknown') {
    if (active?.item.trackingMode === 'serial') {
      if (options.unknownSerials) return addSerial(active, scan.code);
      return {
        lines,
        active: activeId,
        tone: 'error',
        message: `${scan.code} is not a serial of ${active.item.sku} on record.`,
      };
    }
    if (active && isLotTracked(active.item) && !active.lotCode) {
      return {
        lines: replace({ ...active, lotCode: scan.code }),
        active: active.id,
        tone: 'ok',
        message: `Lot ${scan.code}.`,
      };
    }
    return {
      lines,
      active: activeId,
      tone: 'error',
      message: `No item has the code ${scan.code}.`,
    };
  }
  const { item, stock } = scan;
  const mine =
    (active?.item.variantId === item.variantId ? active : null) ??
    [...lines].reverse().find((l) => l.item.variantId === item.variantId) ??
    null;
  if (item.trackingMode === 'serial') {
    const line = mine ?? newLine(item, stock);
    if (item.matchedBy === 'serial' && item.serial) return addSerial(line, item.serial.serial);
    return {
      lines: mine ? lines : [...lines, line],
      active: line.id,
      tone: 'notice',
      message: `Scan the serial of each ${item.sku}.`,
    };
  }
  const line = mine ?? newLine(item, stock);
  const next = { ...line, tally: addScan(line.tally, item.pack) };
  return { lines: mine ? replace(next) : [...lines, next], active: line.id, tone: 'ok' };
}

/** One line's editor: units or a pack with − and +, a lot, or the serials scanned. */
export function LineEditor({
  env,
  line,
  locationId,
  note,
  quantityLabel,
  serialHint,
  onChange,
  onRemove,
  removeLabel = 'Remove',
}: {
  env: ScanEnv;
  line: ItemLine;
  /** Where the item is: its lots there are offered. */
  locationId: string | null;
  /** Such as "On record here: 12". */
  note?: string | null;
  quantityLabel: string;
  serialHint: string;
  onChange: (line: ItemLine) => void;
  onRemove: () => void;
  removeLabel?: string;
}) {
  const { item } = line;
  const serialMode = item.trackingMode === 'serial';
  const lotMode = isLotTracked(item);
  const lots = locationId ? lotsAt(line.stock, locationId) : [];
  const addSerial = (code: string) => {
    if (line.serials.some((s) => sameCode(s, code))) {
      env.feedback('error', `${code} is already listed.`);
      return;
    }
    onChange({ ...line, serials: [...line.serials, code] });
    env.feedback('ok', `Serial ${code}.`);
  };
  return (
    <div className="scan-line-editor">
      <h3>
        {item.productName}
        {item.variantName ? <span className="muted"> · {item.variantName}</span> : null}
      </h3>
      <p className="scan-meta">
        <span className="mono">{item.sku}</span>
        {note ? <span>{note}</span> : null}
      </p>
      {serialMode ? (
        <>
          <ScanField
            label="Serial"
            placeholder="Scan or type each serial"
            button="Add"
            onSubmit={addSerial}
          />
          {line.serials.length > 0 ? (
            <ul className="scan-serials" aria-label="Serials">
              {line.serials.map((s) => (
                <li key={s}>
                  <span className="mono">{s}</span>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() =>
                      onChange({ ...line, serials: line.serials.filter((x) => x !== s) })
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{serialHint}</p>
          )}
        </>
      ) : (
        <>
          {item.packs.length > 0 ? (
            <select
              aria-label="Pack"
              value={line.tally.pack?.packId ?? ''}
              onChange={(e) =>
                onChange({
                  ...line,
                  tally: withPack(
                    line.tally,
                    item.packs.find((p) => p.packId === e.target.value) ?? null,
                  ),
                })
              }
            >
              <option value="">Units</option>
              {item.packs.map((p) => (
                <option key={p.packId} value={p.packId}>
                  {p.name} ({formatDecimal(p.baseQuantity)})
                </option>
              ))}
            </select>
          ) : null}
          <div className="scan-quantity">
            <button
              type="button"
              className="secondary"
              aria-label="One less"
              onClick={() => onChange({ ...line, tally: step(line.tally, '-1') })}
            >
              −
            </button>
            <input
              aria-label={quantityLabel}
              inputMode="decimal"
              value={line.tally.quantity}
              onChange={(e) =>
                onChange({
                  ...line,
                  tally: { ...line.tally, quantity: e.target.value.replace(',', '.') },
                })
              }
            />
            <button
              type="button"
              className="secondary"
              aria-label="One more"
              onClick={() => onChange({ ...line, tally: step(line.tally, '1') })}
            >
              +
            </button>
          </div>
        </>
      )}
      {lotMode ? (
        lots.length > 0 ? (
          <select
            aria-label="Lot"
            value={lots.find((c) => sameCode(c, line.lotCode)) ?? ''}
            onChange={(e) => onChange({ ...line, lotCode: e.target.value })}
          >
            <option value="">{lots.length === 1 ? `Lot ${lots[0]}` : 'Which lot?'}</option>
            {lots.map((c) => (
              <option key={c} value={c}>
                Lot {c}
              </option>
            ))}
          </select>
        ) : (
          <ScanField
            label="Lot"
            placeholder="Lot code"
            button="Set"
            keepValue
            onSubmit={(code) => onChange({ ...line, lotCode: code })}
            inputProps={{
              value: line.lotCode,
              onChange: (e) => onChange({ ...line, lotCode: e.target.value }),
            }}
          />
        )
      ) : null}
      <p className="scan-confirm" aria-live="polite">
        {serialMode
          ? `${line.serials.length} ${line.serials.length === 1 ? 'unit' : 'units'}`
          : describeTally(line.tally)}
        {line.lotCode ? ` · lot ${line.lotCode}` : ''}
      </p>
      <button type="button" className="ghost small" onClick={onRemove}>
        {removeLabel}
      </button>
    </div>
  );
}
