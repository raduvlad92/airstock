-- Phase 1, milestone N2: search, duplicate detection, and saved views.

-- Trigram similarity for typo-tolerant name search and similar-name warnings (plan 5.7, 5.10).
create extension if not exists pg_trgm;

create index products_name_trgm_idx on products using gin (name gin_trgm_ops);
-- Full-text search on name and description with the language-neutral `simple` configuration, so
-- several EU languages match word for word without stemming.
create index products_search_idx on products
  using gin (to_tsvector('simple', name || ' ' || coalesce(description, '')));
create index variants_sku_trgm_idx on variants using gin (sku_normalized gin_trgm_ops);

-- Saved views (plan 5.10): grid or gallery settings, private to their owner or shared with the shop.
create table saved_views (
  shop_id uuid not null references shops (id),
  id uuid not null,
  owner_membership_id uuid not null,
  name text not null check (length(name) between 1 and 100),
  shared boolean not null default false,
  -- {mode, viewType, columns: [{key, width, hidden}], sort, filter, search, density}
  definition jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (shop_id, id),
  foreign key (shop_id, owner_membership_id) references memberships (shop_id, id)
);

create index saved_views_owner_idx on saved_views (shop_id, owner_membership_id);

alter table saved_views enable row level security;
create policy tenant_isolation on saved_views using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
grant select, insert, update, delete on saved_views to airstock_app;
