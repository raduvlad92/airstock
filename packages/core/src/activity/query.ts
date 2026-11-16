// The activity history query (PRD 7.4): the shop timeline with its filters, used by the activity
// list (REST, MCP, dashboard) and the activity export job. Keyset paging on
// (occurred_at, event_id), newest first, so a page never skips or repeats an event.
//
// The indexes behind it were chosen on the 1-million-event bench history (migration 0061, ADR
// "Activity views", docs/phase-2-measurements.md "I5 activity search"). Two rules keep the plans
// predictable there:
// - Every filter is a plain predicate (never `$n is null or …`), so the planner sees the shape it
//   runs.
// - Filters whose matches the planner cannot estimate are resolved first, against the shop's
//   own history (`resolveActivityFilters`): an action group becomes the list of actions the shop
//   has, and a source the shop never used ends the search before it starts.

import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { errors } from '../errors.ts';
import { UUID_PATTERN } from '../ids.ts';
import { Id } from '../schemas.ts';
import { ACTOR_TYPES, OUTCOMES, SOURCES } from './vocabulary.ts';

/** Every filter is optional and they combine with AND. */
export const ActivityFilters = z.object({
  actorType: z
    .enum(ACTOR_TYPES)
    .optional()
    .describe(
      'Who acted: a person, an API credential, an AI connection, a connector such as Shopify, or the system.',
    ),
  actorId: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('A user, API credential, connection, or connector ID, or a system job name.'),
  source: z.enum(SOURCES).optional().describe('Where the request came from.'),
  from: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe('Events at or after this time (ISO 8601).'),
  to: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe('Events before this time (ISO 8601).'),
  targetType: z
    .string()
    .max(50)
    .optional()
    .describe('The kind of record, such as product, variant, location, warehouse, or import.'),
  targetId: z.string().max(100).optional().describe('The record’s ID.'),
  action: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .optional()
    .describe(
      'An action such as inventory.receipt.created, or a prefix ending in * such as inventory.*. Several, comma-separated, match any.',
    ),
  outcome: z.enum(OUTCOMES).optional(),
  phase: z
    .enum(['attempt', 'outcome'])
    .optional()
    .describe('attempt: commands as they arrived; outcome: what happened.'),
  locationId: Id.optional().describe(
    'A warehouse or location: events about it or any location inside it.',
  ),
  integration: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'An API credential, AI connection, or connector ID, or a client ID such as shopify: what that integration did.',
    ),
  attemptId: Id.optional().describe(
    'One request (a batch): its attempt, its outcome, and every record it changed, such as each row of a bulk edit or an import.',
  ),
  operationId: Id.optional().describe('An inventory operation, as returned by stock commands.'),
});
export type ActivityFiltersInput = z.infer<typeof ActivityFilters>;

export interface ActivityRow {
  event_id: string;
  occurred_at: Date;
  action: string;
  phase: 'attempt' | 'outcome';
  outcome: string;
  source: string;
  actor_type: string;
  actor_id: string | null;
  client_id: string | null;
  target_type: string | null;
  target_id: string | null;
  operation_id: string | null;
  attempt_id: string | null;
  request_id: string | null;
  external_ref: string | null;
  reason: string | null;
  changes: unknown;
  error: unknown;
  /** Only the in-scope locations for a member limited to some locations. */
  location_ids: string[] | null;
}

export function parseCursor(before: string | undefined): [string, string] | null {
  if (!before) return null;
  const [time, id] = before.split('|');
  if (!time || !id || Number.isNaN(Date.parse(time)) || !UUID_PATTERN.test(id)) {
    throw errors.validation([{ path: 'before', message: 'Invalid cursor.' }]);
  }
  return [time, id];
}

/** Most action patterns in one filter; more are refused rather than ignored. */
const MAX_ACTION_PATTERNS = 20;

/** `inventory.*` is a prefix; anything else is one action. */
function actionPatterns(value: string): { exact: string[]; prefixes: string[] } {
  const exact: string[] = [];
  const prefixes: string[] = [];
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > MAX_ACTION_PATTERNS) {
    throw errors.validation([
      { path: 'action', message: `At most ${MAX_ACTION_PATTERNS} actions or groups.` },
    ]);
  }
  for (const part of parts) {
    if (part.endsWith('*')) prefixes.push(part.slice(0, -1));
    else exact.push(part);
  }
  return { exact, prefixes };
}

/** The first string after every string that starts with `prefix`, in byte order. */
function prefixEnd(prefix: string): string {
  const last = prefix.codePointAt(prefix.length - 1)!;
  return `${prefix.slice(0, -1)}${String.fromCodePoint(last + 1)}`;
}

/**
 * The shop's actions that start with a prefix, by a loose scan of `audit_events_shop_action_idx`:
 * one index probe per distinct action, however many events each has. A planner estimate for a
 * prefix is a guess (the action may be new and unused, or nearly every event), so the search uses
 * the exact list instead, which the action statistics can price.
 */
const ACTIONS_WITH_PREFIX = `with recursive a(action) as (
    (select e.action collate "C" from audit_events e
     where e.shop_id = app_shop_id() and e.action collate "C" >= $1 and e.action collate "C" < $2
     order by e.action collate "C" limit 1)
    union all
    select (select e.action collate "C" from audit_events e
            where e.shop_id = app_shop_id() and e.action collate "C" > a.action
              and e.action collate "C" < $2
            order by e.action collate "C" limit 1)
    from a where a.action is not null
  )
  select action from a where action is not null limit 1000`;

/**
 * A reader's location scope, listed: the locations inside it, and the warehouses and locations
 * whose records they may see (warehouses they have a location in). Null for every location.
 */
export interface ResolvedScope {
  locations: string[];
  records: string[];
}

/** Lists a member's scope (warehouse or location IDs) once per request (PRD 2.4). */
export async function resolveScope(tx: Tx, scope: string[] | null): Promise<ResolvedScope | null> {
  if (scope === null) return null;
  const rows = await tx.query<{ id: string; warehouse_id: string }>(
    `select l.id, l.path_ids[1] as warehouse_id from locations l
     where l.shop_id = app_shop_id() and l.path_ids && $1::uuid[]`,
    [scope],
  );
  const locations = rows.map((r) => r.id);
  return {
    locations,
    records: [...new Set([...scope, ...locations, ...rows.map((r) => r.warehouse_id)])],
  };
}

/**
 * Filters as the search runs them, with the values the planner needs to see: an action group
 * becomes the list of the shop's actions in it, and a warehouse or location the list of
 * locations inside it.
 */
export type ResolvedActivityFilters = Omit<ActivityFiltersInput, 'action' | 'locationId'> & {
  /** The actions to match, exactly; absent for every action. */
  actions?: string[];
  /** The locations to match, and the warehouse whose own events match too. */
  place?: { locations: string[]; warehouseId: string | null };
};

/**
 * Turns the caller's filters into the search's, against the shop's own history and the reader's
 * scope. Null when no event can match: an action group the shop has no events in, a source it
 * never used, or a place outside the reader's scope. Then the search costs a few index probes
 * instead of a walk through the shop's whole history.
 */
export async function resolveActivityFilters(
  tx: Tx,
  filters: ActivityFiltersInput,
  scope: ResolvedScope | null,
): Promise<ResolvedActivityFilters | null> {
  const { action, locationId, ...rest } = filters;
  const resolved: ResolvedActivityFilters = rest;
  if (action) {
    const { exact, prefixes } = actionPatterns(action);
    if (!prefixes.includes('')) {
      const actions = new Set(exact);
      for (const prefix of prefixes) {
        const rows = await tx.query<{ action: string }>(ACTIONS_WITH_PREFIX, [
          prefix,
          prefixEnd(prefix),
        ]);
        for (const r of rows) actions.add(r.action);
      }
      if (actions.size === 0) return null;
      resolved.actions = [...actions];
    }
  }
  if (rest.source) {
    // A source's share differs from shop to shop (Shopify is half of one shop's history and none
    // of another's), which a shop-wide estimate cannot see.
    const [used] = await tx.query<{ used: boolean }>(
      `select exists (select 1 from audit_events e
         where e.shop_id = app_shop_id() and e.source = $1) as used`,
      [rest.source],
    );
    if (!used?.used) return null;
  }
  if (locationId) {
    // The warehouse or location itself and every location inside it; a warehouse's own events
    // (a rename) name no location. A limited reader matches only on locations in their scope:
    // an event that also names an outside location does not match on that one.
    const [row] = await tx.query<{ locations: string[]; warehouse: boolean }>(
      `select coalesce(array_agg(l.id), '{}') as locations,
         exists (select 1 from warehouses w where w.id = $1) as warehouse
       from locations l where l.shop_id = app_shop_id() and l.path_ids @> array[$1::uuid]`,
      [locationId],
    );
    const inScope = (id: string) => scope === null || scope.locations.includes(id);
    const locations = (row?.locations ?? []).filter(inScope);
    const warehouseId =
      row?.warehouse && (scope === null || scope.records.includes(locationId)) ? locationId : null;
    if (locations.length === 0 && warehouseId === null) return null;
    resolved.place = { locations, warehouseId };
  }
  return resolved;
}

export interface ActivityQuery {
  filters: ResolvedActivityFilters;
  /** The reader's location scope, from `resolveScope`. */
  scope: ResolvedScope | null;
  limit: number;
  cursor: [string, string] | null;
  /**
   * Also show events whose locations were not known when written (the attempt of a command
   * whose locations the database names). Set for one request whose events are in scope.
   */
  includeUnknownLocations?: boolean;
}

type Param = (value: unknown, cast?: string) => string;

function params(): { list: unknown[]; p: Param } {
  const list: unknown[] = [];
  return {
    list,
    p: (value, cast = '') => {
      list.push(value);
      return `$${list.length}${cast}`;
    },
  };
}

/**
 * Location scope (PRD 2.4): a member limited to some locations sees events about no location and
 * events naming at least one location inside their scope; an event about a warehouse or location
 * record only when they may see that record. `locations` is the scope's locations placeholder.
 */
function scopeWhere(
  scope: ResolvedScope,
  locations: string,
  p: Param,
  includeUnknown: boolean,
): string[] {
  const unknown = includeUnknown ? ' or cardinality(e.location_ids) = 0' : '';
  return [
    `(e.location_ids is null${unknown} or e.location_ids && ${locations})`,
    `(e.target_type is null or e.target_type not in ('warehouse', 'location')
        or e.target_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-'
        or e.target_id = any(${p(scope.records, '::text[]')}))`,
  ];
}

function filterWhere(f: ResolvedActivityFilters, p: Param): string[] {
  const where = ['e.shop_id = app_shop_id()'];
  if (f.targetType) where.push(`e.target_type = ${p(f.targetType)}`);
  if (f.targetId) where.push(`e.target_id = ${p(f.targetId)}`);
  if (f.actorType) where.push(`e.actor_type = ${p(f.actorType)}`);
  if (f.actorId) where.push(`e.actor_id = ${p(f.actorId)}`);
  if (f.source) where.push(`e.source = ${p(f.source)}`);
  if (f.outcome) where.push(`e.outcome = ${p(f.outcome)}`);
  if (f.phase) where.push(`e.phase = ${p(f.phase)}`);
  if (f.from) where.push(`e.occurred_at >= ${p(f.from, '::timestamptz')}`);
  if (f.to) where.push(`e.occurred_at < ${p(f.to, '::timestamptz')}`);
  if (f.attemptId) where.push(`e.attempt_id = ${p(f.attemptId, '::uuid')}`);
  if (f.operationId) where.push(`e.operation_id = ${p(f.operationId, '::uuid')}`);
  if (f.actions) {
    // In the index's collation, so the index serves it whatever the database's collation is.
    where.push(`e.action collate "C" = any(${p(f.actions, '::text[]')})`);
  }
  if (f.integration) {
    // Integrations act as API credentials, AI connections, or connectors, whose IDs are UUIDs; a
    // client ID (an OAuth client) names the app behind a connection.
    where.push(
      UUID_PATTERN.test(f.integration)
        ? `e.actor_id = ${p(f.integration)}`
        : `e.client_id = ${p(f.integration)}`,
    );
  }
  if (f.place) {
    const parts: string[] = [];
    if (f.place.locations.length > 0) {
      parts.push(`e.location_ids && ${p(f.place.locations, '::uuid[]')}`);
    }
    if (f.place.warehouseId) {
      parts.push(`(e.target_type = 'warehouse' and e.target_id = ${p(f.place.warehouseId)})`);
    }
    where.push(parts.length === 1 ? parts[0]! : `(${parts.join(' or ')})`);
  }
  return where;
}

/** Builds the timeline query, newest first, from filters `resolveActivityFilters` returned. */
export function activityQuery(q: ActivityQuery): { sql: string; params: unknown[] } {
  const { list, p } = params();
  const where = filterWhere(q.filters, p);
  if (q.cursor) {
    where.push(
      `(e.occurred_at, e.event_id) < (${p(q.cursor[0], '::timestamptz')}, ${p(q.cursor[1], '::uuid')})`,
    );
  }
  let locations = 'e.location_ids';
  if (q.scope !== null) {
    const inScope = p(q.scope.locations, '::uuid[]');
    where.push(...scopeWhere(q.scope, inScope, p, q.includeUnknownLocations === true));
    // Only the locations inside the scope are listed.
    locations = `case when e.location_ids is null then null
      else array(select x from unnest(e.location_ids) x where x = any(${inScope})) end`;
  }
  const sql = `select e.event_id, e.occurred_at, e.action, e.phase, e.outcome, e.source, e.actor_type,
      e.actor_id, e.client_id, e.target_type, e.target_id, e.operation_id, e.attempt_id,
      e.request_id, e.external_ref, e.reason, e.changes, e.error, ${locations} as location_ids
    from audit_events e
    where ${where.join('\n      and ')}
    order by e.occurred_at desc, e.event_id desc
    limit ${p(q.limit, '::int')}`;
  return { sql, params: list };
}

/**
 * Whether one request has an event inside a scope: then its events whose locations were not
 * known when written (its attempt, say) are shown with it.
 */
export function requestInScopeQuery(
  attemptId: string,
  scope: ResolvedScope,
): { sql: string; params: unknown[] } {
  return {
    sql: `select exists (select 1 from audit_events e
      where e.shop_id = app_shop_id() and e.attempt_id = $1::uuid
        and e.location_ids && $2::uuid[]) as in_scope`,
    params: [attemptId, scope.locations],
  };
}

/**
 * One request from attempt to outcome (PRD 7.4): its action, when it arrived, its outcome and
 * when that was recorded, and how many events it has, records changed included, within the
 * reader's scope.
 */
export function lifecycleQuery(
  attemptId: string,
  scope: ResolvedScope | null,
  includeUnknownLocations: boolean,
): { sql: string; params: unknown[] } {
  const { list, p } = params();
  const where = filterWhere({ attemptId }, p);
  if (scope !== null) {
    where.push(...scopeWhere(scope, p(scope.locations, '::uuid[]'), p, includeUnknownLocations));
  }
  const sql = `with ev as (
      select e.phase, e.action, e.outcome, e.occurred_at from audit_events e
      where ${where.join('\n        and ')}
    ),
    attempt as (select action, occurred_at from ev where phase = 'attempt' order by occurred_at limit 1),
    main as (
      select o.action, o.outcome, o.occurred_at from ev o
      where o.phase = 'outcome' and o.action = coalesce((select action from attempt), o.action)
      order by o.occurred_at limit 1
    )
    select coalesce((select action from attempt), (select action from main)) as action,
      (select occurred_at from attempt) as started_at,
      (select outcome from main) as outcome,
      (select occurred_at from main) as finished_at,
      (select max(occurred_at) from ev) as last_at,
      (select count(*) from ev)::int as events,
      (select count(*) from ev where phase = 'outcome'
        and outcome in ('failed', 'denied', 'conflict', 'unknown'))::int as problems`;
  return { sql, params: list };
}

/**
 * Whether the history is behind (PRD 7.3): this shop's commands of the last 15 minutes whose
 * outcome is in the history (written with the change) but whose attempt, sent through the
 * queue first, is not yet; and the queue consumer's last batch. Reads and failures reach the
 * history only through the queue, so a missing attempt is the shop's own sign of a backlog.
 */
export const ingestionQuery = `select p.pending, p.oldest, s.last_batch_at, s.last_batch_lag_ms as lag_ms,
     (select max(occurred_at) from audit_events where shop_id = app_shop_id()) as newest
   from (
     select count(distinct o.attempt_id)::int as pending,
       extract(epoch from now() - min(o.occurred_at))::float8 as oldest
     from audit_events o
     where o.shop_id = app_shop_id() and o.phase = 'outcome' and o.attempt_id is not null
       and o.occurred_at > now() - interval '15 minutes'
       and o.occurred_at < now() - interval '5 seconds'
       and not exists (select 1 from audit_events a
         where a.attempt_id = o.attempt_id and a.phase = 'attempt'
           -- The attempt comes first; a day back reaches an import job's commit request.
           and a.occurred_at > o.occurred_at - interval '1 day')) p
   left join audit_ingestion_status s on true`;
