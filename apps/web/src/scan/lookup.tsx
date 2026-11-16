import type { ops } from '@airstock/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type Out } from '../api.ts';
import { ErrorNotice, formatDecimal, Loading } from '../components/ui.tsx';
import { type ScanEnv, useScanHandler } from './flows.ts';
import type { BarcodeMatch, LocationRow, Resolved } from './resolve.ts';

type Availability = Out<typeof ops.getAvailability>;

/**
 * Look up (plan 5.12): scan a variant, pack, or location barcode and see the item, its pack, and
 * its stock per location. Each lookup is a read the server logs as one.
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
        <p>Scan a product, a case, or a location label.</p>
      </div>
    );
  }
  if (last.kind === 'item') return <ItemCard env={env} match={last.match} />;
  if (last.kind === 'location') return <LocationCard location={last.location} />;
  return (
    <div className="scan-card">
      <h2>Unknown code</h2>
      <p className="mono scan-code">{last.code}</p>
      <p className="muted">No product or pack in this shop has this code.</p>
    </div>
  );
}

export function ItemCard({ env, match }: { env: ScanEnv; match: BarcodeMatch }) {
  const stock = useQuery({
    queryKey: ['shop', env.shopId, 'availability', match.variantId],
    queryFn: () =>
      api<Availability>(`/shops/${env.shopId}/availability`, {
        query: { variantId: match.variantId },
      }),
  });
  return (
    <div className="scan-card">
      <h2>{match.productName}</h2>
      <p className="scan-meta">
        <span className="mono">{match.sku}</span>
        {match.packName ? (
          <span className="scan-pack">
            {match.packName} = {formatDecimal(match.baseQuantity)} units
          </span>
        ) : (
          <span className="scan-pack">Single unit</span>
        )}
      </p>
      {stock.isPending ? <Loading label="Loading stock…" /> : null}
      <ErrorNotice error={stock.error} />
      {stock.data ? (
        <StockTable stock={stock.data} here={env.location?.locationId ?? null} />
      ) : null}
      <p className="small-text">
        <Link
          to="/shops/$shopId/products"
          params={{ shopId: env.shopId }}
          search={{ item: match.productId }}
        >
          Open in the dashboard
        </Link>
      </p>
    </div>
  );
}

export function StockTable({ stock, here }: { stock: Availability; here: string | null }) {
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
        <ul className="scan-positions">
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
                {formatDecimal(p.reserved) !== '0'
                  ? `${formatDecimal(p.reserved)} reserved · `
                  : ''}
              </span>
              <strong className="scan-position-qty">{formatDecimal(p.onHand)}</strong>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function LocationCard({ location }: { location: LocationRow }) {
  return (
    <div className="scan-card">
      <h2>{location.path}</h2>
      <p className="scan-meta">
        <span>{location.warehouseName}</span>
        {location.code ? <span className="mono">{location.code}</span> : null}
      </p>
      <p className="muted">Set as the current location for the next scans.</p>
    </div>
  );
}
