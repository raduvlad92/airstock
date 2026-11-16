# 0028. Transfers: holds as typed reservations, transit positions per transfer, the transfer row locked first

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan decision D8, Section 5.4, and PRD 6.4 (milestone I2). Builds on [ADR 0006](0006-inventory-concurrency.md) and [ADR 0020](0020-stock-model.md).

**Summary:** A ready transfer holds stock with one reservation of purpose `transfer` per line; dispatch consumes it into in-transit positions that name the transfer; per-line quantities are authoritative and the status is derived from them; transfer commands lock their transfer row first, then follow ADR 0006

## Decision

- **Records.** `transfers` (source and destination locations, reference, tracking reference, note, summary status, exception flag) and `transfer_lines`, one line per variant, with `planned`, `cancelled`, `dispatched`, `received`, and `resolved` in base units. Held is `planned − cancelled − dispatched`; in transit is `dispatched − received − resolved`. Check constraints keep `cancelled + dispatched ≤ planned` and `received + resolved ≤ dispatched` (PRD 6.4 step 6). A line can name a lot or exact serials, and keeps the pack it was entered in, the pack version, and its factor.
- **Status from quantities.** After every command the status is recomputed: draft until ready; then ready, partially dispatched, dispatched, partially received, received, or cancelled from the line totals. `exception` is set by a person reporting missing or damaged units and lasts while anything is in transit. The status never hides a mixed line: every read returns each line's quantities.
- **Ready** places one reservation per line, purpose `transfer`, limited to the source, with allocations on concrete positions in the transfer's condition: earliest expiry, then oldest stock, then location path. Expired lots are held only when the line names the lot. Locations that are not fulfillment-eligible can still send stock. The hold uses the same allocation accounting as orders, so `stock_positions()` and every reservation see it (A24). Ready fails whole when any line is short.
- **Holds change only through their transfer.** `manage_reservations` refuses to release, fulfill, or reallocate a reservation of purpose `transfer` (`reservation_is_transfer`), so line quantities and allocations cannot drift apart.
- **Dispatch** consumes the line's allocations (as fulfillment does) and moves the units into in-transit positions at the shop's in-transit location, keyed by variant, condition, lot, serial, and transfer. Lots and serials travel on those positions; serial units become `in_transit`. A scanned serial that is free at the source takes the place of a held one, so the picker never has to find the serial ready happened to pick.
- **Receipt** moves actual quantities from transit into destination positions, at the destination or a shelf inside it, optionally in another condition (units that arrived damaged). Sellable units fill open shortages first, in the same transaction (ADR 0021). The units keep their age: a destination position takes the oldest `received_at` of what it holds.
- **Cancel** releases the hold on the undispatched remainder; a draft line simply shrinks. Dispatched units stay in transit until they are received or resolved.
- **Exceptions.** `report_exception` flags the transfer with a note and moves no stock. `resolve` settles in-transit units that will not arrive (`lost`, `short`) or were destroyed (`damaged`) with an adjustment out of transit at the moving average (reasons loss or theft, and damage), and writes their serials off.
- **Move within a warehouse** (D8) is one command that creates, readies, dispatches, and receives a transfer of kind `move` in one transaction, through the same code, so a move has the same ledger, holds, and history as any transfer. Both locations must be in one warehouse.
- **Costs.** Transfers do not change cost: in-transit stock stays owned, so the owned quantity behind the moving average is unchanged and transfer entries record no unit cost. Only a resolution leaves owned stock, at the average (ADR 0022).
- **Location scope (PRD 2.4).** Ready, dispatch, and cancel need the source in scope; receipt needs the destination (or the named shelf). Create, reading, reporting an exception, and resolving need either end. Lists show transfers that touch a location in scope.
- **History.** Every stock operation of a transfer names it (`inventory_operations.transfer_id`), so a transfer's history, a lot trace, and a serial's history show each dispatch and receipt. `transfer.status_changed` webhook events are written with each status change, in the same transaction (ADR 0023).

### Lock order

A transfer command locks its transfer row first. Only transfer commands lock transfer rows, and always before anything else, so no transaction that holds a position or reservation ever waits for one: no cycle can form. After that, ADR 0006 holds: variants (key share), positions by id in one statement (source positions, the transfer's in-transit positions, and the destination's existing positions), then reservations by id in one statement (the line holds, expired claims at those positions, and open shortages the receipt may fill), then `variant_costs` and serial units. In-transit positions change only under their transfer's lock, since reservation, count, and adjustment commands never touch positions with a transfer. A count may move a transfer hold to another source position (reallocation); dispatch and cancel re-read the hold's positions after locking and ask the caller to retry if one moved.

## Why

- Using reservations for holds means the existing availability rule, reconciliation, and reservation reads cover transfers with no second accounting.
- In-transit positions per transfer keep conservation a ledger fact: the units leave the source and enter transit in one operation, and the transfer's in-transit total always equals its lines' (checked by `transfer_reconciliation_problems()`).
- Locking the document first serializes commands on one transfer without reordering the stock locks every other command already takes.

## Update, 16 November 2026: review fixes (PR #73 findings)

- **Locations are share-locked.** A receipt and a move share-lock the destination they load (`destinationLeaf`), and creating a transfer or a move share-locks both locations, as every command that brings stock in does. An archive, which locks the location and then checks it, waits for them instead of passing its check while units land.
- **No archive with units on the way.** Archiving a location or warehouse is refused with `transfers_inbound` while an open transfer to it has units not yet received or resolved; they would otherwise stay in transit to an archived location.
- **A scanned lot without a quantity** takes that lot's remainder on the line (held at the source for a dispatch, in transit for a receipt or a resolution), not the line's remainder across lots.
- **Receipts do not make units sellable.** Receiving units sent in another condition (quarantine, damaged) as sellable is refused with `condition_change_required`: that is a condition change, with its permission and reason. Receiving them in a worse condition (arrived damaged) is unchanged.
- **Exceptions and location scope.** Report and resolve check that either location is in scope in the handler. Their `locations` hook returns no locations, so the attempt and a failure stay hidden from members limited to other locations; the outcome names both.
- **Dispatch keeps returns' units.** A dispatch that would take a return's uninspected units out of quarantine is refused (ADR 0029).

## Revisit when

Transfers need partial lines per lot (one line per variant today), carrier integrations, or a recovery flow that returns in-transit units to the source without an adjustment.
