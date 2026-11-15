# 0016. Warehouse records and the location hierarchy

**Status:** Accepted, 15 November 2026. Implements Phase 1 plan Section 5.9 and exit criterion F14 (milestone N6).

## Decision

### Warehouse records

- `warehouses` gains an address, a contact, provider IDs (`[{provider, externalId}]`), an operating status (`operating` or `paused`), fulfillment eligibility, and a `contract`: start and end dates, a fee description, a currency (the shop's by default), rates as decimal strings with what they are charged per, notes, and attachment media IDs (checked once media exist, N4). The contract is a record of agreed terms, not billing (PRD 5.1).
- **Commercial terms need `storage.commercial.read`,** to read and to change. Without it, list and detail responses leave the `contract` key out and say `commercialVisible: false`; the query does not even select the column. Sending a contract without the permission is `403`. History keeps the full values, so members who may see terms get a complete record, and activity reads replace `changes.contract` with `"hidden"` for everyone else. The rule lives in a small list in `activity.ts`, which other restricted values (supplier costs) can join.
- **Operating status is a record only.** What decides allocation is fulfillment eligibility, and it now applies downwards: a location takes part in fulfillment only when it, every location above it, and its warehouse are eligible (`location_fulfillment_eligible()`, used by reservations, availability, and the Shopify push).
- Updates take a required `expectedVersion` and send only what changes; each field change is in the event. Archived warehouses and locations are read-only until restored.

### Locations

- **Paths** are the warehouse name, the labels above, and the location's own label (its code, or its name), joined by `/`. A top-level location labelled like its warehouse does not repeat it, so the default stays `Main stock`. A rename, code change, or move rewrites `path` and `path_ids` for the whole warehouse in one statement. Locations whose path changed this way keep their version, so editing a child never conflicts with renaming its parent. Because `path_ids` follow the move, location scopes follow it too.
- **Codes** are unique among the active locations of a warehouse, ignoring case. The check runs under the warehouse lock instead of a unique index, because existing data may already hold duplicates and a failing migration would stop the staging deploy.
- **Moves** stay inside the warehouse. They are refused while the location or anything inside it holds stock, when the new parent holds stock or is archived, and when the new parent is the location or inside it.
- **Archive cascades.** Archiving a location or a warehouse archives every active location inside it and records which archive did it (`archived_via`). Restoring brings back exactly those; a location archived on its own before stays archived. Restoring needs an active warehouse and parent. Archive is refused while any location involved holds stock or open reservations (allocations never exceed on-hand stock, so on-hand stock covers both), or while a Shopify store sells from one of them. A shop keeps at least one active warehouse.
- **Locking.** Structural commands lock the warehouse row, then the locations in id order. Receipts and Shopify mappings take a share lock on their location, so a receipt and an archive or move cannot both pass their checks: whichever comes second waits and then sees the other's result. A race test covers it.

### Location scopes (C31)

- `members.location_scopes.set` replaces a member's scope with all locations or a list of warehouse and location IDs of the shop. It is session-only, needs `members.manage`, and only members with every location may use it, so a limited manager cannot widen their own access. Owners always have every location. `members.list` returns the IDs. Enforcement is unchanged since Phase 0; it now also covers the new commands, and a limited member may change a warehouse record only when the whole warehouse is in scope.

### MCP

- `manage_storage` replaces `manage_locations` with twelve actions for warehouses and locations; the tool count stays at 11. Shared arguments have no defaults, because a default in the flat schema would apply to every action, for example resetting ownership on an update.

## Why

PRD 5.1 and 5.2 ask for complete site records with fees visible only to authorized roles, archived locations that take no new operations, and no silent removal of a warehouse with stock. Cascading archive with a record of what cascaded keeps restore exact without a second confirmation. Making eligibility apply downwards keeps the warehouse flag meaningful without copying it onto every location.

## Revisit when

Phase 2 transfers arrive (moving a location with stock could become a transfer), a warehouse grows past a few thousand locations (paths are rewritten per warehouse), or warehouse billing is taken on (contracts would need their own table and history).
