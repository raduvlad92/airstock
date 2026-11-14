-- Phase 0 delivery and audit: idempotency, outbox, jobs, and the activity history.

create table idempotency_records (
  shop_id uuid not null,
  -- Who sent the command: a user, an API credential, a connection grant, or a connector.
  caller_id text not null,
  operation_id text not null,
  key text not null check (length(key) between 1 and 200),
  request_hash text not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  response jsonb,
  result_operation_id uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (shop_id, caller_id, operation_id, key),
  foreign key (shop_id) references shops (id)
);

-- Rows written in the same transaction as the change they announce, delivered after commit.
create table outbox_events (
  shop_id uuid not null,
  id uuid not null,
  topic text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  attempts integer not null default 0,
  primary key (shop_id, id),
  foreign key (shop_id) references shops (id)
);

create index outbox_events_pending_idx on outbox_events (created_at) where dispatched_at is null;

create table jobs (
  shop_id uuid not null,
  id uuid not null,
  kind text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  payload jsonb not null,
  attempts integer not null default 0,
  last_error text,
  run_after timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, id),
  foreign key (shop_id) references shops (id)
);

-- Activity history (PRD 7). Partitioned by month on the time the event was created.
-- The event ID and occurred_at are fixed when the event is created, so a retried queue
-- delivery lands on the same (occurred_at, event_id) key and is ignored (plan P4).
create table audit_events (
  event_id uuid not null,
  occurred_at timestamptz not null,
  schema_version smallint not null,
  shop_id uuid,                -- null for platform-scope events
  actor_type text not null,
  actor_id text,
  on_behalf_of text,           -- the real administrator when acting for someone else
  client_id text,
  grant_id uuid,
  action text not null,
  phase text not null check (phase in ('attempt', 'outcome')),
  outcome text not null check (outcome in ('received', 'succeeded', 'failed', 'denied', 'cancelled', 'conflict', 'no_change', 'replayed', 'unknown')),
  source text not null check (source in ('dashboard', 'api', 'mcp', 'import', 'scheduled', 'admin', 'shopify')),
  attempt_id uuid,
  request_id uuid,
  operation_id uuid,
  target_type text,
  target_id text,
  location_ids uuid[],
  idempotency_key text,
  external_ref text,
  reason text,
  changes jsonb,
  context jsonb,
  error jsonb,
  ingested_at timestamptz not null default now(),
  primary key (occurred_at, event_id)
) partition by range (occurred_at);

create table audit_events_default partition of audit_events default;

create index audit_events_shop_time_idx on audit_events (shop_id, occurred_at desc, event_id desc);
create index audit_events_target_idx on audit_events (shop_id, target_type, target_id, occurred_at desc);
create index audit_events_attempt_idx on audit_events (attempt_id);

-- Creates monthly partitions from last month through `months_ahead` months from now.
-- Runs from migrations and from the scheduled handler, so the default partition stays empty.
create function ensure_audit_partitions(months_ahead integer default 3) returns integer
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  month_start date := date_trunc('month', now() - interval '1 month')::date;
  created integer := 0;
  name text;
begin
  for i in 0 .. months_ahead + 1 loop
    name := format('audit_events_%s', to_char(month_start, 'YYYY_MM'));
    if to_regclass(name) is null then
      execute format(
        'create table %I partition of audit_events for values from (%L) to (%L)',
        name, month_start, (month_start + interval '1 month')::date);
      created := created + 1;
    end if;
    month_start := (month_start + interval '1 month')::date;
  end loop;
  return created;
end
$$;

select ensure_audit_partitions(3);

-- Batch ingestion for the audit-intake queue consumer. One call per queue batch; events for
-- several shops arrive together, so this runs as the table owner rather than under the
-- per-shop policies. It only inserts, and duplicates are ignored.
create function ingest_audit_events(events jsonb) returns integer
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  inserted integer;
begin
  insert into audit_events (
    event_id, occurred_at, schema_version, shop_id, actor_type, actor_id, on_behalf_of,
    client_id, grant_id, action, phase, outcome, source, attempt_id, request_id, operation_id,
    target_type, target_id, location_ids, idempotency_key, external_ref, reason, changes,
    context, error)
  select
    e.event_id, e.occurred_at, e.schema_version, e.shop_id, e.actor_type, e.actor_id,
    e.on_behalf_of, e.client_id, e.grant_id, e.action, e.phase, e.outcome, e.source,
    e.attempt_id, e.request_id, e.operation_id, e.target_type, e.target_id, e.location_ids,
    e.idempotency_key, e.external_ref, e.reason, e.changes, e.context, e.error
  from jsonb_to_recordset(events) as e(
    event_id uuid, occurred_at timestamptz, schema_version smallint, shop_id uuid,
    actor_type text, actor_id text, on_behalf_of text, client_id text, grant_id uuid,
    action text, phase text, outcome text, source text, attempt_id uuid, request_id uuid,
    operation_id uuid, target_type text, target_id text, location_ids uuid[],
    idempotency_key text, external_ref text, reason text, changes jsonb, context jsonb,
    error jsonb)
  on conflict (occurred_at, event_id) do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end
$$;

alter table idempotency_records enable row level security;
alter table outbox_events enable row level security;
alter table jobs enable row level security;
alter table audit_events enable row level security;

create policy tenant_isolation on idempotency_records using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on outbox_events using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on jobs using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy shop_history on audit_events for select using (shop_id = app_shop_id());
create policy shop_history_insert on audit_events for insert with check (shop_id = app_shop_id());

grant select, insert, update on idempotency_records, outbox_events, jobs to airstock_app;
-- History is append-only for the runtime role (PRD 7.4).
grant select, insert on audit_events to airstock_app;
grant execute on function ensure_audit_partitions(integer), ingest_audit_events(jsonb) to airstock_app;
revoke execute on function ensure_audit_partitions(integer), ingest_audit_events(jsonb) from public;
