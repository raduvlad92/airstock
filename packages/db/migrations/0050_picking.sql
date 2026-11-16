-- Phase 2, milestone I4: pick lists (plan Section 5.11, PRD 6.10).
--
-- A pick list is built from open reservations: one line per outstanding allocation, sorted by
-- location path for a short walk. Picking records what was picked per line and never changes
-- stock; stock leaves only when a reservation is fulfilled (for manual and API reservations at
-- the end of the list, for Shopify orders when Shopify reports the fulfillment). Scanning a
-- different lot or position reallocates through the reservation's own command, and the line
-- follows the new allocation. A short pick records what was found and flags the line; the count
-- that settles the difference starts there (milestone I2's count, wired in I4b).

create table pick_lists (
  shop_id uuid not null references shops (id),
  id uuid not null,
  -- Per shop, for people: "Pick list 12".
  number integer not null check (number > 0),
  status text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  -- The filters it was built from, as given (channel, warehouse, dates, orders).
  filters jsonb not null default '{}',
  note text check (length(note) between 1 and 500),
  created_by_actor_type text not null,
  created_by_actor_id text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (shop_id, id),
  unique (shop_id, number)
);

create index pick_lists_open_idx on pick_lists (shop_id, created_at) where status = 'open';

create table pick_lines (
  shop_id uuid not null,
  id uuid not null,
  pick_list_id uuid not null,
  -- Walk order within the list: location path, then SKU.
  sequence integer not null,
  -- The reservation that holds the allocation (a bundle's component), and the order-level one.
  reservation_id uuid not null,
  root_reservation_id uuid not null,
  allocation_id uuid not null,
  variant_id uuid not null,
  position_id uuid not null,
  location_id uuid not null,
  location_path text not null,
  lot_id uuid,
  serial_id uuid,
  external_ref text,
  -- Manual and API reservations are fulfilled when the list is completed; Shopify orders are
  -- fulfilled from Shopify (plan 5.14), so their picks are only recorded.
  fulfill_on_complete boolean not null,
  -- Base units. What is left to pick is quantity - picked - short - moved.
  quantity numeric(20, 6) not null check (quantity > 0),
  picked numeric(20, 6) not null default 0 check (picked >= 0),
  -- Not found at the position (a short pick); flagged for a count.
  short numeric(20, 6) not null default 0 check (short >= 0),
  -- Taken from another lot or position instead; the new line names the new allocation.
  moved numeric(20, 6) not null default 0 check (moved >= 0),
  status text not null default 'open'
    check (status in ('open', 'picked', 'short', 'moved', 'done', 'cancelled')),
  -- When completing the list fulfilled this line: the fulfillment's operation.
  fulfilled_operation_id uuid,
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (shop_id, id),
  check (picked + short + moved <= quantity),
  foreign key (shop_id, pick_list_id) references pick_lists (shop_id, id),
  foreign key (shop_id, reservation_id) references reservations (shop_id, id),
  foreign key (shop_id, root_reservation_id) references reservations (shop_id, id),
  foreign key (shop_id, allocation_id) references reservation_allocations (shop_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  foreign key (shop_id, position_id) references inventory_positions (shop_id, id),
  foreign key (shop_id, location_id) references locations (shop_id, id)
);

create index pick_lines_list_idx on pick_lines (shop_id, pick_list_id, sequence);
-- An allocation is on at most one list that is still being worked.
create unique index pick_lines_active_allocation_idx on pick_lines (shop_id, allocation_id)
  where status in ('open', 'picked', 'short');

-- Every pick and short pick, insert-only.
create table picks (
  shop_id uuid not null,
  id uuid not null,
  pick_list_id uuid not null,
  pick_line_id uuid not null,
  kind text not null check (kind in ('pick', 'short')),
  -- Picked, or for a short pick what was found.
  quantity numeric(20, 6) not null check (quantity >= 0),
  -- For a short pick: what was expected and not found.
  missing numeric(20, 6) not null default 0 check (missing >= 0),
  position_id uuid not null,
  location_id uuid not null,
  lot_id uuid,
  serial_id uuid,
  -- Set when the scan named another lot or position and the allocation was moved first.
  reallocation_operation_id uuid,
  actor_type text not null,
  actor_id text not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  foreign key (shop_id, pick_line_id) references pick_lines (shop_id, id)
);

create index picks_line_idx on picks (shop_id, pick_line_id);

alter table pick_lists enable row level security;
alter table pick_lines enable row level security;
alter table picks enable row level security;
create policy tenant_isolation on pick_lists using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on pick_lines using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on picks using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
grant select, insert, update on pick_lists, pick_lines to airstock_app;
grant select, insert on picks to airstock_app;
