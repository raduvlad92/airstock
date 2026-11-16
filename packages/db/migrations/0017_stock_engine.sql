-- Phase 2, milestone I1: the stock engine (plan Sections 5.1–5.3, 5.7, 5.10; decisions D1–D7, D18).
--
-- Lock order stays as in 0002 and ADR 0006 for every command:
--   1. inventory_positions, in ascending id order
--   2. reservations, in ascending id order (a bundle reservation and its component reservations
--      are locked together, by id)
--   3. everything else: variant_costs, serial_units, lots, products, alerts
-- Lot and serial rows are created (insert ... on conflict) before the positions that name them;
-- a new row's unique-index wait never closes a cycle with the order above.

-- Conditions and in-transit stock (D1) ------------------------------------------------------

alter table inventory_positions drop constraint inventory_positions_condition_check;
alter table inventory_positions add constraint inventory_positions_condition_check
  check (condition in ('sellable', 'quarantine', 'damaged', 'repair', 'supplier_return'));

-- One system location per shop holds dispatched stock (PRD 5.2). It belongs to no warehouse, is
-- never fulfillment-eligible, takes no receipts, and is left out of every location list. Its
-- positions name their transfer (transfers arrive in milestone I2).
alter table locations add column kind text not null default 'storage'
  check (kind in ('storage', 'in_transit'));
alter table locations alter column warehouse_id drop not null;
alter table locations add constraint locations_kind_warehouse
  check ((kind = 'storage') = (warehouse_id is not null));
create unique index locations_in_transit_idx on locations (shop_id) where kind = 'in_transit';

insert into locations (shop_id, id, warehouse_id, name, path, path_ids, fulfillment_eligible, kind)
select s.id, x.id, null, 'In transit', 'In transit', array[x.id], false, 'in_transit'
from shops s cross join lateral (select gen_random_uuid() as id) x
where not exists (select 1 from locations l where l.shop_id = s.id and l.kind = 'in_transit');

-- Lots and serials (D4) ---------------------------------------------------------------------

create table lots (
  shop_id uuid not null,
  id uuid not null,
  variant_id uuid not null,
  code text not null check (length(code) between 1 and 100),
  -- Trimmed, inner whitespace collapsed, upper case: lot codes are unique per variant (PRD 6.7).
  code_normalized text not null,
  expires_on date,
  produced_on date,
  supplier_id uuid,
  -- Free text until purchase orders exist; milestone I3 links the PO line.
  purchase_order_ref text check (length(purchase_order_ref) between 1 and 200),
  created_operation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (shop_id, id),
  unique (shop_id, variant_id, code_normalized),
  -- Lets positions, entries, and reservations require a lot of their own variant.
  unique (shop_id, variant_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  foreign key (shop_id, supplier_id) references suppliers (shop_id, id),
  foreign key (shop_id, created_operation_id) references inventory_operations (shop_id, id),
  check (produced_on is null or expires_on is null or produced_on <= expires_on)
);

create index lots_expiry_idx on lots (shop_id, expires_on) where expires_on is not null;

create table serial_units (
  shop_id uuid not null,
  id uuid not null,
  variant_id uuid not null,
  serial text not null check (length(serial) between 1 and 100),
  -- Same normalization as lot codes; serials are unique per variant within the shop.
  serial_normalized text not null,
  status text not null default 'in_stock'
    check (status in ('in_stock', 'in_transit', 'sold', 'written_off')),
  -- The position holding the unit while it is in stock or in transit.
  position_id uuid,
  created_operation_id uuid not null,
  last_operation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (shop_id, id),
  unique (shop_id, variant_id, serial_normalized),
  unique (shop_id, variant_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  foreign key (shop_id, position_id) references inventory_positions (shop_id, id),
  foreign key (shop_id, created_operation_id) references inventory_operations (shop_id, id),
  foreign key (shop_id, last_operation_id) references inventory_operations (shop_id, id),
  check ((status in ('in_stock', 'in_transit')) = (position_id is not null))
);

create index serial_units_position_idx on serial_units (shop_id, position_id) where position_id is not null;

-- Positions: lot, serial, transfer, and the age of the stock they hold -------------------------

alter table inventory_positions
  -- Set for in-transit positions: the transfer the units travel with (I2 adds the foreign key).
  add column transfer_id uuid,
  -- When the oldest units still on hand arrived: set by a receipt into an empty position. The
  -- allocation rule takes the oldest stock first (D3).
  add column received_at timestamptz,
  add constraint inventory_positions_lot_fk foreign key (shop_id, variant_id, lot_id)
    references lots (shop_id, variant_id, id),
  add constraint inventory_positions_serial_fk foreign key (shop_id, variant_id, serial_id)
    references serial_units (shop_id, variant_id, id) deferrable initially deferred,
  add constraint inventory_positions_one_serial check (serial_id is null or on_hand <= 1),
  add constraint inventory_positions_lot_or_serial check (lot_id is null or serial_id is null);

update inventory_positions set received_at = created_at where on_hand > 0;

alter table inventory_positions drop constraint inventory_positions_identity;
alter table inventory_positions add constraint inventory_positions_identity
  unique nulls not distinct (shop_id, variant_id, location_id, condition, lot_id, serial_id, transfer_id);

create index inventory_positions_lot_idx on inventory_positions (shop_id, lot_id) where lot_id is not null;

-- Operations and entries ---------------------------------------------------------------------

alter table inventory_operations drop constraint inventory_operations_kind_check;
alter table inventory_operations add constraint inventory_operations_kind_check
  check (kind in ('receipt', 'reservation', 'release', 'expiry', 'adjustment', 'fulfillment',
    'transfer_dispatch', 'transfer_receipt', 'return', 'count', 'condition_change', 'reversal',
    'reallocation'));
alter table inventory_operations
  add column supplier_id uuid,
  -- A reversal names the operation it compensates (I2).
  add column reverses_operation_id uuid,
  add constraint inventory_operations_supplier_fk foreign key (shop_id, supplier_id)
    references suppliers (shop_id, id),
  add constraint inventory_operations_reverses_fk foreign key (shop_id, reverses_operation_id)
    references inventory_operations (shop_id, id);

create index inventory_operations_time_idx on inventory_operations (shop_id, occurred_at);

alter table inventory_entries
  add column lot_id uuid,
  add column serial_id uuid,
  -- The pack version whose factor converted the entered quantity (ADR 0019).
  add column pack_version integer,
  -- Fulfillments and other claim-driven movements name their reservation (lot trace, A37).
  add column reservation_id uuid,
  -- Where unit_cost came from (D7): entered on the receipt, the moving average, the variant's
  -- default cost, or none known.
  add column cost_basis text check (cost_basis in ('entered', 'average', 'default', 'none')),
  add constraint inventory_entries_lot_fk foreign key (shop_id, variant_id, lot_id)
    references lots (shop_id, variant_id, id),
  add constraint inventory_entries_serial_fk foreign key (shop_id, variant_id, serial_id)
    references serial_units (shop_id, variant_id, id) deferrable initially deferred,
  add constraint inventory_entries_reservation_fk foreign key (shop_id, reservation_id)
    references reservations (shop_id, id),
  -- An entry in packs records what was entered and the factor, and they multiply out exactly.
  add constraint inventory_entries_pack_quantities check (pack_id is null or (
    entered_quantity is not null and conversion_factor is not null and pack_version is not null
    and abs(delta) = entered_quantity * conversion_factor));

create index inventory_entries_lot_idx on inventory_entries (shop_id, lot_id) where lot_id is not null;
create index inventory_entries_serial_idx on inventory_entries (shop_id, serial_id) where serial_id is not null;
create index inventory_entries_reservation_idx on inventory_entries (shop_id, reservation_id)
  where reservation_id is not null;
create index inventory_entries_variant_time_idx on inventory_entries (shop_id, variant_id, created_at);

-- Variants, products, and shop settings -----------------------------------------------------

alter table variants
  -- At most one unit on hand across the shop, checked in the receipt transaction (D5).
  add column one_of_a_kind boolean not null default false,
  -- Units of a lot stop being sellable this many days before the lot expires (D4).
  add column sell_by_margin_days integer not null default 0
    check (sell_by_margin_days between 0 and 3650),
  add constraint variants_one_of_a_kind_untracked check (not one_of_a_kind or tracking_mode = 'none');

-- A one-of-a-kind item that was fulfilled is "sold": hidden from default views, history kept,
-- and active again when it comes back (D5).
alter table products drop constraint products_status_check;
alter table products add constraint products_status_check
  check (status in ('draft', 'active', 'archived', 'sold'));

alter table shops
  -- A receipt at an eligible location fills open shortages, oldest first (D6).
  add column fill_shortages_on_receipt boolean not null default true,
  -- Applied to reservations that do not say; null means they never expire (D2).
  add column reservation_expiry_minutes integer check (reservation_expiry_minutes between 1 and 129600);

-- Reservations v2 (D2, D3, D6) ---------------------------------------------------------------

alter table reservations
  -- Which allocation rule applies: 'default', or a sales channel such as 'shopify:<connection>'.
  add column channel text not null default 'default' check (length(channel) between 1 and 100),
  -- Optional limits the caller set: a location (with its sub-locations) and a lot.
  add column location_id uuid,
  add column lot_id uuid,
  -- A bundle reservation is a header; each component has a reservation that points at it and
  -- holds the allocations. component_base_quantity is the component's base units per bundle.
  add column parent_id uuid,
  add column bundle_version_id uuid,
  add column component_base_quantity numeric(20, 6) check (component_base_quantity > 0),
  -- Shortage released without ever being allocated (an order line cancelled while short).
  add column shortage_released numeric(20, 6) not null default 0 check (shortage_released >= 0),
  add constraint reservations_location_fk foreign key (shop_id, location_id)
    references locations (shop_id, id),
  add constraint reservations_lot_fk foreign key (shop_id, variant_id, lot_id)
    references lots (shop_id, variant_id, id),
  add constraint reservations_parent_fk foreign key (shop_id, parent_id)
    references reservations (shop_id, id),
  add constraint reservations_bundle_version_fk foreign key (shop_id, bundle_version_id)
    references bundle_versions (shop_id, id),
  add constraint reservations_component check ((parent_id is null) = (component_base_quantity is null)),
  add constraint reservations_shortage_covered check (shortage_quantity + shortage_released <= quantity);

create index reservations_parent_idx on reservations (shop_id, parent_id) where parent_id is not null;
create index reservations_open_variant_idx on reservations (shop_id, variant_id, id)
  where status in ('active', 'partially_fulfilled');
create index reservations_open_shortage_idx on reservations (shop_id, variant_id, id)
  where shortage_quantity > 0 and status in ('active', 'partially_fulfilled');

-- A reallocation moves an outstanding claim to another position: the old allocation records
-- what moved, the new one names where it came from. Outstanding is what still holds stock.
alter table reservation_allocations
  add column moved numeric(20, 6) not null default 0 check (moved >= 0),
  add column source_allocation_id uuid,
  add constraint reservation_allocations_source_fk foreign key (shop_id, source_allocation_id)
    references reservation_allocations (shop_id, id);
alter table reservation_allocations drop constraint reservation_allocations_check;
alter table reservation_allocations add constraint reservation_allocations_settled
  check (released + fulfilled + moved <= quantity);
alter table reservation_allocations add column outstanding numeric(20, 6)
  generated always as (quantity - released - fulfilled - moved) stored;
drop index reservation_allocations_open_position_idx;
create index reservation_allocations_open_position_idx on reservation_allocations (shop_id, position_id)
  where outstanding > 0;

-- Allocation rules (D3): per shop and channel, an ordered list of warehouses or locations.
create table allocation_rules (
  shop_id uuid not null references shops (id),
  id uuid not null,
  channel text not null check (length(channel) between 1 and 100),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, id),
  unique (shop_id, channel)
);

create table allocation_rule_locations (
  shop_id uuid not null,
  rule_id uuid not null,
  position integer not null check (position >= 0),
  -- A warehouse or a location; a warehouse covers every location in it (matched on path_ids).
  scope_id uuid not null,
  primary key (shop_id, rule_id, position),
  unique (shop_id, rule_id, scope_id),
  foreign key (shop_id, rule_id) references allocation_rules (shop_id, id)
);

-- Valuation (D7) ------------------------------------------------------------------------------

-- One moving average per variant per shop. `quantity` is the owned quantity (on hand in every
-- condition plus in transit) and changes in the same transaction as the positions; the row lock
-- serializes average updates. Restricted: only members with costs.read see the costs.
create table variant_costs (
  shop_id uuid not null,
  variant_id uuid not null,
  quantity numeric(20, 6) not null default 0 check (quantity >= 0),
  average_cost numeric(20, 6) check (average_cost >= 0),
  -- Merchant-entered cost used for a receipt without a cost while the variant has no stock.
  default_cost numeric(20, 6) check (default_cost >= 0),
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (shop_id, variant_id),
  foreign key (shop_id, variant_id) references variants (shop_id, id)
);

-- One row per stock or cost change, insert-only: value at any past date is the latest row's
-- quantity_after × average_after, reproducible without recalculation.
create table variant_cost_history (
  shop_id uuid not null,
  id uuid not null,
  variant_id uuid not null,
  operation_id uuid,
  occurred_at timestamptz not null default now(),
  kind text not null check (kind in ('receipt', 'fulfillment', 'adjustment', 'transfer', 'return',
    'count', 'default_cost', 'opening')),
  quantity_delta numeric(20, 6) not null,
  unit_cost numeric(20, 6),
  quantity_after numeric(20, 6) not null check (quantity_after >= 0),
  average_after numeric(20, 6),
  primary key (shop_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  foreign key (shop_id, operation_id) references inventory_operations (shop_id, id)
);

create index variant_cost_history_variant_idx
  on variant_cost_history (shop_id, variant_id, occurred_at desc, id desc);
create index variant_cost_history_time_idx on variant_cost_history (shop_id, occurred_at);

insert into variant_costs (shop_id, variant_id, quantity)
select shop_id, variant_id, sum(on_hand) from inventory_positions group by shop_id, variant_id;
insert into variant_cost_history (shop_id, id, variant_id, kind, quantity_delta, quantity_after)
select shop_id, gen_random_uuid(), variant_id, 'opening', quantity, quantity from variant_costs;

-- Round half to even at a scale (D7). PostgreSQL's round() rounds halves away from zero.
create function round_half_even(p_value numeric, p_scale integer) returns numeric
  language sql immutable strict
  as $$
    select (case when abs(x - trunc(x)) = 0.5 and mod(trunc(x), 2) = 0 then trunc(x) else round(x) end)
      / power(10::numeric, p_scale)
    from (select p_value * power(10::numeric, p_scale) as x) s
  $$;

-- Applies one stock change to a variant's owned quantity and moving average (PRD 6.11) and
-- records it. Inbound units take the entered cost, else the default cost while there is no stock,
-- else the current average; outbound units leave at the current average. Call it after the
-- positions are locked (lock order). Returns the unit cost the entries record.
create function apply_stock_cost(p_history_id uuid, p_variant_id uuid, p_operation_id uuid,
  p_kind text, p_delta numeric, p_unit_cost numeric)
returns table (unit_cost numeric, cost_basis text, average_after numeric, quantity_after numeric)
language plpgsql
as $$
declare
  c variant_costs;
  applied numeric;
  basis text;
  new_average numeric;
begin
  insert into variant_costs (shop_id, variant_id) values (app_shop_id(), p_variant_id)
    on conflict do nothing;
  select * into c from variant_costs where shop_id = app_shop_id() and variant_id = p_variant_id
    for update;
  new_average := c.average_cost;
  if p_delta > 0 then
    if p_unit_cost is not null then
      applied := p_unit_cost; basis := 'entered';
    elsif c.quantity = 0 and c.default_cost is not null then
      applied := c.default_cost; basis := 'default';
    elsif c.average_cost is not null then
      applied := c.average_cost; basis := 'average';
    else
      applied := null; basis := 'none';
    end if;
    if basis in ('entered', 'default') then
      new_average := case when c.average_cost is null or c.quantity = 0 then applied
        else round_half_even((c.quantity * c.average_cost + p_delta * applied) / (c.quantity + p_delta), 6)
      end;
    end if;
  else
    applied := c.average_cost;
    basis := case when c.average_cost is null then 'none' else 'average' end;
  end if;
  update variant_costs set quantity = c.quantity + p_delta, average_cost = new_average,
    version = c.version + 1, updated_at = now()
  where shop_id = app_shop_id() and variant_id = p_variant_id;
  -- The time the row lock was held, not the transaction start: concurrent changes to one variant
  -- are ordered as they were applied, so "the latest row before a date" is the right one.
  insert into variant_cost_history (shop_id, id, variant_id, operation_id, occurred_at, kind,
    quantity_delta, unit_cost, quantity_after, average_after)
  values (app_shop_id(), p_history_id, p_variant_id, p_operation_id, clock_timestamp(), p_kind,
    p_delta, applied, c.quantity + p_delta, new_average);
  return query select applied, basis, new_average, c.quantity + p_delta;
end
$$;

-- One shared rule for what is sellable now (plan 5.1) -----------------------------------------

-- When a lot stops being sellable: the start of the day after its expiry date in the shop's time
-- zone, earlier by the variant's sell-by margin. Null when the lot has no expiry date.
create function lot_sellable_until(p_expires_on date, p_margin_days integer, p_timezone text)
  returns timestamptz language sql stable
  as $$ select ((p_expires_on - coalesce(p_margin_days, 0) + 1)::timestamp at time zone p_timezone) $$;

-- Stock per position right now. Every read and command that needs reserved or available units
-- uses this function, so reservation expiry and lot expiry apply the same way in the dashboard,
-- the API, MCP, reports, and the Shopify push: when they run, not when a sweeper gets to them.
--   reserved:  allocations still outstanding, minus those whose reservation has expired
--   sellable:  sellable condition, at an active, fulfillment-eligible storage location, not in
--              transit, and not from an expired lot
--   available: on hand minus reserved when sellable, else 0 (never below zero: allocated <= on_hand)
create function stock_positions(p_variant_ids uuid[])
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
  join variants v on v.shop_id = p.shop_id and v.id = p.variant_id
  left join lots lt on lt.shop_id = p.shop_id and lt.id = p.lot_id
  cross join lateral (
    select coalesce(sum(a.outstanding), 0) as expired
    from reservation_allocations a
    join reservations r on r.shop_id = a.shop_id and r.id = a.reservation_id
    where a.shop_id = p.shop_id and a.position_id = p.id and a.outstanding > 0
      and r.status in ('active', 'partially_fulfilled') and r.expires_at <= now()) x
  cross join lateral (
    select coalesce(lt.expires_on is not null and now() >= lot_sellable_until(lt.expires_on,
      v.sell_by_margin_days, (select sh.timezone from shops sh where sh.id = p.shop_id)), false)
      as lot_expired) e
  cross join lateral (
    select p.condition = 'sellable' and p.transfer_id is null and l.kind = 'storage'
      and l.status = 'active' and location_fulfillment_eligible(l.shop_id, l.path_ids)
      and not e.lot_expired as sellable, e.lot_expired) s
  where p.variant_id = any(p_variant_ids)
$$;

-- Alerts (D12, D18) -------------------------------------------------------------------------

-- Milestone I3 adds rules, subscriptions, and notifications. I1 opens reconciliation alerts.
create table alerts (
  shop_id uuid not null references shops (id),
  id uuid not null,
  kind text not null check (length(kind) between 1 and 50),
  -- At most one open alert per key, for example 'reconciliation' (D12).
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  target_type text,
  target_id uuid,
  location_ids uuid[],
  details jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrences integer not null default 1 check (occurrences >= 1),
  acknowledged_at timestamptz,
  acknowledged_by text,
  resolved_at timestamptz,
  version integer not null default 1,
  primary key (shop_id, id)
);

create unique index alerts_open_key_idx on alerts (shop_id, dedupe_key) where status <> 'resolved';
create index alerts_status_idx on alerts (shop_id, status, opened_at desc);

-- Reconciliation (D18) ----------------------------------------------------------------------

-- Every stock invariant, checked in the current shop. Empty when history, balances, allocations,
-- reservations, serials, and costs agree (A21). The scheduled check and the tests both use it.
create function stock_reconciliation_problems()
returns table (problem text, target_type text, target_id uuid, expected text, actual text)
language sql stable
as $$
  -- Balances equal the sum of the ledger.
  select 'on_hand_mismatch', 'position', p.id, coalesce(e.total, 0)::text, p.on_hand::text
  from inventory_positions p
  left join (select position_id, sum(delta) as total from inventory_entries group by position_id) e
    on e.position_id = p.id
  where p.on_hand <> coalesce(e.total, 0)
  union all
  -- Allocated equals the outstanding claims at the position.
  select 'allocated_mismatch', 'position', p.id, coalesce(a.total, 0)::text, p.allocated::text
  from inventory_positions p
  left join (select position_id, sum(outstanding) as total from reservation_allocations
             group by position_id) a on a.position_id = p.id
  where p.allocated <> coalesce(a.total, 0)
  union all
  select 'over_allocated', 'position', id, on_hand::text, allocated::text
  from inventory_positions where allocated > on_hand
  union all
  -- A reservation's quantity is what its allocations hold (net of moves) plus its shortage.
  select 'reservation_total_mismatch', 'reservation', r.id, r.quantity::text,
    (coalesce(a.held, 0) + r.shortage_quantity + r.shortage_released)::text
  from reservations r
  left join (select reservation_id, sum(quantity - moved) as held from reservation_allocations
             group by reservation_id) a on a.reservation_id = r.id
  where (r.parent_id is not null or not exists (
      select 1 from reservations c where c.shop_id = r.shop_id and c.parent_id = r.id))
    and r.quantity <> coalesce(a.held, 0) + r.shortage_quantity + r.shortage_released
  union all
  -- Open and closed states match what is still outstanding.
  select 'reservation_status_mismatch', 'reservation', r.id,
    case when o.open > 0 then 'open' else 'closed' end, r.status
  from reservations r
  cross join lateral (
    select coalesce((select sum(a.outstanding) from reservation_allocations a
      where a.shop_id = r.shop_id and a.reservation_id = r.id), 0)
      + r.shortage_quantity
      + coalesce((select sum(c.shortage_quantity + coalesce((select sum(a.outstanding)
            from reservation_allocations a where a.shop_id = c.shop_id and a.reservation_id = c.id), 0))
          from reservations c where c.shop_id = r.shop_id and c.parent_id = r.id), 0) as open) o
  where (o.open > 0) <> (r.status in ('active', 'partially_fulfilled'))
  union all
  -- A bundle's component reservations hold its quantity times their base quantity.
  select 'bundle_component_mismatch', 'reservation', c.id,
    (p.quantity * c.component_base_quantity)::text, c.quantity::text
  from reservations c join reservations p on p.shop_id = c.shop_id and p.id = c.parent_id
  where c.quantity <> p.quantity * c.component_base_quantity
  union all
  -- A serial is in stock exactly when its position holds it.
  select 'serial_mismatch', 'serial_unit', s.id,
    case when s.status in ('in_stock', 'in_transit') then '1' else '0' end,
    coalesce((select sum(p.on_hand) from inventory_positions p
      where p.shop_id = s.shop_id and p.serial_id = s.id), 0)::text
  from serial_units s
  where (case when s.status in ('in_stock', 'in_transit') then 1 else 0 end) <>
    coalesce((select sum(p.on_hand) from inventory_positions p
      where p.shop_id = s.shop_id and p.serial_id = s.id), 0)
    or (s.position_id is not null and not exists (select 1 from inventory_positions p
      where p.shop_id = s.shop_id and p.id = s.position_id and p.serial_id = s.id and p.on_hand = 1))
  union all
  -- The owned quantity behind the moving average equals the positions.
  select 'cost_quantity_mismatch', 'variant', coalesce(c.variant_id, p.variant_id),
    coalesce(p.total, 0)::text, coalesce(c.quantity, 0)::text
  from variant_costs c
  full join (select variant_id, sum(on_hand) as total from inventory_positions group by variant_id) p
    on p.variant_id = c.variant_id
  where coalesce(c.quantity, 0) <> coalesce(p.total, 0)
$$;

create table stock_reconciliations (
  shop_id uuid not null references shops (id),
  id uuid not null,
  trigger text not null check (trigger in ('scheduled', 'daily')),
  checked_at timestamptz not null default now(),
  problems integer not null check (problems >= 0),
  details jsonb not null default '[]'::jsonb,
  primary key (shop_id, id)
);

create index stock_reconciliations_recent_idx on stock_reconciliations (shop_id, checked_at desc);

-- Shops due a check: stock activity since their last one, or none for a day (daily = true).
create function shops_due_stock_reconciliation(p_daily boolean, p_limit integer) returns setof uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select s.id from shops s
  left join lateral (select max(checked_at) as last from stock_reconciliations c where c.shop_id = s.id) c on true
  where case when p_daily then c.last is null or c.last < now() - interval '23 hours'
    else exists (select 1 from inventory_operations o where o.shop_id = s.id
      and o.occurred_at > coalesce(c.last, '-infinity'::timestamptz)) end
    and exists (select 1 from inventory_operations o where o.shop_id = s.id)
  order by c.last nulls first, s.id
  limit least(p_limit, 500)
$$;

revoke execute on function shops_due_stock_reconciliation(boolean, integer) from public;
grant execute on function shops_due_stock_reconciliation(boolean, integer) to airstock_app;

-- Row-level security and grants --------------------------------------------------------------

alter table lots enable row level security;
alter table serial_units enable row level security;
alter table allocation_rules enable row level security;
alter table allocation_rule_locations enable row level security;
alter table variant_costs enable row level security;
alter table variant_cost_history enable row level security;
alter table alerts enable row level security;
alter table stock_reconciliations enable row level security;

create policy tenant_isolation on lots using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on serial_units using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on allocation_rules using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on allocation_rule_locations using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on variant_costs using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on variant_cost_history using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on alerts using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on stock_reconciliations using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());

grant select, insert, update on lots, serial_units, allocation_rules, variant_costs, alerts to airstock_app;
grant select, insert, delete on allocation_rule_locations to airstock_app;
-- History: written once, never changed.
grant select, insert on variant_cost_history, stock_reconciliations to airstock_app;
grant execute on function round_half_even(numeric, integer),
  apply_stock_cost(uuid, uuid, uuid, text, numeric, numeric),
  lot_sellable_until(date, integer, text), stock_positions(uuid[]), stock_reconciliation_problems()
  to airstock_app;
