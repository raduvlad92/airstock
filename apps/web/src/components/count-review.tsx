import { add, compare, normalize, subtract } from '@airstock/core/catalog/decimal';
import { useState } from 'react';
import { ApiError } from '../api.ts';
import { Field, formatDecimal, Notice } from './ui.tsx';

// What a count asks before it changes stock (ADR 0031), shown the same way wherever a count is
// typed: the stock panel, the Counts tab, and the catalog grid (G5). A count below reserved stock
// asks, per claim, to release it or move it to other stock; a count whose shelf moved since it
// was read asks whether the number stands.

interface Claim {
  allocationId: string;
  reservationId: string;
  purpose: string;
  externalRef: string | null;
  outstanding: string;
}
export interface ClaimProblem {
  positionId: string;
  toResolve: string;
  allocations: Claim[];
}
export type Choice = { allocationId: string; action: 'release' | 'reallocate'; quantity?: string };

/** The claims a below-reserved error lists, if that is what the error is. */
export function belowReserved(error: unknown): ClaimProblem[] | null {
  if (error instanceof ApiError && error.code === 'below_reserved') {
    return (error.problem.positions as ClaimProblem[] | undefined) ?? null;
  }
  return null;
}

/** Asks, per claim, to release it or move it to other stock, then retries with the choices. */
export function ClaimChoices({
  problems,
  pending,
  onRetry,
}: {
  problems: ClaimProblem[];
  pending: boolean;
  onRetry: (choices: Choice[]) => void;
}) {
  const [actions, setActions] = useState<Record<string, string>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  return (
    <div className="stack">
      <Notice>
        This leaves fewer units than are reserved. Choose what happens to each claim; nothing is
        released without your choice.
      </Notice>
      {problems.map((p) => (
        <div key={p.positionId} className="stack">
          <p className="muted">{formatDecimal(p.toResolve)} reserved units need a decision.</p>
          {p.allocations.map((a) => (
            <div className="inline-form" key={a.allocationId}>
              <span>
                {a.purpose === 'transfer' ? 'Transfer hold' : (a.externalRef ?? 'Reservation')} ·{' '}
                {formatDecimal(a.outstanding)}
              </span>
              <Field label="Action">
                <select
                  value={actions[a.allocationId] ?? ''}
                  onChange={(e) => setActions({ ...actions, [a.allocationId]: e.target.value })}
                >
                  <option value="">Keep</option>
                  {a.purpose === 'transfer' ? null : <option value="release">Release</option>}
                  <option value="reallocate">Move to other stock</option>
                </select>
              </Field>
              <Field label="Units">
                <input
                  value={amounts[a.allocationId] ?? ''}
                  onChange={(e) => setAmounts({ ...amounts, [a.allocationId]: e.target.value })}
                  placeholder={`All ${formatDecimal(a.outstanding)}`}
                  inputMode="decimal"
                  size={8}
                />
              </Field>
            </div>
          ))}
        </div>
      ))}
      <div>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            onRetry(
              Object.entries(actions)
                .filter(([, action]) => action !== '')
                .map(([allocationId, action]) => ({
                  allocationId,
                  action: action as Choice['action'],
                  ...((amounts[allocationId] ?? '').trim()
                    ? { quantity: amounts[allocationId]!.trim() }
                    : {}),
                })),
            )
          }
        >
          Apply with these choices
        </button>
      </div>
    </div>
  );
}

/** What a count was based on: the position version (null when there was none) and on hand. */
export interface PositionRead {
  version: number | null;
  onHand: string;
}

export interface MovedProblem {
  variantId: string;
  locationId: string;
  read: PositionRead;
  now: PositionRead;
}

/** The positions a moved-since-read error lists, if that is what the error is. */
export function movedSinceRead(error: unknown): MovedProblem[] | null {
  if (error instanceof ApiError && error.code === 'moved_since_read') {
    return (error.problem.positions as MovedProblem[] | undefined) ?? null;
  }
  return null;
}

/**
 * Units moved on the shelf after the count's number was read: keep the count as the number there
 * now, or add the movements since (as a count session's review offers). Either retries with what
 * is there now as the new read.
 */
export function MovedSinceReadReview({
  problem,
  counted,
  pending,
  onRetry,
}: {
  problem: MovedProblem;
  counted: string;
  pending: boolean;
  onRetry: (counted: string, read: PositionRead) => void;
}) {
  const moved = normalize(subtract(problem.now.onHand, problem.read.onHand));
  const withMovements = normalize(add(counted, moved));
  const sign = compare(moved, '0') > 0 ? '+' : '';
  return (
    <div className="stack">
      <Notice>
        Stock moved here since you read it: on hand was {formatDecimal(problem.read.onHand)}, now{' '}
        {formatDecimal(problem.now.onHand)} ({sign}
        {formatDecimal(moved)}). Nothing was changed. Is {formatDecimal(counted)} the number on the
        shelf now?
      </Notice>
      <div className="toolbar">
        <button type="button" disabled={pending} onClick={() => onRetry(counted, problem.now)}>
          Keep my count ({formatDecimal(counted)})
        </button>
        {compare(withMovements, '0') >= 0 ? (
          <button
            type="button"
            className="ghost"
            disabled={pending}
            onClick={() => onRetry(withMovements, problem.now)}
          >
            Count plus movements since ({formatDecimal(withMovements)})
          </button>
        ) : null}
      </div>
    </div>
  );
}
