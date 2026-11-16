import type { ops } from '@airstock/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api, command, type Out } from '../api.ts';
import {
  Badge,
  Card,
  Empty,
  ErrorNotice,
  Field,
  formatDateTime,
  Loading,
  Notice,
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';
import { useMutation } from '../mutation.ts';

// The stock check (D18): the scheduled reconciliation's last results, the problems found now, and
// the reviewed repair of one problem. Nothing is repaired without a person confirming it.

type StockCheck = Out<typeof ops.getStockCheck>;
type Problem = StockCheck['current']['problems'][number];
type Preview = Out<typeof ops.previewStockRepair>;

const TRIGGER_LABEL = { scheduled: 'after stock changes', daily: 'daily' } as const;

export function StockCheckPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const context = useShopContext(shopId);
  const [selected, setSelected] = useState<Problem | null>(null);
  const [repaired, setRepaired] = useState(false);
  const check = useQuery({
    queryKey: ['shop', shopId, 'stock-check'],
    queryFn: () => api<StockCheck>(`/shops/${shopId}/stock-check`),
    enabled: can(context.data, 'inventory.read'),
  });
  if (!context.data) return <Loading />;
  if (!can(context.data, 'inventory.read')) {
    return <Notice>The stock check needs the inventory.read permission.</Notice>;
  }
  const canRepair = can(context.data, 'inventory.adjust');
  const data = check.data;
  return (
    <>
      <Card title="Stock check">
        <p className="fine">
          Every 30 minutes after stock changes, and once a day, Airstock checks that stock history,
          balances, reservations, serials, and the quantity behind the average cost agree. A problem
          opens an alert. Nothing is changed until someone reviews and repairs it here.
        </p>
        <ErrorNotice error={check.error} />
        {check.isLoading ? <Loading /> : null}
        {data ? (
          <dl className="facts">
            <dt>Last check</dt>
            <dd>
              {data.lastCheck
                ? `${formatDateTime(data.lastCheck.checkedAt)} (${TRIGGER_LABEL[data.lastCheck.trigger]})`
                : 'Not checked yet'}
            </dd>
            <dt>Result</dt>
            <dd>{data.lastCheck ? <ProblemBadge count={data.lastCheck.problemCount} /> : '—'}</dd>
            <dt>Alert</dt>
            <dd>
              {data.alert && data.alert.status !== 'resolved' ? (
                <>
                  <Badge tone="error">Open</Badge> since {formatDateTime(data.alert.openedAt)},
                  found by {data.alert.occurrences}{' '}
                  {data.alert.occurrences === 1 ? 'check' : 'checks'}
                </>
              ) : data.alert ? (
                `Resolved ${formatDateTime(data.alert.resolvedAt)}`
              ) : (
                'None'
              )}
            </dd>
          </dl>
        ) : null}
      </Card>

      {data ? (
        <Card title="Problems now">
          {repaired ? (
            <Notice tone="ok">
              Repaired.{' '}
              {data.current.problemCount === 0 && data.alert?.status === 'open'
                ? 'The alert closes at the next scheduled check.'
                : null}
            </Notice>
          ) : null}
          {data.current.problemCount === 0 ? (
            <Empty>Stock adds up: no problems right now.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table" aria-label="Stock problems">
                <thead>
                  <tr>
                    <th>Problem</th>
                    <th>Item</th>
                    <th>Expected</th>
                    <th>Found</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.current.problems.map((p) => (
                    <tr key={`${p.problem}:${p.targetId}`}>
                      <td>
                        {p.title}
                        <div className="fine">
                          <code>{p.problem}</code>
                        </div>
                      </td>
                      <td>
                        {p.sku ?? '—'}
                        {p.locationPath ? <div className="fine">{p.locationPath}</div> : null}
                      </td>
                      <td>{p.expected}</td>
                      <td>{p.actual}</td>
                      <td>
                        {!p.repairable ? (
                          <span className="fine">Review by hand</span>
                        ) : canRepair ? (
                          <button
                            type="button"
                            className="small ghost"
                            onClick={() => {
                              setRepaired(false);
                              setSelected(p);
                            }}
                          >
                            Preview repair
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.current.partial ? (
            <p className="fine">Only problems at your locations are listed.</p>
          ) : null}
          {data.current.problemCount > data.current.problems.length ? (
            <p className="fine">
              Showing {data.current.problems.length} of {data.current.problemCount} problems.
            </p>
          ) : null}
          {selected ? (
            <RepairPanel
              shopId={shopId}
              problem={selected}
              onClose={() => setSelected(null)}
              onRepaired={() => {
                setSelected(null);
                setRepaired(true);
              }}
            />
          ) : null}
        </Card>
      ) : null}

      {data && data.recent.length > 0 ? (
        <Card title="Recent checks">
          <div className="table-wrap">
            <table className="table" aria-label="Recent stock checks">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Run</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDateTime(r.checkedAt)}</td>
                    <td>{TRIGGER_LABEL[r.trigger]}</td>
                    <td>
                      <ProblemBadge count={r.problemCount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}

function ProblemBadge({ count }: { count: number }) {
  return count === 0 ? (
    <Badge tone="ok">No problems</Badge>
  ) : (
    <Badge tone="error">
      {count} {count === 1 ? 'problem' : 'problems'}
    </Badge>
  );
}

/** The compensating operation for one problem, committed only with a reason. */
function RepairPanel({
  shopId,
  problem,
  onClose,
  onRepaired,
}: {
  shopId: string;
  problem: Problem;
  onClose: () => void;
  onRepaired: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const preview = useQuery({
    queryKey: ['shop', shopId, 'stock-check', 'preview', problem.problem, problem.targetId],
    queryFn: () =>
      api<Preview>(`/shops/${shopId}/stock-check/repair-preview`, {
        query: { problem: problem.problem, targetId: problem.targetId },
      }),
  });
  const repair = useMutation({
    mutationFn: (p: Preview) =>
      command(`/shops/${shopId}/stock-check/repairs`, {
        problem: problem.problem,
        targetId: problem.targetId,
        expected: p.problem?.expected,
        actual: p.problem?.actual,
        reason: reason.trim(),
        confirm: true,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'stock-check'] });
      onRepaired();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (preview.data) repair.mutate(preview.data);
  };
  const plan = preview.data;
  return (
    <section className="panel" aria-label="Repair preview">
      <div className="panel-head">
        <h2>Repair: {problem.title}</h2>
        <button type="button" className="small ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <ErrorNotice error={preview.error} />
      {preview.isLoading ? <Loading /> : null}
      {plan && !plan.reported ? (
        <Notice>This problem is no longer reported. There is nothing to repair.</Notice>
      ) : null}
      {plan?.repair ? (
        <form onSubmit={submit}>
          <p>{plan.repair.summary}</p>
          <dl className="facts">
            <dt>Changes</dt>
            <dd>
              {plan.repair.from} → {plan.repair.to}
            </dd>
          </dl>
          <Field label="Reason">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What a count or the records showed"
              required
              maxLength={500}
              rows={2}
            />
          </Field>
          <button type="submit" disabled={repair.isPending || reason.trim() === ''}>
            Repair
          </button>
          <ErrorNotice error={repair.error} />
        </form>
      ) : null}
      {plan?.guidance ? <p className="fine">{plan.guidance}</p> : null}
    </section>
  );
}
