import type { ops } from '@airstock/core';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type FormEvent, Fragment, useEffect, useState } from 'react';
import { api, command, type Out } from '../api.ts';
import { costText } from '../components/catalog/SupplierItemsEditor.tsx';
import { ConflictNotice, isVersionConflict } from '../components/catalog/shared.tsx';
import {
  Badge,
  Card,
  Empty,
  ErrorNotice,
  Field,
  formatDecimal,
  Loading,
  PageHeader,
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';
import { useMutation } from '../mutation.ts';

type Suppliers = Out<typeof ops.listSuppliers>;
type Supplier = Suppliers['suppliers'][number];
type SupplierDetail = Out<typeof ops.getSupplier>;

const FIELDS = [
  ['contactName', 'Contact'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['website', 'Website'],
  ['address', 'Address'],
  ['notes', 'Notes'],
] as const;
type TextField = (typeof FIELDS)[number][0];

interface SupplierDraft {
  name: string;
  contactName: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  notes: string;
  leadTimeDays: string;
}

const EMPTY: SupplierDraft = {
  name: '',
  contactName: '',
  email: '',
  phone: '',
  website: '',
  address: '',
  notes: '',
  leadTimeDays: '',
};

const draftOf = (s: Supplier): SupplierDraft => ({
  name: s.name,
  contactName: s.contactName ?? '',
  email: s.email ?? '',
  phone: s.phone ?? '',
  website: s.website ?? '',
  address: s.address ?? '',
  notes: s.notes ?? '',
  leadTimeDays: s.leadTimeDays === null ? '' : String(s.leadTimeDays),
});

/** Empty text clears a field; lead time is whole days. */
function bodyOf(d: SupplierDraft) {
  const text = (v: string) => v.trim() || null;
  return {
    name: d.name.trim(),
    contactName: text(d.contactName),
    email: text(d.email),
    phone: text(d.phone),
    website: text(d.website),
    address: text(d.address),
    notes: text(d.notes),
    leadTimeDays: /^\d+$/.test(d.leadTimeDays.trim()) ? Number(d.leadTimeDays.trim()) : null,
  };
}

export function SuppliersPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const search = useSearch({ strict: false }) as { supplier?: string };
  const navigate = useNavigate();
  const context = useShopContext(shopId);
  const canWrite = can(context.data, 'catalog.write');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const list = useInfiniteQuery({
    queryKey: ['shop', shopId, 'suppliers', 'list', query, archived],
    queryFn: ({ pageParam }) =>
      api<Suppliers>(`/shops/${shopId}/suppliers`, {
        query: {
          query: query || undefined,
          includeArchived: archived || undefined,
          after: pageParam,
          limit: 50,
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const suppliers = list.data?.pages.flatMap((p) => p.suppliers) ?? [];
  const open = (id: string | null) =>
    void navigate({
      to: '/shops/$shopId/suppliers',
      params: { shopId },
      search: id ? { supplier: id } : {},
    });

  return (
    <div className="stack">
      <PageHeader
        title="Suppliers"
        subtitle="Who you buy from, and what each supplier sells you."
        actions={
          canWrite ? (
            <button type="button" className="small" onClick={() => setCreating(!creating)}>
              Add supplier
            </button>
          ) : null
        }
      />
      {creating ? (
        <CreateSupplier
          shopId={shopId}
          onDone={(id) => {
            setCreating(false);
            if (id) open(id);
          }}
        />
      ) : null}
      <div className="toolbar">
        <input
          type="search"
          className="toolbar-search"
          aria-label="Search suppliers"
          placeholder="Search name, contact, email"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>
      <ErrorNotice error={list.error} />
      {list.isPending ? <Loading /> : null}
      {list.data && suppliers.length === 0 ? (
        <Empty>{query ? 'No supplier matches.' : 'No suppliers yet.'}</Empty>
      ) : null}
      {suppliers.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Contact</th>
                <th className="num">Lead time</th>
                <th className="num">Items</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => (
                <tr key={s.id} className={s.id === search.supplier ? 'open-row' : ''}>
                  <td>
                    <button type="button" className="link-button" onClick={() => open(s.id)}>
                      {s.name}
                    </button>{' '}
                    {s.status === 'archived' ? <Badge tone="muted">archived</Badge> : null}
                  </td>
                  <td>{s.contactName ?? s.email ?? '—'}</td>
                  <td className="num">
                    {s.leadTimeDays === null ? '—' : `${s.leadTimeDays} days`}
                  </td>
                  <td className="num">{s.itemCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.hasNextPage ? (
        <button
          type="button"
          className="ghost small"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          Show more
        </button>
      ) : null}
      {search.supplier ? (
        <SupplierCard
          key={search.supplier}
          shopId={shopId}
          supplierId={search.supplier}
          canWrite={canWrite}
          onClose={() => open(null)}
        />
      ) : null}
    </div>
  );
}

function SupplierFields({
  draft,
  onChange,
}: {
  draft: SupplierDraft;
  onChange(d: SupplierDraft): void;
}) {
  const set = (patch: Partial<SupplierDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="form-grid">
      <Field label="Name">
        <input value={draft.name} required onChange={(e) => set({ name: e.target.value })} />
      </Field>
      {FIELDS.filter(([k]) => k !== 'notes' && k !== 'address').map(([key, label]) => (
        <Field key={key} label={label}>
          <input
            value={draft[key as TextField]}
            type={key === 'email' ? 'email' : 'text'}
            onChange={(e) => set({ [key]: e.target.value })}
          />
        </Field>
      ))}
      <Field label="Lead time (days)">
        <input
          value={draft.leadTimeDays}
          inputMode="numeric"
          onChange={(e) => set({ leadTimeDays: e.target.value })}
        />
      </Field>
      <Field label="Address">
        <textarea
          rows={2}
          value={draft.address}
          onChange={(e) => set({ address: e.target.value })}
        />
      </Field>
      <Field label="Notes">
        <textarea rows={2} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
    </div>
  );
}

function CreateSupplier({ shopId, onDone }: { shopId: string; onDone(id?: string): void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SupplierDraft>(EMPTY);
  const create = useMutation({
    mutationFn: () => command<{ supplier: Supplier }>(`/shops/${shopId}/suppliers`, bodyOf(draft)),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'suppliers'] });
      onDone(result.supplier.id);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Card title="New supplier">
      <form className="stack" onSubmit={submit}>
        <SupplierFields draft={draft} onChange={setDraft} />
        <ErrorNotice error={create.error} />
        <div className="form-actions">
          <button type="submit" disabled={create.isPending || !draft.name.trim()}>
            Create supplier
          </button>
          <button type="button" className="ghost" onClick={() => onDone()}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

function SupplierCard({
  shopId,
  supplierId,
  canWrite,
  onClose,
}: {
  shopId: string;
  supplierId: string;
  canWrite: boolean;
  onClose(): void;
}) {
  const queryClient = useQueryClient();
  const context = useShopContext(shopId);
  const detail = useQuery({
    queryKey: ['shop', shopId, 'suppliers', 'detail', supplierId],
    queryFn: () => api<SupplierDetail>(`/shops/${shopId}/suppliers/${supplierId}`),
  });
  const [draft, setDraft] = useState<{ version: number; values: SupplierDraft } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'suppliers'] });
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      command<{ supplier: Supplier }>(`/shops/${shopId}/suppliers/${supplierId}`, body),
    onSuccess: () => {
      setDraft(null);
      void refresh();
    },
  });

  if (detail.isPending) return <Loading />;
  if (!detail.data) return <ErrorNotice error={detail.error} />;
  const { supplier, items, costVisible } = detail.data;
  const active = items.filter((i) => i.status === 'active');
  const conflict = update.error && isVersionConflict(update.error);

  return (
    <Card
      title={supplier.name}
      actions={
        <button type="button" className="ghost small" onClick={onClose} aria-label="Close supplier">
          ✕
        </button>
      }
    >
      <div className="stack">
        {supplier.status === 'archived' ? <Badge tone="muted">archived</Badge> : null}
        {draft ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({ expectedVersion: draft.version, ...bodyOf(draft.values) });
            }}
          >
            <SupplierFields
              draft={draft.values}
              onChange={(values) => setDraft({ ...draft, values })}
            />
            <div className="form-actions">
              <button type="submit" disabled={update.isPending || !draft.values.name.trim()}>
                Save
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setDraft(null);
                  update.reset();
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <dl className="facts">
            {FIELDS.map(([key, label]) =>
              supplier[key] ? (
                <Fragment key={key}>
                  <dt>{label}</dt>
                  <dd>{supplier[key]}</dd>
                </Fragment>
              ) : null,
            )}
            <dt>Lead time</dt>
            <dd>{supplier.leadTimeDays === null ? '—' : `${supplier.leadTimeDays} days`}</dd>
            <dt>Currency</dt>
            <dd>{supplier.currency}</dd>
          </dl>
        )}
        {conflict ? (
          <ConflictNotice
            what="supplier"
            onReload={() => {
              setDraft(null);
              update.reset();
              void detail.refetch();
            }}
          />
        ) : (
          <ErrorNotice error={update.error} />
        )}
        {canWrite && !draft ? (
          <div className="form-actions">
            {supplier.status === 'active' ? (
              <button
                type="button"
                className="small ghost"
                onClick={() => {
                  update.reset();
                  setDraft({ version: supplier.version, values: draftOf(supplier) });
                }}
              >
                Edit
              </button>
            ) : null}
            <button
              type="button"
              className="small ghost"
              disabled={update.isPending}
              onClick={() =>
                update.mutate({
                  expectedVersion: supplier.version,
                  status: supplier.status === 'active' ? 'archived' : 'active',
                })
              }
            >
              {supplier.status === 'active' ? 'Archive' : 'Restore'}
            </button>
          </div>
        ) : null}
        <h3>Supplied items</h3>
        {active.length === 0 ? (
          <p className="muted">
            None yet. Add this supplier to a variant from the product’s Suppliers tab.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Supplier SKU</th>
                  <th>Sold in</th>
                  {costVisible ? <th className="num">Last cost</th> : null}
                  <th className="num">Minimum</th>
                </tr>
              </thead>
              <tbody>
                {active.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Link
                        to="/shops/$shopId/products"
                        params={{ shopId }}
                        search={{ item: i.productId }}
                      >
                        {i.productName}
                      </Link>{' '}
                      <code>{i.sku}</code> {i.preferred ? <Badge tone="ok">preferred</Badge> : null}
                    </td>
                    <td>{i.supplierSku ?? '—'}</td>
                    <td>{i.packName ?? 'Units'}</td>
                    {costVisible ? (
                      <td className="num">
                        {costText(i, context.data?.shop.currency, 'unit') ?? '—'}
                      </td>
                    ) : null}
                    <td className="num">
                      {i.minimumOrderQuantity ? formatDecimal(i.minimumOrderQuantity) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!costVisible && active.length > 0 ? (
          <p className="muted small-text">Costs are hidden: they need the costs permission.</p>
        ) : null}
      </div>
    </Card>
  );
}
