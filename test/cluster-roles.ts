import { bootstrap } from '@airstock/db/migrate';
import pg from 'pg';

/**
 * Creates the runtime role and sets its test password, one checkout at a time.
 *
 * Roles belong to the whole server, not to one database, so test and end-to-end runs in other
 * worktrees change the same `airstock_app` row. Two `alter role` statements at once fail with
 * "tuple concurrently updated". Advisory locks are per database, so every run takes the same lock
 * in the admin database (`adminUrl`) before touching the role.
 */
export async function prepareAppRole(adminUrl: string, ownerUrl: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`select pg_advisory_lock(hashtext('airstock_test_cluster_roles'))`);
    await bootstrap(ownerUrl);
    await admin.query(`alter role airstock_app password 'airstock_app'`);
  } finally {
    await admin.end();
  }
}
