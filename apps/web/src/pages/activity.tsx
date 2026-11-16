import type { ops } from '@airstock/core';
import {
  ACTION_GROUPS,
  ACTOR_TYPE_LABELS,
  ACTOR_TYPES,
  OUTCOME_LABELS,
  OUTCOMES,
  SOURCE_LABELS,
  SOURCES,
} from '@airstock/core/activity';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { api, type Out } from '../api.ts';
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
import { can, useShopContext } from '../context.tsx';
import { ExportButton } from './imports.tsx';
import { usePlaces } from './webhooks.tsx';

type Activity = Out<typeof ops.listActivity>;
export type ActivityEvent = Activity['events'][number];
type Lifecycle = NonNullable<Activity['lifecycle']>;
type Ingestion = NonNullable<Activity['ingestion']>;

/** The API's activity filters (PRD 7.4), as query parameters. */
export type ActivityFilters = Partial<
  Record<
    | 'actorType'
    | 'actorId'
    | 'integration'
    | 'source'
    | 'action'
    | 'outcome'
    | 'locationId'
    | 'from'
    | 'to'
    | 'targetType'
    | 'targetId'
    | 'attemptId',
    string
  >
>;

/** The activity history, newest first, with filters; the first page says whether it is behind. */
export function useActivity(shopId: string, filters: ActivityFilters = {}) {
  return useInfiniteQuery({
    queryKey: ['shop', shopId, 'activity', filters],
    queryFn: ({ pageParam }) =>
      api<Activity>(`/shops/${shopId}/activity`, {
        query: { ...filters, before: pageParam, limit: 50 },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // History grows all the time: going back to earlier filters shows what is new since.
    staleTime: 0,
  });
}

// The page's filters live in the address, so a filtered view can be shared or opened from a
// record's history ("Follow this request").

/** Search parameters of the Activity page. Dates are days (yyyy-mm-dd) in the browser's zone. */
export interface ActivitySearch {
  who?: string;
  source?: string;
  action?: string;
  outcome?: string;
  place?: string;
  from?: string;
  to?: string;
  targetType?: string;
  targetId?: string;
  attempt?: string;
}

const SEARCH_KEYS = [
  'who',
  'source',
  'action',
  'outcome',
  'place',
  'from',
  'to',
  'targetType',
  'targetId',
  'attempt',
] as const satisfies ReadonlyArray<keyof ActivitySearch>;

export function parseActivitySearch(search: Record<string, unknown>): ActivitySearch {
  const out: ActivitySearch = {};
  for (const key of SEARCH_KEYS) {
    const value = search[key];
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim().slice(0, 300);
  }
  return out;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Midnight at the start of a day in the browser's time zone, as an instant. */
function startOfDay(day: string): string | undefined {
  if (!DAY.test(day)) return undefined;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toISOString();
}

function nextDay(day: string): string | undefined {
  if (!DAY.test(day)) return undefined;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d + 1).toISOString();
}

/** The page's search as the API's filters. */
function toFilters(s: ActivitySearch): ActivityFilters {
  const f: ActivityFilters = {};
  if (s.who) {
    const [kind, id] = [s.who.slice(0, s.who.indexOf(':')), s.who.slice(s.who.indexOf(':') + 1)];
    if (kind === 'user') f.actorId = id;
    else if (kind === 'integration') f.integration = id;
    else if (kind === 'type') f.actorType = id;
  }
  if (s.source) f.source = s.source;
  if (s.action) f.action = s.action;
  if (s.outcome) f.outcome = s.outcome;
  if (s.place) f.locationId = s.place;
  if (s.from) f.from = startOfDay(s.from);
  // "To" includes the day chosen.
  if (s.to) f.to = nextDay(s.to);
  if (s.targetType) f.targetType = s.targetType;
  if (s.targetId) f.targetId = s.targetId;
  if (s.attempt) f.attemptId = s.attempt;
  return f;
}

const OUTCOME_TONE: Record<string, string> = {
  succeeded: 'ok',
  received: 'muted',
  failed: 'error',
  denied: 'error',
  conflict: 'warn',
  unknown: 'warn',
};

const short = (id: string) => `…${id.slice(-6)}`;

/**
 * Events in a table. The target and the request link to the Activity page filtered on them, so
 * a record's history panel leads to the full timeline.
 */
export function ActivityTable({ shopId, events }: { shopId: string; events: ActivityEvent[] }) {
  return (
    <div className="table-wrap">
      <table className="table" aria-label="Activity">
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Outcome</th>
            <th>By</th>
            <th>Record</th>
            <th>Request</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.eventId}>
              <td className="nowrap">{formatDateTime(e.occurredAt)}</td>
              <td>
                <code>{e.action}</code>
                {e.phase === 'attempt' ? <span className="muted"> (attempt)</span> : null}
              </td>
              <td>
                <Badge tone={OUTCOME_TONE[e.outcome]}>{e.outcome}</Badge>
              </td>
              <td>
                {e.source}
                <span className="muted"> · {e.actorType}</span>
                {e.clientId ? <span className="muted"> · {e.clientId}</span> : null}
              </td>
              <td className="muted">
                {e.targetType && e.targetId ? (
                  <Link
                    to="/shops/$shopId/activity"
                    params={{ shopId }}
                    search={{ targetType: e.targetType, targetId: e.targetId }}
                    title={`History of this ${e.targetType}`}
                  >
                    {e.targetType} {UUID.test(e.targetId) ? short(e.targetId) : e.targetId}
                  </Link>
                ) : (
                  (e.targetType ?? '—')
                )}
              </td>
              <td>
                {e.attemptId ? (
                  <Link
                    to="/shops/$shopId/activity"
                    params={{ shopId }}
                    search={{ attempt: e.attemptId }}
                    title="Follow this request from attempt to outcome"
                  >
                    {short(e.attemptId)}
                  </Link>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Members = Out<typeof ops.listMembers>;
type Connections = Out<typeof ops.listConnections>;
type Credentials = Out<typeof ops.listApiCredentials>;

/** People and integrations for the "Who" filter; lists the reader may not see are left out. */
function useActors(shopId: string, canManageKeys: boolean) {
  const members = useQuery({
    queryKey: ['shop', shopId, 'members'],
    queryFn: () => api<Members>(`/shops/${shopId}/members`),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const connections = useQuery({
    queryKey: ['shop', shopId, 'connections'],
    queryFn: () => api<Connections>(`/shops/${shopId}/connections`),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const credentials = useQuery({
    queryKey: ['shop', shopId, 'api-credentials'],
    queryFn: () => api<Credentials>(`/shops/${shopId}/api-credentials`),
    staleTime: 5 * 60_000,
    enabled: canManageKeys,
    retry: false,
  });
  return {
    people: (members.data?.members ?? []).map((m) => ({
      value: `user:${m.userId}`,
      label: m.displayName ? `${m.displayName} (${m.email})` : m.email,
    })),
    integrations: [
      ...(connections.data?.connections ?? []).map((c) => ({
        value: `integration:${c.grantId}`,
        label: `AI connection: ${c.clientName ?? c.clientId ?? 'not used yet'}`,
      })),
      ...(credentials.data?.credentials ?? []).map((c) => ({
        value: `integration:${c.credentialId}`,
        label: `API key: ${c.name}`,
      })),
    ],
  };
}

export function ActivityPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const search = useSearch({ from: '/shops/$shopId/activity' });
  const navigate = useNavigate({ from: '/shops/$shopId/activity' });
  const context = useShopContext(shopId);
  const filters = toFilters(search);
  const activity = useActivity(shopId, filters);
  const events = activity.data?.pages.flatMap((p) => p.events) ?? [];
  const first = activity.data?.pages[0];
  const set = (patch: Partial<ActivitySearch>) =>
    void navigate({ search: (prev) => parseActivitySearch({ ...prev, ...patch }) });
  const filtered = Object.keys(search).length > 0;
  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="Every change, read, and refusal, with who did it and from where."
      />
      {first?.ingestion?.delayed ? <DelayNotice ingestion={first.ingestion} /> : null}
      <Card
        title="Filters"
        actions={
          <span className="form-actions">
            {filtered ? (
              <button
                type="button"
                className="ghost small"
                onClick={() => void navigate({ search: {} })}
              >
                Clear filters
              </button>
            ) : null}
            {can(context.data, 'exports.run') ? (
              <ExportButton
                key={JSON.stringify(filters)}
                shopId={shopId}
                endpoint={`/shops/${shopId}/activity/exports`}
                query={filters}
              />
            ) : null}
          </span>
        }
      >
        <FilterForm
          shopId={shopId}
          search={search}
          set={set}
          canManageKeys={can(context.data, 'credentials.manage')}
        />
        {search.targetType || search.attempt ? (
          <div className="chips">
            {search.targetType ? (
              <span className="badge chip">
                History of {search.targetType}{' '}
                {search.targetId && UUID.test(search.targetId)
                  ? short(search.targetId)
                  : search.targetId}
                <button
                  type="button"
                  className="chip-remove"
                  aria-label="Show every record"
                  onClick={() => set({ targetType: undefined, targetId: undefined })}
                >
                  ×
                </button>
              </span>
            ) : null}
            {search.attempt ? (
              <span className="badge chip">
                One request {short(search.attempt)}
                <button
                  type="button"
                  className="chip-remove"
                  aria-label="Show every request"
                  onClick={() => set({ attempt: undefined })}
                >
                  ×
                </button>
              </span>
            ) : null}
          </div>
        ) : null}
      </Card>
      {first?.lifecycle ? <LifecycleCard lifecycle={first.lifecycle} /> : null}
      <Card>
        <ErrorNotice error={activity.error} />
        {activity.isPending ? <Loading /> : null}
        {activity.data && events.length === 0 ? (
          <Empty>{filtered ? 'Nothing matches these filters.' : 'No activity yet.'}</Empty>
        ) : null}
        {events.length > 0 ? <ActivityTable shopId={shopId} events={events} /> : null}
        {activity.hasNextPage ? (
          <button
            type="button"
            className="ghost"
            disabled={activity.isFetchingNextPage}
            onClick={() => void activity.fetchNextPage()}
          >
            {activity.isFetchingNextPage ? 'Loading…' : 'Older events'}
          </button>
        ) : null}
      </Card>
    </>
  );
}

function FilterForm({
  shopId,
  search,
  set,
  canManageKeys,
}: {
  shopId: string;
  search: ActivitySearch;
  set: (patch: Partial<ActivitySearch>) => void;
  canManageKeys: boolean;
}) {
  const actors = useActors(shopId, canManageKeys);
  const places = usePlaces(shopId, true);
  const knownAction = ACTION_GROUPS.some((g) => g.value === search.action);
  return (
    <div className="form-grid">
      <Field label="Who">
        <select value={search.who ?? ''} onChange={(e) => set({ who: e.target.value })}>
          <option value="">Anyone</option>
          {actors.people.length > 0 ? (
            <optgroup label="People">
              {actors.people.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          {actors.integrations.length > 0 ? (
            <optgroup label="Integrations">
              {actors.integrations.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          <optgroup label="Any of a kind">
            {ACTOR_TYPES.map((t) => (
              <option key={t} value={`type:${t}`}>
                {ACTOR_TYPE_LABELS[t]}
              </option>
            ))}
          </optgroup>
        </select>
      </Field>
      <Field label="Source">
        <select value={search.source ?? ''} onChange={(e) => set({ source: e.target.value })}>
          <option value="">Any source</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Action">
        <select value={search.action ?? ''} onChange={(e) => set({ action: e.target.value })}>
          <option value="">Any action</option>
          {ACTION_GROUPS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
          {search.action && !knownAction ? (
            <option value={search.action}>{search.action}</option>
          ) : null}
        </select>
      </Field>
      <Field label="Outcome">
        <select value={search.outcome ?? ''} onChange={(e) => set({ outcome: e.target.value })}>
          <option value="">Any outcome</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {OUTCOME_LABELS[o]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Warehouse or location">
        <select value={search.place ?? ''} onChange={(e) => set({ place: e.target.value })}>
          <option value="">Anywhere</option>
          {places.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="From">
        <input
          type="date"
          value={search.from ?? ''}
          max={search.to}
          onChange={(e) => set({ from: e.target.value })}
        />
      </Field>
      <Field label="To">
        <input
          type="date"
          value={search.to ?? ''}
          min={search.from}
          onChange={(e) => set({ to: e.target.value })}
        />
      </Field>
    </div>
  );
}

/** One request from attempt to outcome (PRD 7.4). */
function LifecycleCard({ lifecycle }: { lifecycle: Lifecycle }) {
  return (
    <Card title="Request">
      <dl className="facts">
        <dt>Action</dt>
        <dd>
          <code>{lifecycle.action ?? '—'}</code>
        </dd>
        <dt>Outcome</dt>
        <dd>
          <Badge tone={OUTCOME_TONE[lifecycle.status] ?? 'muted'}>{lifecycle.status}</Badge>
          {lifecycle.status === 'pending' ? (
            <span className="muted"> The attempt is recorded; its outcome is not yet.</span>
          ) : null}
        </dd>
        <dt>Received</dt>
        <dd>{formatDateTime(lifecycle.startedAt)}</dd>
        <dt>Outcome recorded</dt>
        <dd>
          {formatDateTime(lifecycle.finishedAt)}
          {lifecycle.durationMs !== null ? (
            <span className="muted"> · took {formatDuration(lifecycle.durationMs)}</span>
          ) : null}
        </dd>
        {lifecycle.lastEventAt && lifecycle.lastEventAt !== lifecycle.finishedAt ? (
          <>
            <dt>Last event</dt>
            <dd>{formatDateTime(lifecycle.lastEventAt)}</dd>
          </>
        ) : null}
        <dt>Events</dt>
        <dd>
          {lifecycle.events}
          {lifecycle.problems > 0 ? (
            <span className="muted"> · {lifecycle.problems} failed, denied, or conflicting</span>
          ) : null}
        </dd>
      </dl>
    </Card>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** Reads, attempts, and failures reach the history through a queue (PRD 7.3). */
function DelayNotice({ ingestion }: { ingestion: Ingestion }) {
  const waiting = ingestion.pendingRequests;
  return (
    <Notice>
      The history is catching up: the newest events may take a little longer to appear.
      {waiting > 0
        ? ` ${waiting} recent ${waiting === 1 ? 'command is' : 'commands are'} still on the way${
            ingestion.oldestPendingSeconds !== null
              ? `, the oldest for ${ingestion.oldestPendingSeconds} s`
              : ''
          }.`
        : ''}
      {ingestion.lastBatchLagSeconds !== null && ingestion.lastBatchLagSeconds > 10
        ? ` The last events arrived after ${Math.round(ingestion.lastBatchLagSeconds)} s.`
        : ''}
    </Notice>
  );
}
