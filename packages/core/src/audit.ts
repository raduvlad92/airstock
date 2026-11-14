import type { Caller, Source } from './caller.ts';
import { uuidv7 } from './ids.ts';

export type AuditOutcome =
  | 'received'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'conflict'
  | 'no_change'
  | 'replayed'
  | 'unknown';

/** Audit envelope, schema version 1 (PRD 7.2). Field names match the audit_events columns. */
export interface AuditEvent {
  event_id: string;
  occurred_at: string;
  schema_version: 1;
  shop_id: string | null;
  actor_type: Caller['kind'];
  actor_id: string | null;
  on_behalf_of: string | null;
  client_id: string | null;
  grant_id: string | null;
  action: string;
  phase: 'attempt' | 'outcome';
  outcome: AuditOutcome;
  source: Source;
  attempt_id: string | null;
  request_id: string | null;
  operation_id: string | null;
  target_type: string | null;
  target_id: string | null;
  location_ids: string[] | null;
  idempotency_key: string | null;
  external_ref: string | null;
  reason: string | null;
  changes: unknown;
  context: unknown;
  error: unknown;
}

/**
 * Durable intake for events written outside the business transaction: attempts, reads,
 * failures, replays (PRD 7.3). `send` resolves only once the events are durably accepted
 * (the queue acknowledged them); callers await it before answering.
 */
export interface AuditSink {
  send(events: AuditEvent[]): Promise<void>;
}

export interface AuditBase {
  shopId: string | null;
  caller: Caller;
  requestId: string;
  attemptId: string | null;
  idempotencyKey: string | null;
}

export function auditEvent(
  base: AuditBase,
  fields: Pick<AuditEvent, 'action' | 'phase' | 'outcome'> & Partial<AuditEvent>,
): AuditEvent {
  const now = Date.now();
  return {
    event_id: uuidv7(now),
    occurred_at: new Date(now).toISOString(),
    schema_version: 1,
    shop_id: base.shopId,
    actor_type: base.caller.kind,
    actor_id: base.caller.id,
    on_behalf_of: null,
    client_id: base.caller.clientId ?? null,
    grant_id: base.caller.grantId ?? null,
    source: base.caller.source,
    attempt_id: base.attemptId,
    request_id: base.requestId,
    operation_id: null,
    target_type: null,
    target_id: null,
    location_ids: null,
    idempotency_key: base.idempotencyKey,
    external_ref: null,
    reason: null,
    changes: null,
    context: null,
    error: null,
    ...fields,
  };
}

const AUDIT_COLUMNS = `event_id uuid, occurred_at timestamptz, schema_version smallint, shop_id uuid,
  actor_type text, actor_id text, on_behalf_of text, client_id text, grant_id uuid, action text,
  phase text, outcome text, source text, attempt_id uuid, request_id uuid, operation_id uuid,
  target_type text, target_id text, location_ids uuid[], idempotency_key text, external_ref text,
  reason text, changes jsonb, context jsonb, error jsonb`;

const AUDIT_COLUMN_NAMES = AUDIT_COLUMNS.split(',')
  .map((c) => c.trim().split(/\s+/)[0])
  .join(', ');

/** INSERT for events written inside a business transaction; $1 is a JSON array of events. */
export const INSERT_AUDIT_EVENTS_SQL = `insert into audit_events (${AUDIT_COLUMN_NAMES})
  select ${AUDIT_COLUMN_NAMES} from jsonb_to_recordset($1::jsonb) as e(${AUDIT_COLUMNS})`;
