import type { ops } from '@airstock/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api, command, type Out } from '../../api.ts';
import { useShopContext } from '../../context.tsx';
import { Badge, ErrorNotice, Field, formatDecimal, Loading } from '../ui.tsx';
import {
  ConflictNotice,
  type EditorProps,
  isVersionConflict,
  unitName,
  usePackaging,
} from './shared.tsx';

type Items = Out<typeof ops.listSupplierItems>;
export type SupplierItem = Items['items'][number];
type Suppliers = Out<typeof ops.listSuppliers>;

interface ItemDraft {
  supplierId: string;
  packId: string;
  supplierSku: string;
  lastCost: string;
  minimumOrderQuantity: string;
  preferred: boolean;
}

const draftOf = (item: SupplierItem): ItemDraft => ({
  supplierId: item.supplierId,
  packId: item.packId ?? '',
  supplierSku: item.supplierSku ?? '',
  lastCost: item.lastCost ?? '',
  minimumOrderQuantity: item.minimumOrderQuantity ?? '',
  preferred: item.preferred,
});

/** "12.40 EUR per case", or nothing when the caller may not see costs. */
export function costText(item: SupplierItem, currency: string | undefined, unit: string) {
  if (!item.costVisible || item.lastCost === null) return null;
  const single = unit === 'each' ? 'item' : unit;
  return `${formatDecimal(item.lastCost, 2)}${currency ? ` ${currency}` : ''} per ${item.packName ?? single}`;
}

function ItemForm({
  initial,
  suppliers,
  packs,
  unit,
  costVisible,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: ItemDraft;
  suppliers?: Suppliers['suppliers'];
  packs: Array<{ id: string; name: string }>;
  unit: string;
  costVisible: boolean;
  pending: boolean;
  submitLabel: string;
  onSubmit(draft: ItemDraft): void;
  onCancel?(): void;
}) {
  const [draft, setDraft] = useState(initial);
  const set = (patch: Partial<ItemDraft>) => setDraft({ ...draft, ...patch });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(draft);
  };
  return (
    <form className="edit-card" onSubmit={submit}>
      <div className="form-grid">
        {suppliers ? (
          <Field label="Supplier">
            <select value={draft.supplierId} onChange={(e) => set({ supplierId: e.target.value })}>
              <option value="">Choose…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Sold in">
          <select value={draft.packId} onChange={(e) => set({ packId: e.target.value })}>
            <option value="">{unitName(unit)}</option>
            {packs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Supplier SKU">
          <input value={draft.supplierSku} onChange={(e) => set({ supplierSku: e.target.value })} />
        </Field>
        {costVisible ? (
          <Field
            label="Last cost"
            hint={draft.packId ? 'Per pack' : `Per ${unit === 'each' ? 'item' : unit}`}
          >
            <input
              value={draft.lastCost}
              inputMode="decimal"
              onChange={(e) => set({ lastCost: e.target.value })}
            />
          </Field>
        ) : null}
        <Field label="Minimum order" hint={draft.packId ? 'In packs' : `In ${unitName(unit)}`}>
          <input
            value={draft.minimumOrderQuantity}
            inputMode="decimal"
            onChange={(e) => set({ minimumOrderQuantity: e.target.value })}
          />
        </Field>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.preferred}
          onChange={(e) => set({ preferred: e.target.checked })}
        />
        Preferred supplier for this variant
      </label>
      <div className="form-actions">
        <button
          type="submit"
          className="small"
          disabled={pending || (suppliers !== undefined && !draft.supplierId)}
        >
          {submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="small ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** Who supplies a variant (plan 5.6): supplier SKU, pack, minimum order, and, with costs.read, cost. */
export function SupplierItemsEditor({ shopId, variantId, canWrite = true }: EditorProps) {
  const queryClient = useQueryClient();
  const key = ['shop', shopId, 'supplier-items', 'variant', variantId];
  const items = useQuery({
    queryKey: key,
    queryFn: () =>
      api<Items>(`/shops/${shopId}/supplier-items`, { query: { variantId, limit: 200 } }),
  });
  const packaging = usePackaging(shopId, variantId);
  const currency = useShopContext(shopId).data?.shop.currency;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const suppliers = useQuery({
    queryKey: ['shop', shopId, 'suppliers', 'all-active'],
    queryFn: () => api<Suppliers>(`/shops/${shopId}/suppliers`, { query: { limit: 200 } }),
    enabled: adding,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'supplier-items'] });
    void queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'suppliers'] });
  };
  const save = useMutation({
    mutationFn: ({ item, draft }: { item?: SupplierItem; draft: ItemDraft }) => {
      const costVisible = items.data?.costVisible ?? false;
      const cost = draft.lastCost.trim();
      const body = {
        packId: draft.packId || null,
        supplierSku: draft.supplierSku.trim() || null,
        minimumOrderQuantity: draft.minimumOrderQuantity.trim() || null,
        preferred: draft.preferred,
        // A cost is sent only when it changed, so its date stays the date it was last set.
        ...(costVisible && cost !== (item?.lastCost ?? '') ? { lastCost: cost || null } : {}),
      };
      return command(
        `/shops/${shopId}/supplier-items`,
        item
          ? { itemId: item.id, expectedVersion: item.version, ...body }
          : { supplierId: draft.supplierId, variantId, ...body },
      );
    },
    onSuccess: () => {
      setAdding(false);
      setEditing(null);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (item: SupplierItem) =>
      command(`/shops/${shopId}/supplier-items/${item.id}/remove`, {
        expectedVersion: item.version,
      }),
    onSuccess: refresh,
  });

  if (items.isPending) return <Loading />;
  if (!items.data) return <ErrorNotice error={items.error} />;
  const unit = packaging.data?.baseUnit ?? 'unit';
  const packs = (packaging.data?.packs ?? []).filter((p) => p.status === 'active');
  const active = items.data.items.filter((i) => i.status === 'active');
  const error = save.error ?? remove.error;

  return (
    <section className="field-group" aria-label="Suppliers">
      <h3>Suppliers</h3>
      {active.length === 0 ? <p className="muted">No supplier for this variant yet.</p> : null}
      <ul className="plain-list supplier-items">
        {active.map((item) =>
          editing === item.id ? (
            <li key={item.id}>
              <strong>{item.supplierName}</strong>
              <ItemForm
                initial={draftOf(item)}
                packs={packs}
                unit={unit}
                costVisible={item.costVisible}
                pending={save.isPending}
                submitLabel="Save"
                onSubmit={(draft) => save.mutate({ item, draft })}
                onCancel={() => {
                  setEditing(null);
                  save.reset();
                }}
              />
            </li>
          ) : (
            <li key={item.id}>
              <div>
                <Link
                  to="/shops/$shopId/suppliers"
                  params={{ shopId }}
                  search={{ supplier: item.supplierId }}
                >
                  {item.supplierName}
                </Link>{' '}
                {item.preferred ? <Badge tone="ok">preferred</Badge> : null}
              </div>
              <div className="muted small-text">
                {[
                  item.supplierSku ? `SKU ${item.supplierSku}` : null,
                  item.packName ? `in ${item.packName}` : null,
                  item.minimumOrderQuantity
                    ? `minimum ${formatDecimal(item.minimumOrderQuantity)} ${item.packName ?? unitName(unit)}`
                    : null,
                  costText(item, currency, unit),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {canWrite ? (
                <div className="form-actions">
                  <button
                    type="button"
                    className="small ghost"
                    onClick={() => {
                      save.reset();
                      setEditing(item.id);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="small ghost"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(item)}
                  >
                    Remove
                  </button>
                </div>
              ) : null}
            </li>
          ),
        )}
      </ul>
      {!items.data.costVisible && active.length > 0 ? (
        <p className="muted small-text">Costs are hidden: they need the costs permission.</p>
      ) : null}
      {error && isVersionConflict(error) ? (
        <ConflictNotice
          what="supplier item"
          onReload={() => {
            setEditing(null);
            save.reset();
            remove.reset();
            void items.refetch();
          }}
        />
      ) : (
        <ErrorNotice error={error} />
      )}
      {canWrite ? (
        adding ? (
          suppliers.data ? (
            suppliers.data.suppliers.length === 0 ? (
              <p className="muted">
                No suppliers yet.{' '}
                <Link to="/shops/$shopId/suppliers" params={{ shopId }}>
                  Add one
                </Link>{' '}
                first.
              </p>
            ) : (
              <ItemForm
                initial={{
                  supplierId: '',
                  packId: '',
                  supplierSku: '',
                  lastCost: '',
                  minimumOrderQuantity: '',
                  preferred: active.length === 0,
                }}
                suppliers={suppliers.data.suppliers}
                packs={packs}
                unit={unit}
                costVisible={items.data.costVisible}
                pending={save.isPending}
                submitLabel="Add supplier"
                onSubmit={(draft) => save.mutate({ draft })}
                onCancel={() => {
                  setAdding(false);
                  save.reset();
                }}
              />
            )
          ) : suppliers.isPending ? (
            <Loading />
          ) : (
            <ErrorNotice error={suppliers.error} />
          )
        ) : (
          <div className="form-actions">
            <button
              type="button"
              className="small ghost"
              onClick={() => {
                save.reset();
                setAdding(true);
              }}
            >
              Add a supplier
            </button>
          </div>
        )
      ) : null}
    </section>
  );
}
