-- Phase 0 access: scoped API credentials and MCP connection grants, plus the few narrow
-- cross-shop functions that background work needs before it knows which shop to enter.

create table api_credentials (
  shop_id uuid not null,
  id uuid not null,
  -- A credential acts for one member and never exceeds that member's permissions or
  -- location scope (PRD 2.4, 8.3).
  membership_id uuid not null,
  name text not null check (length(name) between 1 and 100),
  -- SHA-256 of the 256-bit random secret. The secret itself is shown once and never stored.
  secret_hash text not null,
  scopes text[] not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  primary key (shop_id, id),
  foreign key (shop_id, membership_id) references memberships (shop_id, id)
);

-- One approved MCP/OAuth connection, bound to exactly one shop (PRD 9.4).
create table connection_grants (
  shop_id uuid not null,
  id uuid not null,
  membership_id uuid not null,
  client_id text not null,
  client_name text,
  scopes text[] not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  primary key (shop_id, id),
  foreign key (shop_id, membership_id) references memberships (shop_id, id)
);

alter table api_credentials enable row level security;
alter table connection_grants enable row level security;
create policy tenant_isolation on api_credentials using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on connection_grants using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
grant select, insert, update on api_credentials, connection_grants to airstock_app;

-- Resolves a presented credential ID to its shop and member before any shop context exists.
-- Returns nothing for a revoked credential or a removed member. The caller compares the
-- secret hash in constant time.
create function authenticate_api_credential(p_id uuid)
  returns table (
    shop_id uuid, credential_id uuid, membership_id uuid, user_id uuid, role text,
    all_locations boolean, location_scope_ids uuid[], scopes text[], secret_hash text)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select c.shop_id, c.id, m.id, m.user_id, m.role, m.all_locations,
    coalesce((select array_agg(s.scope_id) from membership_location_scopes s
      where s.shop_id = m.shop_id and s.membership_id = m.id), '{}'),
    c.scopes, c.secret_hash
  from api_credentials c
  join memberships m on m.shop_id = c.shop_id and m.id = c.membership_id
  where c.id = p_id and c.status = 'active' and m.status = 'active'
$$;

-- Same for an MCP connection grant. Called on every MCP request, so revocation in the
-- platform stops the next tool call even while an issued token is still unexpired.
create function resolve_connection_grant(p_id uuid)
  returns table (
    shop_id uuid, grant_id uuid, membership_id uuid, user_id uuid, role text,
    all_locations boolean, location_scope_ids uuid[], scopes text[], client_id text,
    workos_user_id text)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select g.shop_id, g.id, m.id, m.user_id, m.role, m.all_locations,
    coalesce((select array_agg(s.scope_id) from membership_location_scopes s
      where s.shop_id = m.shop_id and s.membership_id = m.id), '{}'),
    g.scopes, g.client_id, u.workos_user_id
  from connection_grants g
  join memberships m on m.shop_id = g.shop_id and m.id = g.membership_id
  join users u on u.id = m.user_id
  where g.id = p_id and g.status = 'active' and m.status = 'active'
$$;

-- Outbox rows waiting for delivery, oldest first, across shops.
create function pending_outbox_events(p_limit integer)
  returns table (shop_id uuid, id uuid, topic text, payload jsonb, created_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select o.shop_id, o.id, o.topic, o.payload, o.created_at
  from outbox_events o
  where o.dispatched_at is null
  order by o.created_at
  limit least(p_limit, 500)
$$;

create function mark_outbox_dispatched(p_ids uuid[]) returns integer
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  updated integer;
begin
  update outbox_events set dispatched_at = now(), attempts = attempts + 1
  where id = any(p_ids) and dispatched_at is null;
  get diagnostics updated = row_count;
  return updated;
end
$$;

-- Shops holding reservations past their expiry that still have outstanding allocations.
create function shops_with_expired_reservations(p_limit integer) returns setof uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select distinct r.shop_id
  from reservations r
  where r.status in ('active', 'partially_fulfilled') and r.expires_at <= now()
  limit least(p_limit, 500)
$$;

revoke execute on function authenticate_api_credential(uuid), resolve_connection_grant(uuid),
  pending_outbox_events(integer), mark_outbox_dispatched(uuid[]),
  shops_with_expired_reservations(integer) from public;
grant execute on function authenticate_api_credential(uuid), resolve_connection_grant(uuid),
  pending_outbox_events(integer), mark_outbox_dispatched(uuid[]),
  shops_with_expired_reservations(integer) to airstock_app;

-- Sign-in: find or create the user for a verified identity-provider user ID. Runs before any
-- user context exists, so it bypasses the users policies; it only touches that one user.
create function upsert_user_by_workos_id(
  p_new_id uuid, p_workos_user_id text, p_email text, p_display_name text) returns uuid
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  found_id uuid;
begin
  insert into users (id, workos_user_id, email, display_name)
  values (p_new_id, p_workos_user_id, p_email, p_display_name)
  on conflict (workos_user_id) do update
    set email = excluded.email, display_name = coalesce(excluded.display_name, users.display_name)
  returning id into found_id;
  return found_id;
end
$$;

revoke execute on function upsert_user_by_workos_id(uuid, text, text, text) from public;
grant execute on function upsert_user_by_workos_id(uuid, text, text, text) to airstock_app;
