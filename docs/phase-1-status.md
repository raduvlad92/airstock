# Phase 1 status

**Updated:** 15 November 2026  
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
| N8 Measure and exit | Done, except the owner's ChatGPT run | Staging benchmark, staging run in a real browser, measurements, cost model, and report ([Phase 1 report](phase-1-report.md)). |

## 2. Exit criteria evidence

See the [Phase 1 report](phase-1-report.md), Section 1, for the evidence per criterion.

| ID | State |
| --- | --- |
| F1–F12, F14 | Done |
| F13 | Owner: ChatGPT run (Section 5) |

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
| Phase 1 check | The real-browser run of 15 November (report Section 3). It can be deleted with `scripts/bench/cleanup.ts --names 'Phase 1 check%'`. |
| ChatGPT run | Prepared for F13 (Section 5) |

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
