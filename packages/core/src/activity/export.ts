// The activity export (plan Section 5.15): the timeline with the list's filters, written as CSV by
// the export job, with the reader's location scope and field visibility as when they search.

import type { Database } from '@airstock/db';
import type { AuditSink } from '../audit.ts';
import { auditEvent } from '../audit.ts';
import type { Caller } from '../caller.ts';
import { csvLine } from '../csv.ts';
import { AppError } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import { effectivePermissions } from '../permissions.ts';
import type { FileAccess } from '../registry.ts';
import { insertWebhookEvents, webhookEvent } from '../webhooks/events.ts';
import { type ActivityFiltersInput, type ActivityRow, activityQuery } from './query.ts';
import { redactEventChanges } from './redact.ts';

/** At most this many events per file; narrow the filters (a date range) for more. */
export const ACTIVITY_EXPORT_LIMIT = 50_000;
const PAGE = 2_000;

const HEADER = [
  'occurred_at',
  'event_id',
  'action',
  'phase',
  'outcome',
  'source',
  'actor_type',
  'actor_id',
  'client_id',
  'target_type',
  'target_id',
  'attempt_id',
  'operation_id',
  'location_ids',
  'external_ref',
  'reason',
  'changes',
  'error',
];

const json = (value: unknown) =>
  value === null || value === undefined ? '' : JSON.stringify(value);

/** Writes the file and completes the export row; returns the number of events. */
export async function runActivityExport(
  deps: { db: Database; audit: AuditSink; files: FileAccess },
  shopId: string,
  exportId: string,
  fileKey: string,
  caller: Caller,
  filters: ActivityFiltersInput,
): Promise<number> {
  const membership = caller.membership!;
  if (!effectivePermissions(membership).has('activity.read')) {
    throw new AppError(
      403,
      'forbidden',
      'The member who started this export can no longer read the activity history.',
      'denied',
    );
  }
  const scope = membership.allLocations ? null : membership.locationScopeIds;
  const lines = [csvLine(HEADER)];
  let cursor: [string, string] | null = null;
  let count = 0;
  while (count < ACTIVITY_EXPORT_LIMIT) {
    const { sql, params } = activityQuery({
      filters,
      scope,
      limit: Math.min(PAGE, ACTIVITY_EXPORT_LIMIT - count),
      cursor,
    });
    const rows = await deps.db.transaction(
      { shopId, userId: caller.userId, readOnly: true },
      (tx) => tx.query<ActivityRow>(sql, params),
    );
    for (const r of rows) {
      lines.push(
        csvLine([
          new Date(r.occurred_at).toISOString(),
          r.event_id,
          r.action,
          r.phase,
          r.outcome,
          r.source,
          r.actor_type,
          r.actor_id,
          r.client_id,
          r.target_type,
          r.target_id,
          r.attempt_id,
          r.operation_id,
          (r.location_ids ?? []).join(' '),
          r.external_ref,
          r.reason,
          json(redactEventChanges(r.target_type, r.changes, membership)),
          json(r.error),
        ]),
      );
    }
    count += rows.length;
    const last = rows.at(-1);
    if (rows.length < PAGE || !last) break;
    cursor = [new Date(last.occurred_at).toISOString(), last.event_id];
  }
  // Byte-order mark: spreadsheets then read the file as UTF-8.
  await deps.files.put(fileKey, `﻿${lines.join('\r\n')}\r\n`, 'text/csv; charset=utf-8');
  await deps.db.transaction({ shopId, userId: null }, async (tx) => {
    await tx.query(
      `update export_jobs set status = 'completed', file_key = $2, row_count = $3, completed_at = now(),
         download_until = now() + interval '24 hours', delete_after = now() + interval '7 days' where id = $1`,
      [exportId, fileKey, count],
    );
    await insertWebhookEvents(
      tx,
      [webhookEvent('job.completed', { kind: 'export', id: exportId })],
      uuidv7,
    );
  });
  await deps.audit.send([
    auditEvent(
      { shopId, caller, requestId: uuidv7(), attemptId: null, idempotencyKey: null },
      {
        action: 'activity.export.completed',
        phase: 'outcome',
        outcome: 'succeeded',
        target_type: 'export',
        target_id: exportId,
        changes: { rows: count, truncated: count >= ACTIVITY_EXPORT_LIMIT },
      },
    ),
  ]);
  return count;
}
