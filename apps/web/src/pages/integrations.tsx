import type { ops } from '@airstock/core';
import { CONNECTION_SCOPES } from '@airstock/core/permissions';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { useMutation } from '../mutation.ts';
import { ShopifyCard } from './shopify.tsx';

type Connections = Out<typeof ops.listConnections>;
type Credentials = Out<typeof ops.listApiCredentials>;
type ShopifyConnections = Out<typeof ops.listShopifyConnections>;

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
      <ErrorNotice error={connections.error} />
      {connections.isPending ? <Loading /> : null}
      {connections.data?.connections.map((c) => (
        <ShopifyCard key={c.connectionId} shopId={shopId} connection={c} />
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
          Shopify asks you to approve access to products, inventory, locations, orders,
          fulfillments, and returns. Airstock never reads customer names or addresses.
        </p>
      </Card>
    </>
  );
}
