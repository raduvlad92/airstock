import { z } from 'zod';
import type { AnyOperation, McpExposure } from './registry.ts';
import { isMcpExposure } from './registry.ts';

/**
 * A task-shaped MCP tool composed from registry operations (PRD 9.3). Tools with several
 * operations take an `action` argument. Inputs stay flat objects so every MCP client can
 * read the schema.
 */
export interface McpToolDef {
  name: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  inputSchema: z.ZodObject;
  actions: Array<{ action: string | null; operation: AnyOperation }>;
}

const IDEMPOTENCY_FIELD = 'idempotency_key';

export function buildMcpTools(operations: readonly AnyOperation[]): McpToolDef[] {
  const groups = new Map<string, Array<{ op: AnyOperation; mcp: McpExposure }>>();
  for (const op of operations) {
    if (!isMcpExposure(op.mcp)) continue;
    const list = groups.get(op.mcp.tool) ?? [];
    list.push({ op, mcp: op.mcp });
    groups.set(op.mcp.tool, list);
  }

  return [...groups.entries()].map(([name, members]) => {
    const multi = members.length > 1;
    if (multi && members.some((m) => !m.mcp.action)) {
      throw new Error(`MCP tool ${name} combines several operations, so each needs an action.`);
    }
    const anyCommand = members.some((m) => m.op.kind === 'command');
    const shape: Record<string, z.ZodType> = {};
    if (multi) {
      shape.action = z
        .enum(members.map((m) => m.mcp.action!) as [string, ...string[]])
        .describe('What to do.');
    }
    for (const { op } of members) {
      for (const [key, field] of Object.entries(op.input.shape as Record<string, z.ZodType>)) {
        // In a combined tool a field only some actions use cannot be required at the top level.
        if (!(key in shape)) shape[key] = multi ? field.optional() : field;
      }
    }
    if (anyCommand) {
      shape[IDEMPOTENCY_FIELD] = z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'Reuse the same key when retrying the same request, so it is not carried out twice.',
        );
    }
    const description = multi
      ? members
          .map((m) => `action "${m.mcp.action}": ${m.op.summary}. ${m.op.description ?? ''}`.trim())
          .join('\n')
      : `${members[0]!.op.summary}. ${members[0]!.op.description ?? ''}`.trim();
    return {
      name,
      description,
      readOnly: members.every((m) => m.mcp.readOnly),
      destructive: members.some((m) => m.mcp.destructive),
      inputSchema: z.object(shape),
      actions: members.map((m) => ({ action: m.mcp.action ?? null, operation: m.op })),
    };
  });
}

/** Picks the operation for a tool call and separates the idempotency key from its input. */
export function resolveToolCall(
  tool: McpToolDef,
  args: Record<string, unknown>,
): { operation: AnyOperation; input: Record<string, unknown>; idempotencyKey: string | null } {
  const { action, [IDEMPOTENCY_FIELD]: key, ...rest } = args;
  const match =
    tool.actions.length === 1 ? tool.actions[0] : tool.actions.find((a) => a.action === action);
  if (!match) throw new Error(`Unknown action for ${tool.name}.`);
  return {
    operation: match.operation,
    input: rest,
    idempotencyKey: typeof key === 'string' ? key : null,
  };
}
