# Phase 2 report

**Date:** 16 November 2026  
**Plan:** [Phase 2 build plan](phase-2-build-plan.md) · **Progress log:** [Phase 2 status](phase-2-status.md) · **Measurements:** [Phase 2 measurements](phase-2-measurements.md)  
**Staging:** https://airstock.deletecookies.dev

> Draft. Evidence is being checked row by row; this version is pushed early so it survives a usage-limit stop.

## 1. Summary

Phase 2 and the Shopify connector (PRD Phases 2 and 3) are built, merged, and deployed to staging. A merchant can:
- receive stock by the case, with lots, expiry dates, serials, costs, and one-of-a-kind items;
- reserve, release, and fulfill it, including bundles and Shopify shortages;
- move it between locations and warehouses, take returns through quarantine and inspection, and count and adjust it with reasons and reversals;
- order from suppliers, get one low-stock alert per rule, and value stock at moving average cost;
- scan, receive, count, move, pick, and quick-add on a phone;
- run the eight standard reports and search the full history with the PRD 7.4 filters;
- send signed webhooks to their own tools;
- connect a Shopify store: onboarding import, mapping, the order flow, the reconciler, sync health, and listings in both directions.

Everything is reachable from the dashboard, REST, and MCP: **201 operations in 22 MCP tools** (`pnpm parity`), against 99 and 14 at the end of Phase 1.

Two independent reviews (inventory, then Shopify) found 35 confirmed defects. Each got a failing test first, then a fix. No expected-failure test is left on `main`.

**Exit criteria:** 13 of 18 are done with evidence. Four need an owner run that has not happened yet (G11 iPhone, G14 n8n, G15 rehearsal, G16 ChatGPT). G18 is partly done: the volume run met its targets except two over-target cases, one fixed (PR #89) and one with a fix in review (PR #92).

**Left before the pilot:**
1. The owner's iPhone run ([status, Section 2.1](phase-2-status.md#21-iphone-check-i4)).
2. An n8n webhook URL and a subscription.
3. Reconnecting both Shopify development stores, then the rehearsal with the owner's product export.
4. The ChatGPT run of the Phase 2 prompts.
5. The production decision ([status, Section 2.2](phase-2-status.md#22-production-decision-i7)).
6. Then I8: production setup, a restore test, and go-live on the owner's store.

### 1.1 What was built

| Milestone | PRs | Summary |
| --- | --- | --- |
| I0 Groundwork | #46, #48, #50 | Bench seeds for six persona shops and a 1-million-event history; re-consent revokes earlier connections (D20); originals shrink to 2,048 px (D19); the ChatGPT harness; a catalog cursor crash on non-Latin-1 names found by the seed and fixed. |
| I1 Stock engine | #45, #49, #51, #55 | Conditions, in transit, lots, serials, tracking modes, one-of-a-kind items, pack-aware receipts with costs, reservations with partial release and fulfillment, allocation rules with earliest expiry first, reallocation, bundles, shortages, moving average, the scheduled stock check with a reviewed repair (ADRs 0020, 0021, 0022, 0024). |
| I2 Transfers, returns, counts | #57, #63, #64 | Transfers with holds, transit, exceptions, and one-command moves; returns with quarantine and inspection; count sessions, quick counts, adjustments, condition changes, reversals (ADRs 0028, 0029, 0031). |
| I3 Purchasing and alerts | #59, #62 | Purchase orders with PDF, email, receipts against lines, on order; reorder rules, drafts from low stock, alerts in the app, by email, webhooks, and MCP (ADRs 0027, 0030). |
| I4 Scanning and picking | #54, #58, #60, #69 | The scanner at `/app/scan` and the installed app; look up, receive, unknown codes; pick lists on the phone and as PDF; count, move, receive against a PO, quick add with pictures (ADRs 0025, 0026). |
| I5 Webhooks, activity, reports | #47, #52, #71 | Signed webhooks with subscriptions, retries, a log, and replay; activity views with the PRD 7.4 filters on a shop-first audit key; the eight reports, saved reports, CSV export, `run_report` (ADRs 0023, 0032, 0034). |
| I6 Shopify connector | #67, #70, #74, #76, #79 | Mapping and onboarding; the order lifecycle; batched compare-and-set push and the reconciler; sync health and `shopify_sync`; listings in both directions with per-field ownership (ADRs 0033, 0035–0038). |
| I7 MVP gate | #73, #77, #78, #80, #82, #83, #86, #87, #89, #90, #91; #92 open | Two reviews and their fixes, the volume run, the CI deploy fix, test stability, idempotency retention, the inventory-list fix, and the reservation-contention fix (in review). |
| Across milestones | #66 | MCP server instructions that route by task (D16). |

## 2. Exit criteria

**States:** Done (a passing test, a recorded run, or a figure in this report), Partly, Not done, or Waiting for the owner's run.

| ID | Criterion | State | Evidence |
| --- | --- | --- | --- |
| G1 | Stock per location, condition, lot, and serial; history and balances reconcile; a mismatch raises an alert with a reviewed repair; one SKU in a store, a rented warehouse, and a fulfillment partner | Done | A03 in `packages/core/test/inventory.test.ts`. A21 property tests in `stock-property.test.ts` and `documents-property.test.ts`. The scheduled stock check and reviewed repair in `reconciliation.test.ts` (PR #55); since PR #78 it also runs the transfer and return checks (review finding 19). |
| G2 | Reservations: exactly the available units, one effect per replay, expiry against fulfillment, partial release and fulfillment, allocation rule with earliest expiry first | Done | A04 and A08 in `stock-concurrency.test.ts`; A05 in `idempotency.test.ts` and `stock-failures.test.ts`; A37 allocation half in `stock-engine.test.ts`. |
| G3 | Transfers exact through dispatch, transit, partial receipt, cancellation, and exceptions; a transfer hold counts against every other caller | Done | A06, A24, A25 in `transfers.test.ts` and `transfer-concurrency.test.ts`. |
| G4 | Returns to quarantine, inspection splits them, no automatic refund; a returned serial must match one fulfilled from the shop | Done | A07 and the return half of A38 in `returns.test.ts`; `apps/web/e2e/returns.spec.ts`. |
| G5 | Counts: movement during a count needs review; below reserved needs a shortage resolution; grid quantity becomes a count; adjustments have reasons and reversals | Done | `counts.test.ts`, `count-failures.test.ts` (details in the final version). |
| G6 | Lots and expiry; lot trace and export; serial history; unknown or duplicate serials rejected | Done | A37 and A38 in `stock-engine.test.ts`, `transfers.test.ts`, `returns.test.ts`. |
| G7 | Bundles reserve and fulfill whole or fail whole; a connector order records a shortage per component | Done | A36 in `stock-engine.test.ts` (engine), `stock-concurrency.test.ts`, and `apps/worker/test/shopify-orders.test.ts` (Shopify). |
| G8 | Receipts, counts, transfers, and adjustments accept packs; history shows pack, factor, and base quantity | Done | A28 receipt half in `stock-engine.test.ts`; the transfer half in `transfers.test.ts`. |
| G9 | POs drafted from low stock, sent as PDF, received in part, closed; one alert per rule in the app, email, webhook, and MCP | Done | A34 and A35 in `alerts.test.ts`; `purchasing.test.ts`. |
| G10 | Moving average: €4 and €6, 5 fulfilled: average €5, value €75, cost of goods €25, same when re-run; costs hidden without `costs.read` | Done | A39 in `stock-engine.test.ts` and `reports.test.ts`. |
| G11 | Scanning on the owner's iPhone, in Safari and installed | Waiting for the owner's run | The flows pass in Chromium (`apps/web/e2e`). The iPhone script is [status, Section 2.1](phase-2-status.md#21-iphone-check-i4). Only iPhone Chrome in a tab was run (Phase 0, E8). |
| G12 | Pick lists by location path; a short pick starts a count and reallocation; stock changes only at fulfillment | Done | A41 pick half in `packages/core/test/picking.test.ts` and `apps/web/e2e/picking.spec.ts`. |
| G13 | Eight reports with filters, saved reports, CSV; activity views with PRD 7.4 filters, per-record history, ingestion delay; location scope on every new read and command | Done | `reports.test.ts` (core and Worker), `activity.test.ts`; A42 across `transfers`, `returns`, `counts`, `picking`, `scan-lookup`, `webhooks`, `alerts`, `reports`, and `shopify-health` tests. |
| G14 | Signed webhooks reach the owner's n8n after commit only, with retries, a log, deduplication, and replay | Waiting for the owner's run | `packages/core/test/webhooks.test.ts` (A11, A19). On staging, 40 of 40 deliveries to a stand-in receiver on the first attempt, p95 366 ms from the event (Section 3). |
| G15 | Shopify: onboarding (rehearsed with the owner's export), mapping, full order flow, shortages, reconciler, listings both ways, sync health in the dashboard and MCP | Waiting for the owner's run | A28, A29, A30, A36, A41 Shopify half against the fake store in `apps/worker/test/shopify-*.test.ts`; review findings F1–F12, L1–L2 fixed (PRs #90, #91). Not yet run on the development stores with the new scopes, and no rehearsal. |
| G16 | Parity; ChatGPT picks the right tool and action for the Phase 2 prompts | Waiting for the owner's run | `pnpm parity`: 201 operations, 22 MCP tools; A23 in `registry.test.ts`. The prompts are in `docs/chatgpt-runs/phase-2.json`; no run is recorded. |
| G17 | Failure contract for every new command | Done | A11, A12, A26 in `stock-failures.test.ts`, `transfer-failures.test.ts`, `return-failures.test.ts`, `count-failures.test.ts`, and `failures.test.ts`. |
| G18 | Volume run on the persona shops meets its targets; cost per shop updated | Partly | Section 3 and 4. Two over-target cases: the inventory list (fixed in PR #89 for one reader; 10 readers on the largest shop still over) and 10 reservations of one variant (fix in PR #92, open). Shopify latencies and Neon compute with the new crons were not measured. |

## 3. Measurements

See [Phase 2 measurements](phase-2-measurements.md). Table to follow.

## 4. Cost model update

To follow.

## 5. Reviews

To follow.

## 6. What went wrong

To follow.

## 7. Proposed PRD changes

To follow.

## 8. Not done, and handoff to I8 and I9

To follow.
