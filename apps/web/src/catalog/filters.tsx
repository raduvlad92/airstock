import { useState } from 'react';
import type { Column } from './schema.ts';

export interface Condition {
  field: string;
  op: string;
  value?: unknown;
}

const OPS: Record<string, Array<[string, string]>> = {
  text: [
    ['contains', 'contains'],
    ['equals', 'is'],
    ['starts_with', 'starts with'],
    ['is_empty', 'is empty'],
    ['is_not_empty', 'is not empty'],
  ],
  number: [
    ['eq', '='],
    ['neq', '≠'],
    ['lt', '<'],
    ['lte', '≤'],
    ['gt', '>'],
    ['gte', '≥'],
    ['is_empty', 'is empty'],
    ['is_not_empty', 'is not empty'],
  ],
  boolean: [['is', 'is']],
  date: [
    ['before', 'before'],
    ['after', 'after'],
    ['on', 'on'],
    ['within_last_days', 'in the last … days'],
    ['within_next_days', 'in the next … days'],
    ['is_empty', 'is empty'],
  ],
  select: [
    ['is_any_of', 'is'],
    ['is_none_of', 'is not'],
    ['is_empty', 'is empty'],
    ['is_not_empty', 'is not empty'],
  ],
  multi: [
    ['has_any', 'has any of'],
    ['has_all', 'has all of'],
    ['has_none', 'has none of'],
    ['is_empty', 'is empty'],
  ],
};

function opsFor(column: Column): Array<[string, string]> {
  switch (column.kind) {
    case 'number':
    case 'money':
    case 'measurement':
      return OPS.number!;
    case 'boolean':
      return OPS.boolean!;
    case 'date':
    case 'timestamp':
      return OPS.date!;
    case 'select':
    case 'family':
      return OPS.select!;
    case 'multi':
    case 'tags':
      return OPS.multi!;
    default:
      return column.key === 'available' || column.key === 'price' ? OPS.number! : OPS.text!;
  }
}

const NO_VALUE = new Set(['is_empty', 'is_not_empty']);

export function describeCondition(c: Condition, columns: Column[]): string {
  const column = columns.find((x) => x.key === c.field);
  const op = column ? opsFor(column).find(([id]) => id === c.op)?.[1] : c.op;
  const value = Array.isArray(c.value)
    ? c.value.join(', ')
    : c.value === undefined
      ? ''
      : String(c.value);
  return `${column?.label ?? c.field} ${op ?? c.op} ${value}`.trim();
}

/** A filter row per condition, all of which must match (plan 5.10). */
export function FilterEditor({
  columns,
  families,
  value,
  onChange,
}: {
  columns: Column[];
  families: Array<{ id: string; name: string }>;
  value: Condition[];
  onChange(next: Condition[]): void;
}) {
  const filterable = columns.filter((c) => c.kind !== 'readonly' || c.key === 'available');
  const [draft, setDraft] = useState<Condition[]>(value);
  const update = (i: number, patch: Partial<Condition>) =>
    setDraft(draft.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="filter-editor">
      {draft.length === 0 ? <p className="muted">No filters. Add one to narrow the list.</p> : null}
      {draft.map((c, i) => {
        const column = filterable.find((x) => x.key === c.field) ?? filterable[0]!;
        const ops = opsFor(column);
        const options =
          column.key === 'family'
            ? families.map((f) => ({ id: f.id, label: f.name }))
            : (column.field?.options.filter((o) => !o.archived) ?? []);
        return (
          <div className="filter-row" key={i}>
            <select
              aria-label="Field"
              value={c.field}
              onChange={(e) => {
                const next = filterable.find((x) => x.key === e.target.value)!;
                update(i, { field: next.key, op: opsFor(next)[0]![0], value: undefined });
              }}
            >
              {filterable.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Operator"
              value={c.op}
              onChange={(e) => update(i, { op: e.target.value })}
            >
              {ops.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            {NO_VALUE.has(c.op) ? null : column.kind === 'boolean' ? (
              <select
                aria-label="Value"
                value={String(c.value ?? 'true')}
                onChange={(e) => update(i, { value: e.target.value === 'true' })}
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : options.length > 0 ? (
              <select
                aria-label="Value"
                multiple
                value={(c.value as string[] | undefined) ?? []}
                onChange={(e) =>
                  update(i, { value: [...e.target.selectedOptions].map((o) => o.value) })
                }
              >
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                aria-label="Value"
                type={column.kind === 'date' ? 'date' : 'text'}
                value={String(c.value ?? '')}
                placeholder={column.kind === 'measurement' ? 'such as 2 kg' : ''}
                onChange={(e) =>
                  update(i, {
                    value:
                      column.kind === 'tags'
                        ? e.target.value.split(',').map((t) => t.trim())
                        : e.target.value,
                  })
                }
              />
            )}
            <button
              type="button"
              className="small ghost"
              aria-label="Remove filter"
              onClick={() => setDraft(draft.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        );
      })}
      <div className="form-actions">
        <button
          type="button"
          className="small ghost"
          disabled={draft.length >= 20}
          onClick={() => {
            const first = filterable[0]!;
            setDraft([...draft, { field: first.key, op: opsFor(first)[0]![0] }]);
          }}
        >
          Add filter
        </button>
        <button
          type="button"
          className="small"
          onClick={() =>
            onChange(
              draft.filter((c) => NO_VALUE.has(c.op) || (c.value !== undefined && c.value !== '')),
            )
          }
        >
          Apply
        </button>
      </div>
    </div>
  );
}
