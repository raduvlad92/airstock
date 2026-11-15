import { type ReactNode, useEffect, useRef } from 'react';
import { Badge, formatDecimal } from '../components/ui.tsx';
import type { Mode } from './schema.ts';
import { type Row, rowId } from './values.ts';

/** Extra card content another milestone adds, such as the primary picture (N4). */
export const galleryImage: { render?: (props: { shopId: string; row: Row }) => ReactNode } = {};

/** Cards from the same query as the grid (plan 5.13): picture, name, SKU, price, and stock. */
export function Gallery({
  shopId,
  mode,
  rows,
  hasMore,
  onNeedMore,
  onOpen,
}: {
  shopId: string;
  mode: Mode;
  rows: Row[];
  hasMore: boolean;
  onNeedMore(): void;
  onOpen(row: Row): void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onNeedMore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, onNeedMore]);
  return (
    <div className="gallery">
      {rows.map((row) => {
        const stock = row.available === null ? null : Number(row.available);
        return (
          <button
            type="button"
            key={rowId(row)}
            className="gallery-card"
            onClick={() => onOpen(row)}
          >
            <div className="gallery-image">
              {galleryImage.render ? (
                galleryImage.render({ shopId, row })
              ) : (
                <span aria-hidden="true">{row.name.slice(0, 1)}</span>
              )}
            </div>
            <div className="gallery-body">
              <strong>{row.name}</strong>
              <span className="muted">
                {mode === 'variants'
                  ? [row.title, row.sku].filter(Boolean).join(' · ')
                  : `${row.variantCount ?? 0} variants`}
              </span>
              <span className="gallery-meta">
                <span>
                  {mode === 'variants'
                    ? row.price
                      ? formatDecimal(row.price, 2)
                      : '—'
                    : row.priceRange?.min
                      ? formatDecimal(row.priceRange.min, 2)
                      : '—'}
                </span>
                {stock !== null ? (
                  <Badge tone={stock > 0 ? 'ok' : 'error'}>
                    {stock > 0 ? `${formatDecimal(row.available)} in stock` : 'Out of stock'}
                  </Badge>
                ) : null}
              </span>
            </div>
          </button>
        );
      })}
      <div ref={sentinel} className="gallery-sentinel" />
    </div>
  );
}
