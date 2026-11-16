import { createHash } from 'node:crypto';
import { migrate } from '@airstock/db/migrate';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { prepareAppRole } from './cluster-roles.ts';

/**
 * Creates a fresh test database, applies the roles and migrations, and installs a test-only
 * trigger used to make an audit insert fail on demand (A12).
 *
 * TEST_DATABASE_URL must point at a server where the user can create databases. The database is
 * named per checkout (or TEST_DB_NAME). Locally:
 * `pnpm db:up` starts one on port 54329. CI uses a postgres:17 service container.
 */
export default async function setup(project: TestProject) {
  const admin =
    process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/postgres';
  // One database per checkout, so tests in several worktrees can run at once.
  const dbName =
    process.env.TEST_DB_NAME ??
    `airstock_test_${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 8)}`;
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`drop database if exists ${dbName} with (force)`);
  await client.query(`create database ${dbName}`);
  await client.end();

  const ownerUrl = new URL(admin);
  ownerUrl.pathname = `/${dbName}`;
  await prepareAppRole(admin, ownerUrl.toString());
  await migrate(ownerUrl.toString());

  const owner = new pg.Client({ connectionString: ownerUrl.toString() });
  await owner.connect();
  await owner.query(`
    create function test_fail_audit() returns trigger language plpgsql as $$
    begin
      if new.reason = 'TEST_FAIL_AUDIT_INSERT' then
        raise exception 'simulated audit persistence failure';
      end if;
      return new;
    end $$;
    create trigger test_fail_audit before insert on audit_events
      for each row execute function test_fail_audit();`);
  await owner.end();

  const appUrl = new URL(ownerUrl.toString());
  appUrl.username = 'airstock_app';
  appUrl.password = 'airstock_app';
  project.provide('databases', { ownerUrl: ownerUrl.toString(), appUrl: appUrl.toString() });
}
