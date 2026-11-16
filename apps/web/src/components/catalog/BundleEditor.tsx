import type { ops } from '@airstock/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, command, type Out } from '../../api.ts';
import { can, useShopContext } from '../../context.tsx';
import { useMutation } from '../../mutation.ts';
import { useLocations } from '../../pages/warehouses.tsx';
import { Badge, ErrorNotice, Field, formatDecimal, Loading } from '../ui.tsx';
import {
  ConflictNotice,
  type EditorProps,
  isPositiveDecimal,
  isVersionConflict,
  type Packaging,
  tempKey,
  unitName,
  usePackaging,
  usePackagingSaved,
} from './shared.tsx';

type Availability = Out<typeof ops.getBundleAvailability>;
type QueryResult = Out<typeof ops.queryItems>;

interface ComponentDraft {
  key: string;
  variantId: string;
  label: string;
  packId: string;
  quantity: string;
}

const BUNDLE_COMPONENTS = 50;

type Locations = Out<typeof ops.listLocations>;

/** The location's path below its warehouse, since the warehouse names the group. */
function pathInWarehouse(path: string, warehouseName: string): string {
  if (!path.startsWith(warehouseName)) return path;
  return path.slice(warehouseName.length).replace(/^\s*\/\s*/, '') || path;
}

/** Whole shop, one warehouse, or one location and the locations under it. */
function PlaceSelect({
  shopId,
  value,
  onChange,
}: {
  shopId: string;
  value: string;
  onChange(value: string): void;
}) {
  const locations = useLocations(shopId);
  const groups = new Map<string, { name: string; locations: Locations['locations'] }>();
  for (const l of locations.data?.locations ?? []) {
    if (l.status !== 'active') continue;
    const group = groups.get(l.warehouseId) ?? { name: l.warehouseName, locations: [] };
    group.locations.push(l);
    groups.set(l.warehouseId, group);
  }
  return (
    <Field label="Count stock in">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Whole shop</option>
        {[...groups].map(([warehouseId, group]) => (
          <optgroup key={warehouseId} label={group.name}>
            <option value={`warehouse:${warehouseId}`}>All of {group.name}</option>
            {group.locations.map((l) => (
              <option key={l.locationId} value={`location:${l.locationId}`}>
                {pathInWarehouse(l.path, group.name)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </Field>
  );
}

function BundleAvailability({
  shopId,
  variantId,
  pickPlace,
}: {
  shopId: string;
  variantId: string;
  /** Listing locations needs storage.read; without it the whole shop is counted. */
  pickPlace: boolean;
}) {
  const [place, setPlace] = useState('');
  const [kind, placeId] = place.split(':');
  const availability = useQuery({
    queryKey: ['shop', shopId, 'bundle-availability', variantId, place],
    queryFn: () =>
      api<Availability>(`/shops/${shopId}/variants/${variantId}/bundle-availability`, {
        query: {
          warehouseId: kind === 'warehouse' ? placeId : undefined,
          locationId: kind === 'location' ? placeId : undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });
  const a = availability.data;
  const limit = a?.components.find((c) => c.variantId === a.limitedBy);
  return (
    <div className="bundle-availability stack">
      {pickPlace ? <PlaceSelect shopId={shopId} value={place} onChange={setPlace} /> : null}
      {availability.isPending ? <Loading /> : null}
      {availability.error ? <ErrorNotice error={availability.error} /> : null}
      {a ? (
        <>
          <p>
            <strong>{formatDecimal(a.available)}</strong> available
            {limit ? <span className="muted"> · limited by {limit.sku}</span> : null}
          </p>
          {a.partial ? (
            <p className="muted small-text">Counts only the locations you can access.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** A component's pack choice, from that component's own packs. */
function ComponentPack({
  shopId,
  row,
  onChange,
}: {
  shopId: string;
  row: ComponentDraft;
  onChange(packId: string): void;
}) {
  const packaging = usePackaging(shopId, row.variantId);
  const packs = packaging.data?.packs.filter((p) => p.status === 'active') ?? [];
  const unit = unitName(packaging.data?.baseUnit);
  return (
    <Field label="Counted in">
      <select value={row.packId} onChange={(e) => onChange(e.target.value)}>
        <option value="">{unit}</option>
        {packs.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({formatDecimal(p.baseQuantity)} {unit})
          </option>
        ))}
      </select>
    </Field>
  );
}

function ComponentSearch({
  shopId,
  exclude,
  onPick,
}: {
  shopId: string;
  exclude: string[];
  onPick(row: { variantId: string; label: string }): void;
}) {
  const [search, setSearch] = useState('');
  const found = useQuery({
    queryKey: ['shop', shopId, 'component-search', search.trim()],
    queryFn: () =>
      api<QueryResult>(`/shops/${shopId}/items/query`, {
        method: 'POST',
        body: { mode: 'variants', search: search.trim(), limit: 8 },
      }),
    enabled: search.trim().length >= 2,
  });
  return (
    <div className="stack">
      <input
        type="search"
        value={search}
        placeholder="Find a component by name or SKU"
        aria-label="Find a component"
        onChange={(e) => setSearch(e.target.value)}
      />
      <ul className="plain-list">
        {(found.data?.rows ?? [])
          .filter((r) => r.variantId && !exclude.includes(r.variantId))
          .map((r) => (
            <li key={r.variantId}>
              {r.name}
              {r.title ? ` · ${r.title}` : ''} <code>{r.sku}</code>{' '}
              <button
                type="button"
                className="small ghost"
                onClick={() => {
                  onPick({
                    variantId: r.variantId!,
                    label: `${r.name}${r.title ? ` · ${r.title}` : ''} (${r.sku})`,
                  });
                  setSearch('');
                }}
              >
                Add
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

/** A bundle's components (plan 5.5) and how many bundles the components' stock allows. */
export function BundleEditor({ shopId, variantId, canWrite = true }: EditorProps) {
  const packaging = usePackaging(shopId, variantId);
  const context = useShopContext(shopId);
  const saved = usePackagingSaved(shopId, variantId);
  const [draft, setDraft] = useState<{ version: number; rows: ComponentDraft[] } | null>(null);
  const save = useMutation({
    mutationFn: (d: { version: number; rows: ComponentDraft[] }) =>
      command<{ packaging: Packaging }>(`/shops/${shopId}/variants/${variantId}/bundle`, {
        bundleVersion: d.version,
        components: d.rows.map((r) => ({
          variantId: r.variantId,
          ...(r.packId ? { packId: r.packId } : {}),
          quantity: r.quantity.trim(),
        })),
      }),
    onSuccess: (result) => {
      saved(result.packaging);
      setDraft(null);
    },
  });

  if (packaging.isPending) return <Loading />;
  if (!packaging.data) return <ErrorNotice error={packaging.error} />;
  const data = packaging.data;
  const bundle = data.bundle?.active ? data.bundle : null;
  const partOf =
    data.componentOf.length > 0 ? (
      <p className="muted">
        Part of {data.componentOf.length === 1 ? 'the bundle' : 'the bundles'}{' '}
        {data.componentOf.map((b) => b.sku).join(', ')}.
      </p>
    ) : null;

  if (!draft) {
    return (
      <section className="field-group" aria-label="Bundle">
        <h3>Bundle</h3>
        {partOf}
        {bundle ? (
          <>
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Component</th>
                    <th className="num">Per bundle</th>
                  </tr>
                </thead>
                <tbody>
                  {bundle.components.map((c) => (
                    <tr key={`${c.variantId}:${c.packId ?? ''}`}>
                      <td>
                        {c.productName}
                        {c.title ? ` · ${c.title}` : ''} <code>{c.sku}</code>{' '}
                        {c.status !== 'active' ? <Badge tone="error">{c.status}</Badge> : null}
                      </td>
                      <td className="num">
                        {formatDecimal(c.quantity)} {c.packName ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {can(context.data, 'inventory.read') ? (
              <BundleAvailability
                shopId={shopId}
                variantId={variantId}
                pickPlace={can(context.data, 'storage.read')}
              />
            ) : null}
          </>
        ) : (
          <p className="muted">
            Not a bundle. A bundle is sold as one item made of other variants.
          </p>
        )}
        {canWrite && data.componentOf.length === 0 ? (
          <div className="form-actions">
            <button
              type="button"
              className="small ghost"
              onClick={() => {
                save.reset();
                setDraft({
                  version: data.bundleVersion,
                  rows: (bundle?.components ?? []).map((c) => ({
                    key: tempKey(),
                    variantId: c.variantId,
                    label: `${c.productName}${c.title ? ` · ${c.title}` : ''} (${c.sku})`,
                    packId: c.packId ?? '',
                    quantity: formatDecimal(c.quantity),
                  })),
                });
              }}
            >
              {bundle ? 'Edit bundle' : 'Make this a bundle'}
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  const update = (key: string, patch: Partial<ComponentDraft>) =>
    setDraft({ ...draft, rows: draft.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const valid = draft.rows.every((r) => isPositiveDecimal(r.quantity));
  const removing = draft.rows.length === 0;
  return (
    <section className="field-group" aria-label="Bundle">
      <h3>Bundle</h3>
      {draft.rows.map((r, i) => (
        <fieldset key={r.key} className="edit-card" aria-label={`Component ${i + 1}`}>
          <p>{r.label}</p>
          <div className="form-grid">
            <Field label="Quantity">
              <input
                value={r.quantity}
                inputMode="decimal"
                onChange={(e) => update(r.key, { quantity: e.target.value })}
              />
            </Field>
            <ComponentPack
              shopId={shopId}
              row={r}
              onChange={(packId) => update(r.key, { packId })}
            />
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
      ))}
      {draft.rows.length < BUNDLE_COMPONENTS ? (
        <ComponentSearch
          shopId={shopId}
          exclude={[variantId]}
          onPick={(row) =>
            setDraft({
              ...draft,
              rows: [...draft.rows, { key: tempKey(), packId: '', quantity: '1', ...row }],
            })
          }
        />
      ) : null}
      {save.error && isVersionConflict(save.error) ? (
        <ConflictNotice
          what="bundle"
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
        <button
          type="button"
          className="small"
          disabled={save.isPending || !valid || (removing && !bundle)}
          onClick={() => save.mutate(draft)}
        >
          {removing && bundle ? 'Stop selling as a bundle' : 'Save bundle'}
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
