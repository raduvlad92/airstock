import type { ops } from '@airstock/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { ApiError, api, command, errorMessage, type Out } from '../api.ts';
import { ReorderRulesPanel } from '../components/reorder-rules.tsx';
import {
  Badge,
  Empty,
  ErrorNotice,
  Field,
  formatDecimal,
  Loading,
  Notice,
  Tabs,
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';
import { ActivityTable, useActivity } from '../pages/activity.tsx';
import { StockPanel, StockSettingsForm } from '../pages/inventory.tsx';
import { telemetry } from '../telemetry.ts';
import { RichText } from './rich-text.tsx';
import { type CatalogSchema, type Column, columnsFor, useCatalogSchema } from './schema.ts';
import { editText, parseInput } from './values.ts';

export type Item = Out<typeof ops.getItem>['item'];
type FieldValue = Item['product']['fields'][string];

export function useItem(shopId: string, productId: string) {
  return useQuery({
    queryKey: ['shop', shopId, 'item', productId],
    queryFn: async () =>
      (
        await api<Out<typeof ops.getItem>>(`/shops/${shopId}/items/detail`, {
          query: { productId },
        })
      ).item,
  });
}

/** Extra tabs that other milestones add (pictures, packaging, suppliers). */
export interface DetailExtension {
  id: string;
  label: string;
  render(props: { shopId: string; item: Item; canWrite: boolean }): ReactNode;
}
export const detailExtensions: DetailExtension[] = [];

type TabId = 'details' | 'variants' | 'related' | 'stock' | 'history' | string;

/** The detail panel (plan 5.13): everything about one product, beside the grid. */
export function DetailPanel({
  shopId,
  productId,
  onClose,
}: {
  shopId: string;
  productId: string;
  onClose(): void;
}) {
  const item = useItem(shopId, productId);
  const schema = useCatalogSchema(shopId);
  const context = useShopContext(shopId);
  const canWrite = can(context.data, 'catalog.write');
  const [tab, setTab] = useState<TabId>('details');

  useEffect(() => {
    telemetry.track(
      shopId,
      'detail_panel.opened',
      { tab: 'details' },
      { type: 'product', id: productId },
    );
    return () =>
      telemetry.track(shopId, 'detail_panel.closed', undefined, { type: 'product', id: productId });
  }, [shopId, productId]);

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'details', label: 'Details' },
    {
      id: 'variants',
      label: `Variants${item.data ? ` (${item.data.variants.filter((v) => v.status === 'active').length})` : ''}`,
    },
    ...detailExtensions.map((e) => ({ id: e.id, label: e.label })),
    { id: 'related', label: 'Related' },
    { id: 'stock', label: 'Stock' },
    { id: 'history', label: 'History' },
  ];
  return (
    <aside className="detail-panel" aria-label="Product details">
      <div className="detail-head">
        <div>
          <h2>{item.data?.product.name ?? 'Loading…'}</h2>
          {item.data ? (
            <span className="muted">
              {item.data.product.family?.name ?? 'No family'} ·{' '}
              <Badge tone={item.data.product.status === 'active' ? 'ok' : 'muted'}>
                {item.data.product.status}
              </Badge>
            </span>
          ) : null}
        </div>
        <button type="button" className="ghost small" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="detail-body">
        <ErrorNotice error={item.error} />
        {item.isPending || schema.isPending ? <Loading /> : null}
        {item.data && schema.data ? (
          tab === 'details' ? (
            <DetailsTab shopId={shopId} item={item.data} schema={schema.data} canWrite={canWrite} />
          ) : tab === 'variants' ? (
            <VariantsTab
              shopId={shopId}
              item={item.data}
              schema={schema.data}
              canWrite={canWrite}
            />
          ) : tab === 'related' ? (
            <RelatedTab shopId={shopId} item={item.data} schema={schema.data} canWrite={canWrite} />
          ) : tab === 'stock' ? (
            <StockTab shopId={shopId} item={item.data} />
          ) : tab === 'history' ? (
            <HistoryTab shopId={shopId} item={item.data} />
          ) : (
            detailExtensions
              .find((e) => e.id === tab)
              ?.render({ shopId, item: item.data, canWrite })
          )
        ) : null}
      </div>
    </aside>
  );
}

// Field editing ----------------------------------------------------------------------------

function useSaveField(shopId: string, productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (change: {
      variantId?: string;
      field: string;
      expected: unknown;
      value?: unknown;
      inherit?: boolean;
    }) =>
      command<{ item: Item }>(`/shops/${shopId}/items/${productId}/changes`, { changes: [change] }),
    onSuccess: (result) => {
      queryClient.setQueryData(['shop', shopId, 'item', productId], result.item);
      void queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'items'] });
    },
  });
}

/** One field: its value, where it comes from, and an inline editor with compare-and-set. */
function FieldRow({
  shopId,
  productId,
  column,
  value,
  variantId,
  schema,
  canWrite,
  required,
}: {
  shopId: string;
  productId: string;
  column: Column;
  value: FieldValue;
  variantId?: string;
  schema: CatalogSchema;
  canWrite: boolean;
  required?: boolean;
}) {
  const save = useSaveField(shopId, productId);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ theirs: unknown } | null>(null);
  const editable = canWrite && column.editable;
  const rich = column.field?.type === 'rich_text' || column.key === 'description';
  const submit = async (e?: FormEvent, opts: { expected?: unknown; inherit?: boolean } = {}) => {
    e?.preventDefault();
    if (draft === null && !opts.inherit) return;
    let next: unknown;
    if (!opts.inherit) {
      const parsed =
        column.key === 'description'
          ? ({ ok: true, value: draft } as const)
          : parseInput(column, draft!, schema);
      if (!parsed.ok) {
        setError(parsed.message);
        return;
      }
      next = parsed.value;
    }
    try {
      await save.mutateAsync({
        ...(variantId ? { variantId } : {}),
        field: column.key,
        expected: opts.expected !== undefined ? opts.expected : value.value,
        ...(opts.inherit ? { inherit: true } : { value: next }),
      });
      setDraft(null);
      setError(null);
      setConflict(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'edit_conflict') {
        const c = (err.problem.conflicts as Array<{ current: unknown }>)[0];
        setConflict({ theirs: c?.current ?? null });
      } else setError(errorMessage(err));
    }
  };
  const display =
    value.display ?? (value.value === null ? '' : editText(column, value.value, schema));
  return (
    <div className={`field-row${value.source === 'inherited' ? ' inherited' : ''}`}>
      <div className="field-row-label">
        {column.label}
        {required ? (
          <span className="required" title="Required in this family">
            {' '}
            *
          </span>
        ) : null}
        {value.source === 'inherited' ? <span className="muted"> · inherited</span> : null}
        {value.source === 'cleared' ? (
          <span className="muted"> · cleared on this variant</span>
        ) : null}
      </div>
      {draft === null ? (
        <div className="field-row-value">
          {rich && typeof value.value === 'string' ? (
            <RichText text={value.value} />
          ) : (
            <span>{display || <span className="muted">—</span>}</span>
          )}
          {editable ? (
            <span className="field-row-actions">
              <button
                type="button"
                className="small ghost"
                onClick={() => setDraft(editText(column, value.value, schema))}
              >
                Edit
              </button>
              {variantId &&
              value.source !== 'inherited' &&
              value.source !== 'none' &&
              column.field?.level === 'both' ? (
                <button
                  type="button"
                  className="small ghost"
                  onClick={() => void submit(undefined, { inherit: true })}
                >
                  Inherit
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : (
        <form className="field-row-edit" onSubmit={(e) => void submit(e)}>
          {rich ? (
            <textarea
              aria-label={column.label}
              value={draft}
              rows={5}
              onChange={(e) => setDraft(e.target.value)}
            />
          ) : column.kind === 'select' && column.field ? (
            <select
              aria-label={column.label}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            >
              <option value="">—</option>
              {column.field.options
                .filter((o) => !o.archived || o.id === value.value)
                .map((o) => (
                  <option key={o.id} value={o.label}>
                    {o.label}
                  </option>
                ))}
            </select>
          ) : column.kind === 'family' ? (
            <select
              aria-label={column.label}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            >
              <option value="">No family</option>
              {schema.families.map((f) => (
                <option key={f.id} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
          ) : column.kind === 'boolean' ? (
            <select
              aria-label={column.label}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            >
              <option value="">—</option>
              <option value="Yes">Yes</option>
              <option value="No">No</option>
            </select>
          ) : (
            <input
              aria-label={column.label}
              type={column.kind === 'date' ? 'date' : 'text'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                column.kind === 'measurement'
                  ? 'such as 1.2 kg'
                  : column.kind === 'multi'
                    ? 'labels separated by ;'
                    : ''
              }
            />
          )}
          <button type="submit" className="small" disabled={save.isPending}>
            Save
          </button>
          <button
            type="button"
            className="small ghost"
            onClick={() => {
              setDraft(null);
              setError(null);
              setConflict(null);
            }}
          >
            Cancel
          </button>
        </form>
      )}
      {error ? <p className="field-error">{error}</p> : null}
      {conflict ? (
        <p className="notice">
          Someone changed this to “{editText(column, conflict.theirs, schema) || 'empty'}” since you
          opened it.{' '}
          <button
            type="button"
            className="small"
            onClick={() => void submit(undefined, { expected: conflict.theirs })}
          >
            Keep mine
          </button>{' '}
          <button
            type="button"
            className="small ghost"
            onClick={() => {
              setDraft(null);
              setConflict(null);
            }}
          >
            Take theirs
          </button>
        </p>
      ) : null}
    </div>
  );
}

const DESCRIPTION: Column = {
  key: 'description',
  label: 'Description',
  kind: 'text',
  level: 'product',
  editable: true,
  sortable: false,
  defaultWidth: 200,
  builtin: true,
};
const STATUS: Column = { ...DESCRIPTION, key: 'status', label: 'Status', kind: 'text' };
const DIMENSIONS: Column = { ...DESCRIPTION, key: 'dimensions', label: 'Dimensions', kind: 'text' };

function DetailsTab({
  shopId,
  item,
  schema,
  canWrite,
}: {
  shopId: string;
  item: Item;
  schema: CatalogSchema;
  canWrite: boolean;
}) {
  const cols = columnsFor('products', schema, canWrite);
  const byKey = new Map(cols.map((c) => [c.key, c]));
  const p = item.product;
  const own = (value: unknown, display?: string | null): FieldValue => ({
    value,
    display: display ?? null,
    source: value === null || value === undefined ? 'none' : 'own',
  });
  const family = schema.families.find((f) => f.id === p.family?.id);
  const familyKeys = new Set(family?.fields.map((f) => f.key) ?? []);
  const groups = new Map<string, Array<{ key: string; required: boolean }>>();
  for (const f of family?.fields ?? []) {
    const def = schema.fields.find((x) => x.key === f.key);
    if (!def || def.level === 'variant') continue;
    const name = f.group ?? 'Details';
    groups.set(name, [...(groups.get(name) ?? []), { key: f.key, required: f.required }]);
  }
  const others = Object.keys(p.fields).filter((k) => !familyKeys.has(k));
  const [adding, setAdding] = useState('');
  const addable = schema.fields.filter(
    (f) =>
      f.status === 'active' &&
      f.level !== 'variant' &&
      !(f.key in p.fields) &&
      !familyKeys.has(f.key) &&
      f.type !== 'file',
  );
  const row = (key: string, required = false) => {
    const column = byKey.get(key);
    if (!column) return null;
    return (
      <FieldRow
        key={key}
        shopId={shopId}
        productId={p.id}
        column={column}
        value={p.fields[key] ?? own(null)}
        schema={schema}
        canWrite={canWrite}
        required={required}
      />
    );
  };
  const weight = p.weight as { value: string; unit: string } | null;
  const dims = p.dimensions as {
    length: string;
    width: string;
    height: string;
    unit: string;
  } | null;
  return (
    <div className="stack">
      <section className="field-group">
        <FieldRow
          shopId={shopId}
          productId={p.id}
          column={byKey.get('name')!}
          value={own(p.name, p.name)}
          schema={schema}
          canWrite={canWrite}
        />
        <FieldRow
          shopId={shopId}
          productId={p.id}
          column={{ ...STATUS, editable: p.status !== 'archived' }}
          value={own(p.status, p.status)}
          schema={schema}
          canWrite={canWrite}
        />
        <FieldRow
          shopId={shopId}
          productId={p.id}
          column={byKey.get('family')!}
          value={own(p.family?.id ?? null, p.family?.name ?? null)}
          schema={schema}
          canWrite={canWrite}
        />
        <FieldRow
          shopId={shopId}
          productId={p.id}
          column={byKey.get('tags')!}
          value={own(p.tags.length ? p.tags : null, p.tags.join(', ') || null)}
          schema={schema}
          canWrite={canWrite}
        />
        <FieldRow
          shopId={shopId}
          productId={p.id}
          column={DESCRIPTION}
          value={own(p.description)}
          schema={schema}
          canWrite={canWrite}
        />
        <FieldRow
          shopId={shopId}
          productId={p.id}
          column={{ ...DESCRIPTION, key: 'weight', label: 'Weight', kind: 'measurement' }}
          value={own(p.weight, weight ? `${formatDecimal(weight.value)} ${weight.unit}` : null)}
          schema={schema}
          canWrite={canWrite}
        />
        <FieldRow
          shopId={shopId}
          productId={p.id}
          column={DIMENSIONS}
          value={own(
            p.dimensions,
            dims ? `${dims.length} × ${dims.width} × ${dims.height} ${dims.unit}` : null,
          )}
          schema={schema}
          canWrite={canWrite}
        />
      </section>
      {[...groups.entries()].map(([name, list]) => (
        <section key={name} className="field-group">
          <h3>{name}</h3>
          {list.map((f) => row(f.key, f.required))}
        </section>
      ))}
      {others.length > 0 ? (
        <section className="field-group">
          <h3>Other fields</h3>
          {others.map((k) => row(k))}
        </section>
      ) : null}
      {canWrite && addable.length > 0 ? (
        <div className="inline-form">
          <Field label="Add a value for another field">
            <select value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Choose a field…</option>
              {addable.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          {adding ? row(adding) : null}
        </div>
      ) : null}
    </div>
  );
}

// Variants ---------------------------------------------------------------------------------

function VariantsTab({
  shopId,
  item,
  schema,
  canWrite,
}: {
  shopId: string;
  item: Item;
  schema: CatalogSchema;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'item', item.product.id] });
    void queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'items'] });
  };
  const status = useMutation({
    mutationFn: (v: { id: string; archive: boolean }) =>
      command(`/shops/${shopId}/variants/${v.id}/${v.archive ? 'archive' : 'restore'}`, {}),
    onSuccess: refresh,
  });
  const [open, setOpen] = useState<string | null>(null);
  const variantColumns = columnsFor('variants', schema, canWrite).filter(
    (c) => c.level === 'variant' && c.editable && c.key !== 'sku',
  );
  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>Options</th>
              <th>SKU</th>
              <th className="num">Price</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {item.variants.map((v) => (
              <tr key={v.id} className={v.status === 'archived' ? 'muted' : ''}>
                <td>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setOpen(open === v.id ? null : v.id)}
                  >
                    {v.title || 'Default'}
                  </button>
                </td>
                <td>
                  <code>{v.sku}</code>
                </td>
                <td className="num">{formatDecimal(v.price, 2)}</td>
                <td>
                  <Badge tone={v.status === 'active' ? 'ok' : 'muted'}>{v.status}</Badge>
                </td>
                <td>
                  {canWrite ? (
                    <button
                      type="button"
                      className="small ghost"
                      onClick={() => status.mutate({ id: v.id, archive: v.status === 'active' })}
                    >
                      {v.status === 'active' ? 'Archive' : 'Restore'}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorNotice error={status.error} />
      {open
        ? (() => {
            const v = item.variants.find((x) => x.id === open)!;
            const own = (value: unknown, display: string | null = null) =>
              ({ value, display, source: value === null ? 'none' : 'own' }) as FieldValue;
            const w = v.weight.value as { value: string; unit: string } | null;
            const skuColumn = columnsFor('variants', schema, canWrite).find(
              (c) => c.key === 'sku',
            )!;
            return (
              <section className="field-group">
                <h3>{v.title || 'Default variant'}</h3>
                <FieldRow
                  shopId={shopId}
                  productId={item.product.id}
                  variantId={v.id}
                  column={skuColumn}
                  value={own(v.sku, v.sku)}
                  schema={schema}
                  canWrite={canWrite}
                />
                <FieldRow
                  shopId={shopId}
                  productId={item.product.id}
                  variantId={v.id}
                  column={columnsFor('variants', schema, canWrite).find((c) => c.key === 'price')!}
                  value={own(v.price, v.price ? formatDecimal(v.price, 2) : null)}
                  schema={schema}
                  canWrite={canWrite}
                />
                <FieldRow
                  shopId={shopId}
                  productId={item.product.id}
                  variantId={v.id}
                  column={{
                    ...columnsFor('variants', schema, canWrite).find((c) => c.key === 'weight')!,
                    field: undefined,
                  }}
                  value={{
                    value: v.weight.value,
                    display: w ? `${formatDecimal(w.value)} ${w.unit}` : null,
                    source: v.weight.source,
                  }}
                  schema={schema}
                  canWrite={canWrite}
                />
                {variantColumns
                  .filter((c) => !c.builtin)
                  .map((c) => (
                    <FieldRow
                      key={c.key}
                      shopId={shopId}
                      productId={item.product.id}
                      variantId={v.id}
                      column={c}
                      value={v.fields[c.key] ?? { value: null, display: null, source: 'none' }}
                      schema={schema}
                      canWrite={canWrite}
                    />
                  ))}
              </section>
            );
          })()
        : null}
      {canWrite ? (
        <GenerateVariants shopId={shopId} item={item} schema={schema} onDone={refresh} />
      ) : null}
    </div>
  );
}

type Generated = Out<typeof ops.generateVariants>;

function GenerateVariants({
  shopId,
  item,
  schema,
  onDone,
}: {
  shopId: string;
  item: Item;
  schema: CatalogSchema;
  onDone(): void;
}) {
  const family = schema.families.find((f) => f.id === item.product.family?.id);
  const initial =
    item.options.length > 0
      ? item.options.map((o) => ({ name: o.name, values: o.values.map((v) => v.label).join(', ') }))
      : (family?.suggestedOptions ?? []).slice(0, 2).map((o) => ({ name: o.name, values: '' }));
  const [options, setOptions] = useState(initial.length ? initial : [{ name: 'Size', values: '' }]);
  const [pattern, setPattern] = useState('');
  const [price, setPrice] = useState('');
  const [preview, setPreview] = useState<Generated | null>(null);
  const body = (mode: 'preview' | 'create') => ({
    options: options
      .filter((o) => o.name.trim() && o.values.trim())
      .map((o) => ({
        name: o.name.trim(),
        values: o.values
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      })),
    ...(pattern ? { skuPattern: pattern } : {}),
    ...(price ? { price } : {}),
    mode,
  });
  const run = useMutation({
    mutationFn: (mode: 'preview' | 'create') =>
      command<Generated>(
        `/shops/${shopId}/products/${item.product.id}/variants/generate`,
        body(mode),
      ),
    onSuccess: (result) => {
      if (result.mode === 'create') {
        setPreview(null);
        onDone();
      } else setPreview(result);
    },
  });
  return (
    <section className="field-group">
      <h3>Options and variants</h3>
      <p className="muted">
        Up to three options. Existing variants keep their SKU, stock, and history; the preview shows
        every combination before anything is created.
      </p>
      {options.map((o, i) => (
        <div className="inline-form" key={i}>
          <Field label="Option">
            <input
              value={o.name}
              onChange={(e) =>
                setOptions(options.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
              }
            />
          </Field>
          <Field label="Values, separated by commas">
            <input
              value={o.values}
              placeholder={
                family?.suggestedOptions.find((s) => s.name === o.name)?.values.join(', ') ??
                'S, M, L'
              }
              onChange={(e) =>
                setOptions(options.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))
              }
            />
          </Field>
        </div>
      ))}
      <div className="form-actions">
        {options.length < 3 ? (
          <button
            type="button"
            className="small ghost"
            onClick={() => setOptions([...options, { name: '', values: '' }])}
          >
            Add option
          </button>
        ) : null}
      </div>
      <div className="inline-form">
        <Field label="SKU pattern">
          <input value={pattern} onChange={(e) => setPattern(e.target.value)} />
        </Field>
        <Field label="Price for new variants">
          <input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <button
          type="button"
          className="ghost"
          onClick={() => run.mutate('preview')}
          disabled={run.isPending}
        >
          Preview
        </button>
        <p className="fine">{'Option names in braces, such as TS-{colour}-{size}.'}</p>
      </div>
      <ErrorNotice error={run.error} />
      {preview ? (
        <>
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Combination</th>
                  <th>SKU</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {preview.combinations.map((c) => (
                  <tr key={Object.values(c.optionValues).join('/')}>
                    <td>{Object.values(c.optionValues).join(' / ')}</td>
                    <td>
                      <code>{c.sku}</code>
                    </td>
                    <td>
                      {c.duplicate ? (
                        <Badge tone="error">SKU taken</Badge>
                      ) : c.state === 'new' ? (
                        <Badge tone="ok">new</Badge>
                      ) : (
                        <Badge>{c.state}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <button
              type="button"
              onClick={() => run.mutate('create')}
              disabled={
                run.isPending ||
                preview.combinations.some((c) => c.duplicate) ||
                !preview.combinations.some((c) => c.state === 'new')
              }
            >
              Create {preview.combinations.filter((c) => c.state === 'new').length} variants
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

// Related, stock, history -------------------------------------------------------------------

function RelatedTab({
  shopId,
  item,
  schema,
  canWrite,
}: {
  shopId: string;
  item: Item;
  schema: CatalogSchema;
  canWrite: boolean;
}) {
  const relationFields = schema.fields.filter(
    (f) => f.type === 'relationship' && f.status === 'active',
  );
  const productRelations = relationFields.filter((f) => f.level === 'product');
  return (
    <div className="stack">
      {relationFields.length === 0 ? (
        <Empty>No relationship fields yet. Add one in Settings, such as “Compatible with”.</Empty>
      ) : null}
      {productRelations.map((f) => (
        <RelationEditor
          key={f.key}
          shopId={shopId}
          productId={item.product.id}
          label={f.label}
          field={f.key}
          targets={(item.product.fields[f.key]?.value as string[] | null) ?? []}
          canWrite={canWrite}
        />
      ))}
      {relationFields
        .filter((f) => f.level === 'variant')
        .flatMap((f) =>
          item.variants
            .filter((v) => v.status === 'active')
            .map((v) => (
              <RelationEditor
                key={`${f.key}:${v.id}`}
                shopId={shopId}
                productId={item.product.id}
                variantId={v.id}
                label={`${f.label} · ${v.sku}`}
                field={f.key}
                targets={(v.fields[f.key]?.value as string[] | null) ?? []}
                targetType="variant"
                canWrite={canWrite}
              />
            )),
        )}
      <section className="field-group">
        <h3>Pointing here</h3>
        {item.incoming.length === 0 ? (
          <p className="muted">No other record links to this one.</p>
        ) : (
          <ul className="plain-list">
            {item.incoming.map((r) => (
              <li key={`${r.field}:${r.sourceId}:${r.targetId}`}>
                <strong>{r.sourceName}</strong>{' '}
                <span className="muted">{(r.relationKind ?? r.field).replaceAll('_', ' ')}</span>{' '}
                this
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type QueryResult = Out<typeof ops.queryItems>;

function RelationEditor(props: {
  shopId: string;
  productId: string;
  variantId?: string;
  label: string;
  field: string;
  targets: string[];
  targetType?: 'product' | 'variant';
  canWrite: boolean;
}) {
  const save = useSaveField(props.shopId, props.productId);
  const [search, setSearch] = useState('');
  const names = useQuery({
    queryKey: ['shop', props.shopId, 'relation-names', props.targets],
    queryFn: async () =>
      Promise.all(
        props.targets.slice(0, 20).map(async (id) => {
          const res = await api<Out<typeof ops.getItem>>(`/shops/${props.shopId}/items/detail`, {
            query: props.targetType === 'variant' ? { variantId: id } : { productId: id },
          }).catch(() => null);
          const v = res?.item.variants.find((x) => x.id === id);
          return {
            id,
            name: res ? `${res.item.product.name}${v ? ` · ${v.sku}` : ''}` : id.slice(-8),
          };
        }),
      ),
    enabled: props.targets.length > 0,
  });
  const found = useQuery({
    queryKey: ['shop', props.shopId, 'relation-search', search],
    queryFn: () =>
      api<QueryResult>(`/shops/${props.shopId}/items/query`, {
        method: 'POST',
        body: { search, mode: props.targetType === 'variant' ? 'variants' : 'products', limit: 8 },
      }),
    enabled: search.trim().length >= 2,
  });
  const set = (targets: string[]) =>
    save.mutate({
      ...(props.variantId ? { variantId: props.variantId } : {}),
      field: props.field,
      expected: props.targets.length ? props.targets : null,
      value: targets,
    });
  return (
    <section className="field-group">
      <h3>{props.label}</h3>
      {props.targets.length === 0 ? <p className="muted">None.</p> : null}
      <ul className="plain-list">
        {(names.data ?? props.targets.map((id) => ({ id, name: '…' }))).map((t) => (
          <li key={t.id}>
            {t.name}
            {props.canWrite ? (
              <button
                type="button"
                className="small ghost"
                onClick={() => set(props.targets.filter((x) => x !== t.id))}
              >
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {props.canWrite ? (
        <>
          <input
            type="search"
            value={search}
            placeholder="Find a product to link"
            onChange={(e) => setSearch(e.target.value)}
            aria-label={`Link to ${props.label}`}
          />
          <ul className="plain-list">
            {(found.data?.rows ?? [])
              .filter(
                (r) =>
                  (props.targetType === 'variant' ? r.variantId : r.productId) !==
                  (props.variantId ?? props.productId),
              )
              .map((r) => {
                const id = (props.targetType === 'variant' ? r.variantId : r.productId)!;
                return (
                  <li key={id}>
                    {r.name} {r.sku ? <code>{r.sku}</code> : null}
                    <button
                      type="button"
                      className="small"
                      disabled={props.targets.includes(id)}
                      onClick={() => set([...props.targets, id])}
                    >
                      Link
                    </button>
                  </li>
                );
              })}
          </ul>
        </>
      ) : null}
      <ErrorNotice error={save.error} />
    </section>
  );
}

function StockTab({ shopId, item }: { shopId: string; item: Item }) {
  const active = item.variants.filter((v) => v.status === 'active');
  const [variantId, setVariantId] = useState(active[0]?.id ?? '');
  if (active.length === 0) return <Empty>No active variants.</Empty>;
  return (
    <div className="stack">
      {active.length > 1 ? (
        <Field label="Variant">
          <select value={variantId} onChange={(e) => setVariantId(e.target.value)}>
            {active.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title || 'Default'} · {v.sku}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <StockPanel shopId={shopId} variantId={variantId} title="Stock by location" />
      <ReorderRulesPanel shopId={shopId} variantId={variantId} />
      {active.find((v) => v.id === variantId) ? (
        <StockSettingsForm
          key={variantId}
          shopId={shopId}
          productId={item.product.id}
          variant={active.find((v) => v.id === variantId)!}
        />
      ) : null}
    </div>
  );
}

function HistoryTab({ shopId, item }: { shopId: string; item: Item }) {
  const [target, setTarget] = useState<{ type: string; id: string }>({
    type: 'product',
    id: item.product.id,
  });
  const activity = useActivity(shopId, { targetType: target.type, targetId: target.id });
  const events = activity.data?.pages.flatMap((p) => p.events) ?? [];
  return (
    <div className="stack">
      <Field label="History of">
        <select
          value={`${target.type}:${target.id}`}
          onChange={(e) => {
            const [type, id] = e.target.value.split(':');
            setTarget({ type: type!, id: id! });
          }}
        >
          <option value={`product:${item.product.id}`}>The product</option>
          {item.variants.map((v) => (
            <option key={v.id} value={`variant:${v.id}`}>
              Variant {v.title || ''} · {v.sku}
            </option>
          ))}
        </select>
      </Field>
      <ErrorNotice error={activity.error} />
      {activity.isPending ? (
        <Loading />
      ) : events.length === 0 ? (
        <Notice>No history yet.</Notice>
      ) : (
        <ActivityTable shopId={shopId} events={events} />
      )}
      {activity.hasNextPage ? (
        <button type="button" className="ghost small" onClick={() => void activity.fetchNextPage()}>
          Older
        </button>
      ) : null}
    </div>
  );
}
