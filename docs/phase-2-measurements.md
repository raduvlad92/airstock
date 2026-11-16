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
