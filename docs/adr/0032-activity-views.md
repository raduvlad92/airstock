# 0032. Activity views

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan decision D15 and the activity half of Section 5.15 (milestone I5); amends ADR 0004's storage.

**Summary:** PRD 7.4 filters resolved against the shop's own history before searching; location IDs on every event from each operation's `locations` hook; a shop-first audit key without a default partition; small deduplicated filter indexes; lifecycle, ingestion delay, and export as a logged job

## Decision

- **Filters (PRD 7.4).** `activity.list` (REST, `search_activity`, the dashboard) and the activity export take the same filters, combined with AND: actor (`actorId`, `actorType`), `integration` (an API key, AI connection, or connector ID, or an OAuth client ID), `source`, `from` and `to`, record (`targetType`, `targetId`), `action` (exact actions, or groups such as `inventory.*`, comma-separated), `outcome`, `phase`, `locationId` (a warehouse or location and everything inside it, and a warehouse's own events), `operationId`, and `attemptId` (one request: a batch). Keyset paging on `(occurred_at, event_id)` and restricted-field hiding are as before.
- **Resolved first.** The planner cannot estimate some filters, and on 1 million events a wrong guess costs seconds. So `resolveActivityFilters` turns them into values it can price, against the shop's own history: an action group becomes the list of the shop's actions in it (a loose scan of the action index, one probe per distinct action); a source the shop never used, or a group with no events, ends the search before it starts; a place becomes the list of its locations. The reader's scope is listed the same way (`resolveScope`). Filters are plain predicates, never `$n is null or …`.
- **Locations on events (A42).** The pipeline records on the attempt, the outcome, and failures the locations each operation's `locations(input, tx)` hook names, merged with any the handler adds. A hook that needs the database gives "not known yet" (`[]`) on the attempt, which a limited member does not see, except in that request's batch view when another of its events is inside their scope. No operation has activity-specific code.
- **Scoped history (PRD 2.4).** A member limited to some locations sees events about no location, events naming at least one location inside their scope (with only those locations listed), and warehouse and location records only when they may see the record. The scope applies to every filter, the lifecycle, and the export; a location filter matches only inside the scope.
- **Lifecycle.** With `attemptId`, the first page carries the request from attempt to outcome: action, status (`pending` while only the attempt is recorded), when each was recorded, duration, the latest event, and how many events and problems it has within the reader's scope. Import record events now carry the commit request's attempt ID, so an import is one batch.
- **Ingestion delay (PRD 7.3).** The first page carries `ingestion`: this shop's commands of the last 15 minutes whose outcome is in the history but whose queued attempt is not, and the queue consumer's last batch (`audit_ingestion_status`, one platform row; redelivered events do not count). The dashboard shows a notice while either says the history is behind.
- **Export.** `activity.exports.create` (permission `exports.run`, plus `activity.read`; MCP exception: it is a file) writes the filtered history as CSV through the export job, at most 50,000 events per file, with the member's scope and field visibility at run time. Creation, completion, failure (new for every export kind), and each download are events.
- **Storage (amends ADR 0004).** History is keyed `UNIQUE NULLS NOT DISTINCT (shop_id, occurred_at, event_id)` instead of the primary key `(occurred_at, event_id)`, which had no shop: whenever the planner expected a filter to match often, it walked that key through every shop's events. The new key also replaces the shop/time index. There is no default partition: with one, PostgreSQL cannot read the months in order and starts every month at once. Redelivery is still ignored, because an event's shop, time, and ID are fixed when it is created.
- **Indexes.** Each filter that can be rare has an index whose key leaves out the time, so B-tree deduplication stores each value once per shop with a list of rows (about 8 bytes per event): actor, action (in collation "C"), source, problems (partial, failures, denials, and conflicts), locations (GIN), operation, and attempt (now partial). Common filters walk the shop key newest first and stop at a page.

## Update, 16 November 2026: location scope in reads and commands after the inventory review

PRD 2.4 says a command is allowed only if every location it touches is in scope, and that out-of-scope stock figures and history are hidden. The review found reads and hooks that missed locations; each now names them, so the history's `location_ids` follow too.

- **Counts.** A count's `locations` hook (record, submit, cancel) names the count's location and every line's shelf; get and list show a count to a limited member only when all of them are in scope. A count started from positions has no location of its own and used to pass every check.
- **Lot trace and serial history** show only movements at locations in scope, the lot's totals cover only those locations, a serial's current position is hidden when it is outside the scope, and both results carry `partial`.
- **Stock view costs.** `get_stock` returns no cost block to a member limited to some locations: the moving average and owned value are shop-wide, which the valuation report already refuses such members for.
- **Shortages.** A shortage is at no position, so it is about the reservation's location limit, if it has one. Releasing a reservation names the location limit of any part with a shortage; the shortage list and, for reservations without allocations, the reservation list hide those limited to locations out of scope. A shortage without a location limit stays about no location, like other events without locations.
- **Purchase order receipts** check the order's destination (ADR 0027), and **allocation rules** the rule they replace (ADR 0020).

## Consequences

- On the 1-million-event bench, two-filter searches have a p95 of about 12 ms warm and under 1 s cold; history costs fewer bytes per event than before (docs/phase-2-measurements.md, "I5 activity search").
- A filter that matches only far back in a large history still reads that history: a member whose events are nearly all three-month-old import records, filtered by their attempts, takes seconds cold. The planner cannot see that correlation.
- Without a default partition, an event outside the monthly partitions fails to insert. The daily job keeps three months ahead, so that takes three months without the job, and it fails loudly rather than silently.
- The PRD's dedup wording (Section 7.3, `UNIQUE (occurred_at, event_id)`) becomes `UNIQUE (shop_id, occurred_at, event_id)`; proposed for the Phase 2 report.
- The dashboard's action groups are a list in `@airstock/core/activity`; a milestone that adds an action prefix adds its group there.

## Revisit when

Searches on a large shop's history are slow cold despite these indexes (per-partition extended statistics, or an attempts index by actor, are the next steps), the hot window moves to R2 (PRD 7.4), or platform admins need cross-shop timelines, which would need a time index without the shop.
