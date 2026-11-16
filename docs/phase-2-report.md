# Phase 2 report

**Date:** 16 November 2026  
**Plan:** [Phase 2 build plan](phase-2-build-plan.md) · **Progress log:** [Phase 2 status](phase-2-status.md) · **Measurements:** [Phase 2 measurements](phase-2-measurements.md)  
**Staging:** https://airstock.deletecookies.dev

## 1. Summary

Phase 2 and the Shopify connector (PRD Phases 2 and 3) are built, merged, and deployed to staging. A merchant can:
- receive stock by the case, with lots, expiry dates, serials, costs, and one-of-a-kind items;
- reserve, release, and fulfill it, including bundles and Shopify orders with shortages;
- move it between locations and warehouses, take returns through quarantine and inspection, and count and adjust it with reasons and reversals;
- order from suppliers, get one low-stock alert per rule, and value stock at moving average cost;
- look up, receive, count, move, pick, and quick-add on a phone;
- run the eight standard reports and search the full history with the PRD 7.4 filters;
- send signed webhooks to their own tools;
- connect a Shopify store: onboarding import, mapping, the order flow, the reconciler, sync health, and listings in both directions.

Everything is reachable from the dashboard, REST, and MCP: **201 operations in 22 MCP tools** (`pnpm parity`), against 99 and 14 at the end of Phase 1. The test suite has 95 Vitest files (core, Worker, and web) against PostgreSQL 17, and 26 Playwright tests in Chromium. All of them run in CI on every PR.

Two independent reviews, of the inventory engine and of the Shopify connector, confirmed 35 defects before any merchant used the product. Each got a failing test first, then a fix. No expected-failure test is left on `main` (Section 5).

**Exit criteria (Section 2):**
- **Done (10):** G1, G2, G3, G4, G7, G8, G9, G10, G12, G13.
- **Partly (4):**
  - G5: no quantity can be typed into the grid as a count;
  - G6: the lot trace has no export;
  - G17: purchasing and picking commands have no fault-injection tests;
  - G18: two load cases were over target and both are fixed (PRs #89, #92), except 10 simultaneous readers of the inventory list on the 20,000-variant shop, which is limited by the database size; Shopify latencies and Neon compute were not measured.
- **Waiting for the owner's run (4):** G11 iPhone, G14 n8n, G15 Shopify development stores and the rehearsal, G16 ChatGPT.

**Left before the pilot:**
1. **The owner's checks**, all listed in the [status doc, Section 2](phase-2-status.md#2-owner-steps):
   - the iPhone run ([Section 2.1](phase-2-status.md#21-iphone-check-i4));
   - an n8n webhook URL and a subscription;
   - reconnecting both Shopify development stores, then the rehearsal with the owner's product export;
   - the ChatGPT run of the Phase 2 prompts;
   - the production decision ([Section 2.2](phase-2-status.md#22-production-decision-i7)).
2. **The build's own gaps:** the G5, G6, and G17 items above, and a real-browser run of every flow on staging (Section 8).
3. **I8 go-live:** production as decided, a restore test (A22), then onboarding the owner's store.

### 1.1 What was built

| Milestone | PRs | Summary |
| --- | --- | --- |
| I0 Groundwork | #46, #48, #50 | Bench seeds for six persona shops and a 1-million-event history. Re-consent revokes earlier connections (D20), and originals shrink to 2,048 px (D19). The ChatGPT harness. The seed found a catalog cursor crash on names outside Latin-1, fixed in #50. |
| I1 Stock engine | #45, #49, #51, #55 | Conditions, in transit, lots, serials, one-of-a-kind items, pack-aware receipts with costs, reservations with partial release and fulfillment, allocation rules with earliest expiry first, reallocation, bundles, shortages, moving average, and the scheduled stock check with a reviewed repair (ADRs 0020, 0021, 0022, 0024). |
| I2 Transfers, returns, counts | #57, #63, #64 | Transfers with holds, transit, exceptions, and one-command moves; returns with quarantine and inspection; count sessions, quick counts, adjustments, condition changes, and reversals (ADRs 0028, 0029, 0031). |
| I3 Purchasing and alerts | #59, #62 | Purchase orders with PDF, email, receipts against lines, and on order; reorder rules, drafts from low stock, and alerts in the app, by email, webhooks, and MCP (ADRs 0027, 0030). |
| I4 Scanning and picking | #54, #58, #60, #69 | The scanner at `/app/scan` and the installed app; look up, receive, and unknown codes; pick lists on the phone and as PDF; count, move, receive against a PO, and quick add with pictures (ADRs 0025, 0026). |
| I5 Webhooks, activity, reports | #47, #52, #71 | Signed webhooks with subscriptions, retries, a log, and replay; activity views with the PRD 7.4 filters on a shop-first audit key; the eight reports, saved reports, CSV export, and `run_report` (ADRs 0023, 0032, 0034). |
| I6 Shopify connector | #67, #70, #74, #76, #79 | Mapping and onboarding; the order lifecycle; batched compare-and-set push and the reconciler; sync health and `shopify_sync`; listings in both directions with per-field ownership (ADRs 0033, 0035–0038). |
| I7 MVP gate | #73, #77, #78, #82, #90, #91 | The two reviews and their fixes (Section 5). |
| | #80, #86, #89, #92 | The volume run and its fixes: idempotency retention, the staging connection limit, the inventory list, and the reservation contention. |
| | #83, #87 | The CI deploy fix and the test-stability work (Section 6). |
| Across milestones | #66 | MCP server instructions that route by task (D16). |

## 2. Exit criteria

**States:** Done (a passing test, a recorded run, or a figure in this report), Partly, Not done, or Waiting for the owner's run. Test files are in `packages/core/test` unless the path says otherwise.

| ID | Criterion | State | Evidence |
| --- | --- | --- | --- |
| G1 | Stock per location, condition, lot, and serial; history and balances reconcile; a mismatch raises an alert with a reviewed repair; one SKU in a store, a rented warehouse, and a fulfillment partner | Done | A03: "keeps one catalog identity with per-location totals (A03)" in `inventory.test.ts`. A21: "keeps every invariant after each step" in `stock-property.test.ts` (lots, serials, packs, bundles, shortages, expiry, reallocation) and `documents-property.test.ts` (transfers, returns, quick counts, adjustments, condition changes). Stock check: "opens one alert for a corrupted balance, keeps it on repeat runs, and edits nothing" and "repairs through a reviewed preview and commit, and the next check resolves the alert" in `reconciliation.test.ts`, also through REST and MCP (`apps/worker/test/stock-check.test.ts`) and in Chromium (`apps/web/e2e/stock-check.spec.ts`). Since PR #78 the check also runs the transfer and return checks (review finding 19). |
| G2 | Reservations: exactly the available units, one effect per replay, expiry against fulfillment, partial release and fulfillment, allocation rule with earliest expiry first | Done | A04: "lets exactly nine of thirty callers reserve nine units spread over three lots" and "gives each serial to one caller only" in `stock-concurrency.test.ts`. A08: "gives one valid outcome per reservation: shipped or expired, never both". A05: 50 replays of receipts, reservations, and fulfillments in `idempotency.test.ts` and `stock-failures.test.ts`. A37 allocation half: "allocates the earliest expiry first, stops selling an expired lot at once, and traces every order" in `stock-engine.test.ts`. |
| G3 | Transfers exact through dispatch, transit, partial receipt, cancellation, and exceptions; a transfer hold counts against every other caller | Done | A06: "dispatches ten and receives six: six at the destination, four in transit, none left at the source". A25: "leaves six unheld at the source, one in transit, three received, and refuses to exceed the line" (`transfers.test.ts`). A24: "lets a ready and reservations share the last units exactly, never more" (`transfer-concurrency.test.ts`). Chromium: `apps/web/e2e/transfers.spec.ts`. |
| G4 | Returns go to quarantine, inspection splits them, no automatic refund; a returned serial must match one fulfilled from the shop | Done | A07: "quarantines all six, releases four to sellable and keeps two damaged, with no refund". A38 return half: "takes back a fulfilled serial, flags one never fulfilled here, and refuses one in stock" (`returns.test.ts`). An unmatched serial is flagged for review, as plan Section 5.5 says. Chromium: `apps/web/e2e/returns.spec.ts`. |
| G5 | Counts: a movement during a count needs review; below reserved needs a shortage resolution; a grid quantity becomes a count; adjustments have reasons and reversals | Partly | In `counts.test.ts`: "runs a blind count over a location, and needs review when a position moved after counting"; "refuses to drop below reserved, then releases or reallocates exactly as chosen"; "adjusts with a reason, needs a note for "other", and costs units out at the average" (with a reversal). Chromium: `apps/web/e2e/counts.spec.ts`. **Missing:** the quick count is on the Inventory page, the scanner, and MCP, but the catalog grid has no stock column to type into, and no test covers a grid count. |
| G6 | Lots and expiry: expired units stop selling at expiry even if the job is late; a lot trace lists supplier, PO, receipts, and every order, transfer, return, and disposal, and exports. Serials: each unit's history; unknown or duplicate serials rejected or flagged | Partly | A37: the test above, and "keeps expired reservations from holding stock even when the sweeper is late (A37, A08)". A38: "receives one position per serial, rejects duplicates, and records each step" (`stock-engine.test.ts`) and "moves one serial through transit and its history shows each step" (`transfers.test.ts`). Supplier and PO links in the trace: `purchasing.test.ts`. **Missing:** the lot trace (`inventory.lots.trace`) has no export, and the movements report has no lot filter. |
| G7 | Bundles reserve and fulfill whole or fail whole; a connector order records a shortage per component | Done | A36: "reserves only whole sets, all components at once, and fulfills them together" (`stock-engine.test.ts`); "reserves whole gift sets atomically: two of twenty callers win with 5 soaps at 2 per set" (`stock-concurrency.test.ts`); "A36 (Shopify): 3 gift sets ordered with 5 soaps, 2 per set: a shortage per component" (`apps/worker/test/shopify-orders.test.ts`). |
| G8 | Receipts, counts, transfers, and adjustments accept packs; history shows the pack, its factor, and the base quantity | Done | A28 receipt half: "stores 3 cases of 24 as 72 base units with the pack, its factor, and what was entered" (`stock-engine.test.ts`). "counts in packs, by lot, and by serial" (`counts.test.ts`). "keeps lots through transit, and records packs on the line and the entries" (`transfers.test.ts`). Adjustments in packs in `documents-property.test.ts`. |
| G9 | POs drafted per supplier from low stock, sent as PDF, received in part, closed; on order until closing; one alert per rule in the app, by email, webhook, and MCP, cleared when stock recovers | Done | A34: "opens one alert as orders drain stock, emails once, and clears when stock recovers", which also checks the one `alert.opened` outbox event (`alerts.test.ts`); MCP in `apps/worker/test/alerts.test.ts`. A35: "drafts one order per supplier, receives half a line, and closes it" (`alerts.test.ts`); "drafts, sends, receives, and downloads the PDF" (`apps/worker/test/purchasing.test.ts`). Chromium: `alerts.spec.ts`, `purchasing.spec.ts`. |
| G10 | Moving average: €4 and €6, 5 fulfilled: average €5, value €75, cost of goods €25, the same when re-run; costs hidden without `costs.read` | Done | A39: "gives €5 average, €75 value, and €25 cost of goods, the same when asked again later" and "hides costs without costs.read and refuses to take one" (`stock-engine.test.ts`); "values 15 units at €75 and costs 5 fulfilled at €25, the same when asked again after later receipts" (`reports.test.ts`). The plan's valuation property test (Section 7.1) was not written. |
| G11 | Scanning on the owner's iPhone, in Safari and installed: look up, receive (also against a PO), count, move, pick, lots and serials, quick add; unknown codes; location labels | Waiting for the owner's run | In Chromium (`scan.spec.ts`, `scan-flows.spec.ts`, `picking.spec.ts`): look up from a keyboard-wedge scanner, count, move, receive against a PO, quick add of a graded card, and pick. Component tests cover receiving cases, serial capture, and unknown codes. **No test captures a lot while scanning.** On the iPhone, only Chrome in a tab has run (Phase 0, E8). The script is in [status, Section 2.1](phase-2-status.md#21-iphone-check-i4). |
| G12 | Pick lists by location path; a short pick starts a count and reallocation; stock changes only at fulfillment | Done | A41: "builds one list for 20 orders, walked in location-path order", "flags a short pick and names the position to count", and "records picks without changing stock" (`picking.test.ts`). Chromium: "a pick list for 20 orders is printed, picked by scanning, and fulfilled at the end" (`picking.spec.ts`, without a short pick). |
| G13 | Eight reports with filters, saved reports, and CSV; activity views with the PRD 7.4 filters, per-record history, and the ingestion delay; location scope on every new read and command | Done | `reports.test.ts` runs all eight kinds, saved reports, and the export job. `activity.test.ts`: the "filters by…" tests, "follows a request from attempt to outcome", "says the history is behind while a command's queued attempt has not arrived", and the CSV export. A42 in the core tests of every new module. Gaps: Chromium runs two of the eight reports, and only `run_report` is tested for scope through a real MCP client (`apps/worker/test/reports.test.ts`). |
| G14 | Signed webhooks reach the owner's n8n after commit only, with retries, a log, deduplication by event ID, and replay | Waiting for the owner's run | `webhooks.test.ts`: "sends each subscription only its chosen types and filters, signed", "sends nothing for a rolled-back transaction (A11)", "retries after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, and 24 h, with the same event ID, then fails", and "replays with the same event ID as a new delivery (A19)". On staging, 40 of 40 deliveries reached a stand-in receiver on the first attempt (Section 3). |
| G15 | Shopify: onboarding from a store (the owner's export, rehearsed on a development store), mapping with packs and bundles, the full order flow, shortages, the reconciler, listings both ways with field ownership, sync health in the dashboard and MCP | Waiting for the owner's run | Against the fake store in `apps/worker/test/shopify-*.test.ts`: onboarding "reads with a bulk operation, previews matches, commits, maps, receives, and references pictures"; A28 "3 cases of 24, then Shopify sells 5 singles and a 6-pack: 61 left, the 6-pack shows 10"; A29, A30, A36, A41; edits, cancellations, fulfillments and their cancellation, refunds into returns, Shopify returns; the four listing cases; sync health. Review findings F1–F12 and L1–L2 are fixed (PRs #90, #91). **Not yet run on the development stores with the new scopes, and no rehearsal.** Sync health is not tested through an MCP client. |
| G16 | Parity holds; ChatGPT picks the right tool and action for the Phase 2 prompts, inside its grant | Waiting for the owner's run | `pnpm parity`: 201 operations, 22 MCP tools. A23 in `registry.test.ts`; the tool list in `apps/worker/test/mcp-tools.test.ts`. The 14 prompts are in `docs/chatgpt-runs/phase-2.json`; no run is recorded. |
| G17 | The failure contract holds for every new command: a rollback leaves no stock effect; a lost acknowledgement leaves a durable attempt and no duplicate | Partly | A11, A12, A26, and 50 replays (A05) for every case in `stock-failures.test.ts` (6 commands), `transfer-failures.test.ts` (7), `return-failures.test.ts` (4), and `count-failures.test.ts` (7), plus the pipeline in `failures.test.ts`. **Missing:** no such suite for purchasing (including the PO receipt replay A05 names), picking, alerts, or the stock-check repair. They run through the same pipeline, but no test proves it for them. |
| G18 | The volume run on the persona shops meets its targets; the cost per shop is updated | Partly | Section 3 and Section 4. Stock commands, availability, activity search, reports, and webhooks met their targets. The inventory list is within target for one reader, but not for 10 readers on the 20,000-variant shop. Ten reservations of one variant were over target; the per-variant lock (PR #92) brought the bench server p95 from 1,045 to 427 ms. Shopify latencies and Neon compute with the new crons were not measured. |

## 3. Measurements

All from the [measurements doc](phase-2-measurements.md): the `airstock-bench` Neon project (Frankfurt, 0.25–2 CU, a laptop client in Europe at about 15 ms per round trip), and staging for the Worker timings. **Seed:** six persona shops with 31,569 variants, 5,170 lots, 13,647 serials, 1,027 one-of-a-kind items, and three months of stock activity (120,750 operations). The 1-million-event history is on a separate branch (plan risk R3). The plan's 300 operations a day per shop ran at about 220.

| Measurement (plan Section 8) | Target | Result | Status |
| --- | --- | --- | --- |
| Stock commands with 10 concurrent callers | p95 under 500 ms | Bench, 10 callers: 13–31 statements, 2–8 ms of database time, 81–193 ms estimated in the Worker. Staging, one caller at a time: server p95 235 ms (receive) to 335 ms (count submit). | Met. Staging was not run with 10 callers after its out-of-memory restart (Section 6). |
| Reservation with earliest expiry, 200 lots | p95 under 500 ms | One caller: staging p95 349 ms. Ten callers on that variant: staging p95 851 ms (1 unit) and 1,062 ms (12 units). PR #92: bench server p95 1,045 → 427 ms; locally with 6 ms per statement, p95 328–337 ms. | Met on the bench after #92 (merged); the 10-caller staging run is to be repeated. |
| Availability for one variant | p95 under 200 ms | Staging p95 164 ms, of which 87 ms is the audit-queue send. Bench estimate 37–49 ms. | Met |
| Inventory list, 50 rows, lot and condition columns | p95 under 1 s | After PR #89, one caller: 10–177 ms of database time; the 20,000-variant shop's server p95 is 196 ms (was 1.4 s). Ten callers: under 0.3 s in five shops; 1.9 s p95 in the 20,000-variant shop while the compute scales up, and 1.04 s server p95 held at 2 CU. | Met for one caller; over for 10 callers on the largest shop |
| Activity search, 1 million events, two filters | p95 under 1 s | Warm server p95 9.3 ms. Cold (compute just woken) server p95 534 ms, client p95 685 ms. 2 of 90 cold searches took over 1 s (1.3 s and 5.3 s). | Met |
| Reports on 31,000 variants | Under 5 s (stock on hand), under 10 s (value at a past date) | Largest shop: stock on hand 1.56 s, value 7 days ago 0.10–0.12 s at the server. Every other shop under 0.35 s. Export of 18,460 rows: 7.7 s. | Met |
| Webhook delivery, commit to receipt | p95 under 10 s | Staging, 40 deliveries to a receiver behind a tunnel (standing in for n8n): p95 366 ms from the event, 215 ms from the response; all on the first attempt. | Met |
| Shopify: order to reservation, fulfillment to stock, change to push | p95 under 30 s each | Not measured in Phase 2. Jobs run right after the webhook response (PR #13), and pushes go out right after the command (PR #14). | Not measured |
| SQL statements per command; bytes per entry, lot, and serial | Feeds the cost model | 13–31 statements per command (Section 4). Ledger entry 326 B, lot 634 B, serial 498 B, position 360 B, reservation 323 B, count line 577 B. | Measured |
| Queue operations per command, including webhooks and Shopify | Feeds the cost model | Not counted in a run. From the design: 3 per command (ADR 0004); 0 for a webhook delivered on the first attempt and 3 per retry (ADR 0023); a Shopify webhook 6, plus 3 per command its job runs (Phase 0). | Estimated |
| Neon compute with the new crons and retries | Neon still scales to zero between bursts | The crons are unchanged (every 30 minutes and daily at 03:00), and the reconciler and stock check run inside them. The I7 run used 221 compute seconds on its branch. Compute hours with the crons were not measured. | Not measured |
| Cost per shop per month | Against $0.49 | About $0.34–0.42 (Section 4) | Within budget |

**Other findings from the measurements:**
- **The audit-queue send is awaited on every request.** On staging it takes 80–106 ms at p95, about a third of a command's server time and half of a read's. It is the largest cost after the statements.
- **The I0 baseline found two product bugs:** grid queries failed on names outside Latin-1 (fixed in #50), and the global audit primary key made rare filters read every shop's events (fixed by the shop-first key in #52).
- **Storage:** an audit event is 633 bytes after I5's indexes, down from 699, with six more indexes.

## 4. Cost model update

Phase 0's model (its report, Section 6) assumed 30,000 reads, 6,000 stock commands, and 900 Shopify orders of 2 lines per shop per month. Phase 1 added the catalog and media (its report, Section 5). Phase 2 adds what stays in the database after each stock command, webhooks, and the rest of the Shopify order flow. Rates are as in Phase 0: Neon $0.35 per GB-month, Queues $0.40 per million operations.

**Assumed activity per shop per month:**

| Activity | Assumption | Queue operations | Stored in PostgreSQL |
| --- | --- | --- | --- |
| Stock operations | 6,600, the I7 pace of 220 a day. Their requests and audit events are already in Phase 0's 6,000 commands | Already counted | 1.43 KB each, kept for good: 9.4 MB a month. The bench's stock tables grew 172 MB for 120,750 operations, including lots, serials, count lines, and new positions |
| Idempotency records | One per command, 1.6 KB, kept 7 days (PR #86) | | About 2.5 MB at any time |
| Webhooks | One subscription that receives `stock.changed` for every operation: 6,600 deliveries | 0 when the first attempt succeeds (40 of 40 on staging); 3 per retry. With 5% retried once: about 1,000 | One audit event per delivery outcome: 4.5 MB a month, 13.5 MB in the 3-month hot window. Delivery rows are deleted after 30 days; their size was not measured |
| Shopify fulfillments | Each of the 900 orders is also fulfilled through `fulfillments/create`: the webhook (3), its delayed safety copy (3), and two fulfill commands (6) | 10,800 | |
| Crons | The 30-minute reconciler and the daily stock check, inside the existing crons | Jobs run inside the cron | |

**Effect on cost, at 1,000 shops:**

| Item | Added per shop per month |
| --- | --- |
| Neon storage: stock history, idempotency records, and webhook audit events. 16 MB in the first month; 129 MB after 12 months, because stock history is never archived | $0.006 in the first month, rising by about $0.0033 a month to **$0.045 after a year** |
| Queues: about 11,800 operations | about $0.005 |
| Workers CPU and requests: fulfillment jobs and deliveries (estimated at Phase 0's 24 ms per command and 5 ms per delivery) | about $0.002 |
| **Phase 2 total** | **about $0.013 in the first month, about $0.05 after a year** |

Added to the Phase 0 and Phase 1 figure of $0.33–0.37, this gives **about $0.34–0.42 per shop per month, inside the $0.49 budget (PRD 14.4)**. The headroom is about 1.2× at the top of that range.

**What could still break it:**
- **Stock history grows with use and is never archived.** At this pace a shop adds 113 MB a year, $0.04 a month more each year. After three years that is $0.12 a shop, and the budget no longer fits. The ledger needs a plan before then: compacting old entries into balances, or moving old months to R2 like the audit history.
- **Neon compute is still the largest unmeasured item.** Phase 0's $0.077–0.116 per shop at 1,000 shops stays the estimate. The 10-caller inventory list on a 20,000-variant shop needs 2 CU for about a second, so large shops raise the compute floor.
- **Media:** Phase 1's $0.072 assumed 3 MB originals. Originals now shrink to 2,048 px (D19), but their new size was not measured, so that figure stays as an upper bound.

**The pilot's real monthly cost** comes from the [production brief](phase-2-status.md#22-production-decision-i7): about **$10–15 a month on top of Workers Paid ($5)** while the owner is the only merchant, so $15–20 in all; $20 more with Resend Pro. Most of it is Neon Launch, about $10. The 30-minute cron alone wakes the database 48 times a day. With Neon's suspend after 5 idle minutes, that keeps the compute up at least 4 hours a day: about 60 CU-hours a month at the 0.5 CU minimum, about $6 at Phase 0's $0.106 per CU-hour. That is an estimate; the pilot should measure it (PRD 16.2).

## 5. Reviews

Before the January merchant, each part got an independent review with one rule: **the reviewer writes failing tests, no fixes.** Each confirmed defect is a test named after the finding and marked `it.fails`, so CI stays green while it waits. Each test was also run as a plain `it` to check that it fails on the defect's assertion, not its setup. The fix turns it into a plain `it`. Suspected issues that a test could not show were listed separately, and a fixer had to prove one with a test before fixing it.

| Review | Confirmed | Fixed in | Suspected, then proven and fixed |
| --- | --- | --- | --- |
| Inventory engine (#73) | 21: 8 high, 3 medium-high, 7 medium, 1 medium-low, 2 low | #77 (picking, purchasing, scope), #78 (serials, one of a kind, costs, returns, reallocation, sweep, stock check) | 13 of 14, including three deadlocks |
| Shopify connector (#82) | 14: F1–F12 and L1–L2 (listings) | #90 (order sync, onboarding, reconciler), #91 (push, uninstall, listings) | 5 of 6; the sixth (description normalization) was mostly safe and was hardened |

**The most important classes of defect:**
- **Stock created or lost by rare sequences.** A serial could end up on hand in two places (remove, find, reverse). A pick list shipped bundle components nobody picked. Reversing a stock-check repair changed a real balance. A PO receipt converted cases at the pack's new size, not the size ordered.
- **Location scope bypassed by new paths (6 findings).** Counts started from positions, PO receipts, allocation rules, the lot trace and serial history, engine events, and cost totals each skipped the scope check that their main path had.
- **Rules enforced in one command but not in another.** The one-of-a-kind limit held for receipts but not counts. Uninspected return units could be made sellable by a condition change.
- **Lock order.** The shortage sweep broke ADR 0006's lock order, and three more deadlocks turned up among the suspected items.
- **Shopify events arriving out of order or late (F1, F5, F10).** For example, an order first seen with its fulfillment never left stock, and a late `orders/create` held units again after an edit.
- **Oversell from guesses (F4, F8).** An order placed while the onboarding preview waited, or committed at an unmapped location, sold stock twice.
- **One bad item stopping everything (F2, F11, F12).** An archived variant failed its whole order and halted the reconciler's cursor. One refused level stopped every push in its batch.
- **Retries of external writes (F7, L2).** A lost response froze a level as a conflict, and pictures were uploaded twice.

**What the reviews showed about the process.** All 35 defects passed the milestones' own tests. Those tests checked what each builder thought of. The reviews found the interactions between features: picking with bundles, counts with one-of-a-kind items, new reads with location scope, and Shopify events in an unexpected order. Writing the failing test first meant the defects were agreed before anyone changed code, two fixers could work in parallel, and a fix was proven by its test turning green.

## 6. What went wrong

- **The account's usage limit stopped every agent twice on 16 November** (status, Section 1):
  - At about 03:20 UTC, all running agents stopped at the 5-hour limit. Only pushed work survived: the stock engine's third part, the webhooks, and most of the activity views. Unpushed work in progress was lost and redone. The three milestones that had just started lost nothing, because they had not written code yet.
  - From 09:10 to 12:10 UTC the limit stopped them again. The Shopify order-flow work was saved from its checkout.
  - Since then each agent pushes within its first 30 minutes, and at most three run at once, so fewer are cut off mid-task.
- **A merged fix did not reach staging** (PR #83). CI cancels a superseded `main` run, and a documentation-only push skipped the deploy. When docs-only #81 cancelled the run of #78, the inventory review fixes never deployed. Now every push to `main` builds, tests, and deploys, and only pull requests skip the heavy steps for documentation.
- **Flaky tests** (PR #87). Two suites running at once failed in 11 of 12 runs; after the fixes, 24 of 24 passed. The root causes:
  - **Two real app races**, which a phone would hit:
    - TanStack's `useMutation` applied new options a task after the screen showed them, so a tap in between could receive 6 units while the button said 12. Fixed with a wrapper (`apps/web/src/mutation.ts`), which Biome now enforces.
    - The scan page applied lookup results concurrently, so two quick scans of a case counted as one. Results now apply one at a time, in scan order.
  - **Shared test infrastructure:**
    - one PostgreSQL server (100 connections) serves every worktree, and test pools ran it out of connections;
    - a lock-wait helper matched other databases' lock waits;
    - an audit query picked the attempt event instead of the outcome;
    - sweeps in tests ran over every shop (also fixed in #56 and #65).
- **ADR numbers still moved.** Phase 1's lesson was to number ADRs at merge. With five or six PRs open at once, that meant renumbering on rebase: at least 12 commits in Phase 2 did only that (transfers went from 0026 to 0028, alerts from 0029 to 0030), each regenerating the index and the OpenAPI files. **Migrations did not collide**, because each milestone had its own range from the start: I1 0017–0029, I2 0030, I3 0040, I4 0050, I5 0060, I6 0070, and I7 0080. Sorted order is also dependency order.
- **Staging's database ran out of memory under load.** In the volume run, 10 concurrent callers on staging's 0.25 CU compute, with 60 idle Hyperdrive connections, failed new connections with "Cannot allocate memory" for about two minutes. One reservation answered 500, and the compute restarted. Hyperdrive's limit is now 20 (PR #86, `docs/staging.md`), and the production brief recommends at least 0.5 CU. The 10-caller staging phases have not been run again.
- **The volume seed was smaller than planned.** The full seed and the 1-million-event history did not fit in the free bench project together, so they ran on separate branches (plan risk R3). The spare-parts shop ran at 220 operations a day instead of 280. Bundle reservations, pick lists, and Shopify mappings were not seeded.
- **Idempotency records were never deleted**: about 1.6 KB per command, as much as all other stock tables in three months. Found by the volume run and fixed in #86.

## 7. Proposed PRD changes

The PRD is not edited here. The owner applies these, as with P16–P23 after Phase 1.

| ID | Change | Section |
| --- | --- | --- |
| P24 | **One-of-a-kind items, both ways.** A variant can be one of a kind: at most one unit owned across the shop, enforced in receipts, counts, adjustments, and reversals. It becomes sold after fulfillment and comes back on return, and its certificate number is its barcode. Units that share a price are a serialized variant instead. The merchant chooses per item (ADR 0024). | 4.1, 6.7 |
| P25 | **Listings in both directions with field ownership.** Products created in Shopify are picked up by webhook and matched by SKU or barcode; products created in Airstock can be listed to Shopify. Title, description, price, pictures, options, and status each have an owner per shop: Airstock for items created here, Shopify for imported ones. A change from the other side shows in sync health with "take Shopify's" or "push Airstock's" and is never applied silently (ADR 0038). | 8.5 |
| P26 | **Webhooks are configured per subscription.** A registry of event types, each with a description and sample. Each subscription chooses its types and filters. Deliveries are signed, retried for 24 hours, logged for 30 days, and replayable. Subscriptions are managed in the dashboard and API only, never over MCP (ADR 0023). | 8.4 |
| P27 | **MCP: 22 task-shaped tools and server instructions.** The instructions route tasks to tools, with the first 512 characters self-contained. ChatGPT documents no tool limit, so the gate is measured tool choice per milestone, not a count. `pnpm parity` keeps 25 tools as the launch ceiling. Update the "Tool count after Phase 1" paragraph. | 9.3 |
| P28 | **Idempotency keys are kept 7 days.** Within 7 days a retry replays the original result. After that the key is forgotten: the request runs as new, and the outcome lookup answers `not_found` (ADR 0006 update). | 7.3, 8.3 |
| P29 | **Production compute starts at 0.5 CU,** with a Hyperdrive origin connection limit sized to it (20 at 0.25 CU). Ten people opening the largest inventory list at once need 2 CU for about a second. | 14.2, 12.3 |
| P30 | **The audit key is shop-first, with no default partition.** `audit_events` is unique on `(shop_id, occurred_at, event_id)`, which replaces the global primary key, so no search can read another shop's events. Monthly partitions only, so the newest month is read first. Filter indexes start with `shop_id` (ADRs 0004, 0032). | 7.3, 7.4 |
| P31 | **Record the measured targets.** Activity search over 1 million events: 534 ms cold p95 with two filters. Reports on 20,000 variants: 1.56 s. Inventory list: 196 ms for one reader. Stock commands on staging: p95 235–335 ms. | 12.3 |
| P32 | **Shopify orders are held where Shopify committed them.** PRD 8.5 says the allocation rule chooses. Shopify has already lowered the committing location's availability, so holding the units elsewhere showed them as sellable there. Reservations now move into the committing location's scope as far as its stock allows (PR #90). | 6.3, 8.5 |
| P33 | **Uninstalling keeps the holds.** Holds stay while a store is uninstalled. A reinstall in the same shop adopts the previous connection's orders, maps, and cursor. `shop/redact`, 48 hours after uninstall, releases them (ADR 0035). | 8.5 |
| P34 | **The pilot store runs its own custom-distribution app.** For a custom app, protected customer data is available without Shopify's review. The public app still needs the review (status, Section 5.2). | 8.5, 17 |
| P35 | **Stock history stays in PostgreSQL and is part of the cost model:** about 1.4 KB per stock operation, 113 MB a year at 220 operations a day. Decide before public launch how old ledger entries are compacted or archived. | 7.4, 14.4 |
| P36 | **An independent review with failing tests is part of each MVP gate.** Both Phase 2 reviews found defects that every milestone test had passed. | 16 |

## 8. Not done, and handoff to I8 and I9

**Waiting for the owner** ([status, Section 2](phase-2-status.md#2-owner-steps)):
- the iPhone run (G11);
- an n8n URL and a subscription (G14);
- reconnecting both Shopify development stores, the optional test order, and the rehearsal with the product export (G15);
- the ChatGPT run (G16), which another agent is preparing;
- the production decision.

**Build work before the pilot:**
- **Run the 10-caller staging phases again** with the per-variant reservation lock (PR #92, merged) and the new Hyperdrive limit.
- **G5:** a stock quantity typed in the catalog grid, as a one-line count, with its test.
- **G6:** an export of the lot trace (or a lot filter on the movements report, which already exports).
- **G17:** fault-injection and replay suites for purchasing (including the PO receipt replay), picking, alerts, and the stock-check repair.
- **Test gaps:** lot capture while scanning; a short pick in Chromium; sync health and the other untested tools through a real MCP client (8 of 22 tools are never called through one in the Worker tests); the plan's valuation property test; the six reports not run in Chromium.
- **A real-browser run of every flow on staging** (plan Section 6.8), with its events checked in `audit_events`. It is not recorded yet.
- **Out-of-date comments:** three review test files still say their tests are marked `it.fails`.

**Over target, left open:**
- **Ten concurrent readers of the inventory list on the largest shop** (34,000 positions): 1.9 s p95 while the compute scales, 1.04 s at 2 CU. The owner's store is far smaller; revisit if a shop that size joins.
- **The audit-queue send** costs 80–106 ms on every request. Sending the attempt event without waiting, or batching it, would cut a third of each command's time; it needs a change to the durability contract (PRD 7.3) first.
- **Shopify latencies and Neon compute hours** were not measured. Measure both in the I8 rehearsal on production.

**I8, pilot go-live** (plan Section 6.9): production as the owner decides, a restore test (A22) before real data, the owner's store installed on its own custom app, onboarding, mapping, and the first real orders watched.

**I9, after January:**
- **R2 archive of history (A18).** It must ship before the pilot's first monthly partition is 90 days old: **early April 2027**.
- **Scheduled report emails (A40).** Saved reports and CSV exports are already in place.
- **Batched access events for API and MCP clients**, before public launch (PRD 7.3; Phase 0 report, Section 6.3).
- **The 3PL decision:** Shopify fulfillment orders assigned to a third-party fulfillment service (`fulfillment_orders` scopes) are not handled. The pilot uses one warehouse of its own; decide before a merchant with a third-party warehouse connects. Creating Shopify fulfillments from Airstock stays in Phase 4.
- **The stock ledger's long-term storage** (P35).
- **Delete the bench project** after Phase 2, as planned (status, Section 4).

**Ready for I8:**
- The production brief, with a cost per item ([status, Section 2.2](phase-2-status.md#22-production-decision-i7)).
- The staging Shopify app configuration as a template (`config/shopify/shopify.app.staging.toml`).
- The volume scripts (`scripts/bench/`), to run again on production before real data.
