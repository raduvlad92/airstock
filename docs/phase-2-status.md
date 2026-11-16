# Phase 2 status

**Updated:** 16 November 2026  
**Plan:** [Phase 2 build plan](phase-2-build-plan.md)

Staging: https://airstock.deletecookies.dev (see [staging.md](staging.md)). Every merge to `main` migrates and deploys it. Large seeds and timings run in the separate bench project (Section 4), never on staging.

## 1. Milestones

| Milestone | State | Notes |
| --- | --- | --- |
| I0 Groundwork | Done | Bench seeds and baseline timings (PR #48, [measurements](phase-2-measurements.md)). Originals shrink to 2,048 px, re-consent revokes earlier connections, and the ChatGPT harness (PR #46). Research (Section 5). The bench seed found a crash in the catalog grid on names outside Latin-1 ("ș", "€"); fixed in PR #50. |
| I1 Stock engine | Done | Schema, receipts, reservations, fulfillment, allocation rules, bundles, shortages, and valuation (PRs #45, #49). One-of-a-kind items, quick add, starter families for cards and sets, and the dashboard stock panel (PR #51). The scheduled stock check with a reviewed repair (PR #55, Settings › Stock check). |
| I2 Transfers, returns, counts | In progress | Restarted 16 November, 07:30 UTC |
| I3 Purchasing and alerts | Done when #62 merges | Purchase orders (PR #59, [ADR 0027](adr/0027-purchase-orders.md)): PDF, email, receipts against lines, on order. Reorder rules, draft from low stock, and alerts in the app, by email, webhooks, and MCP (PR #62, [ADR 0029](adr/0029-reorder-rules-and-alerts.md)). |
| I4 Scanning and picking | First half done | The scanner at `/app/scan` and the installed app (PR #54, [ADR 0025](adr/0025-scanning-and-installed-app.md)); look up, receive, and unknown codes (PR #58); pick lists on the phone and as PDF (PR #60, [ADR 0026](adr/0026-picking.md)). Next (I4b), once I2 and I3 land: count, move, receive against a PO, quick add, and short pick to count. |
| I5 Webhooks, activity, reports | In progress | Webhooks done (PR #47, [ADR 0023](adr/0023-outgoing-webhooks.md), [webhooks.md](webhooks.md)). Activity views are being finished. Reports wait for I3. |
| I6 Shopify connector | Waiting for I2 | |
| I7 MVP gate | Not started | |
| I8 Pilot go-live | Not started | |
| I9 After January | Not started | |

**Night of 16 November:** every agent stopped at the account's 5-hour usage limit at about 03:20 UTC. Only pushed work survived: the stock engine's third part, the webhooks, and most of the activity views. The three milestones that had just started lost nothing, because they had not written code yet. Each agent now pushes within its first 30 minutes.

## 2. Owner steps

| When | Step | State |
| --- | --- | --- |
| I0 | Create the `airstock-bench` Neon project and a project-scoped API key | Done, 16 November |
| I4, now | Scan on the iPhone in Safari and as an installed app, close up and in dim light, including a graded-card slab label: the script in Section 2.1 | **Ready** |
| I5 | Give an n8n webhook URL and set up a subscription in the dashboard | Later |
| I6 | Give the store's Shopify product export, for the rehearsal on a development store | Later |
| I7 | Decide production: domain, Neon plan, WorkOS production environment, email sender | Later |

### 2.1 iPhone check (I4)

The scanner has only been tested in browsers on a computer. This run checks the camera, torch, sounds, and home-screen install on the iPhone.

1. **Open the scanner.** In Safari on the iPhone, open https://airstock.deletecookies.dev/app/scan and sign in. Tap **Start camera** and allow it. The line under the camera should say "zxing decoder".
2. **Print test labels.** On the laptop, go to Labels and print a location label for a shelf, and labels for one or two products. Real product barcodes work too.
3. **Location label.** Scan it. The green bar should read "Location: Main stock/…".
4. **Look up.** Scan a product barcode. The item and its stock per location should appear.
5. **Close and dim.** Repeat step 4 close up (5–10 cm) and in dim light. Try **Light on** and **Zoom** if they appear.
6. **Graded-card slab.** Scan the slab's barcode close up, then in dim light, through the plastic.
   - If it's unknown, tap **Create new item** or **Attach to an item**.
   - Scan it again; it should now find the item.
7. **Receive.**
   - Open the **Receive** tab.
   - Scan the item twice; it should show 2 units.
   - Tap **Receive 2**; you should hear a beep.
   - Check the stock in **Look up**.
8. **Install.** While on `/app/scan`, tap Share, then **Add to Home Screen**. Open Airstock from the home screen; it should start on the scanner. Repeat steps 3 and 4. Put the ringer on silent and check the beep still plays (the button in the header turns sounds off).
9. **Pick.**
   - On the laptop, reserve a few units on the Inventory page.
   - Go to Picking, then **Build pick list**, then **Download PDF**.
   - On the phone, open **Pick**, choose the list, scan the shelf label, scan the item, and tap **Confirm**.
   - On one line, try **Short…**.
   - Tap **Finish and fulfill**. Stock should drop only at the end.

Note anything that fails, and at which step.

## 3. Decisions

ADRs are numbered when they merge. This table links each decision as it lands.

| ID | Decision | Record |
| --- | --- | --- |
| D1–D4 | Stock model, conditions, lots, serials, allocation rule | [ADR 0020](adr/0020-stock-model.md) |
| D5 | One-of-a-kind items, both ways | [ADR 0024](adr/0024-one-of-a-kind-items.md) |
| D6 | Shortages | [ADR 0021](adr/0021-shortages.md) |
| D7 | Valuation | [ADR 0022](adr/0022-valuation.md) |
| D11 | Purchase orders: per-line quantities, receipts at the line cost, PDF in the Worker, send log | [ADR 0027](adr/0027-purchase-orders.md) |
| D12 | Alerts: checked in the stock transaction, one open alert per rule, notified through the outbox | [ADR 0029](adr/0029-reorder-rules-and-alerts.md) |
| D14 | Webhooks: registry of event types, per-shop subscriptions, signed deliveries with retries | [ADR 0023](adr/0023-outgoing-webhooks.md), [docs/webhooks.md](webhooks.md) |
| D16 | MCP tools: measured tool choice, not a count | [ADR 0005, update](adr/0005-operation-registry.md) and Section 5.1 |
| D19 | Media originals shrink above 2,048 px | [ADR 0015, update](adr/0015-media.md) |
| D20 | Re-consent revokes earlier connections, on the new connection's first request | [ADR 0007, update](adr/0007-mcp-connection-binding.md) |

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
| Bench project | Six "Bench" persona shops on branch `i0-personas`; the 1-million-event history on branch `i0-baseline` (I0) | Timings; see [measurements](phase-2-measurements.md) |
| Staging | As listed in [Phase 1 status](phase-1-status.md), Section 4 | Unchanged by Phase 2 seeds |
