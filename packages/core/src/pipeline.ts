import { CommitOutcomeUnknownError, type Database, type Tx } from '@airstock/db';
import { applyStockAlerts } from './alerts/check.ts';
import { type AuditEvent, type AuditSink, auditEvent, INSERT_AUDIT_EVENTS_SQL } from './audit.ts';
import { type Caller, callerKey, type Membership } from './caller.ts';
import { AppError, errors } from './errors.ts';
import { canonicalJson, sha256Hex } from './hash.ts';
import { UUID_PATTERN, uuidv7 } from './ids.ts';
import type { MediaDelivery } from './media/signing.ts';
import { effectivePermissions, isRole } from './permissions.ts';
import type { AnyOperation, FileAccess, HandlerContext, HandlerResult } from './registry.ts';
import { catalogChangeEmit, INSERT_WEBHOOK_OUTBOX_SQL } from './webhooks/events.ts';
import type { WebhookSecretCipher } from './webhooks/signing.ts';

export interface Logger {
  error(message: string, data?: Record<string, unknown>): void;
  /** Optional: measurements and other non-error lines. */
  info?(message: string, data?: Record<string, unknown>): void;
}

export interface PipelineDeps {
  db: Database;
  audit: AuditSink;
  logger?: Logger;
  files?: FileAccess;
  /** Signs media links in results; without it they are null and uploads are refused. */
  media?: MediaDelivery;
  /** Encrypts webhook signing secrets; without it creating a webhook is refused. */
  webhookSecrets?: WebhookSecretCipher;
}

export interface ExecuteRequest {
  caller: Caller;
  /** The shop named by the request (path or grant). Ignored for account operations. */
  shopId: string | null;
  input: unknown;
  idempotencyKey?: string | null;
  requestId?: string;
}

export interface ExecuteResult {
  result: unknown;
  replayed: boolean;
  requestId: string;
  attemptId: string | null;
  /** Null for account-level reads, which span the caller's shops. */
  shopId: string | null;
  /** Outbox events this call committed; the caller may publish them right away. */
  outbox: number;
}

/**
 * The one command path shared by REST, MCP, connectors, and jobs (PRD 10.3).
 *
 * Commands: authorize → validate → durable attempt event → transaction (idempotency claim,
 * location scope, handler, success event, outbox, idempotency result) → commit.
 * Reads: authorize → validate → read-only transaction → durable access event → return.
 * Every failure after authentication sends one outcome event before the error is returned.
 */
export async function execute(
  deps: PipelineDeps,
  op: AnyOperation,
  req: ExecuteRequest,
): Promise<ExecuteResult> {
  const requestId = req.requestId ?? uuidv7();
  const { caller } = req;
  // An account-level command creates the shop it names; an account-level read spans the
  // caller's shops and runs, and is audited, without a shop.
  const shopId = op.scope === 'account' ? (op.kind === 'command' ? uuidv7() : null) : req.shopId;
  const idempotencyKey = req.idempotencyKey ?? null;
  let attemptId: string | null = null;

  const base = () => ({
    shopId: shopId && UUID_PATTERN.test(shopId) ? shopId : null,
    caller,
    requestId,
    attemptId,
    idempotencyKey,
  });

  // The locations this request touches, for location-scoped history (PRD 2.4, A42). Null for
  // operations without a `locations` hook; [] while they are not known yet, which hides the
  // event from members limited to some locations until it is known.
  let locationIds: string[] | null = op.locations ? [] : null;

  const fail = async (error: unknown): Promise<never> => {
    const appError = toAppError(error, deps.logger, op.id);
    try {
      await deps.audit.send([
        auditEvent(base(), {
          action: op.audit.action,
          phase: 'outcome',
          outcome: appError.outcome,
          location_ids: locationIds,
          error: { code: appError.code, status: appError.status },
          // What the caller was told (field errors, conflicts, similar items), so the warning
          // shown is in the history along with the choice made next (plan 5.7).
          context: Object.keys(appError.extra).length > 0 ? { problem: appError.extra } : null,
        }),
      ]);
    } catch (sendError) {
      // The request already fails. For commands, the durable attempt event stays as the
      // record, and the reconciler treats an attempt without an outcome as unresolved.
      deps.logger?.error('audit_failure_event_not_recorded', {
        operation: op.id,
        requestId,
        error: String(sendError),
      });
    }
    throw appError;
  };

  // 1. Authorize. Unauthenticated requests never reach this function (plan P3).
  let membership: Membership | null = null;
  if (op.scope === 'shop') {
    if (!shopId || !UUID_PATTERN.test(shopId)) return fail(shopNotFound());
    try {
      membership = await resolveMembership(deps.db, caller, shopId);
    } catch (error) {
      return fail(error);
    }
    if (!membership) return fail(shopNotFound());
  }
  const denied = authorize(op, caller, membership);
  if (denied) return fail(denied);

  // 2. Validate.
  const parsed = op.input.safeParse(req.input);
  if (!parsed.success) {
    return fail(
      errors.validation(
        parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => ({
          path: i.path.map(String).join('.'),
          message: i.message,
        })),
      ),
    );
  }
  const input = parsed.data;
  if (op.idempotency === 'required') {
    if (!idempotencyKey) {
      return fail(
        errors.validation([
          { path: 'Idempotency-Key', message: 'An idempotency key is required.' },
        ]),
      );
    }
    if (idempotencyKey.length > 200) {
      return fail(
        errors.validation([{ path: 'Idempotency-Key', message: 'At most 200 characters.' }]),
      );
    }
  }

  if (op.locations) locationIds = await locationsFromInput(op, input);

  // 3. Commands: the attempt is durable before anything executes (PRD 7.3).
  if (op.kind === 'command') {
    attemptId = uuidv7();
    try {
      await deps.audit.send([
        auditEvent(base(), {
          action: op.audit.action,
          phase: 'attempt',
          outcome: 'received',
          location_ids: locationIds,
        }),
      ]);
    } catch {
      throw errors.auditUnavailable();
    }
  }

  const requestHash =
    op.idempotency === 'required' ? await sha256Hex(canonicalJson({ op: op.id, input })) : null;
  const locationScope = membership && !membership.allLocations ? membership.locationScopeIds : null;
  const resolvedShopId = shopId;

  type TxOutcome =
    | { kind: 'done'; handled: HandlerResult<unknown>; webhookRows: number }
    | { kind: 'replay'; response: unknown };

  let outcome: TxOutcome;
  try {
    outcome = await deps.db.transaction(
      { shopId: resolvedShopId, userId: caller.userId, readOnly: op.kind === 'read' },
      async (tx) => {
        if (requestHash && idempotencyKey) {
          const replay = await claimIdempotencyKey(tx, caller, op.id, idempotencyKey, requestHash);
          if (replay) return { kind: 'replay', response: replay.response } as const;
        }
        if (op.locations) {
          const touched = await op.locations(input, tx);
          locationIds = [...new Set(touched)];
          await assertLocationsInScope(tx, touched, locationScope);
        }
        const ctx: HandlerContext = {
          tx,
          ...(deps.files ? { files: deps.files } : {}),
          shopId: resolvedShopId ?? '',
          caller,
          membership,
          requestId,
          attemptId,
          locationScope,
          newId: () => uuidv7(),
          ...(deps.media ? { media: deps.media } : {}),
          ...(deps.webhookSecrets ? { webhookSecrets: deps.webhookSecrets } : {}),
          event: (fields) => auditEvent(base(), { phase: 'outcome', ...fields }),
        };
        const handled = await op.handler(ctx, input);
        let webhookRows = 0;
        if (op.kind === 'command') {
          // Low stock and shortages, checked after the command's locks, committed with it (D12).
          await applyStockAlerts(ctx, handled);
          webhookRows = await finalizeCommand(
            tx,
            op,
            caller,
            idempotencyKey,
            handled,
            base(),
            locationIds,
          );
        }
        return { kind: 'done', handled, webhookRows } as const;
      },
    );
  } catch (error) {
    return fail(error);
  }

  if (outcome.kind === 'replay') {
    try {
      await deps.audit.send([
        auditEvent(base(), { action: op.audit.action, phase: 'outcome', outcome: 'replayed' }),
      ]);
    } catch {
      throw errors.auditUnavailable();
    }
    return {
      result: outcome.response,
      replayed: true,
      requestId,
      attemptId,
      shopId: resolvedShopId,
      outbox: 0,
    };
  }

  if (op.kind === 'read') {
    // No protected data leaves without a durable access record (PRD 7.3, A31).
    const { audit } = outcome.handled;
    try {
      await deps.audit.send([
        auditEvent(base(), {
          action: op.audit.action,
          phase: 'outcome',
          outcome: 'succeeded',
          target_type: audit.targetType,
          target_id: audit.targetId,
          location_ids: mergeLocations(audit.locationIds, locationIds),
          context: audit.context ?? { input },
        }),
        ...(outcome.handled.events ?? []),
      ]);
    } catch {
      throw errors.auditUnavailable();
    }
  }

  return {
    result: outcome.handled.result,
    replayed: false,
    requestId,
    attemptId,
    shopId: resolvedShopId,
    outbox: op.kind === 'command' ? (outcome.handled.outbox?.length ?? 0) + outcome.webhookRows : 0,
  };
}

function shopNotFound(): AppError {
  // Same answer whether the shop does not exist or the caller is not a member of it.
  return new AppError(404, 'not_found', 'Shop was not found.', 'denied');
}

/**
 * Resolves and authorizes a caller for a shop outside an operation: the media upload stream,
 * which runs before any transaction (ADR 0015). Same answers as the pipeline.
 */
export async function authorizeShopCaller(
  db: Database,
  caller: Caller,
  shopId: string,
  need: Pick<AnyOperation, 'permission' | 'connectionScope'>,
): Promise<Membership> {
  if (!UUID_PATTERN.test(shopId)) throw shopNotFound();
  const membership = await resolveMembership(db, caller, shopId);
  if (!membership) throw shopNotFound();
  const denied = authorize(need, caller, membership);
  if (denied) throw denied;
  return membership;
}

function authorize(
  op: Pick<AnyOperation, 'permission' | 'connectionScope'>,
  caller: Caller,
  membership: Membership | null,
): AppError | null {
  if (op.permission !== 'authenticated') {
    if (!membership || !effectivePermissions(membership).has(op.permission)) {
      return errors.forbidden(`Requires the ${op.permission} permission.`);
    }
  }
  if (op.connectionScope === 'session') {
    if (caller.scopes !== 'all')
      return errors.forbidden('Only an interactive session can do this.');
  } else if (caller.scopes !== 'all' && !caller.scopes.has(op.connectionScope)) {
    return errors.forbidden(`This connection was not granted the ${op.connectionScope} scope.`);
  }
  return null;
}

async function resolveMembership(
  db: Database,
  caller: Caller,
  shopId: string,
): Promise<Membership | null> {
  if (caller.boundShopId !== null) {
    return caller.boundShopId === shopId ? caller.membership : null;
  }
  if (!caller.userId) return null;
  const rows = await db.transaction({ shopId, userId: caller.userId, readOnly: true }, (tx) =>
    tx.query<{ id: string; role: string; all_locations: boolean; scope_ids: string[] }>(
      `select m.id, m.role, m.all_locations,
         coalesce(array(select s.scope_id from membership_location_scopes s
           where s.shop_id = m.shop_id and s.membership_id = m.id), '{}') as scope_ids
       from memberships m
       where m.shop_id = $1 and m.user_id = $2 and m.status = 'active'`,
      [shopId, caller.userId],
    ),
  );
  const row = rows[0];
  if (!row || !isRole(row.role)) return null;
  return {
    id: row.id,
    role: row.role,
    allLocations: row.all_locations,
    locationScopeIds: row.scope_ids,
  };
}

async function claimIdempotencyKey(
  tx: Tx,
  caller: Caller,
  operationId: string,
  key: string,
  requestHash: string,
): Promise<{ response: unknown } | null> {
  const claimed = await tx.query(
    `insert into idempotency_records (shop_id, caller_id, operation_id, key, request_hash)
     values (app_shop_id(), $1, $2, $3, $4)
     on conflict do nothing
     returning 1`,
    [callerKey(caller), operationId, key, requestHash],
  );
  if (claimed.length > 0) return null;
  // Another transaction already committed this key (a concurrent duplicate waits on the
  // unique index above until the first one commits or rolls back).
  const [existing] = await tx.query<{ request_hash: string; status: string; response: unknown }>(
    `select request_hash, status, response from idempotency_records
     where shop_id = app_shop_id() and caller_id = $1 and operation_id = $2 and key = $3`,
    [callerKey(caller), operationId, key],
  );
  if (!existing) throw errors.conflict('idempotency_retry', 'Retry the request.');
  if (existing.request_hash !== requestHash) {
    throw errors.unprocessable(
      'idempotency_key_reused',
      'This idempotency key was already used for a different request.',
    );
  }
  if (existing.status !== 'completed') {
    throw errors.conflict('idempotency_in_progress', 'The original request is still running.');
  }
  return { response: existing.response };
}

async function finalizeCommand(
  tx: Tx,
  op: AnyOperation,
  caller: Caller,
  idempotencyKey: string | null,
  handled: HandlerResult<unknown>,
  base: Parameters<typeof auditEvent>[0],
  touched: string[] | null,
): Promise<number> {
  const { audit } = handled;
  const success: AuditEvent = auditEvent(base, {
    action: op.audit.action,
    phase: 'outcome',
    outcome: audit.outcome ?? 'succeeded',
    target_type: audit.targetType,
    target_id: audit.targetId,
    operation_id: audit.operationId ?? null,
    location_ids: mergeLocations(audit.locationIds, touched),
    external_ref: audit.externalRef ?? null,
    reason: audit.reason ?? null,
    changes: audit.changes ?? null,
    context: audit.context ?? null,
  });
  const outbox = (handled.outbox ?? []).map((o) => ({ id: uuidv7(), ...o }));
  const events = [success, ...(handled.events ?? [])];
  // Webhook events: the handler's, plus catalog.item.changed derived from a catalog command's
  // events. Each becomes an outbox row only if the shop subscribes to its type (D14).
  const catalog = catalogChangeEmit(op.id, events);
  const webhooks = [...(handled.webhooks ?? []), ...(catalog ? [catalog] : [])].map((w) => ({
    id: uuidv7(),
    type: w.type,
    input: w.input,
  }));
  // One round trip: success event (plus any extra events), outbox rows, webhook events,
  // idempotency result.
  const [written] = await tx.query<{ webhooks: number }>(
    `with audit as (${INSERT_AUDIT_EVENTS_SQL}),
     outbox as (
       insert into outbox_events (shop_id, id, topic, payload)
       select app_shop_id(), x.id, x.topic, x.payload
       from jsonb_to_recordset($2::jsonb) as x(id uuid, topic text, payload jsonb)),
     webhooks as (${INSERT_WEBHOOK_OUTBOX_SQL.replace('$1::jsonb', '$8::jsonb')}),
     idem as (
       update idempotency_records
       set status = 'completed', response = $3::jsonb, completed_at = now(), result_operation_id = $4
       where shop_id = app_shop_id() and caller_id = $5 and operation_id = $6 and key = $7)
     select (select count(*) from webhooks)::int as webhooks`,
    [
      JSON.stringify(events),
      JSON.stringify(outbox),
      JSON.stringify(handled.result ?? null),
      audit.operationId ?? null,
      callerKey(caller),
      op.id,
      idempotencyKey,
      JSON.stringify(webhooks),
    ],
  );
  return written?.webhooks ?? 0;
}

/** The handler's locations and the hook's, or null when the operation names none. */
function mergeLocations(
  fromHandler: string[] | undefined,
  touched: string[] | null,
): string[] | null {
  const all = [...new Set([...(fromHandler ?? []), ...(touched ?? [])])];
  if (all.length > 0) return all.slice(0, 100);
  // A location-scoped operation that touched none (a reservation anywhere that found nothing)
  // is about no location: visible to everyone who may read history.
  return null;
}

class NeedsDatabase extends Error {}

/**
 * The `locations` hook evaluated before the transaction, for the attempt event: most hooks read
 * the input only. A hook that needs the database gives [] here (not known yet), and the outcome
 * event, written inside the transaction, carries the real locations.
 */
async function locationsFromInput(op: AnyOperation, input: unknown): Promise<string[]> {
  const offline = {
    query: () => {
      throw new NeedsDatabase();
    },
    statements: 0,
  } as unknown as Tx;
  try {
    const ids = await op.locations!(input, offline);
    return [...new Set(ids)].filter((id) => UUID_PATTERN.test(id));
  } catch {
    return [];
  }
}

async function assertLocationsInScope(
  tx: Tx,
  locationIds: string[],
  scope: string[] | null,
): Promise<void> {
  const ids = [...new Set(locationIds)];
  if (ids.length === 0) return;
  const rows = await tx.query<{ id: string; in_scope: boolean }>(
    `select id, ($2::uuid[] is null or path_ids && $2::uuid[]) as in_scope
     from locations where id = any($1::uuid[])`,
    [ids, scope],
  );
  if (rows.length !== ids.length) throw errors.notFound('Location');
  if (rows.some((r) => !r.in_scope)) {
    throw new AppError(
      403,
      'location_out_of_scope',
      'You do not have access to one or more of these locations.',
      'denied',
    );
  }
}

/** Network-level failures reaching the database (no SQLSTATE: the server never answered). */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

interface PgError {
  code?: string;
  constraint?: string;
}

function toAppError(error: unknown, logger: Logger | undefined, operation: string): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof CommitOutcomeUnknownError) return errors.outcomeUnknown();
  const pg = error as PgError;
  if (typeof pg?.code === 'string' && CONNECTION_ERROR_CODES.has(pg.code)) {
    logger?.error('database_unavailable', { operation, code: pg.code });
    return errors.serviceUnavailable();
  }
  if (pg?.code === '40001' || pg?.code === '40P01') {
    return errors.conflict('retry_conflict', 'A concurrent change interfered. Retry the request.');
  }
  if (pg?.code === '23505') {
    return errors.conflict('duplicate', 'A record with the same unique value already exists.', {
      constraint: pg.constraint,
    });
  }
  logger?.error('unexpected_error', { operation, error: String(error), code: pg?.code });
  return errors.internal();
}
