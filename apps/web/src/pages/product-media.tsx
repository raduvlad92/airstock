import type { ops } from '@airstock/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { api, type Out } from '../api.ts';
import { MediaManager } from '../components/media/MediaManager.tsx';
import { ErrorNotice, PageHeader } from '../components/ui.tsx';

/** A product's pictures and attachments, until the detail panel (N3) shows them. */
export function ProductMediaPage() {
  const { shopId, productId } = useParams({ from: '/shops/$shopId/products/$productId/media' });
  const item = useQuery({
    queryKey: ['shop', shopId, 'item', productId],
    queryFn: () =>
      api<Out<typeof ops.getItem>>(`/shops/${shopId}/items/detail`, { query: { productId } }),
  });
  return (
    <>
      <PageHeader
        title={item.data?.item.product.name ?? 'Product'}
        subtitle="Pictures and attachments"
        actions={
          <Link to="/shops/$shopId/products" params={{ shopId }}>
            All products
          </Link>
        }
      />
      <ErrorNotice error={item.error} />
      <MediaManager shopId={shopId} productId={productId} />
    </>
  );
}
