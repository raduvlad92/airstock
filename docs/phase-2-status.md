# Phase 2 status

**Updated:** 16 November 2026  
**Plan:** [Phase 2 build plan](phase-2-build-plan.md)

Staging: https://airstock.deletecookies.dev (see [staging.md](staging.md)). Every merge to `main` migrates and deploys it. Large seeds and timings run in the separate bench project (Section 4), never on staging.

## 1. Milestones

| Milestone | State | Notes |
| --- | --- | --- |
| I0 Groundwork | In progress | Three parts are running in parallel: bench seeds and baseline timings; media size limit, re-consent, and the ChatGPT harness; and the research below (Section 5), which is done. |
| I1 Stock engine | In progress | Started 16 November, in parallel with I0, because every later milestone builds on its schema. |
| I2 Transfers, returns, counts | Waiting for I1 | |
| I3 Purchasing and alerts | Waiting for I1 | |
| I4 Scanning and picking | Waiting for I1 | |
| I5 Webhooks, activity, reports | Waiting for I1 | |
| I6 Shopify connector | Waiting for I1 and I2 | |
| I7 MVP gate | Not started | |
| I8 Pilot go-live | Not started | |
| I9 After January | Not started | |

## 2. Owner steps

| When | Step | State |
| --- | --- | --- |
| I0 | Create the `airstock-bench` Neon project and a project-scoped API key | Done, 16 November |
| I4, early | Scan on the iPhone in Safari and as an installed app, close up and in dim light, including a graded-card slab label | Later |
| I5 | Give an n8n webhook URL and set up a subscription in the dashboard | Later |
| I6 | Give the store's Shopify product export, for the rehearsal on a development store | Later |
| I7 | Decide production: domain, Neon plan, WorkOS production environment, email sender | Later |

## 3. Decisions

ADRs are numbered when they merge. This table links each decision as it lands.

| ID | Decision | Record |
| --- | --- | --- |
| D16 | MCP tools: measured tool choice, not a count | [ADR 0005, update](adr/0005-operation-registry.md) and Section 5.1 |
| D19 | Media originals shrink above 2,048 px | In progress |
| D20 | Re-consent revokes earlier connections | In progress |
| D14 | Webhooks: registry of event types, per-shop subscriptions, signed deliveries with retries | [ADR 0023](adr/0023-outgoing-webhooks.md), [docs/webhooks.md](webhooks.md) |

## 4. Bench project

- **Neon project `airstock-bench`:** Frankfurt (`aws-eu-central-1`), Postgres 17, free plan, default branch `production`. It is separate from staging, so a full database there cannot block staging.
- **Access:** an owner connection string and an API key scoped to this project only. Both are kept outside the repository. The key cannot create or delete projects or reach staging.
- **Limits:** 1 GB of storage. At 1 GB every write fails, deletions included, so seeds stop at about 850 MB (plan risk R3). It has 100 compute hours a month of its own.
- **Lifetime:** kept through Phase 2, then deleted.

## 5. Research

### 5.1 How ChatGPT handles a larger tool list (D16)

Checked on 16 November 2026 against OpenAI's documentation:

- **No documented limit** on the number of tools an MCP app exposes in ChatGPT. Users can switch individual tools off in the app's settings.
- **Discovery:** ChatGPT reads the tools, their descriptions, and the server's `instructions` when the app is refreshed. Its selection method is not documented. OpenAI's own advice:
  - action-oriented tool names;
  - descriptions that say "Use this when…" and name the cases a tool is not for;
  - parameter descriptions with enums;
  - server-wide guidance in the MCP `instructions` field, with its first 512 characters self-contained.
- **Annotations:** ChatGPT respects `readOnlyHint`. A tool without it is treated as a write and asks the user to confirm by default.
- **Tool search:** OpenAI's Responses API has tool search, which loads an MCP server's tools only when needed (`defer_loading`). That is for developers who call the API themselves, so it is nothing an MCP server can switch on for ChatGPT.

**Consequence for Phase 2:**
- Keep the tools task-shaped, and write every description in OpenAI's "Use this when…" form.
- Mark read-only tools with `readOnlyHint`.
- Put the cross-tool guidance in the server `instructions`, for example "for stock questions use `get_stock`; for catalog questions use `search_catalog`".
- Measure every milestone's prompts with the harness (`scripts/chatgpt-run.ts`). A wrong pick is fixed by wording first, then by merging or splitting tools.

### 5.2 Shopify protected customer data for the pilot store

Checked on 16 November 2026 against [Shopify's protected customer data page](https://shopify.dev/docs/apps/launch/protected-customer-data):

- For a **custom app**, Shopify's access table lists protected customer data, levels 1 and 2, as **always available**. Shopify's review through the Partner Dashboard is described for public apps only.
- An app must have a distribution method chosen before it can request access. Custom distribution installs on one store (or one Plus organization), and the choice cannot be changed.

**Consequence for Phase 2:**
- Plan risk R2 (a review delaying January) does not apply to the pilot.
- The pilot store gets its own custom-distribution app for production (I8). The staging app stays on the development stores.
- The connector still asks only for IDs and line items in its webhooks (ADR 0008) and stores no names or addresses. That keeps the later public app at level 1.
- Recheck before going public (PRD 15, Phase 5).

## 6. Bench and staging data

| Where | Data | Purpose |
| --- | --- | --- |
| Bench project | Six "Bench" persona shops and a 1-million-event history (I0) | Timings; written to `docs/phase-2-measurements.md` when I0 lands |
| Staging | As listed in [Phase 1 status](phase-1-status.md), Section 4 | Unchanged by Phase 2 seeds |
