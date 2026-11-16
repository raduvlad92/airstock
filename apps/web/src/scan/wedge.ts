import { useEffect, useRef } from 'react';

/**
 * Keyboard-wedge scanners (USB or Bluetooth, PRD 3.4) type a code as fast keystrokes ending in
 * Enter. Inside a text field they simply type into it, and every scan field submits on Enter.
 * When focus is elsewhere (after tapping a button), this listener collects the keystrokes instead.
 * People type slower than `maxGapMs` between keys, so typing a shortcut never turns into a scan.
 */
export interface WedgeOptions {
  maxGapMs?: number;
  minLength?: number;
  enabled?: boolean;
}

export class WedgeBuffer {
  private chars = '';
  private lastAt = 0;

  constructor(
    private readonly maxGapMs = 60,
    private readonly minLength = 3,
  ) {}

  /** Feeds one key; returns the scanned code when Enter ends a fast sequence. */
  key(key: string, now: number): string | null {
    if (now - this.lastAt > this.maxGapMs) this.chars = '';
    this.lastAt = now;
    if (key === 'Enter') {
      const code = this.chars;
      this.chars = '';
      return code.length >= this.minLength ? code : null;
    }
    if (key.length === 1) this.chars += key;
    return null;
  }
}

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'file'].includes(
      target.type,
    );
  }
  return false;
}

export function useKeyboardWedge(onScan: (code: string) => void, options: WedgeOptions = {}) {
  const handler = useRef(onScan);
  handler.current = onScan;
  const { maxGapMs = 60, minLength = 3, enabled = true } = options;
  useEffect(() => {
    if (!enabled) return;
    const buffer = new WedgeBuffer(maxGapMs, minLength);
    const listener = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return;
      // performance.now(), not event.timeStamp: some input paths stamp keys on another clock.
      const code = buffer.key(event.key, performance.now());
      if (code) {
        event.preventDefault();
        handler.current(code);
      }
    };
    document.addEventListener('keydown', listener, true);
    return () => document.removeEventListener('keydown', listener, true);
  }, [enabled, maxGapMs, minLength]);
}
