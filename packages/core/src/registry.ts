import type { Tx } from '@airstock/db';
import type { z } from 'zod';
import type { AuditEvent, AuditOutcome } from './audit.ts';
import type { Caller, Membership } from './caller.ts';
import type { MediaDelivery } from './media/signing.ts';
import type { Permission, RequiredScope } from './permissions.ts';
import type { WebhookEmit } from './webhooks/events.ts';
import type { WebhookSecretCipher } from './webhooks/signing.ts';

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

/** File storage (R2) for operations that read or write files: imports and exports. */
export interface FileAccess {
  get(key: string): Promise<string | null>;
  put(key: string, body: string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface HandlerContext {
  tx: Tx;
  /** Present when the caller's runtime has file storage. */
  files?: FileAccess;
  /** Empty for account-level reads, which span the caller's shops. */
  shopId: string;
  caller: Caller;
  /** Null only for account-level operations such as creating a shop. */
  membership: Membership | null;
  requestId: string;
  attemptId: string | null;
  /** Null means every location; otherwise the warehouse/location IDs the caller may use. */
  locationScope: string[] | null;
  newId(): string;
  /** Signs media links (ADR 0015); absent where media delivery is not configured. */
  media?: MediaDelivery;
  /** Encrypts webhook signing secrets (D14); absent where webhooks are not configured. */
  webhookSecrets?: WebhookSecretCipher;
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
  /** Defaults to `succeeded`; `no_change` when the command found nothing to do. */
  outcome?: Extract<AuditOutcome, 'succeeded' | 'no_change'>;
}

export interface HandlerResult<O> {
  result: O;
  audit: AuditDetails;
  outbox?: Array<{ topic: string; payload: unknown }>;
  /**
   * Domain events for outgoing webhooks (`webhookEvent(type, input)`). Written to the outbox in
   * the same transaction as the change, and only when the shop subscribes to the type (D14).
   */
  webhooks?: WebhookEmit[];
  /**
   * Variants whose on order changed (a purchase order sent, closed, or cancelled): the pipeline
   * checks their reorder rules in this transaction, as it does for stock changes (D12).
   */
  alertCheck?: { variantIds: string[] };
  /**
   * Extra events. Commands write them in the transaction with the success event; reads send
   * them with the access event, in the same queue message.
   */
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

/** The parsed output type of an operation, for typed clients such as the dashboard. */
export type OperationOutput<O extends AnyOperation> = z.infer<O['output']>;
/** The input type of an operation before defaults are applied. */
export type OperationInput<O extends AnyOperation> = z.input<O['input']>;

export function defineOperation<I extends z.ZodObject, O extends z.ZodType>(
  op: Operation<I, O>,
): Operation<I, O> {
  return op;
}

export function isMcpExposure(m: McpExposure | McpException): m is McpExposure {
  return 'tool' in m;
}
