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

## Update, 16 November 2026 (Phase 2, milestone I7): idempotency retention

- **Records are kept 7 days.** Every command stores its whole response in `idempotency_records`, about 1.6 KB, and nothing deleted them: at the I7 volume run's pace that is about 190 MB a quarter for six shops (`docs/phase-2-measurements.md`, "I7 volume run"). The daily cron (03:00 UTC) now runs `sweepIdempotencyRecords`, which calls `delete_old_idempotency_records(days, batch)` (migration 0080) for records created more than 7 days ago: 5,000 per short transaction, at most 40 batches a run, the oldest first. The next day's run continues where a capped one stopped, and Neon can scale to zero between runs.
- **A replay after the window is a new request.** Within 7 days a retry with the same key replays the original result, as before. After that the key is forgotten: the same key and request run again as a new command, and `get_operation_outcome` (`GET /operation-outcomes`) answers `not_found`. Callers retry lost responses within minutes, so the window covers them with a wide margin. The API reference (`Idempotency-Key`), the outcome lookup, and the MCP `idempotency_key` field say so.
- **Imports are unaffected.** Opening stock claims a key per import row and location in the same transaction as the chunk's checkpoint, so a resumed import starts after the checkpoint; the key is a second guard, and an import resumes within minutes (`stale_imports`).

## Revisit when

Transfers arrive in milestone I2: dispatch and receipt must follow the same lock order.
