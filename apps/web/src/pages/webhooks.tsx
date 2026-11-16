import type { ops } from '@airstock/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
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
  titleCase,
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';

type EventTypes = Out<typeof ops.listWebhookEventTypes>;
type Subscriptions = Out<typeof ops.listWebhookSubscriptions>;
type Subscription = Subscriptions['subscriptions'][number];
type Deliveries = Out<typeof ops.listWebhookDeliveries>;
type Delivery = Deliveries['deliveries'][number];
type Locations = Out<typeof ops.listLocations>;
type Warehouses = Out<typeof ops.listWarehouses>;

/** Statuses that change on their own soon: the log refreshes while any is showing. */
const MOVING = new Set(['pending', 'sending']);

const OVERLAPS = [
  { hours: 24, label: 'Keep the old secret valid for 24 hours' },
  { hours: 1, label: 'Keep the old secret valid for 1 hour' },
  { hours: 168, label: 'Keep the old secret valid for 7 days' },
  { hours: 0, label: 'Stop the old secret now' },
];

const DELIVERY_TONE: Record<Delivery['status'], string> = {
  pending: 'muted',
  sending: 'muted',
  retrying: 'warn',
  delivered: 'ok',
  failed: 'error',
  cancelled: 'muted',
};

export function WebhooksPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const context = useShopContext(shopId);
  const queryClient = useQueryClient();
  const allowed = can(context.data, 'webhooks.manage');
  const [editing, setEditing] = useState<Subscription | 'new' | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [logFor, setLogFor] = useState('');

  const types = useQuery({
    queryKey: ['shop', shopId, 'webhook-event-types'],
    queryFn: () => api<EventTypes>(`/shops/${shopId}/webhook-event-types`),
    enabled: allowed,
    staleTime: 5 * 60_000,
  });
  const subscriptions = useQuery({
    queryKey: ['shop', shopId, 'webhooks'],
    queryFn: () => api<Subscriptions>(`/shops/${shopId}/webhook-subscriptions`),
    enabled: allowed,
  });
  const places = usePlaces(shopId, allowed);
  const deliveries = useQuery({
    queryKey: ['shop', shopId, 'webhook-deliveries', logFor],
    queryFn: () =>
      api<Deliveries>(`/shops/${shopId}/webhook-deliveries`, {
        query: { subscriptionId: logFor || undefined, limit: 50 },
      }),
    enabled: allowed,
    refetchInterval: (query) =>
      query.state.data?.deliveries.some((d) => MOVING.has(d.status)) ? 2000 : false,
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'webhooks'] });
    await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'webhook-deliveries'] });
  };

  if (context.data && !allowed) {
    return <Notice>You need the webhooks.manage permission to manage webhooks.</Notice>;
  }
  const typeList = types.data?.eventTypes ?? [];
  const list = subscriptions.data?.subscriptions ?? [];
  return (
    <>
      <Card
        title="Webhooks"
        actions={
          editing === null ? (
            <button type="button" className="small" onClick={() => setEditing('new')}>
              Add webhook
            </button>
          ) : null
        }
      >
        <p className="muted">
          Airstock sends the events you choose to your URL, such as an n8n Webhook node, right after
          each change is saved. Every request is signed; check it with the secret shown when you
          create the webhook. See{' '}
          <a href="https://github.com/raduvlad92/airstock/blob/main/docs/webhooks.md">
            the webhook guide
          </a>{' '}
          for the n8n recipe.
        </p>
        {secret ? (
          <div className="token-box">
            <strong>Copy the signing secret for “{secret.name}” now. It is shown only once.</strong>
            <code className="copyable">{secret.value}</code>
            <button type="button" className="small ghost" onClick={() => setSecret(null)}>
              Done
            </button>
          </div>
        ) : null}
        <ErrorNotice error={subscriptions.error ?? types.error} />
        {subscriptions.isPending ? <Loading /> : null}
        {subscriptions.data && list.length === 0 && editing === null ? (
          <Empty>No webhooks yet.</Empty>
        ) : null}
        {editing !== null ? (
          <SubscriptionForm
            shopId={shopId}
            subscription={editing === 'new' ? null : editing}
            types={typeList}
            alertKinds={types.data?.alertKinds ?? []}
            places={places}
            onDone={async (created) => {
              if (created) setSecret(created);
              setEditing(null);
              await refresh();
            }}
            onCancel={() => setEditing(null)}
          />
        ) : null}
      </Card>
      {list.map((s) => (
        <SubscriptionCard
          key={s.subscriptionId}
          shopId={shopId}
          subscription={s}
          types={typeList}
          places={places}
          onEdit={() => setEditing(s)}
          onSecret={(value) => setSecret({ name: s.name, value })}
          onChanged={refresh}
          onShowLog={() => setLogFor(s.subscriptionId)}
        />
      ))}
      {list.length > 0 ? (
        <DeliveryLog
          shopId={shopId}
          subscriptions={list}
          deliveries={deliveries.data?.deliveries ?? []}
          loading={deliveries.isPending}
          error={deliveries.error}
          logFor={logFor}
          setLogFor={setLogFor}
          onChanged={refresh}
        />
      ) : null}
    </>
  );
}

export interface Place {
  id: string;
  label: string;
}

/** Warehouses, then their locations, for the location filter. */
/** Active warehouses, each followed by its locations, for place pickers. */
export function usePlaces(shopId: string, enabled: boolean): Place[] {
  const warehouses = useQuery({
    queryKey: ['shop', shopId, 'warehouses'],
    queryFn: () => api<Warehouses>(`/shops/${shopId}/warehouses`),
    enabled,
  });
  const locations = useQuery({
    queryKey: ['shop', shopId, 'locations'],
    queryFn: () => api<Locations>(`/shops/${shopId}/locations`),
    enabled,
  });
  const out: Place[] = [];
  for (const w of warehouses.data?.warehouses ?? []) {
    if (w.status !== 'active') continue;
    out.push({ id: w.warehouseId, label: `${w.name} (whole warehouse)` });
    for (const l of locations.data?.locations ?? []) {
      if (l.warehouseId === w.warehouseId && l.status === 'active') {
        out.push({ id: l.locationId, label: l.path });
      }
    }
  }
  return out;
}

function SubscriptionForm({
  shopId,
  subscription,
  types,
  alertKinds,
  places,
  onDone,
  onCancel,
}: {
  shopId: string;
  subscription: Subscription | null;
  types: EventTypes['eventTypes'];
  alertKinds: string[];
  places: Place[];
  onDone: (created: { name: string; value: string } | null) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(subscription?.name ?? '');
  const [url, setUrl] = useState(subscription?.url ?? '');
  const [eventTypes, setEventTypes] = useState<string[]>(
    subscription?.eventTypes ?? ['stock.changed'],
  );
  const [locationIds, setLocationIds] = useState<string[]>(subscription?.filters.locationIds ?? []);
  const [kinds, setKinds] = useState<string[]>(subscription?.filters.alertKinds ?? []);
  const offered = types.filter(
    (t) => t.status === 'available' || subscription?.eventTypes.includes(t.type),
  );
  const chosen = types.filter((t) => eventTypes.includes(t.type));
  const usesLocations = chosen.some((t) => t.filters.includes('locations'));
  const usesAlertKinds = chosen.some((t) => t.filters.includes('alertKinds'));
  const save = useMutation({
    mutationFn: async () => {
      const filters = { locationIds, alertKinds: kinds };
      if (subscription) {
        await api(`/shops/${shopId}/webhook-subscriptions/${subscription.subscriptionId}`, {
          body: {
            expectedVersion: subscription.version,
            name,
            url,
            eventTypes,
            filters,
          },
        });
        return null;
      }
      const created = await api<Out<typeof ops.createWebhookSubscription>>(
        `/shops/${shopId}/webhook-subscriptions`,
        { body: { name, url, eventTypes, filters } },
      );
      return { name: created.subscription.name, value: created.secret };
    },
    onSuccess: (created) => onDone(created),
  });
  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="stack webhook-form" aria-label="Webhook">
      <h3>{subscription ? `Edit ${subscription.name}` : 'New webhook'}</h3>
      <Field label="Name" error={fieldErrors.name}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="What receives it, such as n8n stock flow"
          required
          maxLength={100}
        />
      </Field>
      <Field label="URL" error={fieldErrors.url}>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://n8n.example.com/webhook/… (HTTPS on a public host)"
          required
          maxLength={2000}
        />
      </Field>
      <fieldset className="checks">
        <legend>Events</legend>
        {offered.map((t) => (
          <label key={t.type} className="check event-type">
            <input
              type="checkbox"
              checked={eventTypes.includes(t.type)}
              onChange={(e) =>
                setEventTypes(
                  e.target.checked
                    ? [...eventTypes, t.type]
                    : eventTypes.filter((x) => x !== t.type),
                )
              }
            />
            <span>
              <code>{t.type}</code>
              <span className="fine">{t.description}</span>
            </span>
          </label>
        ))}
        {Object.entries(fieldErrors)
          .filter(([path]) => path.startsWith('eventTypes'))
          .map(([path, message]) => (
            <span key={path} className="field-error">
              {message}
            </span>
          ))}
      </fieldset>
      {usesLocations ? (
        <MultiSelect
          label="Locations"
          empty="Every location"
          addLabel="Limit to a warehouse or location…"
          options={places}
          value={locationIds}
          onChange={setLocationIds}
        />
      ) : null}
      {usesAlertKinds ? (
        <MultiSelect
          label="Alert kinds"
          empty="Every kind"
          addLabel="Limit to an alert kind…"
          options={alertKinds.map((k) => ({ id: k, label: titleCase(k) }))}
          value={kinds}
          onChange={setKinds}
        />
      ) : null}
      <div className="form-actions">
        <button type="submit" disabled={save.isPending || eventTypes.length === 0}>
          {subscription ? 'Save' : 'Create webhook'}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ErrorNotice error={save.error} />
    </form>
  );
}

/** A dropdown that adds values, shown as removable chips. Empty means "all". */
function MultiSelect({
  label,
  empty,
  addLabel,
  options,
  value,
  onChange,
}: {
  label: string;
  empty: string;
  addLabel: string;
  options: Place[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const byId = new Map(options.map((o) => [o.id, o.label]));
  return (
    <Field label={label}>
      <div className="chips">
        {value.length === 0 ? <span className="muted">{empty}</span> : null}
        {value.map((id) => (
          <span key={id} className="badge chip">
            {byId.get(id) ?? id}
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${byId.get(id) ?? id}`}
              onClick={() => onChange(value.filter((v) => v !== id))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <select
        value=""
        aria-label={addLabel}
        onChange={(e) => {
          if (e.target.value) onChange([...value, e.target.value]);
        }}
      >
        <option value="">{addLabel}</option>
        {options
          .filter((o) => !value.includes(o.id))
          .map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
      </select>
    </Field>
  );
}

function SubscriptionCard({
  shopId,
  subscription: s,
  types,
  places,
  onEdit,
  onSecret,
  onChanged,
  onShowLog,
}: {
  shopId: string;
  subscription: Subscription;
  types: EventTypes['eventTypes'];
  places: Place[];
  onEdit: () => void;
  onSecret: (secret: string) => void;
  onChanged: () => Promise<void>;
  onShowLog: () => void;
}) {
  const [overlap, setOverlap] = useState(24);
  const [testType, setTestType] = useState('webhook.test');
  const base = `/shops/${shopId}/webhook-subscriptions/${s.subscriptionId}`;
  const test = useMutation({
    mutationFn: () =>
      api<Out<typeof ops.testWebhookSubscription>>(`${base}/test`, {
        body: { eventType: testType },
      }),
    onSuccess: async () => {
      onShowLog();
      await onChanged();
    },
  });
  const rotate = useMutation({
    mutationFn: () =>
      api<Out<typeof ops.rotateWebhookSecret>>(`${base}/rotate-secret`, {
        body: { overlapHours: overlap },
      }),
    onSuccess: async (res) => {
      onSecret(res.secret);
      await onChanged();
    },
  });
  const status = useMutation({
    mutationFn: (next: 'active' | 'disabled') => api(`${base}/status`, { body: { status: next } }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => api(`${base}/delete`, { body: {} }),
    onSuccess: onChanged,
  });
  const placeLabel = new Map(places.map((p) => [p.id, p.label]));
  const testable = types.filter(
    (t) => t.status === 'available' && (t.type === 'webhook.test' || s.eventTypes.includes(t.type)),
  );
  return (
    <Card
      title={s.name}
      actions={
        <Badge tone={s.status === 'active' ? 'ok' : 'muted'}>
          {s.status === 'active'
            ? 'on'
            : s.disabledReason === 'failing'
              ? 'off: failing for 3 days'
              : 'off'}
        </Badge>
      }
    >
      <dl className="facts">
        <dt>URL</dt>
        <dd>
          <code>{s.url}</code>
        </dd>
        <dt>Events</dt>
        <dd className="chips">
          {s.eventTypes.map((t) => (
            <code key={t}>{t}</code>
          ))}
        </dd>
        <dt>Locations</dt>
        <dd>
          {s.filters.locationIds.length
            ? s.filters.locationIds.map((id) => placeLabel.get(id) ?? id).join(', ')
            : 'Every location'}
        </dd>
        {s.filters.alertKinds.length ? (
          <>
            <dt>Alert kinds</dt>
            <dd>{s.filters.alertKinds.map(titleCase).join(', ')}</dd>
          </>
        ) : null}
        <dt>Secret</dt>
        <dd>
          ends in <code>{s.secretHint}</code>
          {s.previousSecretExpiresAt
            ? `; the previous secret also signs until ${formatDateTime(s.previousSecretExpiresAt)}`
            : ''}
        </dd>
        <dt>Last success</dt>
        <dd>{formatDateTime(s.lastSuccessAt)}</dd>
        {s.failingSince ? (
          <>
            <dt>Failing since</dt>
            <dd>{formatDateTime(s.failingSince)}</dd>
          </>
        ) : null}
      </dl>
      {s.disabledReason === 'failing' ? (
        <p className="notice error">
          Every delivery failed for 3 days, so this webhook was turned off and the owners were
          emailed. Fix the endpoint, turn it on, and replay what it missed from the log below.
        </p>
      ) : null}
      <div className="inline-form webhook-actions">
        <Field label="Send a test">
          <select value={testType} onChange={(e) => setTestType(e.target.value)}>
            {testable.map((t) => (
              <option key={t.type} value={t.type}>
                {t.type === 'webhook.test' ? 'webhook.test' : `Sample ${t.type}`}
              </option>
            ))}
          </select>
        </Field>
        <button type="button" disabled={test.isPending} onClick={() => test.mutate()}>
          Send test
        </button>
        <button type="button" className="ghost" onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className="ghost"
          disabled={status.isPending}
          onClick={() => status.mutate(s.status === 'active' ? 'disabled' : 'active')}
        >
          {s.status === 'active' ? 'Turn off' : 'Turn on'}
        </button>
        <button
          type="button"
          className="ghost danger"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Delete the webhook “${s.name}”? Pending retries stop.`)) {
              remove.mutate();
            }
          }}
        >
          Delete
        </button>
      </div>
      <div className="inline-form webhook-actions">
        <Field label="Rotate the secret">
          <select value={overlap} onChange={(e) => setOverlap(Number(e.target.value))}>
            {OVERLAPS.map((o) => (
              <option key={o.hours} value={o.hours}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          className="ghost"
          disabled={rotate.isPending}
          onClick={() => rotate.mutate()}
        >
          Rotate secret
        </button>
      </div>
      {test.data ? (
        <Notice tone="ok">Test sent. Its delivery is at the top of the log below.</Notice>
      ) : null}
      <ErrorNotice error={test.error ?? rotate.error ?? status.error ?? remove.error} />
    </Card>
  );
}

function DeliveryLog({
  shopId,
  subscriptions,
  deliveries,
  loading,
  error,
  logFor,
  setLogFor,
  onChanged,
}: {
  shopId: string;
  subscriptions: Subscription[];
  deliveries: Delivery[];
  loading: boolean;
  error: unknown;
  logFor: string;
  setLogFor: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const replay = useMutation({
    mutationFn: (deliveryId: string) =>
      api(`/shops/${shopId}/webhook-deliveries/${deliveryId}/replay`, { body: {} }),
    onSuccess: onChanged,
  });
  return (
    <Card
      title="Delivery log"
      actions={
        <select
          value={logFor}
          aria-label="Show deliveries for"
          onChange={(e) => setLogFor(e.target.value)}
        >
          <option value="">Every webhook</option>
          {subscriptions.map((s) => (
            <option key={s.subscriptionId} value={s.subscriptionId}>
              {s.name}
            </option>
          ))}
        </select>
      }
    >
      <p className="fine">
        Kept for 30 days. A failed delivery is retried after 1 minute, 5 minutes, 30 minutes, 2
        hours, 6 hours, 12 hours, and 24 hours. A replay sends the same event ID again.
      </p>
      <ErrorNotice error={error ?? replay.error} />
      {loading ? <Loading /> : null}
      {!loading && deliveries.length === 0 ? <Empty>No deliveries yet.</Empty> : null}
      {deliveries.length > 0 ? (
        <div className="table-wrap">
          <table className="table" aria-label="Webhook deliveries">
            <thead>
              <tr>
                <th>Time</th>
                <th>Webhook</th>
                <th>Event</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Response</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.deliveryId}>
                  <td>{formatDateTime(d.createdAt)}</td>
                  <td>{d.subscriptionName}</td>
                  <td>
                    <code>{d.eventType}</code>
                    {d.test ? <Badge tone="muted">test</Badge> : null}
                    {d.replayOf ? <Badge tone="muted">replay</Badge> : null}
                  </td>
                  <td>
                    <Badge tone={DELIVERY_TONE[d.status]}>{d.status}</Badge>
                    {d.status === 'retrying' && d.nextAttemptAt ? (
                      <span className="fine"> next {formatDateTime(d.nextAttemptAt)}</span>
                    ) : null}
                  </td>
                  <td>{d.attempts}</td>
                  <td title={d.lastResponse ?? undefined}>
                    {d.lastStatusCode ?? '—'}
                    {d.lastError ? <span className="fine"> {d.lastError}</span> : null}
                  </td>
                  <td>
                    {d.status !== 'pending' && d.status !== 'sending' ? (
                      <button
                        type="button"
                        className="small ghost"
                        disabled={replay.isPending}
                        onClick={() => replay.mutate(d.deliveryId)}
                      >
                        Replay
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
