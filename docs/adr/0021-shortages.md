# 0021. Shortages: only connectors, filled oldest first by receipts

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan decision D6 and PRD 8.5 (milestone I1).

**Summary:** Only connector callers reserve with a shortage; receipts fill open shortages oldest first in their own transaction (a shop setting), a 30-minute sweep catches the rest; availability never goes below zero

## Decision

- **Who.** A reservation may record a shortage only when the caller is a connector (`allowShortage: true` from a caller of kind `connector`, such as the Shopify order job). Shopify has already accepted the order, so rejecting it would lose demand. Every other caller gets `insufficient_stock` and nothing is reserved (PRD 6.1, rule 5).
- **What is stored.** The reservation allocates what is available under its limits (location, lot, channel rule) and keeps the rest in `shortage_quantity`. A bundle records a shortage per component reservation. Connector reservations never expire.
- **Visible and counted.** `get_stock` reports the variant's open shortage next to availability, which stays at zero or above (shown and pushed). `manage_reservations` lists shortages per reservation and per variant. Each new shortage writes an `inventory.shortage_opened` outbox event; milestone I3 turns it into an alert.
- **Filled by receipts.** A receipt into sellable stock fills the variant's open shortages in the same transaction, oldest reservation first, taking only positions each reservation's limits allow. The shop setting `fill_shortages_on_receipt` (default on, in the dashboard's stock settings) turns this off; the shortages then wait for a person to act.
- **Released first.** Releasing a reservation releases its shortage before its allocations (`shortage_released`), as when an order line is cancelled while short.
- **The sweep.** A receipt that creates a brand-new position cannot be seen by an order reserved at the same moment, so that order's shortage could stay open while stock is free. A connector reservation also locks the variant's empty positions, so it waits for a receipt already in progress at an existing position. For the first case, `sweepShortages` runs with the 30-minute cron and fills open shortages from available stock, honouring the same setting and limits.

## Why

- Only the channel that already took the money can create demand without stock; anything else would let the API oversell.
- Filling in the receipt's transaction keeps "available" honest at once: the units a receipt brings go to the orders that were waiting for them, before anyone else can reserve them.

## Revisit when

Several channels compete for the same shortages and need priorities other than age, or a merchant wants backorders for direct API callers.
