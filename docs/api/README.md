# API contract

The OpenAPI 3.1 contract is generated from the operation registry with `pnpm openapi`. CI runs `pnpm openapi:check`, which fails when a file here is stale, missing, or not generated.

It is one file per operation, so branches that change different operations never edit the same file:

- [`document.json`](document.json): the document without `paths` (info, servers, security, shared components).
- [`operations/<operationId>.json`](operations): one entry of `paths` per operation, such as [`catalog.items.create.json`](operations/catalog.items.create.json).

The single document is joined from these files by `scripts/openapi-bundle.mjs`. Wrangler runs it before every build and dev session, and the Worker serves the result at `/openapi.json`. To write it locally, run `pnpm openapi:bundle` (into `apps/worker/public/openapi.json`) or `node scripts/openapi-bundle.mjs <file>`.

Paths are sorted by path and then method, so the joined document does not depend on registry order.
