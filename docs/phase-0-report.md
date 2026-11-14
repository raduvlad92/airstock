# Phase 0 report

**Date:** 14 November 2026  
**Plan:** [Phase 0 build plan](phase-0-build-plan.md) · **Progress log:** [Phase 0 status](phase-0-status.md)  
**Staging:** https://airstock.deletecookies.dev

## 1. Verdict

The foundation works on real services. ChatGPT and Shopify run end to end against two isolated shops, and every request is fast and audited. Three exit criteria still need the owner: the phone scanning matrix (E8), the Microsoft and email-code sign-ins (E3), and the sending domain for email (E9). Each is a short task, listed in Section 8. Phase 1 can start in parallel.

| ID | Criterion | State | Evidence |
| --- | --- | --- | --- |
| E1 | Public repository, one CI runner, one deploy path | Done | CI migrates and deploys staging on every merge to `main` (15 green runs on `main` today). |
| E2 | Neon (EU) via Hyperdrive, R2 (EU), queues, crons; Worker near the database | Done, with a finding | User requests run next to the database: 4–8 ms per SQL statement. Queue consumers are not placed (Section 4.4); job batches now run through the Worker's own fetch handler. |
| E3 | Google, Microsoft, and email sign-in; two shops with different owners and one user in both | Partly | Google sign-in on staging; invitations by email; one user in two shops with different owners is tested in CI (`apps/worker/test/members.test.ts`). Microsoft asks for a passkey, and the email code goes to the owner's inbox: owner task. |
| E4 | Registry generates REST, OpenAPI, permissions, audit names, MCP; parity in CI | Done | 24 operations, 9 MCP tools, parity check in CI. |
| E5 | Stock commands correct under concurrency, replay, rollback, audit failure, cross-shop | Done | 115 tests against PostgreSQL 17 in CI ([status, Section 4](phase-0-status.md#4-acceptance-scenarios-covered-by-tests)). |
| E6 | ChatGPT over OAuth, bound to one shop, refused beyond its grant, survives refresh, stops on revocation | Done | Eight-step run on 14 November ([status, Section 6](phase-0-status.md)). A later bug in MCP tool calls was found by the bench and fixed (Section 5). |
| E7 | Shopify order → reservation, availability pushed back, duplicate webhook without effect, other shop untouched | Done | Run on two development stores (Section 3). |
| E8 | Camera decode results on current iOS Safari and Android Chrome | Waiting for devices | `/scan-test` is live; desktop Chrome decodes all four targets with both decoders. |
| E9 | Email provider chosen; one email sent | Done, domain pending | Resend ([ADR 0009](adr/0009-transactional-email.md)). An invitation was delivered to the owner's address. It used an existing verified subdomain because the Resend plan has no free domain slot. |
| E10 | CPU, statements, round trips, latency, queue operations, bytes per audit event, cost per shop | Done | Sections 4 and 6. |

## 2. What was built

- **Spine:** operation registry, command pipeline, PostgreSQL schema with row-level security, queue-based audit intake, outbox, idempotency (ADRs 0001–0006).
- **Access:** WorkOS sign-in without passwords (sign-ins and sign-outs recorded as platform events), sealed host-only sessions, API credentials, MCP with shop-bound grants through WorkOS standalone Connect (ADR 0007), member invitations accepted by verified email.
- **Shopify:** install with expiring encrypted tokens, `orders/create` and `app/uninstalled` webhooks, orders reserved by the Shopify connector, and a compare-and-set availability push that processes unseen orders before reporting a conflict (ADR 0008).
- **Email:** Resend, idempotent sends from the outbox (ADR 0009).
- **Scanning:** an installable shell and a camera decode test page comparing the built-in BarcodeDetector with zxing-wasm.
- **Measurement:** `Server-Timing` on every request, a request log line, `scripts/bench/run.ts`, `scripts/bench/audit-bytes.ts`.

## 3. Shopify on staging (E7)

Stores `airstock-dev-a` and `airstock-dev-b`, each installed into its own shop ("Bibica", "Bibica B") through the dashboard. Both `orders/create` and `app/uninstalled` subscriptions were accepted; development stores did not ask for protected customer data approval (a public app will).

| Check | Result |
| --- | --- |
| First push after mapping by SKU | Shopify 3 → 10 (store A) and 3 → 20 (store B), each compared against Shopify's quantity read just before. |
| Order becomes a reservation | Order #1001 for 2 became reservation `shopify:order/18617424773450/line/49445606621514`, actor `connector`, source `shopify`. Airstock's record of Shopify went 10 → 8, matching Shopify. |
| Duplicate delivery (A30) | The same event ID again: recorded as `no_change`, no receipt, no job. The same order under a new event ID: new receipt and job, line already processed, still one reservation. |
| Isolation (A13) | An order on store B reserved 5 in "Bibica B" only; store A and its shop were unchanged. |
| Airstock change reaches Shopify | A receipt of 2 made Shopify 8 → 10. |
| P1 race | Order #1002 took Shopify 10 → 9 while an Airstock receipt raised Airstock to 13. The push's write 10 → 13 was refused (`changeFromQuantity` stale); it processed the order and wrote 9 → 12. Audit event: `refusedWrites: 1, ordersCaughtUp: 1`. The late webhook found the line done. Shopify never showed 13. |
| Unexplained edit | Shopify set to 50 by hand: the push was refused, no order explained it, a `shopify.inventory.conflict` event recorded expected 12, Airstock 13, Shopify 50, and Shopify was left at 50. Mapping again from the dashboard took 50 as the new start and pushed 50 → 13. |
| Bad signature (P3) | 401 before anything is recorded or queued. |

## 4. Measurements (E10)

Measured on staging, 14 November 2026, from a laptop in Europe. Every request reports its own `Server-Timing`, so client and server figures are separate. CPU time comes from `wrangler tail`.

### 4.1 Latency per operation

Bench run 4 (Smart Placement, current configuration), 40 iterations each, one at a time, warm Worker and warm Neon compute:

| Operation | Client p50 / p95 | Worker p50 / p95 | Database p50 / p95 | Audit queue send p50 | Transactions | SQL statements | Queue sends |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REST `get_availability` | 172 / 223 ms | 114 / 130 ms | 43 / 60 ms | 71 ms | 2 | 7 | 1 |
| REST `reserve_stock` | 209 / 241 ms | 152 / 173 ms | 76 / 102 ms | 73 ms | 2 | 13 | 1 |
| REST `release_reservation` | 252 / 327 ms | 187 / 218 ms | 101 / 134 ms | 83 ms | 2 | 15 | 1 |
| REST `receive_stock` | 198 / 235 ms | 141 / 174 ms | 63 / 104 ms | 77 ms | 2 | 11 | 1 |
| MCP `get_availability` | 175 / 242 ms | 123 / 167 ms | 48 / 60 ms | 77 ms | 2 | 7 | 1 |
| MCP `reserve_stock` | 229 / 276 ms | 170 / 210 ms | 88 / 112 ms | 75 ms | 2 | 13 | 1 |

- **Against the PRD 12.3 targets** (reads p95 under 1 s, stock commands under 2 s at the server): every operation is under a quarter of its target.
- **The awaited audit send is the largest single part** of every request: 65–85 ms, about half of the Worker time. It is the price of "no response without a durable record" (PRD 7.3). If reads need to be faster, the plan's fallback applies: send the access event concurrently with the query and wait for both.
- One of the two transactions is authentication (API credential or MCP grant lookup, 3 statements).
- Across three runs the database time per statement was 4–8 ms (runs 2–4); the run-to-run variation was larger than the difference between Smart Placement and an explicit `aws:eu-central-1` hint, so the comparison the plan asked for is inconclusive. Smart Placement stays.

### 4.2 CPU time

From `wrangler tail`, per invocation (includes after-response work such as outbox delivery):

| Request | CPU p50 | CPU p95 |
| --- | --- | --- |
| `get_availability` | 11 ms | 45 ms |
| `reserve_stock` | 24 ms | 37 ms |
| `release_reservation` | 31 ms | 92 ms |
| `receive_stock` | 20 ms | 26 ms |
| MCP tool call | 14 ms | 30 ms |
| Cron sweep | 14–34 ms | |
| Audit queue batch (8–18 events) | 2–5 ms | 19 ms |

Commands gained about 10 ms CPU when they started delivering their outbox events after the response (Section 4.4).

### 4.3 Shopify latency

| Path | Before | After | Change |
| --- | --- | --- | --- |
| Shopify order → webhook received | 1.5–2.1 s | same | Shopify's side |
| Webhook received → reservation committed | 3.0–6.9 s, median 4.6 s | 0.20–0.30 s, median 0.26 s | Jobs run next to the database, right after the webhook response (PRs #12, #13) |
| Airstock receipt → Shopify updated | Up to 60 s (cron), then 2.3–7.5 s | 0.26–0.31 s, median 0.27 s | Outbox delivered right after the command (PRs #7, #14) |

### 4.4 Findings that changed the build

- **Queue consumers run far from the database.** Placement moves only fetch handlers. Consumers measured about 150 ms per round trip to Neon, so an order job (about 25 round trips) took seconds. Job batches now go through the Worker's own fetch handler via a service binding, and order jobs and outbox events run right after the request that created them; the queue is the retry path.
- **The every-minute cron kept Neon awake.** 0.89 CU-hours in the project's first four hours, which is about 180 CU-hours a month against the free plan's 100: staging would have been suspended mid-month. The sweep now runs every 30 minutes; commands publish their own events.
- **Queue delivery adds 1.5–4.6 s.** Cloudflare Queues is fine for retries and audit intake, not for anything a merchant waits on.

### 4.5 Neon cold start

With the sweep every 30 minutes, the compute suspended 6 minutes after the 15:00 sweep (Hyperdrive's pool does not keep it awake). The first `get_availability` after that:

| | Database | Worker | Client |
| --- | --- | --- | --- |
| First request, compute suspended | 736 ms | 926 ms | 1.42 s |
| Next three requests | 48–80 ms | 112–153 ms | 0.40–0.56 s |

A waking compute adds about 0.7 s once. That is inside the targets, so the plan's fallback (keep compute warm on a paid plan) is not needed for the pilot. A ChatGPT or Shopify call that arrives first after an idle period pays it.

### 4.6 Bytes per audit event

100,000 synthetic events through `ingest_audit_events` on PostgreSQL 17 (`scripts/bench/audit-bytes.ts`), shaped like staging's events (60% read access, 20% attempts, 20% command outcomes):

| Part | Bytes per event |
| --- | --- |
| Table (heap) | 433 |
| Indexes | 298 (target 127, shop and time 103, primary key 40, attempt 27) |
| TOAST | 0 |
| **Total** | **732** |

A million events is about 700 MB, so the plan's 1-million-event benchmark does not fit Neon Free's storage (P5 confirmed); run it in a separate project or temporary paid tier, as planned.

## 5. What went wrong

| Problem | Found by | Fix |
| --- | --- | --- |
| Every MCP tool call on staging failed with an internal error after the ChatGPT run. The SDK answers with a stream the tool writes into after `fetch()` returns; the request closed its database handle first. ChatGPT's earlier calls succeeded; whether they won the race or were answered differently is not known. | The bench (60 tool calls, all `isError`) | Read the response to the end before returning; the test database handle now refuses use after close, which reproduces it (PR #11). |
| Re-mapping a Shopify store failed: a delete and an insert in one statement share a snapshot, so the insert hit the rows being deleted. | Test | Two statements (PR #6). |
| The first real browser run blocked same-site form posts (`Origin: null` under `no-referrer`). | Staging, before this session | `same-origin` referrer policy (PR #4). |
| Queue consumers far from the database; Neon never suspending | Measurement | Section 4.4. |
| Two commits went in with formatting errors because a pipeline hid `pnpm verify`'s exit code. | CI | Fixed in follow-up commits; CI caught both. |

## 6. Cost per shop (E10)

### 6.1 Assumptions

A small paid shop each month: 30,000 reads (dashboard, API, MCP), 6,000 stock commands, 900 Shopify orders with 2 lines each. Audit history stays in PostgreSQL for 3 months, then moves to R2 (PRD 7.4). Rates: PRD 14.1, Neon Launch ($0.106 per CU-hour, $0.35 per GB-month), Resend Pro ($20 a month).

Measured per unit:

| Unit | CPU | Queue operations | Audit events | Stored per month |
| --- | --- | --- | --- | --- |
| Read | 11 ms | 3 (one access event) | 1 | 0.7 KB |
| Command | 24 ms | 3 (attempt event; outbox delivered in the request) | 2, plus 1 push event when mapped | 2.2 KB |
| Shopify order, 2 lines | about 50 ms | 12 (webhook attempt, delayed safety copy, two reservation attempts) | 6 | 4.4 KB |

Per shop per month: 36,900 requests, 519,000 CPU-ms, 118,800 queue operations, 53,400 audit events (39 MB a month, 117 MB in the 3-month hot window).

### 6.2 Projection

| Item | 10 shops (pilot) | 1,000 shops |
| --- | --- | --- |
| Workers requests ($0.30 per million beyond 10 M) | included | $0.008 |
| Workers CPU ($0.02 per million ms beyond 30 M) | included | $0.010 |
| Queues ($0.40 per million operations beyond 1 M) | included | $0.047 |
| Neon storage ($0.35 per GB-month) | free plan | $0.044 |
| Neon compute (1–1.5 CU around the clock at 1,000 shops) | free plan, see note | $0.077–0.116 |
| R2 archive | free allowance | under $0.005 |
| Email (Resend Pro) | free plan | $0.020 |
| Workers Paid base ($5) | $0.50 | $0.005 |
| **Per shop per month** | **about $0.50 (the base fee)** | **about $0.21–0.25** |

**Against the $0.49 budget (PRD 14.4): it fits at 1,000 shops with about 2× headroom.** At pilot size the fixed $5 Workers fee dominates, and the pilot's daytime traffic will keep Neon awake for hours a day: 10 active shops could use most of the free 100 CU-hours, so budget for Neon Launch (about $10–20 a month) during the pilot.

### 6.3 What breaks it

- **Reads by integrations.** Every read is a queue message (3 operations). One API client polling availability every second costs about 7.8 million operations a month, about $3 for that shop alone. Rate limits per credential are needed before launch, and read access events should be batched (several events per message) for API and MCP clients.
- **Longer hot history.** Each extra month of audit history in PostgreSQL adds about $0.014 per shop.
- **Neon compute** is the largest item and depends on traffic shape, not shop count. Measure it during the pilot (PRD 16.2).

## 7. Proposed PRD v0.5 changes

| ID | Change | Section |
| --- | --- | --- |
| P1 | Shopify mismatch handling: on a refused compare-and-set, process unseen orders, recompute, retry; only an unexplained difference is a conflict. Proven (Section 3). | 8.5 |
| P2 | One queue message per read, carrying the outcome. Built. | 7.3, 14.2 |
| P3 | Authentication before the audit queue; failed authentication is a 401 without an audit event. Built, including Shopify webhooks. | 7.3, 10.3 |
| P4 | UUIDv7 event IDs, monthly partitions on creation time, `UNIQUE (occurred_at, event_id)`. Built. | 7.3, 7.4 |
| P5 | 732 bytes per audit event including indexes; the 1-million-event benchmark needs a separate project or paid tier. | 12.3, 14.1 |
| P6 | Email domain: owner chose Resend and a dedicated subdomain; Resend stores data in the US (C20 gap, ADR 0009). | 14.2, 17 |
| P7 | Neon `aws-eu-central-1`. Built. | 12.4 |
| P8 | Wording: bundles are in V0. | 8.5 |
| P9 | MCP authorization is WorkOS standalone Connect, with Airstock's consent creating the grant (ADR 0007). | 1.3, 9.4 |
| P10 | Shopify uses expiring offline tokens (1 h access, 90 d refresh), required for public apps from 2027. | 8 |
| P11 | Work a merchant waits on runs in the request (after the response) next to the database; Cloudflare Queues is the retry path. Queue consumers are not placed near the database. | 10, 13 |
| P12 | Scheduled sweeps every 30 minutes, not every minute, so the database can scale to zero. | 6.3, 14.2 |
| P13 | Rate limits per API credential and MCP connection, and batched read access events, before launch (cost). | 9, 14.2 |
| P14 | A Shopify store is active in one shop at a time; protected customer data approval is needed before the app is public. | 8.5 |
| P15 | A connection grant whose consent was abandoned (the client never received the code) stays active and unbound; expire unbound grants after a few minutes. Seen once on staging. | 9.4 |

## 8. Owner actions to close Phase 0

1. **Scan matrix (E8), about 15 minutes.** On an iPhone (Safari) and an Android phone (Chrome), sign in at https://airstock.deletecookies.dev/scan-test, open the targets page on a laptop screen, and scan each code once with each decoder at arm's length in good light, then once close and once in dim light. Repeat once after "Add to Home Screen" (installed). Results save automatically.
2. **Sign-in methods (E3), about 5 minutes.** Accept the invitation emailed to vlad@deletecookies.net by signing in with an emailed code, create a shop as that user, and sign in once with Microsoft (it asks for your passkey).
3. **Email domain (E9).** Choose one: upgrade Resend to Pro ($20 a month), or remove one of the three existing Resend domains. Then `mail.airstock.deletecookies.dev` can be added; switching staging is DNS plus one setting.

## 9. Not done, and why

- **React shell (M4).** The dashboard is server-rendered pages plus a small script calling `/api/v1`. The React and TanStack shell starts with the Phase 1 grid, where it is needed.
- **Inventory forms in the dashboard.** Stock is changed through the API, MCP, and Shopify; the forms come with the Phase 1 grid.
- **Shortage reservations (A29), cancellations, the reconciler (A30 second half).** Phase 3, as planned.
- **Cold Worker start.** Not controllable from outside; first requests after a deploy took 0.5–0.8 s at the client.

## 10. Phase 1 starting point

Phase 1 builds on the registry, the pipeline, the schema conventions, and the test harness. First tasks: custom fields and product families (the next schema-shaping decision), then the TanStack grid and the React shell, with REST and MCP coverage alongside each feature.
