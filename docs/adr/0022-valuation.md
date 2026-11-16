# 0022. Valuation: moving average per variant, history rows for any date

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan decision D7, Section 5.10, and PRD 6.11 (milestone I1).

**Summary:** One moving average per variant per shop over owned stock, kept with the owned quantity in a locked `variant_costs` row; every entry stores the unit cost it applied; one history row per change makes value at any past moment and cost of goods reproducible; half-even rounding at 6 places

## Decision

- **Where.** `variant_costs` holds, per variant, the owned quantity (on hand in every condition plus in transit), the moving average, and an optional default cost. `apply_stock_cost()` is the only writer: it locks the row (the last step of the lock order), applies the change, and writes a `variant_cost_history` row. The reconciliation check compares the owned quantity with the positions.
- **Receipts.** A receipt with a cost (per base unit, or per pack and divided exactly by the pack's factor) moves the average: `(quantity × average + received × cost) ÷ (quantity + received)`. Without a cost, units come in at the default cost when the variant has no stock, else at the current average, which then does not change. When no cost is known at all, the entry records none and the average stays unknown; the first costed receipt sets it.
- **Out.** Fulfillments (and, from I2, adjustments out and disposals) remove units at the current average. Transfers do not change cost. A bundle's cost is the sum of its components' costs at fulfillment.
- **Every entry stores its unit cost** and where it came from (`cost_basis`: entered, average, default, none).
- **Value at any moment.** Each history row has the owned quantity and the average after the change, stamped with the time the row lock was held (`clock_timestamp()`), so concurrent changes are ordered as they happened. The value at a moment is, per variant, the latest row before it: quantity × average. Cost of goods for a period sums the fulfillment entries in it, each at its stored cost. Asking again later gives the same answer (A39).
- **Rounding.** Costs are `numeric(20, 6)` and the average is rounded half to even at 6 places (`round_half_even`, since PostgreSQL's `round` rounds halves away from zero). Values are exact products; they are rounded to cents only for display.
- **Who sees costs.** `costs.read` (owners and managers). Without it, stock views say `costVisible: false` and leave costs out, entering a cost on a receipt or a default cost is refused, valuation is refused, and activity hides the values (`changes.restricted`). Valuation is shop-wide, so members limited to some locations cannot run it; per-location value reports come with I5.

## Why

- A single locked row per variant serializes average updates without locking the variant's positions against each other, and keeps value reproducible without replaying the ledger.
- Storing the cost on every entry means cost of goods never depends on recomputing the average later.

## Update, 16 November 2026: units in before units out

An adjustment, count, or reversal costs each variant's units in before its units out (`applyChanges`). Units that only change shelf in one operation (a count that finds the shelf's units on another shelf) then come in at the average and leave at it, so the average stays. Costing the outs first took the owned quantity through zero, and the ins then took the default cost although no unit entered or left the shop. The formula is unchanged.

## Revisit when

FIFO valuation, landed costs, per-warehouse costs, or foreign-currency purchase orders arrive (PRD Phase 4).
