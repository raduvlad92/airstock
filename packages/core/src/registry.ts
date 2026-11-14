import type { Tx } from '@airstock/db';
import type { z } from 'zod';
import type { AuditEvent } from './audit.ts';
import type { Caller, Membership } from './caller.ts';
import type { Permission, RequiredScope } from './permissions.ts';

/** How an operation appears to MCP clients: as part of a task-shaped tool (PRD 9.3). */
export interface McpExposure {
  tool: string;
  /** Set when one tool covers several operations; becomes the tool's `action` value. */
  action?: string;
  readOnly: boolean;
  destructive: boolean;
}

/** An operation deliberately not reachable over MCP, with the reason (checked in CI). */
export interface McpException {
  exception: string;
}

export interface HandlerContext {
  tx: Tx;
  shopId: string;
  caller: Caller;
  /** Null only for account-level operations such as creating a shop. */
  membership: Membership | null;
  requestId: string;
  attemptId: string | null;
  /** Null means every location; otherwise the warehouse/location IDs the caller may use. */
  locationScope: string[] | null;
  newId(): string;
  /** An extra event produced inside the transaction, such as a reservation expired lazily. */
  event(fields: Pick<AuditEvent, 'action' | 'outcome'> & Partial<AuditEvent>): AuditEvent;
}

export interface AuditDetails {
  targetType: string;
  targetId: string;
  changes?: unknown;
  context?: unknown;
  locationIds?: string[];
  operationId?: string | null;
  externalRef?: string | null;
  reason?: string | null;
}

export interface HandlerResult<O> {
  result: O;
  audit: AuditDetails;
  outbox?: Array<{ topic: string; payload: unknown }>;
  events?: AuditEvent[];
}

export interface Operation<I extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType> {
  /** Stable ID, also the default audit action prefix and the idempotency binding. */
  id: string;
  summary: string;
  description?: string;
  kind: 'read' | 'command';
  /** 'shop' runs inside one shop; 'account' creates or lists across the caller's shops. */
  scope: 'shop' | 'account';
  input: I;
  output: O;
  /** 'authenticated' means any signed-in user (account-level operations only). */
  permission: Permission | 'authenticated';
  connectionScope: RequiredScope;
  audit: { action: string };
  idempotency: 'required' | 'none';
  http: { method: 'GET' | 'POST'; path: string; status?: 200 | 201 };
  mcp: McpExposure | McpException;
  /** Locations the operation touches; each must be inside the caller's location scope. */
  locations?: (input: z.infer<I>, tx: Tx) => Promise<string[]> | string[];
  handler: (ctx: HandlerContext, input: z.infer<I>) => Promise<HandlerResult<z.infer<O>>>;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry of typed operations
export type AnyOperation = Operation<any, any>;

export function defineOperation<I extends z.ZodObject, O extends z.ZodType>(
  op: Operation<I, O>,
): Operation<I, O> {
  return op;
}

export function isMcpExposure(m: McpExposure | McpException): m is McpExposure {
  return 'tool' in m;
}
