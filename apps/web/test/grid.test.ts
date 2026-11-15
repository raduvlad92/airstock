import { describe, expect, it } from 'vitest';
import { parseTsv, toTsv } from '../src/catalog/clipboard.ts';
import { contains, keyAction, move, range, single } from '../src/catalog/grid-state.ts';

const b = { rows: 10, cols: 5 };

describe('grid keyboard model', () => {
  it('moves, clamps at the edges, and wraps Tab to the next row', () => {
    let s = single({ row: 0, col: 0 });
    s = move(s, 'up', b);
    expect(s.active).toEqual({ row: 0, col: 0 });
    s = move(s, 'end', b);
    expect(s.active).toEqual({ row: 0, col: 4 });
    s = move(s, 'next', b);
    expect(s.active).toEqual({ row: 1, col: 0 });
    s = move(s, 'prev', b);
    expect(s.active).toEqual({ row: 0, col: 4 });
    s = move(s, 'pageDown', b, false, 50);
    expect(s.active.row).toBe(9);
  });

  it('extends a range with Shift and keeps its anchor', () => {
    let s = single({ row: 2, col: 1 });
    s = move(s, 'down', b, true);
    s = move(s, 'right', b, true);
    expect(range(s)).toEqual({ top: 2, bottom: 3, left: 1, right: 2 });
    expect(contains(s, 3, 2)).toBe(true);
    expect(contains(s, 4, 2)).toBe(false);
    expect(move(s, 'down', b).anchor).toEqual({ row: 4, col: 2 });
  });

  it('maps keys to actions', () => {
    const k = (
      key: string,
      mods: Partial<{
        shiftKey: boolean;
        metaKey: boolean;
        ctrlKey: boolean;
        altKey: boolean;
      }> = {},
    ) =>
      keyAction({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods });
    expect(k('ArrowDown', { shiftKey: true })).toEqual({
      type: 'move',
      move: 'down',
      extend: true,
    });
    expect(k('Enter')).toEqual({ type: 'edit', initial: null });
    expect(k('Enter', { shiftKey: true })).toEqual({ type: 'open' });
    expect(k('7')).toEqual({ type: 'edit', initial: '7' });
    expect(k('d', { ctrlKey: true })).toEqual({ type: 'fillDown' });
    expect(k('Delete')).toEqual({ type: 'clear' });
    expect(k('c', { metaKey: true })).toBeNull();
  });
});

describe('clipboard text', () => {
  it('round-trips cells with tabs, newlines, and quotes', () => {
    const rows = [
      ['a', 'b\tc', 'say "hi"'],
      ['line\nbreak', '', '3.50'],
    ];
    expect(parseTsv(toTsv(rows))).toEqual(rows);
  });

  it('reads what spreadsheets put on the clipboard', () => {
    expect(parseTsv('5\r\n6\r\n7\r\n')).toEqual([['5'], ['6'], ['7']]);
    expect(parseTsv('x\ty')).toEqual([['x', 'y']]);
  });
});
