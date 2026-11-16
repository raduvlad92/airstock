import type { Tx } from '@airstock/db';
import { z } from 'zod';
import type { AuditEvent } from '../audit.ts';
import { compare, normalize } from '../catalog/decimal.ts';
import { AppError, errors } from '../errors.ts';
import type { AnyOperation, HandlerContext, HandlerResult } from '../registry.ts';
import { defineOperation } from '../registry.ts';
import { Id } from '../schemas.ts';
import {
  affectedLevels,
  SHOPIFY_PUSH_TOPIC,
  salesMaps,
  shopifyChannel,
} from '../shopify/targets.ts';
import { applyChanges } from '../stock/adjust.ts';
import { exactProduct, OPEN_STATUSES } from '../stock/engine.ts';
import type { WebhookEmit } from '../webhooks/events.ts';
import {
  fulfillReservation,
  reallocateReservation,
  releaseReservation,
  reserveStock,
} from './inventory-reservations.ts';
import { createReturn, receiveReturn } from './returns.ts';

// The Shopify order lifecycle (plan Section 5.14, PRD 8.5). Whatever brought an order (a webhook,
// the reconciler, the push's catch-up), its state in Shopify is applied in one transaction:
//
//   order created        reserve each mapped line by the connection's allocation rule; what is
//                        short is a shortage (D6), never a refusal
//   order edited         reserve more, or release the newest reservations first
//   order cancelled      release what is still open
//   fulfillment created  fulfill at the fulfilling location, reallocating there first
//   fulfillment cancelled reverse those fulfillments (a compensating receipt at the cost they left
//                        with) and reserve the line again
//   refund with restock  returned units start the return workflow: quarantine first, whatever
//   or return            Shopify's restock flag says
//
// Rows record what was applied, so the same state applied twice changes nothing. Each line also
// keeps Airstock's record of Shopify's available quantity in step: an order takes its units out of
// Shopify's available, an edit that removes units and a restocking refund put them back.

const Num = z.string().regex(/^[0-9]{1,20}$/);
const Time = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'A timestamp.');

export const ShopifyOrderState = z.object({
  orderId: Num,
  createdAt: Time,
  updatedAt: Time.nullable().optional(),
  cancelledAt: Time.nullable().optional(),
  lines: z
    .array(
      z.object({
        lineId: Num,
        variantId: Num.nullable(),
        quantity: z.number().int().min(0),
        currentQuantity: z.number().int().min(0).optional(),
        /** Where Shopify committed the units, when the order's fulfillment orders were read. */
        locationId: Num.nullable().optional(),
      }),
    )
    .max(500),
  /** Absent when only the orders/create payload is known. */
  fulfillments: z
    .array(
      z.object({
        fulfillmentId: Num,
        status: z.enum(['success', 'cancelled', 'error', 'failure', 'open', 'pending']),
        locationId: Num.nullable(),
        createdAt: Time,
        lines: z.array(z.object({ lineId: Num, quantity: z.number().int().min(0) })).max(500),
      }),
    )
    .max(100)
    .optional(),
  refunds: z
    .array(
      z.object({
        refundId: Num,
        createdAt: Time,
        lines: z
          .array(
            z.object({
              lineId: Num,
              quantity: z.number().int().min(0),
              restockType: z.enum(['cancel', 'return', 'no_restock', 'legacy_restock']),
              locationId: Num.nullable(),
            }),
          )
          .max(500),
      }),
    )
    .max(100)
    .optional(),
  /** Shopify returns: refunds issued through them, and what came back (dispositions). */
  returns: z
    .array(
      z.object({
        returnId: Num,
        refundIds: z.array(Num).max(100),
        dispositions: z
          .array(
            z.object({
              dispositionId: Num,
              lineId: Num,
              quantity: z.number().int().min(1),
              type: z.enum(['restocked', 'not_restocked', 'processing_required', 'missing']),
              locationId: Num.nullable(),
              createdAt: Time,
            }),
          )
          .max(500),
      }),
    )
    .max(50)
    .optional(),
});
export type ShopifyOrderState = z.infer<typeof ShopifyOrderState>;

const SyncResult = z.object({
  reserved: z.number().int(),
  shortage: z.number().int(),
  unmapped: z.number().int(),
  alreadyProcessed: z.number().int(),
  released: z.number().int(),
  fulfilled: z.number().int(),
  fulfillmentsReversed: z.number().int(),
  returns: z.array(Id),
  /** Lines Airstock refused to hold (an archived variant, say), with the refusal's code. */
  refused: z.array(z.object({ lineId: z.string(), code: z.string() })),
  skipped: z.enum(['before_connection']).nullable(),
});

export interface Acc {
  /** Levels whose record of Shopify's quantity changed: pushed after commit. */
  levels: Set<string>;
  /**
   * Shopify's own changes to its available, applied to the records at the end, in level order
   * (the order the push locks them in).
   */
  took: Array<{ item: string; location: string; items: number; at: string }>;
  outbox: Array<{ topic: string; payload: unknown }>;
  events: AuditEvent[];
  webhooks: WebhookEmit[];
  alertVariants: string[];
}

/**
 * Runs another command's handler inside this transaction, so the order's state and every stock
 * effect commit together. Its audit event is written with this command's, under the connector.
 */
export async function inner<O extends AnyOperation>(
  ctx: HandlerContext,
  acc: Acc,
  op: O,
  input: unknown,
): Promise<z.infer<O['output']>> {
  const parsed = op.input.parse(input);
  const out = (await op.handler(ctx, parsed)) as HandlerResult<z.infer<O['output']>>;
  acc.outbox.push(...(out.outbox ?? []));
  acc.webhooks.push(...(out.webhooks ?? []));
  acc.alertVariants.push(...(out.alertCheck?.variantIds ?? []));
  acc.events.push(
    ...(out.events ?? []),
    ctx.event({
      action: op.audit.action,
      outcome: out.audit.outcome ?? 'succeeded',
      target_type: out.audit.targetType,
      target_id: out.audit.targetId,
      operation_id: out.audit.operationId ?? null,
      location_ids: out.audit.locationIds ?? null,
      external_ref: out.audit.externalRef ?? null,
      reason: out.audit.reason ?? null,
      changes: out.audit.changes ?? null,
      context: out.audit.context ?? null,
    }),
  );
  return out.result;
}

interface LineRow {
  shopify_line_id: string;
  shopify_variant_id: string | null;
  quantity: number;
  outcome: string;
  shopify_location_id: string | null;
  variant_id: string | null;
  pack_id: string | null;
  bundle: boolean;
  per_item: string;
  open_items: number;
  fulfilled_items: number;
  effect_items: number | null;
  inventory_item_id: string | null;
}

interface ScopeMap {
  shopify_location_id: string;
  scope_id: string;
  location_id: string | null;
  receive_location_id: string | null;
}

const lineRef = (orderId: string, lineId: string) => `shopify:order/${orderId}/line/${lineId}`;

/** Base units (or bundles) for Shopify items of a line. */
function units(line: Pick<LineRow, 'bundle' | 'per_item'>, items: number): string {
  return line.bundle ? String(items) : normalize(exactProduct(String(items), line.per_item));
}

/**
 * Lowers Airstock's record of Shopify's available (raises it for a negative count), unless
 * Shopify's own read is newer. Applied at the end of the sync, in level order.
 */
async function shopifyTook(
  _tx: Tx,
  acc: Acc,
  _connectionId: string,
  item: string | null,
  shopifyLocationId: string | null,
  items: number,
  at: string,
): Promise<void> {
  if (!item || !shopifyLocationId || items === 0) return;
  // Shopify now shows a number Airstock's availability may not match (an oversold order, a
  // restock): the level is pushed after commit, from the corrected record.
  acc.levels.add(`${item}@${shopifyLocationId}`);
  acc.took.push({ item, location: shopifyLocationId, items, at });
}

async function applyTook(tx: Tx, acc: Acc, connectionId: string): Promise<void> {
  const sorted = [...acc.took].sort((a, b) =>
    a.item !== b.item ? (a.item < b.item ? -1 : 1) : a.location < b.location ? -1 : 1,
  );
  for (const t of sorted) {
    await tx.query(
      `update shopify_inventory_levels set expected_available = expected_available - $4,
         updated_at = now()
       where connection_id = $1 and shopify_inventory_item_id = $2 and shopify_location_id = $3
         and expected_available is not null and expected_as_of < $5::timestamptz`,
      [connectionId, t.item, t.location, t.items, t.at],
    );
  }
}

/**
 * The line's reservations with something open, oldest first. A reservation a person released or
 * fulfilled by hand holds less than the line recorded: only what it still holds is counted, so
 * a later cancellation or fulfillment never fails on it (those units are the person's call).
 */
async function lineReservations(
  tx: Tx,
  connectionId: string,
  line: Pick<LineRow, 'shopify_line_id' | 'bundle' | 'per_item'>,
) {
  const rows = await tx.query<{
    reservation_id: string;
    open_items: number;
    status: string;
    open_units: string;
  }>(
    `select x.reservation_id, x.open_items, r.status,
       (r.shortage_quantity + coalesce((select sum(a.outstanding) from reservation_allocations a
          where a.shop_id = r.shop_id and a.reservation_id = r.id), 0))::text as open_units
     from shopify_line_reservations x
     join reservations r on r.shop_id = x.shop_id and r.id = x.reservation_id
     where x.connection_id = $1 and x.shopify_line_id = $2 and x.open_items > 0
     order by x.created_at, x.reservation_id`,
    [connectionId, line.shopify_line_id],
  );
  return rows.flatMap((r) => {
    let open = (OPEN_STATUSES as readonly string[]).includes(r.status) ? r.open_items : 0;
    if (open > 0 && !line.bundle) {
      open = Math.min(open, Math.floor(Number(r.open_units) / Number(line.per_item) + 1e-9));
    }
    return open > 0 ? [{ reservation_id: r.reservation_id, open_items: open }] : [];
  });
}

/**
 * A refusal that belongs to the line, not to the order (an archived variant or bundle component,
 * say): recorded on the line, so the order's other lines still apply (A30). Anything else (a
 * conflict to retry, a server error) fails the order as before.
 */
function lineRefusal(error: unknown): string | null {
  if (!(error instanceof AppError)) return null;
  if (error.code === 'retry_conflict' || error.status >= 500) return null;
  return [404, 409, 422].includes(error.status) ? error.code : null;
}

async function setReservationOpen(tx: Tx, reservationId: string, openItems: number) {
  await tx.query('update shopify_line_reservations set open_items = $2 where reservation_id = $1', [
    reservationId,
    openItems,
  ]);
}

/** Releases Shopify items of a line, newest reservation first. */
async function releaseItems(
  ctx: HandlerContext,
  acc: Acc,
  connectionId: string,
  line: LineRow,
  items: number,
  reason: string,
  oldestFirst = false,
): Promise<number> {
  let left = items;
  const reservations = await lineReservations(ctx.tx, connectionId, line);
  if (!oldestFirst) reservations.reverse();
  for (const r of reservations) {
    if (left === 0) break;
    const take = Math.min(left, r.open_items);
    await inner(ctx, acc, releaseReservation, {
      reservationId: r.reservation_id,
      quantity: units(line, take),
      reason,
    });
    await setReservationOpen(ctx.tx, r.reservation_id, r.open_items - take);
    left -= take;
  }
  return items - left;
}

/**
 * Reserves more Shopify items for a line, as a new reservation of the connection's channel. A
 * refusal of the line itself (its variant archived here while Shopify still sells it) is
 * returned instead of thrown, with nothing written, so the rest of the order still applies.
 */
async function reserveItems(
  ctx: HandlerContext,
  acc: Acc,
  connectionId: string,
  orderId: string,
  line: LineRow,
  items: number,
): Promise<{ reservationId: string; short: boolean } | { refused: string }> {
  let made: z.infer<typeof reserveStock.output>;
  await ctx.tx.query('savepoint shopify_line');
  try {
    made = await inner(ctx, acc, reserveStock, {
      variantId: line.variant_id,
      quantity: units(line, items),
      purpose: 'external_order',
      externalRef: lineRef(orderId, line.shopify_line_id),
      channel: shopifyChannel(connectionId),
      allowShortage: true,
    });
  } catch (error) {
    const refused = lineRefusal(error);
    if (!refused) throw error;
    await ctx.tx.query('rollback to savepoint shopify_line');
    return { refused };
  }
  await ctx.tx.query('release savepoint shopify_line');
  await ctx.tx.query(
    `insert into shopify_line_reservations (shop_id, connection_id, shopify_line_id, reservation_id,
       open_items) values (app_shop_id(), $1, $2, $3, $4)`,
    [connectionId, line.shopify_line_id, made.reservationId, items],
  );
  const short = made.bundle
    ? made.bundle.components.some((c) => compare(c.shortage, '0') > 0)
    : compare(made.shortage, '0') > 0;
  return { reservationId: made.reservationId, short };
}

/**
 * Moves a reservation's open allocations into the scope (a warehouse, or a location and its
 * sub-locations) where Shopify fulfilled, as far as stock there allows. Returns the units of each
 * variant now allocated inside the scope.
 */
async function allocateInScope(
  ctx: HandlerContext,
  acc: Acc,
  rootId: string,
  scopeId: string,
  needs: Array<{ reservationId: string; variantId: string; units: string }>,
): Promise<Map<string, string>> {
  const covered = new Map<string, string>();
  for (const need of needs) {
    const allocations = await ctx.tx.query<{ id: string; outstanding: string; in_scope: boolean }>(
      `select a.id, a.outstanding::text, l.path_ids @> array[$2::uuid] as in_scope
       from reservation_allocations a
       join inventory_positions p on p.shop_id = a.shop_id and p.id = a.position_id
       join locations l on l.shop_id = p.shop_id and l.id = p.location_id
       where a.reservation_id = $1 and a.outstanding > 0 order by a.id`,
      [need.reservationId, scopeId],
    );
    let inScope = normalize(
      allocations
        .filter((a) => a.in_scope)
        .reduce((s, a) => s + Number(a.outstanding), 0)
        .toString(),
    );
    let missing = Number(need.units) - Number(inScope);
    if (missing > 0) {
      const candidates = await ctx.tx.query<{ position_id: string; available: string }>(
        `select position_id, available::text from stock_positions(array[$1::uuid])
         where $2::uuid = any(path_ids) and available > 0
         order by expires_on nulls last, received_at nulls last, location_path, position_id`,
        [need.variantId, scopeId],
      );
      for (const a of allocations.filter((x) => !x.in_scope)) {
        let fromHere = Number(a.outstanding);
        for (const c of candidates) {
          if (missing <= 0 || fromHere <= 0) break;
          const q = Math.min(missing, fromHere, Number(c.available));
          if (q <= 0) continue;
          await inner(ctx, acc, reallocateReservation, {
            reservationId: rootId,
            allocationId: a.id,
            quantity: normalize(String(q)),
            positionId: c.position_id,
            reason: 'Shopify fulfilled from another location',
          });
          c.available = String(Number(c.available) - q);
          fromHere -= q;
          missing -= q;
          inScope = normalize(String(Number(inScope) + q));
        }
      }
    }
    covered.set(need.variantId, inScope);
  }
  return covered;
}

/**
 * Fulfills Shopify items of a line where Shopify fulfilled them: oldest reservation first, its
 * allocations moved into the fulfilling scope first. What Airstock does not hold there (a
 * location not mapped, or no stock) is released and reported, since the units already left.
 */
async function fulfillItems(
  ctx: HandlerContext,
  acc: Acc,
  connectionId: string,
  line: LineRow,
  items: number,
  scope: ScopeMap | null,
  reference: string,
): Promise<{ fulfilled: number; released: number; operationIds: string[] }> {
  let left = items;
  let released = 0;
  const operationIds: string[] = [];
  for (const r of await lineReservations(ctx.tx, connectionId, line)) {
    if (left === 0) break;
    const take = Math.min(left, r.open_items);
    let doable = 0;
    if (scope) {
      const parts = line.bundle
        ? await ctx.tx.query<{ id: string; variant_id: string; per: string }>(
            `select id, variant_id, component_base_quantity::text as per from reservations
             where parent_id = $1 order by id`,
            [r.reservation_id],
          )
        : [{ id: r.reservation_id, variant_id: line.variant_id!, per: '1' }];
      const covered = await allocateInScope(
        ctx,
        acc,
        r.reservation_id,
        scope.scope_id,
        parts.map((p) => ({
          reservationId: p.id,
          variantId: p.variant_id,
          units: line.bundle ? normalize(exactProduct(String(take), p.per)) : units(line, take),
        })),
      );
      // Whole Shopify items covered in the scope.
      doable = Math.min(
        take,
        ...parts.map((p) =>
          Math.floor(
            Number(covered.get(p.variant_id) ?? '0') /
              (line.bundle ? Number(p.per) : Number(line.per_item)),
          ),
        ),
      );
    }
    if (doable > 0) {
      if (line.bundle) {
        const done = await inner(ctx, acc, fulfillReservation, {
          reservationId: r.reservation_id,
          quantity: String(doable),
          reference,
        });
        operationIds.push(done.operationId);
      } else {
        // Allocation by allocation inside the scope, so no unit leaves from elsewhere.
        let need = Number(units(line, doable));
        const inScope = await ctx.tx.query<{ id: string; outstanding: string }>(
          `select a.id, a.outstanding::text from reservation_allocations a
           join inventory_positions p on p.shop_id = a.shop_id and p.id = a.position_id
           join locations l on l.shop_id = p.shop_id and l.id = p.location_id
           where a.reservation_id = $1 and a.outstanding > 0 and l.path_ids @> array[$2::uuid]
           order by a.id`,
          [r.reservation_id, scope!.scope_id],
        );
        for (const a of inScope) {
          if (need <= 0) break;
          const q = Math.min(need, Number(a.outstanding));
          const done = await inner(ctx, acc, fulfillReservation, {
            reservationId: r.reservation_id,
            allocationId: a.id,
            quantity: normalize(String(q)),
            reference,
          });
          operationIds.push(done.operationId);
          need -= q;
        }
      }
    }
    if (take > doable) {
      await inner(ctx, acc, releaseReservation, {
        reservationId: r.reservation_id,
        quantity: units(line, take - doable),
        reason: scope
          ? 'Shopify fulfilled units Airstock does not hold at that location'
          : 'Shopify fulfilled from a location Airstock does not sync',
      });
      released += take - doable;
    }
    await setReservationOpen(ctx.tx, r.reservation_id, r.open_items - take);
    left -= take;
  }
  // Items Shopify fulfilled that Airstock never held for the line (already released, say).
  return { fulfilled: items - left - released, released: released + left, operationIds };
}

/**
 * Reverses fulfillment operations: the units go back to the positions they left, at the cost they
 * left with, as one reversal per operation (a compensating receipt), and a sold one-of-a-kind
 * item is in stock again.
 */
async function reverseFulfillments(
  ctx: HandlerContext,
  acc: Acc,
  operationIds: string[],
  reference: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const fulfillmentId of operationIds) {
    const [done] = await ctx.tx.query<{ id: string }>(
      'select id from inventory_operations where reverses_operation_id = $1',
      [fulfillmentId],
    );
    if (done) continue;
    const entries = await ctx.tx.query<{
      variant_id: string;
      location_id: string;
      condition: string;
      lot_id: string | null;
      serial_id: string | null;
      delta: string;
      unit_cost: string | null;
    }>(
      `select e.variant_id, e.location_id, p.condition, e.lot_id, e.serial_id, e.delta::text,
         e.unit_cost::text
       from inventory_entries e join inventory_positions p on p.shop_id = e.shop_id and p.id = e.position_id
       where e.operation_id = $1 order by e.variant_id, e.id`,
      [fulfillmentId],
    );
    for (const v of [...new Set(entries.map((e) => e.variant_id))].sort()) {
      await ctx.tx.query('select 1 from variants where id = $1 for key share', [v]);
    }
    const operationId = ctx.newId();
    await ctx.tx.query(
      `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source, attempt_id,
         external_ref, reason, reverses_operation_id)
       values (app_shop_id(), $1, 'reversal', $2, $3, $4, $5, $6, 'shopify_fulfillment_cancelled', $7)`,
      [
        operationId,
        ctx.caller.kind,
        ctx.caller.id,
        ctx.caller.source,
        ctx.attemptId,
        reference,
        fulfillmentId,
      ],
    );
    const changes = entries.map((e) => ({
      key: {
        variantId: e.variant_id,
        locationId: e.location_id,
        condition: e.condition,
        lotId: e.lot_id,
        serialId: e.serial_id,
        transferId: null,
      },
      delta: normalize(e.delta.replace(/^-/, '')),
      unitCost: e.unit_cost,
    }));
    const applied = await applyChanges(
      ctx,
      operationId,
      'reversal',
      changes.map((c) => c.key),
      async () => changes,
      [],
    );
    // A sold one-of-a-kind item is back in stock (D5).
    await ctx.tx.query(
      `update products p set status = 'active', updated_at = now(), version = p.version + 1
       where p.status = 'sold' and p.id in (select v.product_id from variants v
         where v.id = any($1::uuid[]) and v.one_of_a_kind)`,
      [[...new Set(entries.map((e) => e.variant_id))]],
    );
    const locationIds = [...new Set(entries.map((e) => e.location_id))];
    acc.events.push(
      ...applied.events,
      ctx.event({
        action: 'inventory.fulfillment.reversed',
        outcome: 'succeeded',
        target_type: 'inventory_operation',
        target_id: fulfillmentId,
        operation_id: operationId,
        location_ids: locationIds,
        external_ref: reference,
        reason: 'Shopify cancelled the fulfillment',
        changes: { reverses: fulfillmentId, changes: applied.changes },
      }),
    );
    for (const variantId of [...new Set(entries.map((e) => e.variant_id))]) {
      acc.outbox.push({
        topic: 'inventory.availability_changed',
        payload: {
          variantId,
          locationIds: [
            ...new Set(entries.filter((e) => e.variant_id === variantId).map((e) => e.location_id)),
          ],
        },
      });
    }
    out.push(operationId);
  }
  return out;
}

export const syncShopifyOrder = defineOperation({
  id: 'shopify.orders.sync',
  summary: 'Apply a Shopify order’s state to reservations and stock',
  kind: 'command',
  scope: 'shop',
  input: z.object({ connectionId: Id, order: ShopifyOrderState }),
  output: SyncResult,
  permission: 'integrations.sync',
  connectionScope: 'inventory:write',
  audit: { action: 'shopify.order.synced' },
  idempotency: 'none',
  http: { method: 'POST', path: '/shops/{shopId}/shopify/connections/{connectionId}/orders/sync' },
  mcp: { exception: 'Integration callback: runs only for Shopify orders the connector reads.' },
  async handler(ctx, input) {
    const { connectionId, order } = input;
    const result: z.infer<typeof SyncResult> = {
      reserved: 0,
      shortage: 0,
      unmapped: 0,
      alreadyProcessed: 0,
      released: 0,
      fulfilled: 0,
      fulfillmentsReversed: 0,
      returns: [],
      refused: [],
      skipped: null,
    };
    const acc: Acc = {
      levels: new Set(),
      took: [],
      outbox: [],
      events: [],
      webhooks: [],
      alertVariants: [],
    };
    const [connection] = await ctx.tx.query<{ status: string; created_at: Date }>(
      'select status, created_at from shopify_connections where id = $1 for key share',
      [connectionId],
    );
    if (!connection) throw errors.notFound('Shopify connection');
    if (connection.status !== 'active') {
      throw errors.conflict('shopify_not_connected', 'This Shopify store is not connected.');
    }
    const ref = `shopify:order/${order.orderId}`;
    // Orders from before the connection already left Shopify's available, which the onboarding
    // read; they stay Shopify's.
    if (Date.parse(order.createdAt) < new Date(connection.created_at).getTime()) {
      result.skipped = 'before_connection';
      return {
        result,
        audit: {
          targetType: 'shopify_order',
          targetId: order.orderId,
          externalRef: ref,
          outcome: 'no_change',
          reason: 'Placed before the store was connected.',
        },
      };
    }
    // The order row serializes syncs of one order; it is taken before any stock lock and only
    // by this command.
    await ctx.tx.query(
      `insert into shopify_orders (shop_id, connection_id, shopify_order_id, shopify_created_at,
         shopify_updated_at, cancelled_at)
       values (app_shop_id(), $1, $2, $3, $4, $5)
       on conflict (shop_id, connection_id, shopify_order_id) do update set
         shopify_updated_at = greatest(shopify_orders.shopify_updated_at, excluded.shopify_updated_at),
         cancelled_at = coalesce(excluded.cancelled_at, shopify_orders.cancelled_at),
         synced_at = now(), version = shopify_orders.version + 1`,
      [
        connectionId,
        order.orderId,
        order.createdAt,
        order.updatedAt ?? null,
        order.cancelledAt ?? null,
      ],
    );
    const [orderRow] = await ctx.tx.query<{ cancelled_at: Date | null }>(
      `select cancelled_at from shopify_orders where connection_id = $1 and shopify_order_id = $2`,
      [connectionId, order.orderId],
    );
    const cancelled = orderRow?.cancelled_at !== null && orderRow?.cancelled_at !== undefined;
    const scopes = await ctx.tx.query<ScopeMap>(
      `select shopify_location_id, scope_id, location_id, receive_location_id
       from shopify_location_maps where connection_id = $1 order by position`,
      [connectionId],
    );
    const scopeOf = (shopifyLocationId: string | null) =>
      scopes.find((s) => s.shopify_location_id === shopifyLocationId) ?? null;
    const onlyLocation = scopes.length === 1 ? scopes[0]!.shopify_location_id : null;
    const maps = await salesMaps(
      ctx.tx,
      connectionId,
      order.lines.flatMap((l) => (l.variantId ? [l.variantId] : [])),
    );
    const existing = new Map(
      (
        await ctx.tx.query<LineRow>(
          `select l.shopify_line_id, l.shopify_variant_id, l.quantity, l.outcome,
             l.shopify_location_id, l.variant_id, l.pack_id, l.bundle, l.per_item::text,
             l.open_items, l.fulfilled_items, l.effect_items, m.shopify_inventory_item_id as inventory_item_id
           from shopify_order_lines l
           left join shopify_variant_maps m on m.shop_id = l.shop_id and m.connection_id = l.connection_id
             and m.shopify_variant_id = l.shopify_variant_id
           where l.connection_id = $1 and l.shopify_line_id = any($2::text[])
           for update of l`,
          [connectionId, order.lines.map((l) => l.lineId)],
        )
      ).map((r) => [r.shopify_line_id, r]),
    );
    const lines: LineRow[] = [];

    // 1. Lines seen for the first time: reserve what is ordered.
    for (const l of [...order.lines].sort((a, b) => (a.lineId < b.lineId ? -1 : 1))) {
      const known = existing.get(l.lineId);
      if (known) {
        lines.push(known);
        if (known.outcome !== 'unmapped') result.alreadyProcessed++;
        continue;
      }
      const map = l.variantId ? maps.get(l.variantId) : undefined;
      const mapped = Boolean(map && scopes.length > 0 && l.quantity > 0);
      const row: LineRow = {
        shopify_line_id: l.lineId,
        shopify_variant_id: l.variantId,
        quantity: l.quantity,
        outcome: mapped ? 'reserved' : 'unmapped',
        shopify_location_id: l.locationId ?? onlyLocation,
        variant_id: mapped ? map!.variantId : null,
        pack_id: mapped ? map!.packId : null,
        bundle: mapped ? map!.bundle : false,
        per_item: mapped ? map!.perItem : '1',
        open_items: 0,
        fulfilled_items: 0,
        effect_items: mapped ? l.quantity : null,
        inventory_item_id: map?.inventoryItemId ?? null,
      };
      await ctx.tx.query(
        `insert into shopify_order_lines (shop_id, connection_id, shopify_order_id, shopify_line_id,
           shopify_variant_id, quantity, outcome, shopify_location_id, variant_id, pack_id, bundle,
           per_item, effect_items)
         values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          connectionId,
          order.orderId,
          l.lineId,
          l.variantId,
          l.quantity,
          row.outcome,
          row.shopify_location_id,
          row.variant_id,
          row.pack_id,
          row.bundle,
          row.per_item,
          row.effect_items,
        ],
      );
      if (!mapped) {
        result.unmapped++;
        lines.push(row);
        continue;
      }
      // Shopify took the ordered units out of its available when it accepted the order.
      await shopifyTook(
        ctx.tx,
        acc,
        connectionId,
        row.inventory_item_id,
        row.shopify_location_id,
        l.quantity,
        order.createdAt,
      );
      lines.push(row);
    }
    const byLine = new Map(lines.map((l) => [l.shopify_line_id, l]));
    const live = (l: LineRow) =>
      l.outcome !== 'unmapped' && l.outcome !== 'refused' && l.variant_id !== null;
    // A line Airstock refuses to hold (its variant archived here while Shopify still sells it):
    // recorded as such, never retried by later syncs, and the rest of the order applies.
    const refuse = (line: LineRow, code: string) => {
      line.outcome = 'refused';
      result.refused.push({ lineId: line.shopify_line_id, code });
    };

    // 2. Fulfillments: new ones fulfill, cancelled ones are reversed.
    if (order.fulfillments) {
      const recorded = new Map(
        (
          await ctx.tx.query<{
            shopify_fulfillment_id: string;
            status: string;
            lines: Array<{
              lineId: string;
              items: number;
              released: number;
              operationIds: string[];
            }>;
          }>(
            `select shopify_fulfillment_id, status, lines from shopify_fulfillments
             where connection_id = $1 and shopify_fulfillment_id = any($2::text[]) for update`,
            [connectionId, order.fulfillments.map((f) => f.fulfillmentId)],
          )
        ).map((r) => [r.shopify_fulfillment_id, r]),
      );
      const sorted = [...order.fulfillments].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      );
      for (const f of sorted) {
        const was = recorded.get(f.fulfillmentId);
        const reference = `shopify:fulfillment/${f.fulfillmentId}`;
        if (!was && f.status === 'success') {
          const scope = scopeOf(f.locationId);
          const done: Array<{
            lineId: string;
            items: number;
            released: number;
            operationIds: string[];
          }> = [];
          for (const fl of f.lines) {
            const line = byLine.get(fl.lineId);
            if (!line || !live(line) || fl.quantity === 0) continue;
            // Shopify shipped more than the line holds: its first sync already carries the
            // fulfillment (fulfillments/create came first, or the reconciler found the order).
            // The difference is reserved first, so the shipped units leave stock here.
            if (fl.quantity > line.open_items) {
              const made = await reserveItems(
                ctx,
                acc,
                connectionId,
                order.orderId,
                line,
                fl.quantity - line.open_items,
              );
              if ('refused' in made) {
                refuse(line, made.refused);
                continue;
              }
              if (made.short) {
                line.outcome = 'shortage';
                result.shortage++;
              } else result.reserved++;
              line.open_items = fl.quantity;
            }
            const outcome = await fulfillItems(
              ctx,
              acc,
              connectionId,
              line,
              fl.quantity,
              scope,
              reference,
            );
            line.open_items = Math.max(0, line.open_items - (outcome.fulfilled + outcome.released));
            line.fulfilled_items += fl.quantity;
            result.fulfilled += outcome.fulfilled;
            result.released += outcome.released;
            done.push({
              lineId: fl.lineId,
              items: fl.quantity,
              released: outcome.released,
              operationIds: outcome.operationIds,
            });
          }
          await ctx.tx.query(
            `insert into shopify_fulfillments (shop_id, connection_id, shopify_fulfillment_id,
               shopify_order_id, shopify_location_id, status, lines)
             values (app_shop_id(), $1, $2, $3, $4, 'fulfilled', $5)`,
            [connectionId, f.fulfillmentId, order.orderId, f.locationId, JSON.stringify(done)],
          );
        } else if (!was && f.status === 'cancelled') {
          // Cancelled before Airstock saw it: nothing was fulfilled here.
          await ctx.tx.query(
            `insert into shopify_fulfillments (shop_id, connection_id, shopify_fulfillment_id,
               shopify_order_id, shopify_location_id, status, cancelled_at)
             values (app_shop_id(), $1, $2, $3, $4, 'cancelled', now())`,
            [connectionId, f.fulfillmentId, order.orderId, f.locationId],
          );
        } else if (was?.status === 'fulfilled' && f.status === 'cancelled') {
          const reversals = await reverseFulfillments(
            ctx,
            acc,
            was.lines.flatMap((l) => l.operationIds),
            reference,
          );
          for (const l of was.lines) {
            const line = byLine.get(l.lineId);
            if (line) line.fulfilled_items = Math.max(0, line.fulfilled_items - l.items);
          }
          result.fulfillmentsReversed++;
          await ctx.tx.query(
            `update shopify_fulfillments set status = 'cancelled', cancelled_at = now(),
               reversal_operation_ids = $3
             where connection_id = $1 and shopify_fulfillment_id = $2`,
            [connectionId, f.fulfillmentId, reversals],
          );
        }
      }
    }

    // 3. What should still be held: the units Shopify has yet to ship, nothing once the order is
    // cancelled. Reserve the difference, or release the newest first.
    //
    // Shopify's current quantity leaves out refunded units, shipped or not. A refund that
    // restocks as `cancel` was of unshipped units and one as `return` (or issued through a return)
    // of shipped units; for one without restock, refunds are taken from shipped units first, as
    // Shopify counts its fulfillable quantity. Guessing wrong there holds a unit too many, never
    // one too few.
    const returnRefunds = new Set((order.returns ?? []).flatMap((r) => r.refundIds));
    const refunded = new Map<string, { all: number; unshipped: number; shipped: number }>();
    for (const r of order.refunds ?? []) {
      for (const rl of r.lines) {
        const sum = refunded.get(rl.lineId) ?? { all: 0, unshipped: 0, shipped: 0 };
        sum.all += rl.quantity;
        if (returnRefunds.has(r.refundId) || rl.restockType === 'return')
          sum.shipped += rl.quantity;
        else if (rl.restockType === 'cancel') sum.unshipped += rl.quantity;
        refunded.set(rl.lineId, sum);
      }
    }
    for (const line of lines) {
      if (!live(line)) continue;
      const state = order.lines.find((l) => l.lineId === line.shopify_line_id)!;
      const current = state.currentQuantity ?? state.quantity;
      const r = refunded.get(line.shopify_line_id) ?? { all: 0, unshipped: 0, shipped: 0 };
      // Ordered after edits: what Shopify still counts plus everything refunded.
      const ordered = current + r.all;
      const unknown = r.all - r.unshipped - r.shipped;
      const shippedLeft = Math.max(0, line.fulfilled_items - r.shipped);
      const unshippedRefunds = r.unshipped + Math.max(0, unknown - shippedLeft);
      const target = cancelled ? 0 : Math.max(0, ordered - line.fulfilled_items - unshippedRefunds);
      if (target > line.open_items) {
        const made = await reserveItems(
          ctx,
          acc,
          connectionId,
          order.orderId,
          line,
          target - line.open_items,
        );
        if ('refused' in made) {
          refuse(line, made.refused);
          continue;
        }
        if (made.short) {
          line.outcome = 'shortage';
          result.shortage++;
        } else result.reserved++;
        line.open_items = target;
      } else if (target < line.open_items) {
        const freed = await releaseItems(
          ctx,
          acc,
          connectionId,
          line,
          line.open_items - target,
          cancelled ? 'Shopify order cancelled' : 'Shopify order edited',
        );
        result.released += freed;
        line.open_items -= freed;
      }
      // Units an edit removed went back to Shopify's available (Shopify restocks them); units it
      // added came out of it. A refund's restock is counted with the refund below.
      if (order.refunds !== undefined || state.currentQuantity !== undefined) {
        const effect = ordered;
        const before = line.effect_items ?? line.quantity;
        if (effect !== before && !cancelled) {
          await shopifyTook(
            ctx.tx,
            acc,
            connectionId,
            line.inventory_item_id,
            line.shopify_location_id,
            effect - before,
            order.updatedAt ?? new Date().toISOString(),
          );
          line.effect_items = effect;
        }
      }
    }

    // 4. Refunds: a restock puts units back in Shopify's available at its location; returned
    // units start a return, received into quarantine where the location is mapped.
    if (order.refunds) {
      const seen = new Set(
        (
          await ctx.tx.query<{ key: string }>(
            `select shopify_refund_id || ':' || shopify_line_id as key from shopify_refund_lines
             where connection_id = $1 and shopify_refund_id = any($2::text[])`,
            [connectionId, order.refunds.map((r) => r.refundId)],
          )
        ).map((r) => r.key),
      );
      for (const r of order.refunds) {
        for (const rl of r.lines) {
          if (rl.quantity === 0 || seen.has(`${r.refundId}:${rl.lineId}`)) continue;
          const line = byLine.get(rl.lineId);
          let returnId: string | null = null;
          // A refund issued through a Shopify return: the return's dispositions restock and
          // bring the units back (step 5), not the refund.
          const viaReturn = (order.returns ?? []).find((x) => x.refundIds.includes(r.refundId));
          const restocked = rl.restockType !== 'no_restock' && !viaReturn;
          if (line && live(line) && restocked) {
            await shopifyTook(
              ctx.tx,
              acc,
              connectionId,
              line.inventory_item_id,
              rl.locationId,
              -rl.quantity,
              r.createdAt,
            );
          }
          const returned =
            !viaReturn &&
            (rl.restockType === 'return' ||
              (rl.restockType === 'legacy_restock' && (line?.fulfilled_items ?? 0) > 0));
          if (line && live(line) && returned) {
            returnId = await startReturn(ctx, acc, order.orderId, line, rl.quantity, {
              reference: `shopify:refund/${r.refundId}`,
              reason: 'Refunded with restock in Shopify',
              scope: scopeOf(rl.locationId) ?? scopeOf(line.shopify_location_id),
            });
            result.returns.push(returnId);
          }
          await ctx.tx.query(
            `insert into shopify_refund_lines (shop_id, connection_id, shopify_refund_id, shopify_line_id,
               items, restock_type, shopify_location_id, refunded_at, return_id, shopify_return_id)
             values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
             on conflict (shop_id, connection_id, shopify_refund_id, shopify_line_id) do update set
               items = shopify_refund_lines.items + excluded.items,
               return_id = coalesce(shopify_refund_lines.return_id, excluded.return_id)`,
            [
              connectionId,
              r.refundId,
              rl.lineId,
              rl.quantity,
              rl.restockType,
              rl.locationId,
              r.createdAt,
              returnId,
              viaReturn?.returnId ?? null,
            ],
          );
        }
      }
    }

    // 5. Shopify returns: each disposition once. A restock raises Shopify's available at its
    // location; units that came back (restocked or not, or to be processed) start a return here,
    // received into quarantine (ADR 0029). Missing units never came back.
    const dispositions = (order.returns ?? []).flatMap((x) =>
      x.dispositions.map((d) => ({ ...d, returnId: x.returnId })),
    );
    if (dispositions.length > 0) {
      const seen = new Set(
        (
          await ctx.tx.query<{ id: string }>(
            `select shopify_disposition_id as id from shopify_return_dispositions
             where connection_id = $1 and shopify_disposition_id = any($2::text[])`,
            [connectionId, dispositions.map((d) => d.dispositionId)],
          )
        ).map((x) => x.id),
      );
      const inOrder = [...dispositions].sort(
        (a, b) =>
          a.dispositionId.length - b.dispositionId.length ||
          (a.dispositionId < b.dispositionId ? -1 : a.dispositionId > b.dispositionId ? 1 : 0),
      );
      for (const d of inOrder) {
        if (seen.has(d.dispositionId)) continue;
        const line = byLine.get(d.lineId);
        let returnId: string | null = null;
        if (line && live(line)) {
          if (d.type === 'restocked') {
            await shopifyTook(
              ctx.tx,
              acc,
              connectionId,
              line.inventory_item_id,
              d.locationId,
              -d.quantity,
              d.createdAt,
            );
          }
          if (d.type !== 'missing') {
            returnId = await startReturn(ctx, acc, order.orderId, line, d.quantity, {
              reference: `shopify:return/${d.returnId}`,
              reason:
                d.type === 'restocked'
                  ? 'Returned and restocked in Shopify'
                  : 'Returned in Shopify, not restocked',
              scope: scopeOf(d.locationId) ?? scopeOf(line.shopify_location_id),
            });
            result.returns.push(returnId);
          }
        }
        await ctx.tx.query(
          `insert into shopify_return_dispositions (shop_id, connection_id, shopify_disposition_id,
             shopify_return_id, shopify_order_id, shopify_line_id, items, disposition_type,
             shopify_location_id, disposed_at, return_id)
           values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            connectionId,
            d.dispositionId,
            d.returnId,
            order.orderId,
            d.lineId,
            d.quantity,
            d.type,
            d.locationId,
            d.createdAt,
            returnId,
          ],
        );
      }
    }

    // 6. The lines as applied.
    for (const line of lines.filter((l) => live(l) || l.outcome === 'refused')) {
      await ctx.tx.query(
        `update shopify_order_lines set open_items = $3, fulfilled_items = $4, effect_items = $5,
           outcome = $6, reservation_id = coalesce(reservation_id,
             (select reservation_id from shopify_line_reservations x where x.connection_id = $1
                and x.shopify_line_id = $2 order by created_at limit 1)),
           updated_at = now()
         where connection_id = $1 and shopify_line_id = $2`,
        [
          connectionId,
          line.shopify_line_id,
          line.open_items,
          line.fulfilled_items,
          line.effect_items,
          line.outcome,
        ],
      );
    }
    await applyTook(ctx.tx, acc, connectionId);
    // Levels whose record changed are pushed after commit, unless a stock change in this
    // transaction already announces them (its push covers the same level).
    const announced = new Set<string>();
    for (const o of acc.outbox) {
      if (o.topic !== 'inventory.availability_changed') continue;
      const p = o.payload as { variantId?: string; locationIds?: string[]; positionIds?: string[] };
      for (const l of await affectedLevels(ctx.tx, {
        variantId: p.variantId ?? null,
        locationIds: p.locationIds ?? [],
        positionIds: p.positionIds ?? [],
      })) {
        if (l.connectionId === connectionId) {
          announced.add(`${l.inventoryItemId}@${l.shopifyLocationId}`);
        }
      }
    }
    for (const level of acc.levels) {
      if (announced.has(level)) continue;
      const [item, location] = level.split('@');
      acc.outbox.push({
        topic: SHOPIFY_PUSH_TOPIC,
        payload: { connectionId, inventoryItemIds: [item], shopifyLocationIds: [location] },
      });
    }
    return {
      result,
      audit: {
        targetType: 'shopify_order',
        targetId: order.orderId,
        externalRef: ref,
        changes: { ...result, cancelled },
      },
      outbox: acc.outbox,
      events: acc.events,
      webhooks: acc.webhooks,
      ...(acc.alertVariants.length > 0 ? { alertCheck: { variantIds: acc.alertVariants } } : {}),
    };
  },
});

/**
 * Returned units of a line (a refund with restock, or a Shopify return's disposition): a return
 * for the line (so its cost traces back to the line's fulfillments), authorized, and received into
 * quarantine at the mapped location's receiving location. Lot- and serial-tracked units are
 * received by a person, who names lots or serials; so are units at a location that is not mapped.
 */
async function startReturn(
  ctx: HandlerContext,
  acc: Acc,
  orderId: string,
  line: LineRow,
  items: number,
  how: { reference: string; reason: string; scope: ScopeMap | null },
): Promise<string> {
  const scope = how.scope;
  const parts = line.bundle
    ? await ctx.tx.query<{ variant_id: string; per: string }>(
        `select c.variant_id, sum(c.base_quantity)::text as per
         from bundles b
         join bundle_versions bv on bv.shop_id = b.shop_id and bv.bundle_id = b.id and bv.version = b.version
         join bundle_components c on c.shop_id = bv.shop_id and c.bundle_version_id = bv.id
         where b.variant_id = $1 group by c.variant_id order by c.variant_id`,
        [line.variant_id],
      )
    : [{ variant_id: line.variant_id!, per: line.per_item }];
  const created = await inner(ctx, acc, createReturn, {
    lines: parts.map((p) => ({
      variantId: p.variant_id,
      quantity: normalize(exactProduct(String(items), p.per)),
    })),
    orderRef: lineRef(orderId, line.shopify_line_id),
    reference: how.reference,
    reason: how.reason,
    authorize: true,
  });
  const returnId = created.return.returnId;
  const location = scope?.receive_location_id ?? null;
  if (location) {
    const tracked = await ctx.tx.query<{ id: string }>(
      `select id from variants where id = any($1::uuid[]) and tracking_mode <> 'none'`,
      [parts.map((p) => p.variant_id)],
    );
    if (tracked.length === 0) {
      await inner(ctx, acc, receiveReturn, { returnId, locationId: location });
    }
  }
  return returnId;
}

export const shopifyOrderCallbacks = [syncShopifyOrder] as const;
