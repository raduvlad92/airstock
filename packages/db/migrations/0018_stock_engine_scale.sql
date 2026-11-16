-- Milestone I1, follow-up to 0017: costs come back at their stored scale (ADR 0003: "5.000000"),
-- not with the extra digits of a division.

create or replace function round_half_even(p_value numeric, p_scale integer) returns numeric
  language sql immutable strict
  as $$
    select round((case when abs(x - trunc(x)) = 0.5 and mod(trunc(x), 2) = 0 then trunc(x)
        else round(x) end) / power(10::numeric, p_scale), p_scale)
    from (select p_value * power(10::numeric, p_scale) as x) s
  $$;

create or replace function apply_stock_cost(p_history_id uuid, p_variant_id uuid, p_operation_id uuid,
  p_kind text, p_delta numeric, p_unit_cost numeric)
returns table (unit_cost numeric, cost_basis text, average_after numeric, quantity_after numeric)
language plpgsql
as $$
declare
  c variant_costs;
  applied numeric;
  basis text;
  new_average numeric;
begin
  insert into variant_costs (shop_id, variant_id) values (app_shop_id(), p_variant_id)
    on conflict do nothing;
  select * into c from variant_costs where shop_id = app_shop_id() and variant_id = p_variant_id
    for update;
  new_average := c.average_cost;
  if p_delta > 0 then
    if p_unit_cost is not null then
      applied := p_unit_cost; basis := 'entered';
    elsif c.quantity = 0 and c.default_cost is not null then
      applied := c.default_cost; basis := 'default';
    elsif c.average_cost is not null then
      applied := c.average_cost; basis := 'average';
    else
      applied := null; basis := 'none';
    end if;
    if basis in ('entered', 'default') then
      new_average := case when c.average_cost is null or c.quantity = 0 then applied
        else round_half_even((c.quantity * c.average_cost + p_delta * applied) / (c.quantity + p_delta), 6)
      end;
    end if;
  else
    applied := c.average_cost;
    basis := case when c.average_cost is null then 'none' else 'average' end;
  end if;
  update variant_costs set quantity = c.quantity + p_delta, average_cost = new_average,
    version = c.version + 1, updated_at = now()
  where shop_id = app_shop_id() and variant_id = p_variant_id;
  -- The time the row lock was held, not the transaction start: concurrent changes to one variant
  -- are ordered as they were applied, so "the latest row before a date" is the right one.
  insert into variant_cost_history (shop_id, id, variant_id, operation_id, occurred_at, kind,
    quantity_delta, unit_cost, quantity_after, average_after)
  values (app_shop_id(), p_history_id, p_variant_id, p_operation_id, clock_timestamp(), p_kind,
    p_delta, applied, c.quantity + p_delta, new_average);
  return query select applied::numeric(20, 6), basis, new_average::numeric(20, 6),
    (c.quantity + p_delta)::numeric(20, 6);
end
$$;
