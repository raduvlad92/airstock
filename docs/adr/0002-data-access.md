# 0002. Data access: plain SQL, tenant context per transaction

**Status:** Accepted, 14 November 2026. Resolves the PRD's open "Postgres query library" decision for Phase 0.

**Summary:** Plain SQL over `pg`, no query builder; tenant context per transaction; row-level security

## Decision

- Queries are parameterized SQL strings run through a small `Database`/`Tx` interface over `pg` (node-postgres), in Node and in Workers behind Hyperdrive. No ORM or query builder in Phase 0.
- `Database.transaction(context, fn)` opens a transaction and sets `app.shop_id` and `app.user_id` with `set_config(..., true)`, so the tenant context ends with the transaction and never leaks to the next use of a pooled connection (PRD 10.4). `BEGIN` and the context travel in one round trip.
- Row-level security is enabled on every tenant table. The runtime role `airstock_app` owns nothing and has no `BYPASSRLS`, so policies always apply to it. `FORCE ROW LEVEL SECURITY` is not used: only migrations and a few narrow `SECURITY DEFINER` functions run as the owner (credential lookup, sign-in, audit batch ingestion, cross-shop background scans).
- History tables (`inventory_operations`, `inventory_entries`, `audit_events`) are granted `SELECT, INSERT` only, so the application cannot edit or delete history (PRD 7.4).
- Composite foreign keys `(shop_id, id)` between tenant tables make cross-shop references impossible even for buggy code (PRD 2.2).
- Hot stock commands combine their writes into data-modifying CTEs, so a reservation is about ten statements end to end.

## Why

The PRD asks for explicit transaction control and no hidden round trips (10.2, 10.4). Every statement over Hyperdrive costs a network round trip, and being able to count and shape them matters more in Phase 0 than query-building convenience. The `Tx` interface counts statements for the M8 measurements.

## Revisit when

Phase 1 catalog filtering over custom fields needs dynamically built queries. Kysely remains the first candidate then, behind the same `Tx` interface.
