-- Phase 1, milestone N4: pictures and attachments (plan Section 5.8, ADR 0015).
--
-- Binary files live in the private EU R2 bucket under shops/{shop_id}/media/{media_id}/ with the
-- keys original, thumbnail, and display. PostgreSQL keeps what they are and where they are used.
-- A file upload and a database transaction cannot commit together, so an upload goes through an
-- intent: the bytes reach R2 first, then finalize creates the media record and its links in one
-- transaction. An intent that is never finalized is swept and its objects deleted, so a failed
-- upload never leaves an attachment (PRD 4.5).

create table media_upload_intents (
  shop_id uuid not null references shops (id),
  id uuid not null,
  -- The media record finalize creates; the object keys use it from the start.
  media_id uuid not null,
  kind text not null check (kind in ('image', 'document')),
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp',
    'image/avif', 'image/gif', 'application/pdf')),
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  -- Uploaded parts by name (original, thumbnail, display): size, hash, type, and pixel size.
  parts jsonb not null default '{}'::jsonb check (jsonb_typeof(parts) = 'object'),
  status text not null default 'pending'
    check (status in ('pending', 'finalized', 'failed', 'expired')),
  failure_code text,
  -- The caller that declared the upload (kind:id); only it may upload and finalize.
  created_by text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  -- Set once the objects of a failed or expired upload are deleted from R2.
  cleaned_at timestamptz,
  primary key (shop_id, id),
  unique (shop_id, media_id)
);

create index media_upload_intents_pending_idx on media_upload_intents (expires_at)
  where status = 'pending';
create index media_upload_intents_cleanup_idx on media_upload_intents (shop_id)
  where status in ('failed', 'expired') and cleaned_at is null;

create table media_assets (
  shop_id uuid not null references shops (id),
  id uuid not null,
  kind text not null check (kind in ('image', 'document')),
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  -- Pixel size of an image original, when its header could be read.
  width integer check (width > 0),
  height integer check (height > 0),
  -- Thumbnail and display image made by the browser: type, size, and pixel size (D6).
  derivatives jsonb not null default '{}'::jsonb check (jsonb_typeof(derivatives) = 'object'),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (shop_id, id),
  foreign key (shop_id, id) references media_upload_intents (shop_id, media_id)
);

-- A link names its variant together with the variant's product, so a link can never point at
-- another product's variant.
alter table variants add constraint variants_product_key unique (shop_id, product_id, id);

create table media_links (
  shop_id uuid not null,
  id uuid not null,
  media_id uuid not null,
  product_id uuid not null,
  -- Null: the product itself, whose pictures every variant inherits (ADR 0012).
  variant_id uuid,
  -- Merchant-defined, as a slug; the starter roles are suggestions (PRD 4.5).
  role text not null check (role ~ '^[a-z][a-z0-9_]{0,49}$'),
  position integer not null,
  is_primary boolean not null default false,
  alt_text text check (length(alt_text) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, id),
  unique nulls not distinct (shop_id, media_id, product_id, variant_id),
  foreign key (shop_id, media_id) references media_assets (shop_id, id),
  foreign key (shop_id, product_id) references products (shop_id, id),
  foreign key (shop_id, product_id, variant_id) references variants (shop_id, product_id, id)
);

create index media_links_scope_idx on media_links (shop_id, product_id, variant_id, position);
create index media_links_media_idx on media_links (shop_id, media_id);
create index media_links_variant_idx on media_links (shop_id, variant_id) where variant_id is not null;
-- One primary picture per scope: the product, or one variant.
create unique index media_links_primary_idx
  on media_links (shop_id, product_id, coalesce(variant_id, product_id)) where is_primary;

alter table media_upload_intents enable row level security;
alter table media_assets enable row level security;
alter table media_links enable row level security;

create policy tenant_isolation on media_upload_intents using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on media_assets using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());
create policy tenant_isolation on media_links using (shop_id = app_shop_id()) with check (shop_id = app_shop_id());

grant select, insert, update on media_upload_intents, media_assets to airstock_app;
-- Links are removed when a picture is taken off a product or variant; the removal is audited.
grant select, insert, update, delete on media_links to airstock_app;

-- The sweep finds shops with uploads to expire or clean up, then works inside each shop, where
-- row-level security applies, as it does for reservations and connection grants.
create function shops_with_stale_media_uploads(p_limit integer) returns setof uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select distinct i.shop_id
  from media_upload_intents i
  where (i.status = 'pending' and i.expires_at <= now())
     or (i.status in ('failed', 'expired') and i.cleaned_at is null)
  limit least(p_limit, 500)
$$;

revoke execute on function shops_with_stale_media_uploads(integer) from public;
grant execute on function shops_with_stale_media_uploads(integer) to airstock_app;
