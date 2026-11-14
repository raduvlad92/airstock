/**
 * Local development database: creates airstock_dev on the compose PostgreSQL (port 54329),
 * applies roles and migrations, and seeds one user, shop, item, and API token so the API
 * can be tried with `pnpm --filter @airstock/worker dev`.
 *
 *   pnpm db:up && pnpm dev:setup
 */
import { ensureUser, execute, ops, sessionCaller, uuidv7 } from '@airstock/core';
import { PgDatabase, poolSource } from '@airstock/db';
import { bootstrap, migrate } from '@airstock/db/migrate';
import pg from 'pg';

const server = process.env.DEV_DATABASE_SERVER ?? 'postgres://postgres:postgres@localhost:54329';
const admin = new pg.Client({ connectionString: `${server}/postgres` });
await admin.connect();
const exists = await admin.query("select 1 from pg_database where datname = 'airstock_dev'");
if (exists.rowCount === 0) await admin.query('create database airstock_dev');
await admin.end();

const ownerUrl = `${server}/airstock_dev`;
await bootstrap(ownerUrl);
await migrate(ownerUrl);
const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
await owner.query(`alter role airstock_app password 'airstock_app'`);
await owner.end();

const appUrl = ownerUrl.replace('postgres:postgres@', 'airstock_app:airstock_app@');
const db = new PgDatabase(poolSource(appUrl, 2));
const audit = { send: async () => {} };
const userId = await ensureUser(db, {
  providerUserId: 'dev_user',
  email: 'dev@example.test',
  displayName: 'Dev',
});
const caller = sessionCaller(userId);
const shop = (
  await execute({ db, audit }, ops.createShop, {
    caller,
    shopId: null,
    input: {
      name: `Dev shop ${new Date().toISOString().slice(0, 16)}`,
      currency: 'EUR',
      timezone: 'Europe/Berlin',
    },
  })
).result as { shopId: string; defaultLocationId: string };
const item = (
  await execute({ db, audit }, ops.createItem, {
    caller,
    shopId: shop.shopId,
    input: { name: 'Sample lamp', sku: `LAMP-${uuidv7().slice(-6)}` },
    idempotencyKey: uuidv7(),
  })
).result as { variantId: string };
const credential = (
  await execute({ db, audit }, ops.createApiCredential, {
    caller,
    shopId: shop.shopId,
    input: {
      name: 'local dev',
      scopes: [
        'shop:read',
        'catalog:read',
        'catalog:write',
        'storage:read',
        'storage:write',
        'inventory:read',
        'inventory:write',
        'activity:read',
      ],
    },
  })
).result as { token: string };
await db.close();

console.log(`
Local database ready (airstock_dev).
  shopId     ${shop.shopId}
  locationId ${shop.defaultLocationId}
  variantId  ${item.variantId}
  token      ${credential.token}

Try it (with \`pnpm --filter @airstock/worker dev\` running):
  curl -s -X POST http://localhost:8787/api/v1/shops/${shop.shopId}/receipts \\
    -H "authorization: Bearer ${credential.token}" -H "idempotency-key: $(uuidgen)" \\
    -H "content-type: application/json" \\
    -d '{"variantId":"${item.variantId}","locationId":"${shop.defaultLocationId}","quantity":"10"}'
`);
