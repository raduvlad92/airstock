import type { Tx } from '@airstock/db';
import { z } from 'zod';
import {
  ActivityFilters,
  type ActivityRow,
  activityQuery,
  ingestionQuery,
  lifecycleQuery,
  parseCursor,
  type ResolvedScope,
  requestInScopeQuery,
  resolveActivityFilters,
  resolveScope,
} from '../activity/query.ts';
import { redactEventChanges } from '../activity/redact.ts';
import { callerKey, type Membership } from '../caller.ts';
import { errors } from '../errors.ts';
import { uuidv7Time } from '../ids.ts';
import { effectivePermissions } from '../permissions.ts';
import { defineOperation } from '../registry.ts';
import { Id, iso } from '../schemas.ts';
import { ExportOut, exportOut, loadExport, storeCaller } from './imports.ts';

const ActivityEvent = z.object({
  eventId: Id,
  occurredAt: z.string(),
  action: z.string(),
  phase: z.enum(['attempt', 'outcome']),
  outcome: z.string(),
  source: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  clientId: z.string().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  operationId: Id.nullable(),
  attemptId: Id.nullable(),
  requestId: Id.nullable(),
  locationIds: z
    .array(Id)
    .nullable()
    .describe('Locations the event is about (only your own, if you are limited to some).'),
  externalRef: z.string().nullable(),
  reason: z.string().nullable(),
  changes: z.unknown(),
  error: z.unknown(),
});

const Lifecycle = z
  .object({
    attemptId: Id,
    action: z.string().nullable(),
    status: z
      .string()
      .describe(
        'The outcome of the request (succeeded, failed, denied, conflict, …), or pending while only its attempt is recorded.',
      ),
    startedAt: z.string().nullable().describe('When the attempt was recorded, before it ran.'),
    finishedAt: z.string().nullable().describe('When its outcome was recorded.'),
    durationMs: z.number().int().nullable(),
    lastEventAt: z
      .string()
      .nullable()
      .describe('The request’s latest event, such as the last row of an import.'),
    events: z
      .number()
      .int()
      .describe('Events of this request you can see, each record it changed included.'),
    problems: z.number().int().describe('Of those, failed, denied, conflict, or unknown.'),
  })
  .describe('With attemptId, on the first page: the request from attempt to outcome.');

const Ingestion = z
  .object({
    delayed: z.boolean().describe('True when recent events may not be listed yet.'),
    pendingRequests: z
      .number()
      .int()
      .describe('Recent commands of this shop whose queued records have not arrived yet.'),
    oldestPendingSeconds: z.number().nullable(),
    lastBatchAt: z.string().nullable().describe('When the queue last delivered events.'),
    lastBatchLagSeconds: z
      .number()
      .nullable()
      .describe('How long the last delivered events waited in the queue.'),
    newestEventAt: z.string().nullable(),
  })
  .describe('Reads, attempts, and failures reach the history through a queue (first page only).');

type ActivityEventOut = z.infer<typeof ActivityEvent>;

function eventOut(r: ActivityRow, membership: Membership | null): ActivityEventOut {
  return {
    eventId: r.event_id,
    occurredAt: iso(r.occurred_at) as string,
    action: r.action,
    phase: r.phase,
    outcome: r.outcome,
    source: r.source,
    actorType: r.actor_type,
    actorId: r.actor_id,
    clientId: r.client_id,
    targetType: r.target_type,
    targetId: r.target_id,
    operationId: r.operation_id,
    attemptId: r.attempt_id,
    requestId: r.request_id,
    locationIds: r.location_ids,
    externalRef: r.external_ref,
    reason: r.reason,
    changes: redactEventChanges(r.target_type, r.changes, membership),
    error: r.error,
  };
}

/** Events still waiting in the queue: this shop's recent commands and the consumer's lag. */
async function ingestion(tx: Tx): Promise<z.infer<typeof Ingestion>> {
  const [row] = await tx.query<{
    pending: number;
    oldest: number | null;
    last_batch_at: Date | null;
    lag_ms: number | null;
    newest: Date | null;
  }>(ingestionQuery);
  const lag = row?.lag_ms ?? null;
  const recent =
    row?.last_batch_at && Date.now() - new Date(row.last_batch_at).getTime() < 15 * 60_000;
  return {
    delayed: (row?.pending ?? 0) > 0 || (recent === true && lag !== null && lag > 10_000),
    pendingRequests: row?.pending ?? 0,
    oldestPendingSeconds:
      row?.oldest === null || row?.oldest === undefined ? null : Math.round(row.oldest),
    lastBatchAt: iso(row?.last_batch_at ?? null),
    lastBatchLagSeconds: lag === null ? null : Math.round(lag / 100) / 10,
    newestEventAt: iso(row?.newest ?? null),
  };
}

/** One request from attempt to outcome, with the records it changed (PRD 7.4). */
async function lifecycle(
  tx: Tx,
  attemptId: string,
  scope: ResolvedScope | null,
  includeUnknownLocations: boolean,
): Promise<z.infer<typeof Lifecycle> | null> {
  const { sql, params } = lifecycleQuery(attemptId, scope, includeUnknownLocations);
  const [row] = await tx.query<{
    action: string | null;
    started_at: Date | null;
    outcome: string | null;
    finished_at: Date | null;
    last_at: Date | null;
    events: number;
    problems: number;
  }>(sql, params);
  if (!row || row.events === 0) return null;
  const started = row.started_at;
  const finished = row.finished_at;
  return {
    attemptId,
    action: row.action,
    status: row.outcome ?? 'pending',
    startedAt: iso(started),
    finishedAt: iso(finished),
    durationMs:
      started && finished ? new Date(finished).getTime() - new Date(started).getTime() : null,
    lastEventAt: iso(row.last_at),
    events: row.events,
    problems: row.problems,
  };
}

export const listActivity = defineOperation({
  id: 'activity.list',
  summary: 'Search the activity history',
  description:
    'Use this when someone asks who changed something, what happened to a record, why a command failed or was refused, or what a person, API key, or AI connection did. Filter by record (targetType and targetId), who (actorId or actorType), integration, source, action (exact, or a group such as inventory.*), outcome, phase, date range (from, to), warehouse or location (locationId), stock operation (operationId), or one request (attemptId: its attempt, its outcome, and every record it changed, such as each row of an import, with a lifecycle summary). Newest first; page with `before`. Not for current stock or catalog values: use get_stock or search_catalog. Recent events can take a few seconds to appear; `ingestion` says when the history is behind.',
  kind: 'read',
  scope: 'shop',
  input: ActivityFilters.extend({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().max(100).optional().describe('Cursor from the previous page.'),
  }),
  output: z.object({
    events: z.array(ActivityEvent),
    nextCursor: z.string().nullable(),
    lifecycle: Lifecycle.nullable(),
    ingestion: Ingestion.nullable(),
  }),
  permission: 'activity.read',
  connectionScope: 'activity:read',
  audit: { action: 'activity.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/activity' },
  mcp: { tool: 'search_activity', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const { limit, before, ...filters } = input;
    const cursor = parseCursor(before);
    const scope = await resolveScope(ctx.tx, ctx.locationScope);
    // One request's events whose locations were not known when written (its attempt, say) show
    // when another event of that request is inside the reader's scope.
    let unknownInScope = false;
    if (filters.attemptId && scope !== null) {
      const { sql, params } = requestInScopeQuery(filters.attemptId, scope);
      const [row] = await ctx.tx.query<{ in_scope: boolean }>(sql, params);
      unknownInScope = row?.in_scope === true;
    }
    const resolved = await resolveActivityFilters(ctx.tx, filters, scope);
    let rows: ActivityRow[] = [];
    if (resolved) {
      const { sql, params } = activityQuery({
        filters: resolved,
        scope,
        limit: limit + 1,
        cursor,
        includeUnknownLocations: unknownInScope,
      });
      rows = await ctx.tx.query<ActivityRow>(sql, params);
    }
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const result = {
      events: page.map((r) => eventOut(r, ctx.membership)),
      nextCursor: rows.length > limit && last ? `${iso(last.occurred_at)}|${last.event_id}` : null,
      lifecycle:
        filters.attemptId && !before
          ? await lifecycle(ctx.tx, filters.attemptId, scope, unknownInScope)
          : null,
      ingestion: before ? null : await ingestion(ctx.tx),
    };
    return {
      result,
      audit: {
        targetType: input.targetType ?? 'activity',
        targetId: input.targetId ?? 'list',
        context: { filters, before: before ?? null, returned: page.length },
      },
    };
  },
});

export const createActivityExport = defineOperation({
  id: 'activity.exports.create',
  summary: 'Export the activity history as CSV',
  description:
    'Writes the events matching the filters (the same as the activity list) as CSV, newest first, at most 50,000 per file, as a job. The file is ready for 24 hours and listed with the other exports; creating, finishing, and downloading it are all in the history.',
  kind: 'command',
  scope: 'shop',
  input: ActivityFilters,
  output: z.object({ export: ExportOut }),
  // Downloading any export needs exports.run; reading the history needs activity.read too.
  permission: 'exports.run',
  connectionScope: 'activity:read',
  audit: { action: 'activity.export.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/activity/exports', status: 201 },
  mcp: {
    exception:
      'An activity export is a file, downloaded in the dashboard or through the API; MCP clients search the history with search_activity.',
  },
  async handler(ctx, input) {
    if (!ctx.membership || !effectivePermissions(ctx.membership).has('activity.read')) {
      throw errors.forbidden('Requires the activity.read permission.');
    }
    const exportId = ctx.newId();
    const query = { mode: 'activity', filters: input };
    await ctx.tx.query(
      `insert into export_jobs (shop_id, id, caller, query) values (app_shop_id(), $1, $2, $3)`,
      [exportId, JSON.stringify(storeCaller(ctx.caller)), JSON.stringify(query)],
    );
    return {
      result: { export: exportOut(ctx.shopId, await loadExport(ctx.tx, exportId)) },
      audit: { targetType: 'export', targetId: exportId, changes: { query } },
      outbox: [{ topic: 'catalog.export.run', payload: { exportId } }],
    };
  },
});

export const getOperationOutcome = defineOperation({
  id: 'operations.outcome.get',
  summary: 'Look up the result of a command by its idempotency key',
  description:
    'Use after a lost response or an outcome_unknown error. `completed` returns the original result; `not_found` means the command made no change and is safe to retry with the same key. Results are kept for 7 days: after that every key answers `not_found`.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    operation: z
      .string()
      .min(1)
      .max(100)
      .describe('Operation ID, for example inventory.reservations.create.'),
    idempotencyKey: z.string().min(1).max(200),
  }),
  output: z.object({
    status: z.enum(['completed', 'not_found']),
    result: z.unknown(),
    completedAt: z.string().nullable(),
  }),
  permission: 'shop.read',
  connectionScope: 'shop:read',
  audit: { action: 'operation.outcome.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/operation-outcomes' },
  mcp: { tool: 'get_operation_outcome', readOnly: true, destructive: false },
  async handler(ctx, input) {
    // Keys are bound to the caller: one caller can never read another caller's results.
    const [row] = await ctx.tx.query<{ response: unknown; completed_at: Date }>(
      `select response, completed_at from idempotency_records
       where shop_id = app_shop_id() and caller_id = $1 and operation_id = $2 and key = $3
         and status = 'completed'`,
      [callerKey(ctx.caller), input.operation, input.idempotencyKey],
    );
    return {
      result: row
        ? { status: 'completed' as const, result: row.response, completedAt: iso(row.completed_at) }
        : { status: 'not_found' as const, result: null, completedAt: null },
      audit: {
        targetType: 'idempotency_key',
        targetId: `${input.operation}:${input.idempotencyKey}`,
      },
    };
  },
});

/**
 * Interface actions the dashboard reports itself (PRD 7.1, plan Section 5.14). Saved-view changes,
 * queries, and edits are server operations and are recorded as such, not here.
 */
export const CLIENT_EVENT_TYPES = [
  'page.viewed',
  'grid.column_visibility_changed',
  'grid.column_order_changed',
  'grid.column_resized',
  'grid.page_sorted_locally',
  'view.type_switched',
  'detail_panel.opened',
  'detail_panel.closed',
] as const;

/** How far a client clock may be off, and how late a batch may arrive (a tab asleep overnight). */
const CLIENT_EVENT_FUTURE_MS = 5 * 60 * 1000;
const CLIENT_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const DetailValue = z.union([
  z.string().max(200),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(100)).max(50),
]);

const ClientEvent = z.object({
  eventId: Id.refine((id) => id[14] === '7', 'Must be a UUIDv7.').describe(
    'A UUIDv7 made by the client. Its time is the event time; a resent event with the same ID is recorded once.',
  ),
  seq: z.number().int().min(0).max(2_147_483_647).describe('Client sequence number in the page.'),
  type: z.enum(CLIENT_EVENT_TYPES),
  targetType: z.string().trim().min(1).max(50).optional(),
  targetId: z.string().trim().min(1).max(100).optional(),
  details: z
    .record(z.string().max(50), DetailValue)
    .refine((d) => Object.keys(d).length <= 20, 'At most 20 details.')
    .optional(),
});

export const recordClientEvents = defineOperation({
  id: 'activity.client_events.record',
  summary: 'Record interface events reported by the dashboard',
  description:
    'Batches of up to 100 events. They are stored as client-reported (action `client.<type>`, `context.clientReported`), and an event ID already recorded is dropped.',
  // Recorded through the audit queue like any access event: no business data changes.
  kind: 'read',
  scope: 'shop',
  input: z.object({ events: z.array(ClientEvent).min(1).max(100) }),
  output: z.object({
    accepted: z.number().int(),
    duplicates: z.number().int(),
    rejected: z.number().int().describe('Events whose time was too far in the past or future.'),
  }),
  permission: 'shop.read',
  connectionScope: 'session',
  audit: { action: 'activity.client_events.received' },
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/activity/client-events', status: 200 },
  mcp: { exception: 'Interface telemetry, reported by the dashboard only.' },
  async handler(ctx, input) {
    const now = Date.now();
    const seen = new Set<string>();
    let duplicates = 0;
    let rejected = 0;
    const events = [];
    for (const e of input.events) {
      if (seen.has(e.eventId)) {
        duplicates++;
        continue;
      }
      seen.add(e.eventId);
      const at = uuidv7Time(e.eventId);
      if (at > now + CLIENT_EVENT_FUTURE_MS || at < now - CLIENT_EVENT_MAX_AGE_MS) {
        rejected++;
        continue;
      }
      events.push(
        ctx.event({
          // The event's identity and time come from the client, so a resent batch lands on the
          // same audit key and is ignored.
          event_id: e.eventId,
          occurred_at: new Date(at).toISOString(),
          action: `client.${e.type}`,
          outcome: 'succeeded',
          target_type: e.targetType ?? null,
          target_id: e.targetId ?? null,
          context: {
            clientReported: true,
            clientSeq: e.seq,
            ...(e.details ? { details: e.details } : {}),
          },
        }),
      );
    }
    return {
      result: { accepted: events.length, duplicates, rejected },
      audit: {
        targetType: 'client_events',
        targetId: 'batch',
        context: { accepted: events.length, duplicates, rejected },
      },
      events,
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const activityOperations = [
  listActivity,
  createActivityExport,
  recordClientEvents,
  getOperationOutcome,
] as const;
