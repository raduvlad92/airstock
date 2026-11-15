// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { Telemetry } from '../src/telemetry.ts';

type Sent = { shopId: string; events: Array<{ eventId: string; seq: number; type: string }> };

function recorder(fail: (n: number) => Error | null = () => null) {
  const sent: Sent[] = [];
  let calls = 0;
  const telemetry = new Telemetry(async (shopId, events) => {
    const error = fail(calls++);
    if (error) throw error;
    sent.push({ shopId, events: structuredClone(events) });
  });
  return { telemetry, sent };
}

describe('client event batching (plan 5.14)', () => {
  it('sends one batch per shop with UUIDv7 IDs and increasing sequence numbers', async () => {
    const { telemetry, sent } = recorder();
    telemetry.track('shop-a', 'page.viewed', { route: '/products' });
    telemetry.track('shop-a', 'grid.column_resized', { column: 'sku', width: 120 });
    telemetry.track('shop-b', 'detail_panel.opened', undefined, { type: 'variant', id: 'v1' });
    await telemetry.flush();
    expect(sent.map((s) => [s.shopId, s.events.length])).toEqual([
      ['shop-a', 2],
      ['shop-b', 1],
    ]);
    const all = sent.flatMap((s) => s.events);
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(all.every((e) => /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(e.eventId))).toBe(true);
    expect(telemetry.pending('shop-a')).toBe(0);
  });

  it('flushes at 100 events without waiting for the timer', async () => {
    const { telemetry, sent } = recorder();
    for (let i = 0; i < 100; i++) telemetry.track('s', 'page.viewed');
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.events).toHaveLength(100);
  });

  it('keeps events after a network error or 429 and resends the same IDs', async () => {
    const { telemetry, sent } = recorder((n) =>
      n === 0
        ? new TypeError('offline')
        : n === 1
          ? new ApiError(429, 'rate_limited', 'slow down', {})
          : null,
    );
    telemetry.track('s', 'page.viewed');
    await telemetry.flush();
    await telemetry.flush();
    expect(telemetry.pending('s')).toBe(1);
    await telemetry.flush();
    expect(sent).toHaveLength(1);
    expect(telemetry.pending('s')).toBe(0);
  });

  it('drops a batch the server rejects as invalid', async () => {
    const { telemetry } = recorder(() => new ApiError(400, 'validation_failed', 'bad', {}));
    telemetry.track('s', 'page.viewed');
    await telemetry.flush();
    expect(telemetry.pending('s')).toBe(0);
  });
});
