import type { ops } from '@airstock/core';
import { useQuery } from '@tanstack/react-query';
import { api, type Out } from '../../api.ts';
import { detailExtensions } from '../../catalog/detail.tsx';
import { galleryImage } from '../../catalog/gallery.tsx';
import type { Row } from '../../catalog/values.ts';
import { MediaManager } from './MediaManager.tsx';

type Picture = Out<typeof ops.getPrimaryPictures>['pictures'][number];
type Key = { type: 'product' | 'variant'; id: string };

/**
 * Gallery cards ask for their primary picture one by one; this collects the asks made in the
 * same tick and sends them as one request of at most 200 IDs, so a page of cards is one read
 * and one access event.
 */
class PictureBatcher {
  private pending = new Map<
    string,
    { key: Key; resolve(p: Picture | null): void; reject(e: unknown): void }[]
  >();
  private scheduled = false;

  constructor(private readonly shopId: string) {}

  load(key: Key): Promise<Picture | null> {
    return new Promise((resolve, reject) => {
      const k = `${key.type}:${key.id}`;
      const waiting = this.pending.get(k);
      if (waiting) waiting.push({ key, resolve, reject });
      else this.pending.set(k, [{ key, resolve, reject }]);
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => this.flush());
      }
    });
  }

  private flush() {
    this.scheduled = false;
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (let i = 0; i < entries.length; i += 200) {
      const chunk = entries.slice(i, i + 200);
      const productIds = chunk
        .filter(([, w]) => w[0]!.key.type === 'product')
        .map(([, w]) => w[0]!.key.id);
      const variantIds = chunk
        .filter(([, w]) => w[0]!.key.type === 'variant')
        .map(([, w]) => w[0]!.key.id);
      api<Out<typeof ops.getPrimaryPictures>>(`/shops/${this.shopId}/media/primary`, {
        query: { productIds: productIds.join(','), variantIds: variantIds.join(',') },
      }).then(
        ({ pictures }) => {
          const byKey = new Map(pictures.map((p) => [`${p.recordType}:${p.recordId}`, p]));
          for (const [k, waiting] of chunk)
            for (const w of waiting) w.resolve(byKey.get(k) ?? null);
        },
        (error) => {
          for (const [, waiting] of chunk) for (const w of waiting) w.reject(error);
        },
      );
    }
  }
}

const batchers = new Map<string, PictureBatcher>();
function batcherFor(shopId: string) {
  let batcher = batchers.get(shopId);
  if (!batcher) {
    batcher = new PictureBatcher(shopId);
    batchers.set(shopId, batcher);
  }
  return batcher;
}

function GalleryPicture({ shopId, row }: { shopId: string; row: Row }) {
  const key: Key = row.variantId
    ? { type: 'variant', id: row.variantId }
    : { type: 'product', id: row.productId };
  const picture = useQuery({
    queryKey: ['shop', shopId, 'media', 'primary', key.type, key.id],
    queryFn: () => batcherFor(shopId).load(key),
    // Signed links last at least 15 minutes; refresh well before they expire.
    staleTime: 5 * 60_000,
  });
  const thumb = picture.data?.thumbnail;
  if (thumb?.url) {
    return (
      <img
        src={thumb.url}
        alt={picture.data?.altText ?? row.name}
        width={thumb.width ?? undefined}
        height={thumb.height ?? undefined}
        loading="lazy"
      />
    );
  }
  return <span aria-hidden="true">{row.name.slice(0, 1)}</span>;
}

let registered = false;

/** Adds pictures to the catalog screens (plan 5.13): a detail tab and the gallery card image. */
export function registerMediaExtensions() {
  if (registered) return;
  registered = true;
  detailExtensions.push({
    id: 'media',
    label: 'Pictures',
    render: ({ shopId, item }) => <MediaManager shopId={shopId} productId={item.product.id} />,
  });
  galleryImage.render = (props) => <GalleryPicture {...props} />;
}
