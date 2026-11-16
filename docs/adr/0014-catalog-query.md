# 0014. Catalog query compiler

**Status:** Accepted, 15 November 2026. Implements Phase 1 plan decision D2 and Sections 5.7 and 5.10 (milestone N2).

**Summary:** Typed filter compiler with keyset paging, two row modes, full-text and trigram search, one duplicate check, saved views

## Decision

- **A small typed compiler, no query builder.** `packages/core/src/catalog/query.ts` turns a whitelisted grammar into parameterized SQL over `products p` and `variants v`, behind the existing `Tx` interface:
  - up to 20 conditions, combined with AND, with one level of OR groups (`{any: [...]}`);
  - one sort on any built-in or custom field;
  - selected fields;
  - a keyset cursor.

  Field keys resolve to typed SQL expressions. Operators are checked per kind of value: text, rich text, number (integer, decimal, money, measurement), boolean, date and timestamp, single select, multi select and tags, file, and relationship. Every value travels as a parameter. Kysely is not needed: the compiler is about 450 lines and is covered by a property test.
- **Values follow ADR 0012.**
  - Variants mode reads a variant's own value when it has the key and the product's otherwise; a JSON null reads as empty.
  - Measurements compare and sort on the canonical value, and a filter value like `"2 kg"` is converted first.
  - Money compares on the amount.
  - Selects sort by option position and filter by option ID or label.
  - Relationships filter with `exists` on `record_relations`.
- **Two modes (D7).**
  - **Variants**: one row per variant.
  - **Products**: one row per product.

  In products mode a condition on a variant-level field means "any active variant matches". Sorting by a variant-level field uses the variants' lowest value (or total stock). Rows summarise the variants: count, price range, first SKUs, and the distinct values of variant-level fields.
- **Paging:** `order by expression direction nulls last, id`. The cursor carries the last row's sort value as text, its ID, and a key for the sort it was made for, so a cursor from another query is refused rather than misread. Totals are exact up to 10,000, counted on the first page only.
- **Search:**
  - exact or prefix SKU match;
  - full text on name and description with the `simple` configuration, so several EU languages match without stemming;
  - trigram similarity on names, for typos.

  Name matches come from an indexed subquery (GIN full-text and trigram indexes), which keeps search to about 65 ms on 30,000 variants locally. With no explicit sort, results come in relevance order. Barcodes and supplier SKUs join the search when milestone N5 adds them.
- **Stock:** `available` is computed per row over the caller's location scope (sellable stock at active, fulfillment-eligible locations, net of allocations, crediting expired ones). It can be selected, filtered, and sorted.
- **Duplicates (5.7):** one check, `findDuplicates`, used by the create command and by `catalog.duplicates.check`:
  - a normalized SKU or barcode that is already taken is refused;
  - names with trigram similarity of at least 0.6, or equal after normalization, come back as likely matches.

  Creating with a similar name needs `acknowledgeSimilar`; without it the create fails with `similar_items_found` and the matches. The pipeline now records a failed command's problem details in the outcome event, so the warning shown and the later choice (`acknowledgedSimilar` in the success event) are both in the history.
- **Audit (A10):** every query is an audited read, with its mode, search, filters, sort, fields, and result count in the event context.
- **Saved views** store the mode, view type, columns (order, width, hidden), sort, filters, search, and density. They are private to their owner or shared with the shop; sharing or changing a shared view needs `catalog.write`. They are an MCP exception (interface preferences).

## Measurements (local, 3 shops × 10,000 variants, `scripts/bench`)

| Query, 50 rows | p95 |
| --- | --- |
| List, default sort | 29 ms |
| Custom select filter with a custom measurement sort | 33 ms |
| Custom range and multi-select filters with a decimal sort and four values | 29 ms |
| Products mode, filter on a variant field | 29 ms |
| Search | 67 ms |
| In stock, with availability | 86 ms |

Staging figures (Neon, through the Worker) are part of the Phase 1 report (N8).

## Revisit when

Staging p95 approaches 1 second on custom-field filters or sorts (add expression indexes on the fields in use, then generated columns: risk R1), or the grammar needs nesting deeper than one OR level.
