-- Phase 2, milestone I2: returns and inspection (plan D9, PRD 6.5).
--
-- A return is requested and authorized without touching stock. Receiving puts the units in
-- quarantine at the receiving location; inspection splits them into sellable, damaged, repair,
-- supplier return, or disposal (an adjustment out). Only units released to sellable add to
-- availability. No refund is issued: refunds belong to the sales channel.
--
-- Lock order: a return command locks its return row first (a document lock only return
-- commands take, always first), then positions by id, reservations by id, and everything else,
-- as ADR 0006 and the transfers migration (0030) describe.

create table returns (
  shop_id uuid not null references shops (id),
  id uuid not null,
  -- Your RMA number or another reference.
  reference text check (length(reference) between 1 and 200),
  -- The order and fulfillment it came from, in the sales channel (PRD 6.5).
  order_ref text check (length(order_ref) between 1 and 200),
  fulfillment_ref text check (length(fulfillment_ref) between 1 and 200),
  -- Why the customer sent it back.
  reason text check (length(reason) between 1 and 500),
  note text check (length(note) between 1 and 2000),
  tracking_reference text check (length(tracking_reference) between 1 and 200),
  status text not null default 'requested' check (status in ('requested', 'authorized',
    'in_transit', 'received', 'inspecting', 'completed', 'cancelled', 'exception')),
  -- Where the units were received (in quarantine); set by the first receipt.
  location_id uuid,
  -- Needs review: a serial that was never fulfilled from this shop, or a reported problem.
  exception_open boolean not null default false,
  exception_note text check (length(exception_note) between 1 and 2000),
  -- Closed early with fewer units than expected.
  closed boolean not null default false,
  created_by_type text not null,
  created_by_id text not null,
  authorized_at timestamptz,
  shipped_at timestamptz,
  received_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (shop_id, id),
  foreign key (shop_id, location_id) references locations (shop_id, id)
);

create index returns_recent_idx on returns (shop_id, id desc);
create index returns_open_idx on returns (shop_id, status) where status not in ('completed', 'cancelled');
create index returns_order_idx on returns (shop_id, order_ref) where order_ref is not null;

-- One line per variant. received <= expected; inspected <= received; the dispositions add up to
-- inspected.
create table return_lines (
  shop_id uuid not null,
  id uuid not null,
  return_id uuid not null,
  variant_id uuid not null,
  position integer not null check (position >= 0),
  expected numeric(20, 6) not null check (expected > 0),
  received numeric(20, 6) not null default 0 check (received >= 0),
  sellable numeric(20, 6) not null default 0 check (sellable >= 0),
  damaged numeric(20, 6) not null default 0 check (damaged >= 0),
  repair numeric(20, 6) not null default 0 check (repair >= 0),
  supplier_return numeric(20, 6) not null default 0 check (supplier_return >= 0),
  disposed numeric(20, 6) not null default 0 check (disposed >= 0),
  pack_id uuid,
  pack_version integer,
  entered_quantity numeric(20, 6),
  conversion_factor numeric(20, 6),
  primary key (shop_id, id),
  unique (shop_id, return_id, variant_id),
  foreign key (shop_id, return_id) references returns (shop_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  foreign key (shop_id, pack_id) references packs (shop_id, id),
  constraint return_lines_received check (received <= expected),
  constraint return_lines_inspected check (
    sellable + damaged + repair + supplier_return + disposed <= received),
  constraint return_lines_pack check (pack_id is null or (pack_version is not null
    and entered_quantity is not null and conversion_factor is not null
    and expected = entered_quantity * conversion_factor))
);

create index return_lines_return_idx on return_lines (shop_id, return_id, position);
create index return_lines_variant_idx on return_lines (shop_id, variant_id);

-- What came back, per lot or serial: received and inspected units, the cost they re-entered at,
-- and whether a serial matched one fulfilled from this shop.
create table return_units (
  shop_id uuid not null,
  id uuid not null,
  return_id uuid not null,
  line_id uuid not null,
  variant_id uuid not null,
  lot_id uuid,
  serial_id uuid,
  received numeric(20, 6) not null check (received > 0),
  inspected numeric(20, 6) not null default 0 check (inspected >= 0),
  -- Serials only: false when the serial was not fulfilled from this shop (flagged for review).
  matched boolean,
  -- Cost per base unit the units re-entered valuation at, and where it came from:
  -- 'fulfillment' (the entry they left with), or 'average' (not traceable).
  unit_cost numeric(20, 6),
  cost_source text not null check (cost_source in ('fulfillment', 'average')),
  primary key (shop_id, id),
  unique nulls not distinct (shop_id, line_id, lot_id, serial_id),
  foreign key (shop_id, return_id) references returns (shop_id, id),
  foreign key (shop_id, line_id) references return_lines (shop_id, id),
  foreign key (shop_id, variant_id, lot_id) references lots (shop_id, variant_id, id),
  foreign key (shop_id, variant_id, serial_id) references serial_units (shop_id, variant_id, id),
  check (inspected <= received),
  check ((serial_id is null) = (matched is null))
);

create index return_units_serial_idx on return_units (shop_id, serial_id) where serial_id is not null;

-- One row per inspection decision: which units went where.
create table return_inspections (
  shop_id uuid not null,
  id uuid not null,
  return_id uuid not null,
  line_id uuid not null,
  unit_id uuid not null,
  operation_id uuid not null,
  disposition text not null
    check (disposition in ('sellable', 'damaged', 'repair', 'supplier_return', 'disposal')),
  quantity numeric(20, 6) not null check (quantity > 0),
  note text check (length(note) between 1 and 500),
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  foreign key (shop_id, return_id) references returns (shop_id, id),
  foreign key (shop_id, line_id) references return_lines (shop_id, id),
  foreign key (shop_id, unit_id) references return_units (shop_id, id),
  foreign key (shop_id, operation_id) references inventory_operations (shop_id, id)
);

create index return_inspections_return_idx on return_inspections (shop_id, return_id);

alter table inventory_operations add column return_id uuid,
  add constraint inventory_operations_return_fk foreign key (shop_id, return_id)
    references returns (shop_id, id);
create index inventory_operations_return_idx on inventory_operations (shop_id, return_id)
  where return_id is not null;

-- Return invariants in the current shop: units add up to their lines, and inspections to units.
create function return_reconciliation_problems()
returns table (problem text, target_type text, target_id uuid, expected text, actual text)
language sql stable
as $$
  select 'return_received_mismatch', 'return_line', l.id, l.received::text,
    coalesce(u.received, 0)::text
  from return_lines l
  left join (select line_id, sum(received) as received from return_units group by line_id) u
    on u.line_id = l.id
  where l.received <> coalesce(u.received, 0)
  union all
  select 'return_inspected_mismatch', 'return_line', l.id,
    (l.sellable + l.damaged + l.repair + l.supplier_return + l.disposed)::text,
    coalesce(i.quantity, 0)::text
  from return_lines l
  left join (select line_id, sum(quantity) as quantity from return_inspections group by line_id) i
    on i.line_id = l.id
  where l.sellable + l.damaged + l.repair + l.supplier_return + l.disposed <> coalesce(i.quantity, 0)
  union all
  select 'return_unit_inspected_mismatch', 'return_unit', u.id, u.inspected::text,
    coalesce(i.quantity, 0)::text
  from return_units u
  left join (select unit_id, sum(quantity) as quantity from return_inspections group by unit_id) i
    on i.unit_id = u.id
  where u.inspected <> coalesce(i.quantity, 0)
$$;

alter table returns enable row level security;
alter table return_lines enable row level security;
alter table return_units enable row level security;
alter table return_inspections enable row level security;

create policy tenant_isolation on returns using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on return_lines using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on return_units using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on return_inspections using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());

grant select, insert, update on returns, return_lines, return_units to airstock_app;
-- Inspection decisions are history: written once.
grant select, insert on return_inspections to airstock_app;
grant execute on function return_reconciliation_problems() to airstock_app;
