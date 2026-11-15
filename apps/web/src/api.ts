import type { AnyOperation, OperationOutput } from '@airstock/core';

/** The typed result of a registry operation, for example `Out<typeof ops.listShops>`. */
export type Out<O extends AnyOperation> = OperationOutput<O>;

/** An RFC 9457 problem returned by the API (packages/core/src/errors.ts). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly problem: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field messages from a validation problem, keyed by path. */
  get fieldErrors(): Record<string, string> {
    const list = this.problem.errors as Array<{ path: string; message: string }> | undefined;
    return Object.fromEntries((list ?? []).map((e) => [e.path, e.message]));
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Commands that require one get a fresh key per user action unless a retry passes its own. */
  idempotencyKey?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  keepalive?: boolean;
}

/** Called when the session has ended; the app sends the user to sign in again. */
let onUnauthenticated = () => {
  const back = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/auth/login?return_to=${encodeURIComponent(back)}`);
};

export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

/**
 * Calls /api/v1 like any other client. The session cookie authenticates; the custom header is
 * what a cross-site page cannot send without a CORS preflight, which Airstock never approves.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== '')
      url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { 'x-airstock-request': '1' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  const res = await fetch(url, {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
    signal: options.signal,
    keepalive: options.keepalive,
  });
  const text = await res.text();
  const body = text ? safeParse(text) : null;
  if (!res.ok) {
    if (res.status === 401) onUnauthenticated();
    const problem = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    throw new ApiError(
      res.status,
      typeof problem.code === 'string' ? problem.code : 'http_error',
      typeof problem.title === 'string' ? problem.title : `Request failed (${res.status})`,
      problem,
    );
  }
  return body as T;
}

/** A command that needs an idempotency key: one key per call, so a retry is the caller's choice. */
export function command<T>(path: string, body: unknown, idempotencyKey = crypto.randomUUID()) {
  return api<T>(path, { method: 'POST', body, idempotencyKey });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Text for an error shown to the user. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = typeof error.problem.detail === 'string' ? ` ${error.problem.detail}` : '';
    const fields = Object.entries(error.fieldErrors)
      .map(([path, message]) => `${path || 'input'}: ${message}`)
      .join('; ');
    return `${error.message}${fields ? ` ${fields}` : detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}
