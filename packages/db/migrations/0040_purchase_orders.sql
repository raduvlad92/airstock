-- Phase 2, milestone I3: purchase orders (plan Section 5.8, decision D11, PRD 6.8).
--
-- A purchase order never changes stock by itself. Receiving against a line runs the receipt path
-- (0017) and records the link here. Per-line quantities are authoritative and in base units:
--   ordered     what was ordered (quantity × the pack's factor when the line is in packs)
--   received    what arrived against the line; may exceed ordered after a confirmed over-receipt
--   cancelled   the remainder cancelled by closing or cancelling the order
-- "On order" is what open lines still expect: greatest(ordered − received − cancelled, 0) on
-- orders that are sent or partially received. It is never sellable (PRD 5.3).
--
-- Lock order: a PO receipt locks positions, reservations, and the variant's cost row through the
-- receipt path first, then the purchase order and its line ("everything else", ADR 0006).

create table purchase_orders (
  shop_id uuid not null references shops (id),
  id uuid not null,
  -- Shown as PO-0001; one sequence per shop (purchase_order_counters).
  number integer not null check (number > 0),
  supplier_id uuid not null,
  -- The destination (PRD 6.8); on order counts here.
  warehouse_id uuid not null,
  -- Optional default receiving location inside the warehouse.
  location_id uuid,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'partially_received', 'received', 'closed', 'cancelled')),
  -- The shop currency in V0; foreign-currency orders come later (PRD 6.8).
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  expected_on date,
  -- The supplier's order or confirmation number.
  supplier_reference text check (length(supplier_reference) between 1 and 200),
  notes text check (length(notes) <= 5000),
  created_by_type text not null,
  created_by_id text not null,
  sent_at timestamptz,
  received_at timestamptz,
  closed_at timestamptz,
  cancelled_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, id),
  unique (shop_id, number),
  foreign key (shop_id, supplier_id) references suppliers (shop_id, id),
  foreign key (shop_id, warehouse_id) references warehouses (shop_id, id),
  foreign key (shop_id, location_id) references locations (shop_id, id)
);

create index purchase_orders_status_idx on purchase_orders (shop_id, status, number desc);
create index purchase_orders_supplier_idx on purchase_orders (shop_id, supplier_id, number desc);

create table purchase_order_counters (
  shop_id uuid not null references shops (id),
  last_number integer not null default 0,
  primary key (shop_id)
);

create table purchase_order_lines (
  shop_id uuid not null,
  id uuid not null,
  purchase_order_id uuid not null,
  position integer not null check (position >= 0),
  variant_id uuid not null,
  -- The pack ordered in, such as a case of 24; null when ordered in base units.
  pack_id uuid,
  -- The pack's factor and version when the line was written: the ordered quantity is fixed in
  -- base units even if the pack changes later.
  pack_factor numeric(20, 6) check (pack_factor > 0),
  pack_version integer,
  supplier_item_id uuid,
  supplier_sku text check (length(supplier_sku) between 1 and 100),
  -- As entered: packs when pack_id is set, else base units.
  quantity numeric(20, 6) not null check (quantity > 0),
  ordered numeric(20, 6) not null check (ordered > 0),
  received numeric(20, 6) not null default 0 check (received >= 0),
  cancelled numeric(20, 6) not null default 0 check (cancelled >= 0),
  -- Restricted (costs.read): per pack when pack_id is set, else per base unit. A receipt against
  -- the line carries it into valuation (PRD 6.11).
  unit_cost numeric(20, 6) check (unit_cost >= 0),
  note text check (length(note) <= 500),
  primary key (shop_id, id),
  unique (shop_id, purchase_order_id, position),
  foreign key (shop_id, purchase_order_id) references purchase_orders (shop_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  foreign key (shop_id, variant_id, pack_id) references packs (shop_id, variant_id, id),
  foreign key (shop_id, supplier_item_id) references supplier_items (shop_id, id),
  check ((pack_id is null) = (pack_factor is null) and (pack_id is null) = (pack_version is null)),
  check (ordered = quantity * coalesce(pack_factor, 1)),
  -- Cancelling never takes back what arrived.
  check (cancelled <= greatest(ordered - received, 0))
);

create index purchase_order_lines_variant_idx on purchase_order_lines (shop_id, variant_id);

-- Every receipt against a line: the inventory operation it ran, in base units, and what part of
-- it went beyond the ordered quantity (an over-receipt, confirmed by the person receiving).
create table purchase_order_receipts (
  shop_id uuid not null,
  id uuid not null,
  purchase_order_id uuid not null,
  line_id uuid not null,
  operation_id uuid not null,
  quantity numeric(20, 6) not null check (quantity > 0),
  over_received numeric(20, 6) not null default 0 check (over_received >= 0),
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  foreign key (shop_id, purchase_order_id) references purchase_orders (shop_id, id),
  foreign key (shop_id, line_id) references purchase_order_lines (shop_id, id),
  foreign key (shop_id, operation_id) references inventory_operations (shop_id, id)
);

create index purchase_order_receipts_order_idx on purchase_order_receipts (shop_id, purchase_order_id);

-- A lot received against a PO line names it (G6: a lot trace lists its supplier and PO).
alter table lots add column purchase_order_line_id uuid,
  add constraint lots_purchase_order_line_fk foreign key (shop_id, purchase_order_line_id)
    references purchase_order_lines (shop_id, id);

-- The send log (D11): every send, emailed or marked as sent by hand, with what happened to the
-- email. The email job fills in the provider's message ID or the error.
create table po_sends (
  shop_id uuid not null,
  id uuid not null,
  purchase_order_id uuid not null,
  -- The order's version when it was sent: what the PDF showed.
  purchase_order_version integer not null,
  channel text not null check (channel in ('email', 'manual')),
  recipient text check (length(recipient) <= 320),
  -- recorded: sent outside Airstock; queued → sent or failed; suppressed: this environment only
  -- emails Airstock users (staging), so the email was not sent.
  status text not null check (status in ('recorded', 'queued', 'sent', 'failed', 'suppressed')),
  message text check (length(message) <= 2000),
  provider_message_id text,
  error text,
  actor_type text not null,
  actor_id text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (shop_id, id),
  foreign key (shop_id, purchase_order_id) references purchase_orders (shop_id, id)
);

create index po_sends_order_idx on po_sends (shop_id, purchase_order_id, created_at desc);

-- On order now, per open line (PRD 5.3): what sent or partially received orders still expect.
create function purchase_on_order(p_variant_ids uuid[])
returns table (variant_id uuid, warehouse_id uuid, location_id uuid, purchase_order_id uuid,
  line_id uuid, quantity numeric, expected_on date)
language sql stable
as $$
  select l.variant_id, o.warehouse_id, o.location_id, o.id, l.id,
    greatest(l.ordered - l.received - l.cancelled, 0), o.expected_on
  from purchase_order_lines l
  join purchase_orders o on o.shop_id = l.shop_id and o.id = l.purchase_order_id
  where l.variant_id = any(p_variant_ids)
    and o.status in ('sent', 'partially_received')
    and l.ordered - l.received - l.cancelled > 0
$$;

alter table purchase_orders enable row level security;
alter table purchase_order_counters enable row level security;
alter table purchase_order_lines enable row level security;
alter table purchase_order_receipts enable row level security;
alter table po_sends enable row level security;

create policy tenant_isolation on purchase_orders using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on purchase_order_counters using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on purchase_order_lines using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on purchase_order_receipts using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on po_sends using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());

grant select, insert, update on purchase_orders, purchase_order_counters, po_sends to airstock_app;
-- Draft lines are replaced as a whole while the order is a draft.
grant select, insert, update, delete on purchase_order_lines to airstock_app;
grant select, insert on purchase_order_receipts to airstock_app;
grant execute on function purchase_on_order(uuid[]) to airstock_app;
