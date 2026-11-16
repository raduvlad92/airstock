-- Phase 2, milestone I6: listings in both directions (plan Section 5.14, D21). A product created
-- in Airstock can be listed to a connected store; a product created in Shopify is picked up and
-- matched by SKU or barcode. Each storefront field has an owner per listing: Airstock for products
-- created here, Shopify for products picked up from it. A change from the side that does not own a
-- field is recorded as a difference and shown in sync health, never applied silently.

create table shopify_listings (
  shop_id uuid not null,
  connection_id uuid not null,
  product_id uuid not null,
  -- Null until the product exists in Shopify.
  shopify_product_id text check (shopify_product_id ~ '^[0-9]+$'),
  origin text not null check (origin in ('airstock', 'shopify')),
  -- Per storefront field (title, description, status, prices, pictures): 'airstock' or 'shopify'.
  owners jsonb not null,
  -- The listing status Airstock asks for, where Airstock owns the status.
  desired_status text not null default 'draft' check (desired_status in ('draft', 'active', 'archived')),
  state text not null default 'pending' check (state in ('pending', 'published', 'failed')),
  last_error text check (length(last_error) <= 1000),
  attempts integer not null default 0,
  -- The storefront values on each side when they last agreed (as Airstock's fields and as
  -- Shopify returned them), so a later change is attributed to the side that made it.
  airstock_values jsonb,
  shopify_values jsonb,
  -- Airstock media uploaded to Shopify: {mediaId: shopifyMediaId}.
  pictures jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, connection_id, product_id),
  foreign key (shop_id, connection_id) references shopify_connections (shop_id, id),
  foreign key (shop_id, product_id) references products (shop_id, id)
);
create unique index shopify_listings_shopify_product_idx
  on shopify_listings (shop_id, connection_id, shopify_product_id) where shopify_product_id is not null;

-- A change made on the side that does not own the field: shown with "take Shopify's" or "push
-- Airstock's", applied only when a person chooses.
create table shopify_listing_differences (
  shop_id uuid not null,
  connection_id uuid not null,
  product_id uuid not null,
  field text not null check (field in ('title', 'description', 'status', 'prices', 'pictures')),
  airstock jsonb,
  shopify jsonb,
  -- Which side changed it: Shopify edited an Airstock-owned field, or the reverse.
  changed_by text not null check (changed_by in ('shopify', 'airstock')),
  detected_at timestamptz not null default now(),
  primary key (shop_id, connection_id, product_id, field),
  foreign key (shop_id, connection_id, product_id)
    references shopify_listings (shop_id, connection_id, product_id) on delete cascade
);

-- A shop setting per store: archive a sold one-of-a-kind item's listing (its quantity goes to
-- zero either way).
alter table shopify_connections add column archive_sold_listings boolean not null default false;

alter table shopify_listings enable row level security;
alter table shopify_listing_differences enable row level security;
create policy tenant_isolation on shopify_listings
  using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on shopify_listing_differences
  using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
grant select, insert, update on shopify_listings to airstock_app;
grant select, insert, update, delete on shopify_listing_differences to airstock_app;
