/**
 * Registry parity check (PRD 9.3, A23). Every operation must have a REST route, a
 * permission, an audit action, and either an MCP tool or a documented exception.
 * A new feature is incomplete until this passes.
 */
import { buildMcpTools, isMcpExposure, operations } from '@airstock/core';

const problems: string[] = [];
const seen = { ids: new Set<string>(), actions: new Set<string>(), routes: new Set<string>() };
const tools = buildMcpTools(operations);
const viaMcp = new Map(
  tools.flatMap((t) => t.actions.map((a) => [a.operation.id, t.name] as const)),
);

const rows: string[][] = [];
for (const op of operations) {
  const route = `${op.http.method} /api/v1${op.http.path}`;
  if (seen.ids.has(op.id)) problems.push(`Duplicate operation ID ${op.id}`);
  if (seen.actions.has(op.audit.action)) problems.push(`Duplicate audit action ${op.audit.action}`);
  if (seen.routes.has(route)) problems.push(`Duplicate route ${route}`);
  seen.ids.add(op.id);
  seen.actions.add(op.audit.action);
  seen.routes.add(route);
  if (!op.permission) problems.push(`${op.id} has no permission`);
  if (!op.audit.action) problems.push(`${op.id} has no audit action`);
  if (op.scope === 'shop' && !op.http.path.startsWith('/shops/{shopId}')) {
    problems.push(`${op.id} is shop-scoped but its route does not start with /shops/{shopId}`);
  }
  let mcp: string;
  if (isMcpExposure(op.mcp)) {
    const tool = viaMcp.get(op.id);
    if (!tool) problems.push(`${op.id} names MCP tool ${op.mcp.tool}, which was not built`);
    mcp = `${tool}${op.mcp.action ? ` (${op.mcp.action})` : ''}`;
  } else {
    if (op.mcp.exception.trim().length < 10)
      problems.push(`${op.id} needs a real reason for its MCP exception`);
    mcp = `exception: ${op.mcp.exception}`;
  }
  rows.push([op.id, route, op.permission, op.audit.action, mcp]);
}
if (tools.length > 25) problems.push(`${tools.length} MCP tools; the launch target is 25 or fewer`);

for (const row of rows) console.log(row.join('  |  '));
console.log(`\n${operations.length} operations, ${tools.length} MCP tools.`);
if (problems.length > 0) {
  console.error(`\nParity check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('Parity check passed.');
