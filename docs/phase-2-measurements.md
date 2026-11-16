# Phase 2 measurements

**Plan:** [Phase 2 build plan](phase-2-build-plan.md), Sections 7.2, 7.3, and 8  
**Where:** the `airstock-bench` Neon project ([status, Section 4](phase-2-status.md#4-bench-project)), never staging

Each milestone adds its section here: what was seeded, the sizes, and the timings, with the commands to run them again. The Phase 2 report draws on this file.

## I0 baseline (bench project)

**When:** 16 November 2026.  
**Database:** Neon `airstock-bench`, Frankfurt, PostgreSQL 17, free plan, compute autoscaling between 0.25 and 2 CU. Schema at migration 0015 and product code as at the end of Phase 1, before milestone I1's stock engine (migration 0017). No new indexes.  
**Client:** a laptop in Europe. One round trip to the database takes about 15 ms, so the tables give the server's time separately from the client's.

### Seed

`scripts/bench/seed-personas.ts` writes the six shops of plan Section 7.2. Each catalog is made up in its persona's style, and no product is a real brand's. Every EAN uses the restricted-circulation prefix 2, which no real product carries.

Values go through the product's own encoders for fields, barcodes, packs, and SKUs. Rows are written in batches as the database owner, as in Phase 1. Opening stock follows the import's receipt path: per variant and location, one operation, one position, one ledger entry with its unit cost, and one completed idempotency record. On a schema with I1's stock engine (migration 0017), the seed also writes the moving-average cost and its history, as `apply_stock_cost` does for a receipt with a cost. The seed was checked on that schema: I1's `stock_reconciliation_problems()` finds nothing. The ledger reconciles with the balances (0 mismatches). A read-back through the product's own read operations succeeds for every shop except one grid query, which fails because of a product bug (see [Findings](#findings)).

| Shop | Persona | Variants | Products | Packs | Barcodes | Supplier items | Bundles | Locations | Positions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bench Cards and Bricks | Owner's store: sealed trading-card products (packs in boxes in cases), building sets, and 1,000 items of quantity 1 (single and graded cards, used sets) | 1,254 | 1,232 | 224 | 1,352 | 254 | 0 | 119 | 1,236 |
| Bench Stride Sportswear | Sports clothing in sizes and colours, outfit sets, two warehouses | 4,014 | 251 | 3,774 | 4,014 | 3,774 | 240 | 269 | 4,443 |
| Bench Fuel Kitchen | Drinkable meals, bars, and powders in 6-packs, 12-packs, and cases | 300 | 77 | 625 | 925 | 300 | 0 | 110 | 300 |
| Bench Lumen Skin | Skincare, make-up shades, gift sets | 2,000 | 405 | 3,534 | 5,534 | 1,960 | 40 | 158 | 1,932 |
| Bench Partline Supply | Spare parts with manufacturer numbers and "replaces" relations (2,383), 400 bins, two warehouses, minimum order quantities | 20,000 | 17,828 | 7,915 | 20,000 | 26,011 | 0 | 534 | 16,990 |
| Bench Maison Verre | Clothes, glasses, bags, watches, jewellery; warehouse, store, and third-party fulfilment | 4,001 | 446 | 0 | 4,001 | 3,951 | 50 | 174 | 5,879 |
| **Total** | | **31,569** | **20,239** | **16,072** | **35,826** | **36,250** | **330** | **1,364** | **30,780** |

Each shop also has:
- custom fields and families that fit the persona: 11 to 19 fields besides brand and category, and 3 to 11 families;
- suppliers;
- six members, one of them a picker limited to one warehouse where the shop has several;
- an API credential and a ChatGPT connection.

The whole seed took 29 s.

**Not seeded yet:**
- **Lots, expiry dates, serials, and one-of-a-kind settings.** Milestone I1 adds them. `personas.ts` marks the places with "I1:": food and cosmetics lots (3,000 and 2,000), serials on about 10% of spare parts and on watches, and one-of-a-kind cards, used sets, and jewellery.
- **Three months of stock operations in the ledger** (about 300 a day per shop). Today's commands are receipt, reservation, and release only, so this waits for I1's fulfillment, transfer, and count commands. The history below already contains them as events.
- **Media.**

### History

`scripts/bench/seed-history.ts` writes 1,000,000 audit events across the six shops, from 17 August to 16 November 2026: 91 days in four monthly partitions. August and September were created with the names `ensure_audit_partitions` uses. Events use the real envelope (`auditEvent`) and go in through `ingest_audit_events`, the function the queue consumer calls, in time order, 5,000 per call. The load took 78 s.

The history is made of activities rather than single events:
- dashboard sessions: grid queries, item views, edits with one change event per record, and client-reported interface events with their batch event;
- phone scanning with receipts;
- ChatGPT conversations through the MCP connection;
- Shopify orders with a reservation per line, some cancelled later;
- API syncs from n8n or an ERP;
- catalog work: bulk edits, supplier items, barcodes, pictures, new items, and exports;
- the expiry sweep, and activity reviews.

Real callers also fail, so the history has validation failures, denials, stock and version conflicts, and replays. Each shop starts with its setup and the catalog import, one event per product, variant, and opening receipt, as the import job writes them. Weekdays are busier than weekends, people work office hours, integrations run around the clock, and activity grows by half over the three months.

| Shop | Events | Reads | Attempts | Failed, denied, or conflict | Stock commands a day |
| --- | --- | --- | --- | --- | --- |
| Bench Cards and Bricks | 150,000 | 56% | 16% | 0.8% | 247 |
| Bench Stride Sportswear | 180,000 | 54% | 16% | 0.8% | 293 |
| Bench Fuel Kitchen | 120,000 | 56% | 17% | 0.8% | 199 |
| Bench Lumen Skin | 150,000 | 54% | 17% | 0.8% | 247 |
| Bench Partline Supply | 250,000 | 52% | 11% | 0.5% | 264 |
| Bench Maison Verre | 150,000 | 52% | 16% | 0.7% | 234 |
| **Total** | **1,000,000** | **54%** | **15%** | **0.7%** | **about 250** |

- **Reads** include client-reported events (9.5% of all).
- **Stock commands** are receipts, reservations, releases, and expiries. That is close to the plan's 300 a day.
- **By source:** dashboard 58.5%, Shopify 13.4%, API 13.2%, import 8.4%, MCP 6.0%, scheduled 0.5%.
- **Locations:** a third of the events name locations.
- **Targets:** events point at the shops' real variants, products, locations, and members. Operation and reservation IDs after the import are made up, because the ledger holds only the opening stock.

### Sizes and the two reset points

Sizes are from PostgreSQL, after `VACUUM ANALYZE`. The persona seed and the history together come to about 850 MB: 183 MB plus 667 MB, or about 870 MB as Neon counts it. That is over the 850 MB line set for the free plan, so the run followed plan risk R3:
1. Seed the personas, run the catalog timings, and keep that state as the branch `i0-personas`.
2. On `production`, empty the stock tables, which the activity queries do not read: `inventory_entries`, `reservation_allocations`, `reservations`, `inventory_positions`, `inventory_operations`, and `idempotency_records`.
3. Write the history from a context file taken before step 2, so its events still name the opening receipts and positions.
4. Run the activity timings and keep that state as the branch `i0-baseline`.

Both branches hold the same shops, variants, and locations with the same IDs.

| | `i0-personas` | `i0-baseline` |
| --- | --- | --- |
| Holds | Catalog, opening stock | Catalog, 1,000,000 events, stock tables empty |
| Database size | 182.5 MB | 797.6 MB |
| Catalog tables | 119.0 MB | 119.0 MB |
| Stock tables | 52.1 MB | 0.1 MB |
| History (`audit_events`) | 0.2 MB | 666.5 MB |
| Cluster size, which the 1 GB limit applies to | 204.9 MB (Neon) | 819.4 MB (PostgreSQL) |

Neon counts the whole cluster: the `postgres`, `template0`, and `template1` databases add 21 MB to `neondb`. That is the gap between 204.9 MB and 182.5 MB. Neon's API lags behind the database. It reported `i0-personas` within minutes, but had not yet recomputed the production branch or the project's synthetic storage size when this was written. For `i0-baseline`, `sizes.ts` sums every database in the cluster itself: 819.4 MB, under the 850 MB line and the 1 GB limit. No further writes are planned on it.

**Per record:**

| Item | Size |
| --- | --- |
| Variant: catalog only (product share, options, packs, barcodes, supplier items, relations, all indexes) | 3.95 KB |
| Variant: with its opening stock | 5.7 KB |
| Opening receipt: operation, position, ledger entry, idempotency record | 1.8 KB, of which the idempotency record is 0.75 KB |
| Audit event | 699 bytes: 411 heap and 288 in four indexes (target 124, shop and time 105, primary key 41, attempt 19) |
| A full month of history (September, October) | 186–218 MB for the six shops: 31–36 MB a shop |

- **Variants:** 3.95 KB is more than Phase 1's 2.3 KB. These catalogs carry packs, barcodes, and supplier items on almost every variant, and the spare-parts shop has nearly one product per variant.
- **Audit events:** 699 bytes is close to Phase 0's 732.
- **Import receipts:** the idempotency record from an import is worth a look in I1. It is 40% of an opening receipt and is never read again once the import has finished.

### Catalog queries (the Phase 1 F12 shapes, on the persona shops)

`scripts/bench/query-catalog.ts` now uses each shop's own fields for each shape: its select, measurement, range, multi-select, and decimal fields. Setup: 48 runs per shape, eight per shop, on `i0-personas`, through `catalog.items.query` in process. The client time includes six round trips of about 15 ms each. The server time subtracts them, which makes it comparable to Phase 1's "database p95", measured inside the Worker.

| Query (50 rows) | Client p50 | Client p95 | Server p50 | Server p95 | Slowest shop's p95 (spare parts, 20,000 variants) | Phase 1 database p95 (10,000 variants) |
| --- | --- | --- | --- | --- | --- | --- |
| List, default sort | 106 ms | 162 ms | 12 ms | 68 ms | 73 ms | 133 ms |
| Sort by price, descending | 101 ms | 158 ms | 7 ms | 64 ms | 75 ms | 115 ms |
| Search words | 109 ms | 371 ms | 15 ms | 277 ms | 285 ms | 163 ms |
| Search an exact SKU | 104 ms | 380 ms | 10 ms | 286 ms | 295 ms | 147 ms |
| Select filter, measurement sort | 107 ms | 195 ms | 12 ms | 100 ms | 107 ms | 126 ms |
| Range and multi-select filters, decimal sort, 4 values | 98 ms | 137 ms | 5 ms | 43 ms | 59 ms | 114 ms |
| Products mode, filter on a variant field | 86 ms | 132 ms | 7 ms | 53 ms | 68 ms | 107 ms |
| In stock, with availability | 149 ms | 364 ms | 55 ms | 270 ms | 280 ms | 354 ms |

- **Within target:** every shape is well under the 1-second target.
- **The spare-parts shop sets the p95.** Every other shop is under 80 ms in every shape.
- **Search grows with the catalog:** about 0.3 s at 20,000 variants and 18,000 products. That is not yet a problem.
- **The owner's shop fails two shapes:** default sort and in-stock failed in all eight runs (500, first finding below).
- **Caches were warm.** The run followed the seed.
- **I1 has since changed the in-stock shape.** It now reads the shared `stock_positions` function, so I1's own bench run replaces that row.

### Activity search

`scripts/bench/query-activity.ts` runs 20 shapes, each 36 times: six runs per shop, with members, targets, attempts, warehouses, and dates drawn from each shop's own history. Every query runs as `airstock_app` in a read-only transaction, with row-level security, as in the product. The shapes:
- the six `activity.list` shapes, through the operation itself;
- 14 PRD 7.4 filter shapes as the SQL I5 will need: newest first, 50 rows.

The server time is planning plus execution, from `EXPLAIN (ANALYZE, TIMING OFF)` run right after the query itself. Each `activity.list` call costs six round trips from the laptop (the membership lookup and the query), and each filter query three.

| Shape | Server p50 | Server p95 | Server max | Client p95 | Client, first run after a suspend |
| --- | --- | --- | --- | --- | --- |
| `activity.list`: timeline, first page | 1 ms | 1 ms | 4 ms | 97 ms | 193 ms |
| `activity.list`: a later page (cursor anywhere in 3 months) | 1 ms | 1 ms | 1 ms | 95 ms | 111 ms |
| `activity.list`: one variant's history | 1 ms | 1 ms | 1 ms | 108 ms | 112 ms |
| `activity.list`: one product's history | 1 ms | 1 ms | 1 ms | 105 ms | 134 ms |
| `activity.list`: one attempt | 1 ms | 1 ms | 1 ms | 100 ms | 116 ms |
| `activity.list`: member limited to one warehouse | 1 ms | 1 ms | 2 ms | 103 ms | 103 ms |
| Actor: one member | 2 ms | 3 ms | 3 ms | 56 ms | 787 ms |
| Action: receipts | 2 ms | 3 ms | 3 ms | 56 ms | 52 ms |
| Action group: `inventory.*` | 1 ms | 1 ms | 1 ms | 55 ms | 46 ms |
| Date: one week, a month ago | 0 ms | 0 ms | 1 ms | 56 ms | 51 ms |
| Outcome: failed, denied, or conflict (0.7% of events) | 11 ms | 14 ms | 14 ms | 66 ms | **2,167 ms** |
| Source: MCP | 2 ms | 3 ms | 3 ms | 58 ms | 50 ms |
| Integration: one ChatGPT connection | 51 ms | 75 ms | 106 ms | 208 ms | **1,640 ms** |
| Warehouse, through the location tree | 2 ms | 3 ms | 3 ms | 55 ms | 52 ms |
| Batch: the catalog import (`external_ref`) | 404 ms | 435 ms | 445 ms | 512 ms | **8,527 ms** |
| Member, last 7 days | 1 ms | 5 ms | 6 ms | 59 ms | 49 ms |
| Receipts in one warehouse | 2 ms | 12 ms | 13 ms | 58 ms | 54 ms |
| MCP calls that failed or were denied | 61 ms | 104 ms | 114 ms | 196 ms | 499 ms |
| Reservations in one week, two months ago | 1 ms | 6 ms | 7 ms | 53 ms | 49 ms |
| Shopify reservations in the last 30 days | 1 ms | 83 ms | 84 ms | 128 ms | 169 ms |

The last column is a second run of six per shape, right after the compute was suspended through the Neon API. The compute restarts with an empty cache, so the first query reads its pages from Neon's storage. The client time includes about 50 ms of network.

**What it shows:**

- **Today's `activity.list` is fast at this volume, cold or warm.** Every shape takes about 1 ms at the server, because it follows `audit_events_shop_time_idx` or the target index and stops after 51 rows. Even the first run after a suspend stays under 200 ms at the client. The client's 100 ms is round trips from the laptop; in the Worker it would be about 6 × 5 ms.
- **The plan's target, two filters under 1 s, holds while the cache is warm.** The worst p95 is 435 ms. It does not hold cold: three shapes took 1.6–8.5 s on their first run.
- **Common filters are fast.** A filter that matches more than a few percent of a shop's events (one member, receipts, MCP, a warehouse, a date range) finds 50 rows quickly by walking the shop's time index backwards.
- **Rare filters, and filters with no match, are the problem.** The slow plans, in short:
  - **Batch** (`external_ref`), and **Shopify reservations** in a shop without Shopify: the planner walks the primary key `(occurred_at, event_id)` backwards. That key has no `shop_id`, so it reads **every shop's** events in the time range: 961,000 rows for the batch (nearly the whole table), read through 105,000 buffers (45,000 from storage), and 341,000 rows for the Shopify filter. The cost grows with all events in the database, not with the shop's. On a shared production database with 1,000 shops it would be hundreds of times larger.
  - **One integration** and **MCP failures**: a bitmap scan reads every event of the shop from all four partitions, filters out 99%, and sorts the rest: 27,000 buffers.
  - **Rare outcomes**: the primary-key walk again, through 53,000 rows of all shops. It finds 50 matches quickly only because failures are spread evenly over time.

### What I5 is likely to need

Each index the filters need starts with `shop_id` and ends with `occurred_at desc, event_id desc`. The query can then stop after 51 rows, and the planner never has a reason to walk the global primary key. In order of value:

1. **Actor:** `(shop_id, actor_id, occurred_at desc, event_id desc)`. It serves members, API credentials, ChatGPT connections, and connectors: the actor and integration filters. `actor_type` stays a filter.
2. **Problems:** a partial index `(shop_id, occurred_at desc, event_id desc) where outcome not in ('succeeded', 'received')`. That is under 1% of rows, so about 1 byte per event.
3. **Action:** `(shop_id, action, occurred_at desc, event_id desc)`. An action group should expand to its list of actions from the registry rather than use `like`.
4. **Batch:** a partial index `(shop_id, external_ref, occurred_at desc) where external_ref is not null`. That covers 13.5% of events (imports, purchase orders, Shopify orders); bulk edits are already reachable through their attempt.
5. **Source and warehouse:** fine at this mix, because MCP is 6% of events and a third of events name locations. Measure them in I5 with a small warehouse and a rare source before adding anything. The candidates are `(shop_id, source, occurred_at desc)`, and a GIN index on `location_ids` with the warehouse expanded to its locations.

**Storage cost.** Each full index costs about as much as the existing ones: 105–124 bytes per event, or 15–18% of history storage. Actor and action together would take an event from 699 to about 930 bytes, so I5 should pay for them where the existing indexes waste space:
- The target index (124 bytes per event, the largest) also indexes the 33% of events with no target or a generic one (`list`, `primary`, `batch`). A partial index on record targets saves about 40 bytes per event.
- The attempt index holds the 57% of events without an attempt. A partial `where attempt_id is not null` saves about 10.
- Cold reads, not warm ones, break the target. Once the indexes above exist, the cold cost of each filter should be measured again. A history view probably needs to show something useful within a second even when Neon has just woken up.

### Findings

- **Catalog grid queries fail on names outside Latin-1 (product bug).** `encodeCursor` in `packages/core/src/catalog/query.ts` passes the last row's sort value to `btoa`. That throws for any character beyond Latin-1, such as "—", "ș", "ă", "€", or Japanese text, and the query answers 500 whenever such a name ends a page. In the bench, every default-sorted query on the owner's shop failed: its names contain "—". The pilot store's Romanian product names would hit the same failure. The fix is to encode the cursor's JSON as UTF-8 bytes before Base64, and decode it the same way. This PR does not change product code.
- **The global primary key makes rare filters cost what the whole database holds.** See the activity section above; I5's indexes remove the reason.
- **Import receipts write an idempotency record each:** 0.75 KB per receipt that is never read after the import.
- **The ledger reconciled for every position.** The read-back through `describe_catalog`, item detail, availability, packaging, barcode lookup, locations, supplier items, and bundle availability succeeded for all six shops. The only failure was the owner's grid query, from the first finding.

### How to run it again

The connection strings and the Neon key stay outside the repository. The commands read them from the environment and never print them.

```sh
# Once per empty database: roles, migrations, and a runtime password kept in a file (mode 600).
DATABASE_OWNER_URL=… tsx scripts/bench/setup-db.ts --password-file <file>

# Seeds (about 30 s), sizes, and the catalog timings.
DATABASE_OWNER_URL=… DATABASE_APP_URL=… tsx scripts/bench/seed-personas.ts --out seed-personas.json --check
DATABASE_OWNER_URL=… NEON_API_KEY=… NEON_PROJECT_ID=… tsx scripts/bench/sizes.ts
DATABASE_APP_URL=… tsx scripts/bench/query-catalog.ts --seed seed-personas.json --n 48

# Risk R3: take the history's context, branch, empty the stock tables, then write the history.
DATABASE_OWNER_URL=… tsx scripts/bench/seed-history.ts --context shops.json --dry-run
#   (branch i0-personas here; then on production:)
#   truncate inventory_entries, reservation_allocations, reservations, inventory_positions,
#     inventory_operations, idempotency_records;
DATABASE_OWNER_URL=… tsx scripts/bench/seed-history.ts --context shops.json --max-mb 850

# Activity timings.
DATABASE_APP_URL=… tsx scripts/bench/query-activity.ts --seed seed-personas.json --n 36 --explain 5
```

- `--scale` makes smaller shops, for example `--scale 0.1` for a quick local run, and `--only <persona>` seeds one shop.
- `cleanup.ts --names 'Bench %' --yes` removes the shops.
- To start from a reset point, restore `production` from `i0-personas` or `i0-baseline` in the Neon console, or create a new branch from one of them.

## I5 activity search

**When:** 16 November 2026.  
**Database:** Neon `airstock-bench`, on a branch `i5-activity-bench` created from `i0-baseline` for this run and deleted after it. Migrations 0016 to 0060, then 0061's tables and indexes. Same compute as I0 (0.25 to 2 CU).  
**History:** the I0 history, unchanged: 1,000,000 events in six shops, 120,000 to 250,000 each.  
**What runs:** the product's own search, `resolveActivityFilters` then `activityQuery` (packages/core/src/activity/query.ts), which `activity.list`, `search_activity`, and the activity export all use, as the runtime role in a read-only transaction with row-level security. Newest first, a page of 50 (51 rows read).

### Shapes

`scripts/bench/activity-filters.ts` draws each filter's value from each shop's own history, so a shape is a different search in every shop. Sixteen shapes combine two filters; four are the single-filter views the dashboard opens most (the first page, its ingestion check, one record's history, one request).

Several shapes are worst cases on purpose:
- the shop's busiest and quietest member;
- its rarest action;
- an action group and a source the shop never used;
- its busiest and quietest warehouse;
- a member limited to one warehouse, in the three shops that have one.

### What changed, step by step

Each step was timed warm on all twenty shapes; the column is the slowest shape's server p95.

| Step | Slowest shape, warm server p95 | What it showed |
| --- | --- | --- |
| The new filters, no new indexes | 597 ms | Zero-match filters (an unused action group, an unused source) read the shop's whole history or all shops'. |
| Six small filter indexes | 601 ms | Indexes alone did not help: for `action like 'inventory.transfer.%'` the planner guessed 700 matches and walked the primary key `(occurred_at, event_id)` through every shop's events, 100,000 pages. |
| The shop-first key `(shop_id, occurred_at, event_id)` replaces that primary key and the shop/time index | 174 ms | No search can read another shop's events any more. |
| No default partition | 167 ms | PostgreSQL now reads the months newest first and stops at a full page (an ordered Append instead of a Merge Append). This matters for actions new this month, which the older months do not have. |
| Action groups resolved to the shop's own actions; unused sources stop the search; a source index | 144 ms | Exact action lists get real estimates; the never-used group fell from 601 ms to 1 ms. |
| Scope and places resolved to literal location lists | see below | The busiest location with receipts fell from 3.0 s to 1.1 s cold. |

### Results

Warm: 6 runs per shop and shape. Cold: before each shape, for each shop, the compute was suspended through the Neon API, woken with `select 1` (not counted), and the search run once as `EXPLAIN (ANALYZE, BUFFERS)`, so the cold time is the search's own and its pages come from storage. Client times are from a laptop in Europe and include about 55 ms of round trips for the transaction (three of them).

| Search | Warm server p50 | Warm server p95 | Warm client p95 | Cold server p95 | Cold client p95 | Pages read cold, max |
| --- | --- | --- | --- | --- | --- | --- |
| First page, no filter | 0.8 ms | 1.2 ms | 65 ms | 190 ms | 293 ms | 18 |
| First page: the ingestion check | 1.7 ms | 1.8 ms | 57 ms | 114 ms | 259 ms | 4 |
| One variant's history | 0.8 ms | 0.9 ms | 63 ms | 246 ms | 347 ms | 116 |
| One bulk edit, every record (batch) | 0.7 ms | 0.8 ms | 61 ms | 250 ms | 364 ms | 16 |
| Busiest member + last 30 days | 1.4 ms | 3.9 ms | 60 ms | 220 ms | 290 ms | 1,521 |
| Quietest member + last 90 days | 6.0 ms | 9.1 ms | 63 ms | 296 ms | 390 ms | 2,384 |
| Busiest member + outcome conflict | 1.7 ms | 1.8 ms | 61 ms | 251 ms | 370 ms | 775 |
| One action + busiest member | 3.2 ms | 4.8 ms | 61 ms | 445 ms | 583 ms | 2,925 |
| Action group `inventory.*` + failed | 2.6 ms | 3.0 ms | 77 ms | 207 ms | 328 ms | 550 |
| Rarest action + phase outcome | 0.7 ms | 0.8 ms | 58 ms | 230 ms | 342 ms | 15 |
| Group never used + last 90 days | 1.2 ms | 1.4 ms | 60 ms | 113 ms | 237 ms | 12 |
| Source MCP + denied | 2.0 ms | 3.7 ms | 82 ms | 213 ms | 325 ms | 286 |
| A source never used + phase outcome | 0.8 ms | 0.9 ms | 63 ms | 164 ms | 276 ms | 12 |
| Integration + action group `catalog.*` | 6.1 ms | 7.0 ms | 82 ms | 370 ms | 529 ms | 2,839 |
| Failed + last 7 days | 0.6 ms | 0.6 ms | 59 ms | 141 ms | 257 ms | 118 |
| Busiest warehouse + last 7 days | 1.7 ms | 2.2 ms | 85 ms | 192 ms | 407 ms | 58 |
| Quietest warehouse + succeeded | 2.0 ms | 2.4 ms | 87 ms | 163 ms | 340 ms | 157 |
| Busiest location + receipts | 8.0 ms | 17 ms | 97 ms | 1,133 ms | 1,263 ms | 11,407 |
| Limited member: `inventory.*` + last 30 days | 3.6 ms | 5.3 ms | 100 ms | 116 ms | 290 ms | 92 |
| Limited member: busiest member + attempts | 11 ms | 211 ms | 382 ms | 5,123 ms | 5,275 ms | 33,687 |

**Two filters over 1 million events (90 cold and 540 warm searches):**

| | p50 | p95 | Max |
| --- | --- | --- | --- |
| Warm, server | 2.0 ms | 9.3 ms | |
| Warm, client | | 88 ms | |
| Cold, server | 163 ms | 534 ms | |
| Cold, client | 287 ms | 685 ms | 5,275 ms |

- **The target holds warm and cold:** p95 under 1 s for two filters. I0's cold worst cases took 1.6–8.5 s (one integration, rare outcomes, a batch); the matching searches here take 0.26–0.53 s cold. A batch is now one request's attempt ID, which imports carry too.
- **Two of 90 cold searches took over 1 s:**
  - **The busiest location with receipts, in one shop (1.3 s).** Most receipts in that shop are August's opening stock from the import; the planner picks the action index and reads them to find the 51 at that location.
  - **"The busiest member's attempts" for a member limited to one warehouse, in the spare-parts shop (5.3 s).** That member is the shop's importer: 57,000 events in August, nearly all import records, and their only 565 attempts are in August. Any plan reads three months of the shop's history to reach them. The planner cannot see that correlation (the member is busy, attempts are 15% of events). Per-partition extended statistics, or an attempts index by actor, would fix it. Neither is worth adding before a real shop shows the pattern.
- **Warm searches are 1–10 ms at the server.** The client times are round trips from the laptop; in the Worker they would be about 3 × 5 ms.

### Storage

After `VACUUM ANALYZE`, per event:

| | I0 baseline | I5 |
| --- | --- | --- |
| Heap | 411 bytes | 411 bytes |
| Target index | 124 | 124 |
| Shop and time | 105 (shop/time index) | 59 (the new unique key, freshly built) |
| Primary key `(occurred_at, event_id)` | 41 | none |
| Attempt | 19 | 8 (partial: events with an attempt) |
| Actor, action, source, operation, locations (GIN), problems | none | 8 + 8 + 7 + 5 + 4 + 0.2 |
| **Total** | **699 bytes** | **633 bytes** |

- **The new key was built in one pass, so its pages are full.** The old shop/time index grew with the inserts to 105 bytes. Expect the new key to grow toward that too: about 680 bytes per event, still under I0's 699, with six more indexes.
- **The filter indexes stay small:** their keys leave out the time, so B-tree deduplication stores each shop and value once with a list of row pointers.

### How to run it again

```sh
# Branch from i0-baseline (Neon console or API), then on the branch:
DATABASE_OWNER_URL=… tsx packages/db/src/migrate-cli.ts

# Warm only (about 5 minutes), or with --cold (about 45 minutes: one suspend per shop and shape).
DATABASE_OWNER_URL=… DATABASE_APP_URL=… tsx scripts/bench/activity-filters.ts --n 6
DATABASE_OWNER_URL=… DATABASE_APP_URL=… NEON_API_KEY=… NEON_PROJECT_ID=… NEON_ENDPOINT_ID=… \
  tsx scripts/bench/activity-filters.ts --n 6 --cold --json activity-i5.json
```

`--only` takes shape keys (comma-separated), and `--explain` prints each plan. Delete the branch afterwards.

## I5 reports (bench project)

**When:** 16 November 2026.  
**Database:** a throwaway branch of `i0-personas` (`i5-reports-bench`, deleted afterwards), migrated to the schema of this change (up to migration 0068, the reports migration). Same compute and client as the I0 baseline: about 15 ms per round trip from the client.

### Stock history

`i0-personas` has opening stock and no stock history. `scripts/bench/seed-stock-ledger.ts` adds three weeks of it, set-based, as the database owner, one transaction per shop (about 1 s each):
- The opening stock moves to a week before the history. Each variant gets its moving average from its opening receipts' unit costs; the seed ran before migration 0017, so it had none.
- Each day has 300 operations per shop on random sellable positions with stock. About a third are receipts of 6 to 48 units and two thirds fulfillments of 1 to 3 units, both at the variant's average. Each has its operation, ledger entry, balance, owned quantity, and cost-history row. No position goes below zero at any moment.
- Reorder rules cover 5% of the stocked variants, about half of them low.

`stock_reconciliation_problems()` finds nothing afterwards.

| Shop | Variants | Positions | Operations (21 days) | Reorder rules |
| --- | --- | --- | --- | --- |
| Bench Cards and Bricks | 1,254 | 1,236 | 6,232 | 65 |
| Bench Fuel Kitchen | 300 | 300 | 6,300 | 15 |
| Bench Lumen Skin | 2,000 | 1,932 | 6,281 | 103 |
| Bench Maison Verre | 4,001 | 5,879 | 6,160 | 190 |
| Bench Partline Supply | 20,000 | 16,990 | 1,690 | 689 |
| Bench Stride Sportswear | 4,014 | 4,443 | 6,231 | 194 |

Partline's positions mostly hold one or two units, so most of its drawn fulfillments were dropped to keep stock at or above zero.

### Report timings

`scripts/bench/query-reports.ts` runs each shape 5 times per shop through the product's operation (`execute` as the shop's owner, with row-level security and the access event), first page of 100 rows. "Client" is the whole run as the laptop saw it: the pipeline's 4 to 6 statements at about 15 ms each, plus the report query. "Server" is planning plus execution of the report query, from EXPLAIN (ANALYZE, TIMING OFF) after the timed runs. In the Worker, next to the database, a run takes about the server time plus 10 to 30 ms.

The largest shop, Partline (20,000 variants, 16,990 positions):

| Report | Rows | Client median | Client slowest | Server |
| --- | --- | --- | --- | --- |
| Stock on hand, positions | 16,982 | 1,081 ms | 1,181 ms | 799 ms |
| Stock on hand, per variant, by on hand | 14,187 | 1,043 ms | 1,101 ms | 789 ms |
| Stock on hand, per location | 420 | 888 ms | 991 ms | 722 ms |
| Inventory value now, per location | 420 | 245 ms | 283 ms | 76 ms |
| Inventory value 7 days ago, per location | 420 | 254 ms | 268 ms | 83 ms |
| Inventory value 7 days ago, per variant, by value | 14,190 | 273 ms | 276 ms | 113 ms |
| Inventory value 7 days ago, per category | 10 | 282 ms | 290 ms | 90 ms |
| Movements, 30 days, per variant | 14,195 | 340 ms | 402 ms | 162 ms |
| Movements, 30 days, each entry | 18,680 | 321 ms | 346 ms | 168 ms |
| Cost of goods, 30 days, per variant | 703 | 175 ms | 193 ms | 15 ms |
| Low stock | 341 | 467 ms | 643 ms | 8 ms |

The other shops:

| Shop | Variants | Stock on hand, positions (client, server) | Value 7 days ago, per variant (client, server) | Movements, entries (client, server) |
| --- | --- | --- | --- | --- |
| Bench Cards and Bricks | 1,254 | 256 ms, 56 ms | 177 ms, 12 ms | 230 ms, 56 ms |
| Bench Fuel Kitchen | 300 | 203 ms, 19 ms | 185 ms, 21 ms | 231 ms, 61 ms |
| Bench Lumen Skin | 2,000 | 284 ms, 90 ms | 171 ms, 15 ms | 243 ms, 78 ms |
| Bench Maison Verre | 4,001 | 427 ms, 244 ms | 177 ms, 27 ms | 280 ms, 131 ms |
| Bench Stride Sportswear | 4,014 | 396 ms, 208 ms | 189 ms, 26 ms | 253 ms, 84 ms |

Purchasing, expiring lots, and shortages have no rows in the seed (no orders, lots, or shortages yet) and take 140 to 220 ms, all of it round trips.

**Against the targets (plan Section 8):** stock on hand on the 20,000-variant shop takes 0.8 s at the server, and value at a past date 0.1 s, against 5 s and 10 s. Stock on hand grows with the positions: it computes what is reserved and available through `stock_positions`, the shared rule. At that rate a single shop with all 31,000 variants would take about 1.3 s. Value at a date reads the balances, the ledger entries after the date (one new index, `inventory_entries (shop_id, created_at)`), and the last cost-history row per variant.

**Export job:** every stock-on-hand row of Partline (16,982 rows, 2.1 MB of CSV) in 6.7 s, as four pages of 5,000 in one read-only transaction. Interactive runs stop after 25 s (`report_too_large`, which points to the export); an export's statements may run 5 minutes.

### How to run it again

```sh
# A branch of i0-personas (Neon console or API), migrated to the current schema.
DATABASE_OWNER_URL=… tsx packages/db/src/migrate-cli.ts
# Three weeks of receipts and fulfillments, and reorder rules (about 6 s for the six shops).
DATABASE_OWNER_URL=… tsx scripts/bench/seed-stock-ledger.ts --days 21 --per-day 300
# The timings, and the export job of the largest shop.
DATABASE_APP_URL=… DATABASE_OWNER_URL=… tsx scripts/bench/query-reports.ts --n 5 --json reports.json
```

## I7 volume run

**When:** 16 November 2026.  
**Database:** Neon `airstock-bench`, on a branch `i7-volume` created from `i0-personas` for this run and migrated to the schema of main (migrations 0016 to 0070, with I5's 0068). Same compute as I0: autoscaling between 0.25 and 2 CU. `pg_stat_statements` was installed on the branch for the database times.  
**Client:** the same laptop in Europe, about 15 ms per round trip (14.5–14.9 ms measured in each run).  
**Staging:** the deployed Worker at `airstock.deletecookies.dev`, with one small test shop made through the API for this run and deleted afterwards.

### Seed

`scripts/bench/seed-stock-activity.ts` adds what `personas.ts` marked "I1:", then three months of stock activity: 18 August to 16 November 2026, after the opening import of 17 August. The commands are replayed in memory with the engine's rules, then written in bulk as the database owner, one transaction per shop. Those rules are:
- allocation earliest expiry first, then oldest stock;
- no position below zero;
- allocations never above on hand;
- one serial per position;
- the moving average and owned quantity per variant, with a cost-history row per variant and operation.

Afterwards `stock_reconciliation_problems()`, `transfer_reconciliation_problems()`, and `return_reconciliation_problems()` find nothing in any shop. The whole seed took about 1 minute: 4 to 27 s per shop, most of it writing.

**Tracking (the "I1:" markers):**
- Food: every variant `lot_expiry`, sell-by margin 14 days, shelf life 150 to 330 days.
- Cosmetics: skincare, foundations, and concealers `lot_expiry` (987 variants), margin 30 days.
- Spare parts: pumps, motors, contactors, relays, and sensors serial-tracked: 2,052 variants, 10.3%.
- Fashion: watches serial-tracked; jewellery sold as a single variant made one of a kind.
- Owner's store: the 900 single and graded cards and the 100 used sets made one of a kind.

Opening stock of those variants was received again in one to eight lots, one serial per unit, or one unit.

**Activity:**
- **Orders:** a reservation per line (Shopify connector, API, or dashboard), fulfilled 2 to 40 hours later; 6% are released instead. The last day's stay open.
- **Purchase orders:** by preferred supplier, every two days, for variants under 40% of their opening level (60% for food) or under their reorder rule. They are received 4 to 12 days later with costs, new lots, and new serials; 8% are short, most of those closed short. The newest stay sent or draft.
- **Transfers:** between warehouses, received 18 to 60 hours after dispatch.
- **Returns:** into quarantine, then inspected: 80% back to sellable, 15% damaged, 5% disposed.
- **Counts:** a count of one location with a few corrections, one to three a day.
- **Write-offs:** damage, and expired food lots.
- **Reorder rules** on 5 to 50% of the stocked variants.

Weekdays are busier, people work office hours, and activity grows over the three months.

| Shop | Variants | Lots | Serials (in stock) | One of a kind (sold) | Reorder rules | POs (open) | Operations | Ledger entries | Reservations (open) | Transfers | Returns | Counts | Positions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bench Cards and Bricks | 1,254 | | | 1,000 (467) | 59 | 110 (27) | 18,980 | 11,838 | 9,281 (55) | | 123 | 91 | 1,810 |
| Bench Fuel Kitchen | 300 | 3,045 | | | 132 | 120 (23) | 20,736 | 14,754 | 10,145 (95) | | 74 | 181 | 3,993 |
| Bench Lumen Skin | 2,000 | 2,125 | | | 194 | 76 (19) | 21,138 | 14,456 | 10,134 (62) | | 300 | 180 | 4,034 |
| Bench Maison Verre | 4,001 | | 180 (117) | 27 (26) | 302 | 138 (26) | 21,299 | 23,718 | 9,725 (79) | 295 | 497 | 160 | 9,834 |
| Bench Partline Supply | 20,000 | | 13,467 (11,895) | | 1,122 | 328 (50) | 16,399 | 48,265 | 7,465 (66) | 390 | 63 | 264 | 34,617 |
| Bench Stride Sportswear | 4,014 | | | | 345 | 91 (14) | 22,198 | 23,187 | 9,987 (81) | 294 | 699 | 166 | 8,528 |
| **Total** | **31,569** | **5,170** | **13,647** | **1,027** | **2,154** | **863 (159)** | **120,750** | **136,218** | **56,737 (438)** | **979** | **1,756** | **1,042** | **62,816** |

**About the table:**
- **Operations** count the three months only, not the opening import. Ledger entries include the opening stock.
- **Operations by kind:** reservation 56,737, fulfillment 52,958, release 3,341, return 1,756, condition change (inspection) 1,647, count 1,042, transfer dispatch 979, transfer receipt 966, receipt 784, adjustment 540.
- **Pace:** about 220 stock operations a day per shop (180 to 245), under the plan's 300. Spare parts ran at 220 a day instead of 280 to keep the project under 800 MB. Its orders are larger, so it still has the most ledger entries: serials move one entry per unit.
- **Not seeded:**
  - audit events (the I0 history on `i0-baseline` covers them, and activity search was measured in I5);
  - idempotency records (see the storage section);
  - bundle reservations, pick lists, and Shopify mappings.

### Sizes and storage

After the seed, compacted with `VACUUM FULL` on the tables the seed updated or deleted from, and `VACUUM ANALYZE`, as `scripts/bench/sizes.ts` reports them:

| | `i0-personas` (I0) | `i7-volume` |
| --- | --- | --- |
| Database (`neondb`) | 182.5 MB | 340.4 MB |
| Cluster, which the 1 GB limit counts | 204.9 MB | 362.2 MB |
| Stock tables (positions, ledger, reservations, lots, serials, costs, transfers, returns, counts, POs, rules, idempotency) | 52.1 MB | 224.4 MB |
| Catalog tables | 119.0 MB | 101.7 MB (compacted; the catalog itself did not change) |

**Project storage:** `production` 154 MB, `i0-personas` 205 MB, and `i7-volume` 362 MB: 721 MB together, under the 800 MB line. Neon's API reports branch logical sizes with a lag of minutes, and `synthetic_storage_size` as 0 on this plan, so the cluster figure comes from PostgreSQL.

The measurement runs then added 48 MB, to 410 MB (768 MB for the project):
- the commands' idempotency records, 11 MB;
- their audit events, 11 MB;
- outbox rows, 4 MB;
- their stock rows, and the dead row versions their updates left.

**Per record** (heap and indexes, after compaction):

| Record | Rows | Heap | Indexes | Total |
| --- | --- | --- | --- | --- |
| Ledger entry | 136,218 | 173 B | 153 B | 326 B |
| Operation | 151,526 | 149 B | 80 B | 229 B |
| Position | 58,407 | 163 B | 196 B | 360 B |
| Lot | 5,170 | 185 B | 440 B | 634 B |
| Serial | 13,647 | 197 B | 298 B | 498 B |
| Reservation | 56,737 | 182 B | 140 B | 323 B |
| Allocation | 59,693 | 134 B | 151 B | 286 B |
| Cost-history row | 88,895 | 136 B | 156 B | 293 B |
| Count line | 45,442 | 240 B | 337 B | 577 B |
| Idempotency record, opening import | 30,780 | 356 B | 388 B | 745 B |
| Idempotency record, a command (stores its response, 974 B on average) | 7,278 | 1,213 B (row) | | about 1.6 KB |

**What a stock change costs in storage (cost model):**
- **An order line** (reservation, then fulfillment): about 4 KB in the stock tables. That is two operations, the reservation and its allocation, one ledger entry, one cost-history row, and two idempotency records (2.4 KB of it). The audit events of the two commands add about 3 KB.
- **A receipt:** about 2.3 KB, of which 1.4 KB is the idempotency record, and 2.9 KB with a new lot.
- **A serial-tracked unit:** about 1.2 KB more than an untracked one, for its serial, its own position, and its own entry.
- **Lots and serials are index-heavy:** 70% and 60% of their bytes are indexes. Lots have four unique keys, and serials three.

**Idempotency records are never deleted.** No code or migration removes `idempotency_records`, and every command writes one with its whole response, about 1.6 KB. At three months of this activity that would be 120,750 records, about 190 MB: as much as all the other stock tables together. A retention window would keep them to a few MB per shop, for example deleting completed records after 7 or 30 days in the daily cron.

### Method

**Bench (`scripts/bench/query-stock.ts`):**
- Every command and read goes through the product's pipeline in process, as the runtime role with row-level security.
- Ten callers work at once, each on its own connection: 100 commands per phase and shop, on different variants. Ten callers on one shop is the plan's load case.
- Statements per command are the database layer's own count, including `BEGIN` and `COMMIT`.

**Database time** is `pg_stat_statements` execution time over the phase, divided by the commands. It is reset before each timed phase, and it includes lock waits but not planning. The **Worker estimate** is the database time plus 6 ms per statement: the round trip from the Worker next to Neon (Phase 0 measured 4 to 8 ms; Phase 1 report, Section 4). "Server ≈" in the JSON output is the client time less the statements times the measured round trip. It is noisier, but agrees within 10 to 60 ms.

**Staging (`scripts/bench/staging-stock.ts`):**
- The test shop has 300 items (every sixth lot-tracked) and two locations, made through the API with an API credential of the shop.
- Each command ran 30 times, one at a time, and the response's `Server-Timing` gives the Worker's own time, the database time, and the statement and transaction counts.
- Staging's counts are 2 to 3 statements higher than the bench's: the credential check is a transaction of its own.

### Results against the targets (plan Section 8)

**Stock commands with 10 concurrent callers** (target: p95 under 500 ms). Bench, all six shops:

| Command | SQL statements | Database time per command | Worker estimate | Staging, one at a time: server p50 / p95 (statements) |
| --- | --- | --- | --- | --- |
| Receive | 15–17 | 1.9–7.6 ms | 92–110 ms | 183 / 235 ms (18) |
| Reserve | 13 | 3.4–6.3 ms | 81–84 ms | 185 / 242 ms (16) |
| Fulfill | 19 | 1.8–4.1 ms | 116–118 ms | 215 / 290 ms (22) |
| Transfer dispatch | 26–27 | 3.5–7.2 ms | 160–169 ms | 233 / 329 ms (29) |
| Transfer receipt | 29–31 | 3.2–6.7 ms | 179–193 ms | 240 / 324 ms (33) |
| Count submit | 27–28 | 2.7–5.8 ms | 165–174 ms | 254 / 335 ms (31) |

- **Within target:** every command is well under 500 ms, on the bench estimate and on staging. Statements, not the database, set the time: each statement executes in under half a millisecond on average, and the round trips are the rest.
- **Staging:** its database time is about 6 ms per statement (receive: 106 ms for 18), as the estimate assumes. On top of that comes the awaited audit-queue send: 80 to 106 ms at p95 on every request.
- **One outlier:** in the first bench run, transfer receipt in Partline had a p95 of 1.1 s while its database time stayed 3.5 ms per command. That points to the laptop's connection, not the database, and a second run gave 111 ms.

**Reservation with earliest-expiry allocation, one variant with 200 lots** (Fuel Kitchen; 200 lots with stock in 200 positions; target: p95 under 500 ms):

| Case | Bench database time | Bench Worker estimate | Staging server p50 / p95 |
| --- | --- | --- | --- |
| One caller, 1 unit | 15–17 ms | 93–95 ms | 230 / 349 ms |
| One caller, 30 units (several lots) | 15–17 ms | 93–95 ms | |
| 10 callers on the same variant, 1 unit | 994–1,000 ms, waiting | | 671 / 851 ms |
| 10 callers on the same variant, 12 units | 1,011 ms, waiting | | 890 / 1,062 ms |

One caller is within target. Ten callers reserving the same variant at once are not. Each reservation locks every candidate position of the variant (`lockCandidates`, all 200 lots, in id order) until it commits, so reservations of one variant run one after another. With 10 waiting, the last waits for nine others. See [over target](#over-target-and-proposed-fixes).

**Availability for one variant across the shop** (target: p95 under 200 ms):
- **Bench, every shop:** 6 statements, 0.7–2.1 ms of database time, Worker estimate 37–38 ms, and the same with 10 callers (up to 5.8 ms in Partline).
- **The 200-lot variant:** 10.5–13.2 ms, estimate 46–49 ms.
- **Staging:** server p50 132 ms, p95 164 ms, of which 87 ms (p95) is the audit-queue send.
- **Within target.**

**Inventory list, 50 rows, with lot and condition columns** (target: p95 under 1 s). The list is `reports.run` stock on hand by position (variant, location, condition, lot), first page of 50:

| Shop | Positions with stock | One caller: database time | 10 callers: database time per run |
| --- | --- | --- | --- |
| Bench Cards and Bricks | 1,810 | 71 ms | 660 ms |
| Bench Fuel Kitchen | 3,993 | 171 ms | 1,234 ms |
| Bench Lumen Skin | 4,034 | 172 ms | 817 ms |
| Bench Stride Sportswear | 8,528 | 279 ms | 1,430 ms |
| Bench Maison Verre | 9,834 | 334 ms | 1,784 ms |
| Bench Partline Supply | 34,617 | 1,361 ms | 7,386 ms |

- **Over target:** Partline even with one caller, and four shops with 10 callers.
- **Staging's test shop** (300 items): server p95 166 ms.
- **Cause:** the first page costs as much as the whole report, because the report computes its count and totals over every row, and `stock_positions` is slow over a whole shop. See below.

**Webhook delivery, commit to receipt** (target: p95 under 10 s). A `stock.changed` subscription on the staging test shop pointed at a receiver on the laptop behind a Cloudflare quick tunnel, standing in for n8n. Forty receipts, one at a time:
- all 40 delivered on the first attempt;
- **from the event's time:** p50 293 ms, p95 366 ms, max 423 ms;
- **from the moment the command's response reached the client:** p50 164 ms, p95 215 ms.

Delivery runs in the request's own outbox run right after the response, as plan risk R7 assumes. **Within target.** The subscription and the tunnel were removed afterwards.

**Reports on the full persona seed** (target: under 5 s and 10 s). `query-reports.ts` from I5, run again on the three-month seed:
- stock on hand for Partline (18,460 positions with stock) takes 1.56 s at the server, against I5's 0.8 s on three weeks of history;
- value 7 days ago takes 0.10–0.12 s;
- the stock-on-hand export (18,460 rows, 2.2 MB) took 7.7 s;
- every other shop is under 0.35 s.

**Within target.** Activity search was not measured again: the history is unchanged since I5.

### Over target, and proposed fixes

**1. The inventory list (stock on hand) on large shops.** For Partline's first page:

| Plan step | Time |
| --- | --- |
| `stock_positions(array(select variant_id from vf))`, one Function Scan over 34,020 positions | 1,226 ms (742,000 buffer hits) |
| Joins, grouping, the count and totals over 18,460 rows, and the page of 51 | 160 ms |
| **Total execution** | **1,387 ms** |

The function's own joins take 160 ms. Two things in it cost the rest, because it is called with a 20,000-element array and is not inlined (its argument is a sub-select):
- `location_fulfillment_eligible(l.shop_id, l.path_ids)` runs once per position, as a SQL function with two `NOT EXISTS` lookups: about 15 buffer hits and 25 µs each, about 0.9 s here;
- when the planner applies `p.variant_id = any($1)` as a filter instead of an index condition, it compares every position with up to 20,000 ids one by one.

Run as a prepared generic plan, the body takes 1,042 ms. With both changes below it takes 194 ms, and with only one of them 1.1–1.8 s:
- (a) compute eligibility once per location in a materialized CTE (the shop's 477 stocked locations, 27 ms);
- (b) filter with `p.variant_id in (select unnest($1))`.

Proposed, in a separate change with a migration and tests:
1. In `stock_positions`, apply (a) and (b), or store the effective eligibility on `locations` (kept current when a location or warehouse changes) and drop the per-row function. Expected: Partline's list from 1.4 s to about 0.3 s, and every command that allocates over many positions gains too.
2. In the report runner, compute the count and totals on the first page only, or from a cheaper aggregate. On-hand totals need no availability rule; reserved and available can sum only the positions with allocations.
3. Then measure again with 10 callers. Ten such queries share at most 2 CU, so the per-query cost has to come down about 5× for the 10-caller case to hold on Partline.

**2. Ten concurrent reservations of the same variant** (plan risk R5). One reservation alone is fast at 200 lots: staging p95 349 ms, bench database time 15 ms. But all reservations of a variant serialize on the candidate lock. Through the Worker, with 10 callers on one variant, p95 was 851 ms (1 unit) and 1,062 ms (12 units). This is the owner's release-day case: many orders for one new booster box in the same second. Proposed, as ADR 0020 already anticipates:
1. Lock fewer rows for less time. Choose positions without a lock, then lock only the chosen ones in id order and check them again (retry if they changed). Or take a per-variant advisory lock and then only the chosen positions.
2. Cut the statements between the lock and the commit. A reservation holds its locks for about 9 of its 16 statements, roughly 55 ms in the Worker, so 10 in a row take about 0.6–0.9 s.

Different variants do not wait for each other: with 10 callers on different variants, the bench's database time stayed at 3–6 ms per reservation.

**3. Staging's database ran out of memory under 10 concurrent callers.** During the staging run with 10 callers, at 12:50 UTC, one reservation answered 500 (`internal_error`). For about two minutes new connections then failed with "could not fork new process for connection: Cannot allocate memory", and the compute restarted at 12:53.
- **Staging's compute:** 0.25 CU, `shared_buffers` 128 MB, `max_connections` 112.
- **Connections held:** Hyperdrive held 60 idle `airstock_app` connections.
- **What it means:** at this size, each idle backend's memory leaves no room for a burst. The other 10-caller staging phases were not run again, to leave staging alone.
- **Proposed:**
  1. Cap Hyperdrive's origin connections well under what the compute can hold, about 20 at 0.25 CU.
  2. Or point Hyperdrive at Neon's pooled endpoint.
  3. For production (the owner's I7 decision), use a minimum of 0.5 CU or more.
  4. Run the 10-caller staging phases again after the change.

### Neon compute used

- **The `i7-volume` branch:** 221 compute seconds and 876 active seconds, as Neon's API reported them during the run. The counters lag by minutes; the totals at the end are in the PR.
- **The project for the billing period:** from 2,049 to 2,378 compute seconds, which includes the other branches.
- **Scaling to zero:** the branch's compute keeps Neon's default suspend after 5 idle minutes. This run adds no crons or retries, so the plan's compute-hours row waits for the I6 crons.

### Other findings

- **The audit-queue send is awaited on every request.** On staging it took 80–106 ms at p95, about a third of every command's server time and half of a read's. It is the largest single cost after the statements.
- **`cleanup.ts` could not delete a shop with a submitted count.** A count names its operation, and the operation names its count (migration 0032), so neither table could go first. Fixed in this PR (scripts only): the script clears `count_sessions.operation_id` first.
- **The idempotency records** (above) are never deleted, and a command's record is 1.6 KB.

### How to run it again

```sh
# A branch of i0-personas (Neon console or API), migrated, with pg_stat_statements.
DATABASE_OWNER_URL=… tsx packages/db/src/migrate-cli.ts
psql … -c 'create extension if not exists pg_stat_statements'
# The seed (about 1 minute), one shop at a time to watch the size; spare parts at 220 a day.
for s in Cards Fuel Lumen Stride Maison; do
  DATABASE_OWNER_URL=… tsx scripts/bench/seed-stock-activity.ts --only "Bench $s%" --check
done
DATABASE_OWNER_URL=… tsx scripts/bench/seed-stock-activity.ts --only 'Bench Partline%' --per-day 220 --check
# Compact what the seed rewrote, then vacuum analyze.
psql … -c 'vacuum full inventory_positions' …   # also variant_costs, variants, variant_cost_history,
                                                 # inventory_operations, inventory_entries, products
# Sizes, then the timings (about 10 minutes), then the reports.
DATABASE_OWNER_URL=… NEON_API_KEY=… NEON_PROJECT_ID=… tsx scripts/bench/sizes.ts
DATABASE_OWNER_URL=… DATABASE_APP_URL=… tsx scripts/bench/query-stock.ts --workers 10 --per-worker 10 --json stock.json
DATABASE_APP_URL=… DATABASE_OWNER_URL=… tsx scripts/bench/query-reports.ts --n 3
# Staging: a test shop made through the API, and an API credential of it with every scope.
AIRSTOCK_TOKEN=… tsx scripts/bench/staging-stock.ts --shop <id> --items 300 --n 30
AIRSTOCK_TOKEN=… tsx scripts/bench/staging-stock.ts --shop <id> --skip-setup --webhook-only \
  --webhook-url https://<tunnel> --webhook-port 8787 --webhook-n 40
AIRSTOCK_TOKEN=… tsx scripts/bench/staging-stock.ts --shop <id> --skip-setup --contention --workers 10
DATABASE_OWNER_URL=<staging owner> tsx scripts/bench/cleanup.ts --names '<test shop>' --yes
```

The branch `i7-volume` was deleted afterwards to keep the project's storage free for I6 and the rest of I7; a branch of `i0-personas` and the commands above make it again in a few minutes.

## I7 fixes

**When:** 16 November 2026, after the I7 volume run.  
**Database:** Neon `airstock-bench`, a branch `i7-fixes` from `i0-personas`, migrated to main and seeded with `seed-stock-activity.ts` for Fuel Kitchen and Partline only (the two shops the over-target items need), then compacted as in the volume run. The other four shops have their opening stock only. Autoscaling 0.25 to 2 CU, as before.  
**Client:** the same laptop, 14–17 ms per round trip. `query-stock.ts --phases list,r5` runs only the inventory list and the 200-lot reservations. "Before" is main at that time, measured on the same branch first.

### 1. The inventory list (stock on hand by position, first page of 50)

Migration 0081 (ADR 0020, update for I7):
- eligibility is computed once per query from the shop's ineligible warehouses and locations;
- variants are filtered with a semi-join;
- the report joins the inlined `stock_positions()` with its variant filter;
- the sell-by margin and expired claims are looked up only where they can matter;
- later pages carry the first page's count and totals in the cursor.

Database time per run, from `pg_stat_statements`:

| Shop | Positions with stock | Before, 1 caller | After, 1 caller | Before, 10 callers | After, 10 callers |
| --- | --- | --- | --- | --- | --- |
| Bench Cards and Bricks | 1,236 | 60 ms | 10 ms | 529 ms | 79 ms |
| Bench Fuel Kitchen | 3,345 | 146 ms | 23 ms | 1,401 ms | 205 ms |
| Bench Lumen Skin | 1,932 | 89 ms | 15 ms | 428 ms | 135 ms |
| Bench Maison Verre | 5,879 | 239 ms | 31 ms | 1,270 ms | 266 ms |
| Bench Partline Supply | 33,420 | 1,322 ms | 177 ms | 7,184 ms | 1,790 ms |
| Bench Stride Sportswear | 4,443 | 189 ms | 24 ms | 962 ms | 75 ms |

- **One caller:** every shop is well within the 1 s target. Partline is 177 ms, server p95 196 ms.
- **Ten callers:** every shop but Partline is under 0.3 s. Partline's ten lists need about 1.8 s of CPU between them. That is 1.9 s at p95 while the compute scales up from 0.25 CU, and 0.86 s of database time (server p95 1.04 s) with the compute held at 2 CU. Ten people opening the 34,000-position list in the same second is the limit at 2 CU. Production's minimum compute is the owner's I7 decision.
- **The function alone,** over Partline's 33,420 positions:
  - the array form `stock_positions(array(...))` went from 1,205 ms to 239 ms;
  - the inlined `stock_positions()` takes 97 ms.
- **The report's SQL,** first page: 1,387 ms before, 196 ms after.
- **Filtered runs,** Partline, before and after:
  - search "pump": 155 → 48 ms;
  - one variant: 13 → 2.6 ms;
  - by variant: 1,202 → 162 ms;
  - by location: 1,151 → 126 ms.
  
  The counts and totals are identical.
- **Same results:** each form of the new function was compared with migration 0017's over every variant of all six shops: the whole shop, the array, and one variant at a time. They gave identical rows. For the check, inside a transaction rolled back afterwards, 165 open reservations were expired and one warehouse was made ineligible.
- **Single-variant reads got faster too:** the 200-lot reservation went from 16.8 to 8.2 ms of database time, and availability for that variant from 12.2 to 5.5 ms.

### 2. Ten reservations of one variant at once (plan risk R5)

New reservations take a per-variant advisory lock. One statement then chooses positions, locks only the chosen ones, checks them, and writes. The locks are held for that statement, the final write, and the COMMIT: 3 statements instead of 8 (ADR 0006, update for I7). Fuel Kitchen's variant with 200 lots of 24 units, `query-stock.ts --phases r5`:

| Case | Before (main) | Fix 1 only | After (fixes 1 and 2) |
| --- | --- | --- | --- |
| Statements per reservation | 13 | 13 | 11 |
| One caller, database time | 16.8 ms | 8.2 ms | 4.1–5.1 ms |
| 10 callers, 1 unit: database time per reservation (with lock waits) | 964 ms | 1,051 ms | 381 ms |
| 10 callers, 1 unit: client p50 / p95 | 1,200 / 1,233 ms | 1,324 / 1,376 ms | 572 / 603 ms |
| 10 callers, 1 unit: server p95 (client less statements × 16 ms) | 1,045 ms | 1,158 ms | 427 ms |
| 10 callers, 12 units: database time per reservation | 981 ms | 1,041 ms | 370 ms |
| 10 callers, 12 units: client p50 / p95 | 1,213 / 1,318 ms | 1,314 / 1,334 ms | 566 / 577 ms |

- **The "after" column is the third of three runs.** The first two had the same p50 and database time, but client p95 outliers of 1.2–2.2 s from the laptop's network: in one of them a single caller's p95 was 715 ms against 4 ms of database time.
- **Each run's client time** includes about 16 ms per statement to Frankfurt; in the Worker a statement costs about 6 ms.
- **Locally** (`scripts/bench/reserve-contention.ts`) the same race ran against PostgreSQL 17 on the laptop:
  - setup: a fresh database, 200 lots of 24 units, 100 reservations by 10 callers, and 6 ms added before every statement for the Worker's round trip;
  - before (fix 1 only): p95 862 ms for 1 unit and 650 ms for 12 units, 14–16 reservations a second;
  - after: p95 328 and 337 ms, 31–32 a second;
  - one caller: 13 and 11 statements, about 140 ms either way;
  - stock reconciliation was clean after each run.
- **Through the Worker,** the hold per reservation is about 3 statements × 6 ms plus their execution, 25–30 ms, against about 65 ms before. With ten waiting, the last should wait about 0.25 s instead of 0.6 s. Staging was not run again with 10 callers: the compute is 0.25 CU, and its Hyperdrive limit was only just lowered.
- **When the advisory path falls back:**
  - expired claims on the variant send a reservation to the previous path, which releases them;
  - so does a claim statement that finds too little, a changed position, or a need for more than 32 positions;
  - in the tests' thirty-caller race, the callers that found the units gone took the previous path and failed with `insufficient_stock`, as before.
