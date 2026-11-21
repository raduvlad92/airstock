import { add, compare, normalize, subtract } from '@airstock/core/catalog/decimal';
import { useState } from 'react';
import { ApiError } from '../api.ts';
import { formatDecimal } from '../components/ui.tsx';

/**
 * Below reserved (ADR 0031, PRD 6.6) on the phone: a count or move that leaves fewer units than
 * are reserved lists each claim, and the person chooses per claim to release it or move it to
 * other stock. Nothing is released without a choice; the quantity defaults to what is needed.
 */
export interface Claim {
  allocationId: string;
  reservationId: string;
  purpose: string;
  externalRef: string | null;
  outstanding: string;
}

export interface ClaimProblem {
  positionId: string;
  variantId?: string;
  locationId?: string;
  onHandAfter?: string;
  reserved?: string;
  toResolve: string;
  allocations: Claim[];
}

export interface ClaimChoice {
  allocationId: string;
  action: 'release' | 'reallocate';
  quantity?: string;
}

export function belowReserved(error: unknown): ClaimProblem[] | null {
  if (error instanceof ApiError && error.code === 'below_reserved') {
    return (error.problem.positions as ClaimProblem[] | undefined) ?? null;
  }
  return null;
}

type Action = '' | 'release' | 'reallocate';

function claimLabel(c: Claim): string {
  if (c.purpose === 'transfer') return 'Transfer hold';
  return c.externalRef ?? (c.purpose === 'manual' ? 'Manual reservation' : 'Reservation');
}

export function ClaimChooser({
  problems: given,
  describe,
  shortOrder = null,
  pending,
  onApply,
  onCancel,
}: {
  problems: ClaimProblem[];
  /** Names the item of a problem, such as its SKU and shelf. */
  describe: (p: ClaimProblem) => string;
  /** The order a short pick left without its units: listed first and marked. */
  shortOrder?: string | null;
  pending: boolean;
  onApply: (choices: ClaimChoice[]) => void;
  onCancel: () => void;
}) {
  const [actions, setActions] = useState<Record<string, Action>>({});
  const problems = shortOrder
    ? given.map((p) => ({
        ...p,
        allocations: [
          ...p.allocations.filter((a) => a.externalRef === shortOrder),
          ...p.allocations.filter((a) => a.externalRef !== shortOrder),
        ],
      }))
    : given;
  // Per position, how much each claim gives up: claims in order until the difference is covered.
  const quantities: Record<string, string> = {};
  let ready = true;
  for (const p of problems) {
    let rest = normalize(p.toResolve);
    for (const a of p.allocations) {
      if (!actions[a.allocationId]) continue;
      const take = compare(a.outstanding, rest) < 0 ? normalize(a.outstanding) : rest;
      quantities[a.allocationId] = take;
      rest = normalize(subtract(rest, take));
    }
    if (compare(rest, '0') > 0) ready = false;
  }
  const choices: ClaimChoice[] = Object.entries(actions)
    .filter(([id, action]) => action !== '' && compare(quantities[id] ?? '0', '0') > 0)
    .map(([allocationId, action]) => ({
      allocationId,
      action: action as ClaimChoice['action'],
      quantity: quantities[allocationId]!,
    }));
  return (
    <section className="scan-card scan-claims" aria-label="Reserved stock">
      <h2>Reserved stock</h2>
      <p>
        This leaves fewer units than are reserved. Choose for each order what happens to its units:
        nothing is released unless you say so.
      </p>
      {problems.map((p) => {
        const chosen = p.allocations.reduce(
          (s, a) => (actions[a.allocationId] ? add(s, quantities[a.allocationId] ?? '0') : s),
          '0',
        );
        return (
          <div key={p.positionId} className="scan-claim-group">
            <p className="scan-confirm">
              {describe(p)}: {formatDecimal(p.toResolve)} reserved{' '}
              {p.toResolve === '1' ? 'unit needs' : 'units need'} a decision (
              {formatDecimal(normalize(chosen))} chosen)
            </p>
            <ul className="scan-claim-list">
              {p.allocations.map((a) => {
                const action = actions[a.allocationId] ?? '';
                return (
                  <li key={a.allocationId}>
                    <span>
                      <strong>{claimLabel(a)}</strong>{' '}
                      <span className="muted">
                        {formatDecimal(a.outstanding)} reserved
                        {shortOrder && a.externalRef === shortOrder ? ' · short pick' : ''}
                      </span>
                    </span>
                    <div className="scan-claim-actions">
                      {(
                        [
                          ['', 'Keep'],
                          ...(a.purpose === 'transfer' ? [] : [['release', 'Release']]),
                          ['reallocate', 'Move to other stock'],
                        ] as Array<[Action, string]>
                      ).map(([value, label]) => (
                        <button
                          key={value || 'keep'}
                          type="button"
                          aria-pressed={action === value}
                          className={action === value ? 'chosen' : 'secondary'}
                          onClick={() => setActions((s) => ({ ...s, [a.allocationId]: value }))}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {action && quantities[a.allocationId] ? (
                      <span className="muted small-text">
                        {action === 'release' ? 'Releases' : 'Moves'}{' '}
                        {formatDecimal(quantities[a.allocationId]!)}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <div className="scan-actions">
        <button type="button" disabled={!ready || pending} onClick={() => onApply(choices)}>
          {pending ? 'Saving…' : 'Apply with these choices'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Back
        </button>
      </div>
    </section>
  );
}
