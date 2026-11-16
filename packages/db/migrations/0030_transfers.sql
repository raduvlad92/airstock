-- Phase 2, milestone I2: transfers between locations and warehouses (plan D8, PRD 6.4).
--
-- A transfer moves stock through the shop's in-transit location (migration 0017): dispatch takes
-- units from source positions into in-transit positions that name the transfer, receipt moves them
-- into destination positions. Per-line quantities are authoritative; the summary status never
-- hides mixed lines.
--
-- Lock order (ADR 0006, ADR 0020) with one addition: a transfer command first locks its transfer
-- row, a document lock that only transfer commands take, and always first. Then positions by id,
-- reservations by id, and everything else, as for every stock command. No command that holds a
-- position or reservation ever waits for a transfer row, so the order stays free of cycles.

create table transfers (
  shop_id uuid not null references shops (id),
  id uuid not null,
  -- A move within a warehouse dispatches and receives in one command (D8).
  kind text not null default 'transfer' check (kind in ('transfer', 'move')),
  reference text check (length(reference) between 1 and 200),
  tracking_reference text check (length(tracking_reference) between 1 and 200),
  note text check (length(note) between 1 and 2000),
  -- Stock is taken from this location and its sub-locations.
  from_location_id uuid not null,
  -- Units are received at this location, or at a leaf location inside it.
  to_location_id uuid not null,
  status text not null default 'draft' check (status in ('draft', 'ready', 'partially_dispatched',
    'dispatched', 'partially_received', 'received', 'cancelled', 'exception')),
  -- Set by the receiver when units are missing or damaged, until nothing is left in transit.
  exception_open boolean not null default false,
  exception_note text check (length(exception_note) between 1 and 2000),
  created_by_type text not null,
  created_by_id text not null,
  ready_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (shop_id, id),
  foreign key (shop_id, from_location_id) references locations (shop_id, id),
  foreign key (shop_id, to_location_id) references locations (shop_id, id),
  check (from_location_id <> to_location_id)
);

create index transfers_recent_idx on transfers (shop_id, id desc);
create index transfers_open_idx on transfers (shop_id, status)
  where status not in ('received', 'cancelled');
create index transfers_from_idx on transfers (shop_id, from_location_id);
create index transfers_to_idx on transfers (shop_id, to_location_id);

-- One line per variant. Quantities are base units:
--   held       = planned - cancelled - dispatched   (allocated at the source once ready)
--   in transit = dispatched - received - resolved
create table transfer_lines (
  shop_id uuid not null,
  id uuid not null,
  transfer_id uuid not null,
  variant_id uuid not null,
  position integer not null check (position >= 0),
  -- Transfers move stock without changing its condition; condition changes are separate (D10).
  condition text not null default 'sellable'
    check (condition in ('sellable', 'quarantine', 'damaged', 'repair', 'supplier_return')),
  -- Optional limits for what ready may hold: one lot, or these serials.
  lot_id uuid,
  serial_ids uuid[],
  -- What was entered: a pack, its version, the number of packs, and its factor (G8).
  pack_id uuid,
  pack_version integer,
  entered_quantity numeric(20, 6),
  conversion_factor numeric(20, 6),
  planned numeric(20, 6) not null check (planned > 0),
  cancelled numeric(20, 6) not null default 0 check (cancelled >= 0),
  dispatched numeric(20, 6) not null default 0 check (dispatched >= 0),
  received numeric(20, 6) not null default 0 check (received >= 0),
  -- Settled by an exception resolution (lost, damaged, short): an adjustment out of transit.
  resolved numeric(20, 6) not null default 0 check (resolved >= 0),
  -- The transfer hold (reservation purpose 'transfer'), from ready on.
  reservation_id uuid,
  primary key (shop_id, id),
  unique (shop_id, transfer_id, variant_id),
  foreign key (shop_id, transfer_id) references transfers (shop_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  foreign key (shop_id, variant_id, lot_id) references lots (shop_id, variant_id, id),
  foreign key (shop_id, pack_id) references packs (shop_id, id),
  foreign key (shop_id, reservation_id) references reservations (shop_id, id),
  -- PRD 6.4 step 6: dispatch never exceeds the held remainder; receipt and resolution together
  -- never exceed what was dispatched.
  constraint transfer_lines_dispatch_covered check (cancelled + dispatched <= planned),
  constraint transfer_lines_settle_covered check (received + resolved <= dispatched),
  constraint transfer_lines_pack check (pack_id is null or (pack_version is not null
    and entered_quantity is not null and conversion_factor is not null
    and planned = entered_quantity * conversion_factor))
);

create index transfer_lines_transfer_idx on transfer_lines (shop_id, transfer_id, position);
create index transfer_lines_variant_idx on transfer_lines (shop_id, variant_id);
create unique index transfer_lines_reservation_idx on transfer_lines (shop_id, reservation_id)
  where reservation_id is not null;

-- In-transit positions name their transfer (0017 left the foreign key to this milestone).
alter table inventory_positions add constraint inventory_positions_transfer_fk
  foreign key (shop_id, transfer_id) references transfers (shop_id, id);
create index inventory_positions_transfer_idx on inventory_positions (shop_id, transfer_id)
  where transfer_id is not null;

-- Operations of a transfer (dispatch, receipt, exception resolutions) name it, so its history is
-- one query and a serial's history shows which transfer it travelled with.
alter table inventory_operations add column transfer_id uuid,
  add constraint inventory_operations_transfer_fk foreign key (shop_id, transfer_id)
    references transfers (shop_id, id);
create index inventory_operations_transfer_idx on inventory_operations (shop_id, transfer_id)
  where transfer_id is not null;

-- Transfer invariants, in the current shop, on top of stock_reconciliation_problems():
--   a ready line's held remainder is what its reservation still holds;
--   a line's in-transit quantity is what the transfer's in-transit positions hold for it.
create function transfer_reconciliation_problems()
returns table (problem text, target_type text, target_id uuid, expected text, actual text)
language sql stable
as $$
  select 'transfer_hold_mismatch', 'transfer_line', tl.id,
    (tl.planned - tl.cancelled - tl.dispatched)::text, coalesce(a.held, 0)::text
  from transfer_lines tl
  left join (select reservation_id, sum(outstanding) as held from reservation_allocations
             group by reservation_id) a on a.reservation_id = tl.reservation_id
  where tl.reservation_id is not null
    and tl.planned - tl.cancelled - tl.dispatched <> coalesce(a.held, 0)
  union all
  select 'transfer_in_transit_mismatch', 'transfer_line', tl.id,
    (tl.dispatched - tl.received - tl.resolved)::text, coalesce(p.total, 0)::text
  from transfer_lines tl
  left join (select transfer_id, variant_id, sum(on_hand) as total from inventory_positions
             where transfer_id is not null group by transfer_id, variant_id) p
    on p.transfer_id = tl.transfer_id and p.variant_id = tl.variant_id
  where tl.dispatched - tl.received - tl.resolved <> coalesce(p.total, 0)
$$;

alter table transfers enable row level security;
alter table transfer_lines enable row level security;

create policy tenant_isolation on transfers using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on transfer_lines using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());

grant select, insert, update on transfers, transfer_lines to airstock_app;
grant execute on function transfer_reconciliation_problems() to airstock_app;
