# 0001. Workspace, tooling, and dependency policy

**Status:** Accepted, 14 November 2026

## Decision

- One pnpm workspace: `apps/worker`, `packages/core`, `packages/db`. Internal packages are consumed as TypeScript source, with no build step of their own; wrangler bundles the Worker, Vitest and tsx run everything else.
- TypeScript 7 in strict mode with `noUncheckedIndexedAccess`. Biome for linting and formatting (one fast tool, so CI stays short). Vitest for tests.
- Every dependency is pinned to an exact version (`save-exact`). New versions are adopted only once they are at least 14 days old, which keeps a freshly compromised release out of a public repository. GitHub Actions are pinned to commit SHAs for the same reason.
- Node 22 (`.nvmrc`). PostgreSQL 17 for tests, locally through `compose.yaml` and in CI as a service container.

## Why

The PRD asks for cheap CI (C14) and a public repository (C15). One tool per job and no per-package builds keep the single CI job short. A public repository is a target for dependency attacks, and a cooldown plus SHA pinning is a cheap defence.

## Revisit when

A package needs to be published, or the TypeScript source graph becomes slow enough to need project references.
