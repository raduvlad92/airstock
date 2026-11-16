# 0026. Picking: pick lists from allocations, picks that never move stock

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan Section 5.11, PRD 6.10, and the pick half of A41 (milestone I4).

**Summary:** A pick list is one line per outstanding allocation of open reservations, walked in location-path order; picks record quantities and never change stock; another lot or position reallocates through the reservation's own command; a short pick flags the line and names the position to count; completing fulfills manual and API reservations and only records Shopify orders' picks

## Decision

- **Lists.** `picking.lists.create` takes the outstanding allocations of open, unexpired reservations (purpose manual or external order, not transfers), filtered by channel, warehouse, the day they were reserved (shop time zone), orders, or reservation IDs. An order filter matches an external reference exactly or as a prefix followed by `/`, `:`, or `#`, so `shopify:order/123` takes every line of that order. Each allocation becomes one line with its position, lot, serial, and the order-level reservation; a bundle's component allocations become lines under the bundle's reservation. Lines are numbered in walk order: location path, then SKU, then the reservation's age. At most 2,000 lines; an allocation is on at most one list that is still being worked (a partial unique index), so two pickers never get the same units.
- **Per line**, the API returns the variant, the quantity in base units and in the variant's packs (whole packs, largest first, and the units left over), the lot and expiry or the serial, and the external reference. Lists are numbered per shop for people ("Pick list 12").
- **Picks never change stock.** `picking.picks.record` adds to the line's picked quantity and writes an insert-only `picks` row. Stock and the ledger are untouched until fulfillment.
- **Another lot or position.** When the pick names another lot, serial, location, or position than the line, the command first calls `inventory.reservations.reallocate` in the same transaction (its own audit event, its own inventory operation, its availability outbox), then records the pick on a new line that follows the new allocation. The old line keeps what moved in `moved`.
- **Short picks.** `picking.picks.short` records what was found as picked and the rest as `short`, flags the line, and returns the position to count. The missing units stay reserved at that position: the count that settles the difference (milestone I2's count, wired to the phone in I4b) and the reallocation that follows start from there.
- **Completion.** `picking.lists.complete` fulfills each picked line of a manual or API reservation through `inventory.reservations.fulfill`, per allocation, in the same transaction. Shopify orders (created by the connector, or with a `shopify:` reference or channel) are fulfilled from Shopify (plan 5.14), so their picks are only recorded and reported as `recordedOnly`. A bundle is fulfilled in whole bundles when every one of its component lines is picked in full. Lines still open block completion unless `leaveOpen`; fulfilling needs `inventory.fulfill`, and `fulfill: false` records the picks only. `picking.lists.cancel` closes a list so its allocations can go on another.
- **Lock order.** A picking command locks its pick lines (or the list) first, then calls the reservation commands, which follow ADR 0006 (positions, then reservations). No stock command waits on a pick line, so no cycle can form.
- **Permissions and scope.** `picking.run` (inventory operators, managers, owners) builds lists and records picks; reading them needs `inventory.read`. A member limited to some locations builds lists only from those locations, sees only those lines (`partial`), and cannot pick or complete a line elsewhere (A42).
- **Interfaces.** REST and OpenAPI for every operation; the MCP tool `warehouse_work` (actions `create_pick_list`, `list_pick_lists`, `get_pick_list`, `record_pick`, `short_pick`, `complete_pick_list`, `cancel_pick_list`, and `scan`). The dashboard's Picking page builds, prints, and completes lists; the phone's Pick flow walks them: scan the location, scan the item (a pack's barcode counts the pack), confirm the quantity. A short pick on the phone offers to hand over to Count with that shelf.
- **PDF.** The browser draws the pick list with pdf-lib and the Noto label fonts (ADR 0019): A4, grouped by location in walk order, a box to tick per line, with page numbers. The module loads with a dynamic import; rolldown puts pdf-lib and fontkit in one lazy chunk that the labels page and the pick list share, so the main bundle does not grow.

## Why

- Lines per allocation mean a pick list is a view of what the stock engine already decided; nothing about stock is duplicated, and reconciliation stays per variant.
- Leaving stock alone until fulfillment matches PRD 6.10 and keeps Shopify orders right: Shopify reports their fulfillment, and an Airstock-side decrement would count it twice.
- Reallocating through the reservation command keeps one implementation of allocation rules, expiry, and the lock order.

## Revisit when

- Pickers need waves, zones, or batch picking across lists (several pickers on one list): split lists by zone, or add a claim per line.
- Shopify fulfillments are created from Airstock (after January): Shopify lines then fulfill at completion too.
