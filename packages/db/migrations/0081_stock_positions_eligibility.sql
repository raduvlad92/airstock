-- Phase 2, milestone I7: `stock_positions` over a whole shop (the inventory list, stock on hand),
-- without changing what it returns (ADR 0020, update for I7).
--
-- The I7 volume run measured 1.2 s for Partline's 34,000 positions, for two reasons:
--   * `location_fulfillment_eligible()` ran once per position: two index lookups each, about
--     0.9 s. Eligibility now comes from one array per query, the shop's ineligible warehouses and
--     locations, and a position's location is eligible when its path shares no ID with it. Location
--     scopes already match on the same overlap: warehouse and location IDs never collide.
--   * `variant_id = any($1)` with a 20,000-element array compared every position with the array
--     one id at a time. `in (select unnest($1))` is a semi-join: hashed, or one index lookup per id.
-- Also, the variant row is read only for lots with an expiry date (its sell-by margin), not for
-- every position, and expired claims are looked up only where something is allocated. And the
-- rule now lives in `stock_positions()`, every position of the shop, which
-- the planner inlines: a report over the whole shop joins it with real row counts (hash joins)
-- instead of calling the function with an array of every variant.

-- Ineligible records are few; the partial indexes find them without reading the others.
create index locations_ineligible_idx on locations (shop_id) where not fulfillment_eligible;
create index warehouses_ineligible_idx on warehouses (shop_id) where not fulfillment_eligible;

-- The IDs of the warehouses and locations that are not fulfillment-eligible, in the current shop
-- (row-level security). A location takes part in fulfillment when its path_ids (warehouse,
-- ancestors, itself) overlap none of them: the same rule as location_fulfillment_eligible().
-- Call it as a scalar subquery, `(select fulfillment_ineligible_ids())`, so it runs once per query.
create function fulfillment_ineligible_ids() returns uuid[]
  language sql stable
  as $$
    select array(select a.id from locations a where not a.fulfillment_eligible)
      || array(select w.id from warehouses w where not w.fulfillment_eligible)
  $$;

grant execute on function fulfillment_ineligible_ids() to airstock_app;

-- Stock per position right now, for every position in the current shop (row-level security).
-- Every read and command that needs reserved or available units uses this rule, through this
-- function or stock_positions(variant_ids) below, so reservation expiry and lot expiry apply the
-- same way in the dashboard, the API, MCP, reports, and the Shopify push (ADR 0020).
--   reserved:  allocations still outstanding, minus those whose reservation has expired
--   sellable:  sellable condition, at an active, fulfillment-eligible storage location, not in
--              transit, and not from an expired lot
--   available: on hand minus reserved when sellable, else 0 (never below zero: allocated <= on_hand)
-- Same columns and rows as migration 0017's stock_positions. Kept to one plain SELECT so the
-- planner inlines it into the caller's query.
create function stock_positions()
returns table (position_id uuid, variant_id uuid, location_id uuid, warehouse_id uuid,
  location_path text, path_ids uuid[], condition text, lot_id uuid, serial_id uuid,
  transfer_id uuid, on_hand numeric, allocated numeric, reserved numeric, sellable boolean,
  lot_expired boolean, available numeric, received_at timestamptz, expires_on date)
language sql stable
as $$
  select p.id, p.variant_id, p.location_id, l.warehouse_id, l.path, l.path_ids, p.condition,
    p.lot_id, p.serial_id, p.transfer_id, p.on_hand, p.allocated, p.allocated - x.expired,
    s.sellable, s.lot_expired,
    case when s.sellable then p.on_hand - p.allocated + x.expired else 0 end,
    p.received_at, lt.expires_on
  from inventory_positions p
  join locations l on l.shop_id = p.shop_id and l.id = p.location_id
  left join lots lt on lt.shop_id = p.shop_id and lt.id = p.lot_id
  -- Claims of expired reservations, looked up only where something is allocated: allocated is the
  -- sum of the position's outstanding allocations, so with nothing allocated there are none.
  cross join lateral (
    select case when p.allocated > 0 then (
      select coalesce(sum(a.outstanding), 0)
      from reservation_allocations a
      join reservations r on r.shop_id = a.shop_id and r.id = a.reservation_id
      where a.shop_id = p.shop_id and a.position_id = p.id and a.outstanding > 0
        and r.status in ('active', 'partially_fulfilled') and r.expires_at <= now())
      else 0 end as expired) x
  cross join lateral (
    select coalesce(lt.expires_on is not null and now() >= lot_sellable_until(lt.expires_on,
      (select v.sell_by_margin_days from variants v where v.shop_id = p.shop_id and v.id = p.variant_id),
      (select sh.timezone from shops sh where sh.id = p.shop_id)), false)
      as lot_expired) e
  cross join lateral (
    select p.condition = 'sellable' and p.transfer_id is null and l.kind = 'storage'
      and l.status = 'active' and not (l.path_ids && (select fulfillment_ineligible_ids()))
      and not e.lot_expired as sellable, e.lot_expired) s
$$;

grant execute on function stock_positions() to airstock_app;

-- The same, for the given variants. Called with `array[...]` it is inlined like the function above;
-- called with `array(select ...)` it runs on its own, and the semi-join keeps a long list cheap.
create or replace function stock_positions(p_variant_ids uuid[])
returns table (position_id uuid, variant_id uuid, location_id uuid, warehouse_id uuid,
  location_path text, path_ids uuid[], condition text, lot_id uuid, serial_id uuid,
  transfer_id uuid, on_hand numeric, allocated numeric, reserved numeric, sellable boolean,
  lot_expired boolean, available numeric, received_at timestamptz, expires_on date)
language sql stable
as $$
  select * from stock_positions() sp where sp.variant_id in (select unnest(p_variant_ids))
$$;
