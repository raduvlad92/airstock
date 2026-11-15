# Phase 1 status

**Updated:** 15 November 2026  
**Plan:** [Phase 1 build plan](phase-1-build-plan.md)

Staging: https://airstock.deletecookies.dev (see [staging.md](staging.md)). Every merge to `main` migrates and deploys it.

## 1. Milestones

| Milestone | State | Notes |
| --- | --- | --- |
| N0 Groundwork | In review | React shell at `/app` ([ADR 0010](adr/0010-web-app.md)) with the Phase 0 pages rebuilt (shops, members, AI connections, API credentials, Shopify), plus warehouses, activity, and the stock forms. Rate limits and client-reported events ([ADR 0011](adr/0011-rate-limits-and-client-events.md)). Component tests and a Chromium smoke test in CI. |
| N1 Catalog schema | Not started | |
| N2 Query, search, duplicates | Not started | |
| N3 Grid and detail panel | Not started | |
| N4 Media | Not started | |
| N5 Packs, barcodes, labels, bundles, suppliers | Not started | |
| N6 Warehouses and locations | Not started | |
| N7 Import and export | Not started | |
| N8 Measure and exit | Not started | |

## 2. Exit criteria evidence

| ID | State | Evidence |
| --- | --- | --- |
| F1–F14 | Not started | |

## 3. Decisions

| ID | Decision | Record |
| --- | --- | --- |
| D8 | Web app shape | [ADR 0010](adr/0010-web-app.md) |
| D11 | Rate limits | [ADR 0011](adr/0011-rate-limits-and-client-events.md) |
