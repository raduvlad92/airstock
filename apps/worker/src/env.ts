import type { AuditEvent, OutboxMessage } from '@airstock/core';

export interface Env {
  HYPERDRIVE: Hyperdrive;
  AUDIT_QUEUE: Queue<AuditEvent>;
  JOBS_QUEUE: Queue<OutboxMessage>;
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
}
