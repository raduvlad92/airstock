# 0011. Rate limits and client-reported events

**Status:** Accepted, 15 November 2026. Implements Phase 1 plan decision D11 and Section 5.14 (milestone N0).

**Summary:** Workers Rate Limiting per user, credential, and connection with per-minute refusal summaries; client events batched into one queue message

## Decision

### Rate limits

- The Workers Rate Limiting binding, one binding per caller kind (`wrangler.jsonc`), keyed by the authenticated identity: the user for dashboard sessions, the credential for API credentials, the grant for MCP connections, and the user again for client-event batches. The limits live in `packages/core/src/limits.ts` and are shown in shop settings; a test keeps `wrangler.jsonc` equal to them.

  | Caller | Limit | Binding window |
  | --- | --- | --- |
  | Dashboard session | 20 per second per user | 200 per 10 s |
  | API credential | 10 per second per credential | 100 per 10 s |
  | MCP connection | 5 per second per connection | 50 per 10 s |
  | Client-event batches | 1 per second per user | 10 per 10 s |

  The binding only offers 10- and 60-second windows, so a caller may burst within one window.
- The check runs right after authentication, before the pipeline, so a refused request sends nothing to the audit queue on its own. It answers 429 with problem code `rate_limited` and `Retry-After: 10`.
- Refusals are summarised: the first refusal of a caller in a minute produces one `ratelimit.exceeded` event (outcome `denied`), carrying the refused count of the caller's previous refused minute when the same isolate saw it. The event is sent after the response. Isolates do not share this state, so a caller spread across isolates can produce one event per isolate per minute. Session callers' summaries are platform events (no shop), because the shop in the path is not yet verified at that point.

### Client-reported events

- `POST /api/v1/shops/{shopId}/activity/client-events` (`activity.client_events.record`) takes up to 100 events: a client-made UUIDv7, a client sequence number, a type from a fixed list, an optional target, and small details. Only interactive sessions may call it (an MCP exception).
- Each event becomes an audit event with action `client.<type>`, the caller as actor, and `context.clientReported = true`. Its ID and time come from the UUIDv7, so a resent batch lands on the same audit key and is ignored; duplicates within a batch are dropped, and events more than 24 hours old or 5 minutes ahead are rejected.
- The operation is a read: no business data changes. The pipeline sends extra events from a read together with its access event, and the audit producer now packs the events of one send into one queue message (split only near the 128 KB limit), so one batch is one queue write. The consumer reads both the packed and the old one-event messages.
- The browser flushes every 5 seconds, at 100 events, and when the page is hidden (`fetch` with `keepalive`). It keeps events after a network error or a 429 and drops a batch the server rejects as invalid.

## Why

PRD 8.3 asks for limits per credential and connection; PRD 7.1 asks for interface events marked as client-reported. Counting refusals per minute instead of per request keeps a misbehaving client from turning the limit itself into audit cost, and one queue message per batch keeps client events inside the cost model.

## Revisit when

Limits need to differ per shop or plan (move the decision into the database or a Durable Object), or a client needs exact remaining-quota headers.
