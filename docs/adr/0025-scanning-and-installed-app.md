# 0025. Scanning and the installed app

**Status:** Accepted, 16 November 2026. Implements Phase 2 plan decision D13 and Section 5.12 (milestone I4).

**Summary:** The scanner lives in the React app at `/app/scan` under the app's CSP plus `'wasm-unsafe-eval'`; BarcodeDetector where it reads the needed formats, the vendored zxing-wasm elsewhere (iOS); keyboard wedges in every scan field; flows are plug-ins; the service worker caches the app shell only

## Decision

### Where scanning runs

- The scanner is a route of the dashboard app, `/app/scan`, not a server-rendered page. It shares the session, the API client, the typed operation outputs, and the components with the dashboard. With one shop it opens on that shop; otherwise on the shop named in the address, then the last one used, then a shop list. The dashboard's side navigation links to it.
- **CSP.** The app shell's policy gains `'wasm-unsafe-eval'` in `script-src`, which allows WebAssembly compilation and nothing else: no `eval`, no inline scripts or styles. The groundwork test checks that this is the only difference. The `/scan-test` page from Phase 0 stays as it was.

### Decoding

- **Which decoder.** The built-in `BarcodeDetector` when the browser has it and it reads EAN-13, Code 128, and QR (Chrome on Android, macOS). Everywhere else, including iOS Safari and the installed iOS app, the vendored `zxing-wasm` 3.1.6 (`/assets/vendor/zxing-wasm-3.1.6/`), the build the Phase 0 matrix measured at 60–86 ms per frame on an iPhone. Its script loads on first use from the same origin, so other pages never download it, and the scan page starts the download as it opens.
- **Formats.** EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, Code 93, ITF, QR, and Data Matrix. One list for each decoder (`apps/web/src/scan/formats.ts`); the Node decode tests use the same zxing options.
- **Camera.** The rear camera (`facingMode: environment`, 1920 × 1080 ideal), decoding continuously: about every 40 ms with zxing (frames scaled to 1280 px wide) and every 90 ms with the built-in detector. The `<video>` is `playsinline` and muted, so iOS keeps it in the page. The camera opens on a tap the first time; the choice is remembered, and it stops while the page is hidden. Torch and zoom buttons appear only when the track reports them (iOS 17.4 and later report the torch on iPhone).
- **Repeats.** A code is read once while it stays in view; it counts again only after it has been out of view for 1.5 s, or at once when another code came between. Holding the phone on a label therefore never commits it twice.
- **Keyboard wedges.** Every field that takes a code is a scan field that submits on Enter, so a USB or Bluetooth scanner works in each. When no field has focus, a document listener collects keys that arrive less than 60 ms apart and end in Enter; a person typing is slower, so shortcuts never become scans.
- **Feedback.** A short high tone on success and a low double tone on errors, through Web Audio, unlocked by the first tap because iOS plays nothing before a gesture. The page sets the audio session to `playback` while sounds are on, so the ringer switch does not silence them; a header button turns them off. Android also vibrates; iOS has no vibration API. The camera frame flashes green or red.
- **Locations.** A location label (`LOC:` and the location's ID, ADR 0019) sets the current location for the following scans. It is remembered per shop on the device. A location with sub-locations is refused, because stock sits only at leaves.

### Flows

- The page owns the camera, the scan field, the wedge, the current location, and the feedback. A flow is one component that receives resolved scans through `useScanHandler` and shows its own form, with the quantity and pack visible before anything is committed. The flow tabs sit at the bottom of the screen, every control is at least 48 px tall, and nothing depends on hover.
- Flows not built yet show "coming soon"; plugging one in is one entry in `apps/web/src/scan/flow-list.tsx`.
- Every change made by scanning is an ordinary command with its own idempotency key, validation, and audit event. A lookup is a read and is logged as one.

### Installed app

- The manifest's `start_url` is `/app/scan`, with shortcuts for Receive, Count, Move, Pick, and Quick add (`/app/scan?flow=…`). The `id` stays `/app`, so installs from Phase 0 update in place. Icons: 192 and 512 px, a 512 px maskable icon with the mark inside the safe zone, a 180 px Apple touch icon without transparency, an SVG, and one 96 px icon per shortcut. The shell page sets `viewport-fit=cover`, and the scan page pads for the safe areas.
- **Service worker.** It caches the app shell only: `app.js` and `app.css` network first, answered from the cache when the network takes over 2 s or fails; the versioned zxing files and hashed lazy chunks cache first; the icons are refreshed in the background. Pages, `/api`, sign-in, and fonts always go to the network, so nothing works offline and stock on screen is never a stale copy. A test runs the worker's fetch handler against both lists.

## Why

- One app keeps one origin, one session, and one CSP, and the scanner reuses the dashboard's typed API client and components.
- `'wasm-unsafe-eval'` is the narrowest source expression that lets zxing run: iOS Safari has no `BarcodeDetector`, and the pilot merchant scans with an iPhone.
- A flow framework keeps each new flow (count, move, receive against a PO, quick add) a small component, while the camera, the wedge, and the feedback behave the same everywhere.

## Revisit when

- iOS ships `BarcodeDetector` with the formats above: zxing then stays only as the fallback.
- zxing on the main thread makes the page stutter on older phones: move decoding to a dedicated worker (`worker-src 'self'` already allows it).
- Offline counting or receiving is wanted (PRD 3.4 defers it): the service worker would then need a queue reconciled against stock versions.
