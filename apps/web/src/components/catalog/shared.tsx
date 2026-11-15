import type { ops } from '@airstock/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type Out } from '../../api.ts';
import { formatDecimal } from '../ui.tsx';

/** Props every catalog editor takes (plan N5): the variant it edits, in its product. */
export interface EditorProps {
  shopId: string;
  productId?: string;
  variantId: string;
  canWrite?: boolean;
}

export type Packaging = Out<typeof ops.getPackaging>;

export const packagingKey = (shopId: string, variantId: string) =>
  ['shop', shopId, 'packaging', variantId] as const;

/** Packs, barcodes, shipping packages, and the bundle of one variant, with their list versions. */
export function usePackaging(shopId: string, variantId: string, enabled = true) {
  return useQuery({
    queryKey: packagingKey(shopId, variantId),
    queryFn: () => api<Packaging>(`/shops/${shopId}/variants/${variantId}/packaging`),
    enabled,
  });
}

/** After a save: the answer is the new packaging; labels and bundles that use it are stale. */
export function usePackagingSaved(shopId: string, variantId: string) {
  const queryClient = useQueryClient();
  return (packaging: Packaging) => {
    queryClient.setQueryData(packagingKey(shopId, variantId), packaging);
    void queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'bundle-availability'] });
    void queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'supplier-items'] });
  };
}

export const isVersionConflict = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status === 409 && error.code === 'version_conflict';

/** A stale edit, said plainly: someone saved first, and nothing of yours was written. */
export function ConflictNotice({ what, onReload }: { what: string; onReload(): void }) {
  return (
    <div className="notice error conflict-notice" role="alert">
      <span>
        Someone else changed the {what} after you started editing, so your changes were not saved.
        Reload to see their version, then make your change again.
      </span>
      <button type="button" className="small" onClick={onReload}>
        Reload
      </button>
    </div>
  );
}

type Measure = { value?: string; unit?: string } | null;
type Box = { length?: string; width?: string; height?: string; unit?: string } | null;

/** "4.5 kg": what the API reads back as a weight. */
export function weightText(value: unknown): string {
  const w = value as Measure;
  return w?.value !== undefined ? `${formatDecimal(w.value)} ${w.unit ?? ''}`.trim() : '';
}

/** "40 x 30 x 20 cm": what the API reads back as dimensions. */
export function dimensionsText(value: unknown): string {
  const d = value as Box;
  return d?.length !== undefined
    ? `${formatDecimal(d.length)} x ${formatDecimal(d.width)} x ${formatDecimal(d.height)} ${d.unit ?? ''}`.trim()
    : '';
}

/** How a base unit reads in a sentence: the default unit "each" counts items. */
export const unitName = (unit: string | undefined) => (!unit || unit === 'each' ? 'items' : unit);

/** One base unit, as a choice beside packs: "Single item", or "One kg". */
export const oneUnit = (unit: string | undefined) =>
  !unit || unit === 'each' ? 'Single item' : `One ${unit}`;

/** A decimal string above zero, checked as text (quantities never go through floats). */
export const isPositiveDecimal = (text: string) =>
  /^\d+(\.\d+)?$/.test(text.trim()) && /[1-9]/.test(text);

/** A new row's key until the server gives it an ID. */
export const tempKey = () => `new-${crypto.randomUUID()}`;
