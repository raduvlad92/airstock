import type { ops } from '@airstock/core';
import {
  add,
  compare,
  divide,
  multiply,
  normalize,
  subtract,
} from '@airstock/core/catalog/decimal';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, command, errorMessage, type Out } from '../api.ts';
import { formatDecimal } from '../components/ui.tsx';
import { can } from '../context.tsx';
import { useMutation } from '../mutation.ts';
import { type ScanEnv, useScanHandler } from './flows.ts';
import { ItemTitle } from './lookup.tsx';
import { type Resolved, resolveScan, type ScanItem } from './resolve.ts';
import { ScanField } from './scan-field.tsx';
import { UnknownCode } from './unknown.tsx';

type Receipt = Out<typeof ops.receiveStock>;
type PoReceipt = Out<typeof ops.receivePurchaseOrderLine>;
type Order = Out<typeof ops.getPurchaseOrder>;
type OrderLine = Order['lines'][number];
type Orders = Out<typeof ops.listPurchaseOrders>;
type Pack = ScanItem['packs'][number];

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
    // Private mode: not remembered.
  }
}

/**
 * Receive (plan 5.2, 5.8, 5.12): a free receipt into the current location, or a delivery against
 * a purchase order. Either way the item and quantity lead to the same confirm step: adjust the
 * quantity and pack, capture the lot and expiry or scan serials one by one, and confirm, with the
 * quantity and pack spelled out on the button before anything is committed.
 */
export function ReceiveFlow({ env }: { env: ScanEnv }) {
  const sourceKey = `airstock.scan.receive-source.${env.shopId}`;
  const [source, setSourceState] = useState<'free' | 'po'>(() =>
    remembered(sourceKey) === 'po' ? 'po' : 'free',
  );
  const setSource = (next: 'free' | 'po') => {
    remember(sourceKey, next);
    setSourceState(next);
  };
  return (
    <>
      <fieldset className="scan-segments" aria-label="Receive from">
        <button
          type="button"
          aria-pressed={source === 'free'}
          className={source === 'free' ? 'chosen' : 'secondary'}
          onClick={() => setSource('free')}
        >
          Free receipt
        </button>
        <button
          type="button"
          aria-pressed={source === 'po'}
          className={source === 'po' ? 'chosen' : 'secondary'}
          onClick={() => setSource('po')}
        >
          Purchase order
        </button>
      </fieldset>
      {source === 'free' ? <FreeReceive env={env} /> : <PoReceive env={env} />}
    </>
  );
}

function FreeReceive({ env }: { env: ScanEnv }) {
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
  return unknown ? (
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
  );
}

// Against a purchase order ------------------------------------------------------------------------

/** PO-0007, 0007, or 7: the number people read off the order. */
function poNumber(code: string): number | null {
  const m = /^(?:PO[-\s]?)?0*(\d{1,9})$/i.exec(code.trim());
  return m ? Number(m[1]) : null;
}

function PoReceive({ env }: { env: ScanEnv }) {
  const storeKey = `airstock.scan.receive-po.${env.shopId}`;
  const [orderId, setOrderId] = useState<string | null>(() => remembered(storeKey));
  const [first, setFirst] = useState<ScanItem | null>(null);
  const choose = (id: string | null, item: ScanItem | null = null) => {
    remember(storeKey, id);
    setFirst(item);
    setOrderId(id);
  };
  if (!orderId) return <PoChooser env={env} onChoose={choose} />;
  return (
    <PoWalk key={orderId} env={env} orderId={orderId} first={first} onLeave={() => choose(null)} />
  );
}

function PoChooser({
  env,
  onChoose,
}: {
  env: ScanEnv;
  onChoose: (id: string, item?: ScanItem | null) => void;
}) {
  const [everywhere, setEverywhere] = useState(false);
  const [withItem, setWithItem] = useState<ScanItem | null>(null);
  const orders = useQuery({
    queryKey: ['shop', env.shopId, 'purchase-orders', 'open', withItem?.variantId ?? null],
    queryFn: () =>
      api<Orders>(`/shops/${env.shopId}/purchase-orders`, {
        query: { status: 'open', limit: 200, variantId: withItem?.variantId },
      }),
  });
  const warehouseId = env.location?.warehouseId ?? null;
  const all = orders.data?.purchaseOrders ?? [];
  const shown = everywhere || !warehouseId ? all : all.filter((o) => o.warehouseId === warehouseId);

  const pickNumber = (code: string): boolean => {
    const n = poNumber(code);
    const found = n === null ? undefined : all.find((o) => poNumber(o.number) === n);
    if (found) {
      env.feedback('ok', `${found.number} from ${found.supplierName}.`);
      onChoose(found.id);
      return true;
    }
    return false;
  };

  useScanHandler(async (scan) => {
    if (scan.kind === 'location') return false;
    if (scan.kind === 'unknown') {
      if (!pickNumber(scan.code)) {
        env.feedback('error', `No open purchase order or item has the code ${scan.code}.`);
      }
      return true;
    }
    // An item: the open orders with a line for it.
    const found = await api<Orders>(`/shops/${env.shopId}/purchase-orders`, {
      query: { status: 'open', limit: 200, variantId: scan.item.variantId },
    });
    const here = found.purchaseOrders.filter((o) => !warehouseId || o.warehouseId === warehouseId);
    const candidates = here.length > 0 ? here : found.purchaseOrders;
    if (candidates.length === 1) {
      env.feedback('ok', `${candidates[0]!.number} from ${candidates[0]!.supplierName}.`);
      onChoose(candidates[0]!.id, scan.item);
    } else if (candidates.length === 0) {
      env.feedback('error', `No open purchase order has ${scan.item.sku}.`);
    } else {
      setWithItem(scan.item);
      setEverywhere(here.length === 0);
      env.feedback('notice', `${candidates.length} open orders have ${scan.item.sku}: choose one.`);
    }
    return true;
  });

  return (
    <div className="scan-card">
      <h2>Receive a purchase order</h2>
      <p className="muted">
        Choose the order, scan or type its number, or scan an item to find the orders it is on.
      </p>
      <ScanField
        label="Order number"
        placeholder="PO-0007"
        button="Open"
        onSubmit={(code) => {
          if (!pickNumber(code)) env.feedback('error', `No open purchase order ${code}.`);
        }}
      />
      {withItem ? (
        <p className="scan-meta">
          <span>With {withItem.sku}</span>
          <button type="button" className="ghost small" onClick={() => setWithItem(null)}>
            Show all
          </button>
        </p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="scan-choices" aria-label="Open purchase orders">
          {shown.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                className="scan-choice"
                onClick={() => onChoose(o.id, withItem?.variantId ? withItem : null)}
              >
                <strong>
                  {o.number} · {o.supplierName}
                </strong>
                <span className="muted">
                  {formatDecimal(o.open)} units open · {o.warehouseName}
                  {o.expectedOn ? ` · expected ${o.expectedOn}` : ''}
                  {o.overdue ? ' · overdue' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : orders.isPending ? (
        <p className="muted">Loading…</p>
      ) : (
        <p className="muted">
          No open purchase order{warehouseId && !everywhere ? ' for this warehouse' : ''}.
        </p>
      )}
      {warehouseId && !everywhere && all.length > shown.length ? (
        <button type="button" className="secondary" onClick={() => setEverywhere(true)}>
          Other warehouses ({all.length - shown.length})
        </button>
      ) : null}
    </div>
  );
}

/** The line a scanned item (or case) belongs to: same variant, same pack first, open first. */
export function matchLine(order: Order, item: ScanItem): OrderLine | null {
  const mine = order.lines.filter((l) => l.variantId === item.variantId);
  const pack = item.pack?.packId ?? null;
  const open = (l: OrderLine) => compare(l.open, '0') > 0;
  return (
    mine.find((l) => l.packId === pack && open(l)) ??
    mine.find(open) ??
    mine.find((l) => l.packId === pack) ??
    mine[0] ??
    null
  );
}

/** "4 × Case (6) = 24": a line's base quantity in its pack where whole packs fit. */
function inLinePack(line: OrderLine, base: string): string {
  if (!line.packId || !line.packFactor) return formatDecimal(base);
  const packs = normalize(divide(base, line.packFactor));
  return !packs.includes('.')
    ? `${formatDecimal(packs)} × ${line.packName} (${formatDecimal(line.packFactor)}) = ${formatDecimal(base)}`
    : formatDecimal(base);
}

function PoWalk({
  env,
  orderId,
  first,
  onLeave,
}: {
  env: ScanEnv;
  orderId: string;
  first: ScanItem | null;
  onLeave: () => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['shop', env.shopId, 'purchase-order', orderId];
  const order = useQuery({
    queryKey,
    queryFn: () => api<Order>(`/shops/${env.shopId}/purchase-orders/${orderId}`),
  });
  const [open, setOpen] = useState<{ line: OrderLine; item: ScanItem } | null>(null);
  const [pendingFirst, setPendingFirst] = useState(first);

  // The item scanned to find this order opens its line once the order is loaded.
  useEffect(() => {
    if (!pendingFirst || !order.data) return;
    const line = matchLine(order.data, pendingFirst);
    if (line) setOpen({ line, item: pendingFirst });
    setPendingFirst(null);
  }, [pendingFirst, order.data]);

  const openLine = async (line: OrderLine) => {
    try {
      const found = await resolveScan(env.shopId, line.sku);
      if (found.kind === 'item' && found.item.variantId === line.variantId) {
        // Tapping a line starts in the line's own pack, as if its case had been scanned.
        const pack =
          line.packId && line.packFactor
            ? { packId: line.packId, name: line.packName ?? 'Pack', baseQuantity: line.packFactor }
            : null;
        setOpen({ line, item: { ...found.item, pack } });
      } else {
        env.feedback('notice', `Scan ${line.sku} to receive it.`);
      }
    } catch (error) {
      env.feedback('error', errorMessage(error));
    }
  };

  useScanHandler((scan) => {
    if (scan.kind === 'location' || !order.data || open) return false;
    if (scan.kind === 'unknown') {
      env.feedback('error', `No item has the code ${scan.code}.`);
      return true;
    }
    const line = matchLine(order.data, scan.item);
    if (!line) {
      env.feedback('error', `${order.data.number} has no line for ${scan.item.sku}.`);
      return true;
    }
    setOpen({ line, item: scan.item });
    env.feedback('ok');
    return true;
  });

  if (order.isPending) return <p className="muted">Loading the order…</p>;
  if (order.error) {
    return (
      <div className="scan-card">
        <p className="notice error">{errorMessage(order.error)}</p>
        <button type="button" className="secondary" onClick={onLeave}>
          Other orders
        </button>
      </div>
    );
  }
  const o = order.data;
  if (open) {
    return (
      <ReceiveForm
        key={open.line.id}
        env={env}
        item={open.item}
        po={{ order: o, line: open.line }}
        onDone={(updated) => {
          if (updated) queryClient.setQueryData(queryKey, updated);
          setOpen(null);
        }}
      />
    );
  }
  const receivable = o.status === 'sent' || o.status === 'partially_received';
  return (
    <>
      <div className="scan-card">
        <div className="scan-pick-progress">
          <strong>
            {o.number} · {o.supplier.name}
          </strong>
          <span>{o.status.replaceAll('_', ' ')}</span>
        </div>
        <p className="muted">
          {o.warehouse.name}
          {o.location ? ` · receives into ${o.location.path}` : ''}
          {o.expectedOn ? ` · expected ${o.expectedOn}` : ''}
        </p>
        <p>
          {receivable
            ? env.location || o.location
              ? `Scan each item or its case to receive it${env.location ? ` into ${env.location.path}` : ''}.`
              : 'Scan a location label first, then the items.'
            : `This order is ${o.status.replaceAll('_', ' ')}; nothing more is expected.`}
        </p>
      </div>
      <ul className="scan-pick-lines" aria-label="Order lines">
        {o.lines.map((l) => (
          <li key={l.id}>
            <button
              type="button"
              disabled={!receivable}
              onClick={() => void openLine(l)}
              aria-label={`${l.sku}: ordered ${formatDecimal(l.ordered)}, received ${formatDecimal(l.received)}, open ${formatDecimal(l.open)}`}
            >
              <span>
                {l.sku} · {l.productName}
                {l.variantName ? ` · ${l.variantName}` : ''}
              </span>
              <span className="muted">
                Ordered {inLinePack(l, l.ordered)} · received {formatDecimal(l.received)}
                {compare(l.overReceived, '0') > 0 ? ` (${formatDecimal(l.overReceived)} over)` : ''}
              </span>
              <span className="scan-line-status">
                {compare(l.open, '0') > 0 ? `${formatDecimal(l.open)} open` : 'done'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="secondary" onClick={onLeave}>
        Other orders
      </button>
    </>
  );
}

// The confirm step, shared ------------------------------------------------------------------------

function ReceiveForm({
  env,
  item,
  po,
  onDone,
}: {
  env: ScanEnv;
  item: ScanItem;
  /** Receiving against this purchase order line instead of a free receipt. */
  po?: { order: Order; line: OrderLine };
  onDone: (order?: Order) => void;
}) {
  const serialMode = item.trackingMode === 'serial';
  const lotMode = item.trackingMode === 'lot' || item.trackingMode === 'lot_expiry';
  // Against an order the quantity is in the line's pack or in units; a free receipt takes any pack.
  const linePack: Pack | null =
    po?.line.packId && po.line.packFactor
      ? {
          packId: po.line.packId,
          name: po.line.packName ?? 'Pack',
          baseQuantity: po.line.packFactor,
        }
      : null;
  const packs = po ? (linePack ? [linePack] : []) : item.packs;
  const scannedOther = po && item.pack && item.pack.packId !== linePack?.packId ? item.pack : null;
  const [pack, setPack] = useState<Pack | null>(
    serialMode ? null : po ? (scannedOther ? null : item.pack ? linePack : null) : item.pack,
  );
  const [quantity, setQuantity] = useState(scannedOther ? scannedOther.baseQuantity : '1');
  const [lotCode, setLotCode] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [serials, setSerials] = useState<string[]>([]);
  const [unitCost, setUnitCost] = useState('');
  const [costPer, setCostPer] = useState<'base_unit' | 'pack'>('base_unit');
  const [confirmOver, setConfirmOver] = useState(false);
  const key = useRef(crypto.randomUUID());
  const seesCosts = can(env.shop, 'costs.read') && !po;
  const location = env.location ?? (po?.order.location ? { path: po.order.location.path } : null);

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
      const current = DECIMAL.test(quantity) ? quantity : '0';
      if (po && scannedPack && scannedPack.packId !== linePack?.packId) {
        // A pack the order line is not in: count its units.
        const units = pack ? normalize(multiply(current, pack.baseQuantity)) : current;
        setPack(null);
        setQuantity(normalize(add(units, scannedPack.baseQuantity)));
        env.feedback('ok', `${scannedPack.name}: counted in units.`);
      } else if ((scannedPack?.packId ?? null) !== (pack?.packId ?? null)) {
        setPack(scannedPack);
        setQuantity('1');
        env.feedback(
          'notice',
          scannedPack ? `Switched to ${scannedPack.name}.` : 'Switched to units.',
        );
      } else {
        setQuantity(normalize(add(current, '1')));
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

  const typedQty = DECIMAL.test(quantity) ? quantity : '0';
  const entered = serialMode ? String(serials.length) : typedQty;
  const base = pack ? normalize(multiply(entered, pack.baseQuantity)) : normalize(entered);
  const over =
    po && compare(base, po.line.open) > 0 ? normalize(subtract(base, po.line.open)) : '0';
  const valid =
    location !== null &&
    compare(entered, '0') > 0 &&
    (!lotMode || lotCode.trim() !== '') &&
    (item.trackingMode !== 'lot_expiry' || expiresOn !== '') &&
    (over === '0' || confirmOver);

  const tracked = {
    ...(lotMode ? { lotCode: lotCode.trim() } : {}),
    ...(lotMode && expiresOn ? { expiresOn } : {}),
    ...(serialMode ? { serials } : {}),
  };
  const receive = useMutation({
    mutationFn: async (): Promise<{ quantity: string; order?: Order }> => {
      if (po) {
        const r = await command<PoReceipt>(
          `/shops/${env.shopId}/purchase-orders/${po.order.id}/receive`,
          {
            lineId: po.line.id,
            quantity: entered,
            ...(!pack && po.line.packId ? { inBaseUnits: true } : {}),
            ...(env.location ? { locationId: env.location.locationId } : {}),
            ...tracked,
            ...(over !== '0' ? { confirmOverReceipt: true } : {}),
          },
          key.current,
        );
        return { quantity: r.receipt.quantity, order: r.purchaseOrder };
      }
      const r = await command<Receipt>(
        `/shops/${env.shopId}/receipts`,
        {
          variantId: item.variantId,
          locationId: env.location!.locationId,
          quantity: entered,
          ...(pack ? { packId: pack.packId } : {}),
          ...tracked,
          ...(seesCosts && unitCost.trim()
            ? { unitCost: unitCost.trim(), costPer: pack ? costPer : 'base_unit' }
            : {}),
        },
        key.current,
      );
      return { quantity: r.quantity };
    },
    onSuccess: (r) => {
      key.current = crypto.randomUUID();
      if (po && r.order) {
        const left = r.order.lines.find((l) => l.id === po.line.id)?.open ?? '0';
        env.feedback(
          'ok',
          `Received ${formatDecimal(r.quantity)} × ${item.sku} against ${po.order.number}${compare(left, '0') > 0 ? ` (${formatDecimal(left)} still open)` : ''}.`,
        );
      } else {
        env.feedback(
          'ok',
          `Received ${formatDecimal(r.quantity)} × ${item.sku} into ${location?.path}.`,
        );
      }
      onDone(r.order);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'over_receipt') {
        // Another receipt got there first: the line has less open than shown.
        setConfirmOver(false);
      }
      env.feedback('error', errorMessage(error));
    },
  });

  const step = (delta: string) =>
    setQuantity((q) => {
      const next = normalize(add(DECIMAL.test(q) ? q : '0', delta));
      return compare(next, '1') < 0 ? '1' : next;
    });

  return (
    <div className="scan-card">
      <ItemTitle item={item} />
      {po ? (
        <p className="scan-po-line">
          <strong>{po.order.number}</strong> · ordered {formatDecimal(po.line.ordered)} · received{' '}
          {formatDecimal(po.line.received)} · <strong>{formatDecimal(po.line.open)} open</strong>
        </p>
      ) : null}
      {!location ? <p className="notice error">Scan a location label: where do these go?</p> : null}

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
          {packs.length > 0 ? (
            <select
              aria-label="Pack"
              value={pack?.packId ?? ''}
              onChange={(e) => {
                setPack(packs.find((p) => p.packId === e.target.value) ?? null);
              }}
            >
              <option value="">Units</option>
              {packs.map((p) => (
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

      {over !== '0' ? (
        <label className="scan-over notice">
          <input
            type="checkbox"
            checked={confirmOver}
            onChange={(e) => setConfirmOver(e.target.checked)}
          />
          <span>
            This is {formatDecimal(over)} more than the {formatDecimal(po!.line.open)} still open.
            Receive the extra {formatDecimal(over)} as an over-receipt.
          </span>
        </label>
      ) : null}

      <p className="scan-confirm" aria-live="polite">
        {pack
          ? `${formatDecimal(entered)} × ${pack.name} (${formatDecimal(pack.baseQuantity)}) = ${formatDecimal(base)} units`
          : `${formatDecimal(base)} ${base === '1' ? 'unit' : 'units'}`}
        {lotMode && lotCode ? ` · lot ${lotCode}` : ''}
        {location ? ` → ${location.path}` : ''}
      </p>
      <div className="scan-actions">
        <button
          type="button"
          disabled={!valid || receive.isPending}
          onClick={() => receive.mutate()}
        >
          {receive.isPending
            ? 'Receiving…'
            : `Receive ${formatDecimal(base)}${over !== '0' ? ` (${formatDecimal(over)} over)` : ''}`}
        </button>
        <button type="button" className="secondary" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
      {receive.error ? <p className="notice error">{errorMessage(receive.error)}</p> : null}
    </div>
  );
}
