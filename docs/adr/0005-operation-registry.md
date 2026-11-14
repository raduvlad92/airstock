# 0005. Operation registry, REST, OpenAPI, and MCP

**Status:** Accepted, 14 November 2026. Implements PRD 9.3.

## Decision

- Each operation is defined once in `packages/core/src/operations` with its ID, Zod input and output, permission, connection scope, audit action, idempotency rule, REST method and path, and MCP exposure.
- **REST** routes are registered in a loop over the registry (`apps/worker/src/rest.ts`). Path parameters, the query string (GET), or the JSON body (POST) form the input; the pipeline validates it.
- **OpenAPI 3.1** is generated from the registry with Zod's built-in JSON Schema conversion (`pnpm openapi`) into `docs/api/openapi.json`. CI fails if the committed file is stale. This replaces the proposed `@hono/zod-openapi`: routes are already generated, so a second route layer would add a dependency without benefit.
- **MCP** tools are task-shaped and composed from operations (PRD 9.3). A tool that covers several operations takes an `action` argument; schemas stay flat objects so every MCP client can read them. Commands accept an optional `idempotency_key`. Phase 0 has 9 tools.
- Operations not reachable over MCP declare a reason. Phase 0 exceptions: creating a shop (account-level, while an MCP connection is bound to one shop) and managing credentials and connections (interactive sessions only, so a connection cannot widen or manage its own access).
- `pnpm parity` (in CI) and `registry.test.ts` check that every operation has a route, permission, audit action, and MCP tool or exception (A23).
- Errors use RFC 9457 problem details with a stable `code`, in REST and inside MCP tool errors.

## Revisit when

The tool count approaches 25, or a client needs per-action schemas instead of a flat object.
