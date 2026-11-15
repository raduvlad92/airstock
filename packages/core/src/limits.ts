/**
 * Request rate limits per caller (plan Section 5.15, ADR 0011). The Worker enforces them with the
 * Workers Rate Limiting binding, whose window is 10 or 60 seconds, so `wrangler.jsonc` sets
 * `perSecond × RATE_LIMIT_PERIOD_SECONDS` per window. A test keeps the two in step.
 */
export const RATE_LIMITS = {
  /** A signed-in dashboard user, across all of their shops. */
  session: { perSecond: 20, label: 'Dashboard session, per user' },
  /** One API credential. */
  api_credential: { perSecond: 10, label: 'API credential, per credential' },
  /** One MCP connection grant. */
  connection: { perSecond: 5, label: 'MCP connection, per connection' },
  /** Batches of client-reported interface events, per user. */
  client_events: { perSecond: 1, label: 'Client event batches, per user' },
} as const;

export type RateLimitKind = keyof typeof RATE_LIMITS;

export const RATE_LIMIT_PERIOD_SECONDS = 10;
