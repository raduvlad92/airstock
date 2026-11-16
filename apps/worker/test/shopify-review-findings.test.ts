import { runImportJob, uuidv7 } from '@airstock/core';
import {
  pushAvailability,
  reconcileConnection,
  ShopifyApiError,
  type ShopifyVariant,
} from '@airstock/shopify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../../test/helpers.ts';
import type { FakeStore } from './fake-shopify.ts';
import { json } from './setup.ts';
import { type Merchant, type ShopifyHarness, shopifyHarness } from './shopify-harness.ts';

// Review of the Shopify connector (16 November 2026): one test per confirmed defect, named after
// the finding. Each is `it.fails` so CI stays green until the defect is fixed; the comment above
// each says what goes wrong. When a fix lands, its test starts passing, `it.fails` then fails,
// and the fix turns it into a plain `it`.
//
// Test files run in parallel against one database and outbox: every query here is limited to
// this file's shops.

let h: ShopifyHarness;
beforeAll(async () => {
  h = await shopifyHarness();
});
afterAll(() => h.t.close());

interface Setup {
  m: Merchant;
  store: FakeStore;
  connectionId: string;
  variantId: string;
  productId: string;
  item: ShopifyVariant;
}

/** A shop with `stock` units of one item, a store selling it at "Shop location", mapped. */
async function setup(name: string, stock: number): Promise<Setup> {
  const m = await h.merchant(name);
  const sku = `${name.replace(/\W/g, '').slice(0, 8).toUpperCase()}-${uuidv7().slice(-6)}`;
  const made = await h.item(m, name, sku);
  if (stock > 0) await h.receive(m, made.variantId, stock);
  const store = h.newStore('review');
  const [item] = store.addProduct({ title: name, variants: [{ sku, quantities: { '1001': 0 } }] });
  const connectionId = await h.install(m, store);
  const base = `/shops/${m.shopId}/shopify/connections/${connectionId}`;
  expect(
    (
      await h.command(m.cookie, `${base}/locations`, {
        connectionId,
        locations: [{ shopifyLocationId: '1001', locationId: m.locationId }],
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.command(m.cookie, `${base}/variants`, {
        connectionId,
        variants: [
          {
            shopifyVariantId: item!.variantId,
            shopifyInventoryItemId: item!.inventoryItemId,
            variantId: made.variantId,
          },
        ],
      })
    ).status,
  ).toBe(200);
  await h.flush(m.shopId);
  expect(store.available(item!)).toBe(stock);
  return {
    m,
    store,
    connectionId,
    variantId: made.variantId,
    productId: made.productId,
    item: item!,
  };
}

/** Delivers a topic's webhook, runs this shop's jobs, and pushes this shop's changes. */
async function event(s: Setup, topic: string, body: string, eventId?: string) {
  const res = await h.deliver(s.store.domain, topic, body, eventId ? { eventId } : {});
  expect(res.status).toBe(200);
  const jobs = await h.runJobs(s.m.shopId);
  await h.flush(s.m.shopId);
  return jobs;
}

async function onHand(s: Setup) {
  const [row] = await ownerQuery<{ on_hand: string; allocated: string }>(
    `select coalesce(sum(on_hand), 0)::text as on_hand, coalesce(sum(allocated), 0)::text as allocated
     from inventory_positions where shop_id = $1 and variant_id = $2 and condition = 'sellable'`,
    [s.m.shopId, s.variantId],
  );
  return row!;
}

const NAMES = ['mug', 'teapot', 'kettle'];

interface Many {
  m: Merchant;
  store: FakeStore;
  connectionId: string;
  items: Array<{ variantId: string; productId: string; shopify: ShopifyVariant }>;
}

/** A shop whose items (with stock) are each sold by one Shopify variant at "Shop location". */
async function setupItems(name: string, stocks: number[]): Promise<Many> {
  const m = await h.merchant(name);
  const store = h.newStore('review');
  const items: Many['items'] = [];
  for (const [i, stock] of stocks.entries()) {
    const sku = `${name.replace(/\W/g, '').slice(0, 6).toUpperCase()}-${i}-${uuidv7().slice(-6)}`;
    const made = await h.item(m, `${name} ${NAMES[i]}`, sku);
    if (stock > 0) await h.receive(m, made.variantId, stock);
    const [shopify] = store.addProduct({
      title: `${name} ${NAMES[i]}`,
      variants: [{ sku, quantities: { '1001': 0 } }],
    });
    items.push({ variantId: made.variantId, productId: made.productId, shopify: shopify! });
  }
  const connectionId = await h.install(m, store);
  const base = `/shops/${m.shopId}/shopify/connections/${connectionId}`;
  await h.command(m.cookie, `${base}/locations`, {
    connectionId,
    locations: [{ shopifyLocationId: '1001', locationId: m.locationId }],
  });
  const mapped = await h.command(m.cookie, `${base}/variants`, {
    connectionId,
    variants: items.map((i) => ({
      shopifyVariantId: i.shopify.variantId,
      shopifyInventoryItemId: i.shopify.inventoryItemId,
      variantId: i.variantId,
    })),
  });
  expect(mapped.status).toBe(200);
  await h.flushTogether(m.shopId);
  for (const [i, stock] of stocks.entries()) expect(store.available(items[i]!.shopify)).toBe(stock);
  return { m, store, connectionId, items };
}

async function shopifyAlerts(shopId: string) {
  return ownerQuery<{ kind: string; status: string; details: object }>(
    `select kind, status, details from alerts where shop_id = $1 and kind = 'shopify_sync'
     order by opened_at`,
    [shopId],
  );
}

describe('Shopify connector review findings', () => {
  // FINDING 1 (stock drift, main). shopify.orders.sync runs fulfillments (step 2) before it
  // reserves new lines (step 3). An order whose first sync already carries a fulfillment (its
  // fulfillments/create webhook came before orders/create, or the reconciler found an order whose
  // webhooks were missed, as with a POS sale) has no reservation to fulfill: fulfillItems counts
  // every unit as "released", step 3's target is then 0, and no stock ever leaves. Airstock keeps
  // the shipped units as available and pushes them back to Shopify.
  it.fails('F1: an order first seen with its fulfillment takes the shipped units out of stock', async () => {
    const s = await setup('Late create mug', 5);
    const order = s.store.placeOrder([{ variant: s.item, quantity: 2 }]);
    const f = s.store.fulfill(order);
    // fulfillments/create arrives first; orders/create is late.
    await event(
      s,
      'fulfillments/create',
      s.store.topicBody('fulfillments/create', order, f.fulfillmentId),
    );
    await event(s, 'orders/create', s.store.webhookBody(order));
    expect(await onHand(s)).toEqual({ on_hand: '3.000000', allocated: '0.000000' });
    expect(await h.available(s.m, s.variantId)).toBe('3.000000');
    // Shopify sold 2 of 5: it must not be told 5 are available again.
    expect(s.store.available(s.item)).toBe(3);
  });
  // FINDING 2 (lost order, reconciler stuck; main). shopify.orders.sync applies a whole order in
  // one transaction and reserveStock refuses an archived variant (409 variant_archived, not
  // retryable). A Shopify order with one line for a mapped variant that was archived in Airstock
  // (Shopify still sells it: "continue selling", a POS sale, or an order placed before the push
  // of 0 landed) therefore fails whole: its other lines are never reserved, the job fails for
  // good, and reconcileConnection throws on that order before it moves the cursor, so every run
  // stops at the same order. No later missed order, level comparison, or pending push is ever
  // reconciled for the store. A Shopify reservation released by hand in Airstock poisons an order
  // the same way (its cancel or fulfillment gets reservation_not_open).
  it.fails('F2: an order line for an archived variant does not lose the order or stop the reconciler', async () => {
    const s = await setupItems('Archived line', [5, 5]);
    const [gone, kept] = s.items as [Many['items'][0], Many['items'][0]];
    // The first item is archived in Airstock (the state archive_variant leaves); still mapped.
    await ownerQuery(`update variants set status = 'archived' where id = $1`, [gone.variantId]);
    // Two orders whose webhooks never came: the first has a line for each item.
    s.store.placeOrder([
      { variant: gone.shopify, quantity: 1 },
      { variant: kept.shopify, quantity: 2 },
    ]);
    s.store.placeOrder([{ variant: kept.shopify, quantity: 1 }]);
    const run = () =>
      reconcileConnection(h.deps(), s.m.shopId, s.connectionId, { daily: false }).catch(
        (error: unknown) => error,
      );
    // Today each run throws variant_archived on the first order.
    expect(await run()).not.toBeInstanceOf(Error);
    await run();
    // Both orders' lines for the item that is still sold are held.
    expect(await h.available(s.m, kept.variantId)).toBe('2.000000');
    // The cursor moves past the order (today it stays null: every run stops at the same order).
    const [conn] = await ownerQuery<{ synced: Date | null }>(
      'select orders_synced_through as synced from shopify_connections where id = $1',
      [s.connectionId],
    );
    expect(conn?.synced).not.toBeNull();
  });

  // FINDING 3 (false conflict, level frozen; main). pushBatch decides a refused write is explained
  // only when catchUpOrders "processed" something, and catchUpOrders counts reserved + shortage
  // lines only. A refusal caused by Shopify's own restock (a cancellation, an edit that removes
  // units, a refund with restock) whose webhook has not been applied yet is applied by the
  // catch-up (released), yet counts 0, so the push records a conflict: a shopify_sync alert and a
  // shopify.sync_conflict webhook go out, and the level is not pushed until the reconciler or a
  // person clears it. A cancellation of an order created before the record's as-of time is not
  // even listed by ordersSince, so it is always called a conflict.
  it.fails('F3: a push refused because of an unprocessed cancellation is not a conflict', async () => {
    const s = await setup('Cancel race', 6);
    const order = s.store.placeOrder([{ variant: s.item, quantity: 4 }]);
    await event(s, 'orders/create', s.store.webhookBody(order));
    expect(s.store.available(s.item)).toBe(2);
    // Shopify cancels and restocks; the orders/cancelled webhook is still on its way when a
    // receipt in Airstock pushes the level.
    s.store.cancel(order);
    await h.receive(s.m, s.variantId, 1);
    await h.flush(s.m.shopId);
    expect(await shopifyAlerts(s.m.shopId)).toEqual([]);
    expect(await h.available(s.m, s.variantId)).toBe('7.000000');
    expect(s.store.available(s.item)).toBe(7);
  });

  // FINDING 4 (stock drift and false conflict; main). With one location map, processOrder never
  // reads where Shopify committed a line (lineLocations runs only for several maps), and the sync
  // takes `onlyLocation` for every line. A store with a second Shopify location that is not mapped
  // (a 3PL, a pop-up) gets orders committed there counted against the mapped location's record:
  // the record drops while Shopify's quantity at the mapped location does not, the push then sees
  // target == record and writes nothing, so Shopify keeps showing the reserved units as sellable
  // at the mapped location (oversell), and the next comparison calls it a conflict. PRD 8.5:
  // unmapped Shopify locations are "never guessed".
  it.fails('F4: an order committed at an unmapped Shopify location leaves the mapped level right', async () => {
    const s = await setup('Unmapped loc', 5);
    s.store.levels.set(s.store.key(s.item.inventoryItemId, '1002'), 10);
    // Shopify commits the order at "Warehouse" (1002), which this shop has not mapped.
    const order = s.store.placeOrder([{ variant: s.item, quantity: 2 }], '1002');
    await event(s, 'orders/create', s.store.webhookBody(order));
    // Whatever Airstock holds for the order, Shopify's mapped level must show Airstock's
    // availability there, and the record must match Shopify (no conflict on the next check).
    expect(s.store.available(s.item, '1001')).toBe(Number(await h.available(s.m, s.variantId)));
    await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, { daily: true });
    expect(await shopifyAlerts(s.m.shopId)).toEqual([]);
  });
  // FINDING 5 (stock drift; main). The orders/create job applies its webhook payload (lines with
  // their original quantity, no currentQuantity, no refunds) as the order's whole state. When it
  // runs after a sync that read the order from the Admin API (orders/edited or refunds/create
  // delivered first, the reconciler, or the create job's own retries running late), step 3 takes
  // the original quantity as what is still to ship and reserves again the units an edit removed
  // or a refund took back. Nothing corrects it until the order changes again in Shopify.
  it.fails('F5: a late orders/create does not undo an edit already applied', async () => {
    const s = await setup('Late payload', 10);
    const order = s.store.placeOrder([{ variant: s.item, quantity: 3 }]);
    const createBody = s.store.webhookBody(order);
    s.store.editLine(order, order.lines[0]!.lineId, 1);
    // orders/edited is delivered first, then the orders/create Shopify sent at checkout.
    await event(s, 'orders/edited', s.store.topicBody('orders/edited', order));
    expect(await h.available(s.m, s.variantId)).toBe('9.000000');
    await event(s, 'orders/create', createBody);
    expect(await h.available(s.m, s.variantId)).toBe('9.000000');
    expect(s.store.available(s.item)).toBe(9);
  });
  // FINDING 6 (uninstall lost, tokens kept; main). receiveWebhook records the app/uninstalled
  // receipt in one transaction and marks the connection uninstalled in a second, only when the
  // receipt is new. If the second fails (a crash, a lost connection), Airstock answers 500 and
  // Shopify retries with the same event ID, which is now a duplicate: the uninstall is skipped and
  // answered 200. The connection stays active with its tokens, the store stays locked to this shop
  // (it cannot be connected elsewhere), and the reconciler keeps calling Shopify.
  it.fails('F6: an uninstall that failed once is applied when Shopify retries the webhook', async () => {
    const s = await setup('Uninstall retry', 1);
    const fn = `test_fail_uninstall_${s.connectionId.replace(/-/g, '')}`;
    // A failure injected for this connection only (other test files share the table).
    await ownerQuery(`
      create function ${fn}() returns trigger language plpgsql as $$
      begin
        if new.id = '${s.connectionId}' and new.status = 'uninstalled' then
          raise exception 'simulated failure while marking the uninstall';
        end if;
        return new;
      end $$;
      create trigger ${fn} before update on shopify_connections
        for each row execute function ${fn}();`);
    const eventId = uuidv7();
    const body = JSON.stringify({ id: 1, domain: s.store.domain });
    try {
      const first = await h.deliver(s.store.domain, 'app/uninstalled', body, { eventId });
      expect(first.status).toBeGreaterThanOrEqual(500);
    } finally {
      await ownerQuery(`drop trigger ${fn} on shopify_connections; drop function ${fn}();`);
    }
    // Shopify retries the same event.
    const retry = await h.deliver(s.store.domain, 'app/uninstalled', body, { eventId });
    expect(retry.status).toBe(200);
    const [conn] = await ownerQuery<{ status: string; access: string | null }>(
      `select status, access_token_ciphertext as access from shopify_connections where id = $1`,
      [s.connectionId],
    );
    expect(conn).toEqual({ status: 'uninstalled', access: null });
  });
  // FINDING 7 (level frozen by a retry; main). Each inventorySetQuantities call gets a new
  // idempotency key, and the record is updated only when the call returns. When Shopify applies
  // the write but the response is lost (a timeout, a 502, the Worker stopped), the queue retries
  // with the old record as changeFromQuantity: Shopify refuses it as stale, no order explains it,
  // and a conflict is recorded although Shopify already shows Airstock's number. The reconciler
  // compares Shopify with the (old) record, not with Airstock's target, so the conflict never
  // clears by itself: the level stops syncing until a person resolves an alert about nothing.
  it.fails('F7: a push whose response was lost is not a conflict on retry', async () => {
    const s = await setup('Lost response', 5);
    await h.receive(s.m, s.variantId, 1);
    // Shopify applies the write, then the response is lost.
    const set = s.store.setAvailable.bind(s.store);
    let lose = 1;
    s.store.setAvailable = async (input) => {
      const done = await set(input);
      if (lose-- > 0) throw new ShopifyApiError('Shopify Admin API returned 502.', 502, true);
      return done;
    };
    await expect(h.flush(s.m.shopId)).rejects.toMatchObject({ retryable: true });
    expect(s.store.available(s.item)).toBe(6);
    // The queue retries the message.
    const retried = await pushAvailability(h.deps(), s.m.shopId, {
      variantId: s.variantId,
      locationIds: [s.m.locationId],
    });
    expect(retried.map((r) => r.outcome)).not.toContain('conflict');
    await reconcileConnection(h.deps(), s.m.shopId, s.connectionId, { daily: true });
    expect(await shopifyAlerts(s.m.shopId)).toEqual([]);
  });
  // FINDING 8 (stock drift, oversell; main). The onboarding import receives Shopify's available
  // at the time of the bulk read as opening stock, and maps the variants only after a person
  // commits the preview. An order placed in between (the preview can wait hours) arrives while
  // its variant is unmapped, so its line is recorded as `unmapped` for good and never reserved or
  // fulfilled here. The first push then reads Shopify's lower quantity as the record and writes
  // the opening stock over it: Shopify shows the sold units as available again, and Airstock
  // keeps them on hand after they ship.
  it.fails('F8: an order placed while the onboarding preview waits is not sold twice', async () => {
    const m = await h.merchant('Onboarding race');
    const store = h.newStore('review');
    const code = `RACE-${uuidv7().slice(-6)}`;
    const [variant] = store.addProduct({
      title: 'Race mug',
      variants: [{ sku: code, quantities: { '1001': 10 } }],
    });
    const connectionId = await h.install(m, store);
    const base = `/shops/${m.shopId}/shopify/connections/${connectionId}`;
    await h.command(m.cookie, `${base}/locations`, {
      connectionId,
      locations: [{ shopifyLocationId: '1001', locationId: m.locationId }],
    });
    const started = await h.command(m.cookie, `${base}/onboardings`, { connectionId });
    expect(started.status, await started.clone().text()).toBe(201);
    const onboardingId = (await json(started)).onboarding.onboardingId as string;
    await h.runOnboardingSteps(m.shopId, onboardingId);
    const viewed = await json(
      await h.dashboard(m.cookie, `/shops/${m.shopId}/shopify/onboardings/${onboardingId}`),
    );
    expect(viewed.onboarding.status).toBe('previewed');
    // While the preview waits for review, Shopify sells 3.
    const order = store.placeOrder([{ variant: variant!, quantity: 3 }]);
    await h.deliver(store.domain, 'orders/create', store.webhookBody(order));
    await h.runJobs(m.shopId);
    // The person commits; the import and the maps complete.
    const committed = await h.command(
      m.cookie,
      `/shops/${m.shopId}/shopify/onboardings/${onboardingId}/commit`,
      {},
    );
    expect(committed.status, await committed.clone().text()).toBe(200);
    await h.runOnboardingSteps(m.shopId, onboardingId, 1);
    await runImportJob(
      { db: h.t.db, audit: h.t.sink, files: h.deps().files! },
      m.shopId,
      viewed.onboarding.importId,
    );
    await h.runOnboardingSteps(m.shopId, onboardingId);
    await h.flush(m.shopId);
    // 10 on the shelf, 3 of them sold: 7 to sell, in both systems.
    expect(store.available(variant!)).toBe(7);
    const [mapped] = await ownerQuery<{ variant_id: string }>(
      'select variant_id from shopify_variant_maps where shop_id = $1',
      [m.shopId],
    );
    expect(await h.available(m, mapped!.variant_id)).toBe('7.000000');
  });
  // FINDING 9 (phantom returned stock; main, minor). For a refund restocked at a Shopify location
  // that is not mapped, startReturn falls back to the scope of the line's location
  // (`scopeOf(rl.locationId) ?? scopeOf(line.shopify_location_id)`) and receives the unit into
  // quarantine at that mapped location. The unit went back to the other location (a returns
  // center, a 3PL), so Airstock now counts a quarantined unit that is not there. ADR 0035: units
  // at an unmapped location wait for a person to receive them.
  it.fails('F9: a refund restocked at an unmapped Shopify location is not received here', async () => {
    const s = await setup('Return elsewhere', 5);
    const order = s.store.placeOrder([{ variant: s.item, quantity: 2 }]);
    await event(s, 'orders/create', s.store.webhookBody(order));
    const f = s.store.fulfill(order);
    await event(
      s,
      'fulfillments/create',
      s.store.topicBody('fulfillments/create', order, f.fulfillmentId),
    );
    // The customer returns one unit to Shopify's "Warehouse" (1002), not mapped here.
    s.store.levels.set(s.store.key(s.item.inventoryItemId, '1002'), 0);
    const refund = s.store.refund(order, [
      { lineId: order.lines[0]!.lineId, quantity: 1, restockType: 'return', location: '1002' },
    ]);
    await event(s, 'refunds/create', s.store.topicBody('refunds/create', order, refund.refundId));
    const [quarantine] = await ownerQuery<{ on_hand: string | null }>(
      `select sum(on_hand)::text as on_hand from inventory_positions
       where shop_id = $1 and variant_id = $2 and condition = 'quarantine'`,
      [s.m.shopId, s.variantId],
    );
    expect(quarantine?.on_hand ?? '0').toBe('0');
    const [ret] = await ownerQuery<{ status: string }>(
      'select status from returns where shop_id = $1',
      [s.m.shopId],
    );
    expect(ret?.status).toBe('authorized');
  });
});
