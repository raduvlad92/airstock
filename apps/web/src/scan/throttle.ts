/**
 * Suppresses repeated reads of the same code. A camera sees a code many times a second; only the
 * first read counts until the code has been out of view for `quietMs`. Holding the camera on a
 * code therefore never commits it twice, and scanning the same item again means moving away and
 * back. A different code is accepted at once.
 */
export class ScanThrottle {
  private last: { text: string; seenAt: number } | null = null;

  constructor(private readonly quietMs = 1500) {}

  accept(text: string, now: number): boolean {
    const last = this.last;
    if (last && last.text === text && now - last.seenAt < this.quietMs) {
      last.seenAt = now;
      return false;
    }
    this.last = { text, seenAt: now };
    return true;
  }

  /** Forget the last code, for example after the user typed one in or switched flows. */
  reset(): void {
    this.last = null;
  }
}
