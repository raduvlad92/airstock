import type { Database, Tx } from '@airstock/db';
import { systemCaller } from '../accounts.ts';
import { type AuditBase, auditEvent, INSERT_AUDIT_EVENTS_SQL } from '../audit.ts';
import { type Caller, callerKey } from '../caller.ts';
import { AppError, errors } from '../errors.ts';
import { UUID_PATTERN, uuidv7 } from '../ids.ts';
import type { Logger } from '../pipeline.ts';
import { authorizeShopCaller } from '../pipeline.ts';
import {
  DERIVATIVE_TYPES,
  MEDIA_LIMITS,
  type MediaKind,
  type MediaType,
  UPLOAD_PARTS,
  type UploadPart,
} from './files.ts';

// The upload stream's checks before and after the bytes, and the sweep of uploads that were never
// finalized (plan Section 5.8, ADR 0015). The Worker streams the body to R2 between openUpload and
// recordUploadPart; nothing here holds a transaction open while bytes move.

export function objectKey(shopId: string, mediaId: string, part: UploadPart): string {
  return `shops/${shopId}/media/${mediaId}/${part}`;
}

export function objectKeys(shopId: string, mediaId: string): string[] {
  return UPLOAD_PARTS.map((part) => objectKey(shopId, mediaId, part));
}

/** Where a part of an intent is uploaded, under /api/v1. */
export function uploadPath(shopId: string, intentId: string, part: UploadPart): string {
  return `/shops/${shopId}/media/uploads/${intentId}/${part}`;
}

export const mediaUnavailable = () =>
  new AppError(503, 'media_unavailable', 'Media storage is not set up on this server.', 'failed');

/** A refused upload: the stream stops, its objects are deleted, and the intent fails. */
export const uploadRejected = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => errors.unprocessable(code, message, extra);

export interface OpenUpload {
  shopId: string;
  intentId: string;
  mediaId: string;
  kind: MediaKind;
  part: UploadPart;
  key: string;
  /** For the original: the declared type, size, and hash. */
  contentType: MediaType;
  fileName: string;
  declaredSize: number;
  sha256: string;
  /** Types this part may have, and its byte limit. */
  accept: readonly MediaType[];
  maxBytes: number;
  /** Longest side in pixels, for derivatives. */
  maxSide: number | null;
}

interface IntentRow {
  id: string;
  media_id: string;
  kind: MediaKind;
  file_name: string;
  content_type: MediaType;
  size_bytes: string;
  sha256: string;
  status: string;
  created_by: string;
  expired: boolean;
}

const UPLOAD_NEED = { permission: 'catalog.write', connectionScope: 'catalog:write' } as const;

/**
 * Authorizes the caller and checks the intent before any byte is accepted: it must exist in this
 * shop, belong to the caller, be pending, and not have expired.
 */
export async function openUpload(
  db: Database,
  caller: Caller,
  shopId: string,
  intentId: string,
  part: string,
): Promise<OpenUpload> {
  await authorizeShopCaller(db, caller, shopId, UPLOAD_NEED);
  if (!UUID_PATTERN.test(intentId)) throw errors.notFound('Upload');
  if (!(UPLOAD_PARTS as readonly string[]).includes(part)) throw errors.notFound('Upload part');
  const [intent] = await db.transaction({ shopId, userId: caller.userId, readOnly: true }, (tx) =>
    tx.query<IntentRow>(
      `select id, media_id, kind, file_name, content_type, size_bytes, sha256, status, created_by,
           expires_at <= now() as expired
         from media_upload_intents where id = $1`,
      [intentId],
    ),
  );
  // Another caller's intent answers like a missing one.
  if (!intent || intent.created_by !== callerKey(caller)) throw errors.notFound('Upload');
  checkIntentPending(intent);
  const p = part as UploadPart;
  if (intent.kind === 'document' && p !== 'original') {
    throw uploadRejected('no_derivatives', 'Documents have no thumbnail or display image.');
  }
  const derivative = p === 'original' ? null : MEDIA_LIMITS[p];
  return {
    shopId,
    intentId,
    mediaId: intent.media_id,
    kind: intent.kind,
    part: p,
    key: objectKey(shopId, intent.media_id, p),
    contentType: intent.content_type,
    fileName: intent.file_name,
    declaredSize: Number(intent.size_bytes),
    sha256: intent.sha256,
    accept: derivative ? DERIVATIVE_TYPES : [intent.content_type],
    maxBytes: derivative ? derivative.maxBytes : Number(intent.size_bytes),
    maxSide: derivative ? derivative.maxSide : null,
  };
}

export function checkIntentPending(intent: { status: string; expired: boolean }) {
  if (intent.status === 'finalized')
    throw errors.conflict('upload_finalized', 'This upload is already finished.');
  if (intent.status === 'failed')
    throw errors.conflict('upload_failed', 'This upload failed. Start a new one.');
  if (intent.status === 'expired' || intent.expired)
    throw errors.conflict('upload_expired', 'This upload expired. Start a new one.');
}

export interface UploadedPart {
  size: number;
  sha256: string;
  contentType: MediaType;
  width: number | null;
  height: number | null;
}

function base(shopId: string, caller: Caller, requestId: string): AuditBase {
  return { shopId, caller, requestId, attemptId: null, idempotencyKey: null };
}

/**
 * Records a part whose bytes are stored and checked. Fails with `upload_expired` (or another
 * state) when the intent stopped being pending meanwhile; the caller then deletes the object.
 */
export async function recordUploadPart(
  db: Database,
  caller: Caller,
  upload: OpenUpload,
  part: UploadedPart,
  requestId: string,
): Promise<void> {
  await db.transaction({ shopId: upload.shopId, userId: caller.userId }, async (tx) => {
    const [row] = await tx.query<{ id: string }>(
      `update media_upload_intents set parts = parts || jsonb_build_object($2::text, $3::jsonb)
       where id = $1 and status = 'pending' and expires_at > now() and created_by = $4
       returning id`,
      [upload.intentId, upload.part, JSON.stringify(part), callerKey(caller)],
    );
    if (!row) {
      const [now] = await tx.query<{ status: string; expired: boolean }>(
        'select status, expires_at <= now() as expired from media_upload_intents where id = $1',
        [upload.intentId],
      );
      checkIntentPending(now ?? { status: 'expired', expired: true });
      throw errors.notFound('Upload');
    }
    const event = auditEvent(base(upload.shopId, caller, requestId), {
      action: 'catalog.media.part_uploaded',
      phase: 'outcome',
      outcome: 'succeeded',
      target_type: 'media_upload',
      target_id: upload.intentId,
      changes: { part: upload.part, ...part },
      context: { mediaId: upload.mediaId },
    });
    await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify([event])]);
  });
}

/**
 * Marks the intent failed and records why, in one transaction; returns the object keys to delete.
 * A failed intent is never finalized, so no attachment results (PRD 4.5).
 */
export async function failUpload(
  db: Database,
  caller: Caller,
  upload: Pick<OpenUpload, 'shopId' | 'intentId' | 'mediaId' | 'part'>,
  error: AppError,
  requestId: string,
): Promise<string[]> {
  await db.transaction({ shopId: upload.shopId, userId: caller.userId }, async (tx) => {
    await tx.query(
      `update media_upload_intents set status = 'failed', failure_code = $2
       where id = $1 and status = 'pending'`,
      [upload.intentId, error.code],
    );
    const event = auditEvent(base(upload.shopId, caller, requestId), {
      action: 'catalog.media.upload_failed',
      phase: 'outcome',
      outcome: 'failed',
      target_type: 'media_upload',
      target_id: upload.intentId,
      context: { mediaId: upload.mediaId, part: upload.part },
      error: { code: error.code, status: error.status, detail: error.message },
    });
    await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify([event])]);
  });
  return objectKeys(upload.shopId, upload.mediaId);
}

/** Records that a failed or expired intent's objects are gone. */
export async function markUploadsCleaned(
  db: Database,
  shopId: string,
  intentIds: string[],
): Promise<void> {
  if (intentIds.length === 0) return;
  await db.transaction({ shopId, userId: null }, (tx) =>
    tx.query(
      `update media_upload_intents set cleaned_at = now()
       where id = any($1::uuid[]) and status in ('failed', 'expired')`,
      [intentIds],
    ),
  );
}

/**
 * Expires uploads that were never finalized and deletes the objects of expired and failed ones,
 * shop by shop (cron). Deleting happens after the intent is no longer pending, so a finalize can
 * never race it; a deletion that fails is retried by the next sweep.
 */
export async function sweepMediaUploads(
  db: Database,
  deleteObjects: (keys: string[]) => Promise<void>,
  options: { maxShops?: number; logger?: Logger } = {},
): Promise<{ expired: number; cleaned: number }> {
  const shops = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query<{ shop_id: string }>('select s as shop_id from shops_with_stale_media_uploads($1) s', [
      options.maxShops ?? 50,
    ]),
  );
  const total = { expired: 0, cleaned: 0 };
  for (const { shop_id: shopId } of shops) {
    try {
      const stale = await db.transaction({ shopId, userId: null }, (tx) =>
        expireAndCollect(tx, shopId),
      );
      total.expired += stale.expired;
      const keys = stale.cleanup.flatMap((i) => objectKeys(shopId, i.media_id));
      if (keys.length > 0) await deleteObjects(keys);
      await markUploadsCleaned(
        db,
        shopId,
        stale.cleanup.map((i) => i.id),
      );
      total.cleaned += stale.cleanup.length;
    } catch (error) {
      options.logger?.error('media_sweep_failed', { shopId, error: String(error) });
    }
  }
  return total;
}

async function expireAndCollect(tx: Tx, shopId: string) {
  const expired = await tx.query<{ id: string; media_id: string; parts: Record<string, unknown> }>(
    `update media_upload_intents set status = 'expired'
     where status = 'pending' and expires_at <= now()
     returning id, media_id, parts`,
  );
  if (expired.length > 0) {
    const b = base(shopId, systemCaller('media-upload-expiry', shopId), uuidv7());
    const events = expired.map((i) =>
      auditEvent(b, {
        action: 'catalog.media.upload_expired',
        phase: 'outcome',
        outcome: 'succeeded',
        target_type: 'media_upload',
        target_id: i.id,
        reason: 'The upload was not finished within 15 minutes.',
        changes: { status: 'expired', partsUploaded: Object.keys(i.parts) },
        context: { mediaId: i.media_id, trigger: 'sweeper' },
      }),
    );
    await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify(events)]);
  }
  const cleanup = await tx.query<{ id: string; media_id: string }>(
    `select id, media_id from media_upload_intents
     where status in ('failed', 'expired') and cleaned_at is null
     order by id limit 300`,
  );
  return { expired: expired.length, cleanup };
}
