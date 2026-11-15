-- Phase 1, milestone N5: packs, shipping packages, barcodes, label templates, bundles, suppliers
-- (ADR 0019).
--
-- Stock stays in each variant's base unit. A pack names a quantity of base units, or of another
-- pack of the same variant ("a case holds 12 inner packs"); its base quantity is resolved exactly
-- when it is saved and kept with every version, so a Phase 2 inventory entry can record the factor
-- it used. Barcodes belong to a variant or one of its packs and are unique per shop on their
-- normalized code.

-- List versions -----------------------------------------------------------------------------

-- Packs, barcodes, and shipping packages are each replaced as a whole list. An edit names the
-- version of the list it read and is refused if the list changed since. The row is also the lock
-- that serializes packaging edits of one variant without locking the variant itself.
create table variant_packaging (
  shop_id uuid not null,
  variant_id uuid not null,
  packs_version integer not null default 0,
  barcodes_version integer not null default 0,
  shipping_packages_version integer not null default 0,
  primary key (shop_id, variant_id),
  foreign key (shop_id, variant_id) references variants (shop_id, id)
);

-- Packs -------------------------------------------------------------------------------------

create table packs (
  shop_id uuid not null,
  id uuid not null,
  variant_id uuid not null,
  name text not null check (length(name) between 1 and 100),
  -- Base units, or inner packs when inner_pack_id is set (then a whole number).
  quantity numeric(20, 6) not null check (quantity > 0),
  inner_pack_id uuid,
  -- quantity × the inner pack's base quantity; always fits the variant's quantity scale.
  base_quantity numeric(20, 6) not null check (base_quantity > 0),
  uses text[] not null default '{}'
    check (uses <@ array['purchasing', 'counting', 'transfer', 'sales']::text[]),
  -- Same shapes as the variant's dimensions and weight columns (ADR 0012).
  dimensions jsonb,
  weight jsonb,
  -- Without a price of its own, a pack sells at the variant's price per base unit.
  price numeric(20, 6) check (price >= 0),
  position integer not null,
  -- Packs are archived, never deleted: inventory entries and bundle versions refer to them.
  status text not null default 'active' check (status in ('active', 'archived')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, id),
  -- Lets barcodes, bundle components, supplier items, and inner packs require the same variant.
  unique (shop_id, variant_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  -- Deferred, so a list can be written in any order inside one transaction.
  constraint packs_inner_pack_fk foreign key (shop_id, variant_id, inner_pack_id)
    references packs (shop_id, variant_id, id) deferrable initially deferred,
  check (inner_pack_id is null or inner_pack_id <> id)
);

create index packs_variant_idx on packs (shop_id, variant_id, position);

-- Every definition a pack has had. Insert-only, like other history.
create table pack_versions (
  shop_id uuid not null,
  id uuid not null,
  pack_id uuid not null,
  version integer not null,
  name text not null,
  quantity numeric(20, 6) not null,
  inner_pack_id uuid,
  base_quantity numeric(20, 6) not null,
  uses text[] not null,
  dimensions jsonb,
  weight jsonb,
  price numeric(20, 6),
  status text not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  unique (shop_id, pack_id, version),
  foreign key (shop_id, pack_id) references packs (shop_id, id)
);

-- Phase 2 commands that take a pack quantity write the pack here (the column exists since 0002).
alter table inventory_entries add constraint inventory_entries_pack_fk
  foreign key (shop_id, pack_id) references packs (shop_id, id);

-- Shipping packages: the boxes one unit ships in (PRD 4.2), separate from packs.
create table shipping_packages (
  shop_id uuid not null,
  id uuid not null,
  variant_id uuid not null,
  position integer not null,
  name text check (length(name) between 1 and 100),
  dimensions jsonb not null,
  weight jsonb not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id)
);

create index shipping_packages_variant_idx on shipping_packages (shop_id, variant_id, position);

-- Barcodes ----------------------------------------------------------------------------------

create table barcodes (
  shop_id uuid not null,
  id uuid not null,
  variant_id uuid not null,
  -- Null: the variant's own barcode. Otherwise one of the variant's packs.
  pack_id uuid,
  symbology text not null check (symbology in ('ean13', 'ean8', 'upca', 'code128', 'qr', 'other')),
  code text not null check (length(code) between 1 and 200),
  -- GTINs padded to 14 digits; other codes trimmed and upper-cased (catalog/barcodes.ts).
  code_normalized text not null,
  source text not null default 'entered' check (source in ('entered', 'generated')),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  -- One owner per code in a shop, across variants and packs (PRD 4.7).
  unique (shop_id, code_normalized),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  foreign key (shop_id, variant_id, pack_id) references packs (shop_id, variant_id, id)
);

create index barcodes_variant_idx on barcodes (shop_id, variant_id, position);

-- The shop-wide counter behind generated internal codes.
create table barcode_sequences (
  shop_id uuid primary key references shops (id),
  last_value bigint not null default 0
);

-- Label templates: a layout and the fields to print. The layouts themselves are code.
create table label_templates (
  shop_id uuid not null references shops (id),
  id uuid not null,
  name text not null check (length(name) between 1 and 100),
  kind text not null check (kind in ('item', 'location')),
  layout text not null check (length(layout) between 1 and 50),
  fields text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'archived')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, id)
);

create unique index label_templates_name_idx on label_templates (shop_id, lower(name))
  where status = 'active';

-- Bundles -----------------------------------------------------------------------------------

-- A bundle is a variant made of other variants. `version` is the current definition; a bundle
-- with no components is inactive (the variant is an ordinary one again).
create table bundles (
  shop_id uuid not null,
  id uuid not null,
  variant_id uuid not null,
  version integer not null default 0,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, id),
  unique (shop_id, variant_id),
  foreign key (shop_id, variant_id) references variants (shop_id, id)
);

-- Every definition, insert-only, so Phase 2 reservations can record the version they used.
create table bundle_versions (
  shop_id uuid not null,
  id uuid not null,
  bundle_id uuid not null,
  version integer not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  unique (shop_id, bundle_id, version),
  foreign key (shop_id, bundle_id) references bundles (shop_id, id)
);

create table bundle_components (
  shop_id uuid not null,
  id uuid not null,
  bundle_version_id uuid not null,
  position integer not null,
  variant_id uuid not null,
  pack_id uuid,
  pack_version integer,
  -- As entered: packs when pack_id is set, otherwise base units.
  quantity numeric(20, 6) not null check (quantity > 0),
  -- Base units of the component per bundle, resolved when the version was written.
  base_quantity numeric(20, 6) not null check (base_quantity > 0),
  primary key (shop_id, id),
  foreign key (shop_id, bundle_version_id) references bundle_versions (shop_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  foreign key (shop_id, variant_id, pack_id) references packs (shop_id, variant_id, id)
);

create index bundle_components_version_idx on bundle_components (shop_id, bundle_version_id, position);
create index bundle_components_variant_idx on bundle_components (shop_id, variant_id);

-- Suppliers ---------------------------------------------------------------------------------

create table suppliers (
  shop_id uuid not null references shops (id),
  id uuid not null,
  name text not null check (length(name) between 1 and 200),
  contact_name text check (length(contact_name) <= 200),
  email text check (length(email) <= 320),
  phone text check (length(phone) <= 50),
  website text check (length(website) <= 500),
  address text check (length(address) <= 1000),
  -- The shop currency in V0.
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  lead_time_days integer check (lead_time_days between 0 and 3650),
  notes text check (length(notes) <= 5000),
  status text not null default 'active' check (status in ('active', 'archived')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, id)
);

create unique index suppliers_name_idx on suppliers (shop_id, lower(name)) where status = 'active';

create table supplier_items (
  shop_id uuid not null,
  id uuid not null,
  supplier_id uuid not null,
  variant_id uuid not null,
  -- The pack the supplier sells, such as a case; null when bought in base units.
  pack_id uuid,
  supplier_sku text check (length(supplier_sku) between 1 and 100),
  supplier_sku_normalized text,
  -- Restricted: returned only to members with costs.read.
  last_cost numeric(20, 6) check (last_cost >= 0),
  last_cost_at timestamptz,
  minimum_order_quantity numeric(20, 6) check (minimum_order_quantity > 0),
  preferred boolean not null default false,
  status text not null default 'active' check (status in ('active', 'archived')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, id),
  foreign key (shop_id, supplier_id) references suppliers (shop_id, id),
  foreign key (shop_id, variant_id) references variants (shop_id, id),
  foreign key (shop_id, variant_id, pack_id) references packs (shop_id, variant_id, id)
);

-- One active item per supplier, variant, and pack; one supplier SKU per supplier; one preferred
-- item per variant.
create unique index supplier_items_identity_idx
  on supplier_items (shop_id, supplier_id, variant_id, pack_id) nulls not distinct
  where status = 'active';
create unique index supplier_items_sku_idx
  on supplier_items (shop_id, supplier_id, supplier_sku_normalized)
  where status = 'active' and supplier_sku_normalized is not null;
create unique index supplier_items_preferred_idx on supplier_items (shop_id, variant_id)
  where preferred and status = 'active';
create index supplier_items_variant_idx on supplier_items (shop_id, variant_id);
-- Search by supplier SKU (plan Section 5.10).
create index supplier_items_supplier_sku_lookup_idx
  on supplier_items (shop_id, supplier_sku_normalized);

-- Row-level security ----------------------------------------------------------------------

alter table variant_packaging enable row level security;
alter table packs enable row level security;
alter table pack_versions enable row level security;
alter table shipping_packages enable row level security;
alter table barcodes enable row level security;
alter table barcode_sequences enable row level security;
alter table label_templates enable row level security;
alter table bundles enable row level security;
alter table bundle_versions enable row level security;
alter table bundle_components enable row level security;
alter table suppliers enable row level security;
alter table supplier_items enable row level security;

create policy tenant_isolation on variant_packaging using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on packs using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on pack_versions using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on shipping_packages using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on barcodes using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on barcode_sequences using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on label_templates using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on bundles using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on bundle_versions using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on bundle_components using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on suppliers using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on supplier_items using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());

grant select, insert, update on variant_packaging, packs, barcode_sequences, label_templates,
  bundles, suppliers, supplier_items to airstock_app;
-- History: definitions are added, never changed or removed.
grant select, insert on pack_versions, bundle_versions, bundle_components to airstock_app;
-- Replaced as whole lists.
grant select, insert, update, delete on barcodes to airstock_app;
grant select, insert, delete on shipping_packages to airstock_app;
