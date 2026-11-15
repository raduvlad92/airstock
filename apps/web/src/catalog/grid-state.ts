/** Selection and keyboard movement in the grid, as pure functions (plan Section 5.13). */

export interface Cell {
  row: number;
  col: number;
}

export interface Selection {
  /** Where a Shift-extended range started. */
  anchor: Cell;
  /** The active cell (keyboard focus). */
  active: Cell;
}

export interface Bounds {
  rows: number;
  cols: number;
}

export const clampCell = (c: Cell, b: Bounds): Cell => ({
  row: Math.max(0, Math.min(b.rows - 1, c.row)),
  col: Math.max(0, Math.min(b.cols - 1, c.col)),
});

export function single(cell: Cell): Selection {
  return { anchor: cell, active: cell };
}

/** The selected rectangle, inclusive. */
export function range(s: Selection) {
  return {
    top: Math.min(s.anchor.row, s.active.row),
    bottom: Math.max(s.anchor.row, s.active.row),
    left: Math.min(s.anchor.col, s.active.col),
    right: Math.max(s.anchor.col, s.active.col),
  };
}

export function contains(s: Selection, row: number, col: number): boolean {
  const r = range(s);
  return row >= r.top && row <= r.bottom && col >= r.left && col <= r.right;
}

export type Move =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'next'
  | 'prev'
  | 'home'
  | 'end'
  | 'pageUp'
  | 'pageDown';

/** Moves the active cell; with `extend`, keeps the anchor (Shift). Tab wraps to the next row. */
export function move(s: Selection, m: Move, b: Bounds, extend = false, page = 10): Selection {
  const a = s.active;
  let next: Cell;
  switch (m) {
    case 'up':
      next = { row: a.row - 1, col: a.col };
      break;
    case 'down':
      next = { row: a.row + 1, col: a.col };
      break;
    case 'left':
      next = { row: a.row, col: a.col - 1 };
      break;
    case 'right':
      next = { row: a.row, col: a.col + 1 };
      break;
    case 'next':
      next =
        a.col + 1 < b.cols
          ? { row: a.row, col: a.col + 1 }
          : { row: Math.min(b.rows - 1, a.row + 1), col: 0 };
      break;
    case 'prev':
      next =
        a.col > 0
          ? { row: a.row, col: a.col - 1 }
          : { row: Math.max(0, a.row - 1), col: b.cols - 1 };
      break;
    case 'home':
      next = { row: a.row, col: 0 };
      break;
    case 'end':
      next = { row: a.row, col: b.cols - 1 };
      break;
    case 'pageUp':
      next = { row: a.row - page, col: a.col };
      break;
    case 'pageDown':
      next = { row: a.row + page, col: a.col };
      break;
  }
  const active = clampCell(next, b);
  return extend ? { anchor: s.anchor, active } : single(active);
}

/** The keyboard action for a key press while not editing; null leaves the key to the browser. */
export function keyAction(e: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}):
  | { type: 'move'; move: Move; extend: boolean }
  | { type: 'edit'; initial: string | null }
  | { type: 'clear' }
  | { type: 'collapse' }
  | { type: 'fillDown' }
  | { type: 'open' }
  | null {
  const mod = e.metaKey || e.ctrlKey;
  const arrows: Record<string, Move> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
  };
  if (arrows[e.key])
    return {
      type: 'move',
      move: mod
        ? e.key === 'ArrowLeft'
          ? 'home'
          : e.key === 'ArrowRight'
            ? 'end'
            : arrows[e.key]!
        : arrows[e.key]!,
      extend: e.shiftKey,
    };
  if (e.key === 'Tab') return { type: 'move', move: e.shiftKey ? 'prev' : 'next', extend: false };
  if (e.key === 'Home') return { type: 'move', move: 'home', extend: e.shiftKey };
  if (e.key === 'End') return { type: 'move', move: 'end', extend: e.shiftKey };
  if (e.key === 'PageUp') return { type: 'move', move: 'pageUp', extend: e.shiftKey };
  if (e.key === 'PageDown') return { type: 'move', move: 'pageDown', extend: e.shiftKey };
  if (e.key === 'Enter' && e.shiftKey) return { type: 'open' };
  if (e.key === 'Enter' || e.key === 'F2') return { type: 'edit', initial: null };
  if (e.key === 'Escape') return { type: 'collapse' };
  if (e.key === 'Delete' || e.key === 'Backspace') return { type: 'clear' };
  if (mod && e.key.toLowerCase() === 'd') return { type: 'fillDown' };
  if (!mod && !e.altKey && e.key.length === 1) return { type: 'edit', initial: e.key };
  return null;
}
