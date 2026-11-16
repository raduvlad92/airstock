# 0023. One-of-a-kind items, both ways

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan decision D5 and Section 5.7 (milestone I1). The phone flow follows in I4, and listing on Shopify in I6.

**Summary:** A one-of-a-kind variant holds at most one unit, checked under the variant's cost-row lock, becomes "sold" after fulfillment and active again when it returns; units that share a price are serials on one variant; a quick add creates and receives an item in one command; two starter families for cards and sets

## Decision

### One-of-a-kind variant

- `variants.one_of_a_kind` limits owned stock (every condition, plus in transit) to one unit across the shop. The receipt checks the quantity returned by `apply_stock_cost`, which holds the variant's cost-row lock, so two receipts at different locations cannot both pass. A race test covers it.
- The flag can be set only while the variant has at most one unit, and only when it is not tracked by lot or serial (also a check constraint).
- **Sold.** When a fulfillment leaves no owned stock on a product whose active variants are all one of a kind, the product's status becomes `sold`. Catalog queries and exports leave sold items out unless `sold` is `include` or `only`. History is kept. A later receipt (bought back, or a return in I2) makes the product `active` again.
- A grading certificate number is stored as the item's barcode (any printable code; a valid GTIN is checked as one), so scanning the slab finds it through `lookup_barcode`.

### Serialized shared variant

Units with one price share a serial-tracked variant, each with its serial, for example its certificate number (ADR 0020). Duplicates are refused per variant, ignoring case.

### Quick add

`inventory.quick_add` (MCP `receive_stock`, action `quick_add`; `POST /shops/{shopId}/quick-add`) is one transaction:
- **New item:** it creates the product and its variant with the shared create path (duplicate checks, family fields, barcode), marks the variant one of a kind, and receives one unit. The SKU defaults to the barcode.
- **Existing serialized variant:** with `variantId` and `serial`, it receives one more unit.

It needs `catalog.write` and also `inventory.receive` (and the `inventory:write` scope for connections). The product creation and the receipt each record their own event as well as the quick add's, so both show in the item's history. Pictures are added with the media operations; the phone form (I4) chains them.

### Starter families

- **Trading cards:** game, set, card number, rarity, language, condition (NM, LP, MP, HP, damaged), grading company, grade (1–10, one decimal), and certificate number.
- **Building sets:** set number, theme, piece count, sealed or opened, completeness, and box condition.
- An item's condition is a catalog field (`card_condition`, `box_condition`), kept apart from the stock condition and from the spare-parts family's `condition` field, whose options differ.

## Why

- The owner sells both kinds (graded cards with their own price, and cards or sets in several identical copies) and wants to choose per item.
- Checking the one-unit limit under the cost-row lock that every stock change already takes adds no new lock.

## Revisit when

A merchant needs one-of-a-kind items with several variants (for example a used set sold as complete or as parts), or sold items must leave the catalog entirely after some time.
