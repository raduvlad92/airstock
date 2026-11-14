-- Cluster-level roles. Run once per environment as the database owner (the role that runs
-- migrations and owns every table). The runtime connects as airstock_app; set its password
-- separately (Neon console or ALTER ROLE) and never commit it.
do $$
begin
  if not exists (select from pg_roles where rolname = 'airstock_app') then
    create role airstock_app login nobypassrls;
  end if;
end
$$;
