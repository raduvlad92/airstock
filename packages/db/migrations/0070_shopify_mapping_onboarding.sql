-- Phase 2, milestone I6 (PRD Phase 3): Shopify mapping and onboarding (plan Section 5.14, D17).
--
-- Several Shopify locations per connection, each mapped to a warehouse or a location; Shopify
-- variants mapped to a variant, a sales pack of a variant, or a bundle (a bundle is a variant with
-- an active definition, ADR 0019); and the onboarding import, which reads a store with a bulk
-- operation and writes it through the CSV import job (ADR 0018). Pictures imported from Shopify
-- are referenced by their Shopify URL, not copied to R2 (D17).

-- Location maps ------------------------------------------------------------------------------

-- A Shopify location maps to a warehouse (every location in it) or to one location (and its
-- sub-locations). Availability pushed there is the sum over that scope. Opening quantities from
-- the onboarding import are received at `receive_location_id`, a location without children in
-- the scope. `position` orders the connection's allocation rule (channel 'shopify:<connection>').
alter table shopify_location_maps
  add column warehouse_id uuid,
  add column receive_location_id uuid,
  add column position integer not null default 0 check (position >= 0),
  add column updated_at timestamptz not null default now(),
  alter column location_id drop not null,
  add constraint shopify_location_maps_one_scope
    check ((location_id is null) <> (warehouse_id is null)),
  add constraint shopify_location_maps_warehouse_fk foreign key (shop_id, warehouse_id)
    references warehouses (shop_id, id),
  add constraint shopify_location_maps_receive_fk foreign key (shop_id, receive_location_id)
    references locations (shop_id, id);
alter table shopify_location_maps
  add column scope_id uuid generated always as (coalesce(location_id, warehouse_id)) stored;
update shopify_location_maps set receive_location_id = location_id where receive_location_id is null;
alter table shopify_location_maps drop constraint shopify_location_maps_shop_id_connection_id_location_id_key;
alter table shopify_location_maps add constraint shopify_location_maps_scope_key
  unique (shop_id, connection_id, scope_id);

-- Variant maps -------------------------------------------------------------------------------

-- A Shopify variant sells one unit of the variant, one of its sales packs (Shopify shows
-- floor(available / pack base quantity); a sale reserves pack × quantity base units), or one
-- bundle (the bundle's variant). Several Shopify variants may sell the same variant: the single
-- and the 6-pack.
alter table shopify_variant_maps
  add column pack_id uuid,
  add column shopify_product_id text check (shopify_product_id ~ '^[0-9]+$'),
  add column sku text check (length(sku) <= 255),
  add column title text check (length(title) <= 1000),
  -- How the map was made: matched by SKU or barcode, set by a person, or by the onboarding import.
  add column source text not null default 'manual'
    check (source in ('sku', 'barcode', 'manual', 'onboarding', 'listing')),
  add column updated_at timestamptz not null default now(),
  add constraint shopify_variant_maps_pack_fk foreign key (shop_id, variant_id, pack_id)
    references packs (shop_id, variant_id, id);
alter table shopify_variant_maps drop constraint shopify_variant_maps_shop_id_connection_id_variant_id_key;
create unique index shopify_variant_maps_target_idx
  on shopify_variant_maps (shop_id, connection_id, variant_id, coalesce(pack_id, variant_id));
create index shopify_variant_maps_variant_idx on shopify_variant_maps (shop_id, variant_id);
create index shopify_variant_maps_item_idx
  on shopify_variant_maps (shop_id, connection_id, shopify_inventory_item_id);
grant update on shopify_variant_maps, shopify_location_maps to airstock_app;

-- The store's catalog as last read (unmapped variants are shown, never guessed) ----------------

-- One row per Shopify variant seen by the onboarding read or a products webhook. The dashboard
-- lists the unmapped ones with their SKU and barcode.
create table shopify_catalog_variants (
  shop_id uuid not null,
  connection_id uuid not null,
  shopify_variant_id text not null check (shopify_variant_id ~ '^[0-9]+$'),
  shopify_product_id text not null check (shopify_product_id ~ '^[0-9]+$'),
  shopify_inventory_item_id text check (shopify_inventory_item_id ~ '^[0-9]+$'),
  sku text check (length(sku) <= 255),
  barcode text check (length(barcode) <= 255),
  title text not null check (length(title) <= 1000),
  tracked boolean not null default true,
  seen_at timestamptz not null default now(),
  primary key (shop_id, connection_id, shopify_variant_id),
  foreign key (shop_id, connection_id) references shopify_connections (shop_id, id)
);

-- Onboarding ---------------------------------------------------------------------------------

-- One onboarding import per run. The job reads the store with a bulk operation (resumable: the
-- operation's ID is kept, so a restarted job polls the same one), stores the result in R2, matches
-- every Shopify variant by SKU, then barcode, and writes a CSV import that the person previews and
-- commits (ADR 0018). After the import completes, the job maps the variants and references the
-- pictures.
create table shopify_onboardings (
  shop_id uuid not null,
  id uuid not null,
  connection_id uuid not null,
  -- The member who started it (kind and ID); the import runs with their access.
  caller jsonb not null,
  status text not null default 'reading' check (status in ('reading', 'matching', 'previewed',
    'committing', 'finishing', 'completed', 'failed', 'cancelled')),
  bulk_operation_id text,
  -- The store's catalog as read, in R2 (JSON), and the CSV import made from it.
  file_key text,
  import_id uuid,
  -- Matches: by SKU, by barcode, new, skipped; finishing: mapped, pictures.
  counts jsonb not null default '{}'::jsonb,
  -- Shopify locations without a mapping when the run started; their quantities are not imported.
  unmapped_locations jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  version integer not null default 1,
  primary key (shop_id, id),
  foreign key (shop_id, connection_id) references shopify_connections (shop_id, id),
  foreign key (shop_id, import_id) references import_jobs (shop_id, id)
);

-- One run at a time per connection.
create unique index shopify_onboardings_open_idx on shopify_onboardings (shop_id, connection_id)
  where status in ('reading', 'matching', 'previewed', 'committing', 'finishing');

-- One row per Shopify variant of the run: how it matched, and the import row that carries it.
create table shopify_onboarding_rows (
  shop_id uuid not null,
  onboarding_id uuid not null,
  shopify_variant_id text not null check (shopify_variant_id ~ '^[0-9]+$'),
  shopify_product_id text not null,
  shopify_inventory_item_id text,
  sku text,
  barcode text,
  title text not null,
  match text not null check (match in ('sku', 'barcode', 'new', 'skipped')),
  -- The existing variant a match found; set for new ones once the import created them.
  variant_id uuid,
  -- A barcode match on one of the variant's packs: the Shopify variant sells that pack.
  pack_id uuid,
  -- The SKU written to the import (the existing variant's SKU for a barcode match).
  import_sku text,
  import_row integer,
  -- Pictures to reference once the import created the record: the product's on its first new
  -- variant, a variant's own picture on that variant.
  pictures jsonb not null default '[]'::jsonb,
  tracked boolean not null default true,
  note text,
  mapped boolean not null default false,
  primary key (shop_id, onboarding_id, shopify_variant_id),
  foreign key (shop_id, onboarding_id) references shopify_onboardings (shop_id, id)
);

alter table shopify_catalog_variants enable row level security;
alter table shopify_onboardings enable row level security;
alter table shopify_onboarding_rows enable row level security;
create policy tenant_isolation on shopify_catalog_variants using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on shopify_onboardings using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on shopify_onboarding_rows using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
grant select, insert, update, delete on shopify_catalog_variants to airstock_app;
grant select, insert, update on shopify_onboardings, shopify_onboarding_rows to airstock_app;

-- Onboardings whose job stopped (a lost message, a crash), for the sweep to resume.
create function stale_shopify_onboardings(p_limit integer)
  returns table (shop_id uuid, id uuid)
  language sql stable security definer set search_path = public, pg_temp
as $$
  select o.shop_id, o.id from shopify_onboardings o
  where o.status in ('reading', 'matching', 'committing', 'finishing')
    and o.updated_at <= now() - interval '5 minutes'
  order by o.updated_at limit least(p_limit, 100)
$$;
revoke execute on function stale_shopify_onboardings(integer) from public;
grant execute on function stale_shopify_onboardings(integer) to airstock_app;

-- Pictures referenced by their Shopify URL (D17) ------------------------------------------------

-- An uploaded picture still needs its upload intent; a Shopify picture has none, no R2 objects,
-- and is shown from Shopify's CDN. `sha256` is then the hash of the URL, so the same picture is
-- referenced once.
alter table media_assets drop constraint media_assets_shop_id_id_fkey;
alter table media_assets
  add column external_url text check (external_url ~ '^https://cdn\.shopify\.com/' and length(external_url) <= 2000),
  alter column size_bytes drop not null,
  add constraint media_assets_size_known check (external_url is not null or size_bytes is not null);
alter table media_assets
  add column upload_media_id uuid generated always as (case when external_url is null then id end) stored,
  add constraint media_assets_upload_fk foreign key (shop_id, upload_media_id)
    references media_upload_intents (shop_id, media_id);
create unique index media_assets_external_idx on media_assets (shop_id, sha256)
  where external_url is not null;
