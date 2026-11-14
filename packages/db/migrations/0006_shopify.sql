-- Phase 0 Shopify slice (plan Section 8): one connection per Shopify store, one location map,
-- variant maps, webhook receipts, and the record of Shopify's own levels that makes the
-- availability push a compare-and-set (plan P1).

-- One installed Shopify store, bound to exactly one shop. Tokens are AES-GCM ciphertexts
-- (packages/shopify/src/tokens.ts) with the key ID, so the key can rotate. Shopify issues
-- expiring offline tokens: a one-hour access token and a 90-day refresh token.
create table shopify_connections (
  shop_id uuid not null references shops (id),
  id uuid not null,
  shop_domain text not null check (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  status text not null default 'active' check (status in ('active', 'uninstalled')),
  scopes text[] not null,
  token_key_id text not null,
  -- Cleared when the app is uninstalled.
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  refresh_token_ciphertext text,
  refresh_token_expires_at timestamptz,
  -- Shopify locations as seen at install or at the last mapping, for the dashboard.
  shopify_locations jsonb not null default '[]'::jsonb,
  webhooks jsonb not null default '[]'::jsonb,
  installed_by_membership_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  uninstalled_at timestamptz,
  version integer not null default 1,
  primary key (shop_id, id),
  foreign key (shop_id, installed_by_membership_id) references memberships (shop_id, id)
);

-- A Shopify store sends its webhooks to one shop only, so it can be active in one shop only.
-- Unique indexes are not filtered by row-level security, so this holds across shops.
create unique index shopify_connections_active_domain_idx
  on shopify_connections (shop_domain) where status = 'active';

-- Phase 0 maps one Shopify location to one location per connection.
create table shopify_location_maps (
  shop_id uuid not null,
  connection_id uuid not null,
  shopify_location_id text not null check (shopify_location_id ~ '^[0-9]+$'),
  location_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, connection_id, shopify_location_id),
  unique (shop_id, connection_id, location_id),
  foreign key (shop_id, connection_id) references shopify_connections (shop_id, id),
  foreign key (shop_id, location_id) references locations (shop_id, id)
);

create table shopify_variant_maps (
  shop_id uuid not null,
  connection_id uuid not null,
  shopify_variant_id text not null check (shopify_variant_id ~ '^[0-9]+$'),
  shopify_inventory_item_id text not null check (shopify_inventory_item_id ~ '^[0-9]+$'),
  variant_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, connection_id, shopify_variant_id),
  unique (shop_id, connection_id, variant_id),
  foreign key (shop_id, connection_id) references shopify_connections (shop_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id)
);

-- What Airstock believes Shopify's `available` quantity is for one inventory item at one
-- Shopify location. A successful push sets it; every order line processed lowers it, because
-- Shopify already lowered its own quantity when it accepted the order. The push sends this
-- value as `changeFromQuantity`, so Shopify refuses the write when its quantity moved for a
-- reason Airstock has not seen yet (plan P1). Null means not read from Shopify yet.
create table shopify_inventory_levels (
  shop_id uuid not null,
  connection_id uuid not null,
  shopify_inventory_item_id text not null,
  shopify_location_id text not null,
  expected_available integer,
  -- When expected_available was last taken from Shopify (a read or an accepted push). An order
  -- lowers it only if Shopify created the order after this time; older orders are already in it.
  expected_as_of timestamptz,
  last_pushed_available integer,
  last_pushed_at timestamptz,
  -- Set while a difference with Shopify is unexplained; the conflict UI arrives in Phase 3.
  conflict_shopify_available integer,
  conflict_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (shop_id, connection_id, shopify_inventory_item_id, shopify_location_id),
  foreign key (shop_id, connection_id) references shopify_connections (shop_id, id)
);

-- One row per Shopify order line Airstock has processed, written in the same transaction as
-- the level adjustment, so a line lowers the expected level exactly once however often its
-- webhook, job, or catch-up runs.
create table shopify_order_lines (
  shop_id uuid not null,
  connection_id uuid not null,
  shopify_order_id text not null,
  shopify_line_id text not null,
  shopify_variant_id text,
  quantity integer not null,
  outcome text not null check (outcome in ('reserved', 'shortage', 'unmapped')),
  reservation_id uuid,
  processed_at timestamptz not null default now(),
  primary key (shop_id, connection_id, shopify_line_id),
  foreign key (shop_id, connection_id) references shopify_connections (shop_id, id)
);

create index shopify_order_lines_order_idx on shopify_order_lines (shop_id, connection_id, shopify_order_id);

-- One row per verified webhook delivery. Unique per connection, topic, and Shopify event ID,
-- so a redelivered or duplicated webhook has no second effect (A30).
create table webhook_receipts (
  shop_id uuid not null,
  id uuid not null,
  connection_id uuid not null,
  topic text not null,
  event_id text not null,
  webhook_id text,
  triggered_at timestamptz,
  job_id uuid,
  received_at timestamptz not null default now(),
  primary key (shop_id, id),
  unique (shop_id, connection_id, topic, event_id),
  foreign key (shop_id, connection_id) references shopify_connections (shop_id, id)
);

alter table shopify_connections enable row level security;
alter table shopify_location_maps enable row level security;
alter table shopify_variant_maps enable row level security;
alter table shopify_inventory_levels enable row level security;
alter table shopify_order_lines enable row level security;
alter table webhook_receipts enable row level security;

create policy tenant_isolation on shopify_connections using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on shopify_location_maps using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on shopify_variant_maps using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on shopify_inventory_levels using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on shopify_order_lines using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on webhook_receipts using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());

grant select, insert, update on shopify_connections, shopify_inventory_levels to airstock_app;
grant select, insert, delete on shopify_location_maps, shopify_variant_maps to airstock_app;
grant select, insert on shopify_order_lines, webhook_receipts to airstock_app;

-- A webhook names the store, not the shop. Resolves an active connection by store domain
-- before any shop context exists; the caller has already verified the webhook's HMAC.
create function shopify_connection_for_domain(p_domain text)
  returns table (shop_id uuid, connection_id uuid, installed_by_membership_id uuid)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select c.shop_id, c.id, c.installed_by_membership_id
  from shopify_connections c
  where c.shop_domain = p_domain and c.status = 'active'
$$;

create index jobs_open_idx on jobs (run_after) where status in ('pending', 'running');

-- Jobs whose queue message may have been lost: pending past their run time, or running for
-- longer than any job should. The scheduled handler sends them to the jobs queue again.
create function stale_jobs(p_limit integer)
  returns table (shop_id uuid, id uuid, kind text)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select j.shop_id, j.id, j.kind
  from jobs j
  where (j.status = 'pending' and j.run_after <= now() - interval '1 minute')
     or (j.status = 'running' and j.updated_at <= now() - interval '5 minutes')
  order by j.run_after
  limit least(p_limit, 500)
$$;

revoke execute on function shopify_connection_for_domain(text), stale_jobs(integer) from public;
grant execute on function shopify_connection_for_domain(text), stale_jobs(integer) to airstock_app;
