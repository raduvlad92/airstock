-- Phase 2, milestone I6: Shopify returns (plan Section 5.14). In Shopify's return flow, returned
-- units are restocked through the return's reverse fulfillment order: each disposition says what
-- happened to some units of a line (restocked at a location, not restocked, to be processed, or
-- missing). Each is applied once: a restock raises Shopify's own available, and units that came
-- back start Airstock's return workflow (quarantine first, ADR 0029).
create table shopify_return_dispositions (
  shop_id uuid not null,
  connection_id uuid not null,
  shopify_disposition_id text not null check (shopify_disposition_id ~ '^[0-9]+$'),
  shopify_return_id text not null check (shopify_return_id ~ '^[0-9]+$'),
  shopify_order_id text not null,
  shopify_line_id text not null,
  items integer not null check (items > 0),
  disposition_type text not null
    check (disposition_type in ('restocked', 'not_restocked', 'processing_required', 'missing')),
  shopify_location_id text,
  disposed_at timestamptz not null,
  return_id uuid,
  processed_at timestamptz not null default now(),
  primary key (shop_id, connection_id, shopify_disposition_id),
  foreign key (shop_id, connection_id) references shopify_connections (shop_id, id),
  foreign key (shop_id, return_id) references returns (shop_id, id)
);
create index shopify_return_dispositions_order_idx
  on shopify_return_dispositions (shop_id, connection_id, shopify_order_id);

-- A refund issued through a Shopify return: its restock is the return's dispositions.
alter table shopify_refund_lines add column shopify_return_id text;

alter table shopify_return_dispositions enable row level security;
create policy tenant_isolation on shopify_return_dispositions
  using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
grant select, insert on shopify_return_dispositions to airstock_app;
