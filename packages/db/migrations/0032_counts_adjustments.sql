-- Phase 2, milestone I2: counts, adjustments, condition changes, and reversals (plan D10,
-- PRD 6.6).
--
-- A count session covers chosen positions or a location, optionally blind. Each counted line
-- records the position's version, on hand, and ledger length at the moment it was counted; if
-- the position moved before submit, the line needs review. Submitting posts adjustments with the
-- reason count correction. A count below reserved stock needs an explicit choice per claim.
--
-- Lock order: a count command locks its session row first (only count commands lock it), then
-- positions by id, reservations by id, and everything else, as ADR 0006 describes.

create table count_sessions (
  shop_id uuid not null references shops (id),
  id uuid not null,
  name text check (length(name) between 1 and 200),
  -- The location (with its sub-locations) the session covers; null when it lists positions.
  location_id uuid,
  -- Blind: expected quantities are not shown to the counter.
  blind boolean not null default false,
  status text not null default 'open' check (status in ('open', 'submitted', 'cancelled')),
  -- A quick count is created, counted, and submitted in one command (grid, scan, assistant).
  quick boolean not null default false,
  note text check (length(note) between 1 and 2000),
  created_by_type text not null,
  created_by_id text not null,
  submitted_at timestamptz,
  cancelled_at timestamptz,
  operation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (shop_id, id),
  foreign key (shop_id, location_id) references locations (shop_id, id)
);

create index count_sessions_recent_idx on count_sessions (shop_id, id desc);
create index count_sessions_open_idx on count_sessions (shop_id) where status = 'open';

create table count_lines (
  shop_id uuid not null,
  id uuid not null,
  session_id uuid not null,
  variant_id uuid not null,
  location_id uuid not null,
  condition text not null default 'sellable'
    check (condition in ('sellable', 'quarantine', 'damaged', 'repair', 'supplier_return')),
  lot_id uuid,
  serial_id uuid,
  -- The position, when one exists for this identity (a found item may have none yet).
  position_id uuid,
  -- On hand when the line was added to the session (shown unless the session is blind).
  expected numeric(20, 6) not null default 0 check (expected >= 0),
  counted numeric(20, 6) check (counted >= 0),
  -- The basis of the count: the position's version, on hand, and number of ledger entries when
  -- it was counted. A movement after that (new ledger entries) means the line needs review.
  counted_version bigint,
  counted_on_hand numeric(20, 6),
  counted_entries integer,
  counted_at timestamptz,
  counted_by text,
  -- What was entered, when counted in a pack (G8).
  pack_id uuid,
  pack_version integer,
  entered_quantity numeric(20, 6),
  conversion_factor numeric(20, 6),
  status text not null default 'pending' check (status in ('pending', 'counted', 'posted')),
  -- What submit posted for this line: the adjustment, signed.
  posted_delta numeric(20, 6),
  primary key (shop_id, id),
  constraint count_lines_identity
    unique nulls not distinct (shop_id, session_id, variant_id, location_id, condition, lot_id, serial_id),
  foreign key (shop_id, session_id) references count_sessions (shop_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  foreign key (shop_id, location_id) references locations (shop_id, id),
  foreign key (shop_id, variant_id, lot_id) references lots (shop_id, variant_id, id),
  foreign key (shop_id, variant_id, serial_id) references serial_units (shop_id, variant_id, id),
  foreign key (shop_id, position_id) references inventory_positions (shop_id, id),
  foreign key (shop_id, pack_id) references packs (shop_id, id),
  check (serial_id is null or counted is null or counted <= 1),
  check ((status = 'pending') = (counted is null))
);

create index count_lines_session_idx on count_lines (shop_id, session_id);
create index count_lines_position_idx on count_lines (shop_id, position_id) where position_id is not null;

alter table inventory_operations add column count_session_id uuid,
  add constraint inventory_operations_count_session_fk foreign key (shop_id, count_session_id)
    references count_sessions (shop_id, id);
create index inventory_operations_count_session_idx on inventory_operations (shop_id, count_session_id)
  where count_session_id is not null;

-- One reversal per operation: a second reversal of the same operation is refused by the index.
create unique index inventory_operations_one_reversal_idx on inventory_operations (shop_id, reverses_operation_id)
  where reverses_operation_id is not null;

alter table count_sessions add constraint count_sessions_operation_fk foreign key (shop_id, operation_id)
  references inventory_operations (shop_id, id);

alter table count_sessions enable row level security;
alter table count_lines enable row level security;

create policy tenant_isolation on count_sessions using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on count_lines using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());

grant select, insert, update on count_sessions, count_lines to airstock_app;
