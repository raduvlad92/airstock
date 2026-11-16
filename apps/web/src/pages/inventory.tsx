import type { ops } from '@airstock/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { type FormEvent, Fragment, useState } from 'react';
import { api, command, type Out } from '../api.ts';
import { usePackaging } from '../components/catalog/shared.tsx';
import {
  Badge,
  Card,
  Empty,
  ErrorNotice,
  Field,
  formatDateTime,
  formatDecimal,
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
        subtitle="Stock by location, lot, and serial, with receiving, reservations, and fulfillment."
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

/**
 * Stock for one variant: totals, positions by location, condition, lot, and serial, the average
 * cost (with costs.read), the receive and reserve forms, and the open reservations with release
 * and fulfill (milestone I1; the phone flows come with I4).
 */
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
  const currency = context.data?.shop.currency ?? '';
  const extra: Array<[string, string]> = a
    ? (
        [
          ['In transit', a.totals.inTransit],
          ['Quarantine', a.totals.quarantined],
          ['Damaged', a.totals.damaged],
          ['Repair', a.totals.repair],
          ['Supplier return', a.totals.supplierReturn],
          ['Expired', a.totals.expired],
          ['Shortage', a.totals.shortage],
        ] as Array<[string, string]>
      ).filter(([, v]) => Number(v) !== 0)
    : [];
  const lots = a?.trackingMode === 'lot' || a?.trackingMode === 'lot_expiry';
  const serials = a?.trackingMode === 'serial';
  return (
    <Card title={title ?? 'Stock'}>
      <ErrorNotice error={availability.error} />
      {availability.isPending ? <Loading /> : null}
      {a ? (
        <>
          {a.partial ? <Notice>Totals cover only the locations you can access.</Notice> : null}
          <dl className="facts stats">
            <dt>On hand</dt>
            <dd>{formatDecimal(a.totals.onHand)}</dd>
            <dt>Reserved</dt>
            <dd>{formatDecimal(a.totals.reserved)}</dd>
            <dt>Available</dt>
            <dd>{formatDecimal(a.totals.available)}</dd>
            {extra.map(([label, value]) => (
              <Fragment key={label}>
                <dt>{label}</dt>
                <dd>{formatDecimal(value)}</dd>
              </Fragment>
            ))}
            {a.cost ? (
              <>
                <dt>Average cost</dt>
                <dd>
                  {a.cost.averageCost ? `${formatDecimal(a.cost.averageCost, 2)} ${currency}` : '—'}
                </dd>
                <dt>Value</dt>
                <dd>{a.cost.value ? `${formatDecimal(a.cost.value, 2)} ${currency}` : '—'}</dd>
              </>
            ) : null}
          </dl>
          {a.positions.length > 0 ? (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Location</th>
                    <th>Condition</th>
                    {lots ? <th>Lot</th> : null}
                    {serials ? <th>Serial</th> : null}
                    <th className="num">On hand</th>
                    <th className="num">Reserved</th>
                    <th className="num">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {a.positions.map((p) => (
                    <tr key={p.positionId}>
                      <td>{p.inTransit ? 'In transit' : p.locationPath}</td>
                      <td>{titleCase(p.condition)}</td>
                      {lots ? (
                        <td>
                          {p.lotCode ?? '—'}
                          {p.expiresOn ? ` · ${p.expiresOn}` : ''}{' '}
                          {p.lotExpired ? <Badge tone="error">Expired</Badge> : null}
                        </td>
                      ) : null}
                      {serials ? <td>{p.serial ?? '—'}</td> : null}
                      <td className="num">{formatDecimal(p.onHand)}</td>
                      <td className="num">{formatDecimal(p.reserved)}</td>
                      <td className="num">{formatDecimal(p.available)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No stock recorded yet.</Empty>
          )}
          <ReservationList shopId={shopId} variantId={variantId} />
        </>
      ) : null}
      {a ? (
        <div className="form-columns">
          {can(context.data, 'inventory.receive') ? (
            <ReceiveForm
              shopId={shopId}
              variantId={variantId}
              trackingMode={a.trackingMode}
              costs={can(context.data, 'costs.read')}
            />
          ) : null}
          {can(context.data, 'inventory.reserve') ? (
            <ReserveForm shopId={shopId} variantId={variantId} lots={lots} />
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function useStockRefresh(shopId: string, variantId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'availability', variantId] }),
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'reservations', variantId] }),
    ]);
}

const CONDITIONS = ['sellable', 'quarantine', 'damaged', 'repair', 'supplier_return'] as const;

function ReceiveForm({
  shopId,
  variantId,
  trackingMode,
  costs,
}: {
  shopId: string;
  variantId: string;
  trackingMode: string;
  costs: boolean;
}) {
  const locations = useLocations(shopId);
  const packaging = usePackaging(shopId, variantId);
  const leaves = (locations.data?.locations ?? []).filter(
    (l) => l.holdsStockAllowed && l.status === 'active',
  );
  const packs = (packaging.data?.packs ?? []).filter((p) => p.status === 'active');
  const [locationId, setLocationId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [packId, setPackId] = useState('');
  const [condition, setCondition] = useState('sellable');
  const [lotCode, setLotCode] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [serialText, setSerialText] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [costPer, setCostPer] = useState<'base_unit' | 'pack'>('base_unit');
  const [reference, setReference] = useState('');
  const lots = trackingMode === 'lot' || trackingMode === 'lot_expiry';
  const serial = trackingMode === 'serial';
  const serials = serialText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const refresh = useStockRefresh(shopId, variantId);
  const receive = useMutation({
    mutationFn: () =>
      command<Out<typeof ops.receiveStock>>(`/shops/${shopId}/receipts`, {
        variantId,
        locationId: locationId || leaves[0]?.locationId,
        quantity: serial ? String(serials.length) : quantity,
        condition,
        ...(packId && !serial ? { packId } : {}),
        ...(lots ? { lotCode, ...(expiresOn ? { expiresOn } : {}) } : {}),
        ...(serial ? { serials } : {}),
        ...(costs && unitCost ? { unitCost, costPer: packId ? costPer : 'base_unit' } : {}),
        ...(reference ? { reference } : {}),
      }),
    onSuccess: async () => {
      setQuantity('');
      setSerialText('');
      setReference('');
      setUnitCost('');
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
      {serial ? (
        <Field label="Serials">
          <textarea
            value={serialText}
            onChange={(e) => setSerialText(e.target.value)}
            placeholder="One serial or certificate number per line"
            rows={3}
            required
          />
        </Field>
      ) : (
        <>
          <Field label="Quantity">
            <input
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              inputMode="decimal"
              required
            />
          </Field>
          {packs.length > 0 ? (
            <Field label="Counted in">
              <select value={packId} onChange={(e) => setPackId(e.target.value)}>
                <option value="">Units</option>
                {packs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({formatDecimal(p.baseQuantity)})
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </>
      )}
      {lots ? (
        <>
          <Field label="Lot">
            <input
              value={lotCode}
              onChange={(e) => setLotCode(e.target.value)}
              placeholder="Lot or batch code"
              maxLength={100}
              required
            />
          </Field>
          <Field label="Expires">
            <input
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
              required={trackingMode === 'lot_expiry'}
            />
          </Field>
        </>
      ) : null}
      <Field label="Condition">
        <select value={condition} onChange={(e) => setCondition(e.target.value)}>
          {CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {titleCase(c)}
            </option>
          ))}
        </select>
      </Field>
      {costs ? (
        <Field label="Unit cost">
          <input
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            inputMode="decimal"
            placeholder="Optional"
          />
        </Field>
      ) : null}
      {costs && packId && !serial ? (
        <Field label="Cost per">
          <select
            value={costPer}
            onChange={(e) => setCostPer(e.target.value as 'base_unit' | 'pack')}
          >
            <option value="base_unit">Unit</option>
            <option value="pack">Pack</option>
          </select>
        </Field>
      ) : null}
      <Field label="Reference">
        <input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="Supplier or delivery reference"
          maxLength={200}
        />
      </Field>
      <button type="submit" disabled={receive.isPending || leaves.length === 0}>
        Receive
      </button>
      <ErrorNotice error={receive.error} />
      {receive.data ? (
        <Notice tone="ok">
          Received {formatDecimal(receive.data.quantity)}
          {receive.data.entered
            ? ` (${formatDecimal(receive.data.entered.quantity)} × ${receive.data.entered.packName})`
            : ''}
          .
        </Notice>
      ) : null}
    </form>
  );
}

function ReserveForm({
  shopId,
  variantId,
  lots,
}: {
  shopId: string;
  variantId: string;
  lots: boolean;
}) {
  const [quantity, setQuantity] = useState('');
  const [externalRef, setExternalRef] = useState('');
  const [lotCode, setLotCode] = useState('');
  const refresh = useStockRefresh(shopId, variantId);
  const reserve = useMutation({
    mutationFn: () =>
      command<Out<typeof ops.reserveStock>>(`/shops/${shopId}/reservations`, {
        variantId,
        quantity,
        ...(externalRef ? { externalRef } : {}),
        ...(lots && lotCode ? { lotCode } : {}),
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
      <Field label="Reference">
        <input
          value={externalRef}
          onChange={(e) => setExternalRef(e.target.value)}
          placeholder="Order number"
          maxLength={200}
        />
      </Field>
      {lots ? (
        <Field label="Lot">
          <input
            value={lotCode}
            onChange={(e) => setLotCode(e.target.value)}
            placeholder="Any lot, earliest expiry first"
            maxLength={100}
          />
        </Field>
      ) : null}
      <button type="submit" disabled={reserve.isPending}>
        Reserve
      </button>
      <ErrorNotice error={reserve.error} />
      {reserve.data ? (
        <Notice tone="ok">Reserved {formatDecimal(reserve.data.quantity)}.</Notice>
      ) : null}
    </form>
  );
}

type Reservations = Out<typeof ops.listReservations>;

/** Open reservations of the variant, each with release and fulfill (partial by quantity). */
function ReservationList({ shopId, variantId }: { shopId: string; variantId: string }) {
  const context = useShopContext(shopId);
  const list = useQuery({
    queryKey: ['shop', shopId, 'reservations', variantId],
    queryFn: () =>
      api<Reservations>(`/shops/${shopId}/reservations`, { query: { variantId, limit: 20 } }),
  });
  const rows = list.data?.reservations ?? [];
  if (list.isPending || rows.length === 0) return <ErrorNotice error={list.error} />;
  return (
    <div className="stack">
      <h3>Open reservations</h3>
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Held at</th>
              <th className="num">Reserved</th>
              <th className="num">Shortage</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <ReservationRow
                key={r.reservationId}
                shopId={shopId}
                variantId={variantId}
                reservation={r}
                canReserve={can(context.data, 'inventory.reserve')}
                canFulfill={can(context.data, 'inventory.fulfill')}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReservationRow({
  shopId,
  variantId,
  reservation: r,
  canReserve,
  canFulfill,
}: {
  shopId: string;
  variantId: string;
  reservation: Reservations['reservations'][number];
  canReserve: boolean;
  canFulfill: boolean;
}) {
  const [quantity, setQuantity] = useState('');
  const refresh = useStockRefresh(shopId, variantId);
  const act = useMutation({
    mutationFn: (action: 'release' | 'fulfill') =>
      command(`/shops/${shopId}/reservations/${r.reservationId}/${action}`, {
        ...(quantity ? { quantity } : {}),
      }),
    onSuccess: async () => {
      setQuantity('');
      await refresh();
    },
  });
  const held = r.allocations
    .filter((x) => Number(x.outstanding) > 0)
    .map(
      (x) =>
        `${x.locationPath}${x.lotCode ? ` · ${x.lotCode}` : ''}${x.serial ? ` · ${x.serial}` : ''}`,
    );
  const bundle = r.components.length > 0;
  return (
    <tr>
      <td>
        {r.externalRef ?? '—'} {bundle ? <Badge>Bundle</Badge> : null}
      </td>
      <td>{[...new Set(held)].join(', ') || '—'}</td>
      <td className="num">{formatDecimal(bundle ? r.quantity : r.outstanding)}</td>
      <td className="num">{formatDecimal(r.shortage)}</td>
      <td>{r.expiresAt ? formatDateTime(r.expiresAt) : 'Never'}</td>
      <td>
        {canReserve || canFulfill ? (
          <div className="form-actions">
            <input
              aria-label="Quantity"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              inputMode="decimal"
              placeholder="All"
              size={5}
            />
            {canFulfill ? (
              <button
                type="button"
                className="small"
                disabled={act.isPending}
                onClick={() => act.mutate('fulfill')}
              >
                Fulfill
              </button>
            ) : null}
            {canReserve ? (
              <button
                type="button"
                className="small ghost"
                disabled={act.isPending}
                onClick={() => act.mutate('release')}
              >
                Release
              </button>
            ) : null}
          </div>
        ) : null}
        <ErrorNotice error={act.error} />
      </td>
    </tr>
  );
}

/**
 * A variant's stock settings (D4, D5, D7): tracking (only while it has no stock), one of a kind,
 * the sell-by margin before lot expiry, and the default cost (with costs.read).
 */
export function StockSettingsForm({
  shopId,
  productId,
  variant,
}: {
  shopId: string;
  productId: string;
  variant: {
    id: string;
    trackingMode: string;
    oneOfAKind: boolean;
    sellByMarginDays: number;
  };
}) {
  const context = useShopContext(shopId);
  const queryClient = useQueryClient();
  const costs = can(context.data, 'costs.read');
  const [trackingMode, setTrackingMode] = useState(variant.trackingMode);
  const [oneOfAKind, setOneOfAKind] = useState(variant.oneOfAKind);
  const [margin, setMargin] = useState(String(variant.sellByMarginDays));
  const [defaultCost, setDefaultCost] = useState('');
  const save = useMutation({
    mutationFn: () =>
      command<Out<typeof ops.setStockSettings>>(
        `/shops/${shopId}/variants/${variant.id}/stock-settings`,
        {
          ...(trackingMode !== variant.trackingMode ? { trackingMode } : {}),
          ...(oneOfAKind !== variant.oneOfAKind ? { oneOfAKind } : {}),
          ...(margin !== String(variant.sellByMarginDays)
            ? { sellByMarginDays: Number(margin) }
            : {}),
          ...(costs && defaultCost ? { defaultCost } : {}),
        },
      ),
    onSuccess: async () => {
      setDefaultCost('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'item', productId] }),
        queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'availability', variant.id] }),
      ]);
    },
  });
  if (!can(context.data, 'catalog.write')) return null;
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Tracking">
        <select value={trackingMode} onChange={(e) => setTrackingMode(e.target.value)}>
          <option value="none">None</option>
          <option value="lot">Lot</option>
          <option value="lot_expiry">Lot with expiry</option>
          <option value="serial">Serial</option>
        </select>
      </Field>
      {trackingMode === 'lot_expiry' ? (
        <Field label="Sell-by margin (days)">
          <input
            value={margin}
            onChange={(e) => setMargin(e.target.value)}
            inputMode="numeric"
            pattern="[0-9]*"
          />
        </Field>
      ) : null}
      {costs ? (
        <Field label="Default cost">
          <input
            value={defaultCost}
            onChange={(e) => setDefaultCost(e.target.value)}
            inputMode="decimal"
            placeholder="Used for receipts without a cost"
          />
        </Field>
      ) : null}
      <label className="check">
        <input
          type="checkbox"
          checked={oneOfAKind}
          onChange={(e) => setOneOfAKind(e.target.checked)}
          disabled={trackingMode !== 'none'}
        />
        One of a kind
      </label>
      <button type="submit" disabled={save.isPending}>
        Save stock settings
      </button>
      <ErrorNotice error={save.error} />
    </form>
  );
}
