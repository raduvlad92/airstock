-- MCP connection grants are created at the platform consent step (plan Section 7.2, option A),
-- before WorkOS issues a token. The OAuth client and the token subject are therefore unknown
-- until the first MCP request that carries the grant. That request binds them, and every later
-- request must present the same client and subject.
alter table connection_grants alter column client_id drop not null;
alter table connection_grants add column token_subject text;
alter table connection_grants add column bound_at timestamptz;

drop function resolve_connection_grant(uuid);
create function resolve_connection_grant(p_id uuid)
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
$$;

-- Binds an active, unbound grant to the client and subject of the first verified token that
-- carries it. The first binding wins under concurrency; the function returns the stored values
-- so the caller compares them with what it was presented.
create function bind_connection_grant(
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
  returning g.client_id, g.token_subject
$$;

revoke execute on function resolve_connection_grant(uuid),
  bind_connection_grant(uuid, text, text, text) from public;
grant execute on function resolve_connection_grant(uuid),
  bind_connection_grant(uuid, text, text, text) to airstock_app;
