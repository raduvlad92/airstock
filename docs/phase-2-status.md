# Phase 2 status

**Updated:** 21 November 2026  
**Plan:** [Phase 2 build plan](phase-2-build-plan.md) · **Report:** [Phase 2 report](phase-2-report.md)

Staging: https://airstock.deletecookies.dev (see [staging.md](staging.md)). Every merge to `main` migrates and deploys it. Large seeds and timings run in the separate bench project (Section 4), never on staging.

## 1. Milestones

| Milestone | State | Notes |
| --- | --- | --- |
| I0 Groundwork | Done | Bench seeds and baseline timings (PR #48, [measurements](phase-2-measurements.md)). Originals shrink to 2,048 px, re-consent revokes earlier connections, and the ChatGPT harness (PR #46). Research (Section 5). The bench seed found a crash in the catalog grid on names outside Latin-1 ("ș", "€"); fixed in PR #50. |
| I1 Stock engine | Done | Schema, receipts, reservations, fulfillment, allocation rules, bundles, shortages, and valuation (PRs #45, #49). One-of-a-kind items, quick add, starter families for cards and sets, and the dashboard stock panel (PR #51). The scheduled stock check with a reviewed repair (PR #55, Settings › Stock check). |
| I2 Transfers, returns, counts | Done | Transfers with holds, transit, exceptions, and one-command moves (PR #57, [ADR 0028](adr/0028-transfers.md)); returns with quarantine and inspection, serial checks, and one-of-a-kind items back in stock (PR #63, [ADR 0029](adr/0029-returns.md)); count sessions, quick counts, adjustments with reasons, condition changes, and reversals (PR #64, [ADR 0031](adr/0031-counts-and-adjustments.md)). |
| I3 Purchasing and alerts | Done | Purchase orders (PR #59, [ADR 0027](adr/0027-purchase-orders.md)): PDF, email, receipts against lines, on order. Reorder rules, draft from low stock, and alerts in the app, by email, webhooks, and MCP (PR #62, [ADR 0030](adr/0030-reorder-rules-and-alerts.md)). |
| I4 Scanning and picking | Done | The scanner at `/app/scan` and the installed app (PR #54, [ADR 0025](adr/0025-scanning-and-installed-app.md)); look up, receive, and unknown codes (PR #58); pick lists on the phone and as PDF (PR #60, [ADR 0026](adr/0026-picking.md)). Count, move, receive against a PO, quick add with pictures, and short pick to count (PR #69, ADR 0025 update). |
| I5 Webhooks, activity, reports | Done for January | Webhooks (PR #47, [ADR 0023](adr/0023-outgoing-webhooks.md), [webhooks.md](webhooks.md)). Activity views with the PRD 7.4 filters, location-scoped history, lifecycle, ingestion delay, and export; a shop-first audit key with no default partition, so a two-filter search over 1 million events is 9 ms p95 warm and 534 ms cold (PR #52, [ADR 0032](adr/0032-activity-views.md), [measurements](phase-2-measurements.md)). The eight standard reports with filters, saved reports, CSV export, and `run_report` (PR #71, [ADR 0034](adr/0034-reports.md)). Scheduled report emails come after January. |
| I6 Shopify connector | Done | Mapping and onboarding (PR #67, [ADR 0033](adr/0033-shopify-mapping-and-onboarding.md)); the order flow with shortages, edits, cancellations, fulfillments, and refunds into returns (PR #70, [ADR 0035](adr/0035-shopify-order-lifecycle.md)); batched compare-and-set push and the reconciler (PR #74, [ADR 0036](adr/0036-shopify-push-and-reconciler.md)); sync health and `shopify_sync` (PR #76, [ADR 0037](adr/0037-shopify-sync-health.md)); listings in both directions with per-field ownership (PR #79, [ADR 0038](adr/0038-shopify-listings.md)). The staging app's configuration is in `config/shopify/shopify.app.staging.toml`. An independent review of the connector is in progress. |
| I7 MVP gate | Waiting for the owner | Everything the build can do is done ([report](phase-2-report.md)): 13 of 18 exit criteria with evidence, G18 partly, and G11, G14, G15, and G16 waiting for the owner's runs. The two reviews (35 defects) are fixed, the volume run and its fixes are merged, and the ChatGPT run is prepared (Section 6). On 21 November the report's test gaps were closed and three defects they found were fixed (PRs #97, #98). Left: the owner's checks (Section 2) and the production decision (Section 2.2). |
| I8 Pilot go-live | Not started | |
| I9 After January | Not started | |

**Night of 16 November:** every agent stopped at the account's 5-hour usage limit at about 03:20 UTC. Only pushed work survived: the stock engine's third part, the webhooks, and most of the activity views. The three milestones that had just started lost nothing, because they had not written code yet. Each agent now pushes within its first 30 minutes.

**16 November, 09:10–12:10 UTC:** the usage limit stopped the agents a second time. The Shopify order-flow work was saved from its checkout. Since then, at most three agents run at once, so fewer are cut off mid-task.

**CI fix, 16 November:** a documentation-only merge skipped the staging deploy, so when it cancelled a code merge's run, that code never reached staging (the review fixes in #78). Since PR #83, every merge to `main` builds, tests, and deploys. Staging's Hyperdrive connection limit is 20 (was 60), after 10 parallel callers ran its 0.25 CU database out of memory in the volume run.

## 2. Owner steps

| When | Step | State |
| --- | --- | --- |
| I0 | Create the `airstock-bench` Neon project and a project-scoped API key | Done, 16 November |
| I4, now | Scan on the iPhone in Safari and as an installed app, close up and in dim light, including a graded-card slab label: the script in Section 2.1 | **Ready** |
| I5, now | Give an n8n webhook URL and set up a subscription in the dashboard (Integrations → Webhooks); [webhooks.md](webhooks.md) has the n8n signature check | **Ready** |
| I6, now | **Reconnect both Shopify development stores**, so they grant the new permissions: in staging, open each shop → Settings → Integrations → "Connect another store", enter `airstock-dev-a.myshopify.com` (and `airstock-dev-b.myshopify.com` in its shop), and approve in Shopify. Optionally, on `airstock-dev-a`, order `AIR-MUG-01` with the test gateway, fulfill it, then refund with restock: sync health should show no conflicts and the unit should be in quarantine | **Ready** |
| I6, now | Give the store's Shopify product export, for the rehearsal on a development store | **Ready** |
| I7 | Decide production: the brief and recommendations are in Section 2.2 | **Ready to decide** |
| I7 | The ChatGPT run (Section 6): create the shop "ChatGPT run 2" and an API credential, then run the prompts | **Ready (shop first)** |

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
10. **Count after a short pick.** After the **Short…** in step 9, tap **Count that shelf**. Count should open on that shelf with the item listed at 0 and the missing quantity in the yellow note. Scan the units that are really there, check the quantity, and tap **Confirm count**. If the count leaves fewer units than are reserved, choose **Release** or **Move to other stock** for the order, then **Apply with these choices**.
11. **Quick count.** In **Count**, scan another shelf's label, then each item on it. Scan a case label once: the line should read "1 × Case (…)". Type a number into one line. Check the list under the lines, then tap **Confirm count**.
12. **Count session.**
    - Tap **Count session**, then **New count of …** for the current shelf.
    - Scan an item, tap **Record**, and tap **None here** on a line that is not on the shelf.
    - On the laptop, receive one more unit of the recorded item onto that shelf.
    - On the phone, the line should show under **Moved since counted**. Choose **Keep my count** or **Add the movements**, then **Submit count**.
13. **Move.** In **Move**, scan a shelf's label, scan an item twice, then scan another shelf's label in the same warehouse. The button should read "Move 2 units to …". Tap it, then check both shelves in **Look up**.
14. **Receive a purchase order.**
    - On the laptop, send a purchase order for an item (Purchasing, **Mark as sent** is enough).
    - On the phone, open **Receive**, tap **Purchase order**, scan the shelf's label, and choose the order. You can also type its number, such as PO-0001.
    - Scan the item. The line should show ordered, received, and open.
    - Scan it until it is more than is open. **Receive** should stay greyed out until you tick the over-receipt box.
15. **Quick add a graded card.** In the installed app from step 8:
    - Open **Quick add** and scan a shelf's label.
    - Tap **Take picture**: the camera should open. Take one or two pictures. If only the photo library opens, note it, and use **From library**.
    - Scan the slab's certificate barcode, or type the number. Choose **Trading cards**, fill condition, grading company, grade, name, and price, and tap **Add 1 unit**.
    - The pictures should show **Linked**.
    - When you go back to the scanner, the camera should come back by itself.
    - Scan the slab in **Look up**: it should show as one of a kind, with one unit on that shelf.
    - **List on Shopify** stays greyed out until the Shopify connector is ready.
16. **Unknown code to quick add.** In **Look up**, scan a new slab. Tap **Quick add as a one-of-a-kind item**. The certificate field should already hold the code.

Note anything that fails, and at which step.

### 2.2 Production decision (I7)

The pilot needs a production environment separate from staging. These are the choices, with a recommendation each. Nothing is created or paid for until the owner decides. Costs are monthly, on top of the Workers Paid plan already paid for ($5).

| Decision | Recommendation | Cost | Why |
| --- | --- | --- | --- |
| Web address | A subdomain the owner already has, such as `app.airstock.deletecookies.dev`, until the product name is chosen (PRD 17) | $0 | Moving later means reconnecting the Shopify app, the ChatGPT connector, and the WorkOS redirect: about an hour, no data change |
| Database | A new Neon project on the **Launch** plan in Frankfurt; autoscaling 0.5–2 CU, scaling to zero after 5 minutes; 7 days of restore history | about $10 | Free keeps 6 hours of restore history; the volume run ran a 0.25 CU compute out of memory under 10 parallel callers (Section 1, CI fix note) |
| Sign-in | A WorkOS production environment | $0 up to 1 million users | WorkOS asks for billing details for production |
| Email | Keep sending from `mail.tracker.deletecookies.dev` while the owner is the only merchant; Resend Pro, or a freed domain slot, before a second merchant | $0 now, $20 later | Alerts and PO emails go to the owner's own addresses; Resend stores email data in the US (PRD 12.4), acceptable while the data is the owner's |
| Shopify | A new custom-distribution app for the owner's store, configured like `config/shopify/shopify.app.staging.toml` | $0 | Custom apps get protected customer data without a review (Section 5.2); custom distribution is one store and can't be changed, so staging keeps its own app |
| Cloudflare | A production Worker, Hyperdrive (connection limit 20), an EU R2 bucket, and queues, on the existing account | within Workers Paid | Same shape as staging |

**Expected total:** about $10–15 a month beyond Workers Paid while the owner is the only merchant; $20 more with Resend Pro.

**Before real data:** a restore test (A22) on the production database, then the onboarding rehearsal on production with the owner's export.

## 3. Decisions

ADRs are numbered when they merge. This table links each decision as it lands.

| ID | Decision | Record |
| --- | --- | --- |
| D1–D4 | Stock model, conditions, lots, serials, allocation rule | [ADR 0020](adr/0020-stock-model.md) |
| D5 | One-of-a-kind items, both ways | [ADR 0024](adr/0024-one-of-a-kind-items.md) |
| D6 | Shortages | [ADR 0021](adr/0021-shortages.md) |
| D7 | Valuation | [ADR 0022](adr/0022-valuation.md) |
| D8 | Transfers | [ADR 0028](adr/0028-transfers.md) |
| D9 | Returns | [ADR 0029](adr/0029-returns.md) |
| D10 | Counts and adjustments | [ADR 0031](adr/0031-counts-and-adjustments.md) |
| D11 | Purchase orders: per-line quantities, receipts at the line cost, PDF in the Worker, send log | [ADR 0027](adr/0027-purchase-orders.md) |
| D12 | Alerts: checked in the stock transaction, one open alert per rule, notified through the outbox | [ADR 0030](adr/0030-reorder-rules-and-alerts.md) |
| D13 | Scanning in the app, installed app; picking | [ADR 0025](adr/0025-scanning-and-installed-app.md), [ADR 0026](adr/0026-picking.md) |
| D14 | Webhooks: registry of event types, per-shop subscriptions, signed deliveries with retries | [ADR 0023](adr/0023-outgoing-webhooks.md), [docs/webhooks.md](webhooks.md) |
| D15 | Activity views | [ADR 0032](adr/0032-activity-views.md) |
| D16 | MCP tools: measured tool choice, not a count; server instructions route by task (PR #66) | [ADR 0005, update](adr/0005-operation-registry.md) and Section 5.1 |
| D18 | Reconciliation | [ADR 0020, update](adr/0020-stock-model.md) |
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

## 6. ChatGPT run (I7)

The Phase 2 run checks that ChatGPT picks the right tool and action for the new stock work (plan Section 7.4, G16). It runs on a new staging shop, "ChatGPT run 2". The lead fills the shop through the API with `scripts/chatgpt-run-shop.ts`, using only an API credential of that shop, and reads the results back through the activity API. The prompts and their expected calls are in [docs/chatgpt-runs/phase-2.json](chatgpt-runs/phase-2.json).

### 6.1 Before the run (owner)

1. **Create the shop.** In staging, on the Shops page, use **Create a shop**: name "ChatGPT run 2", currency EUR, and your own time zone.
2. **Create an API credential.** In that shop, open Integrations → API credentials. Under **Create a credential**, name it "ChatGPT run", tick every box under Access, and tap **Create credential**. The token is shown once; keep the page open.
3. **Tell the lead in chat** that the shop is ready. Don't paste the token in chat: the lead asks for it through a secure field. The shop's ID is in the address bar (`/app/shops/<ID>/…`); paste that in chat.

The lead then fills the shop in two steps, a few minutes apart, so the stock value at a moment between them differs from the value now (prompt 8):

```sh
AIRSTOCK_TOKEN=<credential> pnpm chatgpt-run:shop --shop <shop ID> --phase opening
# two minutes or more later
AIRSTOCK_TOKEN=<credential> pnpm chatgpt-run:shop --shop <shop ID> --phase later
```

What the shop holds afterwards:
- **Catalog:** four sealed Pokémon TCG products, with cases (and a pallet of booster-box cases); four LEGO sets in the Building sets family; three graded cards added as one-of-a-kind items; three foods tracked by lot and expiry.
- **Warehouse:** "Main warehouse" with Receiving, shelf A1, and shelf B2.
- **Suppliers:** Nordwind TCG Distribution, Brickhouse Wholesale, and Fresh Fuel Foods, each with supplier SKUs and costs.
- **Stock and costs:** opening stock at older costs, then newer deliveries at higher costs, and a move of 6 booster boxes to B2.
- **Orders:** 1001 to 1003 fulfilled; 1004 and 1005 reserved and waiting to be picked.
- **Reorder rules:** three items end up at or below their reorder point.

The later step prints the moment for prompt 8, such as "17 Nov, 14:05", with the values then and now. The lead gives that moment to the owner with the go-ahead.

### 6.2 Connect ChatGPT

1. In ChatGPT, reconnect the Airstock connector (or remove it and add it again): https://airstock.deletecookies.dev/mcp.
2. On the consent page, choose "ChatGPT run 2" and tick every box. The earlier ChatGPT connection is revoked on the new one's first call (D20).
3. Start a new chat. ChatGPT asks before each change; approve it.

### 6.3 The prompts

Ask in one chat, in this order. "Expected" is what a correct answer says. The numbers come from the lead's local run of the same steps; they hold if each earlier prompt did what it asked.

| # | Prompt | Expected |
| --- | --- | --- |
| 1 | How many Surging Sparks booster boxes do I have, and how many are reserved? | 16 on hand: 10 on A1 and 6 on B2. 2 are reserved, for order 1005, so 14 are available. |
| 2 | Receive 3 cases of 6 Surging Sparks booster boxes from Nordwind TCG Distribution onto shelf A1, at 95 euros a box. | 18 boxes received onto A1 at €95 each, so A1 holds 28. The average cost goes from €90.67 to €92.96. |
| 3 | Move 2 Prismatic Evolutions Elite Trainer Boxes from shelf A1 to B2. | A1 keeps 3, B2 has 2. |
| 4 | What's running low? Draft purchase orders for it. | Three items: Pikachu ex Box (1 available, reorder point 4), Prismatic Evolutions Elite Trainer Box (5, point 6), and Protein Shake Chocolate (20, point 24). ChatGPT shows the proposal and asks first; answer "Yes, draft them". Two draft orders: Fresh Fuel Foods, 4 trays of 12 shakes, €93.60; Nordwind TCG Distribution, a case of 12 Pikachu ex Boxes (€174) and a case of 10 Elite Trainer Boxes (€540), €714. |
| 5 | Which food lots expire in the next 30 days, and which orders got lot L-2311? | Granola L-2309 (6 units, expires 2 December, sellable until 27 November) and Protein Shake L-2311 (8 units, expires 10 December). Lot L-2311 went to order 1003, 4 units. After 21 December, protein bar lot L-2315 (20 January) is inside the 30 days too. |
| 6 | I counted shelf B2: 4 of LEGO-10316 and none of LEGO-42143. | Rivendell 5 → 4 and Daytona 1 → 0 on B2, recorded as count corrections. |
| 7 | Order 1001's LEGO set came back damaged. | A return for order 1001: 1 LEGO Millennium Falcon (75192), reason damaged. Stock doesn't change until the return is received. |
| 8 | What is my stock worth now, and what was it worth at *the moment the lead gave*? | Now €8,649.17: the value the later step printed (€7,634.17), plus the €1,710 received in prompt 2, minus the €695 counted out in prompt 6. At the moment: €7,415.20, the opening stock. |
| 9 | Add a PSA 10 Charizard, Base Set 4/102, certificate 12345678, priced at 450 euros, on shelf A1. | A one-of-a-kind Charizard in the Trading cards family, one unit on A1, €450. With no cost given, its value is unknown; ChatGPT may ask for one. |
| 10 | Make a pick list for the open orders in the main warehouse. | Pick list 1 from orders 1004 and 1005: Galaxy Explorer × 1 and Pikachu ex Box × 2 on A1, Surging Sparks booster box × 2 on B2. |
| 11 | On pick list 1, the picker found only 1 of the 2 Pikachu ex Boxes on shelf A1. Record that. | The Pikachu line is short: 1 picked, 1 missing. Airstock suggests counting A1. |
| 12 | Someone scanned 84731629 in the warehouse. Which item is that and where is it? | The Umbreon VMAX 215/203 Evolving Skies PSA 10 slab: one of a kind, 1 unit on shelf A1. |
| 13 | *Optional:* Are there any Shopify sync problems? | The development store's sync health: last sync and push, pending pushes, conflicts, unmapped items. |
| 14 | *Optional:* List the Charizard on Shopify as a draft. | The Charizard appears in the development store as a draft product at €450. |

**Prompts 13 and 14** need a Shopify development store connected to "ChatGPT run 2" (Integrations → Shopify → Connect a Shopify store). A store connected to another staging shop must be disconnected there first; reconnect it to its own shop afterwards. Without a store, skip both; the lead's table lists them as skipped.

**Prompt 15, read-only:**
1. In ChatGPT, reconnect Airstock again. On the consent page, choose "ChatGPT run 2" and tick only the read boxes: "See the shop and your role", "Read items and variants", "Read warehouses and locations", "Read stock and availability", and "Read the activity history".
2. In a new chat, ask: "Set PKM-PRE-ETB on shelf A1 to zero."
3. **Expected:** refused, because the connection lacks `inventory:write` (A15). A1 still holds 3 Elite Trainer Boxes. ChatGPT may also decline without calling Airstock; that counts as right.

### 6.4 After the run

The owner says "done" in chat. The lead runs the harness with the same credential; it reads the MCP calls from the shop's activity history, prints one row per call, and marks each prompt right or wrong:

```sh
AIRSTOCK_TOKEN=<credential> pnpm chatgpt-run --shop <shop ID> --from <ISO time before the first prompt> \
  --expect docs/chatgpt-runs/phase-2.json --out <file>.md
```

- Calls are split into prompts where ChatGPT paused 8 seconds or more (`--gap`). If a split is off, give that prompt an `at` time in a copy of the expected file.
- In this API mode, a read shows the record it was about rather than its full input, and a refusal shows its code. `--db` with `DATABASE_OWNER_URL` shows the full arguments.
- The lead records the table and the verdicts below. Afterwards, revoke the credential (Integrations → API credentials).

### 6.5 Dry runs

Both runs are made without staging and without ChatGPT: a plain MCP client makes each prompt's expected calls.
- `apps/worker/test/chatgpt-run.test.ts` runs the whole chain in the Worker tests on every CI run: the seed script through the REST API, the calls through MCP, and the harness through the activity API. It checks the API mode lists the same calls as the database mode, and that the expected file marks 13 of 13 prompts right, with 13 and 14 skipped.
- A local run on 16 November went through `wrangler dev` over HTTP, the same way as on staging:
  - the seed script's two steps, two minutes apart, with an API credential of the shop;
  - the prompts' calls from an MCP client signed in as two consented connections, 12 seconds apart;
  - the harness in API mode with the same credential, splitting prompts by the pauses alone.

  The later step printed €7,415.20 at the moment and €7,634.17 after it. The harness listed 38 calls on two connections and marked **13 of 13 prompts right**, with 13 and 14 skipped. Every answer matched the Expected column above.

### 6.6 Result

Not run yet.

## 7. Bench and staging data

| Where | Data | Purpose |
| --- | --- | --- |
| Bench project | Six "Bench" persona shops on branch `i0-personas`. The 1-million-event history branch `i0-baseline` was deleted on 16 November after the activity timings, to keep the project under its 1 GB limit (all branches count); `scripts/bench/seed-history.ts` recreates it in about 80 s | Timings; see [measurements](phase-2-measurements.md) |
| Staging | As listed in [Phase 1 status](phase-1-status.md), Section 4 | Unchanged by Phase 2 seeds |
