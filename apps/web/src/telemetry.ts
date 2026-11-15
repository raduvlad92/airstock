import type { CLIENT_EVENT_TYPES } from '@airstock/core';
import { ApiError, api } from './api.ts';
import { uuidv7 } from './uuid.ts';

export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];
type Detail = string | number | boolean | null | string[];

interface ClientEvent {
  eventId: string;
  seq: number;
  type: ClientEventType;
  targetType?: string;
  targetId?: string;
  details?: Record<string, Detail>;
}

/**
 * Client-reported interface events (plan Section 5.14). Buffered per shop and sent in batches:
 * every 5 seconds, at 100 events, and when the page is hidden. Event IDs are made here, so a batch
 * resent after a network error is recorded once.
 */
export class Telemetry {
  static readonly FLUSH_MS = 5000;
  static readonly BATCH = 100;
  /** Kept while offline or refused; the oldest are dropped beyond this. */
  static readonly MAX_BUFFER = 1000;

  private seq = 0;
  private readonly buffers = new Map<string, ClientEvent[]>();
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly send: (
      shopId: string,
      events: ClientEvent[],
      keepalive: boolean,
    ) => Promise<void> = (shopId, events, keepalive) =>
      api(`/shops/${shopId}/activity/client-events`, {
        method: 'POST',
        body: { events },
        keepalive,
      }),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), Telemetry.FLUSH_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush(true);
    });
  }

  track(
    shopId: string,
    type: ClientEventType,
    details?: Record<string, Detail>,
    target?: { type: string; id: string },
  ): void {
    const buffer = this.buffers.get(shopId) ?? [];
    buffer.push({
      eventId: uuidv7(),
      seq: this.seq++,
      type,
      ...(target ? { targetType: target.type, targetId: target.id } : {}),
      ...(details ? { details } : {}),
    });
    if (buffer.length > Telemetry.MAX_BUFFER)
      buffer.splice(0, buffer.length - Telemetry.MAX_BUFFER);
    this.buffers.set(shopId, buffer);
    if (buffer.length >= Telemetry.BATCH) void this.flush();
  }

  pending(shopId: string): number {
    return this.buffers.get(shopId)?.length ?? 0;
  }

  async flush(keepalive = false): Promise<void> {
    await Promise.all(
      [...this.buffers.keys()].map(async (shopId) => {
        if (this.inFlight.has(shopId)) return;
        const buffer = this.buffers.get(shopId) ?? [];
        if (buffer.length === 0) return;
        const batch = buffer.splice(0, Telemetry.BATCH);
        this.inFlight.add(shopId);
        try {
          await this.send(shopId, batch, keepalive);
        } catch (error) {
          // Offline, rate limited, or a server error: keep the events for the next flush. A batch
          // the server refuses as invalid would never succeed, so it is dropped.
          const permanent =
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 429;
          if (!permanent) buffer.unshift(...batch);
        } finally {
          this.inFlight.delete(shopId);
        }
      }),
    );
  }
}

export const telemetry = new Telemetry();
