# 0028. Returns: quarantine on receipt, inspection by condition, cost back at the fulfillment cost

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan decision D9, Section 5.5, and PRD 6.5 (milestone I2). Builds on [ADR 0020](0020-stock-model.md), [ADR 0022](0022-valuation.md), and [ADR 0027](0027-transfers.md).

**Summary:** Requests and authorizations change no stock; receipt puts units in quarantine at one receiving location with their lots and serials; inspection moves them to sellable, damaged, repair, or supplier return, or writes them off; returned units re-enter valuation at the cost they were fulfilled at, else the moving average; a serial not fulfilled here is received and flagged

## Decision

- **Records.** `returns` (order and fulfillment references, RMA reference, reason, status, receiving location, review flag), `return_lines` (one per variant: expected, received, and the quantity per disposition), `return_units` (per lot or serial: received, inspected, whether a serial matched, and the cost it re-entered at), and `return_inspections` (one row per decision, insert-only). Checks keep `received ≤ expected` and dispositions `≤ received`; `return_reconciliation_problems()` checks that units and inspections add up to their lines.
- **States.** Requested, authorized, and in transit are explicit steps that move no stock. After that the status follows the quantities: received (nothing inspected yet), inspecting, completed (everything received was inspected and everything expected arrived, or the return was closed early with `complete`). Cancel works only before anything arrives. `exception` lasts while the review flag is set.
- **Receipt.** Units go to `quarantine` at a leaf location in any warehouse; a return keeps the location of its first receipt, so its units are found again for inspection. Quarantine is never sellable, so nothing becomes available yet. Lot-tracked units name a lot this shop received; serialized units are given by serial.
- **Serials (PRD 6.7).** A serial whose unit is `sold` matched a fulfillment from this shop and goes back in stock. An unknown or written-off serial is still received (the item is physically here) but flagged: the return goes to `exception` with a note until a person reviews it and clears the flag. A serial still in stock or in transit is refused: it cannot be in two places.
- **Inspection** moves units out of quarantine: to `sellable`, `damaged`, `repair`, or `supplier_return` at the same location (a condition change: on hand and value unchanged), or `disposal`, an adjustment out (reason write-off) at the moving average with serials written off. Only units released to sellable add to availability, and they fill open order shortages first (ADR 0021). Returns never issue refunds; refunds belong to the sales channel.
- **Cost (decision).** Returned units re-enter the moving average at the unit cost of the fulfillment entries they left with, so cost of goods reverses exactly: for a serial, its last fulfillment; otherwise the quantity-weighted cost of the variant's fulfillments for the return's order reference (and lot, when given). When that cannot be traced (no order reference, no costed fulfillment), they come back at the current average (or the default cost while there is no stock), which leaves the average unchanged. The traced cost is passed to `apply_stock_cost()` as an entered cost, so the entries say `entered`; `return_units.cost_source` says `fulfillment` or `average`. Costs are shown only with `costs.read`.
- **One of a kind (D5).** A returned one-of-a-kind item goes from `sold` back to `active`, as a receipt does, and the one-unit limit is checked in the same transaction.
- **Location scope.** Receipt needs the receiving location in scope, inspection the return's location. Returns not yet received touch no location, so any member with `returns.manage` can create, authorize, or cancel them; once received, only members with that location in scope can act on or see them.
- **History.** Every stock operation of a return names it (`inventory_operations.return_id`): the receipt (kind `return`), condition changes, and disposals, so lot traces and serial histories show each step. `return.status_changed` webhook events are written with each status change, in the same transaction.

### Lock order

As for transfers: the return row first (only return commands lock it), then variants (key share), positions by id (the quarantine positions and the existing positions the units go to), reservations by id (open shortages a release to sellable may fill), then `variant_costs` and serial units. New serial units for unknown serials are inserted before the positions that name them.

## Why

- Quarantine on receipt keeps a returned item out of availability until a person has looked at it, which is the point of inspection.
- Reversing cost of goods at the fulfillment cost keeps valuation honest when the average moved between sale and return; falling back to the average never invents a cost.
- Receiving an unmatched serial instead of refusing it matches what happens at the bench: the box is here and must be accounted for, but someone has to look at it.

## Revisit when

Returns need restocking fees, refunds, exchanges, or receipt at several locations for one return.
