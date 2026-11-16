import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ApiError, command, errorMessage } from '../api.ts';
import { useMutation } from '../mutation.ts';
import { parseTsv, toTsv } from './clipboard.ts';
import {
  type Cell,
  contains,
  keyAction,
  move,
  range,
  type Selection,
  single,
} from './grid-state.ts';
import type { CatalogSchema, Column, Mode } from './schema.ts';
import {
  type CellValue,
  cellValue,
  changeFor,
  editText,
  parseInput,
  type Row,
  rowId,
} from './values.ts';

export interface BulkEdit {
  productId: string;
  variantId?: string;
  field: string;
  value: unknown;
  /** For the preview list. */
  label: string;
}

interface CellState {
  state: 'pending' | 'error' | 'conflict';
  draft: string;
  message?: string;
  theirs?: unknown;
  changedBy?: { actorType: string; source: string; clientId: string | null; at: string } | null;
}

export interface GridProps {
  shopId: string;
  mode: Mode;
  columns: Column[];
  widths: Record<string, number>;
  rows: Array<Row | undefined>;
  rowCount: number;
  schema: CatalogSchema | undefined;
  sort: { field: string; direction: 'asc' | 'desc' } | null;
  density: 'compact' | 'comfortable';
  onSort(field: string): void;
  onNeedMore(): void;
  onOpen(row: Row): void;
  onResize(key: string, width: number, done: boolean): void;
  onReorder(fromKey: string, toKey: string): void;
  onBulk(edits: BulkEdit[]): void;
  /** Values saved after the page loaded, by `${rowId}:${column}`. */
  overrides: Map<string, CellValue>;
  onSaved(key: string, value: CellValue): void;
  /** The loaded rows the selection covers, for toolbar actions such as printing labels. */
  onSelectRows?(rows: Row[]): void;
}

const ROW_HEIGHT = { compact: 32, comfortable: 42 } as const;
const HEADER_HEIGHT = 34;

type UpdateResult = {
  item: {
    product: {
      name: string;
      tags: string[];
      family: { id: string; name: string } | null;
      fields: Record<
        string,
        { value: unknown; display: string | null; source: CellValue['source'] }
      >;
    };
    variants: Array<{
      id: string;
      sku: string;
      price: string | null;
      weight: { value: unknown; source: CellValue['source'] };
      fields: Record<
        string,
        { value: unknown; display: string | null; source: CellValue['source'] }
      >;
    }>;
  };
};

/** The saved value of one cell, read from the update's item detail. */
function savedValue(
  result: UpdateResult,
  row: Row,
  column: Column,
  mode: Mode,
  schema: CatalogSchema | undefined,
): CellValue | null {
  const { product, variants } = result.item;
  const variant = variants.find((v) => v.id === row.variantId);
  const merged: Row = {
    ...row,
    name: product.name,
    tags: product.tags,
    familyId: product.family?.id ?? null,
    sku: variant?.sku ?? row.sku,
    price: variant?.price ?? row.price,
    values: {
      ...row.values,
      ...(mode === 'variants' && variant && column.level === 'variant'
        ? variant.fields
        : product.fields),
      ...(variant
        ? { weight: { value: variant.weight.value, display: null, source: variant.weight.source } }
        : {}),
    },
  };
  return cellValue(merged, column, schema, mode);
}

export function Grid(props: GridProps) {
  const { columns, rows, rowCount, mode, schema, density } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const [selection, setSelection] = useState<Selection>(single({ row: 0, col: 0 }));
  const [editing, setEditing] = useState<{ cell: Cell; draft: string } | null>(null);
  const [states, setStates] = useState<Map<string, CellState>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const rowHeight = ROW_HEIGHT[density];
  const frozen = columns[0]!;
  const rest = columns.slice(1);
  const width = (c: Column) => props.widths[c.key] ?? c.defaultWidth;
  const frozenWidth = width(frozen);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: rest.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => width(rest[i]!),
    overscan: 3,
  });
  // Widths change when columns are resized or reordered.
  useEffect(() => colVirtualizer.measure(), [props.widths, columns]);
  useEffect(() => rowVirtualizer.measure(), [rowHeight]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const lastIndex = virtualRows.at(-1)?.index ?? 0;
  useEffect(() => {
    if (lastIndex >= rows.length - 20) props.onNeedMore();
  }, [lastIndex, rows.length, props.onNeedMore]);

  const bounds = { rows: Math.max(1, rowCount), cols: columns.length };
  const value = useCallback(
    (row: Row, column: Column): CellValue =>
      props.overrides.get(`${rowId(row)}:${column.key}`) ?? cellValue(row, column, schema, mode),
    [props.overrides, schema, mode],
  );

  const scrollTo = useCallback(
    (cell: Cell) => {
      rowVirtualizer.scrollToIndex(cell.row, { align: 'auto' });
      if (cell.col > 0) colVirtualizer.scrollToIndex(cell.col - 1, { align: 'auto' });
    },
    [rowVirtualizer, colVirtualizer],
  );

  const update = useMutation({
    mutationFn: (input: {
      row: Row;
      column: Column;
      expected: unknown;
      value: unknown;
      inherit?: boolean;
    }) => {
      const change = changeFor(mode, input.row, input.column);
      return command<UpdateResult>(`/shops/${props.shopId}/items/${input.row.productId}/changes`, {
        changes: [
          {
            ...(change.variantId ? { variantId: change.variantId } : {}),
            field: change.field,
            expected: input.expected,
            ...(input.inherit ? { inherit: true } : { value: input.value }),
          },
        ],
      });
    },
  });

  const setCellState = (key: string, state: CellState | null) =>
    setStates((prev) => {
      const next = new Map(prev);
      if (state) next.set(key, state);
      else next.delete(key);
      return next;
    });

  /** Saves one cell; on a conflict the draft stays with the other person's value next to it. */
  const save = useCallback(
    async (
      row: Row,
      column: Column,
      draft: string,
      expected: unknown,
      opts: { inherit?: boolean } = {},
    ) => {
      const key = `${rowId(row)}:${column.key}`;
      const parsed = opts.inherit
        ? ({ ok: true, value: undefined } as const)
        : parseInput(column, draft, schema);
      if (!parsed.ok) {
        setCellState(key, { state: 'error', draft, message: parsed.message });
        return;
      }
      setCellState(key, { state: 'pending', draft });
      try {
        const result = await update.mutateAsync({
          row,
          column,
          expected,
          value: parsed.value,
          ...opts,
        });
        const saved = savedValue(result, row, column, mode, schema);
        if (saved) props.onSaved(key, saved);
        setCellState(key, null);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'edit_conflict') {
          const conflict = (
            error.problem.conflicts as Array<{
              current: unknown;
              changedBy: CellState['changedBy'];
            }>
          )[0];
          setCellState(key, {
            state: 'conflict',
            draft,
            theirs: conflict?.current ?? null,
            changedBy: conflict?.changedBy ?? null,
            message: 'Someone changed this since you loaded it.',
          });
        } else {
          setCellState(key, { state: 'error', draft, message: errorMessage(error) });
        }
      }
    },
    [schema, mode, update, props],
  );

  const activeRow = rows[selection.active.row];
  const activeColumn = columns[selection.active.col]!;
  const activeKey = activeRow ? `${rowId(activeRow)}:${activeColumn.key}` : '';
  const activeState = states.get(activeKey);

  const startEdit = (initial: string | null) => {
    const row = rows[selection.active.row];
    const column = columns[selection.active.col]!;
    if (!row) return;
    if (!column.editable) {
      setNotice(`${column.label} is not edited here. Shift+Enter opens the product.`);
      return;
    }
    const state = states.get(`${rowId(row)}:${column.key}`);
    const draft = initial ?? state?.draft ?? editText(column, value(row, column).raw, schema);
    setEditing({ cell: selection.active, draft });
    setNotice(null);
  };

  // Enter commits and the editor then blurs: the ref makes sure one edit is saved once.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const finishEdit = (commit: boolean, after: 'down' | 'next' | 'prev' | null) => {
    const current = editingRef.current;
    if (!current) return;
    editingRef.current = null;
    const editing = current;
    const row = rows[editing.cell.row];
    const column = columns[editing.cell.col]!;
    setEditing(null);
    if (commit && row) {
      const current = value(row, column);
      const original = editText(column, current.raw, schema);
      if (editing.draft !== original) {
        const state = states.get(`${rowId(row)}:${column.key}`);
        // Retrying after an error keeps the original expected value.
        void save(
          row,
          column,
          editing.draft,
          state?.state === 'conflict' ? state.theirs : current.raw,
        );
      }
    }
    if (after) setSelection((s) => move(s, after, bounds));
    gridRef.current?.focus();
  };

  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  useEffect(() => scrollTo(selection.active), [selection.active, scrollTo]);

  const { onSelectRows } = props;
  const selectedTop = Math.min(selection.anchor.row, selection.active.row);
  const selectedBottom = Math.max(selection.anchor.row, selection.active.row);
  useEffect(() => {
    onSelectRows?.(rows.slice(selectedTop, selectedBottom + 1).filter((r): r is Row => Boolean(r)));
  }, [onSelectRows, rows, selectedTop, selectedBottom]);

  /** Edits from a range: one cell saves directly; several become a bulk preview (D4). */
  const applyToCells = (
    cells: Array<{ row: Row; column: Column; text: string | null; raw?: unknown }>,
  ) => {
    const editable = cells.filter((c) => c.column.editable);
    if (editable.length < cells.length) setNotice('Read-only columns were skipped.');
    if (editable.length === 0) return;
    if (editable.length === 1) {
      const c = editable[0]!;
      const current = value(c.row, c.column);
      void save(c.row, c.column, c.text ?? '', current.raw);
      return;
    }
    const edits: BulkEdit[] = [];
    for (const c of editable) {
      let v: unknown = c.raw;
      if (c.text !== null) {
        const parsed = parseInput(c.column, c.text, schema);
        if (!parsed.ok) {
          setNotice(`${c.column.label}, ${c.row.sku ?? c.row.name}: ${parsed.message}`);
          return;
        }
        v = parsed.value;
      }
      const change = changeFor(mode, c.row, c.column);
      edits.push({
        ...change,
        value: v,
        label: `${c.row.name}${c.row.sku ? ` · ${c.row.sku}` : ''}`,
      });
    }
    props.onBulk(edits);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const action = keyAction(e);
    if (!action) return;
    e.preventDefault();
    switch (action.type) {
      case 'move':
        setSelection((s) =>
          move(
            s,
            action.move,
            bounds,
            action.extend,
            Math.floor((scrollRef.current?.clientHeight ?? 400) / rowHeight),
          ),
        );
        setNotice(null);
        break;
      case 'edit':
        startEdit(action.initial);
        break;
      case 'collapse':
        setSelection((s) => single(s.active));
        break;
      case 'open':
        if (activeRow) props.onOpen(activeRow);
        break;
      case 'clear': {
        const r = range(selection);
        const cells = [];
        for (let i = r.top; i <= r.bottom; i++) {
          for (let j = r.left; j <= r.right; j++) {
            const row = rows[i];
            if (row) cells.push({ row, column: columns[j]!, text: '' });
          }
        }
        applyToCells(cells);
        break;
      }
      case 'fillDown': {
        const r = range(selection);
        if (r.bottom === r.top) {
          setNotice('Select cells in more than one row to fill down.');
          break;
        }
        const cells = [];
        for (let j = r.left; j <= r.right; j++) {
          const source = rows[r.top];
          if (!source) continue;
          const raw = value(source, columns[j]!).raw;
          for (let i = r.top + 1; i <= r.bottom; i++) {
            const row = rows[i];
            if (row) cells.push({ row, column: columns[j]!, text: null, raw });
          }
        }
        applyToCells(cells);
        break;
      }
    }
  };

  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const r = range(selection);
    const out: string[][] = [];
    for (let i = r.top; i <= r.bottom; i++) {
      const row = rows[i];
      const line: string[] = [];
      for (let j = r.left; j <= r.right; j++) line.push(row ? value(row, columns[j]!).display : '');
      out.push(line);
    }
    e.clipboardData.setData('text/plain', toTsv(out));
    e.preventDefault();
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing) return;
    e.preventDefault();
    const grid = parseTsv(e.clipboardData.getData('text/plain'));
    const start = range(selection);
    // One copied value fills the whole selection; otherwise the block pastes from the active cell.
    const fillAll = grid.length === 1 && grid[0]!.length === 1;
    const cells = [];
    const rowsSpan = fillAll ? start.bottom - start.top + 1 : grid.length;
    const colsSpan = fillAll
      ? start.right - start.left + 1
      : Math.max(...grid.map((g) => g.length));
    for (let i = 0; i < rowsSpan; i++) {
      for (let j = 0; j < colsSpan; j++) {
        const row = rows[start.top + i];
        const column = columns[start.left + j];
        const text = fillAll ? grid[0]![0]! : grid[i]?.[j];
        if (row && column && text !== undefined) cells.push({ row, column, text });
      }
    }
    applyToCells(cells);
  };

  const resolveConflict = (keep: 'mine' | 'theirs') => {
    if (!activeRow || !activeState || activeState.state !== 'conflict') return;
    if (keep === 'theirs') {
      props.onSaved(activeKey, {
        raw: activeState.theirs,
        display: editText(activeColumn, activeState.theirs, schema),
        source: activeState.theirs === null ? 'none' : 'own',
      });
      setCellState(activeKey, null);
    } else {
      void save(activeRow, activeColumn, activeState.draft, activeState.theirs);
    }
  };

  const header = (column: Column, index: number, left: number | null) => (
    <HeaderCell
      key={column.key}
      column={column}
      index={index}
      left={left}
      width={width(column)}
      sort={props.sort}
      onSort={props.onSort}
      onResize={props.onResize}
      onReorder={props.onReorder}
    />
  );

  const renderCell = (
    row: Row | undefined,
    rowIndex: number,
    column: Column,
    colIndex: number,
    left: number | null,
  ) => {
    const selected = contains(selection, rowIndex, colIndex);
    const active = selection.active.row === rowIndex && selection.active.col === colIndex;
    const key = row ? `${rowId(row)}:${column.key}` : '';
    const state = row ? states.get(key) : undefined;
    const v = row ? value(row, column) : null;
    const isEditing = editing && editing.cell.row === rowIndex && editing.cell.col === colIndex;
    const classes = [
      'cell',
      left === null ? 'frozen' : '',
      selected ? 'selected' : '',
      active ? 'active' : '',
      state ? `state-${state.state}` : '',
      v?.source === 'inherited' ? 'inherited' : '',
      column.kind === 'number' || column.kind === 'money' || column.key === 'available'
        ? 'num'
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div
        key={column.key}
        id={`cell-${rowIndex}-${colIndex}`}
        role="gridcell"
        aria-colindex={colIndex + 1}
        aria-selected={selected}
        className={classes}
        style={
          left === null
            ? { width: width(column) }
            : { left: frozenWidth + left, width: width(column) }
        }
        onMouseDown={(e) => {
          if (isEditing) return;
          e.preventDefault();
          gridRef.current?.focus();
          setSelection((s) =>
            e.shiftKey
              ? { anchor: s.anchor, active: { row: rowIndex, col: colIndex } }
              : single({ row: rowIndex, col: colIndex }),
          );
          setNotice(null);
        }}
        onDoubleClick={() => (colIndex === 0 && row ? props.onOpen(row) : startEdit(null))}
        title={
          state?.message ?? (v?.source === 'inherited' ? 'Inherited from the product' : undefined)
        }
      >
        {isEditing ? (
          <input
            ref={editorRef}
            className="cell-editor"
            aria-label={column.label}
            value={editing.draft}
            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                finishEdit(true, 'down');
              } else if (e.key === 'Tab') {
                e.preventDefault();
                finishEdit(true, e.shiftKey ? 'prev' : 'next');
              } else if (e.key === 'Escape') {
                e.preventDefault();
                finishEdit(false, null);
              }
              e.stopPropagation();
            }}
            onBlur={() => finishEdit(true, null)}
          />
        ) : row ? (
          <span className="cell-text">
            {state && state.state !== 'pending' ? state.draft : v?.display}
          </span>
        ) : (
          <span className="cell-skeleton" />
        )}
        {state?.state === 'pending' ? (
          <span className="cell-flag" role="img" aria-label="Saving">
            …
          </span>
        ) : null}
        {state?.state === 'error' ? (
          <span className="cell-flag error" role="img" aria-label="Not saved">
            !
          </span>
        ) : null}
        {state?.state === 'conflict' ? (
          <span className="cell-flag warn" role="img" aria-label="Conflict">
            ⚠
          </span>
        ) : null}
        {colIndex === 0 && row ? (
          <button
            type="button"
            className="open-row"
            aria-label={`Open ${row.name}`}
            tabIndex={-1}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => props.onOpen(row)}
          >
            ›
          </button>
        ) : null}
      </div>
    );
  };

  const totalWidth = frozenWidth + colVirtualizer.getTotalSize();
  return (
    <div className="grid-wrap">
      <div
        ref={gridRef}
        className={`grid density-${density}`}
        role="grid"
        aria-label="Products"
        aria-rowcount={rowCount + 1}
        aria-colcount={columns.length}
        aria-activedescendant={`cell-${selection.active.row}-${selection.active.col}`}
        aria-multiselectable="true"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onCopy={onCopy}
        onPaste={onPaste}
      >
        <div ref={scrollRef} className="grid-scroll">
          <div
            className="grid-canvas"
            style={{ width: totalWidth, height: rowVirtualizer.getTotalSize() + HEADER_HEIGHT }}
          >
            <div
              className="grid-header"
              role="row"
              aria-rowindex={1}
              style={{ width: totalWidth, height: HEADER_HEIGHT }}
            >
              {header(frozen, 0, null)}
              {colVirtualizer
                .getVirtualItems()
                .map((vc) => header(rest[vc.index]!, vc.index + 1, frozenWidth + vc.start))}
            </div>
            {virtualRows.map((vr) => {
              const row = rows[vr.index];
              return (
                <div
                  key={vr.key}
                  role="row"
                  aria-rowindex={vr.index + 2}
                  className="grid-row"
                  style={{
                    transform: `translateY(${vr.start + HEADER_HEIGHT}px)`,
                    height: rowHeight,
                    width: totalWidth,
                  }}
                >
                  {renderCell(row, vr.index, frozen, 0, null)}
                  {colVirtualizer
                    .getVirtualItems()
                    .map((vc) =>
                      renderCell(row, vr.index, rest[vc.index]!, vc.index + 1, vc.start),
                    )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="grid-status" aria-live="polite">
        {activeState?.state === 'conflict' ? (
          <span className="conflict-bar">
            <strong>{activeColumn.label}:</strong> changed to “
            {editText(activeColumn, activeState.theirs, schema) || 'empty'}”
            {activeState.changedBy
              ? ` by ${activeState.changedBy.actorType} via ${activeState.changedBy.source}`
              : ''}
            . Yours: “{activeState.draft || 'empty'}”.
            <button type="button" className="small" onClick={() => resolveConflict('mine')}>
              Keep mine
            </button>
            <button type="button" className="small ghost" onClick={() => resolveConflict('theirs')}>
              Take theirs
            </button>
          </span>
        ) : activeState?.state === 'error' ? (
          <span className="error-text">
            <strong>{activeColumn.label}:</strong> {activeState.message} Press Enter to fix it.
          </span>
        ) : notice ? (
          <span>{notice}</span>
        ) : (
          <span className="muted">
            {activeRow
              ? `${activeColumn.label}${value(activeRow, activeColumn).source === 'inherited' ? ' (inherited from the product)' : ''} · `
              : ''}
            Enter edits · Shift+Enter opens · Ctrl+C / Ctrl+V copy and paste · Ctrl+D fills down
          </span>
        )}
      </div>
    </div>
  );
}

function HeaderCell(props: {
  column: Column;
  index: number;
  left: number | null;
  width: number;
  sort: { field: string; direction: 'asc' | 'desc' } | null;
  onSort(field: string): void;
  onResize(key: string, width: number, done: boolean): void;
  onReorder(fromKey: string, toKey: string): void;
}) {
  const { column, left, width } = props;
  const sorted = props.sort?.field === column.key ? props.sort.direction : null;
  const startResize = (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    let latest = width;
    const onMove = (ev: PointerEvent) => {
      latest = Math.max(60, Math.min(800, Math.round(width + ev.clientX - startX)));
      props.onResize(column.key, latest, false);
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      props.onResize(column.key, latest, true);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  };
  return (
    <div
      role="columnheader"
      aria-colindex={props.index + 1}
      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
      className={`header-cell${left === null ? ' frozen' : ''}`}
      style={left === null ? { width } : { left, width }}
      draggable={left !== null}
      onDragStart={(e) => e.dataTransfer.setData('text/x-airstock-column', column.key)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('text/x-airstock-column')) e.preventDefault();
      }}
      onDrop={(e) => {
        const from = e.dataTransfer.getData('text/x-airstock-column');
        if (from && from !== column.key) props.onReorder(from, column.key);
      }}
    >
      <button
        type="button"
        className="header-label"
        disabled={!column.sortable}
        onClick={() => props.onSort(column.key)}
        title={column.sortable ? 'Sort' : undefined}
      >
        {column.label}
        {sorted ? <span aria-hidden="true">{sorted === 'asc' ? ' ↑' : ' ↓'}</span> : null}
      </button>
      <span
        className="resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${column.label}`}
        onPointerDown={startResize}
      />
    </div>
  );
}
