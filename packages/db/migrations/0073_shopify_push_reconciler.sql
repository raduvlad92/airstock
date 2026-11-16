-- Phase 2, milestone I6: the batched availability push and the Shopify reconciler (plan Section
-- 5.14, D18). The reconciler runs with the existing 30-minute and daily crons: it applies orders
-- Shopify changed since a cursor (missed or late webhooks), then compares Airstock's record of
-- Shopify's quantities with Shopify's own, for recently changed levels every run and for every
-- level daily. A difference no order explains is a conflict: an alert, a webhook event, and
-- Shopify left untouched.

alter table shopify_connections
  -- Orders Shopify updated up to this time have been applied (the reconciler's cursor).
  add column orders_synced_through timestamptz,
  -- The last reconciler run that finished, and the last full level comparison.
  add column reconciled_at timestamptz,
  add column levels_compared_at timestamptz,
  -- The last push Shopify accepted, and the last sync error (cleared by a good run).
  add column last_pushed_at timestamptz,
  add column last_error text check (length(last_error) <= 1000),
  add column last_error_at timestamptz;

alter table shopify_inventory_levels
  -- Shopify's quantity when the reconciler last read it.
  add column checked_available integer,
  add column checked_at timestamptz,
  -- The open alert for an unexplained difference (kind shopify_sync).
  add column conflict_alert_id uuid,
  -- Airstock's availability when the conflict was found.
  add column conflict_airstock_available integer;

create index shopify_inventory_levels_conflicts_idx on shopify_inventory_levels (shop_id, connection_id)
  where conflict_at is not null;

-- Connections the reconciler should run: every active one with mapped locations, least recently
-- reconciled first. Daily runs take those whose levels were not compared for a day.
create function shopify_connections_due(p_daily boolean, p_limit integer)
  returns table (shop_id uuid, connection_id uuid)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select c.shop_id, c.id from shopify_connections c
  where c.status = 'active'
    and exists (select 1 from shopify_location_maps m where m.shop_id = c.shop_id and m.connection_id = c.id)
    and (not p_daily or c.levels_compared_at is null or c.levels_compared_at < now() - interval '23 hours')
  order by case when p_daily then c.levels_compared_at else c.reconciled_at end nulls first, c.id
  limit least(p_limit, 500)
$$;

revoke execute on function shopify_connections_due(boolean, integer) from public;
grant execute on function shopify_connections_due(boolean, integer) to airstock_app;
