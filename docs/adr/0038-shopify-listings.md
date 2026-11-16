# 0038. Shopify listings in both directions, with an owner per storefront field

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan Section 5.14 (listings) and decision D21 (milestone I6). Builds on [ADR 0033](0033-shopify-mapping-and-onboarding.md), [ADR 0036](0036-shopify-push-and-reconciler.md), and [ADR 0037](0037-shopify-sync-health.md).

**Summary:** A product created in Airstock is listed with `shopify.listings.create` and published by a job (productSet with options, variants, SKUs, barcodes, prices, description, and pictures uploaded from R2 through staged uploads); `products/*` webhooks pick up products created in Shopify by SKU or barcode; each listing records who owns each storefront field, and a change from the other side becomes a difference resolved in sync health, never applied silently

## Decision

- **Listings.** `shopify_listings` holds one row per connection and product: the Shopify product, its origin (`airstock` or `shopify`), the **owner of each storefront field** (title, description, status, prices, pictures), the status Airstock asks for, the publish state, and the storefront values on each side when they last agreed. Products created in Airstock are Airstock-owned; products picked up from Shopify are Shopify-owned.
- **To Shopify** (`shopify.listings.create`, `catalog.write`; the dashboard's Shopify tab, the phone's quick add, and the `shopify_sync` tool's `list_product`): the command records the listing and queues `shopify.listing.publish`. The job:
  1. uploads each picture's original (2,048 px, D19) from R2 to Shopify's staged storage;
  2. creates the product with `productSet` (options, variants with SKU, barcode, and price, the pictures, and the item stocked at 0 at every mapped Shopify location);
  3. records the IDs and maps the variants (source `listing`), so the push sets Airstock's availability.

  Before creating, it looks the SKUs up in Shopify, so a retry after a crash adopts the product an earlier attempt made instead of creating a second one. Products created in Shopify are not listed again from Airstock.
- **Later changes.** The 30-minute reconciler publishes listings that are pending, failed (up to five attempts), or whose product, variants, or pictures changed since the last sync.
  - Fields Airstock owns are pushed: title, description, and status with `productUpdate`, new pictures as media, prices with `productVariantsBulkUpdate`. `productSet` is used only to create, because it replaces every variant and would delete ones added in Shopify.
  - An Airstock edit to a field Shopify owns becomes a difference.
- **From Shopify** (`products/create`, `products/update`, with `includeFields` of IDs and the update time; job `shopify.product_sync`, which reads the product and runs `shopify.products.sync` as the connector):
  - A product without a listing is matched by SKU, then barcode. If its variants match one Airstock product, a Shopify-owned listing is created and the variants are mapped. Where titles, descriptions, or prices differ, a difference is recorded: nothing is overwritten on the first match.
  - With no match and one variant, the product is created here (`catalog.items.create`), Shopify-owned, and mapped. With several variants, it is left unmapped in sync health, for a person to map or import with the onboarding import (ADR 0033).
  - A product whose SKUs match an Airstock listing still being created is Airstock's own echo, and is left to the job.
  - For a listed product, a change in Shopify is applied where Shopify owns the field (title, description, prices) and recorded as a difference where Airstock does. Shopify's own echo of a push changes nothing, because each side is compared with its own last values.
  - Every Shopify variant seen is recorded, so unmapped ones show in sync health. The connector caller gains `catalog:write` for this.
- **Differences** (`shopify_listing_differences`, one per product and field) show in sync health with **"take Shopify's"** (copied into Airstock through `catalog.items.update`) or **"push Airstock's"** (the next publish writes Airstock's value, whoever owns the field): `shopify.listing_differences.resolve`, the `shopify_sync` tool's `resolve_listing`. Pictures go one way only.
- **Sold one-of-a-kind items.** Availability drops to zero through the push as for any item. With the store's `archive_sold_listings` setting, the next sync also archives the listing.
- **Quick add.** "List on Shopify" is enabled when one store is connected. It lists the new item as a draft or active product after its pictures are uploaded, and remembers the last choice per shop on the device.

- **API versions.** Barcodes are written as `barcodes` and read from the `barcodes` connection: `barcode` is deprecated in 2026-10, with its removal date not yet announced. The 2027-01 release candidate keeps `inventorySetQuantities` with `changeFromQuantity`, and the product, order, refund, fulfillment, and return reads used here, unchanged; its breaking changes are in discounts, collections, markets, and tax. The onboarding read (ADR 0033) still asks for `barcode`, which keeps working until Shopify sets a removal date.

## Why

- One owner per field gives every storefront value a single source, so the two systems cannot overwrite each other silently, and a person sees and decides every disagreement.
- Comparing each side with its own last values attributes a change to the side that made it, and makes a push's echo harmless.
- Creating with `productSet` and updating with narrower mutations keeps variants added in Shopify safe.

## Revisit when

Merchants need multi-variant products created automatically from Shopify, per-field owners changed from the dashboard, Shopify-side picture changes copied back, or listing changes faster than the 30-minute sync (then queue a publish from catalog commands).
