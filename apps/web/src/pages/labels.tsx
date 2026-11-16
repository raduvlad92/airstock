import type { ops } from '@airstock/core';
import {
  ITEM_LABEL_FIELDS,
  LABEL_FIELD_LABELS,
  LABEL_LAYOUT_KEYS,
  LABEL_LAYOUTS,
  LABEL_LIMITS,
  type LabelKind,
  type LabelLayoutKey,
  LOCATION_LABEL_FIELDS,
} from '@airstock/core/labels';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, command, type Out } from '../api.ts';
import { oneUnit, usePackaging } from '../components/catalog/shared.tsx';
import {
  Card,
  ErrorNotice,
  Field,
  formatDecimal,
  Loading,
  Notice,
  PageHeader,
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';
import {
  type ItemLabels,
  itemPrintLabels,
  type LocationLabels,
  locationPrintLabels,
  type PrintLabel,
} from '../labels/content.ts';
import type { LabelsSearch } from '../labels/search.ts';
import { useMutation } from '../mutation.ts';
import { useLocations } from './warehouses.tsx';

type Templates = Out<typeof ops.listLabelTemplates>;
type Template = Templates['templates'][number];
type QueryResult = Out<typeof ops.queryItems>;
type LabelsModule = typeof import('../labels/pdf.ts');

/** bwip-js, pdf-lib, and fontkit load only here, on demand, so no other page downloads them. */
let pdfModule: Promise<LabelsModule> | null = null;
const loadPdf = () => {
  pdfModule ??= import('../labels/pdf.ts');
  return pdfModule;
};

interface Entry {
  key: string;
  variantId: string;
  packId: string;
  copies: number;
}

const entryKey = (variantId: string, packId: string) => `${variantId}:${packId}`;

function entriesFrom(variants: string | undefined): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const part of variants?.split(',') ?? []) {
    const [variantId = '', packId = ''] = part.split(':');
    const key = entryKey(variantId, packId);
    if (!variantId || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, variantId, packId, copies: 1 });
  }
  return out;
}

/** What to print with: a saved or built-in template, or a layout and fields of one's own. */
interface Choice {
  templateId: string | null;
  templateKey: string | null;
  layout: LabelLayoutKey;
  fields: string[];
}

const choiceOf = (t: Template): Choice => ({
  templateId: t.id,
  templateKey: t.key,
  layout: t.layout,
  fields: t.fields,
});

function templateBody(choice: Choice) {
  if (choice.templateId) return { templateId: choice.templateId };
  if (choice.templateKey) return { template: choice.templateKey };
  return { layout: choice.layout, fields: choice.fields };
}

/** Saves bytes as a file. A blob: URL works under the dashboard CSP: downloads are navigations. */
function saveFile(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function LabelsPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const search = useSearch({ strict: false }) as LabelsSearch;
  const context = useShopContext(shopId);
  const canLocations = can(context.data, 'storage.read');
  const kind: LabelKind = search.kind === 'location' && canLocations ? 'location' : 'item';
  const navigate = useNavigate();
  return (
    <div className="stack labels-page">
      <PageHeader
        title="Labels"
        subtitle="Print product, pack, and location labels. The PDF is made in your browser."
      />
      {canLocations ? (
        <fieldset className="segmented" aria-label="Label kind">
          {(['item', 'location'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={kind === k ? 'on' : ''}
              aria-pressed={kind === k}
              onClick={() =>
                void navigate({
                  to: '/shops/$shopId/labels',
                  params: { shopId },
                  search: { ...search, kind: k },
                })
              }
            >
              {k === 'item' ? 'Product labels' : 'Location labels'}
            </button>
          ))}
        </fieldset>
      ) : null}
      <LabelsForm
        key={`${kind}:${search.variants ?? ''}`}
        shopId={shopId}
        kind={kind}
        initial={kind === 'item' ? entriesFrom(search.variants) : []}
        canSaveTemplate={can(context.data, 'catalog.write')}
      />
    </div>
  );
}

function LabelsForm({
  shopId,
  kind,
  initial,
  canSaveTemplate,
}: {
  shopId: string;
  kind: LabelKind;
  initial: Entry[];
  canSaveTemplate: boolean;
}) {
  const queryClient = useQueryClient();
  const templates = useQuery({
    queryKey: ['shop', shopId, 'label-templates'],
    queryFn: () => api<Templates>(`/shops/${shopId}/labels/templates`),
  });
  const forKind = (templates.data?.templates ?? []).filter((t) => t.kind === kind);
  const [choice, setChoice] = useState<Choice | null>(null);
  const current: Choice | null = choice ?? (forKind[0] ? choiceOf(forKind[0]) : null);
  const [entries, setEntries] = useState<Entry[]>(initial);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [locationCopies, setLocationCopies] = useState(1);
  const [skip, setSkip] = useState(0);
  const [done, setDone] = useState<string | null>(null);

  const layout = current ? LABEL_LAYOUTS[current.layout] : null;
  const perPage = layout ? layout.columns * layout.rows : 1;
  const count =
    kind === 'item'
      ? entries.reduce((n, e) => n + e.copies, 0)
      : locationIds.length * locationCopies;

  // What the labels will say, resolved once per list and template; copies do not change it.
  const unique = useMemo(
    () =>
      kind === 'item'
        ? entries.map((e) => ({
            variantId: e.variantId,
            ...(e.packId ? { packId: e.packId } : {}),
          }))
        : locationIds.map((locationId) => ({ locationId })),
    [kind, entries, locationIds],
  );
  const resolved = useQuery<ItemLabels | LocationLabels>({
    queryKey: ['shop', shopId, 'labels', kind, unique, current && templateBody(current)],
    queryFn: () =>
      kind === 'item'
        ? api<ItemLabels>(`/shops/${shopId}/labels/items`, {
            method: 'POST',
            body: { items: unique, ...templateBody(current!) },
          })
        : api<LocationLabels>(`/shops/${shopId}/labels/locations`, {
            method: 'POST',
            body: { locations: unique, ...templateBody(current!) },
          }),
    enabled: unique.length > 0 && current !== null,
    staleTime: 60_000,
  });
  const preview = useMemo<PrintLabel[]>(
    () =>
      resolved.data
        ? kind === 'item'
          ? itemPrintLabels(resolved.data as ItemLabels)
          : locationPrintLabels(resolved.data as LocationLabels)
        : [],
    [kind, resolved.data],
  );
  const itemData = kind === 'item' ? (resolved.data as ItemLabels | undefined) : undefined;
  const byKey = new Map(
    (itemData?.labels ?? []).map((l) => [entryKey(l.variantId, l.packId ?? ''), l]),
  );

  const print = useMutation({
    mutationFn: async () => {
      if (!current || !layout) throw new Error('Choose a template.');
      const body = templateBody(current);
      const [data, pdf] = await Promise.all([
        kind === 'item'
          ? api<ItemLabels>(`/shops/${shopId}/labels/items`, {
              method: 'POST',
              body: {
                items: entries.map((e) => ({
                  variantId: e.variantId,
                  ...(e.packId ? { packId: e.packId } : {}),
                  copies: e.copies,
                })),
                ...body,
              },
            })
          : api<LocationLabels>(`/shops/${shopId}/labels/locations`, {
              method: 'POST',
              body: {
                locations: locationIds.map((locationId) => ({
                  locationId,
                  copies: locationCopies,
                })),
                ...body,
              },
            }),
        loadPdf(),
      ]);
      const labels =
        kind === 'item'
          ? itemPrintLabels(data as ItemLabels)
          : locationPrintLabels(data as LocationLabels);
      const result = await pdf.buildLabelPdf({
        layout: data.template.layout,
        labels,
        skip: perPage > 1 ? skip : 0,
      });
      const date = new Date().toISOString().slice(0, 10);
      const name = `${kind === 'item' ? 'labels' : 'location-labels'}-${date}.pdf`;
      saveFile(result.bytes, name);
      return { ...result, name };
    },
    onSuccess: (result) =>
      setDone(
        `Downloaded ${result.name}: ${result.labels} ${result.labels === 1 ? 'label' : 'labels'} on ${result.pages} ${result.pages === 1 ? 'page' : 'pages'}.${result.failed.length ? ` Could not draw ${result.failed.join(', ')}.` : ''}${result.missing.length ? ` Printed “?” for ${result.missing.join(' ')}.` : ''}`,
      ),
  });

  const saveTemplate = useMutation({
    mutationFn: (name: string) =>
      command<{ template: Template }>(`/shops/${shopId}/labels/templates`, {
        name,
        kind,
        layout: current!.layout,
        fields: current!.fields,
      }),
    onSuccess: (result) => {
      setChoice(choiceOf(result.template));
      void queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'label-templates'] });
    },
  });

  const fieldList = kind === 'item' ? ITEM_LABEL_FIELDS : LOCATION_LABEL_FIELDS;
  const custom = current !== null && !current.templateId && !current.templateKey;
  const tooMany = count > LABEL_LIMITS.labels;
  const blank = current !== null && current.fields.length === 0;

  return (
    <div className="labels-layout">
      <div className="stack">
        <Card title="Template">
          {templates.isPending ? <Loading /> : <ErrorNotice error={templates.error} />}
          {current ? (
            <div className="stack">
              <Field label="Template">
                <select
                  value={current.templateId ?? current.templateKey ?? ''}
                  onChange={(e) => {
                    const t = forKind.find((x) => (x.id ?? x.key) === e.target.value);
                    setChoice(
                      t ? choiceOf(t) : { ...current, templateId: null, templateKey: null },
                    );
                    setDone(null);
                  }}
                >
                  {forKind.map((t) => (
                    <option key={t.id ?? t.key} value={t.id ?? t.key ?? ''}>
                      {t.name}
                    </option>
                  ))}
                  <option value="">Custom</option>
                </select>
              </Field>
              <Field label="Label size">
                <select
                  value={current.layout}
                  onChange={(e) => {
                    setChoice({
                      ...current,
                      templateId: null,
                      templateKey: null,
                      layout: e.target.value as LabelLayoutKey,
                    });
                    setSkip(0);
                  }}
                >
                  {LABEL_LAYOUT_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {LABEL_LAYOUTS[k].label}
                    </option>
                  ))}
                </select>
              </Field>
              <fieldset className="checks" aria-label="Show on the label">
                <legend>Show on the label</legend>
                {fieldList.map((f) => (
                  <label key={f} className="check">
                    <input
                      type="checkbox"
                      checked={current.fields.includes(f)}
                      onChange={(e) =>
                        setChoice({
                          ...current,
                          templateId: null,
                          templateKey: null,
                          fields: e.target.checked
                            ? fieldList.filter((x) => x === f || current.fields.includes(x))
                            : current.fields.filter((x) => x !== f),
                        })
                      }
                    />
                    {LABEL_FIELD_LABELS[f]}
                  </label>
                ))}
              </fieldset>
              {perPage > 1 ? (
                <Field
                  label="Start at label"
                  hint={`For a partly used sheet: 1 to ${perPage}, left to right, top to bottom.`}
                >
                  <input
                    type="number"
                    min={1}
                    max={perPage}
                    value={skip + 1}
                    onChange={(e) =>
                      setSkip(Math.min(perPage - 1, Math.max(0, Number(e.target.value) - 1 || 0)))
                    }
                  />
                </Field>
              ) : null}
              {custom && canSaveTemplate && current.fields.length > 0 ? (
                <SaveTemplate
                  pending={saveTemplate.isPending}
                  error={saveTemplate.error}
                  onSave={(name) => saveTemplate.mutate(name)}
                />
              ) : null}
            </div>
          ) : null}
        </Card>
        {kind === 'item' ? (
          <ItemEntries
            shopId={shopId}
            entries={entries}
            labels={byKey}
            loading={resolved.isFetching}
            onChange={(next) => {
              setEntries(next);
              setDone(null);
            }}
          />
        ) : (
          <LocationPicker
            shopId={shopId}
            selected={locationIds}
            copies={locationCopies}
            onChange={(ids) => {
              setLocationIds(ids);
              setDone(null);
            }}
            onCopies={setLocationCopies}
          />
        )}
      </div>
      <Card title="Print">
        <div className="stack">
          <ErrorNotice error={resolved.error} />
          {itemData && itemData.missingBarcodes > 0 ? (
            <p className="notice">
              {itemData.missingBarcodes} of these {itemData.missingBarcodes === 1 ? 'has' : 'have'}{' '}
              no barcode and will print without one. Add or generate one in the product’s Packaging
              tab.
            </p>
          ) : null}
          {current && preview.length > 0 ? (
            <LabelPreview labels={preview} layout={current.layout} />
          ) : (
            <p className="muted">
              {kind === 'item'
                ? 'Add products to see a preview.'
                : 'Choose locations to see a preview.'}
            </p>
          )}
          <p>
            {count} {count === 1 ? 'label' : 'labels'}
            {perPage > 1 && count > 0
              ? ` on ${Math.ceil((skip + count) / perPage)} ${Math.ceil((skip + count) / perPage) === 1 ? 'sheet' : 'sheets'}`
              : ''}
          </p>
          {tooMany ? (
            <p className="notice error">Print at most {LABEL_LIMITS.labels} labels at a time.</p>
          ) : null}
          {blank ? <p className="notice">Choose at least one thing to show on the label.</p> : null}
          <ErrorNotice error={print.error} />
          {done ? <Notice tone="ok">{done}</Notice> : null}
          <div className="form-actions">
            <button
              type="button"
              disabled={count === 0 || tooMany || blank || !current || print.isPending}
              onClick={() => {
                setDone(null);
                print.mutate();
              }}
            >
              {print.isPending ? 'Preparing…' : 'Download PDF'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function SaveTemplate({
  pending,
  error,
  onSave,
}: {
  pending: boolean;
  error: unknown;
  onSave(name: string): void;
}) {
  const [name, setName] = useState('');
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name.trim());
      }}
    >
      <Field label="Save as a template">
        <input value={name} placeholder="Template name" onChange={(e) => setName(e.target.value)} />
      </Field>
      <button type="submit" className="small ghost" disabled={pending || !name.trim()}>
        Save template
      </button>
      <ErrorNotice error={error} />
    </form>
  );
}

/** A pack choice per entry; a variant's packs load only when its list is about to be used. */
function PackChoice({
  shopId,
  entry,
  onChange,
}: {
  shopId: string;
  entry: Entry;
  onChange(packId: string): void;
}) {
  const [open, setOpen] = useState(Boolean(entry.packId));
  const packaging = usePackaging(shopId, entry.variantId, open);
  const packs = packaging.data?.packs.filter((p) => p.status === 'active') ?? [];
  return (
    <select
      aria-label="Pack"
      value={entry.packId}
      // Hovering loads the packs, so the list has them by the time it opens.
      onPointerEnter={() => setOpen(true)}
      onFocus={() => setOpen(true)}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{oneUnit(packaging.data?.baseUnit)}</option>
      {packs.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} ({formatDecimal(p.baseQuantity)})
        </option>
      ))}
      {open && packaging.isPending ? <option disabled>Loading packs…</option> : null}
    </select>
  );
}

function ItemEntries({
  shopId,
  entries,
  labels,
  loading,
  onChange,
}: {
  shopId: string;
  entries: Entry[];
  labels: Map<string, ItemLabels['labels'][number]>;
  loading: boolean;
  onChange(entries: Entry[]): void;
}) {
  const [search, setSearch] = useState('');
  const found = useQuery({
    queryKey: ['shop', shopId, 'label-search', search.trim()],
    queryFn: () =>
      api<QueryResult>(`/shops/${shopId}/items/query`, {
        method: 'POST',
        body: { mode: 'variants', search: search.trim(), limit: 10 },
      }),
    enabled: search.trim().length >= 2,
  });
  const add = (variantId: string) => {
    const key = entryKey(variantId, '');
    if (entries.some((e) => e.key === key)) return;
    onChange([...entries, { key, variantId, packId: '', copies: 1 }]);
  };
  const update = (key: string, patch: Partial<Entry>) => {
    const next = entries.map((e) => {
      if (e.key !== key) return e;
      const merged = { ...e, ...patch };
      return { ...merged, key: entryKey(merged.variantId, merged.packId) };
    });
    // Choosing a pack that is already listed merges the two lines.
    const merged: Entry[] = [];
    for (const e of next) {
      const same = merged.find((m) => m.key === e.key);
      if (same) same.copies = Math.min(LABEL_LIMITS.copies, same.copies + e.copies);
      else merged.push(e);
    }
    onChange(merged);
  };
  return (
    <Card title="Products">
      <div className="stack">
        <input
          type="search"
          value={search}
          aria-label="Find products"
          placeholder="Find products by name or SKU"
          onChange={(e) => setSearch(e.target.value)}
        />
        {found.data && search.trim().length >= 2 ? (
          <ul className="plain-list">
            {found.data.rows.length === 0 ? <li className="muted">Nothing found.</li> : null}
            {found.data.rows
              .filter((r) => r.variantId)
              .map((r) => (
                <li key={r.variantId}>
                  {r.name}
                  {r.title ? ` · ${r.title}` : ''} <code>{r.sku}</code>{' '}
                  <button
                    type="button"
                    className="small ghost"
                    onClick={() => add(r.variantId!)}
                    disabled={entries.some((e) => e.key === entryKey(r.variantId!, ''))}
                  >
                    Add
                  </button>
                </li>
              ))}
          </ul>
        ) : null}
        {entries.length === 0 ? (
          <p className="muted">
            No products yet. Find them here, or select rows on the Products page and choose Print
            labels.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table compact label-entries">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Label for</th>
                  <th className="num">Copies</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const l = labels.get(e.key);
                  return (
                    <tr key={e.key}>
                      <td>
                        {l ? (
                          <>
                            {l.name}
                            {l.options ? ` · ${l.options}` : ''} <code>{l.sku}</code>
                            {l.barcode ? null : <span className="muted"> · no barcode</span>}
                          </>
                        ) : loading ? (
                          <span className="muted">Loading…</span>
                        ) : (
                          <span className="muted">{e.variantId.slice(-8)}</span>
                        )}
                      </td>
                      <td>
                        <PackChoice
                          shopId={shopId}
                          entry={e}
                          onChange={(packId) => update(e.key, { packId })}
                        />
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          className="copies"
                          aria-label="Copies"
                          min={1}
                          max={LABEL_LIMITS.copies}
                          value={e.copies}
                          onChange={(ev) =>
                            update(e.key, {
                              copies: Math.min(
                                LABEL_LIMITS.copies,
                                Math.max(1, Math.floor(Number(ev.target.value)) || 1),
                              ),
                            })
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="small ghost"
                          aria-label="Remove"
                          onClick={() => onChange(entries.filter((x) => x.key !== e.key))}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

function LocationPicker({
  shopId,
  selected,
  copies,
  onChange,
  onCopies,
}: {
  shopId: string;
  selected: string[];
  copies: number;
  onChange(ids: string[]): void;
  onCopies(n: number): void;
}) {
  const locations = useLocations(shopId);
  const [filter, setFilter] = useState('');
  const shown = (locations.data?.locations ?? []).filter(
    (l) =>
      l.status === 'active' &&
      (!filter.trim() ||
        `${l.path} ${l.name} ${l.code ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase())),
  );
  const chosen = new Set(selected);
  return (
    <Card title="Locations">
      <div className="stack">
        {locations.isPending ? <Loading /> : <ErrorNotice error={locations.error} />}
        <div className="inline-form">
          <Field label="Filter">
            <input
              type="search"
              value={filter}
              placeholder="Path or code"
              onChange={(e) => setFilter(e.target.value)}
            />
          </Field>
          <Field label="Copies of each">
            <input
              type="number"
              min={1}
              max={LABEL_LIMITS.copies}
              value={copies}
              onChange={(e) =>
                onCopies(
                  Math.min(
                    LABEL_LIMITS.copies,
                    Math.max(1, Math.floor(Number(e.target.value)) || 1),
                  ),
                )
              }
            />
          </Field>
        </div>
        <div className="form-actions">
          <button
            type="button"
            className="small ghost"
            onClick={() =>
              onChange(
                [
                  ...selected,
                  ...shown.map((l) => l.locationId).filter((id) => !chosen.has(id)),
                ].slice(0, LABEL_LIMITS.entries),
              )
            }
          >
            Select all shown
          </button>
          <button type="button" className="small ghost" onClick={() => onChange([])}>
            Clear
          </button>
          <span className="muted">{selected.length} selected</span>
        </div>
        {locations.data && shown.length === 0 ? <p className="muted">No locations.</p> : null}
        <ul className="plain-list location-choices">
          {shown.map((l) => (
            <li key={l.locationId}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={chosen.has(l.locationId)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...selected, l.locationId]
                        : selected.filter((id) => id !== l.locationId),
                    )
                  }
                />
                <span>
                  {l.path}
                  {/* A location with a code shows it in its path; its name is the other half. */}
                  {l.code && l.path.endsWith(l.code) ? (
                    <span className="muted"> · {l.name}</span>
                  ) : l.code ? (
                    <code> {l.code}</code>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

/** The first label, drawn from the same plan as the PDF. */
function LabelPreview({ labels, layout }: { labels: PrintLabel[]; layout: LabelLayoutKey }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const pdf = await loadPdf();
        const metrics = await pdf.labelMetrics(labels);
        if (cancelled) return;
        const spec = LABEL_LAYOUTS[layout];
        const plans = labels.map((l) => pdf.planLabel(l, spec, metrics));
        const dense = plans.filter((p) => p.dense).length;
        const failed = plans.filter((p) => p.failed).length;
        const missing = metrics.missing;
        setWarning(
          [
            dense
              ? `${dense} ${dense === 1 ? 'barcode is' : 'barcodes are'} too long to scan reliably at this size; choose a larger label.`
              : '',
            failed ? `${failed} ${failed === 1 ? 'barcode' : 'barcodes'} cannot be drawn.` : '',
            missing.length
              ? `No label font has ${missing.length === 1 ? 'this character' : 'these characters'}, so ${missing.length === 1 ? 'it prints' : 'they print'} as “?”: ${missing.join(' ')}`
              : '',
          ]
            .filter(Boolean)
            .join(' ') || null,
        );
        setError(null);
        const c = canvas.current;
        const ctx = c?.getContext('2d');
        if (!c || !ctx || !plans[0]) return;
        // Four device pixels per point keeps small text legible.
        const scale = 2 * (window.devicePixelRatio || 1);
        const w = spec.labelWidth * pdf.PT_PER_MM;
        const h = spec.labelHeight * pdf.PT_PER_MM;
        c.width = Math.round(w * scale);
        c.height = Math.round(h * scale);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#000';
        ctx.strokeStyle = '#000';
        pdf.paintLabel(ctx, plans[0], metrics);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [labels, layout]);
  return (
    <figure className="label-preview">
      <canvas ref={canvas} aria-label="Preview of the first label" role="img" />
      <figcaption className="muted small-text">{LABEL_LAYOUTS[layout].label}</figcaption>
      {warning ? <p className="notice">{warning}</p> : null}
      <ErrorNotice error={error} />
    </figure>
  );
}
