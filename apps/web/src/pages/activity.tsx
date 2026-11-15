import type { ops } from '@airstock/core';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { api, type Out } from '../api.ts';
import {
  Badge,
  Card,
  Empty,
  ErrorNotice,
  formatDateTime,
  Loading,
  PageHeader,
} from '../components/ui.tsx';

type Activity = Out<typeof ops.listActivity>;
export type ActivityEvent = Activity['events'][number];

/** The activity history, newest first; with a target, the history of one record. */
export function useActivity(shopId: string, target?: { type: string; id: string }) {
  return useInfiniteQuery({
    queryKey: ['shop', shopId, 'activity', target?.type ?? null, target?.id ?? null],
    queryFn: ({ pageParam }) =>
      api<Activity>(`/shops/${shopId}/activity`, {
        query: { before: pageParam, targetType: target?.type, targetId: target?.id, limit: 50 },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

const OUTCOME_TONE: Record<string, string> = {
  succeeded: 'ok',
  received: 'muted',
  failed: 'error',
  denied: 'error',
  conflict: 'warn',
};

export function ActivityTable({ events }: { events: ActivityEvent[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Outcome</th>
            <th>By</th>
            <th>Target</th>
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
                {e.targetType ? `${e.targetType} ${e.targetId ?? ''}` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ActivityPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const activity = useActivity(shopId);
  const events = activity.data?.pages.flatMap((p) => p.events) ?? [];
  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="Every change, read, and refusal, with who did it and from where. New events can take a few seconds to appear."
      />
      <Card>
        <ErrorNotice error={activity.error} />
        {activity.isPending ? <Loading /> : null}
        {activity.data && events.length === 0 ? <Empty>No activity yet.</Empty> : null}
        {events.length > 0 ? <ActivityTable events={events} /> : null}
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
