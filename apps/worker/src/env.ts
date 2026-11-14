import type { AuditEvent, OutboxMessage } from '@airstock/core';
import type { JobMessage } from './shopify.ts';

export interface Env {
  HYPERDRIVE: Hyperdrive;
  AUDIT_QUEUE: Queue<AuditEvent>;
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
}
