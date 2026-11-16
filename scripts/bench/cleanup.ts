/**
 * Removes benchmark shops and their users (plan Section 8: measure on staging, then leave it as
 * it was). Deletes every row of the named shops from each table with a `shop_id` column, retrying
 * in rounds so foreign keys resolve without a hand-kept table order (cycles, such as a count and
 * its operation, are cut first), then the benchmark users who no longer belong to any shop.
 *
 *   DATABASE_OWNER_URL=… tsx scripts/bench/cleanup.ts --names 'Bench shop %' --names 'Import bench' [--yes]
 *
 * Without --yes it only counts what it would delete.
 */
import { parseArgs } from 'node:util';
import pg from 'pg';

const { values: args } = parseArgs({
  options: {
    names: { type: 'string', multiple: true, default: [] },
    yes: { type: 'boolean', default: false },
  },
});
if (args.names.length === 0) throw new Error('Name the shops with --names (SQL LIKE patterns).');
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('Set DATABASE_OWNER_URL.');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const shops = await client.query<{ id: string; name: string; created_by: string }>(
    'select id, name, created_by from shops where name like any($1::text[]) order by name',
    [args.names],
  );
  const shopIds = shops.rows.map((r) => r.id);
  console.log(`${shopIds.length} shops: ${shops.rows.map((r) => r.name).join(', ') || 'none'}`);
  if (shopIds.length === 0) process.exit(0);

  // Partitions are reached through their parent table.
  const tables = (
    await client.query<{ table_name: string }>(
      `select c.table_name from information_schema.columns c
       join pg_class k on k.relname = c.table_name and k.relnamespace = 'public'::regnamespace
       where c.table_schema = 'public' and c.column_name = 'shop_id' and c.table_name <> 'shops'
         and not k.relispartition and k.relkind in ('r', 'p')
       order by c.table_name`,
    )
  ).rows.map((r) => r.table_name);

  if (!args.yes) {
    let total = 0;
    for (const t of tables) {
      const { rows } = await client.query<{ n: string }>(
        `select count(*) as n from ${t} where shop_id = any($1::uuid[])`,
        [shopIds],
      );
      const n = Number(rows[0]!.n);
      if (n > 0) console.log(`  ${t}: ${n}`);
      total += n;
    }
    console.log(`${total} rows would be deleted. Run again with --yes.`);
    process.exit(0);
  }

  await client.query('begin');
  // Foreign keys that form a cycle are cut first: a submitted count names its operation, and the
  // operation names its count (migration 0032).
  if (tables.includes('count_sessions'))
    await client.query(
      'update count_sessions set operation_id = null where shop_id = any($1::uuid[]) and operation_id is not null',
      [shopIds],
    );
  let remaining = [...tables];
  for (let round = 1; remaining.length > 0; round++) {
    if (round > tables.length + 1)
      throw new Error(`Could not delete from: ${remaining.join(', ')}`);
    const blocked: string[] = [];
    for (const t of remaining) {
      await client.query('savepoint s');
      try {
        const res = await client.query(`delete from ${t} where shop_id = any($1::uuid[])`, [
          shopIds,
        ]);
        await client.query('release savepoint s');
        if ((res.rowCount ?? 0) > 0) console.log(`  ${t}: ${res.rowCount}`);
      } catch (error) {
        await client.query('rollback to savepoint s');
        if ((error as { code?: string }).code !== '23503') throw error;
        blocked.push(t);
      }
    }
    remaining = blocked;
  }
  await client.query('delete from shops where id = any($1::uuid[])', [shopIds]);
  const users = await client.query(
    `delete from users u where u.workos_user_id like 'bench\\_%'
       and not exists (select 1 from memberships m where m.user_id = u.id)
       and not exists (select 1 from shops s where s.created_by = u.id)`,
  );
  await client.query('commit');
  console.log(`Deleted ${shopIds.length} shops and ${users.rowCount} benchmark users.`);
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  await client.end();
}
