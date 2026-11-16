# 0017. Product grid and bulk edits

**Status:** Accepted, 15 November 2026. Implements Phase 1 plan decisions D4 and D7 (milestone N3).

**Summary:** Variants and products rows over one query, virtualized grid with compare-and-set cells; bulk edits previewed, then committed all or nothing

## Decision

### Grid rows (D7)

- **Two modes over the same query** (`catalog.items.query`, ADR 0014):
  - **Variants:** one row per variant. This is where SKU, price, stock, and variant fields are edited.
  - **Products:** one row per product, with descriptive fields. Variant values are summarised: count, price range, first SKUs. Variant-level fields are read-only in this mode.
- **Virtualization:** rows and columns are virtualized with TanStack Virtual, and the name column is frozen.
  - Rows load in pages of 50 as the viewer scrolls, so the grid never holds the whole catalog. The Chromium test scrolls 1,500 rows into a 10,000-variant shop: fewer than 80 rows are in the page, and fewer than 40 requests are made.
  - The scroll height comes from the query's total (exact up to 10,000).
- **Edits:** one cell saves through `catalog.items.update` with the value the person saw as `expected` (ADR 0013).
  - **Cell states:** saved, editing, pending, error (with the message), and conflict.
  - **Conflicts:** the other person's value and who changed it show in the status bar, with *Keep mine* (resend with their value as expected) and *Take theirs*.
  - **Rejected edits:** the draft is kept.
  - **Validation:** input is checked with the same encoder as the server before anything is sent.
- **Keyboard:**
  - arrows, Tab and Shift+Tab, Home and End, Page Up and Page Down;
  - Shift with arrows for ranges;
  - Enter or F2 to edit, and typing starts an edit;
  - Escape to cancel;
  - Delete clears;
  - Ctrl or Cmd with C and V for copy and paste (tab-separated, as spreadsheets use);
  - Ctrl or Cmd with D to fill down;
  - Shift+Enter opens the detail panel.

  Focus stays on the grid, which reports the active cell with `aria-activedescendant`.
- **Columns:** resizable, reorderable (drag a header, or the column menu), and shown or hidden per mode. They are kept per viewer in local storage and in saved views. Resizing, reordering, visibility, view switches, and opening or closing the detail panel are reported as client events (ADR 0011). Queries and edits are audited by the server.
- **TanStack Table is not used.** The grid needs its own column state, keyboard model, and edit states, and a small amount of code over TanStack Virtual covers them. `@tanstack/react-table` is removed, a change from the plan's dependency list.
- **Detail panel tabs:** details grouped by family field groups, variants (with options, generation, and preview), related records (both directions), stock with the receive, reserve, and release forms, and history per product or variant. Pictures, packaging, and suppliers plug in through `detailExtensions` when milestones N4 and N5 land.
- **Gallery:** cards from the same query. The primary picture plugs in through `galleryImage` (N4).

### Bulk edits (D4)

- Pasting or filling into more than one record, clearing a range, and any multi-record change from MCP go through `catalog.bulk.preview`, then `catalog.bulk.commit`. A preview covers up to 500 records; bigger changes go through an import.
- **Preview** validates every change with the same code as a single edit, without saving.
  - It records the values the records had then, the changes, the caller, and a 15-minute expiry in `bulk_previews`.
  - It returns each value before and after. If any change is invalid, it returns the errors and no preview ID.
- **Commit** re-applies the changes with those stored values as `expected`, all or nothing.
  - If any record changed meanwhile, it fails with `preview_stale` and saves nothing (A17). The dashboard then previews again and shows the new values before the person confirms.
  - Only the caller who made a preview can commit it, once.
- Each changed record gets its own audit event, so each record's history shows the bulk change.

## Why

PRD 3.3 asks for a spreadsheet-speed grid without the risks of a spreadsheet. Previews make a paste's reach visible before it lands, and compare-and-set at commit keeps a slow reviewer from overwriting someone else's work.

## Revisit when

Merchants need more than 500 records in one edit outside imports, or keyboard and paste needs grow past what the small grid model covers (risk R2).
