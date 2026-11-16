import type { ops } from '@airstock/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { ApiError, api, command, type Out } from '../api.ts';
import { Badge, Card, ErrorNotice, Field, formatDateTime, Notice } from '../components/ui.tsx';
import { useMutation } from '../mutation.ts';
import { SyncHealth } from './shopify-health.tsx';

// A connected Shopify store: its location maps, matching by SKU, and the onboarding import
// (plan Section 5.14). Unmapped Shopify locations are listed, never guessed.

type ShopifyConnections = Out<typeof ops.listShopifyConnections>;
type Connection = ShopifyConnections['connections'][number];
type Locations = Out<typeof ops.listLocations>;
type Warehouses = Out<typeof ops.listWarehouses>;
type Onboardings = Out<typeof ops.listShopifyOnboardings>;
type Onboarding = Out<typeof ops.getShopifyOnboarding>;
type ImportRows = Out<typeof ops.listImportRows>;

interface MatchResult {
  variantsMapped: number;
  unmatchedShopify: string[];
  untrackedShopify: string[];
}

const RUNNING = ['reading', 'matching', 'committing', 'finishing'];

export function ShopifyCard({ shopId, connection: c }: { shopId: string; connection: Connection }) {
  return (
    <Card
      title={c.shopDomain}
      actions={<Badge tone={c.status === 'active' ? 'ok' : 'muted'}>{c.status}</Badge>}
    >
      <dl className="facts">
        <dt>Variants mapped</dt>
        <dd>{c.variantsMapped}</dd>
        <dt>Webhooks</dt>
        <dd>
          {c.webhooks.length
            ? c.webhooks
                .map((w) => `${w.topic} ${w.status}${w.message ? ` (${w.message})` : ''}`)
                .join(', ')
            : 'none'}
        </dd>
        <dt>Last webhook</dt>
        <dd>{formatDateTime(c.lastWebhookAt)}</dd>
      </dl>
      {c.conflicts ? (
        <p className="notice error">
          {c.conflicts} quantity difference(s) with Shopify that no order explains. Airstock left
          Shopify unchanged; choose a side under Sync health.
        </p>
      ) : null}
      {c.status === 'active' ? (
        <>
          <SyncHealth shopId={shopId} connectionId={c.connectionId} />
          <LocationMaps shopId={shopId} connection={c} />
          <MatchBySku shopId={shopId} connection={c} />
          <OnboardingPanel shopId={shopId} connection={c} />
        </>
      ) : null}
    </Card>
  );
}

function LocationMaps({ shopId, connection: c }: { shopId: string; connection: Connection }) {
  const queryClient = useQueryClient();
  const locations = useQuery({
    queryKey: ['shop', shopId, 'locations'],
    queryFn: () => api<Locations>(`/shops/${shopId}/locations`),
  });
  const warehouses = useQuery({
    queryKey: ['shop', shopId, 'warehouses'],
    queryFn: () => api<Warehouses>(`/shops/${shopId}/warehouses`),
  });
  const initial = Object.fromEntries(
    c.locationMaps.map((m) => [
      m.shopifyLocationId,
      m.warehouseId ? `w:${m.warehouseId}` : `l:${m.locationId}`,
    ]),
  );
  const [choice, setChoice] = useState<Record<string, string>>(initial);
  const save = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/shopify/connections/${c.connectionId}/locations`, {
        connectionId: c.connectionId,
        locations: c.shopifyLocations
          .filter((l) => l.active && choice[l.id])
          .map((l) => {
            const [kind, id] = choice[l.id]!.split(':');
            return {
              shopifyLocationId: l.id,
              ...(kind === 'w' ? { warehouseId: id } : { locationId: id }),
            };
          }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'shopify'] }),
  });
  const active = (warehouses.data?.warehouses ?? []).filter((w) => w.status === 'active');
  const stock = (locations.data?.locations ?? []).filter((l) => l.status === 'active');
  return (
    <section className="subsection">
      <h3>Locations</h3>
      <p className="fine">
        Each Shopify location shows the availability of one warehouse, or one location and its
        sub-locations. Shopify orders are reserved from these, in this order. A Shopify location set
        to “Not synced” is left alone.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Shopify location</th>
              <th>Shows and sells from</th>
            </tr>
          </thead>
          <tbody>
            {c.shopifyLocations
              .filter((l) => l.active)
              .map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.name}
                    {c.unmappedLocations.some((u) => u.id === l.id) ? (
                      <>
                        {' '}
                        <Badge tone="warn">not mapped</Badge>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <select
                      aria-label={`Airstock stock for ${l.name}`}
                      value={choice[l.id] ?? ''}
                      onChange={(e) => setChoice({ ...choice, [l.id]: e.target.value })}
                    >
                      <option value="">Not synced</option>
                      <optgroup label="Warehouses">
                        {active.map((w) => (
                          <option key={w.warehouseId} value={`w:${w.warehouseId}`}>
                            {w.name} (whole warehouse)
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Locations">
                        {stock.map((s) => (
                          <option key={s.locationId} value={`l:${s.locationId}`}>
                            {s.path}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
        Save location maps
      </button>
      <ErrorNotice error={save.error ?? locations.error ?? warehouses.error} />
      {save.isSuccess ? (
        <Notice tone="ok">Saved. Shopify is set to Airstock’s availability there.</Notice>
      ) : null}
    </section>
  );
}

function MatchBySku({ shopId, connection: c }: { shopId: string; connection: Connection }) {
  const queryClient = useQueryClient();
  const match = useMutation({
    mutationFn: async (): Promise<MatchResult> => {
      const res = await fetch(`/shopify/connections/${c.connectionId}/map`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-airstock-request': '1' },
        body: JSON.stringify({ shopId }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        throw new ApiError(
          res.status,
          String(body.code ?? 'http_error'),
          String(body.title ?? 'Failed'),
          body,
        );
      }
      return body as unknown as MatchResult;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'shopify'] }),
  });
  return (
    <section className="subsection">
      <h3>Variants</h3>
      <p className="fine">
        Match the store’s variants to yours by SKU. Packs and bundles are mapped under Sync health
        (Mappings); the onboarding import below also matches by barcode.
      </p>
      <button
        type="button"
        className="ghost"
        disabled={match.isPending || c.locationMaps.length === 0}
        onClick={() => match.mutate()}
      >
        Match by SKU
      </button>
      <ErrorNotice error={match.error} />
      {match.data ? (
        <Notice tone="ok">
          Mapped {match.data.variantsMapped} variant(s)
          {match.data.unmatchedShopify.length
            ? `; no match for ${match.data.unmatchedShopify.slice(0, 20).join(', ')}`
            : ''}
          {match.data.untrackedShopify.length
            ? `; not tracked in Shopify: ${match.data.untrackedShopify.slice(0, 20).join(', ')}`
            : ''}
          .
        </Notice>
      ) : null}
    </section>
  );
}

function OnboardingPanel({ shopId, connection: c }: { shopId: string; connection: Connection }) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['shop', shopId, 'shopify', 'onboardings', c.connectionId],
    queryFn: () =>
      api<Onboardings>(`/shops/${shopId}/shopify/onboardings`, {
        query: { connectionId: c.connectionId },
      }),
    refetchInterval: (q) =>
      q.state.data?.onboardings.some((o) => RUNNING.includes(o.status)) ? 3000 : false,
  });
  const latest = list.data?.onboardings[0];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'shopify'] });
  const start = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/shopify/connections/${c.connectionId}/onboardings`, {
        connectionId: c.connectionId,
      }),
    onSuccess: refresh,
  });
  return (
    <section className="subsection">
      <h3>Import the store’s catalog</h3>
      <p className="fine">
        Reads products, variants, SKUs, barcodes, prices, pictures, and quantities from Shopify.
        Variants are matched by SKU, then barcode; you review the new ones before anything is
        written. Quantities at mapped locations arrive as opening stock; pictures stay on Shopify
        and are shown from there.
      </p>
      {!latest || !RUNNING.includes(latest.status) || latest.status === 'previewed' ? (
        latest?.status === 'previewed' ? null : (
          <button
            type="button"
            disabled={start.isPending || c.locationMaps.length === 0}
            onClick={() => start.mutate()}
          >
            Read the catalog from Shopify
          </button>
        )
      ) : null}
      {c.locationMaps.length === 0 ? <Notice>Map at least one location first.</Notice> : null}
      <ErrorNotice error={start.error ?? list.error} />
      {latest ? <OnboardingView shopId={shopId} onboardingId={latest.onboardingId} /> : null}
    </section>
  );
}

const MATCH_LABELS = {
  sku: 'Matched by SKU',
  barcode: 'Matched by barcode',
  new: 'New',
  skipped: 'Skipped',
} as const;

function OnboardingView({ shopId, onboardingId }: { shopId: string; onboardingId: string }) {
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: ['shop', shopId, 'shopify', 'onboarding', onboardingId],
    queryFn: () => api<Onboarding>(`/shops/${shopId}/shopify/onboardings/${onboardingId}`),
    refetchInterval: (q) =>
      q.state.data && RUNNING.includes(q.state.data.onboarding.status) ? 3000 : false,
  });
  const o = view.data?.onboarding;
  const problems = useQuery({
    queryKey: ['shop', shopId, 'import', o?.importId, 'problems'],
    queryFn: () =>
      api<ImportRows>(`/shops/${shopId}/imports/${o!.importId}/rows`, {
        query: { only: 'problems', limit: 50 },
      }),
    enabled: Boolean(o?.importId && o.status === 'previewed'),
  });
  const done = () => queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'shopify'] });
  const commit = useMutation({
    mutationFn: () => command(`/shops/${shopId}/shopify/onboardings/${onboardingId}/commit`, {}),
    onSuccess: done,
  });
  const cancel = useMutation({
    mutationFn: () => command(`/shops/${shopId}/shopify/onboardings/${onboardingId}/cancel`, {}),
    onSuccess: done,
  });
  if (!o) return <ErrorNotice error={view.error} />;
  const counts = o.counts;
  return (
    <div className="onboarding">
      <p>
        <Badge tone={o.status === 'failed' ? 'error' : o.status === 'completed' ? 'ok' : 'info'}>
          {o.status}
        </Badge>{' '}
        started {formatDateTime(o.createdAt)}
        {o.error ? ` — ${o.error}` : ''}
      </p>
      {['sku', 'barcode', 'new', 'skipped'].some((k) => counts[k] !== undefined) ? (
        <dl className="facts">
          {(['sku', 'barcode', 'new', 'skipped'] as const).map((k) => (
            <Fragment key={k}>
              <dt>{MATCH_LABELS[k]}</dt>
              <dd>{counts[k] ?? 0}</dd>
            </Fragment>
          ))}
          {counts.mapped !== undefined ? (
            <>
              <dt>Mapped</dt>
              <dd>{counts.mapped}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {o.unmappedLocations.length ? (
        <Notice>
          Quantities at {o.unmappedLocations.map((l) => l.name).join(', ')} are not imported: map
          those Shopify locations first, or receive the stock later.
        </Notice>
      ) : null}
      {problems.data?.rows.length ? (
        <Notice>
          {problems.data.rows.length} new row(s) have problems and will be skipped:{' '}
          {problems.data.rows
            .slice(0, 5)
            .map((r) => `row ${r.rowNumber}: ${[...r.errors, ...r.warnings].join('; ')}`)
            .join(' · ')}
        </Notice>
      ) : null}
      {view.data?.rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Shopify variant</th>
                <th>SKU</th>
                <th>Barcode</th>
                <th>Result</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {view.data.rows.slice(0, 200).map((r) => (
                <tr key={r.shopifyVariantId}>
                  <td>{r.title}</td>
                  <td>{r.importSku ?? r.sku ?? '—'}</td>
                  <td>{r.barcode ?? '—'}</td>
                  <td>
                    <Badge
                      tone={r.match === 'skipped' ? 'warn' : r.match === 'new' ? 'info' : 'ok'}
                    >
                      {MATCH_LABELS[r.match]}
                    </Badge>
                    {r.packId ? ' (a pack)' : ''}
                  </td>
                  <td className="fine">{r.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {o.status === 'previewed' ? (
        <div className="shopify-actions">
          <button type="button" disabled={commit.isPending} onClick={() => commit.mutate()}>
            Import and map
          </button>
          <button
            type="button"
            className="ghost"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Cancel
          </button>
        </div>
      ) : null}
      <ErrorNotice error={commit.error ?? cancel.error} />
    </div>
  );
}
