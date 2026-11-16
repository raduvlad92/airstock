<img src="assets/icon.svg" width="64" height="64" alt="">

# airstock

A visual product database and inventory system for ecommerce merchants, with an API and MCP access from day one. Working title; the product name is not chosen yet.

- **What and why:** [PRD and architecture](docs/ecommerce-platform-prd-and-architecture.md)
- **Current build:** [Phase 1 plan](docs/phase-1-build-plan.md) and [Phase 1 status](docs/phase-1-status.md); Phase 0 in its [report](docs/phase-0-report.md)
- **Decisions:** [architecture decision records](docs/adr/README.md)
- **API contract:** [OpenAPI 3.1](docs/api/README.md), generated from the operation registry, one file per operation; the Worker serves the joined document at `/openapi.json`

## Layout

```text
apps/worker      Cloudflare Worker: REST API, MCP endpoint, queue consumers, cron jobs
apps/web         Dashboard: React, Vite, and TanStack, served by the Worker at /app
packages/core    Operation registry, command pipeline, inventory and catalog operations
packages/db      PostgreSQL migrations, roles and row-level security, transaction layer
scripts          Parity check, OpenAPI generation and bundling, ADR index, local dev setup
test             Shared test setup: a fresh PostgreSQL database per run
```

## Develop

Requires Node 22, pnpm 9, and Docker (for PostgreSQL 17).

```sh
pnpm install
pnpm db:up          # PostgreSQL 17 on localhost:54329
pnpm test           # creates a fresh test database and runs every test
pnpm verify         # what CI runs: lint, typecheck, parity, OpenAPI, ADR index, tests, dashboard and Worker build
pnpm e2e            # Chromium smoke test against the built dashboard (after pnpm build)
```

Try the API locally:

```sh
pnpm dev:setup                       # creates airstock_dev and prints a shop, item, and API token
pnpm --filter @airstock/worker dev   # Worker on http://localhost:8787 with local queues
```

Adding to the API (details in [ADR 0005](docs/adr/0005-operation-registry.md)):

- **Operation:** define and export it in its module in `packages/core/src/operations`, append it to the list at the end of that module, and run `pnpm openapi` to write its `docs/api/operations/<id>.json`. A new module also adds one sorted line to each group in `operations/index.ts`.
- **MCP tool action:** set the operation's `mcp` field. Test it with the area's other tests, using `apps/worker/test/mcp-client.ts`. A new tool also adds one line to `mcp-tools.test.ts`.
- **ADR:** see [Adding an ADR](docs/adr/README.md#adding-an-adr); number it when its PR merges and run `pnpm adr`.

The repository is public. Never commit credentials: local secrets go in `apps/worker/.dev.vars`, staging secrets in `wrangler secret` and the GitHub `staging` environment.

## License

Not chosen yet (see the PRD, Section 17). Until a license is added, all rights are reserved.
