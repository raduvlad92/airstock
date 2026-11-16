# 0036. Shopify push in batches, conflicts as alerts, and the reconciler on the existing crons

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan Section 5.14 (push and reconciler), decisions D17 and D18, and PRD 8.5 (milestone I6). Builds on [ADR 0008](0008-shopify-sync.md), [ADR 0030](0030-reorder-rules-and-alerts.md), [ADR 0033](0033-shopify-mapping-and-onboarding.md), and [ADR 0035](0035-shopify-order-lifecycle.md).

**Summary:** The push collects the levels of every stock and map change in a queue batch and writes them per connection in `inventorySetQuantities` calls of up to 100 compare-and-set quantities; an unexplained difference becomes a `shopify_sync` alert and a `shopify.sync_conflict` webhook event, and the level is not pushed until it is resolved; the reconciler runs with the 30-minute and daily crons, applying orders Shopify changed since a cursor, then comparing levels

## Decision

- **Which levels.** A stock change (`inventory.availability_changed`) touches the items mapped to its variant, its packs, and the bundles that use it, at the Shopify locations whose scope holds the changed location (ADR 0033). A map change or an order sync names its levels (`shopify.levels.push`). The jobs consumer collects the levels of all such messages in its batch, per shop, and pushes each level once. If the push fails, every message that contributed retries.
- **One call per 100 levels.** Per connection, levels are sorted by item and location (the order their rows are locked in, so pushes and order syncs never deadlock) and written in `inventorySetQuantities` calls of up to 100 quantities, each with `changeFromQuantity` set to Airstock's record of Shopify's quantity (ADR 0008). The level rows stay locked during the call. Shopify applies a call whole or not at all: when some quantities are stale (its error paths name them), nothing is written, the others are retried, and the stale ones go through the P1 path: orders created since the record are processed, then the write is tried again; if no order explains the difference, it is a conflict.
- **Conflicts.** A conflict records Shopify's and Airstock's quantities on the level, opens one `shopify_sync` alert per level (dedupe key `shopify_conflict:<connection>:<item>@<location>`, filtered by the location map's scope), writes a `shopify.inventory.conflict` audit event, and sends the `shopify.sync_conflict` webhook event (now available to subscriptions). Nothing is written to Shopify, and the level is skipped by later pushes, so Shopify keeps the number a person set there until someone chooses a side (sync health) or the difference goes away. A new difference updates the record without a second alert.
- **The reconciler** (`reconcileShopify`, from the cron's internal reconcile call after the stock check, 20 seconds per run, least recently reconciled connection first):
  1. **Orders** Shopify updated since the connection's cursor (`orders_synced_through`, less 5 minutes because Shopify's search index trails), oldest first, each applied with `shopify.orders.sync` (ADR 0035), up to 250 per run. Missed and late webhooks for creations, edits, cancellations, fulfillments, refunds, and returns all land here. The cursor moves to the last order read, or to the run's start when there are no more pages.
  2. **Levels**: every 30 minutes those that may differ (Airstock's target is not the record, an open conflict, no record yet, or changed since the last run); daily, every mapped level. Shopify's quantities are read 25 items per call while the level rows are locked, so a push cannot land between the two reads. A difference is first explained with orders created since the record; what remains is a conflict. An open conflict whose difference is gone is resolved (`explained`).
  3. **Pending pushes**: levels whose target differs from the record, and levels whose conflict was explained, are pushed.
  The connection keeps `reconciled_at`, `levels_compared_at`, `last_pushed_at`, and the last error for sync health.
- **Rate limits.** The Admin client waits when Shopify answers `THROTTLED` for the time its restore rate needs to refill the call's cost (250 ms to 10 seconds, three times) and on HTTP 429 for `Retry-After`; after that the error is retryable and the queue retries the messages with backoff. Batching keeps the number of calls low: one write per 100 levels, one read per 25 items.

## Why

- One compare-and-set call per 100 levels instead of one per level keeps a busy receipt (a delivery of 300 SKUs) at three calls, well inside Shopify's cost limits, while keeping the per-level check that makes P1 safe.
- An alert and a webhook event make a conflict visible where people already look (the alerts list, email, n8n), and skipping the level means Airstock never overwrites what a person did in Shopify without a decision.
- Applying orders by Shopify's update time catches every kind of missed webhook with the same idempotent command, and running with the existing crons keeps Neon able to scale to zero (D18).

## Revisit when

Shopify changes `inventorySetQuantities` or its error paths, a store's order volume needs more than 250 orders per 30 minutes, or catalogs make the daily comparison longer than one run (then keep a cursor for it).
