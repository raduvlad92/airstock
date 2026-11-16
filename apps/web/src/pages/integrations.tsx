import type { ops } from '@airstock/core';
import { CONNECTION_SCOPES } from '@airstock/core/permissions';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useParams, useSearch } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { ApiError, api, type Out } from '../api.ts';
import {
  Badge,
  Card,
  Empty,
  ErrorNotice,
  Field,
  formatDateTime,
  Loading,
  Notice,
  PageHeader,
} from '../components/ui.tsx';
import { can, useAppInfo, useShopContext } from '../context.tsx';

type Connections = Out<typeof ops.listConnections>;
type Credentials = Out<typeof ops.listApiCredentials>;
type ShopifyConnections = Out<typeof ops.listShopifyConnections>;
type Locations = Out<typeof ops.listLocations>;

export const SCOPE_LABELS: Record<(typeof CONNECTION_SCOPES)[number], string> = {
  'shop:read': 'See the shop and your role',
  'catalog:read': 'Read items and variants',
  'catalog:write': 'Create and change items',
  'storage:read': 'Read warehouses and locations',
  'storage:write': 'Change warehouses and locations',
  'inventory:read': 'Read stock and availability',
  'inventory:write': 'Receive and reserve stock',
  'activity:read': 'Read the activity history',
  'webhooks:manage': 'Manage webhooks and see their deliveries',
};

export function IntegrationsLayout() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="Sales channels, AI assistants, API access, and webhooks."
      />
      <div className="tabs">
        {(
          [
            ['/shops/$shopId/integrations/shopify', 'Shopify'],
            ['/shops/$shopId/integrations/ai', 'AI assistants'],
            ['/shops/$shopId/integrations/api', 'API credentials'],
            ['/shops/$shopId/integrations/webhooks', 'Webhooks'],
          ] as const
        ).map(([to, label]) => (
          <Link
            key={to}
            to={to}
            params={{ shopId }}
            className="tab"
            activeProps={{ className: 'tab active' }}
          >
            {label}
          </Link>
        ))}
      </div>
      <Outlet />
    </>
  );
}

// AI assistants --------------------------------------------------------------------------------

export function AiConnectionsPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const { mcpUrl } = useAppInfo();
  const context = useShopContext(shopId);
  const queryClient = useQueryClient();
  const allowed = can(context.data, 'connections.manage');
  const connections = useQuery({
    queryKey: ['shop', shopId, 'connections'],
    queryFn: () => api<Connections>(`/shops/${shopId}/connections`),
    enabled: allowed,
  });
  const revoke = useMutation({
    mutationFn: (grantId: string) =>
      api(`/shops/${shopId}/connections/${grantId}/revoke`, { method: 'POST', body: {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'connections'] }),
  });
  return (
    <Card title="AI assistants">
      <p>
        To use Airstock from ChatGPT or another MCP client, add a custom connector with the URL{' '}
        <code className="copyable">{mcpUrl}</code>. You choose the shop and the access when you
        connect, and you can revoke it here at any time.
      </p>
      {!allowed ? (
        <Notice>You need the connections.manage permission to see connections.</Notice>
      ) : null}
      {connections.isPending && allowed ? <Loading /> : null}
      <ErrorNotice error={connections.error ?? revoke.error} />
      {connections.data && connections.data.connections.length === 0 ? (
        <Empty>No connections yet.</Empty>
      ) : null}
      {connections.data && connections.data.connections.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Access</th>
                <th>Status</th>
                <th>Created</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {connections.data.connections.map((c) => (
                <tr key={c.grantId}>
                  <td>{c.clientName || c.clientId || 'Not used yet'}</td>
                  <td className="scopes">{c.scopes.join(', ')}</td>
                  <td>
                    <Badge tone={c.status === 'active' ? 'ok' : 'muted'}>{c.status}</Badge>
                    {c.replacedBy ? (
                      <div className="fine">
                        Replaced by a new consent
                        {c.revokedAt ? ` on ${formatDateTime(c.revokedAt)}` : ''}
                      </div>
                    ) : null}
                  </td>
                  <td>{formatDateTime(c.createdAt)}</td>
                  <td>{formatDateTime(c.lastUsedAt)}</td>
                  <td>
                    {c.status === 'active' ? (
                      <button
                        type="button"
                        className="small danger"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(c.grantId)}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

// API credentials ------------------------------------------------------------------------------

export function ApiCredentialsPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const context = useShopContext(shopId);
  const queryClient = useQueryClient();
  const allowed = can(context.data, 'credentials.manage');
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['shop:read', 'catalog:read']);
  const [token, setToken] = useState<string | null>(null);
  const credentials = useQuery({
    queryKey: ['shop', shopId, 'credentials'],
    queryFn: () => api<Credentials>(`/shops/${shopId}/api-credentials`),
    enabled: allowed,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'credentials'] });
  const create = useMutation({
    mutationFn: () =>
      api<Out<typeof ops.createApiCredential>>(`/shops/${shopId}/api-credentials`, {
        method: 'POST',
        body: { name, scopes },
      }),
    onSuccess: async (created) => {
      setToken(created.token);
      setName('');
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/shops/${shopId}/api-credentials/${id}/revoke`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });
  if (!allowed)
    return <Notice>You need the credentials.manage permission to manage API credentials.</Notice>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <>
      <Card title="API credentials">
        <p className="muted">
          A credential acts for you, never beyond your own permissions and locations. Send it as{' '}
          <code>Authorization: Bearer …</code> to <code>/api/v1</code>.
        </p>
        {token ? (
          <div className="token-box">
            <strong>Copy this token now. It is shown only once.</strong>
            <code className="copyable">{token}</code>
            <button type="button" className="small ghost" onClick={() => setToken(null)}>
              Done
            </button>
          </div>
        ) : null}
        <ErrorNotice error={credentials.error ?? revoke.error} />
        {credentials.isPending ? <Loading /> : null}
        {credentials.data && credentials.data.credentials.length === 0 ? (
          <Empty>No credentials yet.</Empty>
        ) : null}
        {credentials.data && credentials.data.credentials.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Access</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {credentials.data.credentials.map((c) => (
                  <tr key={c.credentialId}>
                    <td>{c.name}</td>
                    <td className="scopes">{c.scopes.join(', ')}</td>
                    <td>
                      <Badge tone={c.status === 'active' ? 'ok' : 'muted'}>{c.status}</Badge>
                    </td>
                    <td>{formatDateTime(c.createdAt)}</td>
                    <td>{formatDateTime(c.lastUsedAt)}</td>
                    <td>
                      {c.status === 'active' ? (
                        <button
                          type="button"
                          className="small danger"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(c.credentialId)}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      <Card title="Create a credential">
        <form onSubmit={submit} className="stack">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
            />
          </Field>
          <fieldset className="checks">
            <legend>Access</legend>
            {CONNECTION_SCOPES.map((scope) => (
              <label key={scope} className="check">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(e) =>
                    setScopes(
                      e.target.checked ? [...scopes, scope] : scopes.filter((s) => s !== scope),
                    )
                  }
                />
                {SCOPE_LABELS[scope]} <code>{scope}</code>
              </label>
            ))}
          </fieldset>
          <div className="form-actions">
            <button type="submit" disabled={create.isPending || scopes.length === 0}>
              Create credential
            </button>
          </div>
          <ErrorNotice error={create.error} />
        </form>
      </Card>
    </>
  );
}

// Shopify --------------------------------------------------------------------------------------

export function ShopifyPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const search = useSearch({ strict: false }) as { connected?: string };
  const context = useShopContext(shopId);
  const allowed = can(context.data, 'connections.manage');
  const [domain, setDomain] = useState('');
  const connections = useQuery({
    queryKey: ['shop', shopId, 'shopify'],
    queryFn: () => api<ShopifyConnections>(`/shops/${shopId}/shopify/connections`),
    enabled: allowed,
  });
  const locations = useQuery({
    queryKey: ['shop', shopId, 'locations'],
    queryFn: () => api<Locations>(`/shops/${shopId}/locations`),
    enabled: allowed,
  });
  if (!allowed)
    return <Notice>You need the connections.manage permission to manage Shopify.</Notice>;
  const connect = (e: FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams({ shop_id: shopId, shop: domain.trim() });
    window.location.assign(`/shopify/install?${params}`);
  };
  return (
    <>
      {search.connected ? <Notice tone="ok">Shopify store connected. Map it below.</Notice> : null}
      <ErrorNotice error={connections.error ?? locations.error} />
      {connections.isPending ? <Loading /> : null}
      {connections.data?.connections.map((c) => (
        <ShopifyCard
          key={c.connectionId}
          shopId={shopId}
          connection={c}
          locations={locations.data?.locations ?? []}
        />
      ))}
      <Card
        title={
          connections.data?.connections.length ? 'Connect another store' : 'Connect a Shopify store'
        }
      >
        <form onSubmit={connect} className="inline-form">
          <Field label="Store address">
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="my-store.myshopify.com"
              required
              maxLength={100}
            />
          </Field>
          <button type="submit">Connect store</button>
        </form>
        <p className="fine">
          Shopify asks you to approve access to products, inventory, locations, and orders. Airstock
          never reads customer details.
        </p>
      </Card>
    </>
  );
}

interface MapResult {
  variantsMapped: number;
  unmatchedShopify: string[];
  untrackedShopify: string[];
}

function ShopifyCard({
  shopId,
  connection: c,
  locations,
}: {
  shopId: string;
  connection: ShopifyConnections['connections'][number];
  locations: Locations['locations'];
}) {
  const queryClient = useQueryClient();
  const stockable = locations.filter((l) => l.holdsStockAllowed && l.status === 'active');
  const [shopifyLocationId, setShopifyLocationId] = useState(
    c.locationMap?.shopifyLocationId ?? c.shopifyLocations.find((l) => l.active)?.id ?? '',
  );
  const [locationId, setLocationId] = useState(
    c.locationMap?.locationId ?? stockable[0]?.locationId ?? '',
  );
  const map = useMutation({
    mutationFn: async (): Promise<MapResult> => {
      const res = await fetch(`/shopify/connections/${c.connectionId}/map`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-airstock-request': '1' },
        body: JSON.stringify({ shopId, locationId, shopifyLocationId }),
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
      return body as unknown as MapResult;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'shopify'] }),
  });
  const mappedLabel = c.locationMap
    ? `${c.shopifyLocations.find((l) => l.id === c.locationMap?.shopifyLocationId)?.name ?? c.locationMap.shopifyLocationId} → ${
        stockable.find((l) => l.locationId === c.locationMap?.locationId)?.path ?? 'a location'
      }`
    : 'Not mapped yet';
  return (
    <Card
      title={c.shopDomain}
      actions={<Badge tone={c.status === 'active' ? 'ok' : 'muted'}>{c.status}</Badge>}
    >
      <dl className="facts">
        <dt>Location</dt>
        <dd>{mappedLabel}</dd>
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
          Shopify unchanged; map again to take Shopify's current quantity as the starting point.
        </p>
      ) : null}
      {c.status === 'active' ? (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            map.mutate();
          }}
        >
          <Field label="Shopify location">
            <select
              value={shopifyLocationId}
              onChange={(e) => setShopifyLocationId(e.target.value)}
            >
              {c.shopifyLocations
                .filter((l) => l.active)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Airstock location">
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {stockable.map((l) => (
                <option key={l.locationId} value={l.locationId}>
                  {l.path}
                </option>
              ))}
            </select>
          </Field>
          <button type="submit" disabled={map.isPending}>
            {c.locationMap ? 'Map again by SKU' : 'Map by SKU'}
          </button>
        </form>
      ) : null}
      <p className="fine">
        Variants are matched by SKU. Airstock then sets Shopify's available quantity at that
        location to Airstock's availability and keeps it in step.
      </p>
      <ErrorNotice error={map.error} />
      {map.data ? (
        <Notice tone="ok">
          Mapped {map.data.variantsMapped} variant(s)
          {map.data.unmatchedShopify.length
            ? `; no match for ${map.data.unmatchedShopify.join(', ')}`
            : ''}
          {map.data.untrackedShopify.length
            ? `; not tracked in Shopify: ${map.data.untrackedShopify.join(', ')}`
            : ''}
          .
        </Notice>
      ) : null}
    </Card>
  );
}
