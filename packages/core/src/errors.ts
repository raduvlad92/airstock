import type { AuditOutcome } from './audit.ts';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  errors?: Array<{ path: string; message: string }>;
  [extra: string]: unknown;
}

/** An expected failure with a stable code. REST returns it as RFC 9457 problem details. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly outcome: AuditOutcome,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }

  toProblem(requestId?: string): ProblemDetails {
    return {
      type: `https://airstock.dev/problems/${this.code}`,
      title: this.message,
      status: this.status,
      code: this.code,
      ...(requestId ? { requestId } : {}),
      ...this.extra,
    };
  }
}

export const errors = {
  validation: (issues: Array<{ path: string; message: string }>) =>
    new AppError(400, 'validation_failed', 'The request is not valid.', 'failed', {
      errors: issues,
    }),
  unauthenticated: () =>
    new AppError(401, 'unauthenticated', 'Authentication is required.', 'denied'),
  forbidden: (detail: string) =>
    new AppError(403, 'forbidden', 'You do not have permission for this action.', 'denied', {
      detail,
    }),
  notFound: (what: string) =>
    new AppError(404, 'not_found', `${what} was not found.`, 'failed', { detail: what }),
  conflict: (code: string, message: string, extra: Record<string, unknown> = {}) =>
    new AppError(409, code, message, 'conflict', extra),
  unprocessable: (code: string, message: string, extra: Record<string, unknown> = {}) =>
    new AppError(422, code, message, 'failed', extra),
  auditUnavailable: () =>
    new AppError(
      503,
      'audit_unavailable',
      'The activity log could not record this request, so it was not carried out.',
      'failed',
    ),
  outcomeUnknown: () =>
    new AppError(
      503,
      'outcome_unknown',
      'The result of this command is unknown. Retry with the same idempotency key, or look it up with the operation outcome endpoint.',
      'unknown',
    ),
  serviceUnavailable: () =>
    new AppError(
      503,
      'service_unavailable',
      'The service is temporarily unavailable. Retry later.',
      'failed',
    ),
  internal: () => new AppError(500, 'internal_error', 'An unexpected error occurred.', 'failed'),
};
