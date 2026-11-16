# 0004. Audit pipeline

**Status:** Accepted, 14 November 2026. Implements PRD 7.3 with the owner's decisions P2 and P3.

**Summary:** Queue for attempts, reads, and failures; success events in the business transaction; monthly partitions

## Decision

- **Authenticated callers only (P3).** A request without a valid credential is answered with 401 before anything is queued, and is not a shop audit event. Failed sign-ins arrive later as verified WorkOS events.
- **Commands.** After authorization and validation, a minimal attempt event is sent to the `audit-intake` queue and awaited. The success event is inserted in the same transaction as the change, together with outbox rows and the idempotency result (one statement). Any failure afterwards sends one failure event to the queue before the error is returned.
- **Reads (P2).** One access event per read, sent to the queue and awaited before data is returned. If the queue does not accept it, the read fails with 503 and returns nothing (A31).
- **Denials and validation failures** send a single outcome event.
- **Ingestion.** The queue consumer writes each batch with one call to `ingest_audit_events(jsonb)`, which ignores duplicates by `(occurred_at, event_id)`. Redelivery therefore writes each event exactly once (A27).
- **Storage.** `audit_events` is range-partitioned by month on `occurred_at`. Partitions are created three months ahead by a daily job; a default partition exists only as a safety net and is expected to stay empty.
- **Unknown outcomes.** A lost commit acknowledgement returns `503 outcome_unknown` and records an `unknown` outcome; `GET /operation-outcomes` (and the `get_operation_outcome` tool) tells the client whether the command committed (A26).

## Consequences

- Queue cost is about three operations per event, so a read costs about three queue operations and a successful command about three (the success event goes straight to PostgreSQL).
- Activity views lag the queue by a few seconds; the activity operation says so.
- Archiving partitions to R2 (Phase 2) can detach whole months without rewriting rows.

## Revisit when

Read latency from the awaited queue send is too high in M8. The first fallback is to send the access event concurrently with the query and await both.

## Update, 16 November 2026 (ADR 0031)

Ingestion deduplicates by `(shop_id, occurred_at, event_id)`, a `UNIQUE NULLS NOT DISTINCT` key that replaced the primary key, and there is no default partition any more: both so activity searches read one shop's months in order (ADR 0031). The daily job still keeps three months of partitions ahead; an event outside them now fails to insert.
