import { z } from 'zod';
import { callerKey, type Membership } from '../caller.ts';
import { errors } from '../errors.ts';
import { uuidv7Time } from '../ids.ts';
import { effectivePermissions, type Permission } from '../permissions.ts';
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

/**
 * Values in event `changes` that only some members may read, such as warehouse contract terms
 * (PRD 2.3). The event keeps them; activity reads replace them with "hidden" for everyone else.
 */
const RESTRICTED_CHANGES: Array<{ targetType: string; key: string; permission: Permission }> = [
  { targetType: 'warehouse', key: 'contract', permission: 'storage.commercial.read' },
];

function redactChanges(
  targetType: string | null,
  changes: unknown,
  allowed: ReadonlySet<Permission>,
): unknown {
  if (!changes || typeof changes !== 'object') return changes;
  let out = changes as Record<string, unknown>;
  for (const rule of RESTRICTED_CHANGES) {
    if (rule.targetType === targetType && rule.key in out && !allowed.has(rule.permission)) {
      out = { ...out, [rule.key]: 'hidden' };
    }
  }
  return out;
}

/**
 * Some changes carry values only members with a permission may read, such as supplier costs
 * (`changes.restricted`, ADR 0019). Others see that something restricted changed, not the values.
 */
function redactRestricted(changes: unknown, membership: Membership | null): unknown {
  if (!changes || typeof changes !== 'object' || !('restricted' in changes)) return changes;
  const permission = (changes as { restricted?: { permission?: string } }).restricted?.permission;
  if (!permission) return changes;
  if (membership && effectivePermissions(membership).has(permission as Permission)) return changes;
  return { ...changes, restricted: { permission, hidden: true } };
}

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
    const allowed = ctx.membership ? effectivePermissions(ctx.membership) : new Set<Permission>();
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
          changes: redactRestricted(
            redactChanges(r.target_type, r.changes, allowed),
            ctx.membership,
          ),
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
