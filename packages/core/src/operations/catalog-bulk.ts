import { z } from 'zod';
import { callerKey } from '../caller.ts';
import { AppError, errors } from '../errors.ts';
import { defineOperation } from '../registry.ts';
import { Id, iso } from '../schemas.ts';
import { applyChanges, type Change, persistWrites, recordEvent } from './catalog-items.ts';

// Bulk edits (plan Section 5.11, decision D4, ADR 0017): a paste, a fill, or any multi-record
// change from MCP is previewed first. The preview stores the values the records had; commit
// applies everything or nothing, and is rejected if any of those values changed since (A17).

export const BULK_RECORD_LIMIT = 500;
const PREVIEW_MINUTES = 15;

const EditInput = z.object({
  productId: Id,
  variantId: Id.optional().describe('Leave out to change the product itself.'),
  field: z
    .string()
    .min(1)
    .max(100)
    .describe('A built-in field or a custom field key, as in update.'),
  value: z.unknown().optional().describe('The new value; null clears it.'),
  inherit: z.boolean().optional().describe('Variants only: inherit the product’s value again.'),
});

const PreviewLine = z.object({
  productId: Id,
  variantId: Id.nullable(),
  field: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});

interface StoredGroup {
  productId: string;
  changes: Change[];
}

export const previewBulkEdit = defineOperation({
  id: 'catalog.bulk.preview',
  summary: 'Preview a change to many products or variants',
  description: `Validates up to ${BULK_RECORD_LIMIT} records' changes without saving them and returns each value before and after. If everything is valid you get a previewId, valid for ${PREVIEW_MINUTES} minutes; show the preview, then commit it with bulk_commit.`,
  kind: 'command',
  scope: 'shop',
  input: z.object({ edits: z.array(EditInput).min(1).max(5000) }),
  output: z.object({
    previewId: Id.nullable().describe(
      'Null when some changes are invalid; fix them and preview again.',
    ),
    expiresAt: z.string().nullable(),
    records: z.number(),
    lines: z.array(PreviewLine),
    errors: z.array(
      z.object({ productId: Id, code: z.string(), message: z.string(), details: z.unknown() }),
    ),
  }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.bulk.previewed' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/bulk-edits' },
  mcp: { tool: 'edit_catalog', action: 'bulk_preview', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const records = new Set(input.edits.map((e) => e.variantId ?? e.productId));
    if (records.size > BULK_RECORD_LIMIT) {
      throw errors.unprocessable(
        'too_many_records',
        `A bulk edit covers at most ${BULK_RECORD_LIMIT} records. Use an import for bigger changes.`,
      );
    }
    const groups = new Map<string, Change[]>();
    for (const e of input.edits) {
      const list = groups.get(e.productId) ?? [];
      list.push({
        ...(e.variantId ? { variantId: e.variantId } : {}),
        field: e.field,
        expected: null,
        ...(e.value !== undefined ? { value: e.value } : {}),
        ...(e.inherit ? { inherit: true } : {}),
      });
      groups.set(e.productId, list);
    }
    const lines: z.infer<typeof PreviewLine>[] = [];
    const problems: Array<{ productId: string; code: string; message: string; details: unknown }> =
      [];
    const stored: StoredGroup[] = [];
    // Product IDs in order, so concurrent previews lock rows in the same order.
    for (const productId of [...groups.keys()].sort()) {
      const changes = groups.get(productId)!;
      try {
        const { result } = await applyChanges(ctx, productId, changes, { expectCurrent: true });
        const withExpected: Change[] = [];
        for (const change of changes) {
          const recordId = change.variantId ?? productId;
          const write = result.writes.find((w) => w.id === recordId);
          const entry = write
            ? Object.entries(write.log).find(([key]) => sameField(key, change.field))
            : undefined;
          const before = entry ? entry[1].from : null;
          const after = entry ? entry[1].to : null;
          lines.push({
            productId,
            variantId: change.variantId ?? null,
            field: entry?.[0] ?? change.field,
            before,
            after,
          });
          withExpected.push({ ...change, expected: before });
        }
        stored.push({ productId, changes: withExpected });
      } catch (error) {
        if (!(error instanceof AppError) || error.status >= 500) throw error;
        problems.push({
          productId,
          code: error.code,
          message: error.message,
          details: error.extra,
        });
      }
    }
    if (problems.length > 0) {
      return {
        result: {
          previewId: null,
          expiresAt: null,
          records: records.size,
          lines,
          errors: problems,
        },
        audit: {
          targetType: 'bulk_preview',
          targetId: 'invalid',
          outcome: 'no_change' as const,
          context: { records: records.size, errors: problems.length },
        },
      };
    }
    const previewId = ctx.newId();
    const [row] = await ctx.tx.query<{ expires_at: Date }>(
      `insert into bulk_previews (shop_id, id, caller_id, changes, record_count, expires_at)
       values (app_shop_id(), $1, $2, $3, $4, now() + make_interval(mins => $5))
       returning expires_at`,
      [previewId, callerKey(ctx.caller), JSON.stringify(stored), records.size, PREVIEW_MINUTES],
    );
    return {
      result: {
        previewId,
        expiresAt: iso(row!.expires_at),
        records: records.size,
        lines,
        errors: [],
      },
      audit: {
        targetType: 'bulk_preview',
        targetId: previewId,
        context: { records: records.size, products: stored.length, lines: lines.length },
      },
    };
  },
});

/** A change names a field by key, ID, or built-in name; the log uses the key. */
function sameField(logKey: string, requested: string): boolean {
  return logKey === requested || logKey.toLowerCase() === requested.toLowerCase();
}

export const commitBulkEdit = defineOperation({
  id: 'catalog.bulk.commit',
  summary: 'Commit a bulk edit preview',
  description:
    'Applies every change in the preview, or none. If any record changed since the preview, the commit fails with preview_stale: preview again and show the new result before committing.',
  kind: 'command',
  scope: 'shop',
  input: z.object({ previewId: Id }),
  output: z.object({
    records: z.array(
      z.object({ type: z.enum(['product', 'variant']), id: Id, version: z.number() }),
    ),
  }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'catalog.bulk.committed' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/bulk-edits/{previewId}/commit' },
  mcp: { tool: 'edit_catalog', action: 'bulk_commit', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const [preview] = await ctx.tx.query<{
      caller_id: string;
      status: string;
      changes: StoredGroup[];
      expired: boolean;
      record_count: number;
    }>(
      `select caller_id, status, changes, expires_at <= now() as expired, record_count
       from bulk_previews where id = $1 for update`,
      [input.previewId],
    );
    if (!preview || preview.caller_id !== callerKey(ctx.caller))
      throw errors.notFound('Bulk edit preview');
    if (preview.status !== 'open') {
      throw errors.conflict(
        'preview_closed',
        'This preview was already committed. Preview again to make more changes.',
      );
    }
    if (preview.expired)
      throw errors.conflict('preview_expired', 'This preview expired. Preview the changes again.');
    const records: Array<{ type: 'product' | 'variant'; id: string; version: number }> = [];
    const events = [];
    for (const group of preview.changes) {
      try {
        const { result, loaded } = await applyChanges(ctx, group.productId, group.changes);
        const written = await persistWrites(ctx, loaded, result);
        for (const w of written) {
          records.push({ type: w.type, id: w.id, version: w.version });
          events.push(recordEvent(ctx, w, result.definitionVersions));
        }
      } catch (error) {
        if (error instanceof AppError && (error.code === 'edit_conflict' || error.status === 404)) {
          throw errors.conflict(
            'preview_stale',
            'Some records changed since the preview, so nothing was saved. Preview again and check the new values.',
            { productId: group.productId, ...(error.code === 'edit_conflict' ? error.extra : {}) },
          );
        }
        throw error;
      }
    }
    await ctx.tx.query(
      `update bulk_previews set status = 'committed', committed_at = now() where id = $1`,
      [input.previewId],
    );
    return {
      result: { records },
      audit: {
        targetType: 'bulk_preview',
        targetId: input.previewId,
        changes: { records: records.length, products: preview.changes.length },
      },
      events,
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const catalogBulkOperations = [previewBulkEdit, commitBulkEdit] as const;
