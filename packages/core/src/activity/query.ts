// The activity history query (PRD 7.4): the shop timeline with its filters, used by the activity
// list (REST, MCP, dashboard) and the activity export job. Keyset paging on
// (occurred_at, event_id), newest first, so a page never skips or repeats an event.

import { z } from 'zod';
import { errors } from '../errors.ts';
import { UUID_PATTERN } from '../ids.ts';
import { Id } from '../schemas.ts';

export const ACTOR_TYPES = ['user', 'api_credential', 'connection', 'connector', 'system'] as const;
export const SOURCES = [
  'dashboard',
  'api',
  'mcp',
  'import',
  'scheduled',
  'admin',
  'shopify',
  'webhooks',
] as const;
export const OUTCOMES = [
  'received',
  'succeeded',
  'failed',
  'denied',
  'cancelled',
  'conflict',
  'no_change',
  'replayed',
  'unknown',
] as const;

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
  /** True when the event names locations, at least one inside the reader's scope. */
  in_scope: boolean;
  /** True when the event's locations were not known when it was written. */
  unknown_location: boolean;
}

export function parseCursor(before: string | undefined): [string, string] | null {
  if (!before) return null;
  const [time, id] = before.split('|');
  if (!time || !id || Number.isNaN(Date.parse(time)) || !UUID_PATTERN.test(id)) {
    throw errors.validation([{ path: 'before', message: 'Invalid cursor.' }]);
  }
  return [time, id];
}

/** `inventory.*` → a LIKE prefix; `_` and `%` in action names are literal. */
function actionPatterns(value: string): { exact: string[]; prefixes: string[] } {
  const exact: string[] = [];
  const prefixes: string[] = [];
  for (const raw of value.split(',').slice(0, 20)) {
    const part = raw.trim();
    if (!part) continue;
    if (part.endsWith('*')) {
      prefixes.push(`${part.slice(0, -1).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    } else {
      exact.push(part);
    }
  }
  return { exact, prefixes };
}

export interface ActivityQuery {
  filters: ActivityFiltersInput;
  /** The reader's location scope (warehouse or location IDs), or null for every location. */
  scope: string[] | null;
  limit: number;
  cursor: [string, string] | null;
  /**
   * Show events whose locations were not yet known when written (attempts of commands whose
   * locations need the database) when another event of the same request is in scope. Used for
   * one request's lifecycle.
   */
  includeUnknownInBatch?: boolean;
}

/**
 * Builds the timeline query. Filters become plain predicates (never `$n is null or …`), so the
 * planner sees the shape it runs and can use the indexes chosen on the 1-million-event seed.
 */
export function activityQuery(q: ActivityQuery): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const p = (value: unknown, cast = '') => {
    params.push(value);
    return `$${params.length}${cast}`;
  };
  const f = q.filters;
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
  if (f.action) {
    const { exact, prefixes } = actionPatterns(f.action);
    // One predicate per pattern (not `like any`), so each can use the action index.
    const parts = [
      ...(exact.length ? [`e.action = any(${p(exact, '::text[]')})`] : []),
      ...prefixes.map((prefix) => `e.action like ${p(prefix)}`),
    ];
    if (parts.length) where.push(`(${parts.join(' or ')})`);
  }
  if (f.integration) {
    // Integrations act as API credentials, AI connections, or connectors, whose IDs are UUIDs; a
    // client ID (`shopify`, an OAuth client) names the app behind them. Only integrations carry
    // a client ID, so no actor-type predicate is needed (it also misleads the planner, being
    // correlated with the client ID).
    where.push(
      UUID_PATTERN.test(f.integration)
        ? `e.actor_id = ${p(f.integration)}`
        : `e.client_id = ${p(f.integration)}`,
    );
  }
  if (f.locationId) {
    where.push(
      `e.location_ids && array(select l.id from locations l where l.path_ids @> array[${p(f.locationId, '::uuid')}])`,
    );
  }
  if (q.cursor) {
    where.push(
      `(e.occurred_at, e.event_id) < (${p(q.cursor[0], '::timestamptz')}, ${p(q.cursor[1], '::uuid')})`,
    );
  }
  // Location scope (PRD 2.4): a limited member sees events about no location, and events
  // naming at least one location inside their scope. The scope's locations are listed once.
  const scoped = q.scope !== null;
  const scopeLocations = scoped
    ? `array(select l.id from locations l where l.path_ids && ${p(q.scope, '::uuid[]')})`
    : null;
  if (scopeLocations) {
    where.push(
      q.includeUnknownInBatch
        ? `(e.location_ids is null or cardinality(e.location_ids) = 0 or e.location_ids && ${scopeLocations})`
        : `(e.location_ids is null or e.location_ids && ${scopeLocations})`,
    );
  }
  const locationColumn = scopeLocations
    ? `case when e.location_ids is null then null else array(select x from unnest(e.location_ids) x where x = any(${scopeLocations})) end`
    : 'e.location_ids';
  const inScope = scopeLocations
    ? `coalesce(e.location_ids && ${scopeLocations}, false)`
    : 'coalesce(cardinality(e.location_ids) > 0, false)';
  const sql = `select e.event_id, e.occurred_at, e.action, e.phase, e.outcome, e.source, e.actor_type,
      e.actor_id, e.client_id, e.target_type, e.target_id, e.operation_id, e.attempt_id,
      e.request_id, e.external_ref, e.reason, e.changes, e.error,
      ${locationColumn} as location_ids,
      ${inScope} as in_scope,
      coalesce(cardinality(e.location_ids) = 0, false) as unknown_location
    from audit_events e
    where ${where.join('\n      and ')}
    order by e.occurred_at desc, e.event_id desc
    limit ${p(q.limit, '::int')}`;
  return { sql, params };
}
