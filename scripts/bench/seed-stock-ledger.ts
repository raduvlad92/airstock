/**
 * A few weeks of stock history in the ledger for the persona shops (milestone I5 reports): receipts
 * and fulfillments with their operations, entries, balances, owned quantities, and cost-history
 * rows, so movements, cost of goods, and value at a past date have something to read.
 *
 *   DATABASE_OWNER_URL=postgres://…owner…/db tsx scripts/bench/seed-stock-ledger.ts \
 *     [--days 21] [--per-day 300] [--rules 0.05] [--names 'Bench %']
 *
 * Run it on a throwaway branch of `i0-personas` after the migrations, never on staging. It writes
 * as the database owner, set-based, one transaction per shop:
 *
 * - the opening stock moves to before the history (the seed wrote it at seed time), and each
 *   variant's moving average is set from its opening receipts' unit costs, with the cost-history
 *   row migration 0017 added for it;
 * - each day, `--per-day` operations on random sellable positions with stock: about a third
 *   receipts (6 to 48 units at the variant's average, which therefore stays put) and two thirds
 *   fulfillments of 1 to 3 units at the average. No position ever goes below zero;
 * - reorder rules for a share of the variants (`--rules`), about half of them low;
 * - balances, owned quantities, and cost-history rows (running owned quantity, average) to
 *   match, so `stock_reconciliation_problems()` stays empty.
 */
import { parseArgs } from 'node:util';
import pg from 'pg';

const { values: args } = parseArgs({
  options: {
    days: { type: 'string', default: '21' },
    'per-day': { type: 'string', default: '300' },
    rules: { type: 'string', default: '0.05' },
    names: { type: 'string', default: 'Bench %' },
  },
});
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('Set DATABASE_OWNER_URL (the owner role).');
const days = Number(args.days);
const perDay = Number(args['per-day']);

const client = new pg.Client({ connectionString: url });
await client.connect();
const shops = (
  await client.query<{ id: string; name: string }>(
    'select id, name from shops where name like $1 order by name',
    [args.names],
  )
).rows;
const start = new Date(Date.now() - days * 86_400_000);
start.setUTCHours(0, 0, 0, 0);
const opening = new Date(start.getTime() - 7 * 86_400_000);

for (const shop of shops) {
  const t0 = Date.now();
  await client.query('begin');
  await client.query(`select set_config('app.shop_id', $1, true)`, [shop.id]);
  await client.query('select setseed(0.42)');
  // The opening stock, before the history.
  await client.query(`update inventory_operations set occurred_at = $2 where shop_id = $1`, [
    shop.id,
    opening,
  ]);
  await client.query(`update inventory_entries set created_at = $2 where shop_id = $1`, [
    shop.id,
    opening,
  ]);
  await client.query(
    `update variant_costs c set average_cost = x.average, version = c.version + 1
     from (select variant_id,
             round_half_even(sum(delta * unit_cost) / sum(delta), 6) as average
           from inventory_entries
           where shop_id = $1 and delta > 0 and unit_cost is not null
           group by variant_id) x
     where c.shop_id = $1 and c.variant_id = x.variant_id and c.average_cost is null`,
    [shop.id],
  );
  await client.query(
    `update variant_cost_history h set average_after = c.average_cost, occurred_at = $2
     from variant_costs c
     where h.shop_id = $1 and h.kind = 'opening' and c.shop_id = h.shop_id
       and c.variant_id = h.variant_id`,
    [shop.id, opening],
  );
  // Candidate positions and the day's operations.
  await client.query(
    `create temp table cand on commit drop as
     select row_number() over () as rn, p.id as position_id, p.variant_id, p.location_id,
       p.on_hand, c.average_cost
     from inventory_positions p
     join locations l on l.shop_id = p.shop_id and l.id = p.location_id and l.kind = 'storage'
     join variant_costs c on c.shop_id = p.shop_id and c.variant_id = p.variant_id
     join variants v on v.shop_id = p.shop_id and v.id = p.variant_id
     where p.shop_id = $1 and p.on_hand >= 4 and p.condition = 'sellable'
       and p.lot_id is null and p.serial_id is null and v.tracking_mode = 'none'
       and not v.one_of_a_kind
     order by random() limit 4000`,
    [shop.id],
  );
  const [{ n }] = (await client.query<{ n: number }>('select count(*)::int as n from cand'))
    .rows as [{ n: number }];
  if (n === 0) {
    await client.query('rollback');
    console.log(`${shop.name}: no candidate positions`);
    continue;
  }
  await client.query(
    `create temp table ev on commit drop as
     with picks as (
       select d, k, 1 + floor(random() * $3)::int as rn, random() as r1, random() as r2,
         random() as r3
       from generate_series(0, $1 - 1) d cross join generate_series(1, $2) k)
     select gen_random_uuid() as op_id, gen_random_uuid() as entry_id, gen_random_uuid() as hist_id,
       c.position_id, c.variant_id, c.location_id, c.on_hand, c.average_cost,
       $4::timestamptz + make_interval(days => p.d, secs => 28800 + floor(p.r2 * 36000)::int) as ts,
       case when p.r1 < 0.35 then 'receipt' else 'fulfillment' end as kind,
       case when p.r1 < 0.35 then 6 + floor(p.r3 * 43) else -(1 + floor(p.r3 * 3)) end as delta
     from picks p join cand c on c.rn = p.rn`,
    [days, perDay, n, start],
  );
  // No position goes below zero at any moment: drop the fulfillments that would take it there.
  // Dropping one only raises the running totals after it.
  await client.query(
    `delete from ev e using (
       select op_id, on_hand + sum(delta) over (partition by position_id order by ts, op_id)
         as running
       from ev) r
     where e.op_id = r.op_id and r.running < 0 and e.kind = 'fulfillment'`,
  );
  await client.query(
    `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, reason,
       occurred_at)
     select $1, op_id, kind, case when kind = 'fulfillment' then 'connector' else 'user' end,
       'bench', case when kind = 'fulfillment' then 'shopify' else 'dashboard' end,
       case when kind = 'receipt' then 'bench delivery' end, ts
     from ev`,
    [shop.id],
  );
  await client.query(
    `insert into inventory_entries (shop_id, id, operation_id, position_id, variant_id, location_id,
       delta, unit_cost, cost_basis, created_at)
     select $1, entry_id, op_id, position_id, variant_id, location_id, delta, average_cost,
       case when average_cost is null then 'none' when kind = 'receipt' then 'entered'
         else 'average' end, ts
     from ev`,
    [shop.id],
  );
  await client.query(
    `update inventory_positions p set on_hand = p.on_hand + x.net, updated_at = now(),
       version = p.version + 1
     from (select position_id, sum(delta) as net from ev group by position_id) x
     where p.shop_id = $1 and p.id = x.position_id`,
    [shop.id],
  );
  await client.query(
    `insert into variant_cost_history (shop_id, id, variant_id, operation_id, occurred_at, kind,
       quantity_delta, unit_cost, quantity_after, average_after)
     select $1, e.hist_id, e.variant_id, e.op_id, e.ts, e.kind, e.delta, e.average_cost,
       c.quantity + sum(e.delta) over (partition by e.variant_id order by e.ts, e.hist_id),
       e.average_cost
     from ev e join variant_costs c on c.shop_id = $1 and c.variant_id = e.variant_id`,
    [shop.id],
  );
  await client.query(
    `update variant_costs c set quantity = c.quantity + x.net, version = c.version + 1
     from (select variant_id, sum(delta) as net from ev group by variant_id) x
     where c.shop_id = $1 and c.variant_id = x.variant_id`,
    [shop.id],
  );
  // Reorder rules: half of them at a point above what is available, so they are low.
  await client.query(
    `insert into reorder_rules (shop_id, id, variant_id, warehouse_id, reorder_point,
       reorder_quantity)
     select $1, gen_random_uuid(), x.variant_id, x.warehouse_id,
       case when random() < 0.5 then x.on_hand + 5 else greatest(x.on_hand - 5, 0) end, 24
     from (select distinct on (p.variant_id) p.variant_id, l.warehouse_id, sum(p.on_hand)
             over (partition by p.variant_id, l.warehouse_id) as on_hand
           from inventory_positions p
           join locations l on l.shop_id = p.shop_id and l.id = p.location_id and l.kind = 'storage'
           where p.shop_id = $1 and p.on_hand > 0
           order by p.variant_id, random()) x
     where random() < $2`,
    [shop.id, Number(args.rules)],
  );
  const problems = (
    await client.query<{ n: number }>(
      'select count(*)::int as n from stock_reconciliation_problems()',
    )
  ).rows[0]!.n;
  const counts = (
    await client.query<{ ops: number; rules: number }>(
      `select (select count(*)::int from ev) as ops,
         (select count(*)::int from reorder_rules where shop_id = $1) as rules`,
      [shop.id],
    )
  ).rows[0]!;
  await client.query('commit');
  console.log(
    `${shop.name}: ${counts.ops} operations over ${days} days, ${counts.rules} rules, ${problems} reconciliation problems, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
}
await client.end();
