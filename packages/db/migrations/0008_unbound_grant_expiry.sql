-- Unbound connection grants expire (report P15).
--
-- The consent step creates the grant before WorkOS shows its own consent screen. If the person
-- abandons that screen, the client never receives a code, no token can carry the grant, and it
-- would stay active and unbound in the shop forever (seen once on staging). A grant that no
-- verified token has bound within the bind window can no longer be bound, and the sweep records
-- it as expired. On staging ChatGPT bound its grants 31 and 38 s after consent; the slowest
-- binding seen was 251 s, by a scripted client.

alter table connection_grants drop constraint connection_grants_status_check;
alter table connection_grants add constraint connection_grants_status_check
  check (status in ('active', 'revoked', 'expired'));
alter table connection_grants add column expired_at timestamptz;

create index connection_grants_unbound_idx on connection_grants (created_at)
  where status = 'active' and bound_at is null;

-- How long a new grant waits for the first MCP request to bind it.
create function connection_bind_window() returns interval
  language sql immutable as $$ select interval '10 minutes' $$;

-- Unchanged, except that an unbound grant past the window resolves to nothing, whether or not
-- the sweep has marked it expired yet.
create or replace function resolve_connection_grant(p_id uuid)
  returns table (
    shop_id uuid, grant_id uuid, membership_id uuid, user_id uuid, role text,
    all_locations boolean, location_scope_ids uuid[], scopes text[], client_id text,
    token_subject text, workos_user_id text)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select g.shop_id, g.id, m.id, m.user_id, m.role, m.all_locations,
    coalesce((select array_agg(s.scope_id) from membership_location_scopes s
      where s.shop_id = m.shop_id and s.membership_id = m.id), '{}'),
    g.scopes, g.client_id, g.token_subject, u.workos_user_id
  from connection_grants g
  join memberships m on m.shop_id = g.shop_id and m.id = g.membership_id
  join users u on u.id = m.user_id
  where g.id = p_id and g.status = 'active' and m.status = 'active'
    and (g.bound_at is not null or g.created_at > now() - connection_bind_window())
$$;

-- Unchanged, except that it no longer binds an unbound grant past the window.
create or replace function bind_connection_grant(
  p_id uuid, p_client_id text, p_subject text, p_client_name text)
  returns table (client_id text, token_subject text)
  language sql volatile security definer set search_path = public, pg_temp
as $$
  update connection_grants g set
    client_id = coalesce(g.client_id, p_client_id),
    token_subject = coalesce(g.token_subject, p_subject),
    client_name = coalesce(g.client_name, p_client_name),
    bound_at = coalesce(g.bound_at, now())
  where g.id = p_id and g.status = 'active'
    and (g.bound_at is not null or g.created_at > now() - connection_bind_window())
  returning g.client_id, g.token_subject
$$;

-- The sweep finds shops with unbound grants past the window, then expires them inside each
-- shop, where row-level security applies, as it does for reservations.
create function shops_with_unbound_connection_grants(p_limit integer) returns setof uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select distinct g.shop_id
  from connection_grants g
  where g.status = 'active' and g.bound_at is null
    and g.created_at <= now() - connection_bind_window()
  limit least(p_limit, 500)
$$;

revoke execute on function shops_with_unbound_connection_grants(integer) from public;
grant execute on function shops_with_unbound_connection_grants(integer),
  connection_bind_window() to airstock_app;
