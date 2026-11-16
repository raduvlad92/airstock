import type { AuditEvent } from '../audit.ts';
import { compare } from '../catalog/decimal.ts';
import type { HandlerContext } from '../registry.ts';
import {
  allocate,
  choosePositions,
  expireClaimsAt,
  loadRuleScopes,
  type Pick,
  sumQuantities,
} from './engine.ts';

export interface ShortageFill {
  reservationId: string;
  parentReservationId: string | null;
  quantity: string;
  allocations: Array<{ allocationId: string; positionId: string; quantity: string }>;
}

/**
 * Fills open shortages of a variant from stock that just arrived at the given (already locked)
 * positions, oldest reservation first, in the same transaction (D6). A reservation takes only
 * positions its own limits allow: its location, its lot, and its channel's allocation rule.
 * Expired claims at the positions are released first, so the new allocations always fit.
 */
export async function fillShortages(
  ctx: HandlerContext,
  variantId: string,
  positionIds: string[],
): Promise<{ fills: ShortageFill[]; events: AuditEvent[] }> {
  if (positionIds.length === 0) return { fills: [], events: [] };
  const [settings] = await ctx.tx.query<{ fill: boolean }>(
    'select fill_shortages_on_receipt as fill from shops where id = app_shop_id()',
  );
  if (!settings?.fill) return { fills: [], events: [] };
  const open = await ctx.tx.query<{ id: string; parent_id: string | null }>(
    `select id, parent_id from reservations
     where variant_id = $1 and shortage_quantity > 0 and status in ('active', 'partially_fulfilled')
       and (expires_at is null or expires_at > now())
     order by id`,
    [variantId],
  );
  if (open.length === 0) return { fills: [], events: [] };
  const parents = open.map((o) => o.parent_id).filter((p): p is string => p !== null);
  // Positions are locked; now the expired claims there and these reservations, in id order.
  const events = await expireClaimsAt(ctx, positionIds, [...open.map((o) => o.id), ...parents]);
  const locked = await ctx.tx.query<{
    id: string;
    parent_id: string | null;
    shortage: string;
    location_id: string | null;
    lot_id: string | null;
    channel: string;
  }>(
    `select id, parent_id, shortage_quantity::text as shortage, location_id, lot_id, channel
     from reservations where id = any($1::uuid[]) and shortage_quantity > 0
       and status in ('active', 'partially_fulfilled')
     order by id`,
    [open.map((o) => o.id)],
  );
  const rules = new Map<string, string[] | null>();
  const fills: ShortageFill[] = [];
  for (const r of locked) {
    if (!rules.has(r.channel)) rules.set(r.channel, await loadRuleScopes(ctx.tx, r.channel));
    const allowed = await ctx.tx.query<{ id: string }>(
      `select p.id from inventory_positions p
       join locations l on l.shop_id = p.shop_id and l.id = p.location_id
       where p.id = any($1::uuid[])
         and ($2::uuid is null or l.path_ids @> array[$2::uuid])
         and ($3::uuid is null or p.lot_id = $3)
         and ($4::uuid[] is null or l.path_ids && $4::uuid[])`,
      [positionIds, r.location_id, r.lot_id, rules.get(r.channel) ?? null],
    );
    if (allowed.length === 0) continue;
    const { picks } = await choosePositions(
      ctx.tx,
      [{ variantId, quantity: r.shortage }],
      allowed.map((a) => a.id),
      rules.get(r.channel) ?? null,
    );
    const taken = sumQuantities(picks.map((p: Pick) => p.quantity));
    if (compare(taken, '0') <= 0) continue;
    const made = await allocate(ctx, new Map([[variantId, r.id]]), picks);
    await ctx.tx.query(
      `update reservations set shortage_quantity = shortage_quantity - $2::numeric,
         updated_at = now(), version = version + 1
       where id = $1`,
      [r.id, taken],
    );
    fills.push({
      reservationId: r.id,
      parentReservationId: r.parent_id,
      quantity: taken,
      allocations: made.map((m) => ({
        allocationId: m.allocationId,
        positionId: m.positionId,
        quantity: m.quantity,
      })),
    });
  }
  return { fills, events };
}
