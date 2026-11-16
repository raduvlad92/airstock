# 0010. Dashboard web app

**Status:** Accepted, 15 November 2026. Implements Phase 1 plan decision D8 (milestone N0).

**Summary:** React, Vite, and TanStack app at `/app`, built into the Worker's static assets under the same CSP

## Decision

- `apps/web` is a React 19 single-page app built with Vite 8, routed with TanStack Router (code-based routes, base path `/app`), and fed by TanStack Query. TanStack Virtual arrived with the grid (N3); TanStack Table, planned for it, turned out unnecessary and was removed ([ADR 0017](0017-grid-and-bulk-edits.md)).
- **Build:** one entry (`src/main.tsx`), no HTML, written to `apps/worker/public/app/assets/app.js` and `app.css` with fixed names. The output is not committed; `pnpm build` builds the web app, then the Worker bundle, and CI deploys both.
- **Serving:** Workers static assets serve the built files before the Worker runs. The Worker answers every other path under `/app` with a small shell page (`appShellPage`): a session check, the site's CSP, the user's email and MCP URL as data attributes, and the two tags. A missing file under `/app/assets/` is a 404, never the shell. Every other path still reaches the Worker. Sign-in, consent, invitation, and scan-test pages stay server-rendered.
- **CSP unchanged:** no inline scripts or style elements. React sets styles through the CSSOM, which `style-src 'self'` allows. The Playwright smoke test fails on any CSP report.
- **API:** the app calls `/api/v1` with the session cookie and the `x-airstock-request` header, like the Phase 0 `app.js` it replaces. Response types are inferred from the registry's Zod output schemas (`Out<typeof ops.x>`, type-only imports), so a changed operation breaks the web typecheck instead of the page. Values the app needs at run time come from small subpath exports (`@airstock/core/permissions`), keeping Zod and the operations out of the bundle (115 KB gzipped at N0).
- **Tests:** component tests in Vitest with happy-dom and Testing Library (`apps/web/test`), and one Playwright run in Chromium (`apps/web/e2e`) against the real app on Node and PostgreSQL. The test server's only stand-in is a route that seals a session, because the real sign-in needs WorkOS. The browser is cached in CI.
- **Dependencies** follow ADR 0001 (exact pins, 14-day cooldown). `@vitejs/plugin-react` is used for JSX and development refresh. `happy-dom` and `@testing-library/*` are additions to the plan's list, needed for component tests.

## Why

PRD 3.2 and the Phase 1 grid need a client-side app; serving it from the same Worker keeps one origin, one CSP, and one deploy. Fixed file names let the Worker write the shell without a build manifest; `Cache-Control: no-cache` on `/app/assets/*` makes browsers revalidate, so a deploy is picked up on the next load.

## Revisit when

The bundle passes about 300 KB gzipped (split routes into chunks), or the app needs offline use (cache the assets with versioned names).
