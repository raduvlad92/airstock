import type { ops } from '@airstock/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api, command, type Out } from '../api.ts';
import {
  Card,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Notice,
  PageHeader,
  titleCase,
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';
import { useLocations } from './warehouses.tsx';

type Availability = Out<typeof ops.getAvailability>;
type Variants = Out<typeof ops.searchVariants>;

export function InventoryPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const [sku, setSku] = useState('');
  const [query, setQuery] = useState('');
  const found = useQuery({
    queryKey: ['shop', shopId, 'variant-by-sku', query],
    queryFn: () => api<Variants>(`/shops/${shopId}/variants`, { query: { sku: query, limit: 1 } }),
    enabled: query !== '',
  });
  const variant = found.data?.variants[0];
  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="Stock by location, and the receive, reserve, and release forms."
      />
      <Card>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(sku.trim());
          }}
        >
          <Field label="SKU">
            <input value={sku} onChange={(e) => setSku(e.target.value)} required maxLength={100} />
          </Field>
          <button type="submit">Show stock</button>
        </form>
        {found.isFetching ? <Loading /> : null}
        <ErrorNotice error={found.error} />
        {found.data && !variant ? <Empty>No variant with that SKU.</Empty> : null}
      </Card>
      {variant ? (
        <StockPanel
          shopId={shopId}
          variantId={variant.variantId}
          title={`${variant.productName} · ${variant.sku}`}
        />
      ) : null}
    </>
  );
}

/** Stock by location for one variant, with the stock forms (moved here from Phase 0, M4). */
export function StockPanel({
  shopId,
  variantId,
  title,
}: {
  shopId: string;
  variantId: string;
  title?: string;
}) {
  const context = useShopContext(shopId);
  const availability = useQuery({
    queryKey: ['shop', shopId, 'availability', variantId],
    queryFn: () => api<Availability>(`/shops/${shopId}/availability`, { query: { variantId } }),
  });
  const a = availability.data;
  return (
    <Card title={title ?? 'Stock'}>
      <ErrorNotice error={availability.error} />
      {availability.isPending ? <Loading /> : null}
      {a ? (
        <>
          {a.partial ? <Notice>Totals cover only the locations you can access.</Notice> : null}
          <dl className="facts stats">
            <dt>On hand</dt>
            <dd>{a.totals.onHand}</dd>
            <dt>Reserved</dt>
            <dd>{a.totals.reserved}</dd>
            <dt>Available</dt>
            <dd>{a.totals.available}</dd>
            <dt>Quarantine</dt>
            <dd>{a.totals.quarantined}</dd>
            <dt>Damaged</dt>
            <dd>{a.totals.damaged}</dd>
          </dl>
          {a.positions.length > 0 ? (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Location</th>
                    <th>Condition</th>
                    <th className="num">On hand</th>
                    <th className="num">Reserved</th>
                    <th className="num">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {a.positions.map((p) => (
                    <tr key={p.positionId}>
                      <td>{p.locationPath}</td>
                      <td>{titleCase(p.condition)}</td>
                      <td className="num">{p.onHand}</td>
                      <td className="num">{p.reserved}</td>
                      <td className="num">{p.available}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No stock recorded yet.</Empty>
          )}
        </>
      ) : null}
      <div className="form-columns">
        {can(context.data, 'inventory.receive') ? (
          <ReceiveForm shopId={shopId} variantId={variantId} />
        ) : null}
        {can(context.data, 'inventory.reserve') ? (
          <ReserveForm shopId={shopId} variantId={variantId} />
        ) : null}
        {can(context.data, 'inventory.reserve') ? (
          <ReleaseForm shopId={shopId} variantId={variantId} />
        ) : null}
      </div>
    </Card>
  );
}

function useStockRefresh(shopId: string, variantId: string) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'availability', variantId] });
}

function ReceiveForm({ shopId, variantId }: { shopId: string; variantId: string }) {
  const locations = useLocations(shopId);
  const leaves = (locations.data?.locations ?? []).filter(
    (l) => l.holdsStockAllowed && l.status === 'active',
  );
  const [locationId, setLocationId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [condition, setCondition] = useState('sellable');
  const [reference, setReference] = useState('');
  const refresh = useStockRefresh(shopId, variantId);
  const receive = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/receipts`, {
        variantId,
        locationId: locationId || leaves[0]?.locationId,
        quantity,
        condition,
        ...(reference ? { reference } : {}),
      }),
    onSuccess: async () => {
      setQuantity('');
      setReference('');
      await refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    receive.mutate();
  };
  return (
    <form className="stack mini-form" onSubmit={submit}>
      <h3>Receive</h3>
      <Field label="Location">
        <select
          value={locationId || leaves[0]?.locationId || ''}
          onChange={(e) => setLocationId(e.target.value)}
        >
          {leaves.map((l) => (
            <option key={l.locationId} value={l.locationId}>
              {l.path}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Quantity">
        <input
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          inputMode="decimal"
          required
        />
      </Field>
      <Field label="Condition">
        <select value={condition} onChange={(e) => setCondition(e.target.value)}>
          <option value="sellable">Sellable</option>
          <option value="quarantine">Quarantine</option>
          <option value="damaged">Damaged</option>
        </select>
      </Field>
      <Field label="Reference" hint="Optional supplier or inbound reference.">
        <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} />
      </Field>
      <button type="submit" disabled={receive.isPending || leaves.length === 0}>
        Receive
      </button>
      <ErrorNotice error={receive.error} />
      {receive.isSuccess ? <Notice tone="ok">Received.</Notice> : null}
    </form>
  );
}

function ReserveForm({ shopId, variantId }: { shopId: string; variantId: string }) {
  const [quantity, setQuantity] = useState('');
  const [externalRef, setExternalRef] = useState('');
  const refresh = useStockRefresh(shopId, variantId);
  const reserve = useMutation({
    mutationFn: () =>
      command<Out<typeof ops.reserveStock>>(`/shops/${shopId}/reservations`, {
        variantId,
        quantity,
        ...(externalRef ? { externalRef } : {}),
      }),
    onSuccess: async () => {
      setQuantity('');
      await refresh();
    },
  });
  return (
    <form
      className="stack mini-form"
      onSubmit={(e) => {
        e.preventDefault();
        reserve.mutate();
      }}
    >
      <h3>Reserve</h3>
      <Field label="Quantity">
        <input
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          inputMode="decimal"
          required
        />
      </Field>
      <Field label="Reference" hint="Optional, such as an order number.">
        <input
          value={externalRef}
          onChange={(e) => setExternalRef(e.target.value)}
          maxLength={200}
        />
      </Field>
      <button type="submit" disabled={reserve.isPending}>
        Reserve
      </button>
      <ErrorNotice error={reserve.error} />
      {reserve.data ? (
        <Notice tone="ok">
          Reserved {reserve.data.quantity}. Reservation <code>{reserve.data.reservationId}</code>
        </Notice>
      ) : null}
    </form>
  );
}

function ReleaseForm({ shopId, variantId }: { shopId: string; variantId: string }) {
  const [reservationId, setReservationId] = useState('');
  const [quantity, setQuantity] = useState('');
  const refresh = useStockRefresh(shopId, variantId);
  const release = useMutation({
    mutationFn: () =>
      command<Out<typeof ops.releaseReservation>>(
        `/shops/${shopId}/reservations/${reservationId.trim()}/release`,
        {
          ...(quantity ? { quantity } : {}),
        },
      ),
    onSuccess: async () => {
      setQuantity('');
      await refresh();
    },
  });
  return (
    <form
      className="stack mini-form"
      onSubmit={(e) => {
        e.preventDefault();
        release.mutate();
      }}
    >
      <h3>Release</h3>
      <Field label="Reservation ID">
        <input
          value={reservationId}
          onChange={(e) => setReservationId(e.target.value)}
          required
          maxLength={36}
        />
      </Field>
      <Field label="Quantity" hint="Leave empty to release everything still reserved.">
        <input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" />
      </Field>
      <button type="submit" disabled={release.isPending}>
        Release
      </button>
      <ErrorNotice error={release.error} />
      {release.data ? (
        <Notice tone="ok">
          Released {release.data.released}; the reservation is {release.data.status}.
        </Notice>
      ) : null}
    </form>
  );
}
