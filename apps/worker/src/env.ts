import type { AuditEvent, OutboxMessage } from '@airstock/core';
import type { JobMessage } from './shopify.ts';

/** One queue message: a single event (Phase 0) or every event of one send (ADR 0011). */
export type AuditMessage = AuditEvent | { events: AuditEvent[] };

export interface Env {
  HYPERDRIVE: Hyperdrive;
  AUDIT_QUEUE: Queue<AuditMessage>;
  JOBS_QUEUE: Queue<OutboxMessage | JobMessage>;
  FILES: R2Bucket;
  /** MCP OAuth settings; /mcp answers 503 until they are set (plan M5). */
  MCP_ISSUER?: string;
  MCP_AUDIENCE?: string;
  MCP_JWKS_URL?: string;
  MCP_GRANT_CLAIM?: string;
  MCP_RESOURCE_URL?: string;
  MCP_AUTHORIZATION_SERVER?: string;
  /** Enables /internal/smoke for staging measurements (plan M1). */
  SMOKE_SECRET?: string;
  /** Public origin, such as https://airstock.deletecookies.dev. */
  PUBLIC_URL?: string;
  WORKOS_CLIENT_ID?: string;
  WORKOS_API_KEY?: string;
  /** Seals the session and sign-in flow cookies. */
  SESSION_SECRET?: string;
  /** Shopify app client secret (plan M6). */
  SHOPIFY_API_SECRET?: string;
  SHOPIFY_CLIENT_ID?: string;
  /** 32 random bytes, Base64: encrypts stored Shopify tokens. */
  SHOPIFY_TOKEN_KEY?: string;
  /** Names the token key, stored next to each ciphertext so the key can rotate. */
  SHOPIFY_TOKEN_KEY_ID?: string;
  /** Resend API key with sending access to the EMAIL_FROM domain (plan M7, ADR 0009). */
  RESEND_API_KEY?: string;
  /** Sender, for example: Airstock <invites@mail.airstock.example>. */
  EMAIL_FROM?: string;
  /** This Worker, bound to itself: the jobs consumer runs batches through its fetch handler. */
  SELF?: Fetcher;
  /** Authenticates the jobs consumer's calls to /internal/jobs. */
  INTERNAL_SECRET?: string;
  /** Signs short-lived media links (ADR 0015); media uploads and links are off until it is set. */
  MEDIA_SIGNING_KEY?: string;
  /** Workers Rate Limiting bindings (ADR 0011); limits are in wrangler.jsonc. */
  RATE_LIMIT_SESSION?: RateLimit;
  RATE_LIMIT_API?: RateLimit;
  RATE_LIMIT_MCP?: RateLimit;
  RATE_LIMIT_CLIENT_EVENTS?: RateLimit;
}
