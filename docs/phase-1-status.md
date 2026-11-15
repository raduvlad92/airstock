# Phase 1 status

**Updated:** 15 November 2026  
**Plan:** [Phase 1 build plan](phase-1-build-plan.md)

Staging: https://airstock.deletecookies.dev (see [staging.md](staging.md)). Every merge to `main` migrates and deploys it.

## 1. Milestones

| Milestone | State | Notes |
| --- | --- | --- |
| N0 Groundwork | Done (PR #22) | React shell at `/app` ([ADR 0010](adr/0010-web-app.md)) with the Phase 0 pages rebuilt (shops, members, AI connections, API credentials, Shopify), plus warehouses, activity, and the stock forms. Rate limits and client-reported events ([ADR 0011](adr/0011-rate-limits-and-client-events.md)). Component tests and a Chromium smoke test in CI. |
| N1 Catalog schema | In review | Custom fields of 13 types, families, the four starter templates, brand and category system fields, options with stable value IDs, variant generation with preview, inheritance, field-level compare-and-set ([ADR 0012](adr/0012-custom-fields.md), [ADR 0013](adr/0013-edit-concurrency.md)). MCP: `describe_catalog`, `manage_catalog_schema`, `edit_catalog` (replaces `create_item`), `search_catalog` (replaces `find_items`); 11 tools. The early ChatGPT check of tool choice (risk R3) needs the owner's ChatGPT and moves to the N8 run unless done sooner. |
| N2 Query, search, duplicates | Not started | |
| N3 Grid and detail panel | Not started | |
| N4 Media | Not started | |
| N5 Packs, barcodes, labels, bundles, suppliers | Not started | |
| N6 Warehouses and locations | Not started | |
| N7 Import and export | Not started | |
| N8 Measure and exit | Not started | |

## 2. Exit criteria evidence

| ID | State | Evidence |
| --- | --- | --- |
| F1 | Done in CI | `packages/core/test/catalog.test.ts` (A01: four starter families in one shop, values of every type), `apps/worker/test/catalog.test.ts` (REST and MCP) |
| F2 | Done in CI | A02 in the same files: the default variant keeps its ID, SKU, stock, and history; each variant has its own SKU and price (images arrive in N4) |
| F3 | Partly | Field-level compare-and-set (A09) in `catalog.test.ts`; bulk preview (A17) arrives in N3 |
| F6 | Done in CI | `pnpm parity`: 42 operations, 11 MCP tools |
| F4, F5, F7–F14 | Not started | |

## 3. Decisions

| ID | Decision | Record |
| --- | --- | --- |
| D1 | Custom field storage | [ADR 0012](adr/0012-custom-fields.md) |
| D3 | Edit concurrency | [ADR 0013](adr/0013-edit-concurrency.md) |
| D8 | Web app shape | [ADR 0010](adr/0010-web-app.md) |
| D11 | Rate limits | [ADR 0011](adr/0011-rate-limits-and-client-events.md) |
| D12 | MCP tool budget | [ADR 0005, update](adr/0005-operation-registry.md) |
| D13 | Rich text | [ADR 0012](adr/0012-custom-fields.md) |
