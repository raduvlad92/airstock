import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
export const BOOTSTRAP_FILE = fileURLToPath(new URL('../bootstrap.sql', import.meta.url));

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies forward-only SQL migrations in file-name order, one transaction each.
 * Editing an applied migration is an error: write a new one instead.
 */
export async function migrate(
  connectionString: string,
  dir = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query("select pg_advisory_lock(hashtext('airstock_migrations'))");
    await client.query(`create table if not exists schema_migrations (
      version text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
    const done = new Map(
      (
        await client.query<{ version: string; checksum: string }>(
          'select version, checksum from schema_migrations',
        )
      ).rows.map((r) => [r.version, r.checksum]),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} changed after it was applied. Add a new migration.`);
        }
        result.skipped.push(file);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (version, checksum) values ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtext('airstock_migrations'))")
      .catch(() => {});
    await client.end();
  }
}

/** Creates the cluster-level roles. Run once per environment by the database owner. */
export async function bootstrap(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(await readFile(BOOTSTRAP_FILE, 'utf8'));
  } finally {
    await client.end();
  }
}
