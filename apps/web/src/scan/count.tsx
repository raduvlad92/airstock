import type { ops } from '@airstock/core';
import { add, compare, normalize } from '@airstock/core/catalog/decimal';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, command, errorMessage, type Out } from '../api.ts';
import { formatDecimal } from '../components/ui.tsx';
import { useMutation } from '../mutation.ts';
import { belowReserved, type ClaimChoice, ClaimChooser, type ClaimProblem } from './claims.tsx';
import { type ScanEnv, useScanHandler } from './flows.ts';
import {
  applyLineScan,
  type ItemLine,
  LineEditor,
  lineSummary,
  lineUnits,
  newLine,
} from './item-line.tsx';
import { resolveScan } from './resolve.ts';
import { isLotTracked, lotsAt, recordedAt, typed } from './tally.ts';

type QuickCounted = Out<typeof ops.quickCount>;
type Session = Out<typeof ops.getCount>;
type SessionLine = Session['lines'][number];
type Sessions = Out<typeof ops.listCounts>;
type Submitted = Out<typeof ops.submitCount>;

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: not remembered.
  }
}

const SERIAL_HINT = 'Scan the serial of each unit on the shelf. None scanned counts 0.';

/** "On record here: 12 (2 reserved)" for the shelf being counted. */
function recordNote(line: ItemLine, locationId: string): string | null {
  const r = recordedAt(line.stock, locationId, isLotTracked(line.item) ? line.lotCode : undefined);
  if (!r) return null;
  return `On record here: ${formatDecimal(r.onHand)}${compare(r.reserved, '0') > 0 ? ` (${formatDecimal(r.reserved)} reserved)` : ''}`;
}

/** What is missing before the line can be counted, if anything. */
function lineProblem(line: ItemLine, locationId: string | null): string | null {
  if (line.item.trackingMode !== 'serial' && !/^\d+(\.\d{1,6})?$/.test(line.tally.quantity)) {
    return `Type the number of ${line.item.sku} counted.`;
  }
  if (isLotTracked(line.item) && compare(lineUnits(line), '0') > 0 && !line.lotCode.trim()) {
    const lots = locationId ? lotsAt(line.stock, locationId) : [];
    if (lots.length !== 1) return `Which lot of ${line.item.sku}? Scan or choose it.`;
  }
  return null;
}

/**
 * Units picked from the shelf on open pick lists: in a tote, but on record at the shelf until
 * their list is finished (picks never change stock). A count after a short pick adds them.
 */
interface Tote {
  variantId: string;
  lotCode: string;
  quantity: string;
}

function inTote(line: ItemLine, tote: Tote | null): string | null {
  if (!tote || line.item.trackingMode === 'serial' || line.item.variantId !== tote.variantId) {
    return null;
  }
  if (isLotTracked(line.item) && line.lotCode.trim().toUpperCase() !== tote.lotCode.toUpperCase()) {
    return null;
  }
  return tote.quantity;
}

/** The count entry the API takes for a line (quick count and count sessions alike). */
function countItem(line: ItemLine, locationId?: string, picked: string | null = null) {
  const serial = line.item.trackingMode === 'serial';
  if (picked && !serial && /^\d+(\.\d{1,6})?$/.test(line.tally.quantity)) {
    // What is on the shelf plus what was picked from it, in base units.
    return {
      variantId: line.item.variantId,
      ...(locationId ? { locationId } : {}),
      counted: normalize(add(lineUnits(line), picked)),
      ...(isLotTracked(line.item) && line.lotCode.trim() ? { lotCode: line.lotCode.trim() } : {}),
    };
  }
  return {
    variantId: line.item.variantId,
    ...(locationId ? { locationId } : {}),
    ...(serial
      ? line.serials.length > 0
        ? { serials: line.serials }
        : { counted: '0' }
      : {
          counted: typed(line.tally.quantity),
          ...(line.tally.pack ? { packId: line.tally.pack.packId } : {}),
        }),
    ...(isLotTracked(line.item) && line.lotCode.trim() ? { lotCode: line.lotCode.trim() } : {}),
  };
}

/**
 * Count (plan D10, 5.6, 5.12) on the phone. A quick count of the current shelf: scan the
 * location label, then each item (every scan adds one; a case adds a case; or type the number),
 * and confirm, which posts the differences as one count correction. Or work a count session line
 * by line, then submit it, reviewing lines whose shelf moved since they were counted. A count
 * below reserved stock asks, per claim, to release it or move it to other stock.
 */
export function CountFlow({ env }: { env: ScanEnv }) {
  const modeKey = `airstock.scan.count-mode.${env.shopId}`;
  const shortPick = env.preset?.reason === 'short_pick' ? env.preset : null;
  const [mode, setModeState] = useState<'quick' | 'session'>(() =>
    shortPick ? 'quick' : remembered(modeKey) === 'session' ? 'session' : 'quick',
  );
  const setMode = (next: 'quick' | 'session') => {
    remember(modeKey, next);
    setModeState(next);
  };
  return (
    <>
      <fieldset className="scan-segments" aria-label="Count mode">
        <button
          type="button"
          aria-pressed={mode === 'quick'}
          className={mode === 'quick' ? 'chosen' : 'secondary'}
          onClick={() => setMode('quick')}
        >
          Quick count
        </button>
        <button
          type="button"
          aria-pressed={mode === 'session'}
          className={mode === 'session' ? 'chosen' : 'secondary'}
          onClick={() => setMode('session')}
        >
          Count session
        </button>
      </fieldset>
      {mode === 'quick' ? <QuickCount env={env} /> : <SessionCount env={env} />}
    </>
  );
}

function QuickCount({ env }: { env: ScanEnv }) {
  const queryClient = useQueryClient();
  const shortPick = env.preset?.reason === 'short_pick' ? env.preset : null;
  const [at, setAt] = useState<{ locationId: string; path: string } | null>(() =>
    shortPick?.locationId && shortPick.locationPath
      ? { locationId: shortPick.locationId, path: shortPick.locationPath }
      : env.location
        ? { locationId: env.location.locationId, path: env.location.path }
        : null,
  );
  const [lines, setLinesState] = useState<ItemLine[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [problems, setProblems] = useState<ClaimProblem[] | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // A short pick pins the count to its shelf until it is confirmed or cleared.
  const [pinned, setPinned] = useState(shortPick !== null);
  const [tote, setTote] = useState<Tote | null>(() =>
    shortPick?.variantId && shortPick.picked && compare(shortPick.picked, '0') > 0
      ? {
          variantId: shortPick.variantId,
          lotCode: shortPick.lotCode ?? '',
          quantity: normalize(shortPick.picked),
        }
      : null,
  );
  const key = useRef(crypto.randomUUID());
  const setLines = (next: ItemLine[]) => {
    key.current = crypto.randomUUID();
    setLinesState(next);
  };

  // A short pick opens on its shelf with the item already on the list, at 0 until counted.
  const presetDone = useRef(false);
  useEffect(() => {
    if (!shortPick || presetDone.current) return;
    presetDone.current = true;
    const missing = shortPick.missing ? formatDecimal(shortPick.missing) : null;
    const picked =
      shortPick.picked && compare(shortPick.picked, '0') > 0
        ? ` The ${formatDecimal(shortPick.picked)} already picked from it are added.`
        : '';
    setBanner(
      `Short pick${missing ? `: ${missing} × ${shortPick.sku ?? 'the item'} missing` : ''} at ${shortPick.locationPath}. Count what is on the shelf.${picked}`,
    );
    if (!shortPick.sku) return;
    void resolveScan(env.shopId, shortPick.sku)
      .then((found) => {
        if (found.kind !== 'item' || found.item.variantId !== shortPick.variantId) return;
        const line = {
          ...newLine({ ...found.item, pack: null }, found.stock),
          lotCode: shortPick.lotCode ?? '',
        };
        setLinesState((current) => (current.length === 0 ? [line] : current));
        setActive((current) => current ?? line.id);
      })
      .catch(() => {});
  }, [shortPick, env.shopId]);

  // With nothing counted yet, the count follows the current location.
  useEffect(() => {
    if (lines.length === 0 && !pinned && env.location) {
      setAt({ locationId: env.location.locationId, path: env.location.path });
    }
  }, [env.location, lines.length, pinned]);

  const submit = useMutation({
    mutationFn: (choices: ClaimChoice[]) =>
      command<QuickCounted>(
        `/shops/${env.shopId}/counts/quick`,
        {
          locationId: at!.locationId,
          counts: lines.map((l) => countItem(l, undefined, inTote(l, tote))),
          ...(choices.length > 0 ? { reservationChoices: choices } : {}),
        },
        key.current,
      ),
    onSuccess: (r) => {
      const changed = lines.map((l) => {
        const delta = r.changes
          .filter((c) => c.variantId === l.item.variantId)
          .reduce((s, c) => s + Number(c.delta), 0);
        return delta === 0
          ? `${l.item.sku} unchanged`
          : `${l.item.sku} ${delta > 0 ? '+' : ''}${delta}`;
      });
      const moved = r.released.length + r.reallocated.length;
      env.feedback(
        'ok',
        `Counted at ${at!.path}: ${changed.join(', ')}.${moved ? ` ${moved} reserved claim(s) settled.` : ''}`,
      );
      setLines([]);
      setActive(null);
      setProblems(null);
      setBanner(null);
      setPinned(false);
      setTote(null);
      void queryClient.invalidateQueries({ queryKey: ['shop', env.shopId] });
    },
    onError: (error) => {
      key.current = crypto.randomUUID();
      const claims = belowReserved(error);
      if (claims) {
        setProblems(claims);
        env.feedback('notice', 'Some of these units are reserved: choose what happens to them.');
        return;
      }
      env.feedback('error', errorMessage(error));
    },
  });

  useScanHandler((scan) => {
    if (problems) {
      env.feedback('error', 'Choose what happens to the reserved units first.');
      return true;
    }
    if (scan.kind === 'location') {
      if (lines.length === 0) {
        setAt({ locationId: scan.location.locationId, path: scan.location.path });
        setBanner(null);
        setPinned(false);
        setTote(null);
        env.feedback('ok', `Counting ${scan.location.path}. Scan the items.`);
      } else if (scan.location.locationId === at?.locationId) {
        env.feedback('ok', `Counting ${at.path}.`);
      } else {
        env.feedback(
          'error',
          `This count is for ${at?.path}. Confirm or clear it before counting ${scan.location.path}.`,
        );
      }
      return true;
    }
    if (!at) {
      env.feedback('error', 'Scan the shelf’s location label first.');
      return true;
    }
    const next = applyLineScan(lines, active, scan);
    if (next.lines !== lines) setLines(next.lines);
    setActive(next.active);
    env.feedback(next.tone, next.message);
    return true;
  });

  if (problems) {
    return (
      <ClaimChooser
        problems={problems}
        describe={(p) => {
          const line = lines.find((l) => l.item.variantId === p.variantId);
          return `${line?.item.sku ?? 'Item'} at ${at?.path}`;
        }}
        shortOrder={tote ? (shortPick?.order ?? null) : null}
        pending={submit.isPending}
        onApply={(choices) => submit.mutate(choices)}
        onCancel={() => setProblems(null)}
      />
    );
  }

  const withTote = (l: ItemLine) => {
    const picked = inTote(l, tote);
    return picked ? ` + ${formatDecimal(picked)} picked` : '';
  };
  const blocked = lines.map((l) => lineProblem(l, at?.locationId ?? null)).find(Boolean) ?? null;
  const moved = at && env.location && env.location.locationId !== at.locationId && lines.length > 0;
  return (
    <div className="scan-card">
      {banner ? <p className="notice">{banner}</p> : null}
      <h2>{at ? `Count ${at.path}` : 'Quick count'}</h2>
      {!at ? (
        <p className="muted">Scan the shelf’s location label, then every item on it.</p>
      ) : lines.length === 0 ? (
        <p className="muted">
          Scan each item on the shelf: every scan adds one, a case adds a case. Items you do not
          scan stay as they are.
        </p>
      ) : null}
      {moved ? (
        <p className="notice">
          You scanned {env.location!.path}; this count is still for {at.path}.
        </p>
      ) : null}
      {lines.length > 0 ? (
        <ul className="scan-count-lines" aria-label="Counted items">
          {lines.map((line) =>
            line.id === active ? (
              <li key={line.id} className="open">
                <LineEditor
                  env={env}
                  line={line}
                  locationId={at!.locationId}
                  note={[
                    recordNote(line, at!.locationId),
                    inTote(line, tote)
                      ? `${formatDecimal(inTote(line, tote)!)} picked from here, added to the count`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  quantityLabel="Counted"
                  serialHint={SERIAL_HINT}
                  onChange={(next) => setLines(lines.map((l) => (l.id === next.id ? next : l)))}
                  onRemove={() => {
                    setLines(lines.filter((l) => l.id !== line.id));
                    setActive(null);
                  }}
                />
              </li>
            ) : (
              <li key={line.id}>
                <button type="button" className="scan-line-row" onClick={() => setActive(line.id)}>
                  <span>{line.item.productName}</span>
                  <span className="scan-line-status">{lineSummary(line)}</span>
                </button>
              </li>
            ),
          )}
        </ul>
      ) : null}
      {lines.length > 0 && at ? (
        <>
          <ul className="scan-confirm-list" aria-label="To confirm" aria-live="polite">
            {lines.map((l) => (
              <li key={l.id}>
                {lineSummary(l)}
                {withTote(l)}
              </li>
            ))}
          </ul>
          {blocked ? <p className="notice error">{blocked}</p> : null}
          <div className="scan-actions">
            <button
              type="button"
              disabled={blocked !== null || submit.isPending}
              onClick={() => submit.mutate([])}
            >
              {submit.isPending
                ? 'Saving…'
                : `Confirm count of ${lines.length} ${lines.length === 1 ? 'item' : 'items'}`}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setLines([]);
                setActive(null);
                setBanner(null);
                setPinned(false);
                setTote(null);
              }}
            >
              Clear
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

// Count sessions ---------------------------------------------------------------------------------

function SessionCount({ env }: { env: ScanEnv }) {
  const storeKey = `airstock.scan.count.${env.shopId}`;
  const [sessionId, setSessionId] = useState<string | null>(() => remembered(storeKey));
  const choose = (id: string | null) => {
    remember(storeKey, id);
    setSessionId(id);
  };
  if (!sessionId) return <SessionChooser env={env} onChoose={choose} />;
  return (
    <SessionWalk key={sessionId} env={env} sessionId={sessionId} onLeave={() => choose(null)} />
  );
}

function SessionChooser({ env, onChoose }: { env: ScanEnv; onChoose: (id: string) => void }) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['shop', env.shopId, 'counts', 'open'],
    queryFn: () => api<Sessions>(`/shops/${env.shopId}/counts`, { query: { status: 'open' } }),
  });
  const start = useMutation({
    mutationFn: () =>
      command<Session>(`/shops/${env.shopId}/counts`, { locationId: env.location!.locationId }),
    onSuccess: async (s) => {
      await queryClient.invalidateQueries({ queryKey: ['shop', env.shopId, 'counts'] });
      env.feedback('ok', `Count of ${s.location?.path}: ${s.totals.lines} lines.`);
      onChoose(s.sessionId);
    },
    onError: (error) => env.feedback('error', errorMessage(error)),
  });
  const sessions = list.data?.counts.filter((s) => !s.quick) ?? [];
  return (
    <div className="scan-card">
      <h2>Count sessions</h2>
      {sessions.length > 0 ? (
        <ul className="scan-choices" aria-label="Open counts">
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <button type="button" className="scan-choice" onClick={() => onChoose(s.sessionId)}>
                <strong>{s.name ?? s.location?.path ?? 'Count'}</strong>
                <span className="muted">
                  {s.totals.counted} of {s.totals.lines} counted
                  {s.blind ? ' · blind' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : list.isPending ? (
        <p className="muted">Loading…</p>
      ) : (
        <p className="muted">No open count.</p>
      )}
      <div className="scan-actions">
        {env.location ? (
          <button type="button" disabled={start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? 'Starting…' : `New count of ${env.location.path}`}
          </button>
        ) : (
          <p className="muted">Scan a location label to start a count there.</p>
        )}
      </div>
    </div>
  );
}

type Resolution = 'keep_count' | 'apply_movements';

function SessionWalk({
  env,
  sessionId,
  onLeave,
}: {
  env: ScanEnv;
  sessionId: string;
  onLeave: () => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['shop', env.shopId, 'count', sessionId];
  const session = useQuery({
    queryKey,
    queryFn: () => api<Session>(`/shops/${env.shopId}/counts/${sessionId}`),
  });
  const [entry, setEntry] = useState<ItemLine | null>(null);
  const [reviews, setReviews] = useState<Record<string, Resolution>>({});
  const [problems, setProblems] = useState<ClaimProblem[] | null>(null);
  const [done, setDone] = useState<Submitted | null>(null);
  const recordKey = useRef(crypto.randomUUID());
  const submitKey = useRef(crypto.randomUUID());
  const here = env.location?.locationId ?? null;

  const record = useMutation({
    mutationFn: (p: { counts: unknown[]; label: string }) =>
      command<Session>(
        `/shops/${env.shopId}/counts/${sessionId}/record`,
        { counts: p.counts },
        recordKey.current,
      ),
    onSuccess: (s, p) => {
      recordKey.current = crypto.randomUUID();
      queryClient.setQueryData(queryKey, s);
      env.feedback('ok', `Recorded ${p.label}.`);
      setEntry(null);
    },
    onError: (error) => {
      recordKey.current = crypto.randomUUID();
      env.feedback('error', errorMessage(error));
    },
  });

  // Decisions only for lines that still need one; a recounted line no longer does.
  const decided = () =>
    (session.data?.lines ?? [])
      .filter((l) => l.needsReview && reviews[l.lineId])
      .map((l) => ({ lineId: l.lineId, resolution: reviews[l.lineId]! }));

  const submit = useMutation({
    mutationFn: (choices: ClaimChoice[]) =>
      command<Submitted>(
        `/shops/${env.shopId}/counts/${sessionId}/submit`,
        {
          ...(decided().length > 0 ? { reviews: decided() } : {}),
          ...(choices.length > 0 ? { reservationChoices: choices } : {}),
        },
        submitKey.current,
      ),
    onSuccess: async (r) => {
      submitKey.current = crypto.randomUUID();
      setDone(r);
      setProblems(null);
      queryClient.setQueryData(queryKey, r.session);
      env.feedback('ok', `Count submitted: ${r.changes.length} change(s) posted.`);
      await queryClient.invalidateQueries({ queryKey: ['shop', env.shopId, 'counts'] });
    },
    onError: async (error) => {
      submitKey.current = crypto.randomUUID();
      const claims = belowReserved(error);
      if (claims) {
        setProblems(claims);
        env.feedback('notice', 'Some of these units are reserved: choose what happens to them.');
        return;
      }
      if (error instanceof ApiError && error.code === 'count_needs_review') {
        env.feedback(
          'notice',
          'Some shelves moved after you counted them. Review the marked lines.',
        );
        await queryClient.invalidateQueries({ queryKey });
        return;
      }
      env.feedback('error', errorMessage(error));
    },
  });

  const lines = session.data?.lines ?? [];
  useScanHandler((scan) => {
    if (session.data?.status !== 'open' || problems) return false;
    if (scan.kind === 'location') {
      env.feedback('ok', `Counting at ${scan.location.path}. Scan the items.`);
      return true;
    }
    if (!here) {
      env.feedback('error', 'Scan the shelf’s location label first.');
      return true;
    }
    const current = entry ? [entry] : [];
    if (entry && scan.kind === 'item' && scan.item.variantId !== entry.item.variantId) {
      env.feedback('error', `Record or cancel ${entry.item.sku} first.`);
      return true;
    }
    const next = applyLineScan(current, entry?.id ?? null, scan);
    if (next.lines[0]) setEntry(next.lines[0]);
    env.feedback(next.tone, next.message);
    return true;
  });

  if (session.isPending) return <p className="muted">Loading the count…</p>;
  if (session.error) {
    return (
      <div className="scan-card">
        <p className="notice error">{errorMessage(session.error)}</p>
        <button type="button" className="secondary" onClick={onLeave}>
          Other counts
        </button>
      </div>
    );
  }
  const s = session.data;
  if (done || s.status !== 'open') {
    return (
      <div className="scan-card">
        <h2>
          {s.name ?? s.location?.path ?? 'Count'} is {done ? 'submitted' : s.status}
        </h2>
        {done ? (
          <p>
            {done.changes.length} change(s) posted
            {done.released.length + done.reallocated.length
              ? `; ${done.released.length + done.reallocated.length} reserved claim(s) settled`
              : ''}
            .
          </p>
        ) : null}
        <button type="button" onClick={onLeave}>
          Counts
        </button>
      </div>
    );
  }
  if (problems) {
    return (
      <ClaimChooser
        problems={problems}
        describe={(p) => {
          const line = lines.find(
            (l) => l.variantId === p.variantId && l.locationId === p.locationId,
          );
          return line ? `${line.sku} at ${line.locationPath}` : 'An item';
        }}
        pending={submit.isPending}
        onApply={(choices) => submit.mutate(choices)}
        onCancel={() => setProblems(null)}
      />
    );
  }

  const toReview = lines.filter((l) => l.needsReview);
  const undecided = toReview.filter((l) => !reviews[l.lineId]);
  const entryProblem = entry ? lineProblem(entry, here) : null;
  const zero = (l: SessionLine) =>
    record.mutate({
      counts: [
        {
          variantId: l.variantId,
          locationId: l.locationId,
          counted: '0',
          ...(l.lotCode ? { lotCode: l.lotCode } : {}),
        },
      ],
      label: `none of ${l.sku} at ${l.locationPath}`,
    });

  return (
    <>
      <div className="scan-card">
        <div className="scan-pick-progress">
          <strong>{s.name ?? s.location?.path ?? 'Count'}</strong>
          <span>
            {s.totals.counted} of {s.totals.lines} counted
          </span>
        </div>
        {entry ? (
          <>
            <LineEditor
              env={env}
              line={entry}
              locationId={here}
              note={s.blind || !here ? null : recordNote(entry, here)}
              quantityLabel="Counted"
              serialHint={SERIAL_HINT}
              onChange={setEntry}
              onRemove={() => setEntry(null)}
              removeLabel="Cancel"
            />
            {entryProblem ? <p className="notice error">{entryProblem}</p> : null}
            <div className="scan-actions">
              <button
                type="button"
                disabled={entryProblem !== null || record.isPending}
                onClick={() =>
                  record.mutate({
                    counts: [countItem(entry, here!)],
                    label: `${lineSummary(entry)} at ${env.location?.path}`,
                  })
                }
              >
                {record.isPending
                  ? 'Recording…'
                  : `Record ${formatDecimal(lineUnits(entry))} × ${entry.item.sku}`}
              </button>
            </div>
          </>
        ) : (
          <p className="muted">
            {here
              ? `At ${env.location!.path}: scan each item and record it.`
              : 'Scan a shelf’s location label, then its items.'}
          </p>
        )}
      </div>
      {toReview.length > 0 ? (
        <section className="scan-card" aria-label="Moved since counted">
          <h2>Moved since counted</h2>
          <p className="muted">
            Stock moved on these shelves after you counted them. Keep your count, add the movements
            to it, or scan the item again to recount.
          </p>
          <ul className="scan-claim-list">
            {toReview.map((l) => {
              const moved = l.movementsSince.reduce((sum, m) => sum + Number(m.quantity), 0);
              return (
                <li key={l.lineId}>
                  <span>
                    <strong>
                      {l.sku} · {l.locationPath}
                    </strong>{' '}
                    <span className="muted">
                      counted {formatDecimal(l.counted)}; {moved > 0 ? '+' : ''}
                      {moved} since
                    </span>
                  </span>
                  <div className="scan-claim-actions">
                    {(
                      [
                        ['keep_count', 'Keep my count'],
                        ['apply_movements', 'Add the movements'],
                      ] as Array<[Resolution, string]>
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={reviews[l.lineId] === value}
                        className={reviews[l.lineId] === value ? 'chosen' : 'secondary'}
                        onClick={() => setReviews((r) => ({ ...r, [l.lineId]: value }))}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <ul className="scan-pick-lines" aria-label="Count lines">
        {lines.map((l) => (
          <li key={l.lineId}>
            <div className={`scan-session-line${l.locationId === here ? ' current' : ''}`}>
              <span>
                {l.locationPath} · {l.sku}
                {l.lotCode ? ` · lot ${l.lotCode}` : ''}
                {l.serial ? ` · SN ${l.serial}` : ''}
              </span>
              <span className="muted">
                {l.expected === null ? 'blind' : `on record ${formatDecimal(l.expected)}`}
              </span>
              <span className="scan-line-status">
                {l.status === 'pending' ? 'to count' : formatDecimal(l.counted)}
                {l.needsReview ? ' · moved' : ''}
              </span>
              {l.status === 'pending' && l.locationId === here && !l.serial ? (
                <button
                  type="button"
                  className="secondary small"
                  disabled={record.isPending}
                  onClick={() => zero(l)}
                >
                  None here
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <div className="scan-actions">
        <button
          type="button"
          disabled={
            s.totals.counted === 0 || undecided.length > 0 || submit.isPending || entry !== null
          }
          onClick={() => submit.mutate([])}
        >
          {submit.isPending
            ? 'Submitting…'
            : undecided.length > 0
              ? `Review ${undecided.length} moved ${undecided.length === 1 ? 'line' : 'lines'} first`
              : `Submit count (${s.totals.counted} of ${s.totals.lines} counted)`}
        </button>
        <button type="button" className="secondary" onClick={onLeave}>
          Other counts
        </button>
      </div>
    </>
  );
}
