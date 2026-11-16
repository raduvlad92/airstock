-- Phase 2, milestone I5: outgoing webhooks (plan Section 5.13, decision D14).
--
-- Each shop configures its own subscriptions: an HTTPS URL, the event types it chose from the
-- registry in code, optional location and alert-kind filters, and a signing secret stored
-- encrypted. Domain events reach the outbox in the same transaction as the change. The
-- dispatcher stores each event once and fans it out into one delivery per matching subscription;
-- every retry and replay sends the same event ID. Events and deliveries are kept 30 days.

create table webhook_subscriptions (
  shop_id uuid not null references shops (id),
  id uuid not null,
  name text not null check (length(name) between 1 and 100),
  url text not null check (length(url) between 9 and 2000),
  event_types text[] not null check (cardinality(event_types) between 1 and 50),
  -- Warehouse or location IDs; an event matches when one of its locations lies inside one of
  -- them. Empty means every location. Only event types that carry locations are filtered.
  location_ids uuid[] not null default '{}',
  -- Alert kinds; empty means every kind. Only alert event types are filtered.
  alert_kinds text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'disabled', 'deleted')),
  -- Why a subscription is disabled: by a person, or automatically after 3 days of failures.
  disabled_reason text check (disabled_reason in ('manual', 'failing')),
  -- AES-256-GCM ciphertexts of the signing secrets; the secret is shown once when created.
  secret_key_id text not null,
  secret_ciphertext text not null,
  secret_hint text not null,
  -- During a rotation, deliveries are signed with both secrets until this time.
  previous_secret_ciphertext text,
  previous_secret_expires_at timestamptz,
  -- The first failed delivery since the last success; cleared by any success.
  failing_since timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_by_membership_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  primary key (shop_id, id)
);

create index webhook_subscriptions_active_idx on webhook_subscriptions (shop_id) where status = 'active';

-- One row per event that had at least one subscriber when it was dispatched. Its ID is the
-- envelope `id`, the same on every retry and replay, so consumers deduplicate by it (A19).
create table webhook_events (
  shop_id uuid not null references shops (id),
  id uuid not null,
  type text not null check (length(type) between 1 and 100),
  data jsonb not null,
  -- The leaf locations the event is about, for location filters.
  location_ids uuid[] not null default '{}',
  alert_kind text,
  -- Sent by "Send test": the envelope says so, and it never counts toward failures.
  test boolean not null default false,
  created_at timestamptz not null,
  primary key (shop_id, id)
);

create index webhook_events_created_idx on webhook_events (created_at);

create table webhook_deliveries (
  shop_id uuid not null,
  id uuid not null,
  subscription_id uuid not null,
  event_id uuid not null,
  -- A replay is a new delivery of the same event to the same subscription. No foreign key:
  -- the original may age out first.
  replay_of uuid,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'retrying', 'delivered', 'failed', 'cancelled')),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  -- Set while one sender holds the delivery; an expired lease is recovered by the sweep.
  lease_until timestamptz,
  last_attempt_at timestamptz,
  last_status_code integer,
  last_error text,
  -- At most the first 1 KB of the last response body.
  last_response text check (length(last_response) <= 1024),
  last_duration_ms integer,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  foreign key (shop_id, subscription_id) references webhook_subscriptions (shop_id, id),
  foreign key (shop_id, event_id) references webhook_events (shop_id, id)
);

-- A redelivered outbox message fans out once.
create unique index webhook_deliveries_fanout_idx
  on webhook_deliveries (shop_id, subscription_id, event_id) where replay_of is null;
create index webhook_deliveries_log_idx on webhook_deliveries (shop_id, created_at desc, id desc);
create index webhook_deliveries_open_idx on webhook_deliveries (next_attempt_at)
  where status in ('pending', 'sending', 'retrying');
create index webhook_deliveries_created_idx on webhook_deliveries (created_at);

alter table webhook_subscriptions enable row level security;
alter table webhook_events enable row level security;
alter table webhook_deliveries enable row level security;
create policy tenant_isolation on webhook_subscriptions using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on webhook_events using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on webhook_deliveries using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
grant select, insert, update on webhook_subscriptions, webhook_events, webhook_deliveries to airstock_app;

-- Deliveries whose retry message was lost (due for more than 5 minutes) or whose sender stopped
-- mid-attempt (lease expired), across shops, for the 30-minute sweep. They are marked for retry
-- and returned so the sweep can queue them again.
create function recover_webhook_deliveries(p_limit integer)
  returns table (shop_id uuid, id uuid)
  language sql volatile security definer set search_path = public, pg_temp
as $$
  with stalled as (
    select d.shop_id, d.id from webhook_deliveries d
    where (d.status in ('pending', 'retrying') and d.next_attempt_at <= now() - interval '5 minutes')
       or (d.status = 'sending' and d.lease_until < now())
    order by d.next_attempt_at
    limit least(p_limit, 500)
    for update skip locked)
  update webhook_deliveries d
  set status = 'retrying', lease_until = null, next_attempt_at = least(d.next_attempt_at, now())
  from stalled s
  where d.shop_id = s.shop_id and d.id = s.id
  returning d.shop_id, d.id
$$;

-- The daily sweep: deliveries and events older than the retention window, across shops.
-- Open deliveries stay until they finish.
create function delete_old_webhook_history(p_days integer) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  deleted integer;
begin
  delete from webhook_deliveries
  where created_at < now() - make_interval(days => p_days)
    and status not in ('pending', 'sending', 'retrying');
  get diagnostics deleted = row_count;
  delete from webhook_events e
  where e.created_at < now() - make_interval(days => p_days)
    and not exists (
      select 1 from webhook_deliveries d where d.shop_id = e.shop_id and d.event_id = e.id);
  return deleted;
end
$$;

revoke execute on function recover_webhook_deliveries(integer), delete_old_webhook_history(integer) from public;
grant execute on function recover_webhook_deliveries(integer), delete_old_webhook_history(integer) to airstock_app;

-- Delivery outcomes are recorded with source `webhooks` (actor: the system).
alter table audit_events drop constraint audit_events_source_check;
alter table audit_events add constraint audit_events_source_check
  check (source in ('dashboard', 'api', 'mcp', 'import', 'scheduled', 'admin', 'shopify', 'webhooks'));
