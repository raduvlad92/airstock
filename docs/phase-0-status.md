# Phase 0 status

**Updated:** 14 November 2026  
**Plan:** [Phase 0 build plan](phase-0-build-plan.md)

The code that does not need external accounts is built and tested. What remains needs accounts only the owner can create (Section 3).

## 1. Milestones

| Milestone | State | Notes |
| --- | --- | --- |
| M0 Repository and CI | Done | Public repository, secret scanning and push protection, Dependabot alerts, one CI job, SHA-pinned actions. Branch protection is turned on once the first CI run passes. |
| M1 Staging infrastructure | Ready, waiting for accounts | `apps/worker/wrangler.jsonc` declares Hyperdrive, the EU R2 bucket, two queues with dead-letter queues, and crons. `/internal/smoke` measures database, R2, and queue latency once `SMOKE_SECRET` is set. CI migrates and deploys when the `staging` secrets exist. |
| M2 Core spine | Done | Schema, roles, row-level security, registry, pipeline, audit producer and consumer, outbox, parity check. |
| M3 Representative inventory command | Done | Receive, reserve, release, lazy expiry, availability, outcome lookup, with the Section 9 tests. |
| M4 Sign-in and dashboard shell | Not started | Needs the WorkOS staging environment. User creation (`upsert_user_by_workos_id`) and session callers already exist. |
| M5 MCP and ChatGPT | Server side done | `/mcp` serves 9 tools through the same pipeline, verifies tokens against a JWKS, and checks the connection grant on every call. The WorkOS shop-binding spike (plan 7.2) and the ChatGPT run need WorkOS. |
| M6 Shopify slice | Not started | Needs a Shopify Partners account and two development stores. The outbox already announces `inventory.availability_changed`. |
| M7 Scanning and email | Not started | Scanning needs the staging URL (camera access requires HTTPS). Email provider evaluation can proceed; the send waits for a domain (P6). |
| M8 Measurement and exit | Not started | Needs staging. Statement counting is built into the database layer. |

## 2. Exit criteria evidence so far

| ID | State | Evidence |
| --- | --- | --- |
| E1 | Partly | Repository public; CI in `.github/workflows/ci.yml`. Staging deploy waits for M1. |
| E2 | Waiting | M1. |
| E3 | Waiting | M4. |
| E4 | Done | `pnpm parity` in CI, `packages/core/test/registry.test.ts`, `docs/api/openapi.json` checked in CI. |
| E5 | Done in CI | See Section 4. |
| E6 | Server side tested | `apps/worker/test/mcp.test.ts` (A14–A16 with test tokens). The real ChatGPT run waits for M5. |
| E7–E10 | Waiting | M6–M8. |

## 3. What the owner needs to provide

In rough order of how much each one unblocks:

1. **Cloudflare (M1).** An API token that can edit Workers scripts, Hyperdrive, Queues, and R2, plus the account ID. Store both as secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the GitHub `staging` environment.
2. **Neon (M1).** A free project in `aws-eu-central-1` (Frankfurt) on PostgreSQL 17. Store the owner connection string as `DATABASE_OWNER_URL` in the `staging` environment. Bootstrap creates the `airstock_app` role; its password is then set once and used for the Hyperdrive configuration.
3. **WorkOS (M4, M5).** A staging environment with Google, Microsoft, and Magic Auth enabled, plus its API key and client ID.
4. **Shopify (M6).** A Partners account and two development stores.
5. **ChatGPT (M5).** An account that can add custom MCP connections (developer mode), for the recorded run.
6. **Email domain (M7).** Deferred by the owner.

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
| P3 unauthenticated requests never reach the audit queue | `apps/worker/test/rest.test.ts` |

The Worker also ran under `wrangler dev` (workerd, local Hyperdrive and Queues): receipts, replays, reservations, availability, and the queue consumer writing activity to PostgreSQL all worked.

## 5. Deviations from the plan

- **Query layer:** plain SQL instead of a Kysely comparison spike (ADR 0002). Writing the same command twice would not change the Phase 0 outcome; Kysely stays the candidate for Phase 1 filtering.
- **OpenAPI:** generated from the registry with Zod's JSON Schema support instead of `@hono/zod-openapi` (ADR 0005).
- **Row-level security** is enabled but not forced; the runtime role owns nothing, so policies always apply to it (ADR 0002).
- **API credentials** were added in Phase 0 so the REST API can be used and tested before WorkOS sign-in exists. Creating them is session-only.
- **Duplicate-name warnings** (PRD 4.9) wait for Phase 1; SKU duplicates are already rejected.
