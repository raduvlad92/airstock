import { buildMcpTools, isMcpExposure, operations, resolveToolCall } from '@airstock/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('operation registry (PRD 9.3, A23)', () => {
  it('has unique IDs, audit actions, and REST routes', () => {
    const unique = (values: string[]) => new Set(values).size === values.length;
    expect(unique(operations.map((o) => o.id))).toBe(true);
    expect(unique(operations.map((o) => o.audit.action))).toBe(true);
    expect(unique(operations.map((o) => `${o.http.method} ${o.http.path}`))).toBe(true);
  });

  it('exposes every operation over MCP or documents why not', () => {
    const tools = buildMcpTools(operations);
    const covered = new Set(tools.flatMap((t) => t.actions.map((a) => a.operation.id)));
    for (const op of operations) {
      if (isMcpExposure(op.mcp)) expect(covered.has(op.id)).toBe(true);
      else expect(op.mcp.exception.length).toBeGreaterThan(10);
    }
    expect(tools.length).toBeLessThanOrEqual(25);
  });

  it('builds flat object schemas that every MCP client can read', () => {
    for (const tool of buildMcpTools(operations)) {
      const schema = z.toJSONSchema(tool.inputSchema, { io: 'input' }) as { type: string };
      expect(schema.type).toBe('object');
    }
  });

  it('routes a combined tool by action and keeps the idempotency key out of the input', () => {
    const reserve = buildMcpTools(operations).find((t) => t.name === 'reserve_stock')!;
    const call = resolveToolCall(reserve, {
      action: 'release',
      reservationId: 'x',
      idempotency_key: 'k',
    });
    expect(call.operation.id).toBe('inventory.reservations.release');
    expect(call.input).toEqual({ reservationId: 'x' });
    expect(call.idempotencyKey).toBe('k');
  });

  it('marks stock commands as idempotent-required', () => {
    for (const op of operations.filter(
      (o) => o.id.startsWith('inventory.') && o.kind === 'command',
    )) {
      expect(op.idempotency).toBe('required');
    }
  });
});
