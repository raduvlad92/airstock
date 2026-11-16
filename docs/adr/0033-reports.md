# 0033. Reports: reads over the stock tables, keyset pages with full totals, exports through the export jobs

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan decision D15 (reports half), Section 5.15, goal G13, and PRD 3.5 (milestone I5).

**Summary:** The eight standard reports are read operations over the stock tables in the caller's location scope, with cost columns only for costs.read; rows sort by any column and page by keyset while totals cover every row; value at a date comes from the ledger and the cost history; saved reports are private or shared with reports.manage; CSV exports reuse the export jobs

## Decision

- **Eight reports, one operation.** `reports.run` (`GET /shops/{shopId}/reports/{report}`) takes the report type and one flat set of filters: warehouse, location (with the locations inside it), family, category, supplier, variant, search, and, where they apply, condition, `at`, `from` and `to`, `days`, movement type, and overdue only. A filter a report does not take is left out and named in `ignoredFilters`. Each report has groupings (`groupBy`), such as stock on hand per position, variant, or location. The result lists its columns with a type, the rows, the totals, the row count, and `nextCursor`. The code is in `packages/core/src/reports`.
- **What each report reads:**
  - Stock on hand reads `stock_positions`, the shared rule for reserved and available. The pack breakdown divides on hand by the variant's active packs, largest first.
  - Low stock reuses I3's rule states and suggestion (`reorderRuleStates`, `suggestReorders`), so the report and drafting from low stock agree.
  - Movements read the ledger by entry time (new index `inventory_entries (shop_id, created_at)`). Dispatch and receipt are both "transfer"; in-transit legs are left out, so a transfer counts where it leaves and where it arrives. Any new operation kind appears under its own name, so transfers, returns, and counts from I2 need no change here.
  - Inventory value at a moment takes each position's balance now minus its ledger entries after that moment, times the variant's last cost-history average at or before it (ADR 0022). Both are stored, so the answer does not change later (A39). Without `at`, it reads the balances and `variant_costs`.
  - Cost of goods sums fulfillment entries at their stored unit cost.
  - Purchasing reads open lines of sent orders.
  - Expiring lots reads lots within the window, expired ones included.
  - Shortages reads open shortage reservations, with on order per variant.
  - A date means a day in the shop's time zone: `at` and `to` the end of it, `from` its start.
- **Paging.** Rows sort by any visible column (nulls last, then a stable row key) and page by keyset. The cursor carries the last row's raw sort value and key, and a signature of the report, grouping, sort, and filters, so it cannot be reused for another run. Totals and the row count are computed over every row on each page.
- **Location scope (PRD 2.4, A42).** Every report reads only the caller's locations: positions, entries, and lots there; orders to warehouses or locations in scope; and shortages limited to a location in scope or to none. `partial: true` labels the result, and the dashboard and the CSV say the totals cover only those locations. Unlike `get_stock` valuation (ADR 0022), a member limited to some locations can value their own stock.
- **Costs (PRD 2.3).** Inventory value and cost of goods need costs.read. Elsewhere, cost columns (value, unit cost, open value) are left out without it and cannot be sorted on. Their SQL computes nothing for such callers.
- **Audit.** A run is a read with one access event. Standard runs use `reports.report.run` and saved ones `reports.saved_report.run`, with the report, filters, grouping, sort, rows returned, row count, `partial`, and `costVisible` in the context. Saving and deleting are commands with change events. An export records its creation, its completion (`reports.export.completed`), and each download (`catalog.export.downloaded`).
- **Request budget.** A run sets a 25-second statement timeout. Past it the request fails with `report_too_large`, which points to the export: exports run as a job with a 5-minute statement budget. On the bench, the largest report took 0.8 s at the server (measurements, I5 reports).
- **Saved reports (`saved_reports`, migration 0068).** A saved report is a name, a report type, and its filters, private to its owner or shared with the shop. Anyone with `reports.run` saves their own. Sharing, unsharing, and changing or deleting another member's shared report need the new `reports.manage` (owners and managers). Another member's private report does not exist for the caller. Saving a cost report without costs.read is refused. A run of a saved report may override its filters for that run. Scheduled emails come after January (owner decision): the table will take a schedule column, and the job will apply each recipient's scope and cost permission when it runs.
- **CSV exports.** `reports.export` adds a row to `export_jobs` with `kind = 'report'`, and the job `reports.export.run` writes the file. The job runs as the member who started it, with their scope and cost permission as they are then. It writes every page (5,000 rows each) in one read-only transaction and adds a totals line. The file uses the existing download route, 24-hour link, and 7-day deletion (ADR 0018). Report exports are listed by `reports.exports.list` and left out of the catalog's Recent exports. Downloading needs `exports.run`, and `catalog:read` for an API credential, as before.
- **Permissions.** `reports.run` is given to every role that reads inventory. `reports.manage` goes to owners and managers.
- **MCP.** `run_report` (read-only) has the actions `run`, `run_saved`, and `list_saved`. Saving, deleting, and exporting are documented exceptions: they happen in the dashboard or through the API. The server instructions send "what is my stock worth" and cost of goods to `run_report`. `get_stock` valuation now says it is for one variant.

## Why

- Reading what the stock engine already stores (balances, the ledger with unit costs, the cost history, rule states) keeps reports from disagreeing with stock views, and needs no report tables or snapshots.
- Totals over every row let a page of 100 rows still answer "what is it all worth", and keyset pages stay stable while stock changes.
- Exports reuse a job type that is already logged, signed, and expiring, so reports add no second file path.

## Revisit when

A shop's reports pass the 25-second budget often (move the slow ones to snapshot tables or always run them as jobs), scheduled report emails start (after January), or per-warehouse costing replaces the shop-wide average.
