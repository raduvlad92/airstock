-- Phase 2, milestone I7: idempotency records are kept for a retention window, then deleted by the
-- daily cron (ADR 0006, update for I7). Every command stores its whole response here, about 1.6 KB,
-- and nothing deleted them: at the I7 volume run's pace that is about 190 MB a quarter for six
-- shops. A replay after the window is treated as a new request.

-- The sweep finds old records by age across shops.
create index idempotency_records_created_idx on idempotency_records (created_at);

-- Deletes up to p_batch records created before the window, across shops, and returns how many.
-- The caller repeats it in short transactions, so the daily run never holds a long transaction
-- and Neon can scale to zero afterwards.
create function delete_old_idempotency_records(p_days integer, p_batch integer) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  deleted integer;
begin
  if p_days < 1 or p_batch < 1 then
    raise exception 'retention days and batch size must be positive';
  end if;
  delete from idempotency_records r
  using (
    select shop_id, caller_id, operation_id, key from idempotency_records
    where created_at < now() - make_interval(days => p_days)
    order by created_at
    limit p_batch) old
  where r.shop_id = old.shop_id and r.caller_id = old.caller_id
    and r.operation_id = old.operation_id and r.key = old.key;
  get diagnostics deleted = row_count;
  return deleted;
end
$$;

revoke execute on function delete_old_idempotency_records(integer, integer) from public;
grant execute on function delete_old_idempotency_records(integer, integer) to airstock_app;
