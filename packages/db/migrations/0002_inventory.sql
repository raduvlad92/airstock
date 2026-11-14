-- Phase 0 inventory: positions, append-only ledger, reservations with concrete allocations.
--
-- Lock order for every command that changes stock (PRD 6.1, rule 6):
--   1. inventory_positions, in ascending id order (SELECT ... FOR UPDATE)
--   2. reservations, in ascending id order
--   3. everything else
-- Any command that follows this order cannot deadlock with another that does.

create table inventory_positions (
  shop_id uuid not null,
  id uuid not null,
  variant_id uuid not null,
  location_id uuid not null,
  condition text not null default 'sellable' check (condition in ('sellable', 'quarantine', 'damaged')),
  -- Lot and serial identities arrive in Phase 2. NULLS NOT DISTINCT below keeps a missing
  -- lot or serial from creating a second position for the same stock (PRD 11).
  lot_id uuid,
  serial_id uuid,
  on_hand numeric(20, 6) not null default 0 check (on_hand >= 0),
  -- Sum of outstanding reservation allocations, including transfer holds once they exist.
  -- Allocations whose reservation has expired stay counted until a command or the sweeper
  -- releases them; availability reads subtract them (see inventory availability queries).
  allocated numeric(20, 6) not null default 0 check (allocated >= 0),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, id),
  constraint inventory_positions_identity
    unique nulls not distinct (shop_id, variant_id, location_id, condition, lot_id, serial_id),
  -- Last line of defence for the no-negative-availability rule (PRD 6.1, rule 5).
  constraint inventory_positions_allocation_covered check (allocated <= on_hand),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  foreign key (shop_id, location_id) references locations (shop_id, id)
);

create index inventory_positions_variant_idx on inventory_positions (shop_id, variant_id);
create index inventory_positions_location_idx on inventory_positions (shop_id, location_id);

-- One row per business operation that touches stock. Immutable.
create table inventory_operations (
  shop_id uuid not null,
  id uuid not null,
  kind text not null check (kind in ('receipt', 'reservation', 'release', 'expiry', 'adjustment', 'fulfillment', 'transfer_dispatch', 'transfer_receipt')),
  actor_type text not null,
  actor_id text not null,
  source text not null,
  attempt_id uuid,
  idempotency_key text,
  external_ref text,
  reason text,
  occurred_at timestamptz not null default now(),
  primary key (shop_id, id),
  foreign key (shop_id) references shops (id)
);

-- Append-only physical ledger. Sum of delta per position equals inventory_positions.on_hand.
create table inventory_entries (
  shop_id uuid not null,
  id uuid not null,
  operation_id uuid not null,
  position_id uuid not null,
  variant_id uuid not null,
  location_id uuid not null,
  delta numeric(20, 6) not null check (delta <> 0),
  -- Valuation (Phase 2) and packs (Phase 1) fill these; the columns exist now so history
  -- written in Phase 0 has the same shape.
  unit_cost numeric(20, 6),
  pack_id uuid,
  entered_quantity numeric(20, 6),
  conversion_factor numeric(20, 6),
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  foreign key (shop_id, operation_id) references inventory_operations (shop_id, id),
  foreign key (shop_id, position_id) references inventory_positions (shop_id, id)
);

create index inventory_entries_position_idx on inventory_entries (shop_id, position_id);

create table reservations (
  shop_id uuid not null,
  id uuid not null,
  variant_id uuid not null,
  quantity numeric(20, 6) not null check (quantity > 0),
  -- Demand from an externally accepted order that could not be allocated (PRD 8.5).
  shortage_quantity numeric(20, 6) not null default 0 check (shortage_quantity >= 0),
  status text not null default 'active'
    check (status in ('active', 'partially_fulfilled', 'fulfilled', 'released', 'expired')),
  purpose text not null default 'manual' check (purpose in ('manual', 'external_order', 'transfer')),
  external_ref text,
  expires_at timestamptz,
  created_operation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (shop_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  foreign key (shop_id, created_operation_id) references inventory_operations (shop_id, id)
);

create index reservations_open_expiry_idx on reservations (expires_at)
  where status in ('active', 'partially_fulfilled') and expires_at is not null;
create index reservations_external_ref_idx on reservations (shop_id, external_ref) where external_ref is not null;

create table reservation_allocations (
  shop_id uuid not null,
  id uuid not null,
  reservation_id uuid not null,
  position_id uuid not null,
  quantity numeric(20, 6) not null check (quantity > 0),
  released numeric(20, 6) not null default 0 check (released >= 0),
  fulfilled numeric(20, 6) not null default 0 check (fulfilled >= 0),
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  check (released + fulfilled <= quantity),
  foreign key (shop_id, reservation_id) references reservations (shop_id, id),
  foreign key (shop_id, position_id) references inventory_positions (shop_id, id)
);

create index reservation_allocations_reservation_idx on reservation_allocations (shop_id, reservation_id);
create index reservation_allocations_open_position_idx on reservation_allocations (shop_id, position_id)
  where released + fulfilled < quantity;

alter table inventory_positions enable row level security;
alter table inventory_operations enable row level security;
alter table inventory_entries enable row level security;
alter table reservations enable row level security;
alter table reservation_allocations enable row level security;

create policy tenant_isolation on inventory_positions using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on inventory_operations using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on inventory_entries using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on reservations using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on reservation_allocations using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());

-- History tables are append-only for the runtime role: no UPDATE or DELETE grants.
grant select, insert on inventory_operations, inventory_entries to airstock_app;
grant select, insert, update on inventory_positions, reservations, reservation_allocations to airstock_app;
