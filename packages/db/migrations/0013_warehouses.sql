-- Phase 1, milestone N6: warehouse records, commercial terms, and the location hierarchy rules
-- (ADR 0017).
--
-- `contract` holds commercial terms: dates, fee description, rates, notes, and attachment IDs.
-- Only members with storage.commercial.read see or change it. Row-level security already limits
-- rows to the shop; permissions inside a shop are the registry's job, so the operations leave the
-- column out of every response, and activity reads hide its changes, for everyone else.

alter table warehouses
  -- {"line1", "line2", "city", "region", "postalCode", "country"}; country is ISO 3166-1 alpha-2.
  add column address jsonb check (address is null or jsonb_typeof(address) = 'object'),
  -- {"name", "email", "phone"}
  add column contact jsonb check (contact is null or jsonb_typeof(contact) = 'object'),
  -- [{"provider": "shipbob", "externalId": "123"}]: the site's IDs in other systems.
  add column provider_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(provider_refs) = 'array'),
  -- A record of how the site is running. It does not change stock rules; fulfillment_eligible does.
  add column operating_status text not null default 'operating'
    check (operating_status in ('operating', 'paused')),
  add column fulfillment_eligible boolean not null default true,
  add column contract jsonb check (contract is null or jsonb_typeof(contract) = 'object'),
  add column updated_at timestamptz not null default now(),
  add column archived_at timestamptz;

alter table locations
  add column updated_at timestamptz not null default now(),
  add column archived_at timestamptz,
  -- The warehouse or location whose archive also archived this location. Restoring that record
  -- restores this one; a location archived on its own has null here and stays archived.
  add column archived_via uuid;

create index locations_warehouse_idx on locations (shop_id, warehouse_id);

-- A location takes part in fulfillment when it, every location above it, and its warehouse are
-- eligible. path_ids starts with the warehouse ID, then the ancestors, then the location itself.
create function location_fulfillment_eligible(p_shop_id uuid, p_path_ids uuid[]) returns boolean
  language sql stable
  as $$
    select not exists (
        select 1 from locations a
        where a.shop_id = p_shop_id and a.id = any(p_path_ids) and not a.fulfillment_eligible)
      and not exists (
        select 1 from warehouses w
        where w.shop_id = p_shop_id and w.id = p_path_ids[1] and not w.fulfillment_eligible)
  $$;

grant execute on function location_fulfillment_eligible(uuid, uuid[]) to airstock_app;
