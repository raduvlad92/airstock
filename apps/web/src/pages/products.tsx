import type { ops } from '@airstock/core';
import { LABEL_LIMITS } from '@airstock/core/labels';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, command, type Out } from '../api.ts';
import { BulkDialog } from '../catalog/bulk.tsx';
import { DetailPanel } from '../catalog/detail.tsx';
import { type Condition, describeCondition, FilterEditor } from '../catalog/filters.tsx';
import { Gallery } from '../catalog/gallery.tsx';
import { type BulkEdit, Grid } from '../catalog/grid.tsx';
import {
  type Column,
  columnsFor,
  DEFAULT_COLUMNS,
  type Mode,
  useCatalogSchema,
} from '../catalog/schema.ts';
import { type CellValue, type Row, requestedFields } from '../catalog/values.ts';
import { ErrorNotice, Field, Notice } from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';
import { telemetry } from '../telemetry.ts';
import { ExportButton } from './imports.tsx';

type QueryResult = Out<typeof ops.queryItems>;
type SavedViews = Out<typeof ops.listSavedViews>;

interface Layout {
  columns: string[];
  hidden: string[];
  widths: Record<string, number>;
}

interface Prefs {
  mode: Mode;
  viewType: 'grid' | 'gallery';
  density: 'compact' | 'comfortable';
  layouts: Record<Mode, Layout>;
}

const DEFAULT_PREFS: Prefs = {
  mode: 'variants',
  viewType: 'grid',
  density: 'compact',
  layouts: {
    variants: { columns: DEFAULT_COLUMNS.variants, hidden: [], widths: {} },
    products: { columns: DEFAULT_COLUMNS.products, hidden: [], widths: {} },
  },
};

/** Per-viewer conveniences only; the page works the same without storage. */
function loadPrefs(shopId: string): Prefs {
  try {
    const raw = localStorage.getItem(`airstock.products.${shopId}`);
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    // Storage blocked or unreadable.
  }
  return DEFAULT_PREFS;
}

function savePrefs(shopId: string, prefs: Prefs) {
  try {
    localStorage.setItem(`airstock.products.${shopId}`, JSON.stringify(prefs));
  } catch {
    // Storage blocked or full: preferences last for this page only.
  }
}

export function ProductsPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const search = useSearch({ strict: false }) as { item?: string };
  const navigate = useNavigate();
  const context = useShopContext(shopId);
  const schema = useCatalogSchema(shopId);
  const canWrite = can(context.data, 'catalog.write');
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(shopId));
  const [text, setText] = useState('');
  const [searchText, setSearchText] = useState('');
  const [filter, setFilter] = useState<Condition[]>([]);
  const [sort, setSort] = useState<{ field: string; direction: 'asc' | 'desc' } | null>(null);
  const [panel, setPanel] = useState<'filters' | 'columns' | 'views' | 'create' | null>(null);
  const [bulk, setBulk] = useState<BulkEdit[] | null>(null);
  const [overrides, setOverrides] = useState<Map<string, CellValue>>(new Map());
  const [viewId, setViewId] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<Row[]>([]);
  const mode = prefs.mode;
  const layout = prefs.layouts[mode];

  useEffect(() => savePrefs(shopId, prefs), [shopId, prefs]);
  useEffect(() => {
    const t = setTimeout(() => setSearchText(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const allColumns = useMemo(
    () => columnsFor(mode, schema.data, canWrite),
    [mode, schema.data, canWrite],
  );
  const visible = useMemo(() => {
    const byKey = new Map(allColumns.map((c) => [c.key, c]));
    const ordered = layout.columns.map((k) => byKey.get(k)).filter((c): c is Column => Boolean(c));
    const shown = ordered.filter((c) => !layout.hidden.includes(c.key));
    // The name column is always first and frozen.
    const name = byKey.get('name')!;
    return [name, ...shown.filter((c) => c.key !== 'name')];
  }, [allColumns, layout]);
  const fields = useMemo(() => requestedFields(visible), [visible]);

  const body = {
    mode,
    search: searchText || undefined,
    filter,
    sort: sort ?? undefined,
    fields: [...new Set([...fields, ...(mode === 'variants' ? ['available'] : [])])],
    limit: 50,
  };
  const bodyKey = JSON.stringify(body);
  const query = useInfiniteQuery({
    queryKey: ['shop', shopId, 'items', body],
    queryFn: ({ pageParam }) =>
      api<QueryResult>(`/shops/${shopId}/items/query`, {
        method: 'POST',
        body: { ...body, ...(pageParam ? { cursor: pageParam } : {}) },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(schema.data),
    staleTime: 30_000,
  });
  // Saved cells show their new value until fresh rows arrive; fresh rows already include it.
  useEffect(() => setOverrides(new Map()), [bodyKey, query.dataUpdatedAt]);
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const first = query.data?.pages[0];
  const total = first?.total ?? null;
  const rowCount =
    total !== null && !first?.totalCapped ? total : rows.length + (query.hasNextPage ? 50 : 0);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const needMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Label printing takes variants; at most the labels page's limit of entries.
  const onSelectRows = useCallback((r: Row[]) => setSelectedRows(r), []);
  const selected = useMemo(
    () =>
      [
        ...new Map(selectedRows.filter((r) => r.variantId).map((r) => [r.variantId, r])).values(),
      ].slice(0, LABEL_LIMITS.entries),
    [selectedRows],
  );

  const update = (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch }));
  const updateLayout = (patch: Partial<Layout>) =>
    setPrefs((p) => ({
      ...p,
      layouts: { ...p.layouts, [mode]: { ...p.layouts[mode], ...patch } },
    }));

  const open = (row: Row) =>
    void navigate({
      to: '/shops/$shopId/products',
      params: { shopId },
      search: { item: row.productId },
    });
  const close = () =>
    void navigate({ to: '/shops/$shopId/products', params: { shopId }, search: {} });

  const onSort = (field: string) => {
    setSort((s) =>
      s?.field === field
        ? s.direction === 'asc'
          ? { field, direction: 'desc' }
          : null
        : { field, direction: 'asc' },
    );
  };

  const switchView = (viewType: 'grid' | 'gallery') => {
    update({ viewType });
    telemetry.track(shopId, 'view.type_switched', { to: viewType, mode });
  };

  const views = useQuery({
    queryKey: ['shop', shopId, 'saved-views'],
    queryFn: () => api<SavedViews>(`/shops/${shopId}/saved-views`),
  });
  const applyView = (id: string) => {
    const view = views.data?.views.find((v) => v.id === id);
    setViewId(id || null);
    if (!view) return;
    const d = view.definition;
    setPrefs((p) => ({
      ...p,
      mode: d.mode,
      viewType: d.viewType,
      density: d.density,
      layouts: d.columns.length
        ? {
            ...p.layouts,
            [d.mode]: {
              columns: d.columns.map((c) => c.key),
              hidden: d.columns.filter((c) => c.hidden).map((c) => c.key),
              widths: Object.fromEntries(
                d.columns.filter((c) => c.width).map((c) => [c.key, c.width!]),
              ),
            },
          }
        : p.layouts,
    }));
    setFilter((d.filter as Condition[] | undefined) ?? []);
    setSort(d.sort ?? null);
    setText(d.search ?? '');
  };

  return (
    <div className={`products-page${search.item ? ' with-panel' : ''}`}>
      <div className="products-main">
        <div className="toolbar">
          <fieldset className="segmented" aria-label="Rows">
            {(['variants', 'products'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={mode === m ? 'on' : ''}
                aria-pressed={mode === m}
                onClick={() => update({ mode: m })}
              >
                {m === 'variants' ? 'Variants' : 'Products'}
              </button>
            ))}
          </fieldset>
          <fieldset className="segmented" aria-label="View">
            {(['grid', 'gallery'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={prefs.viewType === v ? 'on' : ''}
                aria-pressed={prefs.viewType === v}
                onClick={() => switchView(v)}
              >
                {v === 'grid' ? 'Grid' : 'Gallery'}
              </button>
            ))}
          </fieldset>
          <input
            type="search"
            className="toolbar-search"
            aria-label="Search products"
            placeholder="Search name, SKU, description"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="button"
            className={`ghost small${filter.length ? ' active-filter' : ''}`}
            onClick={() => setPanel(panel === 'filters' ? null : 'filters')}
          >
            Filters{filter.length ? ` (${filter.length})` : ''}
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={() => setPanel(panel === 'columns' ? null : 'columns')}
          >
            Columns
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={() => setPanel(panel === 'views' ? null : 'views')}
          >
            Views{viewId ? ` · ${views.data?.views.find((v) => v.id === viewId)?.name ?? ''}` : ''}
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={() =>
              update({ density: prefs.density === 'compact' ? 'comfortable' : 'compact' })
            }
          >
            {prefs.density === 'compact' ? 'Comfortable' : 'Compact'}
          </button>
          <span className="toolbar-count muted">
            {total === null
              ? ''
              : `${first?.totalCapped ? '10,000+' : total.toLocaleString()} ${mode}`}
          </span>
          {can(context.data, 'exports.run') ? (
            <ExportButton
              key={bodyKey}
              shopId={shopId}
              query={{
                mode,
                ...(searchText ? { search: searchText } : {}),
                filter,
                ...(sort ? { sort } : {}),
              }}
            />
          ) : null}
          {can(context.data, 'imports.run') ? (
            <Link to="/shops/$shopId/imports" params={{ shopId }} className="button-link small">
              Import
            </Link>
          ) : null}
          {prefs.viewType === 'grid' && mode === 'variants' && selected.length > 0 ? (
            <Link
              to="/shops/$shopId/labels"
              params={{ shopId }}
              search={{ variants: selected.map((r) => r.variantId).join(',') }}
              className="button-link small"
              title="Labels for the selected rows"
            >
              Print labels ({selected.length})
            </Link>
          ) : null}
          {canWrite ? (
            <button
              type="button"
              className="small"
              onClick={() => setPanel(panel === 'create' ? null : 'create')}
            >
              Add product
            </button>
          ) : null}
        </div>
        {filter.length > 0 && panel !== 'filters' ? (
          <div className="chips filter-chips">
            {filter.map((c, i) => (
              <span key={i} className="badge">
                {describeCondition(c, allColumns)}
              </span>
            ))}
            <button type="button" className="small ghost" onClick={() => setFilter([])}>
              Clear
            </button>
          </div>
        ) : null}
        {panel === 'filters' ? (
          <div className="toolbar-panel">
            <FilterEditor
              columns={allColumns}
              families={schema.data?.families ?? []}
              value={filter}
              onChange={(next) => {
                setFilter(next);
                setPanel(null);
              }}
            />
          </div>
        ) : null}
        {panel === 'columns' ? (
          <ColumnsPanel
            columns={allColumns}
            layout={layout}
            shopId={shopId}
            onChange={updateLayout}
          />
        ) : null}
        {panel === 'views' ? (
          <ViewsPanel
            shopId={shopId}
            views={views.data?.views ?? []}
            viewId={viewId}
            canShare={canWrite}
            onApply={applyView}
            current={{
              mode,
              viewType: prefs.viewType,
              density: prefs.density,
              columns: layout.columns.map((key) => ({
                key,
                ...(layout.widths[key] ? { width: layout.widths[key] } : {}),
                ...(layout.hidden.includes(key) ? { hidden: true } : {}),
              })),
              ...(sort ? { sort } : {}),
              ...(filter.length ? { filter } : {}),
              ...(text.trim() ? { search: text.trim() } : {}),
            }}
            onSaved={(id) => setViewId(id)}
          />
        ) : null}
        {panel === 'create' ? (
          <CreateProduct
            shopId={shopId}
            families={schema.data?.families ?? []}
            onCreated={(productId) => {
              setPanel(null);
              void navigate({
                to: '/shops/$shopId/products',
                params: { shopId },
                search: { item: productId },
              });
            }}
          />
        ) : null}
        <ErrorNotice error={query.error ?? schema.error} />
        {query.data && rows.length === 0 ? (
          <Notice>
            {searchText || filter.length
              ? 'Nothing matches. Change the search or filters.'
              : 'No products yet. Add one to start.'}
          </Notice>
        ) : null}
        {prefs.viewType === 'grid' ? (
          <Grid
            shopId={shopId}
            mode={mode}
            columns={visible}
            widths={layout.widths}
            rows={rows}
            rowCount={query.isPending ? 0 : rowCount}
            schema={schema.data}
            sort={sort}
            density={prefs.density}
            onSort={onSort}
            onNeedMore={needMore}
            onOpen={open}
            onResize={(key, width, done) => {
              updateLayout({ widths: { ...layout.widths, [key]: width } });
              if (done)
                telemetry.track(shopId, 'grid.column_resized', { column: key, width, mode });
            }}
            onReorder={(from, to) => {
              const order = layout.columns.filter((k) => k !== from);
              order.splice(order.indexOf(to), 0, from);
              updateLayout({ columns: order });
              telemetry.track(shopId, 'grid.column_order_changed', { order, mode });
            }}
            onBulk={setBulk}
            onSelectRows={onSelectRows}
            overrides={overrides}
            onSaved={(key, value) => setOverrides((m) => new Map(m).set(key, value))}
          />
        ) : (
          <Gallery
            shopId={shopId}
            mode={mode}
            rows={rows}
            hasMore={Boolean(query.hasNextPage)}
            onNeedMore={needMore}
            onOpen={open}
          />
        )}
      </div>
      {search.item ? (
        <DetailPanel key={search.item} shopId={shopId} productId={search.item} onClose={close} />
      ) : null}
      {bulk ? (
        <BulkDialog
          shopId={shopId}
          edits={bulk}
          schema={schema.data}
          onClose={() => setBulk(null)}
          onCommitted={() => {
            setBulk(null);
            void query.refetch();
          }}
        />
      ) : null}
    </div>
  );
}

function ColumnsPanel({
  shopId,
  columns,
  layout,
  onChange,
}: {
  shopId: string;
  columns: Column[];
  layout: Layout;
  onChange(patch: Partial<Layout>): void;
}) {
  const order = [
    ...layout.columns,
    ...columns.map((c) => c.key).filter((k) => !layout.columns.includes(k)),
  ];
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const shown = (key: string) => layout.columns.includes(key) && !layout.hidden.includes(key);
  const toggle = (key: string) => {
    const visible = !shown(key);
    onChange({
      columns: layout.columns.includes(key) ? layout.columns : [...layout.columns, key],
      hidden: visible ? layout.hidden.filter((k) => k !== key) : [...layout.hidden, key],
    });
    telemetry.track(shopId, 'grid.column_visibility_changed', { column: key, visible });
  };
  const shift = (key: string, by: number) => {
    const list = order.filter((k) => layout.columns.includes(k));
    const i = list.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    onChange({ columns: list });
    telemetry.track(shopId, 'grid.column_order_changed', { order: list });
  };
  return (
    <div className="toolbar-panel columns-panel">
      {order
        .filter((k) => byKey.has(k) && k !== 'name')
        .map((key) => (
          <div key={key} className="column-choice">
            <label className="check">
              <input type="checkbox" checked={shown(key)} onChange={() => toggle(key)} />
              {byKey.get(key)!.label}
            </label>
            {shown(key) ? (
              <span>
                <button
                  type="button"
                  className="small ghost"
                  aria-label={`Move ${byKey.get(key)!.label} earlier`}
                  onClick={() => shift(key, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="small ghost"
                  aria-label={`Move ${byKey.get(key)!.label} later`}
                  onClick={() => shift(key, 1)}
                >
                  ↓
                </button>
              </span>
            ) : null}
          </div>
        ))}
    </div>
  );
}

function ViewsPanel(props: {
  shopId: string;
  views: SavedViews['views'];
  viewId: string | null;
  canShare: boolean;
  current: SavedViews['views'][number]['definition'];
  onApply(id: string): void;
  onSaved(id: string): void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const selected = props.views.find((v) => v.id === props.viewId);
  const save = useMutation({
    mutationFn: (input: {
      viewId?: string;
      name: string;
      shared: boolean;
      expectedVersion?: number;
    }) =>
      command<{ view: { id: string } }>(`/shops/${props.shopId}/saved-views`, {
        ...input,
        definition: props.current,
      }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['shop', props.shopId, 'saved-views'] });
      props.onSaved(res.view.id);
      setName('');
    },
  });
  return (
    <div className="toolbar-panel">
      <div className="inline-form">
        <Field label="Saved views">
          <select value={props.viewId ?? ''} onChange={(e) => props.onApply(e.target.value)}>
            <option value="">Choose a view…</option>
            {props.views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.shared ? ' (shared)' : ''}
              </option>
            ))}
          </select>
        </Field>
        {selected && (selected.mine || props.canShare) ? (
          <button
            type="button"
            className="small ghost"
            onClick={() =>
              save.mutate({
                viewId: selected.id,
                name: selected.name,
                shared: selected.shared,
                expectedVersion: selected.version,
              })
            }
          >
            Update “{selected.name}”
          </button>
        ) : null}
      </div>
      <form
        className="inline-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate({ name, shared });
        }}
      >
        <Field label="Save the current layout, filters, and sort as">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </Field>
        {props.canShare ? (
          <label className="check">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />{' '}
            Share with the shop
          </label>
        ) : null}
        <button type="submit" className="small" disabled={save.isPending}>
          Save view
        </button>
      </form>
      <ErrorNotice error={save.error} />
    </div>
  );
}

/** Create with the duplicate check (plan 5.7): a similar name is shown before anything is created. */
function CreateProduct({
  shopId,
  families,
  onCreated,
}: {
  shopId: string;
  families: Array<{ id: string; name: string }>;
  onCreated(productId: string): void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [price, setPrice] = useState('');
  const [barcode, setBarcode] = useState('');
  const [family, setFamily] = useState('');
  const [status, setStatus] = useState<'active' | 'draft'>('active');
  const [similar, setSimilar] = useState<Array<{ productId: string; name: string }> | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);
  const create = useMutation({
    mutationFn: (acknowledgeSimilar: boolean) =>
      command<{ productId: string }>(`/shops/${shopId}/items`, {
        name,
        sku,
        ...(price ? { price } : {}),
        ...(barcode.trim() ? { barcode: barcode.trim() } : {}),
        ...(family ? { family } : {}),
        status,
        acknowledgeSimilar,
      }),
    onSuccess: async (res) => {
      setSimilar(null);
      await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'items'] });
      onCreated(res.productId);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'similar_items_found') {
        setSimilar(error.problem.similarNames as Array<{ productId: string; name: string }>);
      }
    },
  });
  return (
    <div className="toolbar-panel">
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(false);
        }}
      >
        <Field label="Name">
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={500}
          />
        </Field>
        <Field label="SKU">
          <input value={sku} onChange={(e) => setSku(e.target.value)} required maxLength={100} />
        </Field>
        <Field label="Price">
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Barcode">
          <input
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            maxLength={200}
            placeholder="Optional, such as an EAN-13"
          />
        </Field>
        <Field label="Family">
          <select value={family} onChange={(e) => setFamily(e.target.value)}>
            <option value="">None</option>
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'draft')}>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
          </select>
        </Field>
        <button type="submit" disabled={create.isPending}>
          Create
        </button>
      </form>
      {similar ? (
        <div className="notice">
          Products with similar names already exist:
          <ul>
            {similar.map((s) => (
              <li key={s.productId}>{s.name}</li>
            ))}
          </ul>
          <button type="button" className="small" onClick={() => create.mutate(true)}>
            It is a different product: create it
          </button>
        </div>
      ) : (
        <ErrorNotice error={create.error} />
      )}
    </div>
  );
}
