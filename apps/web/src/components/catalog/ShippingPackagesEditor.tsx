import { useState } from 'react';
import { command } from '../../api.ts';
import { useMutation } from '../../mutation.ts';
import { ErrorNotice, Field, Loading } from '../ui.tsx';
import {
  ConflictNotice,
  dimensionsText,
  type EditorProps,
  isVersionConflict,
  type Packaging,
  tempKey,
  usePackaging,
  usePackagingSaved,
  weightText,
} from './shared.tsx';

interface BoxDraft {
  key: string;
  name: string;
  dimensions: string;
  weight: string;
}

/** The boxes one unit ships in (plan 5.3), such as a table in two cartons. */
export function ShippingPackagesEditor({ shopId, variantId, canWrite = true }: EditorProps) {
  const packaging = usePackaging(shopId, variantId);
  const saved = usePackagingSaved(shopId, variantId);
  const [draft, setDraft] = useState<{ version: number; boxes: BoxDraft[] } | null>(null);
  const save = useMutation({
    mutationFn: (d: { version: number; boxes: BoxDraft[] }) =>
      command<{ packaging: Packaging }>(
        `/shops/${shopId}/variants/${variantId}/shipping-packages`,
        {
          shippingPackagesVersion: d.version,
          shippingPackages: d.boxes.map((b) => ({
            ...(b.name.trim() ? { name: b.name.trim() } : {}),
            dimensions: b.dimensions.trim(),
            weight: b.weight.trim(),
          })),
        },
      ),
    onSuccess: (result) => {
      saved(result.packaging);
      setDraft(null);
    },
  });

  if (packaging.isPending) return <Loading />;
  if (!packaging.data) return <ErrorNotice error={packaging.error} />;
  const data = packaging.data;

  if (!draft) {
    return (
      <section className="field-group" aria-label="Shipping boxes">
        <h3>Shipping boxes</h3>
        {data.shippingPackages.length === 0 ? (
          <p className="muted">Not set. Add the boxes one unit ships in.</p>
        ) : (
          <ol className="plain-list">
            {data.shippingPackages.map((b) => (
              <li key={b.id}>
                {b.name ? <strong>{b.name}: </strong> : null}
                {dimensionsText(b.dimensions)}, {weightText(b.weight)}
              </li>
            ))}
          </ol>
        )}
        {canWrite ? (
          <div className="form-actions">
            <button
              type="button"
              className="small ghost"
              onClick={() => {
                save.reset();
                setDraft({
                  version: data.shippingPackagesVersion,
                  boxes: data.shippingPackages.map((b) => ({
                    key: b.id,
                    name: b.name ?? '',
                    dimensions: dimensionsText(b.dimensions),
                    weight: weightText(b.weight),
                  })),
                });
              }}
            >
              Edit boxes
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  const update = (key: string, patch: Partial<BoxDraft>) =>
    setDraft({ ...draft, boxes: draft.boxes.map((b) => (b.key === key ? { ...b, ...patch } : b)) });
  const complete = draft.boxes.every((b) => b.dimensions.trim() && b.weight.trim());
  return (
    <section className="field-group" aria-label="Shipping boxes">
      <h3>Shipping boxes</h3>
      {draft.boxes.map((b, i) => (
        <fieldset key={b.key} className="edit-card" aria-label={`Box ${i + 1}`}>
          <div className="form-grid">
            <Field label="Name">
              <input
                value={b.name}
                placeholder={`Box ${i + 1}`}
                onChange={(e) => update(b.key, { name: e.target.value })}
              />
            </Field>
            <Field label="Dimensions">
              <input
                value={b.dimensions}
                placeholder="120 x 60 x 75 cm"
                onChange={(e) => update(b.key, { dimensions: e.target.value })}
              />
            </Field>
            <Field label="Weight">
              <input
                value={b.weight}
                placeholder="18 kg"
                onChange={(e) => update(b.key, { weight: e.target.value })}
              />
            </Field>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="small ghost"
              onClick={() =>
                setDraft({ ...draft, boxes: draft.boxes.filter((x) => x.key !== b.key) })
              }
            >
              Remove
            </button>
          </div>
        </fieldset>
      ))}
      {save.error && isVersionConflict(save.error) ? (
        <ConflictNotice
          what="shipping boxes"
          onReload={() => {
            setDraft(null);
            save.reset();
            void packaging.refetch();
          }}
        />
      ) : (
        <ErrorNotice error={save.error} />
      )}
      <div className="form-actions">
        {draft.boxes.length < 20 ? (
          <button
            type="button"
            className="small ghost"
            onClick={() =>
              setDraft({
                ...draft,
                boxes: [...draft.boxes, { key: tempKey(), name: '', dimensions: '', weight: '' }],
              })
            }
          >
            Add box
          </button>
        ) : null}
        <button
          type="button"
          className="small"
          disabled={save.isPending || !complete}
          onClick={() => save.mutate(draft)}
        >
          Save boxes
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
