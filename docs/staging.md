# Staging environment

Staging runs at **https://airstock.deletecookies.dev**. Every push to `main` that changes code
runs CI, applies database migrations, and deploys the Worker (`.github/workflows/ci.yml`).

The `deletecookies.dev` zone hosts other apps. Some of them use Clerk on the root domain
(`clerk.`, `accounts.`, `clkmail.` and the `clk*._domainkey` records), and Clerk sets cookies such
as `__session` and `__client_uat` for `.deletecookies.dev`, so browsers send them to Airstock
too. Airstock therefore:

- never reads or sets those cookie names, and ignores cookies it does not own;
- sets only host-only cookies with the `__Host-` prefix (no `Domain` attribute), so nothing it sets
  reaches the other subdomains;
- owns exactly one DNS record in the zone, `airstock`, created by the Worker custom domain. The CI
  token cannot edit DNS.

## Resources

| What | Name or ID | Notes |
| --- | --- | --- |
| Worker | `airstock-staging` | Custom domain `airstock.deletecookies.dev`; `workers.dev` and preview URLs are off |
| Hyperdrive | `airstock-staging` (`d4107a1ef7aa4b6ea8935a208edb0512`) | Query caching **off**: cached reads could cross tenants |
| Queues | `airstock-staging-audit`, `airstock-staging-jobs`, each with a `-dlq` | |
| R2 | `airstock-staging-files` | EU jurisdiction |
| Neon project | `airstock-staging` (`autumn-meadow-53762460`), branch `main`, database `airstock` | AWS `eu-central-1` (Frankfurt), PostgreSQL 17 |
| Database roles | `airstock_owner` (migrations, owns tables), `airstock_app` (runtime, no `BYPASSRLS`) | Hyperdrive connects as `airstock_app` |
| WorkOS | Staging environment `environment_01M7CV6V2AM1CB2KDKR36JWE56`, client `client_01M7CV6VA3GMRS5MYZ2GC1TJNS` | AuthKit domain `tranquil-mirror-83-staging.authkit.app` |
| Shopify app | `Airstock Staging`, client ID `5023573bb7a0db1c57597424be17feff` | Dev Dashboard organization 227739292 |
| Shopify dev stores | `airstock-dev-a`, `airstock-dev-b` | Basic plan, test data and the bogus payment gateway |

### WorkOS settings

- Sign-in methods: Google and Microsoft (WorkOS demo credentials, staging only) and Magic Auth.
  Email and password is off, so Airstock stores no passwords.
- Redirect URI `https://airstock.deletecookies.dev/auth/callback`; initiate-login URI
  `https://airstock.deletecookies.dev/auth/login`; sign-out URI `https://airstock.deletecookies.dev/`.
- Connect: Dynamic Client Registration and Client ID Metadata Documents on; MCP resource
  indicator `https://airstock.deletecookies.dev/mcp` (default).
- External sign-in URI `https://airstock.deletecookies.dev/connect/login` (standalone Connect). WorkOS
  sends every hosted AuthKit sign-in in this environment there, so Airstock's own sign-in page
  calls the WorkOS API directly instead of redirecting to hosted AuthKit.

### Shopify app settings

Not embedded; authorization-code install (`use_legacy_install_flow`); scopes `read_products`,
`read_inventory`, `write_inventory`, `read_locations`, `read_orders`; webhooks API version
`2026-10`; app URL `https://airstock.deletecookies.dev/shopify/app`; redirect URL
`https://airstock.deletecookies.dev/shopify/oauth/callback`. Airstock subscribes each store to
`orders/create` and `app/uninstalled` at install (ADR 0008). Tokens are expiring offline tokens,
stored encrypted with `SHOPIFY_TOKEN_KEY`.

## Secrets

Values are never committed. Names only:

| Where | Name | Purpose |
| --- | --- | --- |
| GitHub environment `staging` | `CLOUDFLARE_API_TOKEN` | Deploy token `airstock-staging-ci`: Workers Scripts and Queues write, Hyperdrive, R2, account settings and tail read on the account; Workers Routes write and zone and DNS read on `deletecookies.dev` only |
| GitHub environment `staging` | `CLOUDFLARE_ACCOUNT_ID` | |
| GitHub environment `staging` | `DATABASE_OWNER_URL` | `airstock_owner`, direct (unpooled) host, `sslmode=verify-full` |
| Worker secret | `SMOKE_SECRET` | Enables `/internal/smoke` |
| Worker secret | `SHOPIFY_API_SECRET` | Shopify app client secret: verifies webhooks and the install redirect |
| Worker secret | `SHOPIFY_TOKEN_KEY` | 32 random bytes (Base64) that encrypt stored Shopify tokens; key ID `k1` in `SHOPIFY_TOKEN_KEY_ID` |
| Worker secret | `WORKOS_API_KEY` | WorkOS key `airstock-staging-worker` |
| Worker secret | `SESSION_SECRET` | Seals the session cookie |
| Hyperdrive origin | `airstock_app` password | Set with `alter role` and stored only in the Hyperdrive config |

To rotate a Worker secret: `pnpm --filter @airstock/worker exec wrangler secret put NAME`. To
rotate the runtime database password: `alter role airstock_app password '...'` as the owner, then
update the Hyperdrive origin with `wrangler hyperdrive update`.

## Checks

```sh
curl -s -H "x-smoke-secret: $SMOKE_SECRET" https://airstock.deletecookies.dev/internal/smoke
curl -s -o /dev/null -w '%{http_code}\n' https://airstock.deletecookies.dev/api/v1/shops   # 401
```

First readings from the Frankfurt colo (14 Nov 2026): the first query on a new connection took
37–53 ms and each later round trip 3–6 ms; an R2 put, get and delete took 245–339 ms together,
and a queue send 69–295 ms. M8 records proper distributions.
