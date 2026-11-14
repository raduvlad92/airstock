import { z } from 'zod';
import { callerKey } from '../caller.ts';
import { errors } from '../errors.ts';
import { defineOperation } from '../registry.ts';
import { Id, iso } from '../schemas.ts';

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
  externalRef: z.string().nullable(),
  reason: z.string().nullable(),
  changes: z.unknown(),
  error: z.unknown(),
});

export const listActivity = defineOperation({
  id: 'activity.list',
  summary: 'Search the activity history',
  description:
    'Newest first. Filter by target to explain a record, or by attempt to follow one request. Recent events can take a few seconds to appear because reads and failures are ingested through a queue.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    targetType: z.string().max(50).optional(),
    targetId: z.string().max(100).optional(),
    attemptId: Id.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().max(100).optional().describe('Cursor from the previous page.'),
  }),
  output: z.object({ events: z.array(ActivityEvent), nextCursor: z.string().nullable() }),
  permission: 'activity.read',
  connectionScope: 'activity:read',
  audit: { action: 'activity.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/activity' },
  mcp: { tool: 'search_activity', readOnly: true, destructive: false },
  async handler(ctx, input) {
    let cursor: [string, string] | null = null;
    if (input.before) {
      const [time, id] = input.before.split('|');
      if (!time || !id || Number.isNaN(Date.parse(time))) {
        throw errors.validation([{ path: 'before', message: 'Invalid cursor.' }]);
      }
      cursor = [time, id];
    }
    const rows = await ctx.tx.query<{
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
      external_ref: string | null;
      reason: string | null;
      changes: unknown;
      error: unknown;
    }>(
      `select event_id, occurred_at, action, phase, outcome, source, actor_type, actor_id, client_id,
         target_type, target_id, operation_id, attempt_id, external_ref, reason, changes, error
       from audit_events e
       where e.shop_id = app_shop_id()
         and ($1::text is null or e.target_type = $1)
         and ($2::text is null or e.target_id = $2)
         and ($3::uuid is null or e.attempt_id = $3)
         and ($4::timestamptz is null or (e.occurred_at, e.event_id) < ($4::timestamptz, $5::uuid))
         and ($6::uuid[] is null or e.location_ids is null or exists (
           select 1 from locations l where l.id = any(e.location_ids) and l.path_ids && $6::uuid[]))
       order by e.occurred_at desc, e.event_id desc
       limit $7`,
      [
        input.targetType ?? null,
        input.targetId ?? null,
        input.attemptId ?? null,
        cursor?.[0] ?? null,
        cursor?.[1] ?? null,
        ctx.locationScope,
        input.limit + 1,
      ],
    );
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      result: {
        events: page.map((r) => ({
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
          externalRef: r.external_ref,
          reason: r.reason,
          changes: r.changes,
          error: r.error,
        })),
        nextCursor:
          rows.length > input.limit && last ? `${iso(last.occurred_at)}|${last.event_id}` : null,
      },
      audit: { targetType: input.targetType ?? 'activity', targetId: input.targetId ?? 'list' },
    };
  },
});

export const getOperationOutcome = defineOperation({
  id: 'operations.outcome.get',
  summary: 'Look up the result of a command by its idempotency key',
  description:
    'Use after a lost response or an outcome_unknown error. `completed` returns the original result; `not_found` means the command made no change and is safe to retry with the same key.',
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
