import { z } from 'zod';
import { errors } from '../errors.ts';
import { defineOperation } from '../registry.ts';
import { Id, iso, Timestamp } from '../schemas.ts';

// Valuation (plan Section 5.10, D7): value at any date from the cost history, and cost of goods
// from the fulfillment entries, which each store the unit cost they applied.

export const getValuation = defineOperation({
  id: 'inventory.valuation.get',
  summary: 'Value stock at a date and cost of goods for a period',
  description:
    'Use this for "what is my stock worth" and cost of goods questions. Value is owned units times the moving average cost, for one variant or the whole shop, now or at any past moment (reproducible later). Cost of goods sums fulfillments between from and to at the cost each one recorded. Needs costs.read; not available to members limited to some locations.',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    variantId: Id.optional(),
    at: Timestamp.optional().describe('Value at this moment; now when left out.'),
    from: Timestamp.optional().describe('Start of the cost-of-goods period (inclusive).'),
    to: Timestamp.optional().describe(
      'End of the cost-of-goods period (exclusive); now by default.',
    ),
  }),
  output: z.object({
    at: z.string(),
    currency: z.string(),
    value: z.string().describe('Exact; round to cents only for display.'),
    quantity: z.string(),
    unknownCostVariants: z
      .number()
      .describe('Variants with stock but no cost yet; they are left out of the value.'),
    variants: z
      .array(
        z.object({
          variantId: Id,
          sku: z.string(),
          quantity: z.string(),
          averageCost: z.string().nullable(),
          value: z.string().nullable(),
        }),
      )
      .describe('Per variant, the 200 most valuable (or the one asked for).'),
    costOfGoods: z
      .object({ from: z.string(), to: z.string(), quantity: z.string(), value: z.string() })
      .nullable(),
  }),
  permission: 'costs.read',
  connectionScope: 'inventory:read',
  audit: { action: 'inventory.valuation.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/valuation' },
  mcp: { tool: 'get_stock', action: 'valuation', readOnly: true, destructive: false },
  async handler(ctx, input) {
    if (ctx.locationScope !== null) {
      throw errors.forbidden(
        'Valuation covers the whole shop; your access is limited to locations.',
      );
    }
    const at = input.at ? new Date(input.at) : new Date();
    for (const [key, value] of [
      ['at', input.at],
      ['from', input.from],
      ['to', input.to],
    ] as const) {
      if (value !== undefined && Number.isNaN(Date.parse(value))) {
        throw errors.validation([{ path: key, message: 'Use an ISO 8601 timestamp.' }]);
      }
    }
    if (input.variantId) {
      const [variant] = await ctx.tx.query('select 1 from variants where id = $1', [
        input.variantId,
      ]);
      if (!variant) throw errors.notFound('Variant');
    }
    const [row] = await ctx.tx.query<{
      currency: string;
      value: string;
      quantity: string;
      unknown: number;
      variants: Array<{
        variantId: string;
        sku: string;
        quantity: string;
        averageCost: string | null;
        value: string | null;
      }>;
    }>(
      `with latest as (
         select distinct on (h.variant_id) h.variant_id, h.quantity_after, h.average_after
         from variant_cost_history h
         where h.occurred_at <= $1::timestamptz and ($2::uuid is null or h.variant_id = $2)
         order by h.variant_id, h.occurred_at desc, h.id desc),
       valued as (
         select l.variant_id, v.sku, l.quantity_after as quantity, l.average_after,
           round_half_even(l.quantity_after * l.average_after, 6) as value
         from latest l join variants v on v.shop_id = app_shop_id() and v.id = l.variant_id
         where l.quantity_after > 0 or $2::uuid is not null)
       select (select currency from shops where id = app_shop_id()) as currency,
         coalesce((select sum(value) from valued), 0)::text as value,
         coalesce((select sum(quantity) from valued), 0)::text as quantity,
         (select count(*)::int from valued where value is null and quantity > 0) as unknown,
         coalesce((select json_agg(json_build_object('variantId', variant_id, 'sku', sku,
             'quantity', quantity::text, 'averageCost', average_after::text, 'value', value::text)
             order by value desc nulls last, sku)
           from (select * from valued order by value desc nulls last, sku limit 200) x), '[]'::json)
           as variants`,
      [at.toISOString(), input.variantId ?? null],
    );
    if (!row) throw errors.internal();
    let costOfGoods = null;
    if (input.from) {
      const to = input.to ? new Date(input.to) : new Date();
      const [cog] = await ctx.tx.query<{ quantity: string; value: string }>(
        `select coalesce(-sum(e.delta), 0)::text as quantity,
           coalesce(round_half_even(-sum(e.delta * coalesce(e.unit_cost, 0)), 6), 0)::text as value
         from inventory_entries e
         join inventory_operations o on o.shop_id = e.shop_id and o.id = e.operation_id
         where o.kind = 'fulfillment' and o.occurred_at >= $1::timestamptz
           and o.occurred_at < $2::timestamptz and ($3::uuid is null or e.variant_id = $3)`,
        [new Date(input.from).toISOString(), to.toISOString(), input.variantId ?? null],
      );
      costOfGoods = {
        from: iso(input.from)!,
        to: to.toISOString(),
        quantity: cog?.quantity ?? '0',
        value: cog?.value ?? '0',
      };
    }
    return {
      result: {
        at: at.toISOString(),
        currency: row.currency,
        value: row.value,
        quantity: row.quantity,
        unknownCostVariants: row.unknown,
        variants: row.variants,
        costOfGoods,
      },
      audit: {
        targetType: input.variantId ? 'variant' : 'shop',
        targetId: input.variantId ?? ctx.shopId,
        context: { input },
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const inventoryValuationOperations = [getValuation] as const;
