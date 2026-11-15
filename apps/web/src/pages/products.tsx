import type { ops } from '@airstock/core';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api, command, type Out } from '../api.ts';
import {
  Badge,
  Card,
  Empty,
  ErrorNotice,
  Field,
  formatDecimal,
  Loading,
  PageHeader,
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';

type Variants = Out<typeof ops.searchVariants>;

/** The product list. The grid, detail panel, and gallery replace it in milestone N3. */
export function ProductsPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const context = useShopContext(shopId);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const variants = useInfiniteQuery({
    queryKey: ['shop', shopId, 'variants', query],
    queryFn: ({ pageParam }) =>
      api<Variants>(`/shops/${shopId}/variants`, { query: { query, after: pageParam, limit: 50 } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = variants.data?.pages.flatMap((p) => p.variants) ?? [];
  return (
    <>
      <PageHeader title="Products" subtitle="Every variant with its SKU, price, and unit." />
      <Card>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(text.trim());
          }}
        >
          <Field label="Search">
            <input
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Name or SKU"
              maxLength={200}
            />
          </Field>
          <button type="submit" className="ghost">
            Search
          </button>
        </form>
        <ErrorNotice error={variants.error} />
        {variants.isPending ? <Loading /> : null}
        {variants.data && rows.length === 0 ? <Empty>No products yet.</Empty> : null}
        {rows.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>SKU</th>
                  <th className="num">Price</th>
                  <th>Unit</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.variantId}>
                    <td>{v.productName}</td>
                    <td>
                      <code>{v.sku}</code>
                    </td>
                    <td className="num">{formatDecimal(v.price, 2)}</td>
                    <td>{v.baseUnit}</td>
                    <td>
                      <Badge tone={v.status === 'active' ? 'ok' : 'muted'}>{v.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {variants.hasNextPage ? (
          <button type="button" className="ghost" onClick={() => void variants.fetchNextPage()}>
            More
          </button>
        ) : null}
      </Card>
      {can(context.data, 'catalog.write') ? <CreateItem shopId={shopId} /> : null}
    </>
  );
}

function CreateItem({ shopId }: { shopId: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [price, setPrice] = useState('');
  const create = useMutation({
    mutationFn: () => command(`/shops/${shopId}/items`, { name, sku, ...(price ? { price } : {}) }),
    onSuccess: async () => {
      setName('');
      setSku('');
      setPrice('');
      await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'variants'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Card title="Add a product">
      <form className="inline-form" onSubmit={submit}>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={500} />
        </Field>
        <Field label="SKU">
          <input value={sku} onChange={(e) => setSku(e.target.value)} required maxLength={100} />
        </Field>
        <Field label="Price">
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
        </Field>
        <button type="submit" disabled={create.isPending}>
          Add product
        </button>
      </form>
      <ErrorNotice error={create.error} />
    </Card>
  );
}
