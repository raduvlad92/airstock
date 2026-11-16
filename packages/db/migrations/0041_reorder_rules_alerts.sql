-- Phase 2, milestone I3: reorder rules and alerts (plan Section 5.9, decision D12, PRD 6.9).
--
-- Low-stock alerts are checked in the transaction that changes stock or on order, after the
-- command's own locks (alerts are last in the lock order, ADR 0006). One open alert per key:
-- `alerts_open_key_idx` (0017) makes a concurrent opener wait, then do nothing.

create table reorder_rules (
  shop_id uuid not null references shops (id),
  id uuid not null,
  variant_id uuid not null,
  -- Per warehouse; per location optionally (PRD 6.9, confirmed in v0.4).
  warehouse_id uuid not null,
  location_id uuid,
  reorder_point numeric(20, 6) not null check (reorder_point >= 0),
  -- Exactly one of: order this much, or order up to this level.
  reorder_quantity numeric(20, 6) check (reorder_quantity > 0),
  maximum_level numeric(20, 6) check (maximum_level > 0),
  preferred_supplier_id uuid,
  status text not null default 'active' check (status in ('active', 'archived')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  foreign key (shop_id, warehouse_id) references warehouses (shop_id, id),
  foreign key (shop_id, location_id) references locations (shop_id, id),
  foreign key (shop_id, preferred_supplier_id) references suppliers (shop_id, id),
  check ((reorder_quantity is null) <> (maximum_level is null)),
  check (maximum_level is null or maximum_level > reorder_point)
);

-- One active rule per variant and warehouse, or variant and location.
create unique index reorder_rules_identity_idx
  on reorder_rules (shop_id, variant_id, warehouse_id, location_id) nulls not distinct
  where status = 'active';
create index reorder_rules_variant_idx on reorder_rules (shop_id, variant_id) where status = 'active';

-- Alerts (0017) learn what they are about. location_ids holds the scope path the alert is about
-- (a warehouse ID, or a location's path from its warehouse down): a member sees the alert when it
-- overlaps their location scope. Null means shop-wide (shortages, the stock check): only members
-- with every location see those.
alter table alerts
  add column rule_id uuid,
  add column variant_id uuid,
  add column warehouse_id uuid,
  add column lot_id uuid,
  -- Why it resolved: recovered, sold_out, filled, reconciled, rule_removed.
  add column resolution text check (length(resolution) <= 50),
  add constraint alerts_rule_fk foreign key (shop_id, rule_id) references reorder_rules (shop_id, id),
  add constraint alerts_variant_fk foreign key (shop_id, variant_id) references variants (shop_id, id),
  add constraint alerts_warehouse_fk foreign key (shop_id, warehouse_id) references warehouses (shop_id, id),
  add constraint alerts_lot_fk foreign key (shop_id, lot_id) references lots (shop_id, id);

create index alerts_kind_idx on alerts (shop_id, kind, status, opened_at desc);

-- Lots expiring within this many days raise an alert in the daily check (plan 5.9).
alter table shops add column lot_expiry_alert_days integer not null default 30
  check (lot_expiry_alert_days between 0 and 3650);

-- What each member receives, per alert kind. Without a row: in the app always; by email for
-- members who manage alerts (owners and managers).
create table alert_subscriptions (
  shop_id uuid not null,
  membership_id uuid not null,
  kind text not null check (kind in ('low_stock', 'lot_expiring', 'shortage', 'shopify_sync',
    'reconciliation_mismatch')),
  in_app boolean not null default true,
  email boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (shop_id, membership_id, kind),
  foreign key (shop_id, membership_id) references memberships (shop_id, id)
);

-- One notification per alert opening, member, and channel (D12: not one per order).
create table notifications (
  shop_id uuid not null,
  id uuid not null,
  alert_id uuid not null,
  membership_id uuid not null,
  channel text not null check (channel in ('email')),
  recipient text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  provider_message_id text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (shop_id, id),
  unique (shop_id, alert_id, membership_id, channel),
  foreign key (shop_id, alert_id) references alerts (shop_id, id),
  foreign key (shop_id, membership_id) references memberships (shop_id, id)
);

-- Shops with active reorder rules or stock in lots, for the daily alert check.
create function shops_due_alert_check(p_limit integer) returns setof uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select s.id from shops s
  where exists (select 1 from reorder_rules r where r.shop_id = s.id and r.status = 'active')
     or exists (select 1 from lots l where l.shop_id = s.id and l.expires_on is not null)
     or exists (select 1 from alerts a where a.shop_id = s.id and a.status <> 'resolved')
  order by s.id
  limit least(p_limit, 1000)
$$;

revoke execute on function shops_due_alert_check(integer) from public;
grant execute on function shops_due_alert_check(integer) to airstock_app;

alter table reorder_rules enable row level security;
alter table alert_subscriptions enable row level security;
alter table notifications enable row level security;

create policy tenant_isolation on reorder_rules using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on alert_subscriptions using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on notifications using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());

grant select, insert, update on reorder_rules, notifications to airstock_app;
grant select, insert, update, delete on alert_subscriptions to airstock_app;
