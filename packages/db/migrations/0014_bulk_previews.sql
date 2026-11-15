-- Phase 1, milestone N3: bulk edit previews (plan Section 5.11, decision D4).
--
-- A change to more than one record (a paste, a fill, any multi-record change from MCP) is
-- previewed first. The preview stores who made it, the target records, the values they had when
-- previewed, and the changes, for 15 minutes. Commit applies all or nothing and is rejected if any
-- of those values changed since.

create table bulk_previews (
  shop_id uuid not null references shops (id),
  id uuid not null,
  -- The caller that made the preview (callerKey); only the same caller may commit it.
  caller_id text not null,
  status text not null default 'open' check (status in ('open', 'committed', 'stale', 'expired')),
  -- [{productId, changes: [{variantId?, field, expected, value?, inherit?}]}]
  changes jsonb not null,
  record_count integer not null check (record_count between 1 and 500),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  primary key (shop_id, id)
);

create index bulk_previews_open_idx on bulk_previews (expires_at) where status = 'open';

alter table bulk_previews enable row level security;
create policy tenant_isolation on bulk_previews using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
grant select, insert, update on bulk_previews to airstock_app;
