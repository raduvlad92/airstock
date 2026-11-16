import type { Database } from '@airstock/db';
import { systemCaller } from '../accounts.ts';
import { type AuditEvent, auditEvent, INSERT_AUDIT_EVENTS_SQL } from '../audit.ts';
import { uuidv7 } from '../ids.ts';
import type { HandlerContext } from '../registry.ts';
import { insertWebhookEvents } from '../webhooks/events.ts';
import {
  type AlertEffects,
  applyAlertChanges,
  checkReorderRules,
  checkShortages,
} from './check.ts';

/**
 * The daily alert check (D12), with the 03:00 cron: lots expiring within the shop's window
 * (`lot_expiry_alert_days`) open an alert until their stock is gone, and every reorder rule and
 * shortage is checked again, which also catches stock changed outside a command (an import's
 * opening stock, a sweep). Each shop runs in its own transaction; outbox rows and webhook events
 * are written in it.
 */
export async function runDailyAlertChecks(
  db: Database,
  maxShops = 500,
): Promise<{ shops: number; opened: number; resolved: number }> {
  const shops = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query<{ shop_id: string }>('select s as shop_id from shops_due_alert_check($1) s', [
      maxShops,
    ]),
  );
  let opened = 0;
  let resolved = 0;
  for (const { shop_id: shopId } of shops) {
    const counts = await checkShop(db, shopId);
    opened += counts.opened;
    resolved += counts.resolved;
  }
  return { shops: shops.length, opened, resolved };
}

export async function checkShop(
  db: Database,
  shopId: string,
): Promise<{ opened: number; resolved: number }> {
  const caller = systemCaller('alerts', shopId);
  const requestId = uuidv7();
  return db.transaction({ shopId, userId: null }, async (tx) => {
    const base = { shopId, caller, requestId, attemptId: null, idempotencyKey: null };
    const ctx: Pick<HandlerContext, 'tx' | 'event'> = {
      tx,
      event: (fields) => auditEvent(base, { phase: 'outcome', ...fields }),
    };
    const lots = await lotExpiry(ctx);
    const rules = await checkReorderRules(ctx, null, 'daily');
    const short = await tx.query<{ variant_id: string }>(
      `select distinct variant_id from reservations
       where shortage_quantity > 0 and status in ('active', 'partially_fulfilled')`,
    );
    const shortages = await checkShortages(
      ctx,
      short.map((s) => s.variant_id),
      null,
      'daily',
    );
    const all: AlertEffects = {
      events: [...lots.events, ...rules.events, ...shortages.events],
      outbox: [...lots.outbox, ...rules.outbox, ...shortages.outbox],
      webhooks: [...lots.webhooks, ...rules.webhooks, ...shortages.webhooks],
    };
    if (all.events.length > 0) {
      await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify(all.events)]);
      await tx.query(
        `insert into outbox_events (shop_id, id, topic, payload)
         select app_shop_id(), x.id, x.topic, x.payload
         from jsonb_to_recordset($1::jsonb) as x(id uuid, topic text, payload jsonb)`,
        [JSON.stringify(all.outbox.map((o) => ({ id: uuidv7(), ...o })))],
      );
      await insertWebhookEvents(tx, all.webhooks, uuidv7);
    }
    const count = (action: string) =>
      all.events.filter((e: AuditEvent) => e.action === action).length;
    return { opened: count('alert.opened'), resolved: count('alert.resolved') };
  });
}

/** Lots with stock that expire within the shop's window, and lot alerts whose stock is gone. */
async function lotExpiry(ctx: Pick<HandlerContext, 'tx' | 'event'>): Promise<AlertEffects> {
  const rows = await ctx.tx.query<{
    lot_id: string;
    code: string;
    expires_on: string;
    variant_id: string;
    sku: string;
    product_name: string;
    expired: boolean;
    on_hand: string;
    scope_ids: string[];
    location_ids: string[];
    alert_id: string | null;
  }>(
    `select lt.id as lot_id, lt.code, to_char(lt.expires_on, 'YYYY-MM-DD') as expires_on,
       lt.variant_id, v.sku, pr.name as product_name,
       lt.expires_on < (now() at time zone sh.timezone)::date as expired,
       st.on_hand::text, st.scope_ids, st.location_ids, a.id as alert_id
     from lots lt
     join shops sh on sh.id = app_shop_id()
     join variants v on v.shop_id = lt.shop_id and v.id = lt.variant_id
     join products pr on pr.shop_id = v.shop_id and pr.id = v.product_id
     left join alerts a on a.shop_id = lt.shop_id and a.dedupe_key = 'lot_expiring:' || lt.id
       and a.status <> 'resolved'
     cross join lateral (
       select coalesce(sum(p.on_hand), 0) as on_hand,
         array(select distinct x from inventory_positions p2
           join locations l2 on l2.shop_id = p2.shop_id and l2.id = p2.location_id
           cross join unnest(l2.path_ids) x
           where p2.shop_id = lt.shop_id and p2.lot_id = lt.id and p2.on_hand > 0) as scope_ids,
         array(select distinct p3.location_id from inventory_positions p3
           where p3.shop_id = lt.shop_id and p3.lot_id = lt.id and p3.on_hand > 0) as location_ids
       from inventory_positions p where p.shop_id = lt.shop_id and p.lot_id = lt.id) st
     where lt.expires_on is not null
       and ((lt.expires_on <= (now() at time zone sh.timezone)::date + sh.lot_expiry_alert_days
             and st.on_hand > 0)
         or a.id is not null)
     order by lt.expires_on, lt.id
     limit 2000`,
  );
  const opened = rows
    .filter((r) => !r.alert_id && Number(r.on_hand) > 0)
    .map((r) => ({
      id: uuidv7(),
      kind: 'lot_expiring' as const,
      dedupeKey: `lot_expiring:${r.lot_id}`,
      targetType: 'lot',
      targetId: r.lot_id,
      variantId: r.variant_id,
      lotId: r.lot_id,
      scopeIds: r.scope_ids,
      webhookLocationIds: r.location_ids,
      details: {
        sku: r.sku,
        productName: r.product_name,
        lotCode: r.code,
        expiresOn: r.expires_on,
        expired: r.expired,
        onHand: r.on_hand,
      },
    }));
  const resolved = rows
    .filter((r) => r.alert_id && Number(r.on_hand) === 0)
    .map((r) => ({
      id: r.alert_id!,
      kind: 'lot_expiring' as const,
      resolution: 'sold_out',
      webhookLocationIds: [],
      details: {},
    }));
  return applyAlertChanges(ctx.tx, ctx.event, opened, resolved, 'daily');
}
