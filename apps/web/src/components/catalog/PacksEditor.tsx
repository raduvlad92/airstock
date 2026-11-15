import { PACK_LIMITS, PACK_USES, type PackUse, resolvePacks } from '@airstock/core/packs';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { command } from '../../api.ts';
import { ErrorNotice, Field, formatDecimal, Loading } from '../ui.tsx';
import {
  ConflictNotice,
  dimensionsText,
  type EditorProps,
  isPositiveDecimal,
  isVersionConflict,
  type Packaging,
  tempKey,
  unitName,
  usePackaging,
  usePackagingSaved,
  weightText,
} from './shared.tsx';

const USE_LABELS: Record<PackUse, string> = {
  purchasing: 'Buying',
  counting: 'Counting',
  transfer: 'Transfers',
  sales: 'Selling',
};

interface PackDraft {
  key: string;
  id?: string;
  name: string;
  quantity: string;
  /** Key of the inner pack, or '' for base units. */
  inner: string;
  uses: PackUse[];
  price: string;
  dimensions: string;
  weight: string;
}

function toDraft(packaging: Packaging): PackDraft[] {
  return packaging.packs
    .filter((p) => p.status === 'active')
    .map((p) => ({
      key: p.id,
      id: p.id,
      name: p.name,
      quantity: formatDecimal(p.quantity),
      inner: p.innerPackId ?? '',
      uses: p.uses,
      price: p.price ?? '',
      dimensions: dimensionsText(p.dimensions),
      weight: weightText(p.weight),
    }));
}

/** Base units per pack as the server will compute them, or why a pack does not resolve. */
function preview(draft: PackDraft[], quantityScale: number) {
  const valid = draft.every((p) => isPositiveDecimal(p.quantity) && p.name.trim());
  if (!valid) return null;
  const resolved = resolvePacks(
    draft.map((p) => ({
      key: p.key,
      name: p.name,
      quantity: p.quantity.trim(),
      inner: p.inner || null,
    })),
    quantityScale,
  );
  return resolved;
}

/** The packs of a variant (plan 5.3): inner packs, cases, pallets, each an exact base quantity. */
export function PacksEditor({ shopId, variantId, canWrite = true }: EditorProps) {
  const packaging = usePackaging(shopId, variantId);
  const saved = usePackagingSaved(shopId, variantId);
  const [draft, setDraft] = useState<{ version: number; packs: PackDraft[] } | null>(null);
  const save = useMutation({
    mutationFn: (d: { version: number; packs: PackDraft[] }) =>
      command<{ packaging: Packaging }>(`/shops/${shopId}/variants/${variantId}/packs`, {
        packsVersion: d.version,
        packs: d.packs.map((p) => {
          const inner = d.packs.find((q) => q.key === p.inner);
          return {
            ...(p.id ? { id: p.id } : {}),
            name: p.name.trim(),
            quantity: p.quantity.trim(),
            ...(inner ? { innerPack: inner.id ?? inner.name.trim() } : {}),
            uses: p.uses,
            price: p.price.trim() || null,
            ...(p.dimensions.trim() ? { dimensions: p.dimensions.trim() } : {}),
            ...(p.weight.trim() ? { weight: p.weight.trim() } : {}),
          };
        }),
      }),
    onSuccess: (result) => {
      saved(result.packaging);
      setDraft(null);
    },
  });

  if (packaging.isPending) return <Loading />;
  if (!packaging.data) return <ErrorNotice error={packaging.error} />;
  const data = packaging.data;
  const active = data.packs.filter((p) => p.status === 'active');
  const unit = unitName(data.baseUnit);

  if (!draft) {
    return (
      <section className="field-group" aria-label="Packs">
        <h3>Packs</h3>
        {active.length === 0 ? (
          <p className="muted">No packs. Stock is counted in {unit} only.</p>
        ) : (
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Pack</th>
                  <th>Holds</th>
                  <th className="num">Total</th>
                  <th>Used for</th>
                </tr>
              </thead>
              <tbody>
                {active.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>
                      {formatDecimal(p.quantity)} {p.innerPackName ?? unit}
                    </td>
                    <td className="num">
                      {formatDecimal(p.baseQuantity)} {unit}
                    </td>
                    <td>{p.uses.map((u) => USE_LABELS[u]).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canWrite ? (
          <div className="form-actions">
            <button
              type="button"
              className="small ghost"
              onClick={() => {
                save.reset();
                setDraft({ version: data.packsVersion, packs: toDraft(data) });
              }}
            >
              Edit packs
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  const resolved = preview(draft.packs, data.quantityScale);
  const update = (key: string, patch: Partial<PackDraft>) =>
    setDraft({ ...draft, packs: draft.packs.map((p) => (p.key === key ? { ...p, ...patch } : p)) });
  const remove = (key: string) =>
    setDraft({
      ...draft,
      packs: draft.packs
        .filter((p) => p.key !== key)
        .map((p) => (p.inner === key ? { ...p, inner: '' } : p)),
    });
  return (
    <section className="field-group" aria-label="Packs">
      <h3>Packs</h3>
      <p className="muted">
        A pack holds a number of {unit}, or of another pack: a case can hold 12 inner packs. Packs
        you remove are archived, not deleted.
      </p>
      {draft.packs.map((p, i) => (
        <fieldset key={p.key} className="edit-card" aria-label={`Pack ${i + 1}`}>
          <div className="form-grid">
            <Field label="Name">
              <input value={p.name} onChange={(e) => update(p.key, { name: e.target.value })} />
            </Field>
            <Field label="Holds">
              <input
                value={p.quantity}
                inputMode="decimal"
                onChange={(e) => update(p.key, { quantity: e.target.value })}
              />
            </Field>
            <Field label="Of">
              <select value={p.inner} onChange={(e) => update(p.key, { inner: e.target.value })}>
                <option value="">{unit}</option>
                {draft.packs
                  .filter((q) => q.key !== p.key)
                  .map((q) => (
                    <option key={q.key} value={q.key}>
                      {q.name || 'Unnamed pack'}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Price" hint="Empty: the unit price times the pack">
              <input
                value={p.price}
                inputMode="decimal"
                onChange={(e) => update(p.key, { price: e.target.value })}
              />
            </Field>
            <Field label="Dimensions">
              <input
                value={p.dimensions}
                placeholder="40 x 30 x 20 cm"
                onChange={(e) => update(p.key, { dimensions: e.target.value })}
              />
            </Field>
            <Field label="Weight">
              <input
                value={p.weight}
                placeholder="4.5 kg"
                onChange={(e) => update(p.key, { weight: e.target.value })}
              />
            </Field>
          </div>
          <fieldset className="checks-inline" aria-label="Used for">
            {PACK_USES.map((u) => (
              <label key={u} className="check">
                <input
                  type="checkbox"
                  checked={p.uses.includes(u)}
                  onChange={(e) =>
                    update(p.key, {
                      uses: e.target.checked ? [...p.uses, u] : p.uses.filter((x) => x !== u),
                    })
                  }
                />
                {USE_LABELS[u]}
              </label>
            ))}
          </fieldset>
          <div className="form-actions">
            {resolved?.ok ? (
              <span className="muted">
                = {formatDecimal(resolved.base.get(p.key))} {unit}
              </span>
            ) : resolved && !resolved.ok && resolved.key === p.key ? (
              <span className="field-error">{resolved.message}</span>
            ) : null}
            <button type="button" className="small ghost" onClick={() => remove(p.key)}>
              Remove
            </button>
          </div>
        </fieldset>
      ))}
      {save.error && isVersionConflict(save.error) ? (
        <ConflictNotice
          what="packs"
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
        {draft.packs.length < PACK_LIMITS.perVariant ? (
          <button
            type="button"
            className="small ghost"
            onClick={() =>
              setDraft({
                ...draft,
                packs: [
                  ...draft.packs,
                  {
                    key: tempKey(),
                    name: '',
                    quantity: '',
                    inner: '',
                    uses: ['purchasing', 'counting', 'transfer'],
                    price: '',
                    dimensions: '',
                    weight: '',
                  },
                ],
              })
            }
          >
            Add pack
          </button>
        ) : null}
        <button
          type="button"
          className="small"
          disabled={save.isPending || resolved === null || !resolved.ok}
          onClick={() => save.mutate(draft)}
        >
          Save packs
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
