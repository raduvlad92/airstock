import type { ops } from '@airstock/core';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError, command, errorMessage, type Out } from '../api.ts';
import { ErrorNotice } from '../components/ui.tsx';
import type { BulkEdit } from './grid.tsx';
import type { CatalogSchema } from './schema.ts';

type Preview = Out<typeof ops.previewBulkEdit>;

function show(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('amount' in v) return String(v.amount);
    if ('value' in v && 'unit' in v) return `${v.value} ${v.unit}`;
    if ('inherit' in v) return 'inherited';
    if (Array.isArray(value)) return value.join(', ');
  }
  return String(value);
}

/**
 * Bulk edit (D4): every multi-record change is previewed and confirmed. If anything changed
 * before the commit, the preview is made again and shown instead (A17).
 */
export function BulkDialog({
  shopId,
  edits,
  schema,
  onClose,
  onCommitted,
}: {
  shopId: string;
  edits: BulkEdit[];
  schema: CatalogSchema | undefined;
  onClose(): void;
  onCommitted(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [stale, setStale] = useState(false);
  const labels = new Map(edits.map((e) => [`${e.variantId ?? e.productId}:${e.field}`, e.label]));
  const fieldLabel = (key: string) => schema?.fields.find((f) => f.key === key)?.label ?? key;

  const make = useMutation({
    mutationFn: () =>
      command<Preview>(`/shops/${shopId}/bulk-edits`, {
        edits: edits.map(({ label: _label, ...e }) => e),
      }),
    onSuccess: setPreview,
  });
  const commit = useMutation({
    mutationFn: () => command(`/shops/${shopId}/bulk-edits/${preview!.previewId}/commit`, {}),
    onSuccess: onCommitted,
    onError: (error) => {
      if (
        error instanceof ApiError &&
        (error.code === 'preview_stale' || error.code === 'preview_expired')
      ) {
        setStale(true);
        make.mutate();
      }
    },
  });

  useEffect(() => {
    dialog.current?.showModal();
    make.mutate();
  }, []);

  return (
    <dialog ref={dialog} className="dialog wide" onClose={onClose} aria-labelledby="bulk-title">
      <h2 id="bulk-title">Review {edits.length} changes</h2>
      {stale ? (
        <p className="notice">
          Some records changed since the first preview. These are the current values; check them
          again.
        </p>
      ) : null}
      {make.isPending ? <p className="muted">Checking every change…</p> : null}
      <ErrorNotice error={make.error} />
      {preview ? (
        <>
          {preview.errors.length > 0 ? (
            <div className="notice error">
              Nothing can be saved until these are fixed:
              <ul>
                {preview.errors.map((e) => (
                  <li key={e.productId}>
                    {e.message}{' '}
                    {errorMessage(
                      new ApiError(400, e.code, '', (e.details ?? {}) as Record<string, unknown>),
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="table-wrap bulk-lines">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Field</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((l) => (
                  <tr key={`${l.variantId ?? l.productId}:${l.field}`}>
                    <td>
                      {labels.get(`${l.variantId ?? l.productId}:${l.field}`) ??
                        l.productId.slice(-6)}
                    </td>
                    <td>{fieldLabel(l.field)}</td>
                    <td className="muted">{show(l.before)}</td>
                    <td>{show(l.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <ErrorNotice
        error={
          commit.error &&
          !(commit.error instanceof ApiError && commit.error.code === 'preview_stale')
            ? commit.error
            : null
        }
      />
      <div className="dialog-actions">
        <button type="button" className="ghost" onClick={() => dialog.current?.close()}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!preview?.previewId || commit.isPending || make.isPending}
          onClick={() => commit.mutate()}
        >
          {commit.isPending
            ? 'Saving…'
            : `Apply ${preview?.records ?? ''} ${preview?.records === 1 ? 'record' : 'records'}`}
        </button>
      </div>
    </dialog>
  );
}
