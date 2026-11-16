# 0020. Stock model: positions, conditions, lots, serials, reservations, and allocation

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan decisions D1–D4 and Section 5.1 (milestone I1). Builds on [ADR 0006](0006-inventory-concurrency.md).

**Summary:** Positions per variant, location, condition, lot, serial, and transfer; one in-transit system location per shop; one shared SQL function for what is sellable now; explicit allocations chosen by a per-channel rule, earliest expiry then oldest stock first

## Decision

### Positions and conditions (D1)

- `inventory_positions` stays the balance table and the unit of locking. A position is a variant at a location, in a condition, optionally for one lot or one serial, and, in transit, for one transfer. The identity is unique with `NULLS NOT DISTINCT`, so a missing lot, serial, or transfer never makes a second position for the same stock.
- Conditions are `sellable`, `quarantine`, `damaged`, `repair`, and `supplier_return`. Disposal is an adjustment out, not a condition. A stock condition (can it be sold?) is separate from an item's catalog condition, such as "near mint".
- **In transit.** Every shop has one system location of kind `in_transit`, created with the shop (and backfilled by migration 0017). It belongs to no warehouse, is never fulfillment-eligible, takes no receipts, and is left out of every location list, mapping, scope, and import. Positions there name their transfer (`transfer_id`); milestone I2 adds the transfers and their foreign key. Owned stock includes it; on hand at a warehouse does not.
- A serial position holds at most one unit (`on_hand <= 1`, a check constraint), and a position names a lot or a serial, never both.
- `received_at` records when the oldest units still on a position arrived: a receipt into an empty position sets it. The allocation rule uses it for "oldest stock first".

### Lots, expiry, and serials (D4)

- `lots`: a code unique per variant (compared trimmed, with inner spaces collapsed, upper case), an optional expiry date, production date, supplier, and a free-text purchase order reference until I3 links PO lines.
- `serial_units`: a serial unique per variant (same normalization), a status (`in_stock`, `in_transit`, `sold`, `written_off`), and the position that holds it while it is in stock or in transit.
- Entries name the lot and serial they moved, the pack version whose factor converted the entered quantity, and the reservation a fulfillment consumed, so a lot trace and a serial's history are queries over the ledger.
- A variant's tracking mode (`none`, `lot`, `lot_expiry`, `serial`) changes only while it has no stock and no open reservations. Stock commands take a key-share lock on the variant row, so a mode change and a receipt cannot both pass their checks.
- **Expiry is computed, never swept.** A lot stops being sellable at the start of the day after its expiry date in the shop's time zone, moved earlier by the variant's `sell_by_margin_days` (`lot_sellable_until`). Nothing has to run on time for expired units to stop being available.

### One rule for "sellable now" (plan 5.1)

- `stock_positions(variant_ids)` is the single SQL function that every read and command uses for reserved and available quantities: stock views, catalog availability columns, bundle availability, reservation allocation, and the Shopify push. For each position it returns on hand, reserved (outstanding allocations minus those of expired reservations), whether it is sellable (sellable condition, not in transit, at an active and fulfillment-eligible storage location, lot not expired), and available (on hand minus reserved when sellable, else 0).
- Availability is never below zero: `allocated <= on_hand` remains a check constraint, the last defence.

### Reservations (D2)

- Allocations stay explicit, on concrete positions. Each allocation records `released`, `fulfilled`, and `moved` (reallocated elsewhere); `outstanding` is a generated column, and `allocated` on a position is the sum of its outstanding allocations.
- Release and fulfillment are partial by quantity, per reservation or per allocation. Expiry is optional for every caller, with a shop default of none (`shops.reservation_expiry_minutes`); connector reservations (Shopify orders) never expire.
- A reservation can be limited to a location (with its sub-locations) and to a lot.
- **Bundles** reserve as a header reservation (the bundle variant, quantity in bundles, the bundle version) with one component reservation per component variant (`parent_id`, base units per bundle). Allocations live on the component reservations, so every stock invariant is per variant.

### Allocation rule (D3)

- Per shop and channel (`default`, or a sales channel such as `shopify:<connection>`): an ordered list of warehouses or locations (`allocation_rules`, `allocation_rule_locations`). Without a rule, every fulfillment-eligible location takes part as one group.
- Positions are chosen by the rule's order, then earliest expiry first for lot-tracked variants, then oldest stock first (`received_at`), then location path and position ID. The chosen positions are the allocations.
- `reallocate` moves an outstanding allocation to another eligible position, for example when a picker scans a different lot. The old allocation records what `moved`; the new one names its `source_allocation_id`.
- Positions received in the same transaction tie on `received_at`; their order is then the location path and position ID, not the order the serials were typed in.
- Units of a lot that expires while reserved stay reserved: the allocation is kept until it is released, reallocated, or fulfilled (a shipment that already left must still be recorded). Expired units never become available again.

### Lock order

ADR 0006's order holds for every command: positions by ID, then reservations by ID (a bundle header and its components together), then everything else (`variant_costs`, `serial_units`, products, alerts). New lot and serial rows are inserted before the positions that name them; a wait on a new row's unique index cannot close a cycle with that order.

## Why

- Keeping one balance table with lot, serial, and transfer in the identity means every movement, from receipts to transfers, uses the same locking, ledger, and checks.
- Computing expiry where it is read, in one function, is the only way the dashboard, the API, MCP, and the Shopify push can never disagree, and it keeps Neon free to sleep between the 30-minute crons.
- Component reservations for bundles keep "allocated equals outstanding allocations" true per variant, so reconciliation needs no bundle arithmetic.

## Update, 16 November 2026: the scheduled reconciliation (D18)

- **The job.** `reconcileStock` (`packages/core/src/stock/reconciliation.ts`) runs from the existing crons, through the Worker's own fetch handler (`/internal/reconcile`, behind the internal secret) so it runs next to the database, or in the cron itself when the self binding is missing. No new cron, so Neon still scales to zero. The 30-minute run takes up to 25 shops with stock activity since their last check; the daily run takes up to 200 shops not checked for a day. Both are picked by `shops_due_stock_reconciliation`, oldest check first, and stop starting shops after 20 seconds.
- **Per shop**, `reconcileShop` runs `stock_reconciliation_problems()` in the shop's context and records a `stock_reconciliations` row (the count, and the first 100 problems). A mismatch opens one alert with the key `reconciliation` (kind `reconciliation_mismatch`) and writes an audit event (`inventory.reconciliation.alert_opened`, actor `system`, ID `reconciliation`, source `scheduled`) listing each problem with its expected and actual figures. The outbox announces it: an `alert.opened` row for the notifications that milestone I3 adds, and the `alert.opened` webhook event once that type is available. A check that finds the same problems again only counts them on the alert (`occurrences`, `last_seen_at`); different problems add an `alert_updated` event. A clean check resolves the alert with an `alert_resolved` event and `alert.resolved` announcements. The job never changes stock.
- **The repair path is reviewed, never automatic.** `GET /stock-check` (and `get_stock` action `stock_check` over MCP) shows the last checks, the alert, and the problems found now. For one problem, `GET /stock-check/repair-preview` shows the compensating operation, and `POST /stock-check/repairs` commits it only with `confirm: true`, a reason, and the previewed figures (`problem_changed` if they moved). Both need the new `inventory.adjust` permission. Each repair is an `adjustment` operation with reason `reconciliation`, audited as `inventory.reconciliation.repaired`, and never edits earlier history (PRD 6.1, rule 10):
  - `on_hand_mismatch`: a ledger entry for the difference, so history explains the balance that availability, reservations, and Shopify have used. On hand does not change; a count corrects it if the shelf disagrees.
  - `cost_quantity_mismatch`: a cost-history entry (`apply_stock_cost`, kind `adjustment`), so the quantity behind the moving average matches the units in stock. It needs access to every location.
  - `allocated_mismatch`: reserved at the position is set to the total of its open allocations, under the position lock; refused if that exceeds on hand.
  - The other problems (reservations, bundle components, serials, over-allocation) get guidance to check the records by hand; no automatic repair is offered.
- The repair locks in the engine's order: the position (or every position of the variant, shared) and then the variant's cost row. Over MCP the preview and the repair are a documented exception: a person reviews them in the dashboard (Settings, Stock check) or over REST. Milestone I2's `adjust_stock` can take the ledger repair over.
- A repair does not resolve the alert; the next scheduled check does, so the record of a mismatch always comes from the same check that found it.

## Update, 16 November 2026: allocation rules and location scope

- **Changing a channel's allocation rule touches the old list and the new one.** `inventory.allocation_rules.set` checks the locations of the rule it replaces as well as the new list against the caller's scope (a warehouse counts as every location in it). An empty list, or a channel without a rule, means every fulfillment-eligible location, so a member limited to some locations can neither set an empty list nor replace a rule that covers every location (`location_out_of_scope`). Before, only the new list was checked, so a scoped manager could re-route a channel's reservations away from, or onto, warehouses outside their scope.

## Update, 16 November 2026: review fixes (PR #73 findings)

- **Serials never in two places.** Every serial update (`syncSerials`) is guarded by where the serial is now: a move out of a position needs the serial on hand there, a move from outside stock (a find, a return, a reversal) needs it out of stock. The update re-reads a concurrently committed change, so the losing command fails with `serial_in_stock` or `serial_not_here`. Adjustments, counts, and reversals also lock their serial units after the cost rows and check them again (`checkSerials`): the earlier checks were plain reads.
- **New positions in one order.** `applyMoves` creates destination positions in identity order (variant, location, condition, lot, serial, transfer). Existing destinations are locked by id first; a command creating a position waits on another creating the same one, so two receipts into empty positions cannot deadlock.
- **Reallocation keeps the reservation's limits.** `reallocate` takes new positions only within the reservation's own lot, location, and channel allocation rule, as filling a shortage does; naming a lot or location outside them fails with `outside_reservation_limits`. An allocation emptied while the command waited for its locks fails with `nothing_allocated` instead of recording a move of nothing.
- **Whole units.** Fulfill, release, and reallocate check an explicit quantity against the variant's quantity precision (`quantity_precision`); a bundle fulfilled without a quantity ships the bundles covered, cut to the bundle's precision.
- **The shortage sweep keeps the lock order.** `sweepShortages` locks the candidate positions of every variant it visits in one ordered statement, then the shortage reservations (with bundle headers and the expired claims there) in one, and only then fills, variant by variant.
- **Engine events name their locations.** `inventory.reservation.expired` carries the locations of the released claims and `inventory.shortage.filled` those of the new allocations, so members limited to other locations do not see them.
- **The scheduled check covers documents.** `readStockProblems` also runs `transfer_reconciliation_problems()` and `return_reconciliation_problems()`. Their five problem kinds (`transfer_hold_mismatch`, `transfer_in_transit_mismatch`, `return_received_mismatch`, `return_inspected_mismatch`, `return_unit_inspected_mismatch`) open the alert and offer no automatic repair: they are checked by hand.
- **A repair is not reversed.** `reverse` refuses an operation with reason `reconciliation`: the repair only explains the balance in the history, so reversing it would change real stock. A count corrects a wrong balance.

## Update, 16 November 2026 (milestone I7): stock_positions over a whole shop

The I7 volume run measured the inventory list (stock on hand by position, first page of 50) at 1.36 s for the spare-parts shop's 34,000 positions with one caller, and 7.4 s with ten. Migration 0081 keeps the rule and its results, and changes how it runs:

- **Eligibility once per query.** `fulfillment_ineligible_ids()` returns the shop's ineligible warehouses and locations (partial indexes find them), and a position's location is eligible when its `path_ids` overlap none of them. Before, `location_fulfillment_eligible()` ran two index lookups per position. Location scopes already rely on warehouse and location IDs never colliding in `path_ids`. `lockCandidates` uses the same test.
- **`stock_positions()`** is every position of the current shop, the rule itself, kept to one plain SELECT so the planner inlines it. `stock_positions(variant_ids)` filters it with `variant_id in (select unnest(...))`, a semi-join, where `= any($1)` compared each position with a 20,000-element array one id at a time. The stock-on-hand report joins `stock_positions()` with its variant filter, so the planner sees real row counts and uses hash joins.
- **Fewer lookups per position.** The variant's sell-by margin is read only for lots with an expiry date. Expired claims are looked up only where something is allocated: `allocated` is the sum of the position's outstanding allocations, so a position with nothing allocated has none.
- **Same results.** `stock-positions.test.ts` compares every form with migration 0017's body across each branch: an ineligible warehouse and parent location, an expired lot, an expired claim, quarantine, and in transit. On the bench, all six persona shops gave identical rows, with 165 open reservations expired and one warehouse made ineligible for the check (rolled back).
- **Report totals once.** A report's count and totals cover every row, so later pages carry the first page's in the cursor instead of computing them again.

Partline's list went from 1,322 ms to 177 ms of database time with one caller (`docs/phase-2-measurements.md`, "I7 fixes").

## Update, 16 November 2026: the lot trace export (G6)

- **What.** `inventory.lots.export_trace` (REST `POST /shops/{shopId}/lots/trace/exports`, MCP `import_export` action `export_lot_trace`) writes one lot's trace as CSV: one line per movement, oldest first, as the trace read lists them, with the lot, SKU, expiry, movement kind, quantity, location, order reference, reservation, the operation's reference, the purchase order (from `purchase_order_receipts`) and supplier of each receipt, the actor, and the operation ID.
- **How.** It is an export job like the catalog and activity exports (`export_jobs`, `query.mode = 'lot_trace'`, run by the catalog export runner): it runs as the member who started it, with their location scope now, so a scoped member's file leaves out other locations' movements exactly as the trace read does. The file downloads through the export file route, each download is logged, and the job logs `inventory.lot_trace_export.created`, `.completed`, and `.failed`. At most 100,000 movements per file; the last line says when it stopped there.
- **Where.** The stock panel's lot column opens the trace (lot, supplier, purchase order, totals, orders, movements) with Export CSV; the export is listed with the others under Recent exports (kind `lot_trace`).

## Revisit when

- Allocation over a variant with hundreds of lots misses the 500 ms target (plan risk R5): lock the candidates in one statement with a cap, then consider an advisory lock per variant and location.
- Per-channel pools need more than an ordered location list.
