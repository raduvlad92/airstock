-- Shopify order sync fixes from the connector review (16 November 2026; ADRs 0033, 0035, 0036).
--
-- A line Airstock refuses to hold (its variant archived here while Shopify still sells it) is
-- recorded as `refused`, so the rest of its order applies; a line Shopify committed at a Shopify
-- location that is not mapped is recorded as `unmapped_location` and holds nothing here.
alter table shopify_order_lines drop constraint shopify_order_lines_outcome_check;
alter table shopify_order_lines add constraint shopify_order_lines_outcome_check
  check (outcome in ('reserved', 'shortage', 'unmapped', 'unmapped_location', 'refused',
    'before_connection'));

-- The reconciler's place in Shopify's list of updated orders when a run stopped early (its
-- budget or 250 orders): the search's start and Shopify's page cursor. The next run continues
-- the same search from the cursor instead of reading the same orders again; a run that reaches
-- the last page clears both and moves `orders_synced_through`.
alter table shopify_connections
  add column orders_page_since timestamptz,
  add column orders_page_after text check (length(orders_page_after) <= 1000);

-- Orders created at or after this time are followed for the map even when Airstock saw them
-- before the map existed (their lines were recorded as unmapped). The onboarding sets it to the
-- start of its catalog read, whose quantities became opening stock: an order placed while the
-- preview waited took units that opening stock still counts, so it is held here once mapped.
-- Null for other maps (orders seen before the map stay Shopify's, ADR 0033).
alter table shopify_variant_maps add column orders_from timestamptz;

-- A store uninstalled and installed again in the same shop: the new connection takes over the
-- previous one's orders, holds, maps, and records, so its open orders are still followed (their
-- fulfillments and cancellations land on the holds made for them). `orders_from` is when the
-- connection's orders start: the first connection's creation; earlier orders stay Shopify's.
alter table shopify_connections add column orders_from timestamptz;

alter table shopify_line_reservations
  drop constraint shopify_line_reservations_shop_id_connection_id_shopify_li_fkey,
  add constraint shopify_line_reservations_line_fkey foreign key (shop_id, connection_id,
    shopify_line_id) references shopify_order_lines (shop_id, connection_id, shopify_line_id)
    on update cascade;
alter table shopify_listing_differences
  drop constraint shopify_listing_differences_shop_id_connection_id_product__fkey,
  add constraint shopify_listing_differences_listing_fkey foreign key (shop_id, connection_id,
    product_id) references shopify_listings (shop_id, connection_id, product_id)
    on delete cascade on update cascade;

grant update on shopify_return_dispositions to airstock_app;

-- Uninstalled connections of a store, in every shop: shop/redact (Shopify's notice, 48 hours after
-- an uninstall, that the store is gone for good) releases what their orders still hold.
create function shopify_uninstalled_connections_for_domain(p_domain text)
  returns table (shop_id uuid, connection_id uuid, installed_by_membership_id uuid)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select c.shop_id, c.id, c.installed_by_membership_id
  from shopify_connections c
  where c.shop_domain = p_domain and c.status = 'uninstalled'
$$;
revoke execute on function shopify_uninstalled_connections_for_domain(text) from public;
grant execute on function shopify_uninstalled_connections_for_domain(text) to airstock_app;
