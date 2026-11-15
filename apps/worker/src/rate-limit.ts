import {
  AppError,
  type AuditEvent,
  auditEvent,
  type Caller,
  type Logger,
  RATE_LIMIT_PERIOD_SECONDS,
  type RateLimitKind,
} from '@airstock/core';
import type { Context } from 'hono';
import { type AppEnv, problem } from './app.ts';

/** Decides whether one more request from `key` fits its limit (ADR 0011). */
export interface RateLimiter {
  allow(kind: RateLimitKind, key: string): Promise<boolean>;
}

/** The Workers Rate Limiting bindings, one per kind; a missing binding allows everything. */
export function bindingLimiter(
  bindings: Partial<Record<RateLimitKind, RateLimit | undefined>>,
): RateLimiter {
  return {
    async allow(kind, key) {
      const binding = bindings[kind];
      if (!binding) return true;
      const { success } = await binding.limit({ key: `${kind}:${key}` });
      return success;
    },
  };
}

/** A fixed-window limiter in memory, for tests and local runs. */
export function memoryLimiter(
  perWindow: Partial<Record<RateLimitKind, number>>,
  windowMs = RATE_LIMIT_PERIOD_SECONDS * 1000,
  now: () => number = Date.now,
): RateLimiter {
  const counts = new Map<string, { window: number; count: number }>();
  return {
    async allow(kind, key) {
      const limit = perWindow[kind];
      if (limit === undefined) return true;
      const window = Math.floor(now() / windowMs);
      const id = `${kind}:${key}`;
      const entry = counts.get(id);
      if (!entry || entry.window !== window) {
        counts.set(id, { window, count: 1 });
        return true;
      }
      entry.count++;
      return entry.count <= limit;
    },
  };
}

export function rateLimited(): AppError {
  return new AppError(429, 'rate_limited', 'Too many requests. Wait and retry.', 'denied', {
    retryAfterSeconds: RATE_LIMIT_PERIOD_SECONDS,
  });
}

/**
 * Turns refused requests into at most one audit event per caller per minute (D11), so a client
 * hammering the API cannot multiply queue writes. The first refusal in a minute produces the
 * event; it carries the count of the caller's previous refused minute, if this isolate saw one.
 * Isolates do not share this state, so a caller spread over several isolates can produce one
 * event per isolate per minute.
 */
export class RefusalRecorder {
  private readonly windows = new Map<string, { minute: number; refused: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  refused(
    caller: Caller,
    kind: RateLimitKind,
    shopId: string | null,
    requestId: string,
  ): AuditEvent | null {
    const minute = Math.floor(this.now() / 60_000);
    const key = `${caller.kind}:${caller.id}:${kind}`;
    const entry = this.windows.get(key);
    if (entry && entry.minute === minute) {
      entry.refused++;
      return null;
    }
    this.windows.set(key, { minute, refused: 1 });
    if (this.windows.size > 5000) this.prune(minute);
    return auditEvent(
      { shopId, caller, requestId, attemptId: null, idempotencyKey: null },
      {
        action: 'ratelimit.exceeded',
        phase: 'outcome',
        outcome: 'denied',
        target_type: 'rate_limit',
        target_id: kind,
        context: {
          windowStart: new Date(minute * 60_000).toISOString(),
          previousWindow: entry
            ? { start: new Date(entry.minute * 60_000).toISOString(), refused: entry.refused }
            : null,
        },
      },
    );
  }

  private prune(minute: number): void {
    for (const [key, entry] of this.windows) {
      if (entry.minute < minute - 1) this.windows.delete(key);
    }
  }
}

/** The limit a caller's requests count against, by how it authenticated. */
export function limitKindFor(caller: Caller): RateLimitKind | null {
  if (caller.kind === 'user') return 'session';
  if (caller.kind === 'api_credential') return 'api_credential';
  if (caller.kind === 'connection') return 'connection';
  return null;
}

/**
 * Checks a request against its limit before anything else runs, so a refused request never
 * reaches the audit queue on its own account (D11).
 */
export class RequestLimits {
  private readonly recorder: RefusalRecorder;

  constructor(
    private readonly limiter: RateLimiter | undefined,
    private readonly logger: Logger,
    now: () => number = Date.now,
  ) {
    this.recorder = new RefusalRecorder(now);
  }

  /** Null when the request may go on; otherwise the 429 response to return. */
  async check(
    c: Context<AppEnv>,
    caller: Caller,
    kind: RateLimitKind,
    key: string,
  ): Promise<Response | null> {
    if (!this.limiter || (await this.limiter.allow(kind, key))) return null;
    const event = this.recorder.refused(caller, kind, caller.boundShopId, c.get('requestId'));
    if (event) {
      // The summary is recorded after the response; it never delays or depends on the 429.
      const send = c
        .get('audit')
        .send([event])
        .catch((error) =>
          this.logger.error('ratelimit_event_not_recorded', { error: String(error) }),
        );
      try {
        c.executionCtx.waitUntil(send);
      } catch {
        // No execution context outside Workers (tests): the send simply runs.
      }
    }
    const res = problem(rateLimited(), c.get('requestId'));
    res.headers.set('retry-after', String(RATE_LIMIT_PERIOD_SECONDS));
    return res;
  }
}
