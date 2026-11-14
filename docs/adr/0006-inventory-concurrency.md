# 0006. Inventory concurrency and expiry

**Status:** Accepted, 14 November 2026. Implements PRD 6.1 and 6.3 for receive, reserve, and release.

## Decision

- **Lock order.** Every stock command locks `inventory_positions` rows in ascending id order, then `reservations` rows, then anything else. Allocations at a position change only while that position is locked.
- **Allocation.** A reservation locks the candidate positions, picks quantities greedily in location-path order in one SQL statement, and fails as a whole if the total is short (no partial reservation). `allocated <= on_hand` is also a database check constraint, the last defence against negative availability.
- **Lazy expiry.** Before allocating, a command releases the expired allocations on the positions it has locked, in its own transaction. Availability reads subtract expired allocations as well. A late sweeper therefore never keeps expired stock unavailable (PRD 6.3). The sweeper (`sweepExpiredReservations`, every minute) only tidies state.
- **Idempotency.** The key is claimed with an insert at the start of the transaction; a concurrent duplicate waits on the unique index and then replays the committed result. Keys are bound to shop, caller, and operation, and a reused key with a different request is rejected (PRD 8.3).
- **Ledger.** Physical changes are append-only `inventory_entries`; claims live in `reservation_allocations`. `reconcile()` in the tests checks both against the position balances after every scenario (A21).

## Evidence

`packages/core/test/concurrency.test.ts` (50 callers racing for 10 units, mixed releases and receipts), `idempotency.test.ts` (50 replays, 50 concurrent duplicates), and `property.test.ts` (random sequences with reconciliation after each step).

## Revisit when

Transfers and fulfillments arrive in Phase 2: they must follow the same lock order.
