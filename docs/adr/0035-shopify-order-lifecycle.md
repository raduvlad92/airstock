# 0035. Shopify order lifecycle: an order's state applied in one transaction

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan Section 5.14 (order flow), PRD 8.5, and decisions D6 and D17 (milestone I6). Builds on [ADR 0008](0008-shopify-sync.md), [ADR 0021](0021-shortages.md), [ADR 0029](0029-returns.md), and [ADR 0033](0033-shopify-mapping-and-onboarding.md).

**Summary:** Every order webhook, reconciler run, or push catch-up applies the order's whole state from Shopify in one `shopify.orders.sync` transaction; rows record what was applied (lines, reservations per line, fulfillments, refund lines, return dispositions), so the same state twice changes nothing; Airstock's record of Shopify's available follows every change Shopify makes itself

## Decision

- **State, not events.** A webhook only names an order (`orders/create` also carries its lines, enough for the reservation). The job reads the order from the Admin API (lines with current quantities, fulfillments, refunds, and, with `read_returns`, returns with their dispositions) and runs `shopify.orders.sync` as the connector. Webhooks arriving late, twice, or out of order all converge on the same result. The `shopify_orders` row is locked first and serializes syncs of one order.
- **What happens per line** (the connector's allocation rule, ADR 0033):

  | Shopify | Airstock |
  | --- | --- |
  | Order created | A reservation per line with `allowShortage`; what is short is a shortage (D6), never a refusal. A pack line reserves pack × quantity base units; a bundle line reserves its components, each with its own shortage. |
  | Order edited | Units still to ship rise: a new reservation for the difference. They fall: releases, newest reservation first. |
  | Order cancelled | Everything still open is released. |
  | Fulfillment created | Oldest reservation first. Allocations outside the fulfilling location's scope are reallocated into it as far as stock there allows, then fulfilled allocation by allocation inside the scope. Units Airstock does not hold there (an unmapped location, no stock) are released and counted, since they already left. A one-of-a-kind item becomes sold (ADR 0024). |
  | Fulfillment cancelled | Each fulfillment operation is reversed once (`reverses_operation_id`), back to the positions it left at the cost it left with; a sold one-of-a-kind item is active again. The units still to ship rise, so the line is reserved again. |
  | Refund with restock `return` (or legacy restock of shipped units) | A return for the line, authorized and received into quarantine at the mapped location's receiving location (ADR 0029), whatever Shopify's restock flag says. Lot- and serial-tracked units, and units at an unmapped location, wait for a person to receive them. |
  | Shopify return, disposed | Each disposition once (`shopify_return_dispositions`). Restocked, not restocked, or to be processed: units came back, so a return into quarantine as above. Missing: nothing came back. Refunds issued through the return leave stock to its dispositions. |

- **Units still to ship.** Shopify's current quantity leaves out refunded units, shipped or not. Units held = ordered after edits − shipped − refunds of unshipped units. A refund restocked as `cancel` is of unshipped units, one as `return` or through a return of shipped units; a refund without restock is counted against shipped units first, as Shopify counts its fulfillable quantity. A wrong guess there holds a unit too many, never too few.
- **Shopify's own changes to `available`.** Airstock's record of Shopify's quantity (`expected_available`, ADR 0008) moves with each change Shopify makes itself: an order line takes its units at the line's location, an edit that removes units and a restocking refund or disposition give them back. Each is counted once, from the line's `effect_items` or its refund or disposition row, and only when Shopify's change is newer than the record's last read. The levels are then pushed after commit, unless a stock change in the same transaction already announces them. So the compare-and-set push is never refused for a change Shopify made itself; a refused write still means something Airstock has not seen.
- **Before the connection.** Orders created before the store was connected stay Shopify's: their fulfillments, cancellations, and returns are not followed (ADR 0033).
- **Webhooks.** Topics `orders/create`, `orders/edited`, `orders/cancelled`, `fulfillments/create`, `fulfillments/update`, `refunds/create`, `reverse_fulfillment_orders/dispose` (its payload names the reverse fulfillment order; the job looks up its order), and `app/uninstalled`, each with `includeFields` limited to IDs and, for orders/create, the creation time and line items. The HMAC is checked on the raw bytes first (401 otherwise), receipts are unique by event ID, and each commits with its job row (ADR 0008). The mandatory privacy topics (`customers/data_request`, `customers/redact`, `shop/redact`) are verified, logged, and acknowledged: Airstock stores order and line references only, no customer data, and `shop/redact` comes after an uninstall that already cleared the tokens. They are configured on the app, not per store.
- **Scopes** (checked against Shopify's 2026-10 reference): `read_orders` for orders, edits, cancellations, and refunds; `read_fulfillments` for the fulfillment topics; `read_merchant_managed_fulfillment_orders` for where a line is committed (several mapped locations); `read_returns` for returns and dispositions. The Admin client skips a read whose scope the store did not grant, so a store that has not approved new scopes keeps syncing what it can.

## Why

- Applying state instead of replaying events makes duplicate, missed, and out-of-order webhooks one problem with one answer, and the reconciler reuses the same command.
- One transaction per order keeps reservations, stock, the ledger, the audit events, and the record of what was applied consistent: a crash leaves the order as it was, and the next run applies it whole.
- Shopify changes its own `available` for orders, edits, cancellations, and restocks. Following each of those keeps compare-and-set meaningful: only a quantity no one in Airstock explains is a conflict.

## Revisit when

Shopify adds an order or return path that changes `available` without a refund, edit, or disposition; a merchant needs returns received at a Shopify location that is not mapped; or orders with more than 100 lines, 10 fulfillments, or 10 refunds become common (the order read takes the first of each).
