-- Phase 1, milestone N7: CSV imports and exports (plan Section 5.12, decision D10).
--
-- Files live in R2. An import is uploaded, previewed (every row validated, nothing written), then
-- committed by a job in chunks of about 200 rows per transaction, each with its rows' outcomes, a
-- change event per record, and a checkpoint, so an interrupted import resumes where it stopped.

create table import_jobs (
  shop_id uuid not null references shops (id),
  id uuid not null,
  -- Who started it, so the job acts with that member's access and the history names them.
  caller jsonb not null,
  file_key text not null,
  file_name text not null check (length(file_name) between 1 and 200),
  size_bytes integer,
  status text not null default 'uploading' check (status in
    ('uploading', 'uploaded', 'previewed', 'committing', 'completed', 'failed', 'cancelled')),
  delimiter text check (delimiter in (',', ';')),
  header jsonb,
  -- {"csv column": "target"}, where target is a built-in field, field:<key>, option:<name>,
  -- stock:<locationId>, product, or ignore.
  mapping jsonb,
  row_count integer,
  -- Preview totals: creates, updates, errors, warnings; commit totals: done, failed.
  counts jsonb not null default '{}'::jsonb,
  -- The highest row number committed; a resumed job continues after it.
  checkpoint integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  committed_at timestamptz,
  completed_at timestamptz,
  version integer not null default 1,
  primary key (shop_id, id)
);

create table import_rows (
  shop_id uuid not null,
  import_id uuid not null,
  row_number integer not null,
  -- Rows of one product share a group and commit in the same chunk.
  group_key text not null,
  action text not null check (action in ('create', 'update', 'error')),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed', 'skipped')),
  -- The validated values in their stored form, ready to write.
  data jsonb,
  errors jsonb,
  warnings jsonb,
  product_id uuid,
  variant_id uuid,
  -- Opening stock received for this row (receipts run after the row's chunk commits).
  stocked boolean not null default false,
  primary key (shop_id, import_id, row_number),
  foreign key (shop_id, import_id) references import_jobs (shop_id, id)
);

create index import_rows_pending_idx on import_rows (shop_id, import_id, group_key) where status = 'pending';

create table export_jobs (
  shop_id uuid not null references shops (id),
  id uuid not null,
  caller jsonb not null,
  -- The catalog query (mode, search, filter, sort, fields) and the export's columns.
  query jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  file_key text,
  row_count integer,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  -- Downloads are offered for 24 hours; the file is deleted after 7 days. The history stays.
  download_until timestamptz,
  delete_after timestamptz,
  file_deleted_at timestamptz,
  primary key (shop_id, id)
);

create index export_jobs_delete_idx on export_jobs (delete_after) where file_deleted_at is null;

alter table import_jobs enable row level security;
alter table import_rows enable row level security;
alter table export_jobs enable row level security;
create policy tenant_isolation on import_jobs using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on import_rows using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on export_jobs using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
grant select, insert, update on import_jobs, export_jobs to airstock_app;
-- A new preview replaces the previous one's rows.
grant select, insert, update, delete on import_rows to airstock_app;

-- Export files past their 7 days, across shops, for the daily sweep.
create function expired_export_files(p_limit integer)
  returns table (shop_id uuid, id uuid, file_key text)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select e.shop_id, e.id, e.file_key from export_jobs e
  where e.file_deleted_at is null and e.file_key is not null and e.delete_after <= now()
  order by e.delete_after limit least(p_limit, 500)
$$;

revoke execute on function expired_export_files(integer) from public;
grant execute on function expired_export_files(integer) to airstock_app;

-- Imports whose job stopped mid-way (a lost queue message or a crash), for the sweep to resume.
create function stale_imports(p_limit integer)
  returns table (shop_id uuid, id uuid)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select i.shop_id, i.id from import_jobs i
  where i.status = 'committing' and i.updated_at <= now() - interval '5 minutes'
  order by i.updated_at limit least(p_limit, 100)
$$;

revoke execute on function stale_imports(integer) from public;
grant execute on function stale_imports(integer) to airstock_app;
