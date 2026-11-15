# 0012. Custom fields, families, options, and rich text

**Status:** Accepted, 15 November 2026. Implements Phase 1 plan decisions D1 and D13 (milestone N1).

## Decision

### Storage (D1)

- **Definitions** in `field_definitions`: a stable ID, a key (slug, never changes), a label, one of 13 types, a level (`product`, `variant`, or `both`), validation rules in `config`, a default, a visibility (`everyone` or `restricted`), a status, and a version that increments on every change. Select options are rows in `field_options` with stable IDs, a position, and an archived flag.
- **Values** in a typed JSONB `attributes` column on `products` and `variants`, keyed by field ID, with one stored form per type: text and rich text as strings; integers as JSON numbers; decimals as decimal strings; booleans; dates as `YYYY-MM-DD`; timestamps as ISO 8601 UTC; single select as an option ID; multi select as option IDs in option order; money as `{amount, currency}`; measurements as `{value, unit, canonical}` with canonical grams, millimetres, millilitres, or °C; files as media IDs. **Relationships** are rows in `record_relations`, so "replaces" and "compatible with" are queryable in both directions.
- **One encoder** (`packages/core/src/catalog/fields.ts`) validates and normalises every write: dashboard, API, MCP, and imports. It accepts what people and files send (option labels as well as IDs, `"1.2 kg"`, `yes`/`no`, numbers as text) and returns the stored form. It has no dependencies, so the dashboard runs the same checks. Encoding a stored value returns it unchanged (a property test).
- **Inheritance:** fields of level `both`, weight, and dimensions are inherited by variants. On a variant a missing key inherits, JSON null clears, and any other value is its own. Weight and dimensions use SQL NULL to inherit and JSON null to clear; reads return the three states as `inherited`, `cleared`, and `own`.
- **Built-in fields** keep columns: name, description, status (`draft`, `active`, `archived`), family, tags, weight, dimensions; and on variants SKU, price, base unit, quantity scale, tracking mode, and option values. Custom keys cannot reuse their names. Brand and category are system single-select fields created with every shop (and backfilled for existing shops).
- **Families** list their fields with required flags, positions, and groups, plus suggested option names and values. Required fields are enforced on active products only, so drafts can be incomplete: fully when a product becomes active or changes family, and for any required field an edit empties.
- **Options:** up to 3 per product, with values that have stable IDs. A variant stores its value IDs sorted, so renaming or reordering options rewrites no variant. The default variant keeps its ID, SKU, stock, and history and takes the first combination when options are added; removing every option requires exactly one active variant. Variant generation previews combinations, SKUs from a pattern, and duplicates before creating anything.
- **Type changes:** integer to decimal, single to multi select, text to rich text, and decimal to money or measurement. Each runs as one SQL update per table after a preview of affected records.
- **Indexes:** GIN `jsonb_path_ops` on both `attributes` columns. Range filters and sorts get expression indexes only where the N2 benchmark shows a need.
- **Limits:** 300 active fields per shop, 500 options per select field, 32 KB of attributes per record, 3 options and 2,048 variants per product. They are listed in `describe_catalog`.
- **Restricted fields** are visible and editable only with `catalog.schema.manage` (owners and managers). File-field values are refused until media exist (N4).

### Rich text (D13)

Rich text is a Markdown subset stored as plain text (up to 50,000 characters), rendered escaped in the dashboard with no HTML passthrough, and converted to HTML only when syncing to Shopify (Phase 3).

## Why

Typed JSONB keeps adding a field free of migrations (F1) and keeps a record's values in one row for the grid. Keying by ID lets labels change; a single encoder makes the API, MCP, imports, and the dashboard agree. Relations need both directions, which JSON arrays cannot index cheaply.

## Revisit when

The N2 benchmark shows JSONB filters or sorts near the 1-second target (expression indexes, then generated columns: risk R1), or a shop needs more than 300 fields.
