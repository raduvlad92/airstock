/**
 * Database size report for the benchmark project (plan Sections 8 and 9, risk R3): the database
 * size, each table with its indexes and TOAST, grouped as catalog, stock, history, and other, and
 * bytes per variant and per audit event. With NEON_API_KEY and NEON_PROJECT_ID set, it adds
 * Neon's own figures: the branch's logical size, the project's synthetic storage size (which
 * includes retained history), and the compute seconds used.
 *
 *   DATABASE_OWNER_URL=… [NEON_API_KEY=… NEON_PROJECT_ID=…] tsx scripts/bench/sizes.ts [--json out.json]
 *
 * Secrets come from the environment and are never printed.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';

const { values: args } = parseArgs({ options: { json: { type: 'string' } } });
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('Set DATABASE_OWNER_URL.');

const GROUPS: Record<string, string[]> = {
  catalog: [
    'products',
    'variants',
    'product_options',
    'product_option_values',
    'field_definitions',
    'field_options',
    'product_families',
    'family_fields',
    'family_option_suggestions',
    'record_relations',
    'variant_packaging',
    'packs',
    'pack_versions',
    'barcodes',
    'barcode_sequences',
    'bundles',
    'bundle_versions',
    'bundle_components',
    'suppliers',
    'supplier_items',
    'shipping_packages',
    'media',
    'media_links',
  ],
  stock: [
    'inventory_positions',
    'inventory_operations',
    'inventory_entries',
    'reservations',
    'reservation_allocations',
    'idempotency_records',
  ],
  storage: ['warehouses', 'locations', 'membership_location_scopes'],
  history: ['audit_events'],
};

const client = new pg.Client({ connectionString: url });
await client.connect();
const { rows: tables } = await client.query<{
  table: string;
  rows: string;
  heap: string;
  indexes: string;
  toast: string;
  total: string;
}>(
  // Partitions are counted under their parent.
  `with rel as (
     select coalesce(p.relname, c.relname) as table, c.oid, c.reltuples
     from pg_class c
     left join pg_inherits i on i.inhrelid = c.oid
     left join pg_class p on p.oid = i.inhparent
     where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace)
   select rel.table,
     sum(greatest(rel.reltuples, 0))::bigint::text as rows,
     sum(pg_relation_size(rel.oid))::text as heap,
     sum(pg_indexes_size(rel.oid))::text as indexes,
     sum(pg_total_relation_size(rel.oid) - pg_relation_size(rel.oid) - pg_indexes_size(rel.oid))::text as toast,
     sum(pg_total_relation_size(rel.oid))::text as total
   from rel group by rel.table order by sum(pg_total_relation_size(rel.oid)) desc`,
);
// Neon's limit applies to the whole cluster, which adds the postgres and template databases.
const { rows: db } = await client.query<{ size: string; cluster: string }>(
  `select pg_database_size(current_database())::text as size,
     (select sum(pg_database_size(datname)) from pg_database)::text as cluster`,
);
const { rows: counts } = await client.query<{ variants: string; events: string; shops: string }>(
  `select (select count(*) from variants)::text as variants,
     (select count(*) from audit_events)::text as events,
     (select count(*) from shops)::text as shops`,
);
await client.end();

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
const groupOf = (t: string) =>
  Object.entries(GROUPS).find(([, list]) => list.includes(t))?.[0] ?? 'other';
const byGroup: Record<string, number> = {};
for (const t of tables)
  byGroup[groupOf(t.table)] = (byGroup[groupOf(t.table)] ?? 0) + Number(t.total);
const variants = Number(counts[0]!.variants);
const events = Number(counts[0]!.events);
const audit = tables.find((t) => t.table === 'audit_events');

let neon: Record<string, unknown> | null = null;
if (process.env.NEON_API_KEY && process.env.NEON_PROJECT_ID) {
  const headers = {
    authorization: `Bearer ${process.env.NEON_API_KEY}`,
    accept: 'application/json',
  };
  const base = `https://console.neon.tech/api/v2/projects/${process.env.NEON_PROJECT_ID}`;
  const project = (await (await fetch(base, { headers })).json()) as {
    project: { synthetic_storage_size?: number; cpu_used_sec?: number };
  };
  const branches = (await (await fetch(`${base}/branches`, { headers })).json()) as {
    branches: Array<{ name: string; logical_size?: number; default?: boolean }>;
  };
  neon = {
    syntheticStorageMB: mb(project.project.synthetic_storage_size ?? 0),
    cpuUsedSeconds: project.project.cpu_used_sec ?? null,
    branches: branches.branches.map((b) => ({
      name: b.name,
      logicalSizeMB: mb(b.logical_size ?? 0),
      default: b.default ?? false,
    })),
  };
}

const report = {
  at: new Date().toISOString(),
  shops: Number(counts[0]!.shops),
  variants,
  auditEvents: events,
  databaseMB: mb(Number(db[0]!.size)),
  clusterMB: mb(Number(db[0]!.cluster)),
  groupsMB: Object.fromEntries(Object.entries(byGroup).map(([g, v]) => [g, mb(v)])),
  bytesPerVariant: variants
    ? Math.round(((byGroup.catalog ?? 0) + (byGroup.stock ?? 0)) / variants)
    : null,
  bytesPerVariantCatalogOnly: variants ? Math.round((byGroup.catalog ?? 0) / variants) : null,
  bytesPerAuditEvent:
    events && audit
      ? {
          heap: Math.round(Number(audit.heap) / events),
          toast: Math.round(Number(audit.toast) / events),
          indexes: Math.round(Number(audit.indexes) / events),
          total: Math.round(Number(audit.total) / events),
        }
      : null,
  neon,
  tables: tables
    .filter((t) => Number(t.total) > 256 * 1024)
    .map((t) => ({
      table: t.table,
      group: groupOf(t.table),
      rows: Number(t.rows),
      heapMB: mb(Number(t.heap)),
      indexesMB: mb(Number(t.indexes)),
      toastMB: mb(Number(t.toast)),
      totalMB: mb(Number(t.total)),
    })),
};
console.log(JSON.stringify(report, null, 2));
if (args.json) await writeFile(args.json, JSON.stringify(report, null, 2));
