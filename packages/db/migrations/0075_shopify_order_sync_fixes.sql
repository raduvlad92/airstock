-- Shopify order sync fixes from the connector review (16 November 2026; ADRs 0033, 0035, 0036).
--
-- A line Airstock refuses to hold (its variant archived here while Shopify still sells it) is
-- recorded as `refused`, so the rest of its order applies; a line Shopify committed at a Shopify
-- location that is not mapped is recorded as `unmapped_location` and holds nothing here.
alter table shopify_order_lines drop constraint shopify_order_lines_outcome_check;
alter table shopify_order_lines add constraint shopify_order_lines_outcome_check
  check (outcome in ('reserved', 'shortage', 'unmapped', 'unmapped_location', 'refused',
    'before_connection'));
