-- Phase 2, milestone I5: activity views (plan Section 5.15, decision D15).
--
-- The timeline filters of PRD 7.4 over the monthly partitions, the ingestion delay the activity
-- views show, and the link from an import's record events to the request that committed it.

-- The queue consumer's last batch: when it arrived and how long its events had waited. The
-- activity views show a delay notice from it. One row for the platform; no shop data.
create table audit_ingestion_status (
  id boolean primary key default true check (id),
  last_batch_at timestamptz not null,
  last_batch_events integer not null,
  last_batch_lag_ms integer not null
);
grant select on audit_ingestion_status to airstock_app;

-- As in 0003, plus the ingestion status. Client-reported events carry the browser's time and
-- may arrive up to a day late by design, so they do not count toward the lag.
create or replace function ingest_audit_events(events jsonb) returns integer
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

  insert into audit_ingestion_status (id, last_batch_at, last_batch_events, last_batch_lag_ms)
  select true, now(), count(*),
    least(coalesce(extract(epoch from now() - min(e.occurred_at)) * 1000, 0), 2147483647)::integer
  from jsonb_to_recordset(events) as e(occurred_at timestamptz, action text)
  where e.action not like 'client.%'
  having count(*) > 0
  on conflict (id) do update set last_batch_at = excluded.last_batch_at,
    last_batch_events = excluded.last_batch_events,
    last_batch_lag_ms = excluded.last_batch_lag_ms;
  return inserted;
end
$$;

-- An import's record events carry the attempt ID of the request that committed it, so the
-- history shows the import as one batch: parent, then each record (PRD 7.4).
alter table import_jobs add column commit_attempt_id uuid;
