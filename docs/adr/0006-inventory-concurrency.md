# 0006. Inventory concurrency and expiry

**Status:** Accepted, 14 November 2026. Implements PRD 6.1 and 6.3 for receive, reserve, and release.

**Summary:** Position locks in id order, a database check on allocations, lazy expiry

## Decision

- **Lock order.** Every stock command locks `inventory_positions` rows in ascending id order, then `reservations` rows, then anything else. Allocations at a position change only while that position is locked.
- **Allocation.** A reservation locks the candidate positions, picks quantities greedily in location-path order in one SQL statement, and fails as a whole if the total is short (no partial reservation). `allocated <= on_hand` is also a database check constraint, the last defence against negative availability.
- **Lazy expiry.** Before allocating, a command releases the expired allocations on the positions it has locked, in its own transaction. Availability reads subtract expired allocations as well. A late sweeper therefore never keeps expired stock unavailable (PRD 6.3). The sweeper (`sweepExpiredReservations`, every minute) only tidies state.
- **Idempotency.** The key is claimed with an insert at the start of the transaction; a concurrent duplicate waits on the unique index and then replays the committed result. Keys are bound to shop, caller, and operation, and a reused key with a different request is rejected (PRD 8.3).
- **Ledger.** Physical changes are append-only `inventory_entries`; claims live in `reservation_allocations`. `reconcile()` in the tests checks both against the position balances after every scenario (A21).

## Evidence

`packages/core/test/concurrency.test.ts` (50 callers racing for 10 units, mixed releases and receipts), `idempotency.test.ts` (50 replays, 50 concurrent duplicates), and `property.test.ts` (random sequences with reconciliation after each step).

## Update, 16 November 2026 (Phase 2, milestone I1)

The Phase 2 commands keep this lock order ([ADR 0020](0020-stock-model.md)): receipts (also into lots and serials, filling shortages), reservations of variants and bundles, release, fulfillment, and reallocation lock positions by ID, then reservations by ID (a bundle header with its components, and expired reservations with the ones a command acts on, in one ordered statement), then the variant's cost row and anything else. Stock commands also take a key-share lock on the variant first, which only a change of tracking mode conflicts with. The sweeper runs every 30 minutes, not every minute. `reconcile()` now runs the SQL check the scheduled reconciliation uses (`stock_reconciliation_problems`), which also covers reservations, bundle components, serials, and owned quantities. `stock-concurrency.test.ts` races fulfillment against expiry (A08), lots, serials, bundles, one-of-a-kind receipts, and receipts filling shortages.

## Revisit when

Transfers arrive in milestone I2: dispatch and receipt must follow the same lock order.
