# 0027. Purchase orders

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan decision D11, Section 5.8, and PRD 6.8 (milestone I3).

**Summary:** Orders with authoritative per-line ordered, received, and cancelled quantities in base units; receipts against a line run the normal receipt path at the line's cost; on order counts open lines of sent orders; the PDF is drawn in the Worker with the label fonts and emailed through Resend with a send log

## Decision

- **Records.** `purchase_orders` (supplier, destination warehouse, optional receiving location, expected date, supplier reference, notes, the shop currency, a per-shop number shown as `PO-0001`) and `purchase_order_lines` (variant, optional pack with its factor and version when written, supplier item and SKU, quantity as entered, unit cost per pack or per base unit). Each line keeps `ordered`, `received`, and `cancelled` in base units; they are authoritative (PRD 6.8). A draft's lines are replaced as a whole; after sending, only the expected date, supplier reference, and notes change.
- **Defaults from the supplier item.** A line without a pack takes the supplier item's pack (`packId: null` orders in base units), its supplier SKU, and its last cost, converted exactly when the line uses another pack. Entering a cost needs `costs.read`.
- **States.** `draft` → `sent` (send) → `partially_received` / `received` (receipts) → `closed` (close). `cancelled` from draft or sent while nothing was received. Close cancels the open remainder explicitly (`cancelled += ordered − received − cancelled`), and works on received orders too. Every state change emits the webhook `purchase_order.status_changed` (now available).
- **On order** is `greatest(ordered − received − cancelled, 0)` on lines of sent or partially received orders, per destination (`purchase_on_order()`), never sellable. `get_stock` reports it as `totals.onOrder` with the open orders, within the caller's location scope.
- **Receiving against a line** runs the receipt path (`receiveIntoStock`, shared with `inventory.receipts.create`): packs, lots and expiry, serials, conditions, shortage fills, and the moving average. The quantity is in the line's pack unless `inBaseUnits`. The line's cost per base unit is passed as an entered cost, so it reaches valuation even when an inventory operator without `costs.read` receives (the cost comes from the order, not the person). The operation records `supplier_id` and the order number as the receipt's reference, and lots received this way name their PO line (`lots.purchase_order_line_id`, G6).
- **Over-receipt.** Receiving more than the line still has open is refused (`over_receipt`, with the open, receiving, and over quantities) unless `confirmOverReceipt`; it is then recorded on the receipt (`purchase_order_receipts.over_received`) and shows on the line.
- **Lock order.** A PO receipt locks positions, reservations, and the cost row through the receipt path first, then the order and its line, and checks the state and the open quantity again under those locks (ADR 0006). A concurrent close or a second receipt therefore cannot let an unconfirmed over-receipt through; the whole receipt rolls back instead.
- **PDF.** Drawn in the Worker with `pdf-lib` and `fontkit`, A4 portrait, with the label fonts (ADR 0019) read through the static assets binding (`ASSETS`) and cached per isolate. The font code moved from the dashboard into `packages/pdf` (`@airstock/pdf`), which both use, so the shaping, script fallback, and glyph fixes are shared. Costs print only for members with `costs.read`; the supplier's email always has them. The download is `GET /api/v1/shops/{shopId}/purchase-orders/{id}/pdf`, which runs `purchasing.orders.get` (permission, location scope, access event) before drawing.
- **Send and the send log.** `send` with `email: true` (the default) queues a `po_sends` row and an `email.purchase_order` outbox event in the same transaction; the jobs consumer renders the PDF, emails it through Resend (ADR 0009) with the PDF attached and the sender as reply-to, and records `sent` with the provider's message ID, or `failed` when the provider refuses for good (a temporary error retries the job). `email: false` records a send made another way (`recorded`). Each outcome is an audit event.
- **Permissions.** `purchasing.manage` (owners and managers) drafts, changes, sends, closes, and cancels; reading orders needs `inventory.read`; receiving needs `inventory.receive`, so inventory operators receive deliveries. Over the API and MCP, commands need `inventory:write`. Orders are visible and changeable only when the caller's location scope covers the destination warehouse or the order's receiving location.
- **MCP.** `manage_purchasing` with `action` (list, get, draft, update, send, receive, close, cancel); the PDF itself is not an MCP result, the send emails it.

## Consequences

- The Worker bundle grows by pdf-lib and fontkit (about 4.8 MB uncompressed, 1.2 MB gzipped in total), under the Workers size limit. Noto Sans SC (10.5 MB) is read only for an order that needs CJK.
- Foreign-currency orders, approval chains, and supplier portals stay later (PRD 6.8).

## Revisit when

A supplier needs a different PDF layout per shop, orders need foreign currencies or landed costs (PRD Phase 4), or PDFs grow large enough to move rendering to a job with the file stored in R2.
