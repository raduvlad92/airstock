import type { ops } from '@airstock/core';
import { add, compare, multiply, normalize } from '@airstock/core/catalog/decimal';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { command, errorMessage, type Out } from '../api.ts';
import { formatDecimal } from '../components/ui.tsx';
import { can } from '../context.tsx';
import { type ScanEnv, useScanHandler } from './flows.ts';
import { ItemTitle } from './lookup.tsx';
import type { Resolved, ScanItem } from './resolve.ts';
import { ScanField } from './scan-field.tsx';
import { UnknownCode } from './unknown.tsx';

type Receipt = Out<typeof ops.receiveStock>;
type Pack = ScanItem['packs'][number];

/**
 * Receive (plan 5.2, 5.12): a free receipt into the current location through the receipt
 * command. Scan the item (or its case), adjust the quantity and pack, capture the lot and expiry
 * or scan serials one by one, optionally enter a unit cost (costs.read only), and confirm. The
 * quantity and pack are spelled out on the button before anything is committed. Receiving
 * against a purchase order plugs in here as a second source of the item and quantity (I4b).
 */
export function ReceiveFlow({ env }: { env: ScanEnv }) {
  const [item, setItem] = useState<ScanItem | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);

  const start = (next: ScanItem) => {
    setUnknown(null);
    setItem(next);
  };

  useScanHandler((scan) => {
    if (scan.kind === 'location') return false;
    if (item) return false; // The open form takes scans itself (see ReceiveForm).
    if (scan.kind === 'unknown') {
      setUnknown(scan.code);
      env.feedback('error', `No item has the code ${scan.code}.`);
      return true;
    }
    start(scan.item);
    env.feedback('ok');
    return true;
  });

  if (item) {
    return <ReceiveForm key={item.variantId} env={env} item={item} onDone={() => setItem(null)} />;
  }
  return (
    <>
      {unknown ? (
        <UnknownCode
          key={unknown}
          env={env}
          code={unknown}
          onDone={(resolved: Resolved) => {
            if (resolved.kind === 'item') start(resolved.item);
          }}
        />
      ) : (
        <div className="scan-hint">
          <h2>Receive</h2>
          <p>
            {env.location
              ? `Scan the item or its case to receive into ${env.location.path}.`
              : 'Scan a location label first, then the item.'}
          </p>
        </div>
      )}
    </>
  );
}

function ReceiveForm({ env, item, onDone }: { env: ScanEnv; item: ScanItem; onDone: () => void }) {
  const serialMode = item.trackingMode === 'serial';
  const lotMode = item.trackingMode === 'lot' || item.trackingMode === 'lot_expiry';
  const [pack, setPack] = useState<Pack | null>(serialMode ? null : item.pack);
  const [quantity, setQuantity] = useState('1');
  const [lotCode, setLotCode] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [serials, setSerials] = useState<string[]>([]);
  const [unitCost, setUnitCost] = useState('');
  const [costPer, setCostPer] = useState<'base_unit' | 'pack'>('base_unit');
  const key = useRef(crypto.randomUUID());
  const seesCosts = can(env.shop, 'costs.read');

  const addSerial = (code: string) => {
    const s = code.trim();
    if (!s) return;
    if (serials.some((x) => x.toUpperCase() === s.toUpperCase())) {
      env.feedback('error', `${s} is already in this receipt.`);
      return;
    }
    setSerials((list) => [...list, s]);
    env.feedback('ok', `Serial ${s} added.`);
  };

  // While the form is open, the same item adds one more; serials and lot codes are captured.
  useScanHandler((scan) => {
    if (scan.kind === 'location') return false;
    if (scan.kind === 'item' && scan.item.variantId === item.variantId) {
      if (serialMode) {
        if (scan.item.matchedBy === 'serial') {
          env.feedback('error', `${scan.code} is already received.`);
        } else {
          env.feedback('notice', 'Scan each unit’s serial.');
        }
        return true;
      }
      const scannedPack = scan.item.pack;
      if ((scannedPack?.packId ?? null) !== (pack?.packId ?? null)) {
        setPack(scannedPack);
        setQuantity('1');
        env.feedback(
          'notice',
          scannedPack ? `Switched to ${scannedPack.name}.` : 'Switched to units.',
        );
      } else {
        setQuantity((q) => normalize(add(/^\d+(\.\d{1,6})?$/.test(q) ? q : '0', '1')));
        env.feedback('ok');
      }
      return true;
    }
    if (scan.kind === 'unknown' && serialMode) {
      addSerial(scan.code);
      return true;
    }
    if (scan.kind === 'unknown' && lotMode && !lotCode) {
      setLotCode(scan.code);
      env.feedback('ok', `Lot ${scan.code}.`);
      return true;
    }
    env.feedback('error', 'Finish or cancel this receipt before scanning another item.');
    return true;
  });

  const typed = /^\d+(\.\d{1,6})?$/.test(quantity) ? quantity : '0';
  const entered = serialMode ? String(serials.length) : typed;
  const base = pack ? normalize(multiply(entered, pack.baseQuantity)) : normalize(entered);
  const valid =
    env.location !== null &&
    compare(entered, '0') > 0 &&
    (!lotMode || lotCode.trim() !== '') &&
    (item.trackingMode !== 'lot_expiry' || expiresOn !== '');

  const receive = useMutation({
    mutationFn: () =>
      command<Receipt>(
        `/shops/${env.shopId}/receipts`,
        {
          variantId: item.variantId,
          locationId: env.location!.locationId,
          quantity: entered,
          ...(pack ? { packId: pack.packId } : {}),
          ...(lotMode ? { lotCode: lotCode.trim() } : {}),
          ...(lotMode && expiresOn ? { expiresOn } : {}),
          ...(serialMode ? { serials } : {}),
          ...(seesCosts && unitCost.trim()
            ? { unitCost: unitCost.trim(), costPer: pack ? costPer : 'base_unit' }
            : {}),
        },
        key.current,
      ),
    onSuccess: (r) => {
      key.current = crypto.randomUUID();
      const text = `Received ${formatDecimal(r.quantity)} × ${item.sku} into ${env.location?.path}.`;
      env.feedback('ok', text);
      onDone();
    },
    onError: (error) => env.feedback('error', errorMessage(error)),
  });

  const step = (delta: string) =>
    setQuantity((q) => {
      const next = normalize(add(/^\d+(\.\d{1,6})?$/.test(q) ? q : '0', delta));
      return compare(next, '1') < 0 ? '1' : next;
    });

  return (
    <div className="scan-card">
      <ItemTitle item={item} />
      {!env.location ? (
        <p className="notice error">Scan a location label: where do these go?</p>
      ) : null}

      {serialMode ? (
        <>
          <ScanField
            label="Serial"
            placeholder="Scan or type each serial"
            button="Add"
            onSubmit={addSerial}
          />
          {serials.length > 0 ? (
            <ul className="scan-serials" aria-label="Serials">
              {serials.map((s) => (
                <li key={s}>
                  <span className="mono">{s}</span>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => setSerials((list) => list.filter((x) => x !== s))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">One serial per unit. Scan them one by one.</p>
          )}
        </>
      ) : (
        <>
          {item.packs.length > 0 ? (
            <select
              aria-label="Pack"
              value={pack?.packId ?? ''}
              onChange={(e) => {
                setPack(item.packs.find((p) => p.packId === e.target.value) ?? null);
              }}
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
              onClick={() => step('-1')}
            >
              −
            </button>
            <input
              aria-label="Quantity"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value.replace(',', '.'))}
            />
            <button
              type="button"
              className="secondary"
              aria-label="One more"
              onClick={() => step('1')}
            >
              +
            </button>
          </div>
        </>
      )}

      {lotMode ? (
        <>
          <ScanField
            label="Lot"
            placeholder="Lot code"
            button="Set"
            keepValue
            onSubmit={(code) => setLotCode(code)}
            inputProps={{ value: lotCode, onChange: (e) => setLotCode(e.target.value) }}
          />
          {item.trackingMode === 'lot_expiry' ? (
            <input
              type="date"
              aria-label="Expiry date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
              required
            />
          ) : null}
        </>
      ) : null}

      {seesCosts ? (
        <div className="scan-cost">
          <input
            aria-label="Unit cost"
            placeholder="Unit cost (optional)"
            inputMode="decimal"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value.replace(',', '.'))}
          />
          {pack ? (
            <select
              aria-label="Cost per"
              value={costPer}
              onChange={(e) => setCostPer(e.target.value as 'base_unit' | 'pack')}
            >
              <option value="base_unit">per unit</option>
              <option value="pack">per {pack.name}</option>
            </select>
          ) : null}
        </div>
      ) : null}

      <p className="scan-confirm" aria-live="polite">
        {pack
          ? `${formatDecimal(entered)} × ${pack.name} (${formatDecimal(pack.baseQuantity)}) = ${formatDecimal(base)} units`
          : `${formatDecimal(base)} ${base === '1' ? 'unit' : 'units'}`}
        {lotMode && lotCode ? ` · lot ${lotCode}` : ''}
        {env.location ? ` → ${env.location.path}` : ''}
      </p>
      <div className="scan-actions">
        <button
          type="button"
          disabled={!valid || receive.isPending}
          onClick={() => receive.mutate()}
        >
          {receive.isPending ? 'Receiving…' : `Receive ${formatDecimal(base)}`}
        </button>
        <button type="button" className="secondary" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
      {receive.error ? <p className="notice error">{errorMessage(receive.error)}</p> : null}
    </div>
  );
}
