# 0019. Packs, barcodes, labels, bundles, and suppliers

**Status:** Accepted, 15 November 2026. Implements Phase 1 plan Sections 5.3–5.6, decision D9, and exit criteria F7 and F8 (milestone N5). Label fonts amended 16 November 2026.

**Summary:** Packs resolve exactly to base units with versions; barcodes unique per shop on the normalized code; labels resolved on the server and drawn in the browser; bundle availability computed on read; supplier costs behind `costs.read`

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
  - location labels: path, code, warehouse, and a QR code of `LOC:` and the location's ID, which stays valid when the location is renamed or recoded.
- The browser draws the PDF:
  - `bwip-js` encodes each symbol into a bitmap through a small drawing context, with no canvas, so the same code runs in Node tests.
  - `pdf-lib` places the bitmaps and text on the page, in embedded Noto fonts that `fontkit` shapes.
  - The server spends no CPU on rendering.
- Layouts are shared constants (`@airstock/core/labels`): A4 sheets of 3 × 8 (70 × 37 mm) and 4 × 10 (52.5 × 29.7 mm), and thermal labels of 50 × 25 mm and 100 × 50 mm. Templates save a layout with chosen fields per shop.
- Labels are an MCP exception, because the output is a PDF made in the browser. The data operations are still in the registry and on REST.
- **F8:** CI decodes every barcode the label renderer draws with the vendored `zxing-wasm` and checks that it resolves to its record.

### Rendering and decoding

- **Bitmaps.** `apps/web/src/labels/barcode.ts` runs the bwip-js encoders (EAN-13, EAN-8, UPC-A, Code 128, QR) through a drawing context that fills a grey bitmap instead of a canvas:
  - 4 pixels per module;
  - quiet zones of 11 modules for linear symbols and 4 for QR;
  - a linear symbol is a band two pixels high, which the PDF stretches to the bar height.

  A code stored as "other" prints as Code 128 when it is printable ASCII of up to 40 characters, and as QR otherwise. A test checks the bars and the QR modules against bwip-js's own encoding.
- **PDF.** `apps/web/src/labels/pdf.ts` draws each distinct code once, as an 8-bit DeviceGray, Flate-compressed image XObject with `Interpolate false`, and places that image on every copy.
- **Placement.** One pure planner places everything, and both the PDF and the on-screen preview of the first label use it:
  - a linear barcode spans the bottom of the label, with modules of at most 0.5 mm and bars of at most 22 mm;
  - a QR code sits on the right, at most 45% of the width, with modules of at most 1 mm;
  - the code is printed in plain text under the symbol when it fits.
- **Text.**
  - The title (a name or a path) gets up to two lines. A path is cut from its start, so the most specific part stays.
  - Long text shrinks down to 5 pt, is then cut with an ellipsis, and finally loses its last lines. Nothing leaves the label's padding.
  - Lines break at spaces and slashes, and between words in Chinese, Japanese, and Thai (`Intl.Segmenter`). Text is cut between whole characters, never inside one.
- **Fonts.** Text prints in self-hosted Noto fonts. The Worker serves them from `/assets/fonts/` with their license (`OFL.txt`), and each PDF embeds a subset holding only the glyphs it draws. `@pdf-lib/fontkit` 1.1.1 reads and shapes them. The files are unmodified: unhinted static TTFs from notofonts.github.io (commit `cfa91e3`), and the Google Fonts static instance of Noto Sans SC 2.004.

  | Font | Covers | Size per file | Loaded |
  | --- | --- | --- | --- |
  | Noto Sans Regular, Bold | Latin, Greek, Cyrillic | 431 kB | always; Bold when a label has bold text |
  | Noto Sans Arabic Regular, Bold | Arabic, Persian, Urdu | 142 kB | when a label has such characters |
  | Noto Sans Hebrew Regular, Bold | Hebrew | 17 kB | as above |
  | Noto Sans Thai Regular, Bold | Thai | 21 kB | as above |
  | Noto Sans Devanagari Regular, Bold | Hindi, Marathi, Nepali | 184 kB | as above |
  | Noto Sans SC Regular | Chinese, and Japanese kana and kanji | 10.5 MB | as above |

  - Noto Sans covers the Latin letters of European languages and Vietnamese, including Romanian "ș" and "ț", Polish, Czech, Hungarian, and Turkish.
  - A script font loads only when a label has a character that Noto Sans lacks and that belongs to the script. Each file is fetched at most once per page load.
  - Noto Sans SC has no bold file. Bold text in it is drawn as the regular glyphs with an outline 0.03 of the font size wide.
  - **CJK trade-off.** One CJK font, fetched only on demand. Noto Sans SC covers all CJK Unified Ideographs and kana, so Chinese and Japanese print; kanji take Chinese glyph forms. The download is 10.5 MB (4.8 MB if compressed with Brotli), under the Workers limit of 25 MiB per static file. It adds 6.7 MB to the repository's history, of 7.6 MB for all the label fonts. Korean Hangul is not covered: Noto Sans KR would add another 6.2 MB, so Hangul goes to the warning list. Adding a script is one font file and one entry in `SCRIPT_FAMILIES` (`apps/web/src/labels/fonts.ts`).
- **Shaping and direction.**
  - Text is composed (NFC), runs of spaces become one, and invisible format characters are dropped.
  - Each line is split into runs by font: Noto Sans first, and spaces, digits, and punctuation stay in the font of the text around them.
  - `bidi-js` 1.1.0 applies the Unicode bidirectional algorithm to each line, with the direction of its first strong character, and mirrors brackets in right-to-left text. fontkit shapes each run: Arabic joining, Devanagari reordering, Thai marks.
  - pdf-lib places glyphs by their advance widths, so neither kerning nor GPOS mark positioning applies; marks sit where the font draws them by default. Text stays left-aligned in every script.
  - The planner measures with the same shaped runs, and the on-screen preview draws the same glyph outlines on its canvas, so the preview matches the PDF.
- **Characters no font has** (Hangul, emoji, rare scripts) print as "?". The labels page lists them under the preview before the download, and again in the download message.
- **fontkit workarounds.**
  - fontkit writes subset glyph offsets in the short `loca` format, which halves them. In fonts with odd-length glyph records, such as the unhinted Noto Sans and Noto Sans SC builds, every later glyph then shifts and the PDF shows wrong or missing letters. `evenGlyphs` pads the records when a font loads.
  - Its Indic shaper calls a transpiled generator, so `regenerator-runtime` 0.14.1 is installed as a global.
  - Subsets of CFF-based OTF fonts came out invalid, so every label font is TrueType.
- **Size.** A one-page A4 sheet of 24 labels (8 Romanian names, Code 128) is 6.4 kB with Helvetica and 11.0 kB with the two embedded Noto Sans subsets. 2,000 labels (500 distinct) build in 0.8 s in Node.
- **Density.** The page warns when a barcode would print with modules under 0.19 mm (linear) or 0.25 mm (QR), the point where scanning becomes unreliable. A4 layouts can start at a later position on a partly used sheet. Thermal layouts put one label on each page, sized to the label.
- **Loading.** bwip-js, pdf-lib, fontkit, and bidi-js load only on the labels page, through a dynamic `import()`. That chunk is 1,361 kB (584 kB gzipped), up from 624 kB (244 kB gzipped) before the fonts; fontkit, with its Unicode and shaping tables, is most of the difference. Font files are fetched at run time, not bundled. The new pages and editors stay in the main bundle, which grows from 518 kB to 575 kB (157 kB to 171 kB gzipped). Loading them lazily made rolldown split shared modules out of the entry, which costs an extra round trip at startup.
- **CSP.** Unchanged. The PDF is saved through a `blob:` URL on a download link, as CSV exports already are. Font files are fetched from the same origin (`connect-src 'self'`), and the preview draws glyph outlines on a canvas, so no `font-src` is needed. The lazy chunk is `script-src 'self'` and contains no `eval`.
- **F8 decoding.** zxing-wasm 3.1.6 decodes in the test process, using the same vendored `zxing-reader.js` and `zxing_reader.wasm` that `/scan-test` serves; the wasm is read from disk instead of fetched. Decoding in the dashboard page would need `'wasm-unsafe-eval'` in its CSP for the sake of a test. The tests decode the images read back out of the PDF file, not the bitmaps before they are embedded, so they prove what the file holds.
  - A unit test builds PDFs in all four layouts with every symbology and then checks each image read back from the file:
    - its pixels match the rasterizer's bitmap;
    - it sits inside its label's padding, with modules of at least 0.19 mm;
    - it decodes to its code.
  - Text is read back from the PDF through each font's ToUnicode map. Romanian, Polish, Greek, and Cyrillic names print whole with nothing missing, and the embedded subsets hold the same outlines as the font files. Other tests check the warning list, that a script's font is fetched only when its characters appear, and the right-to-left order of Arabic and Hebrew lines.
  - The Chromium end-to-end test creates EAN-13 and UPC-A codes, generated Code 128 and QR codes, a generated code on a case, and a location. It prints them from rows selected in the grid and downloads the PDF. Every decoded code must resolve through `lookup_barcode` to the variant or pack it was printed for, the location QR must name the location, a product named "Bol roșu" must print with its "ș", and the page must log no CSP violations.
  - Rasterizing the PDF pages (pdf.js) was not added. Reading the images and their placements back covers everything a page raster would, except a viewer's own scaling.

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
- The label renderer is the only consumer of `bwip-js`, `pdf-lib`, `@pdf-lib/fontkit`, `bidi-js`, and `regenerator-runtime`. They load only on the labels page, so other screens don't pay for them.
- **Across milestones:**
  - `create_product` takes an optional `barcode`. Its symbology is inferred: a valid GTIN by its length, else Code 128 when it fits, else other.
  - The one duplicate check (plan 5.7) refuses a code another variant or pack holds, matched on the normalized form. `check_duplicates` names that owner.
  - Catalog search matches a barcode (normalized, so a scanner's leading zero still finds an EAN-13) and an active supplier SKU exactly, and ranks those matches with exact SKUs.
  - CSV imports take a `barcode` column, suggested for headers such as `EAN`, `UPC`, or `GTIN`. The preview refuses a code that repeats in the file or that another record holds. A code the row's variant already has is a no-op.
  - Exports write each variant's first barcode, so an export imports back unchanged.
  - CSV imports also take `supplier`, `supplier_sku`, `pack:<name>`, and `pack_barcode:<name>` columns (ADR 0018). They create top-level packs or give them a new version, with the rules of `set_packs`. Nested packs are edited in the dashboard only.
