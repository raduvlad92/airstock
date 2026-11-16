import type { ops } from '@airstock/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { api, type Out } from '../api.ts';
import { CurrencySelect, TimeZoneSelect } from '../components/pickers.tsx';
import { Card, Empty, ErrorNotice, Field, Loading, Notice, PageHeader } from '../components/ui.tsx';
import { useShops } from '../context.tsx';
import { useMutation } from '../mutation.ts';

/** The shops the user belongs to, and a form to create one. */
export function ShopsPage() {
  const shops = useShops();
  const search = useSearch({ from: '/' }) as { all?: boolean; joined?: string };
  const navigate = useNavigate();
  const only = shops.data?.shops.length === 1 ? shops.data.shops[0] : undefined;

  // One shop and nothing to show here: go straight to it.
  useEffect(() => {
    if (only && !search.all && !search.joined) {
      void navigate({ to: '/shops/$shopId/products', params: { shopId: only.id }, replace: true });
    }
  }, [only, search.all, search.joined, navigate]);

  return (
    <main className="content narrow-content">
      <PageHeader
        title="Your shops"
        subtitle="Each shop has its own catalog, stock, and members."
      />
      {search.joined ? (
        <Notice tone="ok">Invitation accepted. The shop is now in your list.</Notice>
      ) : null}
      {shops.isPending ? <Loading /> : null}
      <ErrorNotice error={shops.error} />
      {shops.data && shops.data.shops.length === 0 ? (
        <Empty>You have no shop yet. Create one to start.</Empty>
      ) : null}
      {shops.data && shops.data.shops.length > 0 ? (
        <ul className="shop-list">
          {shops.data.shops.map((s) => (
            <li key={s.id}>
              <Link to="/shops/$shopId/products" params={{ shopId: s.id }} className="shop-card">
                <strong>{s.name}</strong>
                <span className="muted">
                  {s.role.replaceAll('_', ' ')} · {s.currency} · {s.timezone}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <CreateShop />
    </main>
  );
}

function CreateShop() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin',
  );
  const create = useMutation({
    mutationFn: () =>
      api<Out<typeof ops.createShop>>('/shops', {
        method: 'POST',
        body: { name, currency, timezone },
      }),
    onSuccess: async (shop) => {
      await queryClient.invalidateQueries({ queryKey: ['shops'] });
      void navigate({ to: '/shops/$shopId/products', params: { shopId: shop.shopId } });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Card title="Create a shop">
      <form className="form-grid" onSubmit={submit}>
        <Field label="Shop name">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <Field label="Currency">
          <CurrencySelect value={currency} onChange={(e) => setCurrency(e.target.value)} required />
        </Field>
        <Field label="Time zone">
          <TimeZoneSelect value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
        </Field>
        <div className="form-actions">
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create shop'}
          </button>
        </div>
        <ErrorNotice error={create.error} />
      </form>
    </Card>
  );
}
