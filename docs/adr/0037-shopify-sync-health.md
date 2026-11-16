# 0037. Shopify sync health and the shopify_sync tool

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan Section 5.14 (sync health), PRD 8.5 ("show sync health per shop … expose the same through MCP"), and milestone I6. Builds on [ADR 0008](0008-shopify-sync.md), [ADR 0033](0033-shopify-mapping-and-onboarding.md), and [ADR 0036](0036-shopify-push-and-reconciler.md).

**Summary:** One read, `shopify.sync.health`, answers whether Shopify is in step and why not; a conflict is resolved only by a person choosing a side (`shopify.conflicts.resolve`: push Airstock's, or take Shopify's as a count correction); both, with the connections list, form the MCP tool `shopify_sync`, which ends ADR 0008's temporary MCP exception

## Decision

- **`shopify.sync.health`** (`inventory.read`), per connected store: the last reconciler run, the last accepted push, the last webhook, how far orders are applied (`orders_synced_through`), the last full comparison, and the last sync error; **pending pushes** (levels whose Airstock target differs from Airstock's record of Shopify, conflicts aside); **conflicts** with what Airstock expected Shopify to hold, what Airstock shows, and what Shopify shows; **shortages** of the connection's orders (D6); **unmapped** Shopify variants (from the onboarding read) and locations; and the **mappings** (location scopes, and what each Shopify variant sells: a unit, a pack, or a bundle). Lists stop at `limit` (50 by default), counts do not.
- **Location scope (A42).** A member limited to some locations sees the conflicts, pending pushes, and location maps of Shopify locations whose scope overlaps theirs, and no shortages (orders are not tied to one location). Resolving needs access to that Shopify location's scope.
- **`shopify.conflicts.resolve`** (`connections.manage`, idempotent):
  - `push_airstock`: Airstock's record of Shopify becomes Shopify's quantity as last read (as of that read, so later orders still lower it), the conflict and its alert close (`pushed_airstock`), and the level is pushed: a compare-and-set from Shopify's number to Airstock's. If Shopify moved again, the write is refused and a new conflict opens.
  - `take_shopify` (also `inventory.adjust`): a `count_correction` adjustment in the map's scope makes Airstock's availability equal Shopify's: units added at the receiving location, or removed from the shelves with the most free units. The record becomes Shopify's number, so the push that follows finds nothing to change. Only for items sold one unit at a time without lots or serials; for packs, bundles, and tracked items the person adjusts stock themselves, then chooses `push_airstock`. Reserved units are never taken.
- **MCP.** The tool `shopify_sync` has the actions `health` and `connections` (read only) and `resolve_conflict` (a write). Its descriptions use OpenAI's "Use this when…" form, and the server instructions say to read health first and resolve only after the person chose a side. `shopify.connections.list` leaves its temporary exception; mapping and onboarding keep theirs (ADR 0033: a person compares both catalogs in the dashboard).
- **Dashboard.** The Shopify card shows Sync health first: the facts, conflicts with "Push Airstock's" and "Take Shopify's", pending pushes, shortages, what is not mapped (with "Map…", which fills a form mapping a Shopify variant to a unit, a pack, or a bundle by SKU or barcode), and the mappings.
- **Stale alerts.** A remap clears a level's conflict; the reconciler resolves a conflict alert whose level no longer has one (`cleared`).

## Why

- One read for "is Shopify in step" gives ChatGPT and the dashboard the same answer, and keeps the tool list to one Shopify tool.
- Airstock owns stock quantities (PRD 8.5), but a number someone typed into Shopify may be a real count. Making a person choose, and making "take Shopify's" an ordinary audited adjustment, keeps every change explainable in the history.

## Revisit when

Merchants need bulk resolution, "take Shopify's" for packs or bundles, or listing differences (part 5, D21) join the same view.
