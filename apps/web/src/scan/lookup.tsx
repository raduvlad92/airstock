import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { formatDecimal } from '../components/ui.tsx';
import { type ScanEnv, useScanHandler } from './flows.ts';
import type { Resolved, ScanItem, ScanLocation, ScanStock } from './resolve.ts';
import { UnknownCode } from './unknown.tsx';

/**
 * Look up (plan 5.12): scan a variant, pack, or location barcode, a serial or certificate
 * number, or type a SKU, and see the item, its pack, and its stock per location. Each lookup is
 * a read the server logs as one. An unknown code offers to attach it or create an item.
 */
export function LookupFlow({ env }: { env: ScanEnv }) {
  const [last, setLast] = useState<Resolved | null>(null);
  useScanHandler((scan) => {
    setLast(scan);
    if (scan.kind === 'item') env.feedback('ok');
    else if (scan.kind === 'unknown') env.feedback('error', `No item has the code ${scan.code}.`);
    else env.feedback('ok', `Location: ${scan.location.path}`);
    return true;
  });
  if (!last) {
    return (
      <div className="scan-hint">
        <h2>Look up</h2>
        <p>Scan a product, a case, a certificate, or a location label.</p>
      </div>
    );
  }
  if (last.kind === 'item') {
    return <ItemCard env={env} item={last.item} stock={last.stock} />;
  }
  if (last.kind === 'location') return <LocationCard location={last.location} />;
  return (
    <UnknownCode
      key={last.code}
      env={env}
      code={last.code}
      onDone={(resolved) => setLast(resolved)}
    />
  );
}

export function ItemTitle({ item }: { item: ScanItem }) {
  return (
    <>
      <h2>
        {item.productName}
        {item.variantName ? <span className="muted"> · {item.variantName}</span> : null}
      </h2>
      <p className="scan-meta">
        <span className="mono">{item.sku}</span>
        {item.pack ? (
          <span className="scan-pack">
            {item.pack.name} = {formatDecimal(item.pack.baseQuantity)} units
          </span>
        ) : (
          <span className="scan-pack">Single unit</span>
        )}
        {item.serial ? <span className="mono">Serial {item.serial.serial}</span> : null}
        {item.trackingMode !== 'none' ? (
          <span>{TRACKING[item.trackingMode] ?? item.trackingMode}</span>
        ) : null}
        {item.oneOfAKind ? <span>One of a kind</span> : null}
      </p>
    </>
  );
}

const TRACKING: Record<string, string> = {
  lot: 'Tracked by lot',
  lot_expiry: 'Lots with expiry',
  serial: 'Tracked by serial',
};

export function ItemCard({
  env,
  item,
  stock,
}: {
  env: ScanEnv;
  item: ScanItem;
  stock: ScanStock | null;
}) {
  return (
    <div className="scan-card">
      <ItemTitle item={item} />
      {item.serial && item.serial.status !== 'in_stock' ? (
        <p className="notice">This unit is {item.serial.status.replaceAll('_', ' ')}.</p>
      ) : null}
      {stock ? <StockTable stock={stock} here={env.location?.locationId ?? null} /> : null}
      <p className="small-text">
        <Link
          to="/shops/$shopId/products"
          params={{ shopId: env.shopId }}
          search={{ item: item.productId }}
        >
          Open in the dashboard
        </Link>
      </p>
    </div>
  );
}

export function StockTable({ stock, here }: { stock: ScanStock; here: string | null }) {
  const t = stock.totals;
  return (
    <>
      <dl className="scan-totals">
        <div>
          <dt>Available</dt>
          <dd className="scan-num">{formatDecimal(t.available)}</dd>
        </div>
        <div>
          <dt>On hand</dt>
          <dd className="scan-num">{formatDecimal(t.onHand)}</dd>
        </div>
        <div>
          <dt>Reserved</dt>
          <dd className="scan-num">{formatDecimal(t.reserved)}</dd>
        </div>
      </dl>
      {stock.positions.length === 0 ? (
        <p className="muted">No stock anywhere{stock.partial ? ' you can see' : ''}.</p>
      ) : (
        <ul className="scan-positions" aria-label="Stock per location">
          {stock.positions.map((p) => (
            <li key={p.positionId} className={p.locationId === here ? 'here' : undefined}>
              <span className="scan-position-path">{p.locationPath}</span>
              <span className="scan-position-detail">
                {p.condition !== 'sellable' ? `${p.condition.replaceAll('_', ' ')} · ` : ''}
                {p.lotCode
                  ? `Lot ${p.lotCode}${p.expiresOn ? ` (exp. ${p.expiresOn})` : ''} · `
                  : ''}
                {p.serial ? `Serial ${p.serial} · ` : ''}
                {p.inTransit ? 'in transit · ' : ''}
                {formatDecimal(p.reserved) !== '0' ? `${formatDecimal(p.reserved)} reserved` : ''}
              </span>
              <strong className="scan-position-qty">{formatDecimal(p.onHand)}</strong>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function LocationCard({ location }: { location: ScanLocation }) {
  return (
    <div className="scan-card">
      <h2>{location.path}</h2>
      <p className="scan-meta">
        <span>{location.warehouseName}</span>
        {location.code ? <span className="mono">{location.code}</span> : null}
      </p>
      <p className="muted">
        {location.holdsStock
          ? 'Set as the current location for the next scans.'
          : 'This location has sub-locations; scan one of those.'}
      </p>
    </div>
  );
}
