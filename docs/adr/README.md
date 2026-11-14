# Architecture decision records

Short records of decisions made while building, with the reason and what would make us revisit them. The PRD and the Phase 0 plan stay the source of requirements; these record how they were met.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-workspace-and-dependencies.md) | pnpm workspace, TypeScript 7, Biome, Vitest; exact pins with a 14-day cooldown | Accepted |
| [0002](0002-data-access.md) | Plain SQL over `pg`, no query builder; tenant context per transaction; row-level security | Accepted |
| [0003](0003-ids-and-decimals.md) | UUIDv7 IDs; quantities and money as `numeric(20,6)` and decimal strings | Accepted |
| [0004](0004-audit-pipeline.md) | Queue for attempts, reads, and failures; success events in the business transaction; monthly partitions | Accepted |
| [0005](0005-operation-registry.md) | One registry generates REST, OpenAPI, permissions, audit names, and task-shaped MCP tools | Accepted |
| [0006](0006-inventory-concurrency.md) | Position locks in id order, a database check on allocations, lazy expiry | Accepted |
| [0007](0007-mcp-connection-binding.md) | MCP shop binding through WorkOS standalone Connect: Airstock consent creates the grant, the first token binds its client | Accepted |
| [0008](0008-shopify-sync.md) | Shopify: expiring encrypted tokens, receipts with jobs, orders reserved by the connector, compare-and-set push that processes unseen orders before calling a conflict | Accepted |
| [0009](0009-transactional-email.md) | Resend for invitations, links without secrets, idempotent sends; account data in the US until revisited | Accepted for Phase 0 |
