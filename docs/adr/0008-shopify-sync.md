# 0008. Shopify sync: orders to reservations, compare-and-set availability push

**Status:** Accepted, 14 November 2026. Implements plan Section 8 (M6) and the P1 finding.

## Decision

- **Install.** Authorization-code grant for a non-embedded app, started from the dashboard for one shop. The sealed flow cookie holds the OAuth `state`, the shop, the store domain, and the signed-in user; the callback checks Shopify's HMAC, the timestamp (10 minutes), the state, and that the same user is still signed in. An install link made by one user therefore cannot connect a store to that user's shop from someone else's browser.
- **Tokens.** Expiring offline tokens (`expiring=1`): a one-hour access token and a 90-day refresh token. Shopify requires these for public apps from 2027, so Phase 0 starts with them. Both are stored AES-256-GCM encrypted with a key ID; the associated data names the shop, store, and token kind, so a ciphertext copied to another row does not decrypt. A refresh happens under a row lock, so concurrent jobs rotate the pair once. Uninstalling clears both.
- **One store, one shop.** A partial unique index keeps a store domain active in one shop at a time, so its webhooks have exactly one destination.
- **Webhooks.** `orders/create` (trigger confirmed by the owner) and `app/uninstalled`, subscribed per store at install with `includeFields` limited to IDs, the creation time, and line items. The HMAC is checked on the raw bytes before anything is recorded or queued; a failure is a 401 (P3). The receipt is unique per connection, topic, and `X-Shopify-Event-Id`, and commits together with its job row; the queue message is sent after commit, and a cron sweep re-sends jobs whose message was lost.
- **Orders.** The job reserves each mapped line as the Shopify connector, at the mapped location, with external reference `shopify:order/{order}/line/{line}` and an idempotency key derived from the connection and line. A repeated webhook, a retried job, and a catch-up from the push all land on the same reservation (A30).
- **Connector identity.** The connector is a caller of kind `connector` with a fixed permission set (read, reserve, `integrations.sync`) and scopes, bound to the connection's shop. It never acts for a person. Audit events carry actor `connector`, the connection ID, and source `shopify`.
- **Push with compare-and-set (P1).** For each mapped item and location Airstock keeps `expected_available`: what it believes Shopify's `available` is. A successful push sets it; each processed order line lowers it, because Shopify lowered its own quantity when it accepted the order. The push sends it as `changeFromQuantity` (API 2026-10), holding the level row lock during the call. When Shopify refuses (`CHANGE_FROM_QUANTITY_STALE`), the push lists orders since the last known state, processes any it has not seen, and retries. Only a difference that no order explains becomes a conflict: an audit event `shopify.inventory.conflict`, a flag on the level, and Shopify left untouched. Conflict resolution UI is Phase 3; mapping again takes Shopify's current quantity as the new starting point.
- **First push.** With no expected value yet, the push first processes orders since install, then reads Shopify's quantity and records the time of the read (`expected_as_of`). An order lowers the expected value only if Shopify created it after that time, so an order already counted in the read is not counted twice.
- **Integration callbacks.** Connecting a store, recording install details, recording a webhook, and marking an uninstall are operations that run through the pipeline (permission, attempt and outcome events, one transaction) but are not in the registry: only the install callback and verified webhooks call them, so they have no REST route or MCP tool. `shopify.connections.list` and `shopify.mappings.set` are registry operations with a temporary MCP exception until the Phase 3 sync tool.

## Consequences

- The push holds a database connection during one Shopify call per level. Acceptable at Phase 0 volumes; revisit with batching (`inventorySetQuantities` takes many quantities) when catalogs grow.
- Shopify's `created_at` has second precision, so an order placed within the same second as the first read can be counted wrongly. The compare-and-set then refuses the next write and the difference is reported as a conflict, never written over.
- An order Airstock cannot cover (`insufficient_stock`) is recorded on the order line as a shortage, and the failed reservation's audit event shows it. Shortage reservations (A29), cancellations, and fulfillment are Phase 3.
- Mapping makes Airstock the source of truth for that location: the first push replaces Shopify's quantity with Airstock's.

## Evidence

`apps/worker/test/shopify.test.ts` against a fake store that commits units on order and enforces `changeFromQuantity`: install checks, order to reservation, duplicate webhook (A30), bad HMAC (P3), two stores and two shops (A13), the P1 race (a pending push meets an order Shopify already accepted: the stale write is refused, the order is processed, and Shopify never shows the higher number), an unexplained edit (conflict, Shopify untouched), one token refresh under concurrency, and uninstall. `packages/shopify/test/crypto.test.ts` covers the HMAC checks and token encryption. The staging run is recorded in the Phase 0 status.

## Revisit when

Shopify changes the inventory mutation again, catalogs need batched pushes, or Phase 3 adds cancellations, fulfillment, and the reconciler.
