# Phase 1 status

**Updated:** 15 November 2026  
**Plan:** [Phase 1 build plan](phase-1-build-plan.md)

Staging: https://airstock.deletecookies.dev (see [staging.md](staging.md)). Every merge to `main` migrates and deploys it.

## 1. Milestones

| Milestone | State | Notes |
| --- | --- | --- |
| N0 Groundwork | Done (PR #22) | React shell at `/app` ([ADR 0010](adr/0010-web-app.md)) with the Phase 0 pages rebuilt (shops, members, AI connections, API credentials, Shopify), plus warehouses, activity, and the stock forms. Rate limits and client-reported events ([ADR 0011](adr/0011-rate-limits-and-client-events.md)). Component tests and a Chromium smoke test in CI. |
| N1 Catalog schema | Done (PR #23) | Custom fields of 13 types, families, the four starter templates, brand and category system fields, options with stable value IDs, variant generation with preview, inheritance, field-level compare-and-set ([ADR 0012](adr/0012-custom-fields.md), [ADR 0013](adr/0013-edit-concurrency.md)). MCP: `describe_catalog`, `manage_catalog_schema`, `edit_catalog` (replaces `create_item`), `search_catalog` (replaces `find_items`); 11 tools. The early ChatGPT check of tool choice (risk R3) needs the owner's ChatGPT and moves to the N8 run unless done sooner. |
| N2 Query, search, duplicates | Done (PR #24) | `catalog.items.query` with the typed filter compiler, two row modes, keyset paging, full-text and trigram search, stock in scope ([ADR 0014](adr/0014-catalog-query.md)); one duplicate check on the create path with `acknowledgeSimilar`; saved views; benchmark seed and query timing in `scripts/bench`. Barcodes and supplier SKUs join search and duplicates when N5 lands. |
| N3 Grid and detail panel | Done (PR #26) | Variants and products grid with virtualized rows and columns, keyboard, copy and paste, fill down, compare-and-set cells with conflict choices; bulk preview and commit ([ADR 0017](adr/0017-grid-and-bulk-edits.md)); detail panel (details by family group, variants and generation, related, stock forms, history); gallery; filters and saved views; settings for fields, families, templates, and units. Pictures, packaging, and suppliers plug in when N4 and N5 land. |
| N4 Media | In progress (parallel agent) | |
| N5 Packs, barcodes, labels, bundles, suppliers | In progress (parallel agent) | |
| N6 Warehouses and locations | In progress (parallel agent) | |
| N7 Import and export | In review | Upload, mapping, preview of every row, set-based chunked commit with checkpoints and resume, opening stock as receipts in the same transaction, exports in the import format with logged downloads and 7-day files ([ADR 0018](adr/0018-imports-and-exports.md)). 10,000 rows commit locally in about 8 s with 613 statements. Packs, barcodes, and supplier SKUs join the mapping when N5 lands. |
| N8 Measure and exit | Not started | |

## 2. Exit criteria evidence

| ID | State | Evidence |
| --- | --- | --- |
| F1 | Done in CI | `packages/core/test/catalog.test.ts` (A01: four starter families in one shop, values of every type), `apps/worker/test/catalog.test.ts` (REST and MCP) |
| F2 | Done in CI | A02 in the same files: the default variant keeps its ID, SKU, stock, and history; each variant has its own SKU and price (images arrive in N4) |
| F3 | Done in CI | A09 in `packages/core/test/catalog.test.ts` and the Chromium grid test; A17 in `packages/core/test/bulk.test.ts` and `apps/web/e2e/grid.spec.ts` |
| F6 | Done in CI | `pnpm parity`: 60 operations, 12 MCP tools |
| F9 | Partly | A43 for SKUs and similar names on the API and MCP create paths (`packages/core/test/query.test.ts`, `apps/worker/test/catalog.test.ts`); barcodes with N5, import with N7, dashboard with N3 |
| F12 | Partly | Local p95 under 90 ms for every query shape on 3 × 10,000 variants ([ADR 0014](adr/0014-catalog-query.md)); the grid loads pages of 50 and never the whole catalog (Chromium test with 10,000 variants); staging run in N8 |
| F4 | Done in CI | A10 in `apps/web/e2e/grid.spec.ts`: column resize, view switch, detail panel open and close as client events; queries with their filters and edits as server events. Media events arrive with N4. |
| F10 | Done in CI | `packages/core/test/imports.test.ts` (preview, commit, opening stock as receipts, A19 resume), `apps/worker/test/imports.test.ts` (upload, permission, download event), `apps/web/e2e/imports.spec.ts`; staging timing in N8 |
| F5, F7, F8, F11, F13, F14 | Not started | |

## 3. Decisions

| ID | Decision | Record |
| --- | --- | --- |
| D1 | Custom field storage | [ADR 0012](adr/0012-custom-fields.md) |
| D2 | Dynamic filters | [ADR 0014](adr/0014-catalog-query.md) |
| D3 | Edit concurrency | [ADR 0013](adr/0013-edit-concurrency.md) |
| D8 | Web app shape | [ADR 0010](adr/0010-web-app.md) |
| D4 | Bulk edits | [ADR 0017](adr/0017-grid-and-bulk-edits.md) |
| D7 | Grid rows | [ADR 0017](adr/0017-grid-and-bulk-edits.md) |
| D10 | Imports and exports | [ADR 0018](adr/0018-imports-and-exports.md) |
| D11 | Rate limits | [ADR 0011](adr/0011-rate-limits-and-client-events.md) |
| D12 | MCP tool budget | [ADR 0005, update](adr/0005-operation-registry.md) |
| D13 | Rich text | [ADR 0012](adr/0012-custom-fields.md) |
