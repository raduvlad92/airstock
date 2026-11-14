import { bootstrap, migrate } from './migrate.ts';

const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('Set DATABASE_OWNER_URL to the owner (migration) role connection string.');
  process.exit(1);
}

if (process.argv.includes('--bootstrap')) {
  await bootstrap(url);
  console.log('Roles bootstrapped.');
}
const result = await migrate(url);
console.log(
  `Applied: ${result.applied.join(', ') || 'none'}; already applied: ${result.skipped.length}`,
);
