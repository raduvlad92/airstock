# 0030. Counts and adjustments: counted basis per line, review after a movement, explicit choices below reserved

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan decision D10, Section 5.6, and PRD 6.6 (milestone I2). Builds on [ADR 0020](0020-stock-model.md), [ADR 0022](0022-valuation.md), and [ADR 0028](0028-transfers.md).

**Summary:** A count line keeps the position's version, on hand, and ledger length when counted; a new ledger entry before submit means the line needs review (keep the count, apply the movements, or recount); submit and every adjustment that would leave fewer units than reserved need a release or reallocate choice per claim; a quick count is one command; reversals are linked operations, once each

## Decision

- **Sessions.** `count_sessions` cover a location (with its sub-locations), chosen variants there, or chosen positions, optionally blind (expected quantities are hidden until submit). `count_lines` are created for every stocked position in scope; recording a count for an item the session did not list adds a line (found). Recounting a line replaces it.
- **The counted basis.** Recording a line stores the position's `version` (as the plan asks), its on hand, and the number of ledger entries at that moment. The version also changes when only claims change (a reservation, a release), which does not invalidate a count, so the test for "the position moved" is a new ledger entry. Reads show, per line, whether it needs review and the movements since it was counted.
- **Review.** Submit refuses with `count_needs_review`, listing the lines and the on hand then and now, until each moved line has a decision: `keep_count` (the count is the truth now) or `apply_movements` (the count was right when taken, so the movements since are added to it), or the line is recounted. The check runs after the positions are locked, so a movement cannot slip in between.
- **Posting.** Submit sets each counted position to its target, posted as one operation of kind `count` with the reason `count_correction`. Uncounted lines change nothing. Lines keep the delta they posted.
- **Below reserved (PRD 6.6).** A count or adjustment that would leave a position with fewer units than its outstanding claims is refused with `below_reserved`, listing each claim (reservation, purpose, external reference, outstanding). The caller retries with `reservationChoices`: `release` (part or all of a claim) or `reallocate` (move it to free stock the claim may use: its own location and lot limits and channel rule). A transfer hold cannot be released here, only reallocated within the transfer's source; to reduce it, cancel on the transfer. Nothing is released silently, a choice that is not needed is refused, and `allocated ≤ on_hand` remains the last defence.
- **Quick count.** One command creates a session, counts, and submits: a quantity typed for a location in the dashboard, a scan, or "I counted shelf B2: 4 of X and none of Y" through MCP (`adjust_stock`, action `count`). Lot-tracked items name the lot (or the only lot on the shelf); serial-tracked items list the serials present, so missing ones are written off and unknown ones are found.
- **Adjustments** need a reason from the plan's list (count correction, damage, loss or theft, found, write-off, sample, supplier return, other with a note), stored as the operation's reason. Packs convert exactly and are recorded on the entries.
- **Condition changes** move free units between conditions at one location without changing on hand or value; reserved units must be released or reallocated first. Units moved to sellable fill open shortages (ADR 0021).
- **Costs.** Units out leave at the moving average; units found come in at the average (or the default cost without stock), which leaves the average unchanged (ADR 0022).
- **Reversal** is a new operation of kind `reversal` naming the original (`reverses_operation_id`, unique, so an operation is reversed once). It applies the opposite of each entry; units that come back re-enter at the cost they left with, so value is restored exactly; units removed again leave at the average. Condition changes reverse by moving the units back. Receipts, fulfillments, transfers, and returns are not reversed this way: they have their own steps, and reversing their stock alone would break their documents.
- **Location scope.** Every count and adjustment touches named locations, which must be in scope; sessions and their lines are visible only to members whose scope covers the session's location.

### Lock order

A session command locks its session row first (only count commands lock it). Then, as ADR 0006: variants (key share), positions by id in one statement (the counted or adjusted positions and, when a claim is to be reallocated, the free stock it may move to), reservations by id in one statement (the claims on those positions and open shortages), then `variant_costs` and serial units. The targets and review checks are computed only after these locks are held.

## Why

- Comparing ledger length rather than the version alone keeps reservation churn from forcing reviews on a busy shelf, while still catching every physical movement.
- Asking per claim instead of shrinking reservations keeps an order from losing its units without someone deciding it.
- Making the quick count the same engine as sessions means the grid, the scanner, and an assistant all post the same history.

## Revisit when

Counts need cycle-count scheduling, recount thresholds, or counting offline (PRD Phase 4).
