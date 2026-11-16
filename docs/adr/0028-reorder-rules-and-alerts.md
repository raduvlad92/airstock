# 0028. Reorder rules and alerts

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan decision D12, Section 5.9, and PRD 6.8 (draft from low stock) and 6.9 (milestone I3).

**Summary:** Reorder rules per variant and warehouse or location; low stock and shortages checked in the transaction that changes stock or on order, after its locks, one open alert per key; notifications through the outbox to the app, email, webhooks, and MCP; lots nearing expiry and a re-check in the daily job; members choose kinds and channels within their location scope

## Decision

- **Rules.** `reorder_rules`: a variant at a warehouse, or at one location in it, with a reorder point and exactly one of a reorder quantity or a maximum level (above the point), and an optional preferred supplier. One active rule per place. Changing a rule is an audit event; removing it archives the row and resolves its open alert (`rule_removed`).
- **Low stock.** A rule is low when available (the shared `stock_positions` rule, ADR 0020) plus on order (`purchase_on_order`, ADR 0027) in its warehouse or location is at or below the point. On order counts, so placing an order stops the alert repeating (PRD 6.9).
- **Where it is checked.** The pipeline, after a command's handler and before its success event, reads the command's `inventory.availability_changed` outbox rows (every stock command already writes them), the variants a purchase order's send, close, or cancel changed on order (`alertCheck` in the handler result), and new shortages (`inventory.shortage_opened`). With rules or open shortage alerts for those variants it runs one read of rule states and, only when something changes, one statement that opens and resolves alerts. Alerts are last in the lock order, after positions, reservations, and cost rows (ADR 0006). Shops without rules pay one index probe.
- **One open alert per key** (`low_stock:<rule>`, `shortage:<variant>`, `lot_expiring:<lot>`, and I1's `reconciliation`), held by the partial unique index on open alerts: a concurrent opener waits on it, then does nothing. An alert stays open (or acknowledged) until its condition clears, then resolves by itself with a resolution (`recovered`, `filled`, `sold_out`, `reconciled`, `rule_removed`). Falling again opens a new alert.
- **Never for stock that did not commit (A11).** The alert row, its `alert.opened` or `alert.resolved` outbox row, the audit event, and the webhook event are written in the command's transaction.
- **Kinds.** `low_stock`; `lot_expiring` from the daily job (lots with stock expiring within the shop's `lot_expiry_alert_days`, 30 by default; resolved when the lot's stock is gone); `shortage` (one per variant while connector orders wait, resolved when filled); `reconciliation_mismatch` (written by I1's stock check, surfaced here); `shopify_sync` is reserved for I6. The daily job also re-checks every rule and shortage, which catches stock changed outside a command (an import's opening stock) and the rare race where two transactions on different positions of one variant each see the other's state before it commits.
- **Scope.** An alert stores the scope path it is about (a warehouse ID, or a location's path). A member sees it when that overlaps their location scope; shop-wide alerts (shortages, the stock check) need every location. Lists, counts, acknowledgement, and emails apply this.
- **Channels.** In the app: the Alerts page and a badge counting open alerts of the kinds the member follows. Email: the jobs consumer reads `alert.opened` from the outbox and emails each member who receives that kind (a preference row, or by default owners and managers), within scope, once per opening, recorded in `notifications` before sending and keyed for Resend's idempotency. Webhooks: `alert.opened` and `alert.resolved` are now available, filtered by alert kind and location (ADR 0023). MCP: `stock_alerts` (list, summary, acknowledge, get and set preferences).
- **Acknowledgement** (`alerts.manage`, owners and managers) marks an alert seen; it stays listed until it resolves.
- **Preferences.** `alert_subscriptions` per member and kind: in the app (the badge) and by email. The shop's lot window is a dashboard setting (`alerts.settings.set`, an MCP exception like other shop settings).
- **Draft from low stock** (`suggest_from_low_stock`, a read) proposes one purchase order per preferred supplier and warehouse: the reorder quantity, or the amount up to the maximum level, minus what is already on order, rounded up to whole packs of the supplier item and to its minimum order quantity (base units round up to the variant's decimal places). The supplier is the rule's preferred supplier, else the variant's preferred supplier item; rules with neither are listed apart. A location rule is left out when the same variant has a warehouse rule there. Nothing is saved until the person reviews and drafts each order.

## Why

- Checking where availability is already announced covers every stock command, today's and I2's, without each one calling the check, and keeps the comparison in the transaction that changes the stock.
- Emitting through the outbox reuses the delivery path the invitations and webhooks already have: retries, idempotency, and nothing sent for a rolled-back change.

## Revisit when

A shop's rules per variant number in the hundreds and the check shows in command timings, members want digests instead of one email per opening, or alerts need snoozing or assignment.
