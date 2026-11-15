import {
  BARCODE_LIMITS,
  checkBarcode,
  GENERATED_SYMBOLOGIES,
  type GeneratedSymbology,
  SYMBOLOGIES,
  SYMBOLOGY_LABELS,
  type Symbology,
} from '@airstock/core/barcodes';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError, command } from '../../api.ts';
import { Badge, ErrorNotice, Field, Loading } from '../ui.tsx';
import {
  ConflictNotice,
  type EditorProps,
  isVersionConflict,
  oneUnit,
  type Packaging,
  tempKey,
  usePackaging,
  usePackagingSaved,
} from './shared.tsx';

interface BarcodeDraft {
  key: string;
  code: string;
  symbology: Symbology;
  /** '' for the variant itself. */
  packId: string;
}

interface Owner {
  productId: string;
  productName: string;
  sku: string;
  packName: string | null;
}

/** "Already used by …" with a link to the record that holds the code. */
function DuplicateNotice({ shopId, error }: { shopId: string; error: ApiError }) {
  const owner = error.problem.existing as Owner | undefined;
  if (!owner) return <ErrorNotice error={error} />;
  return (
    <p className="notice error" role="alert">
      This barcode already belongs to{' '}
      <Link to="/shops/$shopId/products" params={{ shopId }} search={{ item: owner.productId }}>
        {owner.productName}
      </Link>{' '}
      ({owner.sku}
      {owner.packName ? `, ${owner.packName}` : ''}). A code can belong to one record only.
    </p>
  );
}

/** Barcodes of a variant and its packs (plan 5.4), with "Generate" for internal codes. */
export function BarcodesEditor({ shopId, variantId, canWrite = true }: EditorProps) {
  const packaging = usePackaging(shopId, variantId);
  const saved = usePackagingSaved(shopId, variantId);
  const [draft, setDraft] = useState<{ version: number; rows: BarcodeDraft[] } | null>(null);
  const [generate, setGenerate] = useState<{ symbology: GeneratedSymbology; packId: string }>({
    symbology: 'code128',
    packId: '',
  });
  const save = useMutation({
    mutationFn: (d: { version: number; rows: BarcodeDraft[] }) =>
      command<{ packaging: Packaging }>(`/shops/${shopId}/variants/${variantId}/barcodes`, {
        barcodesVersion: d.version,
        barcodes: d.rows.map((r) => ({
          code: r.code.trim(),
          symbology: r.symbology,
          packId: r.packId || null,
        })),
      }),
    onSuccess: (result) => {
      saved(result.packaging);
      setDraft(null);
    },
  });
  const generated = useMutation({
    mutationFn: () =>
      command<{ packaging: Packaging }>(
        `/shops/${shopId}/variants/${variantId}/barcodes/generate`,
        {
          symbology: generate.symbology,
          ...(generate.packId ? { packId: generate.packId } : {}),
        },
      ),
    onSuccess: (result) => saved(result.packaging),
  });

  if (packaging.isPending) return <Loading />;
  if (!packaging.data) return <ErrorNotice error={packaging.error} />;
  const data = packaging.data;
  const packs = data.packs.filter((p) => p.status === 'active');
  const packName = (id: string | null) =>
    id ? (data.packs.find((p) => p.id === id)?.name ?? 'Archived pack') : oneUnit(data.baseUnit);
  const errorFor = (error: unknown) =>
    error instanceof ApiError && error.code === 'duplicate_barcode' ? (
      <DuplicateNotice shopId={shopId} error={error} />
    ) : (
      <ErrorNotice error={error} />
    );

  if (!draft) {
    return (
      <section className="field-group" aria-label="Barcodes">
        <h3>Barcodes</h3>
        {data.barcodes.length === 0 ? (
          <p className="muted">No barcodes yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Type</th>
                  <th>On</th>
                </tr>
              </thead>
              <tbody>
                {data.barcodes.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <code>{b.code}</code>{' '}
                      {b.source === 'generated' ? <Badge tone="muted">generated</Badge> : null}
                    </td>
                    <td>{SYMBOLOGY_LABELS[b.symbology]}</td>
                    <td>{packName(b.packId)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canWrite ? (
          <div className="inline-form">
            <Field label="Generate a code">
              <select
                value={generate.symbology}
                onChange={(e) =>
                  setGenerate({ ...generate, symbology: e.target.value as GeneratedSymbology })
                }
              >
                {GENERATED_SYMBOLOGIES.map((s) => (
                  <option key={s} value={s}>
                    {SYMBOLOGY_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
            {packs.length > 0 ? (
              <Field label="For">
                <select
                  value={generate.packId}
                  onChange={(e) => setGenerate({ ...generate, packId: e.target.value })}
                >
                  <option value="">{oneUnit(data.baseUnit)}</option>
                  {packs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <button
              type="button"
              className="small"
              disabled={generated.isPending}
              onClick={() => generated.mutate()}
            >
              Generate
            </button>
          </div>
        ) : null}
        {generated.error ? errorFor(generated.error) : null}
        <div className="form-actions">
          {canWrite ? (
            <button
              type="button"
              className="small ghost"
              onClick={() => {
                save.reset();
                generated.reset();
                setDraft({
                  version: data.barcodesVersion,
                  rows: data.barcodes.map((b) => ({
                    key: b.id,
                    code: b.code,
                    symbology: b.symbology,
                    packId: b.packId ?? '',
                  })),
                });
              }}
            >
              Edit barcodes
            </button>
          ) : null}
          {data.barcodes.length > 0 ? (
            <Link
              to="/shops/$shopId/labels"
              params={{ shopId }}
              search={{ variants: variantId }}
              className="button-link small"
            >
              Print labels
            </Link>
          ) : null}
        </div>
      </section>
    );
  }

  const update = (key: string, patch: Partial<BarcodeDraft>) =>
    setDraft({ ...draft, rows: draft.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const checks = new Map(draft.rows.map((r) => [r.key, checkBarcode(r.code, r.symbology)]));
  const valid = [...checks.values()].every((c) => c.ok);
  return (
    <section className="field-group" aria-label="Barcodes">
      <h3>Barcodes</h3>
      <p className="muted">
        EAN and UPC check digits are verified. Each code can belong to one variant or pack in the
        shop.
      </p>
      {draft.rows.map((r, i) => {
        const check = checks.get(r.key)!;
        return (
          <fieldset key={r.key} className="edit-card" aria-label={`Barcode ${i + 1}`}>
            <div className="form-grid">
              <Field label="Code" error={r.code.trim() && !check.ok ? check.message : undefined}>
                <input
                  value={r.code}
                  className="mono"
                  onChange={(e) => update(r.key, { code: e.target.value })}
                />
              </Field>
              <Field label="Type">
                <select
                  value={r.symbology}
                  onChange={(e) => update(r.key, { symbology: e.target.value as Symbology })}
                >
                  {SYMBOLOGIES.map((s) => (
                    <option key={s} value={s}>
                      {SYMBOLOGY_LABELS[s]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="On">
                <select
                  value={r.packId}
                  onChange={(e) => update(r.key, { packId: e.target.value })}
                >
                  <option value="">{oneUnit(data.baseUnit)}</option>
                  {packs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="small ghost"
                onClick={() =>
                  setDraft({ ...draft, rows: draft.rows.filter((x) => x.key !== r.key) })
                }
              >
                Remove
              </button>
            </div>
          </fieldset>
        );
      })}
      {save.error && isVersionConflict(save.error) ? (
        <ConflictNotice
          what="barcodes"
          onReload={() => {
            setDraft(null);
            save.reset();
            void packaging.refetch();
          }}
        />
      ) : save.error ? (
        errorFor(save.error)
      ) : null}
      <div className="form-actions">
        {draft.rows.length < BARCODE_LIMITS.perVariant ? (
          <button
            type="button"
            className="small ghost"
            onClick={() =>
              setDraft({
                ...draft,
                rows: [...draft.rows, { key: tempKey(), code: '', symbology: 'ean13', packId: '' }],
              })
            }
          >
            Add barcode
          </button>
        ) : null}
        <button
          type="button"
          className="small"
          disabled={save.isPending || !valid}
          onClick={() => save.mutate(draft)}
        >
          Save barcodes
        </button>
        <button
          type="button"
          className="small ghost"
          onClick={() => {
            setDraft(null);
            save.reset();
          }}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
