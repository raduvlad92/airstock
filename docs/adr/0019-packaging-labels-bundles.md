# 0019. Packs, barcodes, labels, bundles, and suppliers

**Status:** Accepted, 15 November 2026. Implements Phase 1 plan Sections 5.3–5.6, decision D9, and exit criteria F7 and F8 (milestone N5).

## Decision

### Packs

- Stock stays in each variant's base unit. A pack names either a quantity of base units or a quantity of another pack of the same variant: "a case holds 12 inner packs of 6" is 12 × 6 = 72 base units. With an inner pack, the quantity must be a whole number of inner packs.
- `resolvePacks` (`@airstock/core/packs`) computes every base quantity exactly with the shared decimal arithmetic, with no floating point. It refuses a pack that:
  - refers to an unknown pack,
  - takes part in a cycle,
  - nests more than 5 deep,
  - exceeds `numeric(20, 6)`, or
  - has a base quantity that breaks the variant's `quantity_scale`.

  The last rule means converting any whole number of packs always fits the scale. A property test (A28) checks it against a reference.
- A variant's packs are replaced as one list (`set_packs`), up to 20. The edit names the list version it read and is refused if the list has changed since. A `variant_packaging` row per variant holds the list versions and serializes packaging edits without locking the variant.
- Each saved pack writes a `pack_versions` row with the base quantity it resolved to. A Phase 2 inventory entry can then record the exact factor it used (`inventory_entries.pack_id` and `conversion_factor` already exist).
- Uses are purchasing, counting, transfer, and sales. Packs can carry dimensions, weight, and a price.

### Shipping packages

- An ordered list of boxes per variant, each with dimensions and weight. Like packs, the list is replaced whole under its own version. Shipping packages are separate from packs: a pack is a counting unit, a box is what ships.

### Barcodes

- A barcode belongs to a variant or one of its packs. The symbologies are EAN-13, EAN-8, UPC-A, Code 128, QR, and other. EAN and UPC check digits are validated, and Code 128 is limited to printable ASCII, 80 characters at most.
- **Uniqueness is on the normalized code, per shop, across variants and packs,** because a scanner reports text, not who printed it:
  - GTINs are padded to 14 digits. This covers EAN-13, EAN-8, UPC-A, and any digit string with a valid GTIN check digit in another symbology. So UPC-A `036000291452` and EAN-13 `0036000291452` are the same code.
  - Every other code is trimmed and upper-cased.
  - A unique index enforces it. `findBarcodeOwner(s)` names the owner, so every create path, including the duplicate check and imports, can say who already has the code.
- **Generate barcode** takes the next value of the shop's `barcode_sequences` row, such as `AS00000042`, and stores it as Code 128 or as a QR code encoding that same identifier. It never encodes a URL or record data, so a printed label reveals nothing beyond the shop's internal code.
- `lookup_barcode` resolves a scanned code to its variant or pack.

### Labels (D9)

- `labels.items.render` and `labels.locations.render` are read operations. They resolve exactly what goes on each label and log one access event naming the records:
  - item labels: name, SKU, option values, price, barcode, and pack;
  - location labels: path, code, and a barcode of the location code, or of its ID when it has no code.
- The browser draws the PDF:
  - `bwip-js` encodes each symbol into a bitmap through a small drawing context, with no canvas, so the same code runs in Node tests.
  - `pdf-lib` places the bitmaps and text on the page.
  - The server spends no CPU on rendering.
- Layouts are shared constants (`@airstock/core/labels`): A4 sheets of 3 × 8 (70 × 37 mm) and 4 × 10 (52.5 × 29.7 mm), and thermal labels of 50 × 25 mm and 100 × 50 mm. Templates save a layout with chosen fields per shop.
- Labels are an MCP exception, because the output is a PDF made in the browser. The data operations are still in the registry and on REST.
- **F8:** CI decodes every barcode the label renderer draws with the vendored `zxing-wasm` and checks that it resolves to its record.

### Bundles

- A bundle is a variant with versioned component lines: a component variant, an optional pack, and an exact quantity whose base quantity is stored on the line. A component cannot itself be a bundle in V0, and a bundle variant takes no stock of its own.
- Availability is computed on read: the smallest `floor(component available ÷ base quantity per bundle)` over the components, for the whole shop, a warehouse, or a location and its sub-locations. It uses the same position-stock query as `inventory.availability.get` (`POSITION_STOCK_SQL`), so fulfillment eligibility (ADR 0016) and location scope apply the same way. `partial` says when the caller's scope covers only some locations, and an archived component makes the bundle unavailable.
- `inventory.availability.get` now uses the shared query too. A `locationId` filter therefore includes the location's sub-locations, matching bundles and location scopes.

### Suppliers

- A supplier has a name (unique among active suppliers, ignoring case), contact details, a currency (the shop's in V0), a lead time in days, notes, and a status.
- A supplier item links a supplier to a variant, optionally in one of its packs. It holds the supplier SKU (unique per supplier), the last cost (per pack when a pack is set), a minimum order quantity, and a preferred flag, with at most one preferred item per variant.
- **Costs need `costs.read`** to read and to set. Without it, responses say `costVisible: false` and leave the cost out. Events keep the cost under `changes.restricted`. Activity reads show other members that a restricted value changed, not the value, using the same redaction step as warehouse contracts.

### MCP

- `edit_catalog` gains `set_packs`, `set_shipping_packages`, `set_barcodes`, `generate_barcode`, and `set_bundle`. Each "set" action replaces a whole list, which keeps the action count low.
- `search_catalog` gains `get_packaging`, `lookup_barcode`, and `bundle_availability`.
- The new `manage_suppliers` tool covers suppliers and supplier items.

## Why

- Exact base quantities stored per pack version mean a count or a purchase in packs can never drift from the base unit, and Phase 2 can replay any entry with the factor it used.
- Normalizing GTINs before checking uniqueness matches how scanners and marketplaces treat them. Without it, the same physical code could belong to two records.
- Rendering in the browser keeps the Worker within its CPU limits, even for 40-up sheets with QR codes. Decoding in CI proves the printed symbols, not just the stored strings.
- Computing bundle availability on read avoids a second stock ledger that would have to be kept in sync with component stock.

## Consequences

- Phase 2 counts and receipts in packs can use `pack_versions` directly.
- The label renderer is the only consumer of `bwip-js` and `pdf-lib`. Both load only on the labels page, so other screens don't pay for them.
- Barcode and supplier-SKU search, duplicate blocking by barcode, and pack, barcode, and supplier-SKU columns in CSV imports and exports build on `findBarcodeOwners` and the supplier-item tables.
