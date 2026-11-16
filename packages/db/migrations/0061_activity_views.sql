-- Phase 2, milestone I5: activity views (plan Section 5.15, decision D15; ADR "Activity views").
--
-- The timeline filters of PRD 7.4 over the monthly partitions, the ingestion delay the activity
-- views show, and the link from an import's record events to the request that committed it.
-- The index choices were measured on the 1-million-event bench history
-- (docs/phase-2-measurements.md, "I5 activity search").

-- The queue consumer's last batch: when it arrived and how long its events had waited. The
-- activity views show a delay notice from it. One row for the platform; no shop data.
create table audit_ingestion_status (
  id boolean primary key default true check (id),
  last_batch_at timestamptz not null,
  last_batch_events integer not null,
  last_batch_lag_ms integer not null
);
grant select on audit_ingestion_status to airstock_app;

-- An import's record events carry the attempt ID of the request that committed it, so the
-- history shows the import as one batch: the request, then each record (PRD 7.4).
alter table import_jobs add column commit_attempt_id uuid;

-- History is keyed by shop first. The old primary key (occurred_at, event_id) had no shop, and
-- whenever the planner expected a filter to match often, it walked that key backwards through
-- every shop's events: 961,000 rows for one shop's search in the I0 baseline. A shop-first key
-- leaves no such path, and it replaces audit_events_shop_time_idx, which held the same columns.
-- Redelivered events are still ignored: an event's shop, time, and ID are all fixed when it is
-- created. NULLS NOT DISTINCT keeps that true for platform events, which have no shop.
alter table audit_events drop constraint audit_events_pkey;
alter table audit_events add constraint audit_events_shop_event_key
  unique nulls not distinct (shop_id, occurred_at, event_id);
drop index audit_events_shop_time_idx;

-- No default partition. With one, PostgreSQL cannot read the months in order: a search starts
-- every month at once and reads each to its first match, so an action that is new this month
-- reads the shop's whole history in the older ones. Without it, the newest month is read first
-- and the search stops at a full page. The daily job keeps three months of partitions ahead
-- (ensure_audit_partitions); an event outside them now fails loudly instead of landing here.
do $$
begin
  if exists (select 1 from audit_events_default) then
    raise exception 'audit_events_default has rows; move them into monthly partitions first';
  end if;
end
$$;
drop table audit_events_default;

-- As in 0003, deduplicating on the new key, plus the ingestion status: how long the events this
-- batch added had waited. Redelivered events are left out (they were counted when they first
-- arrived), and so are client-reported ones, which carry the browser's time and may arrive up to
-- a day late by design.
create or replace function ingest_audit_events(events jsonb) returns integer
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  inserted integer;
  oldest timestamptz;
begin
  with added as (
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
    on conflict (shop_id, occurred_at, event_id) do nothing
    returning occurred_at, action
  )
  select count(*)::integer, min(occurred_at) filter (where action not like 'client.%')
  into inserted, oldest
  from added;

  if oldest is not null then
    insert into audit_ingestion_status (id, last_batch_at, last_batch_events, last_batch_lag_ms)
    values (true, now(), inserted,
      least(greatest(extract(epoch from now() - oldest) * 1000, 0), 2147483647)::integer)
    on conflict (id) do update set last_batch_at = excluded.last_batch_at,
      last_batch_events = excluded.last_batch_events,
      last_batch_lag_ms = excluded.last_batch_lag_ms;
  end if;
  return inserted;
end
$$;

-- Indexes for the PRD 7.4 filters. A search walks the shop's key newest first and stops at a
-- full page, which is fast for any filter matching more than a few percent of the shop's events.
-- These serve the rare ones, where that walk would read the shop's whole history. Their keys
-- leave out the time, so B-tree deduplication stores each shop and value once with a list of
-- rows: about 8 bytes per event each, against about 105 for a key ending in the time. The
-- matches are few, so sorting them is cheap.
create index audit_events_shop_actor_idx on audit_events (shop_id, actor_id);
-- In collation "C": equality whatever the database's collation, and the loose scan that turns
-- an action group (`inventory.*`) into the shop's own actions (activity/query.ts).
create index audit_events_shop_action_idx on audit_events (shop_id, action collate "C");
-- A source's share differs between shops; the search checks the shop has used it at all.
create index audit_events_shop_source_idx on audit_events (shop_id, source);
-- Failures, denials, and conflicts: under 1% of events.
create index audit_events_shop_problems_idx on audit_events (shop_id, outcome)
  where outcome not in ('succeeded', 'received');
-- Warehouse and location filters, and location-scoped history (PRD 2.4).
create index audit_events_locations_idx on audit_events using gin (location_ids)
  where location_ids is not null;
-- Stock events of one inventory operation.
create index audit_events_operation_idx on audit_events (operation_id)
  where operation_id is not null;
-- One request's events (a batch). Over half of all events are reads without an attempt; they
-- no longer take space here.
drop index audit_events_attempt_idx;
create index audit_events_attempt_idx on audit_events (attempt_id) where attempt_id is not null;
