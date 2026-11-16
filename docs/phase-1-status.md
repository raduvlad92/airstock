# Phase 1 status

**Updated:** 16 November 2026  
**Plan:** [Phase 1 build plan](phase-1-build-plan.md) · **Report:** [Phase 1 report](phase-1-report.md)

Staging: https://airstock.deletecookies.dev (see [staging.md](staging.md)). Every merge to `main` migrates and deploys it.

## 1. Milestones

| Milestone | State | Notes |
| --- | --- | --- |
| N0 Groundwork | Done (PR #22) | React shell at `/app` ([ADR 0010](adr/0010-web-app.md)); rate limits and client-reported events ([ADR 0011](adr/0011-rate-limits-and-client-events.md)). |
| N1 Catalog schema | Done (PR #23) | Custom fields, families, templates, options, variant generation, field-level compare-and-set ([ADR 0012](adr/0012-custom-fields.md), [ADR 0013](adr/0013-edit-concurrency.md)). |
| N2 Query, search, duplicates | Done (PR #24) | Filter compiler, keyset paging, search, duplicate check, saved views ([ADR 0014](adr/0014-catalog-query.md)). |
| N3 Grid and detail panel | Done (PR #26) | Grid, bulk edits, detail panel, gallery, settings ([ADR 0017](adr/0017-grid-and-bulk-edits.md)). |
| N4 Media | Done (PR #28) | Uploads to R2 with checks, browser-made derivatives, signed links, access events; Pictures tab and gallery pictures ([ADR 0015](adr/0015-media.md)). `MEDIA_SIGNING_KEY` is set on staging. |
| N5 Packs, barcodes, labels, bundles, suppliers | Done (PRs #29, #32) | Packs, barcodes, bundles, suppliers, and labels ([ADR 0019](adr/0019-packaging-labels-bundles.md)). The dashboard adds a labels page with the PDF made in the browser, a suppliers page, Packaging and Suppliers tabs in the detail panel, and the decode test (F8). |
| N6 Warehouses and locations | Done (PR #25) | Warehouse records and contracts, location hierarchy rules, location scopes ([ADR 0016](adr/0016-warehouse-records.md)). |
| N7 Import and export | Done (PR #27) | CSV preview, chunked commit with resume, opening stock as receipts, logged exports ([ADR 0018](adr/0018-imports-and-exports.md)). |
| Across milestones | Done (PRs #30, #31) | Barcodes on create, duplicates, search, and CSV; completeness fields; supplier columns in exports; outbox drain (a bug found on staging). |
| N8 Measure and exit | Done | Staging benchmark, staging run in a real browser, measurements, cost model, and report ([Phase 1 report](phase-1-report.md)). The owner's ChatGPT run (F13) was on 15–16 November (Section 5). |

## 2. Exit criteria evidence

See the [Phase 1 report](phase-1-report.md), Section 1, for the evidence per criterion.

| ID | State |
| --- | --- |
| F1–F14 | Done. F13 with two findings (Section 5) |

## 3. Decisions

| ID | Decision | Record |
| --- | --- | --- |
| D1 | Custom field storage | [ADR 0012](adr/0012-custom-fields.md) |
| D2 | Dynamic filters | [ADR 0014](adr/0014-catalog-query.md) |
| D3 | Edit concurrency | [ADR 0013](adr/0013-edit-concurrency.md) |
| D4 | Bulk edits | [ADR 0017](adr/0017-grid-and-bulk-edits.md) |
| D5 | Media access logging | [ADR 0015](adr/0015-media.md) |
| D6 | Media pipeline | [ADR 0015](adr/0015-media.md) |
| D7 | Grid rows | [ADR 0017](adr/0017-grid-and-bulk-edits.md) |
| D8 | Web app shape | [ADR 0010](adr/0010-web-app.md) |
| D9 | Labels | [ADR 0019](adr/0019-packaging-labels-bundles.md) |
| D10 | Imports and exports | [ADR 0018](adr/0018-imports-and-exports.md) |
| D11 | Rate limits | [ADR 0011](adr/0011-rate-limits-and-client-events.md) |
| D12 | MCP tool budget: 14 tools | [ADR 0005, update](adr/0005-operation-registry.md) |
| D13 | Rich text | [ADR 0012](adr/0012-custom-fields.md) |

**Deviations from the plan, with reasons:**
- The benchmark ran in staging on benchmark shops, which were deleted afterwards, instead of in a separate Neon project. I had no access to create one, and the data fit the free plan. The 1-million-event audit seed was left out (risk R7's fallback).
- TanStack Table was not needed and was removed ([ADR 0017](adr/0017-grid-and-bulk-edits.md)).
- Opening stock in imports writes receipts inside each chunk instead of calling the receipt operation per row ([ADR 0018](adr/0018-imports-and-exports.md)).

## 4. Staging data

| Shop | Purpose |
| --- | --- |
| Bibica, Bibica B | Phase 0 shops: Shopify development stores and the Phase 0 ChatGPT connection |
| ChatGPT run | The F13 run of 15–16 November (Section 5). Four of its connections are still active: three with full access and one read-only. |
| Vladeeno1 | Made on 16 November by the emailed-code account in the Phase 0 sign-in check (E3) |

The "Phase 1 check" shop from the real-browser run of 15 November was deleted on 16 November with `scripts/bench/cleanup.ts` (7,632 rows), and its 9 files in R2 (a picture with its two derivatives, three import files, and three exports) were deleted with Wrangler.

## 5. ChatGPT run (F13)

**Setup:** the shop "ChatGPT run" is prepared on staging:
- **Furniture:** Oak dining table (with two shipping boxes and a primary picture), Walnut bookshelf, and Linen armchair.
- **Food:** Wildflower honey, Crunchy granola, and Oat biscuits, in a bare Food family with no fields.
- **Spare parts:** three parts, each with a preferred supplier ("Bosch Parts Europe") and a supplier SKU.

**Connect ChatGPT to that shop with full access:**
1. In the dashboard, open Integrations → AI assistants and revoke the Phase 0 ChatGPT connection.
2. In ChatGPT, reconnect the Airstock connector, or remove it and add it again: https://airstock.deletecookies.dev/mcp. This also loads the Phase 1 tools.
3. On the consent page, choose "ChatGPT run" and tick every box.

**Prompts and expected results.** Ask in one chat, in this order:

| # | Prompt | Expected |
| --- | --- | --- |
| 1 | Which furniture products are missing shipping-package dimensions? | Walnut bookshelf and Linen armchair. Not the Oak dining table. |
| 2 | Add an Allergens field to the Food family and set it to gluten and nuts for these three products. | A multi-select field with gluten and nuts, added to Food, and set on all three food products. |
| 3 | Create a T-shirt in black and white, sizes S to XL, SKUs TS-color-size, price 19.90. | It shows the 8 variants first (preview), then creates them after you confirm. |
| 4 | Which items have no primary picture? | Every product except the Oak dining table. |
| 5 | Export all spare parts with their supplier SKUs. | The export starts. The download is from the dashboard (Imports page), and the file has `supplier` and `supplier_sku` columns. |
| 6 | First: "Set the price of TS-BLACK-M to 21.90." Then change it to 22.90 yourself in the grid. Then: "Who changed the price of SKU TS-BLACK-M, and was it an AI client?" | Two changes: one by ChatGPT (an AI client, through its connection) and one by you in the dashboard. |
| 7 | Revoke the connection again, reconnect with only the read boxes ticked, then: "Change the price of TS-BLACK-M to 1.00." | Refused for lack of `catalog:write`. The price is unchanged. |

**Record:** for each prompt, note whether ChatGPT picked the right action and whether its answer was right. Wrong action choices in `edit_catalog` are the signal for risk R3. After the run, the lead checks every step in `audit_events`.

### Result

The owner ran the prompts on 15–16 November 2026, from 23:46 to 00:08 UTC. I checked each step in `audit_events` for the "ChatGPT run" shop: 43 events from ChatGPT's connections and the owner's dashboard edit. ChatGPT's written answers were not recorded, so the table judges the calls it made.

| # | What ChatGPT called | Result |
| --- | --- | --- |
| 1 | `search_catalog`: first `is` on `family`, refused with the allowed operators; then `family is_any_of "Furniture"` (a name, not an ID), which matched nothing without an error; then `has_shipping_package = false` across all families, 8 variants | **Partly right.** The right tool and completeness filter, but the family name silently matched nothing, so the answer had to come from the 8 rows of every family. |
| 2 | `manage_catalog_schema`: create the field, add it to Food; `edit_catalog`: bulk preview, then commit on the 3 food products | Right |
| 3 | `edit_catalog`: duplicate check, create, set options, generate variants as a preview (8 combinations, 7 new), then generate after confirmation | Right |
| 4 | `search_catalog`: products with `has_picture = false` (9 of 10), then a search for the Oak dining table | Right |
| 5 | `search_catalog` on the spare-parts family, then `manage_suppliers`: list suppliers and the 3 supplier items | **Wrong tool.** No export was started. ChatGPT answered from supplier records instead of using `import_export`. |
| 6 | `edit_catalog`: price 19.90 → 21.90 at 00:04:46 by the connection; the owner changed it to 22.90 in the dashboard at 00:05:20; then `search_activity` on the variant | Right. The two changes carry actor types `connection` and `user`. |
| 7 | A new read-only connection at 00:06:46; the price change was refused: "This connection was not granted the catalog:write scope." | Right. The price stayed 22.90. |

**Risk R3:** ChatGPT picked the right `edit_catalog` action every time, so the 14-tool shape stays (PRD v0.7, 9.3).

**Findings:**
- **A family name in a filter matched nothing, silently.** The catalog query compares `family` values with family IDs, so "Furniture" returned no rows instead of an error or a match. To fix before Phase 2: accept a family's name as well as its ID, and refuse unknown values with the list of families.
- **The export was not offered.** The export operation's description does not say that the file includes the supplier and `supplier_sku` columns, so a request for supplier SKUs looked like a supplier question. To fix: say so in the description.
- **Earlier connections stay active.** Each reconnect from ChatGPT created a new connection. The three full-access connections from 23:37, 23:45, and 23:52 are still active next to the read-only one. Step 7 asked to revoke first; the dashboard lists them under Integrations → AI assistants. A Phase 2 question: should a new consent from the same person and client for the same shop revoke the earlier one?
