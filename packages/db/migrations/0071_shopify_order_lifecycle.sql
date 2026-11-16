-- Phase 2, milestone I6: the Shopify order lifecycle (plan Section 5.14, PRD 8.5). An order is
-- synced from its state in Shopify (lines with their current quantities, fulfillments, refunds,
-- cancellation), whatever webhook or reconciler run brought it, in one transaction per order. The
-- rows below record what Airstock already applied, so applying the same state twice changes
-- nothing and a later state applies only the difference.

-- One row per order Airstock follows: the lock that serializes syncs of one order, and when
-- Shopify last changed it.
create table shopify_orders (
  shop_id uuid not null,
  connection_id uuid not null,
  shopify_order_id text not null check (shopify_order_id ~ '^[0-9]+$'),
  shopify_created_at timestamptz not null,
  shopify_updated_at timestamptz,
  cancelled_at timestamptz,
  synced_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (shop_id, connection_id, shopify_order_id),
  foreign key (shop_id, connection_id) references shopify_connections (shop_id, id)
);

-- Lines: what Airstock holds for each.
alter table shopify_order_lines
  -- Where Shopify committed the units (from the order's fulfillment orders).
  add column shopify_location_id text,
  -- The map when the line was first seen: a variant, a pack of it, or a bundle.
  add column variant_id uuid,
  add column pack_id uuid,
  add column bundle boolean not null default false,
  -- Base units per Shopify item: the pack's base quantity, or 1 (a bundle: 1 bundle).
  add column per_item numeric(20, 6) not null default 1 check (per_item > 0),
  -- Shopify items Airstock holds as open demand (reserved or short) for the line.
  add column open_items integer not null default 0 check (open_items >= 0),
  -- Shopify items fulfilled through Shopify fulfillments (shipped, or released when the units
  -- left from a location Airstock does not hold).
  add column fulfilled_items integer not null default 0 check (fulfilled_items >= 0),
  -- Units Shopify took out of `available` at the line's location, as last applied to the expected
  -- quantity: the ordered quantity, less what edits removed (Shopify restocks those).
  add column effect_items integer,
  add column updated_at timestamptz not null default now(),
  add constraint shopify_order_lines_variant_fk foreign key (shop_id, variant_id)
    references variants (shop_id, id);
alter table shopify_order_lines drop constraint shopify_order_lines_outcome_check;
alter table shopify_order_lines add constraint shopify_order_lines_outcome_check
  check (outcome in ('reserved', 'shortage', 'unmapped', 'before_connection'));

-- Lines from the Phase 0 slice: one reservation each, still open as reserved.
update shopify_order_lines l set open_items = l.quantity, effect_items = l.quantity,
  variant_id = r.variant_id
from reservations r
where r.shop_id = l.shop_id and r.id = l.reservation_id and l.outcome in ('reserved', 'shortage')
  and r.status in ('active', 'partially_fulfilled');

-- The reservations made for a line, oldest first: an edit that adds quantity makes another one;
-- releases take the newest first, fulfillments the oldest.
create table shopify_line_reservations (
  shop_id uuid not null,
  connection_id uuid not null,
  shopify_line_id text not null,
  reservation_id uuid not null,
  -- Shopify items still open on this reservation.
  open_items integer not null check (open_items >= 0),
  created_at timestamptz not null default now(),
  primary key (shop_id, reservation_id),
  foreign key (shop_id, connection_id, shopify_line_id)
    references shopify_order_lines (shop_id, connection_id, shopify_line_id),
  foreign key (shop_id, reservation_id) references reservations (shop_id, id)
);
create index shopify_line_reservations_line_idx
  on shopify_line_reservations (shop_id, connection_id, shopify_line_id, created_at);

insert into shopify_line_reservations (shop_id, connection_id, shopify_line_id, reservation_id, open_items)
select l.shop_id, l.connection_id, l.shopify_line_id, l.reservation_id, l.open_items
from shopify_order_lines l where l.reservation_id is not null and l.open_items > 0;

-- Fulfillments Shopify reported: what was fulfilled here (the fulfillment operations, so a
-- cancellation reverses exactly them) and what was released because the units left from a
-- location Airstock does not hold or did not have.
create table shopify_fulfillments (
  shop_id uuid not null,
  connection_id uuid not null,
  shopify_fulfillment_id text not null check (shopify_fulfillment_id ~ '^[0-9]+$'),
  shopify_order_id text not null,
  shopify_location_id text,
  status text not null check (status in ('fulfilled', 'cancelled')),
  -- Per line: {"lineId", "items", "released", "operationIds"}.
  lines jsonb not null default '[]'::jsonb,
  -- Airstock's reversal operations when the fulfillment was cancelled.
  reversal_operation_ids uuid[] not null default '{}',
  fulfilled_at timestamptz not null default now(),
  cancelled_at timestamptz,
  primary key (shop_id, connection_id, shopify_fulfillment_id),
  foreign key (shop_id, connection_id) references shopify_connections (shop_id, id)
);
create index shopify_fulfillments_order_idx on shopify_fulfillments (shop_id, connection_id, shopify_order_id);

-- Refund lines Shopify reported, applied once each: a restock raises Shopify's own available, and
-- returned units start Airstock's return workflow (quarantine first, whatever the restock flag).
create table shopify_refund_lines (
  shop_id uuid not null,
  connection_id uuid not null,
  shopify_refund_id text not null check (shopify_refund_id ~ '^[0-9]+$'),
  shopify_line_id text not null,
  items integer not null check (items > 0),
  restock_type text not null check (restock_type in ('cancel', 'return', 'no_restock', 'legacy_restock')),
  shopify_location_id text,
  refunded_at timestamptz not null,
  return_id uuid,
  processed_at timestamptz not null default now(),
  primary key (shop_id, connection_id, shopify_refund_id, shopify_line_id),
  foreign key (shop_id, connection_id) references shopify_connections (shop_id, id),
  foreign key (shop_id, return_id) references returns (shop_id, id)
);

alter table shopify_orders enable row level security;
alter table shopify_line_reservations enable row level security;
alter table shopify_fulfillments enable row level security;
alter table shopify_refund_lines enable row level security;
create policy tenant_isolation on shopify_orders using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on shopify_line_reservations using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on shopify_fulfillments using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on shopify_refund_lines using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
grant select, insert, update on shopify_orders, shopify_line_reservations, shopify_fulfillments,
  shopify_refund_lines to airstock_app;
grant update on shopify_order_lines to airstock_app;
