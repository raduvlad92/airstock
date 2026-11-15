# 0015. Media: uploads through the Worker, browser-made derivatives, signed delivery

**Status:** Accepted, 15 November 2026. Implements Phase 1 plan decisions D6 and D5 (the owner's answer Q1), milestone N4.

## Decision

### Records and storage

- Files live in the private EU R2 bucket `FILES` under `shops/{shopId}/media/{mediaId}/`, as `original`, `thumbnail`, and `display`. PostgreSQL keeps `media_upload_intents`, `media_assets`, and `media_links` (migration 0011), with `shop_id`, composite keys, and row-level security like every tenant table.
- A media record has a foreign key to the intent it came from, so no record exists without an upload behind it. A link names its variant together with the variant's product, so it cannot point at another product's variant.

### Upload (D6)

- **Intent** (`catalog.media.uploads.create`): the client declares the file name, type, size, and SHA-256, and gets an intent and PUT URLs valid for 15 minutes. Accepted: JPEG, PNG, WebP, AVIF, and GIF images up to 20 MB; PDF attachments up to 50 MB; 50 files per product, checked at the intent and again when linking.
- **Parts** stream through the Worker into R2: `PUT /api/v1/shops/{shopId}/media/uploads/{intentId}/{original|thumbnail|display}`. They use the same authentication as the rest of `/api/v1` (session plus the custom header, or an API credential), and only the caller that created the intent can upload to it or finalize it. These routes are exempt from the app's 1 MB body limit and have their own.
- **Checks while the bytes move:**
  - The byte count must match the declared size. R2 also requires it, through `FixedLengthStream`.
  - The first bytes must show the declared type (magic numbers). A PDF named `.png`, an HTML page, an SVG, or a HEIC file is refused.
  - SHA-256 is computed with `crypto.DigestStream`, fed from the same transform that checks the bytes, so storage's backpressure reaches the client and no body is buffered. R2 also checks the original against the declared hash and stores nothing when it differs (checked in local workerd). A derivative sent without a length (some HTTP/2 clients) is read into memory first, as it is at most 5 MB.
  - The pixel size is read from the image header, without decoding.
  - In Node tests and the end-to-end server, memory storage and `node:crypto` stand in for R2 and `DigestStream`, behind the `MediaStore` and `StreamHasher` interfaces.
- **Any rejection fails the intent:** a wrong checksum, wrong signature, oversize file, size mismatch, oversize derivative, or interrupted stream. One transaction marks the intent failed and records `catalog.media.upload_failed`, then the Worker deletes the intent's objects. A failed intent cannot be finalized; the client starts again. Protocol mistakes are answered without failing the intent: no body, or a derivative type other than WebP or JPEG.
- **Derivatives:**
  - The dashboard decodes the picture with `createImageBitmap` and draws a 320 px thumbnail and a 1,600 px display image on a canvas. They are WebP at quality 0.82 and never larger than the original.
  - A browser whose canvas cannot encode WebP sends JPEG instead (its canvas answers PNG when asked for WebP). So the server accepts WebP or JPEG derivatives. It checks that each one's bytes match its declared type, that it is at most 1 MB (thumbnail) or 5 MB (display), and that its longest side, read from the header, fits.
  - HEIC (risk R5): where the browser can decode it (Safari), the dashboard converts it to a JPEG original. Other browsers ask for a JPEG.
  - API clients make their own derivatives. Finalize requires both for an image.
- **Finalize** (`catalog.media.uploads.finalize`) creates the media record, any links, and the audit event in one transaction.
- **Sweep:** the existing 30-minute cron expires pending intents past their 15 minutes and records `catalog.media.upload_expired` as a system event. It then deletes the objects of expired and failed intents and marks them cleaned; a deletion that fails is retried by the next sweep. Expiry happens before deletion, so a finalize can never race it. A part that arrives after its intent stopped being pending is deleted by the upload route itself.

### Links

- **Role:** a merchant-defined slug (`Dimension diagram` becomes `dimension_diagram`), with the starter roles suggested. Defaults: `primary` for an image that becomes its scope's primary picture, `detail` for other images, and `attachment` for documents.
- **Order:** a position per scope, the product or one variant. A reorder lists every file in the scope.
- **Primary:** at most one per scope (a unique index). The first image linked to a scope becomes its primary picture. Removing the primary picture promotes the next image in that scope.
- **Alt text:** up to 1,000 characters.
- **Inheritance (ADR 0012):** a variant shows its own links first, then the product's. Its primary picture is its own, or else the product's.
- **Removing a link** keeps the file in the shop's media library (`find` with `unlinked`). Deleting stored files is a retention decision for later.

### Delivery

- **Signed links:** list and detail results carry signed links to the thumbnail and display image, `/media/{shopId}/{mediaId}/{part}?exp=…&sig=…`. The HMAC-SHA256, keyed with the new `MEDIA_SIGNING_KEY`, covers the shop, media, part, and expiry, so a link opens nothing else.
- **Expiry:** at least 15 minutes, rounded up to the next 5-minute step. Links issued within one step are identical, so the browser's private cache answers repeat views. A link therefore lasts 15 to 20 minutes.
- **Serving:** the Worker serves links from R2 with these headers:
  - `Cache-Control: private, max-age` set to the seconds left;
  - `X-Content-Type-Options: nosniff`;
  - `Content-Security-Policy: default-src 'none'; sandbox`;
  - `Cross-Origin-Resource-Policy: same-origin`.

  Originals are served as attachments.
- **The dashboard's CSP is unchanged.** Links are same-origin (`img-src 'self'`) and the media manager uses no `blob:` URLs: progress comes from XHR upload events, and previews wait for the server's thumbnail.
- **Originals never appear in list results.** `catalog.media.download` returns a link to the original valid for at least 5 minutes, and that call is the download event.
- **Without `MEDIA_SIGNING_KEY`,** links are null and uploads answer `503 media_unavailable`.

### Access logging (D5, Q1)

- `catalog.media.list`, `catalog.media.find`, and `catalog.media.primary` each record one access event whose `context.mediaIds` names the media returned. Fetching a signed link records nothing more. Each original download is its own event.
- For the grid, gallery, and detail panel (N3), core exports two helpers that return `{ result, mediaIds }`: `productMedia(ctx, productId)` and `primaryPictures(ctx, { productIds, variantIds })`. A read that embeds them puts `mediaIds` in its own audit context, so each request still records one event. `ItemDetail` and the item queries are unchanged.

### File custom fields

File field values are media IDs. Each must be a file in the shop of the kind the field's `config.accept` allows: images, documents, or any. This replaces ADR 0012's "refused until media exist".

### MCP

`manage_media` has eight actions: `list`, `find`, `primary_pictures`, `download_original`, `link`, `update_link` (role, alt text, primary), `reorder`, and `remove`. Upload and finalize are MCP exceptions, because they carry binary data. That makes 12 tools.

## Why

- **One path through the Worker.** Uploading through the Worker keeps a single authenticated path with the checksum and signature checks where the bytes pass, and no R2 credentials in the browser.
- **No image CPU on the server.** Browser-made derivatives keep image work off the Worker (PRD 4.5: processing has its own budget); the server only reads headers.
- **One event per view.** Signed links let one audited request cover every image it shows (Q1), instead of an event per thumbnail.
- **No orphaned attachments.** Failing the whole intent on any rejection keeps the states simple: an intent either finalizes with every part checked or leaves nothing behind.

## Revisit when

- Public image delivery is wanted (a CDN with an explicit policy, PRD 4.5).
- Browsers' WebP or HEIC support changes the fallbacks.
- Files outgrow a single request. Workers accept bodies up to 100 MB on this plan; multipart upload would be needed beyond that.
- The Phase 1 measurements show the upload's CPU time or the bytes per media item matter for the cost model.
- Unlinked files need a retention rule.
