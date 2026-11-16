# 0013. Field-level compare-and-set for catalog edits

**Status:** Accepted, 15 November 2026. Implements Phase 1 plan decision D3 and the owner's answer Q4 (milestone N1).

**Summary:** Field-level compare-and-set on the value the caller read; conflicts name who changed the field

## Decision

- `catalog.items.update` takes a list of changes to one product and its variants. Each change names a field and carries `expected`: the value the caller last read, as the API returns it (the effective value, so an inherited value counts as what the person saw).
- The command locks the product and its variants, compares each `expected` with the current value after normalising both through the field encoder (so `"10"` equals `"10.00"`, and multi-select order does not matter), and writes nothing if any field differs. The conflict (`409 edit_conflict`) lists each field's current value and who last changed it, read from the activity history: actor, source, client, and time.
- Changes to different fields never conflict. Two edits to the same field from the same value: the first commits, the second sees the new value and conflicts.
- Every changed record's `version` still increments and is returned, for caches. Schema objects (fields, families) and product options use a record-level `expectedVersion` instead, because they are edited as a whole.
- Each changed record gets its own audit event with `changes.fields` keyed by field key (`{from, to}`) and the definition versions used, so a record's history and the conflict lookup find it.
- Changes to more than one product go through a bulk preview and commit (D4, milestone N3), not this command.

## Why

Q4: fewer false conflicts in a busy grid than a record-level version check, while A09 still holds.

## Revisit when

Grid users report conflicts on fields they did not touch, or a single record's history query becomes slow (index `changes` keys).
