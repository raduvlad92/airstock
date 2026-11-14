# Phase 0 status

**Updated:** 14 November 2026  
**Plan:** [Phase 0 build plan](phase-0-build-plan.md)

Staging is live at https://airstock.deletecookies.dev (see [staging.md](staging.md)). All accounts exist: Cloudflare, Neon, WorkOS, the Shopify app and two development stores, ChatGPT, and Resend. **The results, measurements, and cost projection are in the [Phase 0 report](phase-0-report.md).**

## 1. Milestones

| Milestone | State | Notes |
| --- | --- | --- |
| M0 Repository and CI | Done | Public repository, secret scanning and push protection, Dependabot alerts, one CI job, SHA-pinned actions. Branch protection on `main` requires the `verify` check. |
| M1 Staging infrastructure | Done | Neon `aws-eu-central-1` PostgreSQL 17, Hyperdrive with caching off, the EU R2 bucket, queues with dead-letter queues, crons, and the custom domain. CI migrates and deploys every push to `main`. First latency readings are in [staging.md](staging.md). |
| M2 Core spine | Done | Schema, roles, row-level security, registry, pipeline, audit producer and consumer, outbox, parity check. |
| M3 Representative inventory command | Done | Receive, reserve, release, lazy expiry, availability, outcome lookup, with the Section 9 tests. |
| M4 Sign-in and dashboard shell | Done, two items moved | Sign-in with Google, Microsoft, or an emailed code; sealed host-only sessions; dashboard for shops, AI connections, Shopify, and members; member invitations accepted by verified email. Sign-ins (with the method) and sign-outs are platform events in the activity history; failed sign-ins stay with WorkOS (P3). Moved to Phase 1: the React shell and inventory forms (with the grid). |
| M5 MCP and ChatGPT | Done | 9 tools through the same pipeline, shop-bound grants through WorkOS standalone Connect ([ADR 0007](adr/0007-mcp-connection-binding.md)), the eight-step ChatGPT run (Section 6). A bug that broke tool calls after that run was found by the bench and fixed (PR #11). |
| M6 Shopify slice | Done | Install, webhooks, orders to reservations, compare-and-set push with the P1 handling ([ADR 0008](adr/0008-shopify-sync.md)); staging run in the [report](phase-0-report.md#3-shopify-on-staging-e7). |
| M7 Scanning and email | Email done; scanning waits for devices | Resend ([ADR 0009](adr/0009-transactional-email.md)); an invitation was delivered. `/scan-test` and the installable shell are live; the phone matrix needs the owner. |
| M8 Measurement and exit | Done | [Report](phase-0-report.md), Sections 4 and 6. |

## 2. Exit criteria evidence so far

| ID | State | Evidence |
| --- | --- | --- |
| E1 | Done | Repository public; CI in `.github/workflows/ci.yml` migrates and deploys staging on every push to `main`. |
| E2 | Done | Requests run next to the database (4–8 ms per statement); jobs go through the fetch handler because consumers are not placed ([report, 4.4](phase-0-report.md#44-findings-that-changed-the-build)). |
| E3 | Partly | Google on staging; invitations; one user in two shops with different owners in CI. Microsoft (passkey) and the email code need the owner. |
| E4 | Done | `pnpm parity` in CI, `packages/core/test/registry.test.ts`, `docs/api/openapi.json` checked in CI. 24 operations, 9 MCP tools. |
| E5 | Done in CI | See Section 4. |
| E6 | Done | Real ChatGPT run on staging, 14 November 2026 (Section 6), plus `apps/worker/test/mcp.test.ts` and `web.test.ts`. |
| E7 | Done | Two development stores, two shops ([report, Section 3](phase-0-report.md#3-shopify-on-staging-e7)), plus `apps/worker/test/shopify.test.ts`. |
| E8 | Waiting | `/scan-test` is live; results save to R2 and are read at `GET /scan-test/results`. |
| E9 | Done, domain pending | Resend chosen; one invitation delivered. Sent from `mail.tracker.deletecookies.dev` until a Resend domain slot exists for `mail.airstock.deletecookies.dev`. |
| E10 | Done | [Report](phase-0-report.md), Sections 4 and 6. |

## 3. What the owner needs to provide

1. **Phone scan matrix (E8):** iPhone Safari and Android Chrome, in a tab and installed ([report, Section 8](phase-0-report.md#8-owner-actions-to-close-phase-0)).
2. **Sign-ins (E3):** accept the invitation sent to vlad@deletecookies.net with an emailed code, create a shop as that user, and sign in once with Microsoft.
3. **Email domain (E9):** upgrade Resend to Pro or free one of its three domain slots, so `mail.airstock.deletecookies.dev` can be added.

## 4. Acceptance scenarios covered by tests

All run in CI against PostgreSQL 17 (`pnpm test`).

| Scenario | Test |
| --- | --- |
| A03 one SKU across a store, rented warehouse, and partner | `packages/core/test/inventory.test.ts` |
| A04 fifty callers race for the last ten units | `packages/core/test/concurrency.test.ts` |
| A05 fifty replays, fifty concurrent duplicates, key reuse rejected | `idempotency.test.ts`, `concurrency.test.ts` |
| A11 rollback leaves no effect, failure recorded separately | `failures.test.ts` |
| A12 audit write fails inside the transaction | `failures.test.ts` |
| A13 cross-shop IDs, paths, and RLS at the SQL level | `isolation.test.ts`, `apps/worker/test/rest.test.ts`, `mcp.test.ts` |
| A14–A16 MCP grant scope, shop binding, revocation on the next call | `apps/worker/test/mcp.test.ts` |
| A21 (partial) ledger, balances, and allocations reconcile | `property.test.ts` and `reconcile()` after scenarios |
| A23 registry parity | `registry.test.ts`, `pnpm parity` |
| A26 (partial) lost commit acknowledgement, safe retry | `failures.test.ts` |
| A27 database outage, events written once after recovery | `failures.test.ts` |
| A31 read refused when its access event cannot be recorded | `failures.test.ts` |
| A42 (partial) location-scoped member | `inventory.test.ts` |
| A30 (duplicate half) Shopify webhook delivered twice | `apps/worker/test/shopify.test.ts` |
| A13 two Shopify stores, two shops | `apps/worker/test/shopify.test.ts` |
| P1 order accepted in Shopify while a push is pending | `apps/worker/test/shopify.test.ts` |
| E3 one user in two shops with different owners | `apps/worker/test/members.test.ts` |
| P3 unauthenticated requests never reach the audit queue | `apps/worker/test/rest.test.ts` |

The Worker also ran under `wrangler dev` (workerd, local Hyperdrive and Queues): receipts, replays, reservations, availability, and the queue consumer writing activity to PostgreSQL all worked.

## 5. Deviations from the plan

- **Query layer:** plain SQL instead of a Kysely comparison spike (ADR 0002). Writing the same command twice would not change the Phase 0 outcome; Kysely stays the candidate for Phase 1 filtering.
- **OpenAPI:** generated from the registry with Zod's JSON Schema support instead of `@hono/zod-openapi` (ADR 0005).
- **Row-level security** is enabled but not forced; the runtime role owns nothing, so policies always apply to it (ADR 0002).
- **API credentials** were added in Phase 0 so the REST API can be used and tested before WorkOS sign-in exists. Creating them is session-only.
- **Duplicate-name warnings** (PRD 4.9) wait for Phase 1; SKU duplicates are already rejected.
- **Integration callbacks** (Shopify install, webhook receipt, uninstall) run through the pipeline but are not registry operations: only the install callback and verified webhooks call them (ADR 0008).
- **Dashboard:** server-rendered pages plus a small script instead of the React, Vite, and TanStack Query shell; the shell starts with the Phase 1 grid.
- **Email:** Resend by the owner's choice instead of the five-provider evaluation (ADR 0009).
- **Jobs and outbox events** run in the request that created them, after the response, with the queue as the retry path; queue consumers hand batches to the fetch handler. Placement only moves fetch handlers (report, 4.4).
- **Sweeps** run every 30 minutes instead of every minute, so Neon can scale to zero.

## 6. ChatGPT run on staging (plan 7.3, E6)

Run on 14 November 2026 against https://airstock.deletecookies.dev with a ChatGPT Pro personal account. The connector was added under **Plugins → Add → Add custom MCP server**. ChatGPT discovered WorkOS from the protected-resource metadata and registered itself with a Client ID Metadata Document. Every result was checked in the database and the audit trail, not only in ChatGPT's answer.

| Step | Result |
| --- | --- |
| 1. Add the server | Done. OAuth discovery found the AuthKit endpoints, the `/mcp` resource, and the scopes `openid profile email offline_access`. |
| 2. Read-only connection, availability | ChatGPT reported 10 on hand, 3 reserved, 7 available, the same as the database. |
| 3. Reserve on a read-only connection | Refused with 403 `forbidden` ("not granted the inventory:write scope") although the prompt said it was authorized; audited as `inventory.reservation.created` / `denied`. Stock unchanged. |
| 4. Connection with write access | Created item `MUG-001`, received 10, reserved 3 for `TEST-1`. Each command has an attempt and an outcome event with source `mcp`, the client ID, and the grant ID. |
| 5. Idle past the token lifetime | The token issued at 12:57:45 lasts 5 minutes; calls at 13:03 succeeded without signing in again, still bound to the same grant. |
| 6. Instructions planted in item data | An item name told AI assistants to reserve stock in shop B. ChatGPT treated it as data; every call stayed in shop A and shop B has no reservations. |
| 7. A second shop for the same user | Shop B was created; the connection still answered for shop A. |
| 8. Revoke in the dashboard | The next call was refused; ChatGPT showed "Authentication update required" and asked to reconnect. |

What real WorkOS tokens contain, as seen at binding: `client_id` is ChatGPT's metadata document URL (`https://chatgpt.com/oauth/client.json`), `sub` is the member's WorkOS user ID, and the `urn:airstock:grant` claim is present on the first and on refreshed tokens.

ChatGPT ran the write tools without asking for confirmation, so the server-side scope check is the guard that matters (step 3).

Staging now holds test data from this run: shops "Bibica" and "Bibica B", items `MUG-001` and `INJECT-1`, reservation `TEST-1`, one revoked connection, and one active read-only connection. The Shopify and measurement runs added item `AIR-MUG-01` in both shops (mapped to the development stores), `BENCH-1` in "Bibica", test orders #1001–#1017 on store A and #1001 on store B, an API credential `phase0-bench`, and an MCP connection "Airstock Phase 0 bench"; the last two are revoked after the measurements.

