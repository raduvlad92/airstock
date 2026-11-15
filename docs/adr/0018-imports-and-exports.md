# 0018. CSV imports and exports

**Status:** Accepted, 15 November 2026. Implements Phase 1 plan decision D10 and Section 5.12 (milestone N7).

## Decision

- **Files in R2.** `imports.create` returns an upload path. `PUT /api/v1/shops/{shopId}/imports/{importId}/file` takes the raw CSV: UTF-8, comma or semicolon, up to 20 MB and 50,000 rows.
  - The upload route is the one place the 1 MB body limit is lifted.
  - It checks permission (`imports.run`) and the import's state before it writes anything.
  - Exports are written to R2 and downloaded through `GET /api/v1/shops/{shopId}/exports/{exportId}/file` for 24 hours. Each download is its own event. A daily sweep deletes files after 7 days; the history stays.
- **CSV parsing** uses a small RFC 4180 reader and writer in `packages/core/src/csv.ts` (BOM, quotes, CRLF), with no dependency. Exported text cells that start with `=`, `+`, `-`, or `@` get an apostrophe so spreadsheets do not run them as formulas.
- **Mapping:** each column maps to one of:
  - a built-in field (product key, name, SKU, price, description, status, family, tags, weight, dimensions);
  - `field:<key>`;
  - `option:<name>`;
  - `stock:<locationId>`;
  - `ignore`.

  A first preview without a mapping returns the columns and a suggested mapping (by name, key, or label).
- **Preview** validates every row and writes nothing to the catalog. It uses the same encoder as the API and the grid (ADR 0012), with these rules:
  - Rows whose SKU exists update that variant.
  - Other rows create products, grouped into variants by the product-key column (or the name).
  - New products are checked as a whole: a name, distinct option combinations, at most 3 options and 2,048 variants, and required fields when active.
  - Repeated SKUs are errors.
  - Similar existing names are warnings (plan 5.7).

  Each row's validated values are stored in `import_rows` with its action, errors, and warnings. Empty cells change nothing.
- **Commit** (`imports.commit`) records the import's parent event and queues a job (topic `catalog.import.run`). The job:
  - runs through the Worker's own fetch handler, as Phase 0 jobs do;
  - takes whole products until a chunk reaches about 200 rows;
  - writes each chunk set-based in one transaction: products, options, variants, merged updates, relations, the rows' outcomes, one event per record (with `importId`), and the checkpoint.

  A run stops after 20 seconds and queues its continuation. A cron sweep resumes imports whose job stopped, from the checkpoint (A19).
- **Opening stock** goes in the same chunk transaction, also set-based: the same idempotency records `receive_stock` uses (`inventory.receipts.create`, key `import:<importId>:<row>:<locationId>`), the same operations, positions, and ledger entries, the reason "opening stock", a receipt event each, and availability outbox events. A claimed key means that receipt already happened, so a resumed import never receives twice, and a record never exists without its stock.

  This replaces calling the receipt command once per row and location: that measured about nine statements per receipt, roughly seven minutes for 10,000 rows on Neon (risk R4). The import's attempt and parent events cover the attempt-before-change rule for these receipts.
- **Exports** run the caller's catalog query (ADR 0014) page by page in a job (topic `catalog.export.run`). The file is CSV in the import's format: product key, name, SKU, price, status, family, tags, weight, `option:<name>` columns, field keys, and available stock. It respects field visibility and the caller's location scope, so an export imports back as updates.
- **MCP:** a new `import_export` tool starts and follows exports and reads import status and per-row results. Starting an import and downloading files are documented exceptions (they need a file).

## Measurements (local, in process)

| Run | Preview | Commit | Statements |
| --- | --- | --- | --- |
| 10,000 rows, products with 4 sizes, 2 custom fields | 0.3 s, 28 statements | 7.1 s | 616 (0.06 per row) |
| The same with opening stock on 8,000 rows | 0.3 s | 8.3 s | 613 |

At Neon's 5–8 ms per statement these project to well under the 5-minute target. The staging figure is in the Phase 1 report (N8).

## Revisit when

Imports need to update records under concurrent edits with compare-and-set (they currently overwrite, as a file is the source), files go beyond 20 MB (stream-parse from R2), or the per-chunk pending-row query slows imports near 50,000 rows.
