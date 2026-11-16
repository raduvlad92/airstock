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
- `reallocate` moves an outstanding allocation to another eligible position, for example when a picker scans a different lot.

### Lock order

ADR 0006's order holds for every command: positions by ID, then reservations by ID (a bundle header and its components together), then everything else (`variant_costs`, `serial_units`, products, alerts). New lot and serial rows are inserted before the positions that name them; a wait on a new row's unique index cannot close a cycle with that order.

## Why

- Keeping one balance table with lot, serial, and transfer in the identity means every movement, from receipts to transfers, uses the same locking, ledger, and checks.
- Computing expiry where it is read, in one function, is the only way the dashboard, the API, MCP, and the Shopify push can never disagree, and it keeps Neon free to sleep between the 30-minute crons.
- Component reservations for bundles keep "allocated equals outstanding allocations" true per variant, so reconciliation needs no bundle arithmetic.

## Revisit when

- Allocation over a variant with hundreds of lots misses the 500 ms target (plan risk R5): lock the candidates in one statement with a cap, then consider an advisory lock per variant and location.
- Per-channel pools need more than an ordered location list.
