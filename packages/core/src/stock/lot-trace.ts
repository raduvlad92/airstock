// The lot trace as a CSV file (plan Section 5.7, G6): every movement of one lot, from the supplier
// and purchase order of each receipt to every order, transfer, return, and disposal, written by
// the export job with the reader's location scope, as when they read the trace.

import type { Database, Tx } from '@airstock/db';
import { type AuditSink, auditEvent } from '../audit.ts';
import type { Caller } from '../caller.ts';
import { csvLine } from '../csv.ts';
import { AppError, errors } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import { effectivePermissions } from '../permissions.ts';
import type { FileAccess } from '../registry.ts';
import { insertWebhookEvents, webhookEvent } from '../webhooks/events.ts';
import { normalizeCode } from './engine.ts';

export interface TracedLot {
  lotId: string;
  variantId: string;
  sku: string;
  code: string;
  expiresOn: string | null;
  producedOn: string | null;
  supplierId: string | null;
  supplierName: string | null;
  purchaseOrderRef: string | null;
}

/** The lot named by lotId, or by variantId and lotCode; throws not_found. */
export async function findLot(
  tx: Tx,
  input: {
    lotId?: string | undefined;
    variantId?: string | undefined;
    lotCode?: string | undefined;
  },
): Promise<TracedLot> {
  if (!input.lotId && !(input.variantId && input.lotCode)) {
    throw errors.validation([{ path: 'lotId', message: 'Give lotId, or variantId and lotCode.' }]);
  }
  const [lot] = await tx.query<TracedLot>(
    `select lt.id as "lotId", lt.variant_id as "variantId", v.sku, lt.code,
       to_char(lt.expires_on, 'YYYY-MM-DD') as "expiresOn",
       to_char(lt.produced_on, 'YYYY-MM-DD') as "producedOn", lt.supplier_id as "supplierId",
       s.name as "supplierName", lt.purchase_order_ref as "purchaseOrderRef"
     from lots lt join variants v on v.shop_id = lt.shop_id and v.id = lt.variant_id
     left join suppliers s on s.shop_id = lt.shop_id and s.id = lt.supplier_id
     where ($1::uuid is null or lt.id = $1)
       and ($2::uuid is null or (lt.variant_id = $2 and lt.code_normalized = $3))`,
    [
      input.lotId ?? null,
      input.lotId ? null : (input.variantId ?? null),
      input.lotCode ? normalizeCode(input.lotCode) : null,
    ],
  );
  if (!lot) throw errors.notFound('Lot');
  return lot;
}

/** At most this many movements per file; the last line says when it stopped there. */
export const LOT_TRACE_EXPORT_LIMIT = 100_000;

export const LOT_TRACE_HEADER = [
  'occurred_at',
  'lot',
  'sku',
  'expires_on',
  'movement',
  'quantity',
  'location',
  'condition',
  'order',
  'reservation_id',
  'reference',
  'purchase_order',
  'supplier',
  'actor_type',
  'source',
  'operation_id',
];

interface MovementRow {
  occurred_at: string;
  kind: string;
  quantity: string;
  location_path: string;
  condition: string;
  order_ref: string | null;
  reservation_id: string | null;
  reference: string | null;
  purchase_order: string | null;
  supplier: string | null;
  actor_type: string;
  source: string;
  operation_id: string;
}

/**
 * Every movement of the lot at locations in `scope` (null: all), oldest first, as in the trace
 * read. A receipt against a purchase order names the order, and its supplier comes from the
 * receipt (or the order).
 */
async function lotMovements(
  tx: Tx,
  lotId: string,
  scope: string[] | null,
  limit: number,
): Promise<MovementRow[]> {
  return tx.query<MovementRow>(
    `select to_char(o.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at,
       o.kind, e.delta::text as quantity, l.path as location_path, p.condition,
       coalesce(r.external_ref, rp.external_ref) as order_ref, e.reservation_id,
       o.external_ref as reference,
       case when po.number is null then null else 'PO-' || lpad(po.number::text, 4, '0') end
         as purchase_order,
       coalesce(s.name, pos.name) as supplier, o.actor_type, o.source, o.id as operation_id
     from inventory_entries e
     join inventory_operations o on o.shop_id = e.shop_id and o.id = e.operation_id
     join inventory_positions p on p.shop_id = e.shop_id and p.id = e.position_id
     join locations l on l.shop_id = e.shop_id and l.id = e.location_id
     left join reservations r on r.shop_id = e.shop_id and r.id = e.reservation_id
     left join reservations rp on rp.shop_id = r.shop_id and rp.id = r.parent_id
     left join suppliers s on s.shop_id = o.shop_id and s.id = o.supplier_id
     left join lateral (
       select pr.purchase_order_id from purchase_order_receipts pr
       where pr.shop_id = o.shop_id and pr.operation_id = o.id limit 1) pr on true
     left join purchase_orders po on po.shop_id = o.shop_id and po.id = pr.purchase_order_id
     left join suppliers pos on pos.shop_id = po.shop_id and pos.id = po.supplier_id
     where e.lot_id = $1 and ($2::uuid[] is null or l.path_ids && $2::uuid[])
     order by o.occurred_at, e.id
     limit $3`,
    [lotId, scope, limit],
  );
}

export interface LotTraceQuery {
  mode: 'lot_trace';
  lotId: string;
  /** For the file name and the list of exports. */
  lotCode: string;
  sku: string;
}

/**
 * Writes the lot trace file and completes the export row, as the member who started it (their
 * location scope now). Returns the number of movements written.
 */
export async function runLotTraceExport(
  deps: { db: Database; audit: AuditSink; files: FileAccess },
  shopId: string,
  exportId: string,
  fileKey: string,
  caller: Caller,
  query: LotTraceQuery,
): Promise<number> {
  const membership = caller.membership!;
  if (!effectivePermissions(membership).has('inventory.read')) {
    throw new AppError(
      403,
      'forbidden',
      'The member who started this export can no longer read stock.',
      'denied',
    );
  }
  const scope = membership.allLocations ? null : membership.locationScopeIds;
  const { lot, rows } = await deps.db.transaction(
    { shopId, userId: caller.userId, readOnly: true },
    async (tx) => {
      const lot = await findLot(tx, { lotId: query.lotId });
      return { lot, rows: await lotMovements(tx, lot.lotId, scope, LOT_TRACE_EXPORT_LIMIT + 1) };
    },
  );
  const truncated = rows.length > LOT_TRACE_EXPORT_LIMIT;
  const written = rows.slice(0, LOT_TRACE_EXPORT_LIMIT);
  const lines = [csvLine(LOT_TRACE_HEADER)];
  for (const r of written) {
    lines.push(
      csvLine([
        r.occurred_at,
        lot.code,
        lot.sku,
        lot.expiresOn,
        r.kind,
        r.quantity,
        r.location_path,
        r.condition,
        r.order_ref,
        r.reservation_id,
        r.reference,
        r.purchase_order,
        r.supplier,
        r.actor_type,
        r.source,
        r.operation_id,
      ]),
    );
  }
  if (truncated) {
    lines.push(csvLine([`Stopped after ${LOT_TRACE_EXPORT_LIMIT} movements.`]));
  }
  // Byte-order mark: spreadsheets then read the file as UTF-8.
  await deps.files.put(fileKey, `﻿${lines.join('\r\n')}\r\n`, 'text/csv; charset=utf-8');
  await deps.db.transaction({ shopId, userId: null }, async (tx) => {
    await tx.query(
      `update export_jobs set status = 'completed', file_key = $2, row_count = $3, completed_at = now(),
         download_until = now() + interval '24 hours', delete_after = now() + interval '7 days' where id = $1`,
      [exportId, fileKey, written.length],
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
        action: 'inventory.lot_trace_export.completed',
        phase: 'outcome',
        outcome: 'succeeded',
        target_type: 'export',
        target_id: exportId,
        changes: { rows: written.length, truncated },
        context: { lotId: lot.lotId, lotCode: lot.code, sku: lot.sku, partial: scope !== null },
      },
    ),
  ]);
  return written.length;
}
