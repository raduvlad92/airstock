-- Phase 2, milestone I5 (plan Section 5.15, D15): the eight standard reports, saved reports, and
-- report CSV exports through the existing export jobs (ADR 0018).

-- Saved reports: a report type, its filters, and a name; private to their owner or shared with
-- the shop. Scheduled emails come after January (owner decision): they will add a schedule
-- column (daily, weekly, monthly) and recipients here, and the job applies each recipient's
-- location scope and cost permission when it runs (PRD 3.5).
create table saved_reports (
  shop_id uuid not null references shops (id),
  id uuid not null,
  owner_membership_id uuid not null,
  name text not null check (length(name) between 1 and 100),
  report text not null check (report in ('stock_on_hand', 'low_stock', 'movements',
    'inventory_value', 'cost_of_goods', 'purchasing', 'expiring_lots', 'shortages')),
  -- The report's filters, sort, and grouping, as the run operation takes them.
  filters jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object'),
  shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (shop_id, id),
  foreign key (shop_id, owner_membership_id) references memberships (shop_id, id)
);

create index saved_reports_owner_idx on saved_reports (shop_id, owner_membership_id);
create index saved_reports_shared_idx on saved_reports (shop_id) where shared;

alter table saved_reports enable row level security;
create policy tenant_isolation on saved_reports using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
grant select, insert, update, delete on saved_reports to airstock_app;

-- Report exports share the export jobs: `kind` says which runner writes the file, and `query`
-- holds the report and its filters.
alter table export_jobs add column kind text not null default 'catalog'
  check (kind in ('catalog', 'report'));

-- Movements over a period and stock at a past date read the ledger by time, across variants.
-- Entries carry the transaction's time (the same as their operation's `occurred_at`).
create index inventory_entries_time_idx on inventory_entries (shop_id, created_at);
