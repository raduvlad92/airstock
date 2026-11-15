-- Phase 1, milestone N1: custom fields, product families, options, attributes, relations, units.
--
-- Custom field values live in typed JSONB `attributes` on products and variants, keyed by field ID
-- (ADR 0012). On a variant, a missing key inherits the product's value, a JSON null clears it, and
-- any other value is the variant's own. The same three states apply to the weight and dimensions
-- columns: SQL NULL inherits, JSON null clears.

-- Field definitions ------------------------------------------------------------------------

create table field_definitions (
  shop_id uuid not null references shops (id),
  id uuid not null,
  -- A slug used in imports, exports, and the API. Never changes, like the ID.
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  label text not null check (length(label) between 1 and 200),
  description text check (length(description) <= 2000),
  type text not null check (type in ('text', 'rich_text', 'integer', 'decimal', 'boolean', 'date',
    'timestamp', 'single_select', 'multi_select', 'money', 'measurement', 'file', 'relationship')),
  level text not null check (level in ('product', 'variant', 'both')),
  -- Validation rules per type (packages/core/src/catalog/fields.ts).
  config jsonb not null default '{}'::jsonb,
  default_value jsonb,
  -- restricted: only members with catalog.schema.manage see or change values.
  visibility text not null default 'everyone' check (visibility in ('everyone', 'restricted')),
  status text not null default 'active' check (status in ('active', 'archived')),
  -- Brand and category: created with every shop, cannot be archived or retyped.
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (shop_id, id),
  unique (shop_id, key)
);

create table field_options (
  shop_id uuid not null,
  id uuid not null,
  field_id uuid not null,
  label text not null check (length(label) between 1 and 200),
  position integer not null,
  -- Archived options stay on existing records but are not offered for new choices.
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  foreign key (shop_id, field_id) references field_definitions (shop_id, id)
);

create unique index field_options_label_idx on field_options (shop_id, field_id, lower(label))
  where not archived;
create index field_options_field_idx on field_options (shop_id, field_id, position);

-- Product families --------------------------------------------------------------------------

create table product_families (
  shop_id uuid not null references shops (id),
  id uuid not null,
  name text not null check (length(name) between 1 and 200),
  description text check (length(description) <= 2000),
  -- Set when the family came from a starter template (apparel, furniture, food, spare_parts).
  template_key text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (shop_id, id)
);

create unique index product_families_name_idx on product_families (shop_id, lower(name))
  where status = 'active';

create table family_fields (
  shop_id uuid not null,
  family_id uuid not null,
  field_id uuid not null,
  required boolean not null default false,
  position integer not null,
  group_name text check (length(group_name) <= 100),
  primary key (shop_id, family_id, field_id),
  foreign key (shop_id, family_id) references product_families (shop_id, id),
  foreign key (shop_id, field_id) references field_definitions (shop_id, id)
);

create table family_option_suggestions (
  shop_id uuid not null,
  id uuid not null,
  family_id uuid not null,
  name text not null check (length(name) between 1 and 100),
  position integer not null,
  "values" jsonb not null default '[]'::jsonb,
  primary key (shop_id, id),
  foreign key (shop_id, family_id) references product_families (shop_id, id)
);

-- Products and variants ---------------------------------------------------------------------

alter table products drop constraint products_status_check;
alter table products add constraint products_status_check
  check (status in ('draft', 'active', 'archived'));
alter table products add column family_id uuid;
alter table products add constraint products_family_fk
  foreign key (shop_id, family_id) references product_families (shop_id, id);
alter table products add column tags text[] not null default '{}';
alter table products add column attributes jsonb not null default '{}'::jsonb
  check (jsonb_typeof(attributes) = 'object');
-- {"value": "1.2", "unit": "kg", "canonical": "1200"}; canonical in grams.
alter table products add column weight jsonb;
-- {"length": "120", "width": "60", "height": "75", "unit": "cm", "canonical": {...}}; millimetres.
alter table products add column dimensions jsonb;

-- The Phase 0 options column was never used; option values now have stable IDs.
alter table variants drop column options;
-- Value IDs in option position order; empty for a product without options.
alter table variants add column option_value_ids uuid[] not null default '{}';
alter table variants add column attributes jsonb not null default '{}'::jsonb
  check (jsonb_typeof(attributes) = 'object');
alter table variants add column weight jsonb;
alter table variants add column dimensions jsonb;

-- One active variant per option combination.
create unique index variants_combination_idx on variants (shop_id, product_id, option_value_ids)
  where status = 'active';
create index variants_product_idx on variants (shop_id, product_id);
create index products_family_idx on products (shop_id, family_id);

-- Equality and option filters on custom fields (plan Section 5.2).
create index products_attributes_idx on products using gin (attributes jsonb_path_ops);
create index variants_attributes_idx on variants using gin (attributes jsonb_path_ops);

create table product_options (
  shop_id uuid not null,
  id uuid not null,
  product_id uuid not null,
  name text not null check (length(name) between 1 and 100),
  position smallint not null check (position between 0 and 2),
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  -- Deferred, so options can swap places inside one transaction.
  constraint product_options_position_key unique (shop_id, product_id, position)
    deferrable initially deferred,
  foreign key (shop_id, product_id) references products (shop_id, id)
);

create unique index product_options_name_idx on product_options (shop_id, product_id, lower(name));

create table product_option_values (
  shop_id uuid not null,
  id uuid not null,
  option_id uuid not null,
  label text not null check (length(label) between 1 and 100),
  position integer not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  foreign key (shop_id, option_id) references product_options (shop_id, id)
);

create unique index product_option_values_label_idx
  on product_option_values (shop_id, option_id, lower(label));

-- Relationship field values, queryable both ways ("compatible with", "replaces").
create table record_relations (
  shop_id uuid not null,
  id uuid not null,
  field_id uuid not null,
  source_type text not null check (source_type in ('product', 'variant')),
  source_id uuid not null,
  target_type text not null check (target_type in ('product', 'variant')),
  target_id uuid not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (shop_id, id),
  unique (shop_id, field_id, source_id, target_id),
  foreign key (shop_id, field_id) references field_definitions (shop_id, id)
);

create index record_relations_target_idx on record_relations (shop_id, target_id);

-- Units shown in the dashboard (PRD 3.1); values keep the unit they were entered in.
alter table shops add column display_units text not null default 'metric'
  check (display_units in ('metric', 'imperial'));

-- Row-level security ----------------------------------------------------------------------

alter table field_definitions enable row level security;
alter table field_options enable row level security;
alter table product_families enable row level security;
alter table family_fields enable row level security;
alter table family_option_suggestions enable row level security;
alter table product_options enable row level security;
alter table product_option_values enable row level security;
alter table record_relations enable row level security;

create policy tenant_isolation on field_definitions using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on field_options using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on product_families using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on family_fields using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on family_option_suggestions using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on product_options using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on product_option_values using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on record_relations using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());

grant select, insert, update on field_definitions, field_options, product_families,
  product_options, product_option_values to airstock_app;
-- Membership lists and relation sets are replaced, so these rows can be deleted.
grant select, insert, update, delete on family_fields, family_option_suggestions,
  record_relations to airstock_app;
grant delete on product_options, product_option_values to airstock_app;

-- System fields for existing shops (new shops get them from shops.create). -----------------

insert into field_definitions (shop_id, id, key, label, type, level, is_system)
select s.id, gen_random_uuid(), f.key, f.label, 'single_select', 'product', true
from shops s
cross join (values ('brand', 'Brand'), ('category', 'Category')) as f(key, label)
on conflict (shop_id, key) do nothing;
