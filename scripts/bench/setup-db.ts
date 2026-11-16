/**
 * Prepares an empty benchmark database (plan Section 7.3, the `airstock-bench` Neon project): the
 * cluster roles and every migration, as `scripts/dev-setup.ts` does locally, and a random
 * password for the runtime role `airstock_app`.
 *
 *   DATABASE_OWNER_URL=postgres://… tsx scripts/bench/setup-db.ts --password-file <path>
 *
 * The password is made once and kept only in the file (mode 600); a later run reuses it. Nothing
 * secret is printed. The scripts that read as the runtime role take DATABASE_APP_URL: the owner
 * URL with `airstock_app` and that password.
 */
import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { bootstrap, migrate } from '@airstock/db/migrate';
import pg from 'pg';

const { values: args } = parseArgs({
  options: { 'password-file': { type: 'string' } },
});
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('Set DATABASE_OWNER_URL.');
if (!args['password-file']) throw new Error('Name the runtime password file with --password-file.');

await bootstrap(url);
const result = await migrate(url);
console.log(
  `Migrations applied: ${result.applied.length}; already applied: ${result.skipped.length}.`,
);

let password: string;
try {
  password = (await readFile(args['password-file'], 'utf8')).trim();
  console.log('Runtime password: reusing the existing file.');
} catch {
  password = randomBytes(32).toString('base64url');
  await writeFile(args['password-file'], `${password}\n`, { mode: 0o600 });
  console.log('Runtime password: written to the file (mode 600).');
}
await chmod(args['password-file'], 0o600);

const client = new pg.Client({ connectionString: url });
await client.connect();
// ALTER ROLE takes no bind parameters; the password is base64url, so quoting is safe.
if (!/^[A-Za-z0-9_-]+$/.test(password)) throw new Error('Unexpected password characters.');
await client.query(`alter role airstock_app password '${password}'`);
await client.end();
console.log('airstock_app can sign in.');
