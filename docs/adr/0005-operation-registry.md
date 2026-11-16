# 0005. Operation registry, REST, OpenAPI, and MCP

**Status:** Accepted, 14 November 2026. Implements PRD 9.3.

**Summary:** One registry generates REST, OpenAPI, permissions, audit names, and task-shaped MCP tools

## Decision

- Each operation is defined once in `packages/core/src/operations` with its ID, Zod input and output, permission, connection scope, audit action, idempotency rule, REST method and path, and MCP exposure.
- **REST** routes are registered in a loop over the registry (`apps/worker/src/rest.ts`). Path parameters, the query string (GET), or the JSON body (POST) form the input; the pipeline validates it.
- **OpenAPI 3.1** is generated from the registry with Zod's built-in JSON Schema conversion (`pnpm openapi`) into `docs/api` (one file per operation since the update of 16 November 2026). CI fails if a committed file is stale. This replaces the proposed `@hono/zod-openapi`: routes are already generated, so a second route layer would add a dependency without benefit.
- **MCP** tools are task-shaped and composed from operations (PRD 9.3). A tool that covers several operations takes an `action` argument; schemas stay flat objects so every MCP client can read them. Commands accept an optional `idempotency_key`. Phase 0 has 9 tools.
- Operations not reachable over MCP declare a reason. Phase 0 exceptions: creating a shop (account-level, while an MCP connection is bound to one shop) and managing credentials and connections (interactive sessions only, so a connection cannot widen or manage its own access).
- `pnpm parity` (in CI) and `registry.test.ts` check that every operation has a route, permission, audit action, and MCP tool or exception (A23).
- Errors use RFC 9457 problem details with a stable `code`, in REST and inside MCP tool errors.

## Update, 15 November 2026 (Phase 1, D12)

The tool budget after Phase 1 is 16 or fewer, leaving room for Phase 2 under the 25 above. Phase 1 replaces `create_item` with `edit_catalog`, `find_items` with `search_catalog`, and adds `describe_catalog` and `manage_catalog_schema` (N1), then `manage_media`, `manage_suppliers`, `manage_storage` (replacing `manage_locations`), and `import_export`. After N1 there are 11 tools. Tools that share an argument name use the same schema for it across their actions, because the MCP schema is flat. New Phase 1 exceptions: shop settings (dashboard only), client events (dashboard telemetry), file upload, label rendering, saved views, and starting an import.

## Update, 16 November 2026: files that parallel branches share

Phase 1 ran four milestones in parallel, and most merge conflicts were in a few shared files: the operation lists in `operations/index.ts`, the tool list in `mcp.test.ts`, `openapi.json`, and the ADR index. These are now laid out so that a typical change touches no shared file.

- **Operations.** Each module in `packages/core/src/operations` ends with its own list, `<module>Operations`. The list order is the order in which MCP lists a tool's actions. `operations/index.ts` joins the lists in file-name order and re-exports each module with `export *`, so `ops.<name>` still reaches every operation. `registry.test.ts` fails when an exported operation is in no list or in two, or when a module defines an operation it does not export. Integration callbacks stay a separate list (`shopifyIntegrationCallbacks`).
- **Routes.** REST routes are registered sorted by path. At the first segment where two paths differ, a fixed segment comes before a parameter, so registry order cannot let `/items/{itemId}` take `/items/query`. `rest-routes.test.ts` sends every operation's own path and expects that operation.
- **OpenAPI.** `pnpm openapi` writes `docs/api/document.json` (the document without `paths`) and `docs/api/operations/<operationId>.json` (one `paths` entry each). `pnpm openapi:check` fails on a stale, missing, or extra file. `scripts/openapi-bundle.mjs` joins them into one document; Wrangler runs it before every build and dev session, and the Worker serves it at `/openapi.json`. Paths are sorted by path and method. Apart from that order, the joined document is identical to the previous `openapi.json`.
- **MCP tests.** `apps/worker/test/mcp-client.ts` connects a test client with a grant. An area's tool tests live with its other tests. The exact tool list is a contract and has its own test, `mcp-tools.test.ts`.
- **ADRs.** `docs/adr/README.md` is generated from each ADR's title, status, and `**Summary:**` line (`pnpm adr`), and the check fails on two ADRs with the same number. Number an ADR when its PR merges. Git merges the index with the union driver.
- **Order.** Joining module lists in file-name order changed the action order of `edit_catalog` and `search_catalog` in their `action` enum and description. The tools, their actions, and their argument schemas are unchanged.
- **Core barrel.** `packages/core/src/index.ts` stays hand-written. It has one export block per source file, sorted by path, so additions from different modules land in different places; in Phase 1 it never conflicted. It also decides what the Worker and the dashboard may import, which `export *` would give up. Operations reach it through `ops` and need no edit there.

Which files a change touches:

| Change | Files |
| --- | --- |
| An operation in an existing module | The module (the definition and one line in its list), its tests, and its generated `docs/api/operations/<id>.json` |
| A new operation module | The new module, and one sorted line in each of the three groups in `operations/index.ts` |
| An action on an existing MCP tool | The operation's `mcp` field and the area's tests |
| A new MCP tool | As above, plus one sorted line in `mcp-tools.test.ts` (16 tools or fewer) |
| An ADR | The ADR file, and the generated `docs/adr/README.md` |

## Update, 16 November 2026 (Phase 2, D16)

The 16-tool budget above was our own, not a ChatGPT limit; OpenAI documents none. Phase 2 grows to about 22 task-shaped tools (Phase 2 plan, Section 5.16).

The gate is measured tool choice, not a count. Each milestone's ChatGPT prompts are checked with `scripts/chatgpt-run.ts`, and a wrong pick is fixed before the milestone closes.

Following OpenAI's guidance (Phase 2 status, Section 5.1):
- Tool descriptions say "Use this when…" and name the cases a tool is not for.
- Read-only tools carry `readOnlyHint`.
- Cross-tool guidance lives in the server `instructions`, with its first 512 characters self-contained.

## Revisit when

A milestone's ChatGPT run shows wrong tool or action choices that wording does not fix, or a client needs per-action schemas instead of a flat object.
