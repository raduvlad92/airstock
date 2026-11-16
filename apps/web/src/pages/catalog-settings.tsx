import type { ops } from '@airstock/core';
import { FIELD_TYPES } from '@airstock/core/catalog/fields';
import { useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { command, type Out } from '../api.ts';
import { type SchemaField, useCatalogSchema } from '../catalog/schema.ts';
import {
  Badge,
  Card,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Notice,
  titleCase,
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';
import { useMutation } from '../mutation.ts';

type Schema = Out<typeof ops.describeCatalog>;
type Family = Schema['families'][number];

const TYPE_LABELS: Record<(typeof FIELD_TYPES)[number], string> = {
  text: 'Text',
  rich_text: 'Rich text',
  integer: 'Whole number',
  decimal: 'Decimal number',
  boolean: 'Yes or no',
  date: 'Date',
  timestamp: 'Date and time',
  single_select: 'Single select',
  multi_select: 'Multi select',
  money: 'Money',
  measurement: 'Measurement',
  file: 'Files',
  relationship: 'Relationship',
};

const CONVERSIONS: Record<string, string[]> = {
  integer: ['decimal'],
  single_select: ['multi_select'],
  text: ['rich_text'],
  decimal: ['money', 'measurement'],
};

function useRefreshSchema(shopId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'schema'] });
}

/** Settings → Fields: custom fields, their options, and safe type changes (plan 5.2). */
export function FieldsSettingsPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const context = useShopContext(shopId);
  const schema = useCatalogSchema(shopId);
  const manage = can(context.data, 'catalog.schema.manage');
  const [open, setOpen] = useState<string | null>(null);
  if (schema.isPending) return <Loading />;
  const fields = schema.data?.fields ?? [];
  return (
    <>
      <ErrorNotice error={schema.error} />
      <Card
        title={`Fields (${fields.filter((f) => f.status === 'active').length} of ${schema.data?.limits.activeFieldsPerShop ?? 300})`}
      >
        <p className="muted">
          Fields describe products and variants. A field on “both” is set on the product and
          inherited by its variants until a variant has its own value.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Key</th>
                <th>Type</th>
                <th>Level</th>
                <th>Visible to</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.id}>
                  <td>
                    {f.label} {f.isSystem ? <Badge>system</Badge> : null}{' '}
                    {f.status === 'archived' ? <Badge tone="muted">archived</Badge> : null}
                  </td>
                  <td>
                    <code>{f.key}</code>
                  </td>
                  <td>{TYPE_LABELS[f.type]}</td>
                  <td>{titleCase(f.level)}</td>
                  <td>{f.visibility === 'restricted' ? 'Schema managers' : 'Everyone'}</td>
                  <td>
                    {manage ? (
                      <button
                        type="button"
                        className="small ghost"
                        onClick={() => setOpen(open === f.id ? null : f.id)}
                      >
                        {open === f.id ? 'Close' : 'Edit'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {open ? <EditField shopId={shopId} field={fields.find((f) => f.id === open)!} /> : null}
      </Card>
      {manage ? (
        <CreateField shopId={shopId} />
      ) : (
        <Notice>Only members who manage the catalog schema can change fields.</Notice>
      )}
    </>
  );
}

function CreateField({ shopId }: { shopId: string }) {
  const refresh = useRefreshSchema(shopId);
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [type, setType] = useState<(typeof FIELD_TYPES)[number]>('text');
  const [level, setLevel] = useState('product');
  const [options, setOptions] = useState('');
  const [unitKind, setUnitKind] = useState('weight');
  const [restricted, setRestricted] = useState(false);
  const slug =
    key ||
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 'f_$1');
  const create = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/catalog/fields`, {
        key: slug,
        label,
        type,
        level,
        visibility: restricted ? 'restricted' : 'everyone',
        ...(type.endsWith('select')
          ? {
              options: options
                .split(',')
                .map((o) => o.trim())
                .filter(Boolean),
            }
          : {}),
        ...(type === 'measurement' ? { config: { unitKind } } : {}),
        ...(type === 'relationship'
          ? { config: { targetType: level === 'variant' ? 'variant' : 'product' } }
          : {}),
      }),
    onSuccess: async () => {
      setLabel('');
      setKey('');
      setOptions('');
      await refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Card title="Add a field">
      <form className="form-grid" onSubmit={submit}>
        <Field label="Label">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
            maxLength={200}
          />
        </Field>
        <Field label="Key" hint="Used in imports and the API. Cannot change later.">
          <input
            value={slug}
            onChange={(e) => setKey(e.target.value)}
            pattern="[a-z][a-z0-9_]{0,62}"
            required
          />
        </Field>
        <Field label="Type">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as (typeof FIELD_TYPES)[number])}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="On">
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="product">Products</option>
            <option value="variant">Variants</option>
            {type !== 'relationship' ? <option value="both">Both (variants inherit)</option> : null}
          </select>
        </Field>
        {type.endsWith('select') ? (
          <Field label="Options, separated by commas">
            <input value={options} onChange={(e) => setOptions(e.target.value)} />
          </Field>
        ) : null}
        {type === 'measurement' ? (
          <Field label="Measures">
            <select value={unitKind} onChange={(e) => setUnitKind(e.target.value)}>
              <option value="weight">Weight</option>
              <option value="length">Length</option>
              <option value="volume">Volume</option>
              <option value="temperature">Temperature</option>
            </select>
          </Field>
        ) : null}
        <label className="check">
          <input
            type="checkbox"
            checked={restricted}
            onChange={(e) => setRestricted(e.target.checked)}
          />{' '}
          Restricted to schema managers
        </label>
        <div className="form-actions">
          <button type="submit" disabled={create.isPending}>
            Add field
          </button>
        </div>
        <ErrorNotice error={create.error} />
      </form>
    </Card>
  );
}

function EditField({ shopId, field }: { shopId: string; field: SchemaField }) {
  const refresh = useRefreshSchema(shopId);
  const [label, setLabel] = useState(field.label);
  const [add, setAdd] = useState('');
  const [toType, setToType] = useState(CONVERSIONS[field.type]?.[0] ?? '');
  const [unit, setUnit] = useState('kg');
  const [preview, setPreview] = useState<{ products: number; variants: number } | null>(null);
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      command(`/shops/${shopId}/catalog/fields/${field.id}`, {
        expectedVersion: field.version,
        ...body,
      }),
    onSuccess: refresh,
  });
  const options = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      command(`/shops/${shopId}/catalog/fields/${field.id}/options`, body),
    onSuccess: async () => {
      setAdd('');
      await refresh();
    },
  });
  const convert = useMutation({
    mutationFn: (previewOnly: boolean) =>
      command<{ preview: boolean; affected: { products: number; variants: number } }>(
        `/shops/${shopId}/catalog/fields/${field.id}/convert`,
        { toType, preview: previewOnly, ...(toType === 'measurement' ? { unit } : {}) },
      ),
    onSuccess: async (res) => {
      if (res.preview) setPreview(res.affected);
      else {
        setPreview(null);
        await refresh();
      }
    },
  });
  const isSelect = field.type === 'single_select' || field.type === 'multi_select';
  return (
    <div className="stack edit-field">
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({ label });
        }}
      >
        <Field label="Label">
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <button type="submit" className="small">
          Rename
        </button>
        {!field.isSystem ? (
          <button
            type="button"
            className="small ghost"
            onClick={() =>
              update.mutate({ status: field.status === 'active' ? 'archived' : 'active' })
            }
          >
            {field.status === 'active' ? 'Archive field' : 'Restore field'}
          </button>
        ) : null}
      </form>
      <ErrorNotice error={update.error} />
      {isSelect ? (
        <div className="stack">
          <h3>Options</h3>
          <ul className="plain-list">
            {field.options.map((o) => (
              <li key={o.id}>
                <span className={o.archived ? 'muted' : ''}>
                  {o.label}
                  {o.archived ? ' (archived)' : ''}
                </span>
                <button
                  type="button"
                  className="small ghost"
                  onClick={() =>
                    options.mutate(o.archived ? { restore: [o.id] } : { archive: [o.id] })
                  }
                >
                  {o.archived ? 'Restore' : 'Archive'}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              options.mutate({
                add: add
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean),
              });
            }}
          >
            <Field label="Add options, separated by commas">
              <input value={add} onChange={(e) => setAdd(e.target.value)} />
            </Field>
            <button type="submit" className="small">
              Add
            </button>
          </form>
          <ErrorNotice error={options.error} />
        </div>
      ) : null}
      {CONVERSIONS[field.type] && !field.isSystem ? (
        <div className="stack">
          <h3>Change type</h3>
          <div className="inline-form">
            <Field label="To">
              <select value={toType} onChange={(e) => setToType(e.target.value)}>
                {CONVERSIONS[field.type]!.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t as keyof typeof TYPE_LABELS]}
                  </option>
                ))}
              </select>
            </Field>
            {toType === 'measurement' ? (
              <Field label="Existing values are in">
                <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                  {['g', 'kg', 'lb', 'oz', 'mm', 'cm', 'm', 'in', 'ml', 'l'].map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <button type="button" className="small ghost" onClick={() => convert.mutate(true)}>
              Preview
            </button>
          </div>
          {preview ? (
            <Notice>
              {preview.products} products and {preview.variants} variants have a value that will
              change type.{' '}
              <button type="button" className="small" onClick={() => convert.mutate(false)}>
                Change type
              </button>
            </Notice>
          ) : null}
          <ErrorNotice error={convert.error} />
        </div>
      ) : null}
    </div>
  );
}

/** Settings → Families: product families and the four starter templates (Q2). */
export function FamiliesSettingsPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const context = useShopContext(shopId);
  const schema = useCatalogSchema(shopId);
  const manage = can(context.data, 'catalog.schema.manage');
  const refresh = useRefreshSchema(shopId);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const template = useMutation({
    mutationFn: (key: string) => command(`/shops/${shopId}/catalog/templates`, { template: key }),
    onSuccess: refresh,
  });
  const create = useMutation({
    mutationFn: () => command(`/shops/${shopId}/catalog/families`, { name }),
    onSuccess: async () => {
      setName('');
      await refresh();
    },
  });
  if (schema.isPending) return <Loading />;
  const families = schema.data?.families ?? [];
  return (
    <>
      <ErrorNotice error={schema.error} />
      <Card title="Families">
        <p className="muted">
          A family lists the fields its products use, which ones are required, and suggested
          options.
        </p>
        {families.length === 0 ? (
          <Empty>No families yet. Add a starter one below or create your own.</Empty>
        ) : null}
        <ul className="plain-list">
          {families.map((f) => (
            <li key={f.id}>
              <span>
                <strong>{f.name}</strong> <span className="muted">{f.fields.length} fields</span>
              </span>
              {manage ? (
                <button
                  type="button"
                  className="small ghost"
                  onClick={() => setOpen(open === f.id ? null : f.id)}
                >
                  {open === f.id ? 'Close' : 'Edit'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {open && schema.data ? (
          <EditFamily
            shopId={shopId}
            family={families.find((f) => f.id === open)!}
            schema={schema.data}
          />
        ) : null}
      </Card>
      {manage ? (
        <>
          <Card title="Starter families">
            <div className="template-grid">
              {schema.data?.templates.map((t) => (
                <div key={t.key} className="template-card">
                  <strong>{t.name}</strong>
                  <span className="muted">{t.description}</span>
                  <button
                    type="button"
                    className="small"
                    disabled={t.added || template.isPending}
                    onClick={() => template.mutate(t.key)}
                  >
                    {t.added ? 'Added' : 'Add'}
                  </button>
                </div>
              ))}
            </div>
            <ErrorNotice error={template.error} />
          </Card>
          <Card title="Create a family">
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <Field label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={200}
                />
              </Field>
              <button type="submit" disabled={create.isPending}>
                Create
              </button>
            </form>
            <ErrorNotice error={create.error} />
          </Card>
        </>
      ) : null}
    </>
  );
}

function EditFamily({
  shopId,
  family,
  schema,
}: {
  shopId: string;
  family: Family;
  schema: Schema;
}) {
  const refresh = useRefreshSchema(shopId);
  const [members, setMembers] = useState(
    family.fields.map((f) => ({ field: f.key, required: f.required, group: f.group ?? '' })),
  );
  const [adding, setAdding] = useState('');
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      command(`/shops/${shopId}/catalog/families/${family.id}`, {
        expectedVersion: family.version,
        ...body,
      }),
    onSuccess: refresh,
  });
  const available = schema.fields.filter(
    (f) => f.status === 'active' && !members.some((m) => m.field === f.key),
  );
  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>Field</th>
              <th>Group</th>
              <th>Required</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((m, i) => (
              <tr key={m.field}>
                <td>{schema.fields.find((f) => f.key === m.field)?.label ?? m.field}</td>
                <td>
                  <input
                    aria-label="Group"
                    value={m.group}
                    onChange={(e) =>
                      setMembers(
                        members.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)),
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label="Required"
                    checked={m.required}
                    onChange={(e) =>
                      setMembers(
                        members.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)),
                      )
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="small ghost"
                    onClick={() => setMembers(members.filter((_, j) => j !== i))}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="inline-form">
        <Field label="Add a field">
          <select value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Choose…</option>
            {available.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          className="small ghost"
          disabled={!adding}
          onClick={() => {
            setMembers([...members, { field: adding, required: false, group: '' }]);
            setAdding('');
          }}
        >
          Add
        </button>
        <button
          type="button"
          className="small"
          onClick={() =>
            save.mutate({
              fields: members.map((m) => ({
                field: m.field,
                required: m.required,
                ...(m.group ? { group: m.group } : {}),
              })),
            })
          }
        >
          Save fields
        </button>
        <button
          type="button"
          className="small ghost"
          onClick={() => save.mutate({ status: 'archived' })}
        >
          Archive family
        </button>
      </div>
      <ErrorNotice error={save.error} />
    </div>
  );
}

/** Settings → Shop: display units (PRD 3.1). */
export function UnitsSetting({
  shopId,
  current,
}: {
  shopId: string;
  current: 'metric' | 'imperial';
}) {
  const queryClient = useQueryClient();
  const set = useMutation({
    mutationFn: (displayUnits: 'metric' | 'imperial') =>
      command(`/shops/${shopId}/settings`, { displayUnits }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shop', shopId] }),
  });
  return (
    <Card title="Units">
      <p className="muted">
        Values keep the unit they were entered in; this chooses what the dashboard offers first.
      </p>
      <fieldset className="segmented" aria-label="Display units">
        {(['metric', 'imperial'] as const).map((u) => (
          <button
            key={u}
            type="button"
            className={current === u ? 'on' : ''}
            aria-pressed={current === u}
            onClick={() => set.mutate(u)}
          >
            {titleCase(u)}
          </button>
        ))}
      </fieldset>
      <ErrorNotice error={set.error} />
    </Card>
  );
}
