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
