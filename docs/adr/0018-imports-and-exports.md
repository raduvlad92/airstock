# 0018. CSV imports and exports

**Status:** Accepted, 15 November 2026. Implements Phase 1 plan decision D10 and Section 5.12 (milestone N7). Supplier and pack columns added 16 November 2026.

**Summary:** CSV in R2; preview stores validated rows; set-based chunks of 200 with checkpoints, opening-stock receipts in the same transaction; exports from the catalog query

## Decision

- **Files in R2.** `imports.create` returns an upload path. `PUT /api/v1/shops/{shopId}/imports/{importId}/file` takes the raw CSV: UTF-8, comma or semicolon, up to 20 MB and 50,000 rows.
  - The upload route is the one place the 1 MB body limit is lifted.
  - It checks permission (`imports.run`) and the import's state before it writes anything.
  - Exports are written to R2 and downloaded through `GET /api/v1/shops/{shopId}/exports/{exportId}/file` for 24 hours. Each download is its own event. A daily sweep deletes files after 7 days; the history stays.
- **CSV parsing** uses a small RFC 4180 reader and writer in `packages/core/src/csv.ts` (BOM, quotes, CRLF), with no dependency. Exported text cells that start with `=`, `+`, `-`, or `@` get an apostrophe so spreadsheets do not run them as formulas.
- **Mapping:** each column maps to one of:
  - a built-in field (product key, name, SKU, barcode, price, description, status, family, tags, weight, dimensions);
  - `supplier` and `supplier_sku`;
  - `field:<key>`;
  - `option:<name>`;
  - `pack:<name>` and `pack_barcode:<name>`;
  - `stock:<locationId>`;
  - `ignore`.

  A first preview without a mapping returns the columns, a suggested mapping (by name, key, or label), and the pack names the shop uses. Headers such as "Vendor", "Vendor SKU", "Case qty", "Units per carton", and "Case GTIN" are suggested as supplier and pack columns, unless a custom field has that key or label (Shopify exports use "Vendor" for the brand). `supplier` is a reserved field key, as `supplier_sku` already was. A pack header must name a pack word (case, carton, box, inner, outer, pack, pallet, and a few more), so "Stock qty" stays unmapped. Each supplier, supplier SKU, and pack value takes one column.
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
- **Suppliers:**
  - `supplier` names an active supplier of the shop, by name in any case (or by ID). An unknown name is a row error; an import never creates suppliers.
  - `supplier_sku` needs a supplier in the same row, and the mapping needs a supplier column. A supplier SKU that repeats in the file, or that the supplier already uses for another variant, is a row error.
  - Commit creates the variant's supplier item for that supplier or updates the existing one: the one with this supplier SKU, else the one in base units, else the preferred one. An empty `supplier_sku` cell keeps the SKU.
  - When the variant has no preferred item, the imported one becomes preferred. The export writes the preferred supplier, so the file reads back the same. A variant whose items had no preferred one gets one on its first export and import.
  - Costs are never read or written, so the import needs `catalog.write` (as `save_item` does) and not `costs.read`.
- **Packs:**
  - `pack:<name>` is the exact quantity of base units in one pack of that name. Commit creates a top-level pack with that name, or gives an existing one (matched by name, any case) a new version with the new quantity, as `set_packs` does: a `pack_versions` row, the variant's packs version, and the same quantity and scale checks (`resolvePacks`). New packs get the uses `set_packs` defaults to. At most 20 packs per variant.
  - Nested packs stay out of CSV. A nested pack's column must equal its base quantity (no change). A pack that other packs are made of, or that an active bundle uses, keeps its quantity. Each is a row error; change them in the dashboard.
  - `pack_barcode:<name>` adds a barcode to that pack, with the same rules as everywhere else: check digits, and uniqueness per shop on the normalized code. A code that repeats in the file (also against `barcode` columns) or that another record holds is a row error; one the pack already has is no change. A pack barcode needs the pack to exist or its quantity in the same row.
- **Commit, packs and suppliers:** each chunk plans packs and supplier items again against the current records, set-based:
  - packs: lock the chunk's variants' packaging rows (as `set_packs` does), read their packs, and write packs, versions, and list versions in one statement;
  - barcodes of variants and packs in one statement, skipping codes taken since the preview;
  - supplier items: read and lock the chunk's items, then create or update them in one statement.

  A change that became unsafe since the preview (a pack now in a bundle, a code or supplier SKU now taken, an archived supplier) is left out, and the row keeps status `done` with an error that says what was not changed. Each variant whose packs or pack barcodes changed gets one `catalog.packs.set` event, and each created or changed supplier item one `supplier_item.saved` event, linked by `importId`. The job also checks again that the member who committed still has `catalog.write`; if not, the import fails.
- **Opening stock** goes in the same chunk transaction, also set-based: the same idempotency records `receive_stock` uses (`inventory.receipts.create`, key `import:<importId>:<row>:<locationId>`), the same operations, positions, and ledger entries, the reason "opening stock", a receipt event each, and availability outbox events. A claimed key means that receipt already happened, so a resumed import never receives twice, and a record never exists without its stock.

  This replaces calling the receipt command once per row and location: that measured about nine statements per receipt, roughly seven minutes for 10,000 rows on Neon (risk R4). The import's attempt and parent events cover the attempt-before-change rule for these receipts.
- **Exports** run the caller's catalog query (ADR 0014) page by page in a job (topic `catalog.export.run`). The file is CSV in the import's format: product key, name, SKU, barcode, supplier and supplier SKU (the preferred active supplier, no cost), price, status, family, tags, weight, `option:<name>` columns, a `pack:<name>` and `pack_barcode:<name>` pair for each pack name on the exported variants (base units, also for nested packs, and the pack's first barcode), field keys, and available stock. Lines are written after the last page, so a column that first appears on a later page is in every line. It respects field visibility and the caller's location scope, so an export imports back as updates that change nothing.
- **MCP:** a new `import_export` tool starts and follows exports and reads import status and per-row results. Starting an import and downloading files are documented exceptions (they need a file).

## Measurements (local, in process)

| Run | Preview | Commit | Statements |
| --- | --- | --- | --- |
| 10,000 rows, products with 4 sizes, 2 custom fields | 0.3 s, 28 statements | 7.1 s | 616 (0.06 per row) |
| The same with opening stock on 8,000 rows | 0.3 s | 8.3 s | 613 |
| 10,000 rows with supplier, supplier SKU, case quantity, and case barcode (same machine, later run) | 0.5 s, 32 statements | 14.1–17.3 s | 813 (0.08 per row) |

The same machine ran the plain 10,000-row import in 6.1–8.6 s and 463 statements in that session. Packs and suppliers add 7 statements per chunk (about 5–8 ms each locally) and twice the audit events. Most of the added time is the existing pending-row query, which reads wider rows. At Neon's 5–8 ms per statement these project to well under the 5-minute target. The staging figure is in the Phase 1 report (N8). `scripts/bench/import-catalog.ts --packs` repeats the run.

## Revisit when

Imports need to update records under concurrent edits with compare-and-set (they currently overwrite, as a file is the source), files go beyond 20 MB (stream-parse from R2), or the per-chunk pending-row query slows imports near 50,000 rows.
