import type { ops } from '@airstock/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, command, type Out } from '../api.ts';
import { Badge, ErrorNotice, Field, formatDateTime, Loading, Notice } from '../components/ui.tsx';
import { useMutation } from '../mutation.ts';

// Sync health for one connected store (plan Section 5.14, ADR 0037): is Shopify in step, and if
// not, why. Conflicts are resolved here by choosing a side; Airstock never overwrites a quantity
// someone set in Shopify on its own.

type Health = Out<typeof ops.shopifySyncHealth>['connections'][number];
type Scan = Out<typeof ops.scanLookup>;
interface Prefill {
  shopifyVariantId: string;
  inventoryItemId: string;
  sku: string;
}

export function SyncHealth({ shopId, connectionId }: { shopId: string; connectionId: string }) {
  const health = useQuery({
    queryKey: ['shop', shopId, 'shopify', 'health', connectionId],
    queryFn: () =>
      api<Out<typeof ops.shopifySyncHealth>>(`/shops/${shopId}/shopify/sync-health`, {
        query: { connectionId },
      }),
  });
  const h = health.data?.connections[0];
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  return (
    <section className="subsection">
      <h3>Sync health</h3>
      {health.isPending ? <Loading /> : null}
      <ErrorNotice error={health.error} />
      {h ? (
        <>
          <dl className="facts">
            <dt>Last sync</dt>
            <dd>{formatDateTime(h.lastSyncAt)}</dd>
            <dt>Last push</dt>
            <dd>{formatDateTime(h.lastPushedAt)}</dd>
            <dt>Orders applied through</dt>
            <dd>{formatDateTime(h.ordersSyncedThrough)}</dd>
            <dt>Last full comparison</dt>
            <dd>{formatDateTime(h.levelsComparedAt)}</dd>
            <dt>Pending pushes</dt>
            <dd>{h.pendingPushes.count}</dd>
          </dl>
          {h.lastError ? (
            <p className="notice error">
              The last sync failed ({formatDateTime(h.lastError.at)}): {h.lastError.message}
            </p>
          ) : null}
          <Conflicts shopId={shopId} health={h} />
          <Pending health={h} />
          <Shortages health={h} />
          <Listings shopId={shopId} health={h} />
          <Unmapped health={h} onMap={setPrefill} />
          <Mappings
            key={prefill?.shopifyVariantId ?? ''}
            shopId={shopId}
            health={h}
            prefill={prefill}
          />
        </>
      ) : null}
    </section>
  );
}

function itemLabel(l: { sku: string | null; sells: string; inventoryItemId: string }) {
  const what = l.sells === 'unit' ? '' : ` (${l.sells})`;
  return `${l.sku ?? `Shopify item ${l.inventoryItemId}`}${what}`;
}

function Conflicts({ shopId, health: h }: { shopId: string; health: Health }) {
  const queryClient = useQueryClient();
  const resolve = useMutation({
    mutationFn: (input: {
      inventoryItemId: string;
      shopifyLocationId: string;
      choice: 'push_airstock' | 'take_shopify';
    }) =>
      command(`/shops/${shopId}/shopify/connections/${h.connectionId}/conflicts/resolve`, {
        connectionId: h.connectionId,
        ...input,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'shopify'] }),
  });
  if (h.conflicts.length === 0) {
    return <p className="fine">No quantity conflicts: Shopify shows what Airstock expects.</p>;
  }
  return (
    <>
      <h4>Conflicts</h4>
      <p className="fine">
        Shopify shows a quantity no order explains, so Airstock left it unchanged and stopped
        updating it. Choose which side is right: “Push Airstock’s” sets Shopify to Airstock’s
        availability; “Take Shopify’s” adjusts Airstock’s stock to Shopify’s number (a count
        correction).
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Shopify location</th>
              <th>Airstock</th>
              <th>Shopify</th>
              <th>Since</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {h.conflicts.map((c) => (
              <tr key={`${c.inventoryItemId}@${c.shopifyLocationId}`}>
                <td>{itemLabel(c)}</td>
                <td>
                  {c.shopifyLocationName ?? c.shopifyLocationId}
                  {c.scopeName ? <span className="fine"> → {c.scopeName}</span> : null}
                </td>
                <td>{c.airstock ?? '—'}</td>
                <td>{c.shopify ?? 'not stocked'}</td>
                <td>{formatDateTime(c.since)}</td>
                <td className="actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={resolve.isPending}
                    onClick={() =>
                      resolve.mutate({
                        inventoryItemId: c.inventoryItemId,
                        shopifyLocationId: c.shopifyLocationId,
                        choice: 'push_airstock',
                      })
                    }
                  >
                    Push Airstock’s
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={resolve.isPending || c.sells !== 'unit'}
                    title={
                      c.sells !== 'unit' ? 'Only for items sold one unit at a time' : undefined
                    }
                    onClick={() => {
                      if (
                        window.confirm(
                          `Adjust Airstock’s stock of ${itemLabel(c)} to Shopify’s ${c.shopify}?`,
                        )
                      ) {
                        resolve.mutate({
                          inventoryItemId: c.inventoryItemId,
                          shopifyLocationId: c.shopifyLocationId,
                          choice: 'take_shopify',
                        });
                      }
                    }}
                  >
                    Take Shopify’s
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorNotice error={resolve.error} />
      {resolve.isSuccess ? <Notice tone="ok">Resolved.</Notice> : null}
    </>
  );
}

function Pending({ health: h }: { health: Health }) {
  if (h.pendingPushes.count === 0) return null;
  return (
    <>
      <h4>Pending pushes</h4>
      <p className="fine">
        Shopify should show Airstock’s number here and does not yet. The next push or sync writes it
        (every 30 minutes at the latest).
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Shopify location</th>
              <th>Airstock</th>
              <th>Shopify (last known)</th>
            </tr>
          </thead>
          <tbody>
            {h.pendingPushes.levels.map((l) => (
              <tr key={`${l.inventoryItemId}@${l.shopifyLocationId}`}>
                <td>{itemLabel(l)}</td>
                <td>{l.shopifyLocationName ?? l.shopifyLocationId}</td>
                <td>{l.airstock}</td>
                <td>{l.shopify ?? 'not read yet'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Shortages({ health: h }: { health: Health }) {
  if (h.shortages.length === 0) return null;
  return (
    <>
      <h4>Shortages</h4>
      <p className="fine">
        Shopify orders accepted without enough stock. Receiving stock fills them, oldest first.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Order line</th>
              <th>Ordered</th>
              <th>Short</th>
              <th>Since</th>
            </tr>
          </thead>
          <tbody>
            {h.shortages.map((s) => (
              <tr key={s.reservationId}>
                <td>{s.sku}</td>
                <td>{s.externalRef}</td>
                <td>{s.quantity}</td>
                <td>
                  <Badge tone="warn">{s.shortage}</Badge>
                </td>
                <td>{formatDateTime(s.since)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Unmapped({ health: h, onMap }: { health: Health; onMap: (p: Prefill) => void }) {
  if (h.unmappedVariants.count === 0 && h.unmappedLocations.length === 0) return null;
  return (
    <>
      <h4>Not mapped</h4>
      {h.unmappedLocations.length > 0 ? (
        <p className="fine">
          Shopify locations not synced: {h.unmappedLocations.map((l) => l.name).join(', ')}.
        </p>
      ) : null}
      {h.unmappedVariants.count > 0 ? (
        <>
          <p className="fine">
            {h.unmappedVariants.count} Shopify variant(s) are not mapped, so their sales do not
            change stock here.
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Shopify variant</th>
                  <th>SKU</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {h.unmappedVariants.sample.map((v) => (
                  <tr key={v.shopifyVariantId}>
                    <td>{v.title}</td>
                    <td>{v.sku ?? '—'}</td>
                    <td className="actions">
                      <button
                        type="button"
                        className="ghost"
                        disabled={!v.inventoryItemId}
                        onClick={() =>
                          onMap({
                            shopifyVariantId: v.shopifyVariantId,
                            inventoryItemId: v.inventoryItemId ?? '',
                            sku: v.sku ?? '',
                          })
                        }
                      >
                        Map…
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );
}

function Mappings({
  shopId,
  health: h,
  prefill,
}: {
  shopId: string;
  health: Health;
  prefill: Prefill | null;
}) {
  const queryClient = useQueryClient();
  const [shopifyVariantId, setShopifyVariantId] = useState(prefill?.shopifyVariantId ?? '');
  const [inventoryItemId, setInventoryItemId] = useState(prefill?.inventoryItemId ?? '');
  const [sku, setSku] = useState(prefill?.sku ?? '');
  const [packId, setPackId] = useState('');
  const lookup = useQuery({
    queryKey: ['shop', shopId, 'scan', sku],
    queryFn: () =>
      api<Scan>(`/shops/${shopId}/scan`, { query: { code: sku.trim(), includeStock: false } }),
    enabled: sku.trim().length > 1,
  });
  const found = lookup.data?.kind === 'item' ? lookup.data.item : null;
  const save = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/shopify/connections/${h.connectionId}/variants`, {
        connectionId: h.connectionId,
        variants: [
          {
            shopifyVariantId: shopifyVariantId.trim(),
            shopifyInventoryItemId: inventoryItemId.trim(),
            variantId: found!.variantId,
            ...(packId ? { packId } : {}),
          },
        ],
      }),
    onSuccess: () => {
      setShopifyVariantId('');
      setInventoryItemId('');
      setSku('');
      setPackId('');
      return queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'shopify'] });
    },
  });
  return (
    <>
      <h4>Mappings</h4>
      <p className="fine">
        {h.mappings.variantCount} Shopify variant(s) mapped. A Shopify variant sells one unit, one
        pack (Shopify shows whole packs), or one bundle (its components are reserved).
      </p>
      {h.mappings.variants.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Shopify variant</th>
                <th>Airstock SKU</th>
                <th>Sells</th>
                <th>Mapped by</th>
              </tr>
            </thead>
            <tbody>
              {h.mappings.variants.map((v) => (
                <tr key={v.shopifyVariantId}>
                  <td>{v.title ?? v.shopifyVariantId}</td>
                  <td>{v.sku}</td>
                  <td>{v.sells}</td>
                  <td>{v.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (found) save.mutate();
        }}
      >
        <Field label="Shopify variant ID">
          <input
            value={shopifyVariantId}
            inputMode="numeric"
            placeholder="From the variant’s URL in Shopify"
            onChange={(e) => setShopifyVariantId(e.target.value)}
          />
        </Field>
        <Field label="Shopify inventory item ID">
          <input
            value={inventoryItemId}
            inputMode="numeric"
            placeholder="From the variant’s inventory in Shopify"
            onChange={(e) => setInventoryItemId(e.target.value)}
          />
        </Field>
        <Field label="Airstock SKU or barcode">
          <input
            value={sku}
            placeholder="Scan or type"
            onChange={(e) => {
              setSku(e.target.value);
              setPackId('');
            }}
          />
        </Field>
        {found ? (
          <Field label="Sells">
            <select value={packId} onChange={(e) => setPackId(e.target.value)}>
              <option value="">
                One unit of {found.sku}
                {found.variantName ? ` (${found.variantName})` : ''}
              </option>
              {found.packs.map((p) => (
                <option key={p.packId} value={p.packId}>
                  One {p.name} ({p.baseQuantity} units)
                </option>
              ))}
            </select>
          </Field>
        ) : sku.trim().length > 1 && lookup.data?.kind === 'unknown' ? (
          <p className="fine">No item with that SKU or barcode.</p>
        ) : null}
        <button
          type="submit"
          disabled={!found || !shopifyVariantId.trim() || !inventoryItemId.trim() || save.isPending}
        >
          Map
        </button>
        <ErrorNotice error={save.error} />
        {save.isSuccess ? (
          <Notice tone="ok">Mapped. Shopify is set to Airstock’s availability there.</Notice>
        ) : null}
      </form>
    </>
  );
}

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  status: 'Status',
  prices: 'Prices',
  pictures: 'Pictures',
};

function show(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  if (typeof value === 'number') return `${value} picture(s)`;
  if (Array.isArray(value)) return `${value.length} picture(s)`;
  return Object.entries(value as Record<string, string>)
    .map(([sku, price]) => `${sku} ${price}`)
    .join(', ');
}

/** Listings (D21): failed publishes, and fields changed on the side that does not own them. */
function Listings({ shopId, health: h }: { shopId: string; health: Health }) {
  const queryClient = useQueryClient();
  const resolve = useMutation({
    mutationFn: (input: {
      productId: string;
      field: string;
      choice: 'take_shopify' | 'push_airstock';
    }) =>
      command(
        `/shops/${shopId}/shopify/connections/${h.connectionId}/listing-differences/resolve`,
        {
          connectionId: h.connectionId,
          ...input,
        },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'shopify'] }),
  });
  const l = h.listings;
  if (l.count === 0) return null;
  return (
    <>
      <h4>Listings</h4>
      <p className="fine">
        {l.count} product(s) listed{l.pending ? `, ${l.pending} being published` : ''}.
      </p>
      {l.failed.length > 0 ? (
        <p className="notice error">
          Not published: {l.failed.map((f) => `${f.name} (${f.error ?? 'failed'})`).join('; ')}.
          Airstock tries again with the next sync.
        </p>
      ) : null}
      {l.differences.length > 0 ? (
        <>
          <p className="fine">
            Changed on the side that does not own the field, so not copied across. Choose which is
            right.
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Field</th>
                  <th>Airstock</th>
                  <th>Shopify</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {l.differences.map((d) => (
                  <tr key={`${d.productId}:${d.field}`}>
                    <td>{d.name}</td>
                    <td>
                      {FIELD_LABELS[d.field] ?? d.field}
                      <span className="fine">
                        {' '}
                        (changed in {d.changedBy === 'shopify' ? 'Shopify' : 'Airstock'})
                      </span>
                    </td>
                    <td>{show(d.airstock)}</td>
                    <td>{show(d.shopify)}</td>
                    <td className="actions">
                      <button
                        type="button"
                        className="ghost"
                        disabled={resolve.isPending}
                        onClick={() =>
                          resolve.mutate({
                            productId: d.productId,
                            field: d.field,
                            choice: 'push_airstock',
                          })
                        }
                      >
                        Push Airstock’s
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={resolve.isPending || d.field === 'pictures'}
                        onClick={() =>
                          resolve.mutate({
                            productId: d.productId,
                            field: d.field,
                            choice: 'take_shopify',
                          })
                        }
                      >
                        Take Shopify’s
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ErrorNotice error={resolve.error} />
        </>
      ) : null}
    </>
  );
}

/** The product page's Shopify tab: list a product created here (D21). */
export function ShopifyListingTab({
  shopId,
  item,
  canWrite,
}: {
  shopId: string;
  item: { product: { id: string; status: string } };
  canWrite: boolean;
}) {
  const stores = useQuery({
    queryKey: ['shop', shopId, 'shopify'],
    queryFn: () =>
      api<Out<typeof ops.listShopifyConnections>>(`/shops/${shopId}/shopify/connections`),
  });
  const connected = (stores.data?.connections ?? []).filter((c) => c.status === 'active');
  const [connectionId, setConnectionId] = useState('');
  const [status, setStatus] = useState<'draft' | 'active'>('draft');
  const list = useMutation({
    mutationFn: () =>
      command<Out<typeof ops.createShopifyListing>>(
        `/shops/${shopId}/products/${item.product.id}/shopify-listing`,
        {
          productId: item.product.id,
          connectionId: connectionId || connected[0]?.connectionId,
          status,
        },
      ),
  });
  if (stores.isPending) return <Loading />;
  if (connected.length === 0) {
    return <p className="fine">No Shopify store is connected (Settings → Integrations).</p>;
  }
  return (
    <section className="subsection">
      <p className="fine">
        List this product in Shopify with its variants, SKUs, barcodes, prices, description, and
        pictures. Airstock then owns those fields: changes here are pushed, and changes made in
        Shopify show under Sync health. Shopify shows Airstock’s availability.
      </p>
      {connected.length > 1 ? (
        <Field label="Store">
          <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            {connected.map((c) => (
              <option key={c.connectionId} value={c.connectionId}>
                {c.shopDomain}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field label="Listing status">
        <select value={status} onChange={(e) => setStatus(e.target.value as 'draft' | 'active')}>
          <option value="draft">Draft</option>
          <option value="active">Active (for sale)</option>
        </select>
      </Field>
      <button
        type="button"
        disabled={!canWrite || list.isPending || item.product.status === 'archived'}
        onClick={() => list.mutate()}
      >
        List on Shopify
      </button>
      <ErrorNotice error={list.error} />
      {list.data ? (
        <Notice tone="ok">
          {list.data.state === 'published'
            ? `Listing status set to ${list.data.status}.`
            : `Listing as ${list.data.status}: Shopify has it within a minute.`}
        </Notice>
      ) : null}
    </section>
  );
}
