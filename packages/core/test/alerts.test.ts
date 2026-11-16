import {
  checkShopAlerts,
  type EmailSender,
  execute,
  notifyAlertOpened,
  type OutgoingEmail,
  ops,
  uuidv7,
} from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  appDatabase,
  boundCaller,
  createLeafLocation,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
  ownerQuery,
  reconcile,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';

// Reorder rules and alerts (D12, PRD 6.9): A34 (one alert while orders drain stock, in the app and
// by email, cleared when stock recovers), A35 (drafts per supplier from low stock, half a line
// received, closed), pack and minimum-order rounding, a rollback leaves no alert (A11), location
// scope, the daily lot check, and isolation between shops (A13).

const db = appDatabase({}, 6);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Alerts shop');
  h = harness(db, sink, shop);
});
afterAll(() => db.close());

/** This shop's outbox rows for a topic (test files share one outbox: never drain it). */
async function outbox(topic: string, shopId = shop.shopId) {
  return ownerQuery<{ payload: { alertId: string; kind: string } }>(
    'select payload from outbox_events where shop_id = $1 and topic = $2 order by id',
    [shopId, topic],
  );
}

async function alertsFor(variantId: string, status = 'all') {
  const res = await h.run(ops.listAlerts, { status, variantId });
  return res.alerts as Array<{ id: string; kind: string; status: string; details: Json }>;
}

// biome-ignore lint/suspicious/noExplicitAny: test reads JSON details
type Json = Record<string, any>;

async function stocked(quantity: string, sku?: string) {
  const variantId = await createVariant(h, sku);
  await h.run(ops.receiveStock, {
    variantId,
    locationId: shop.locationId,
    quantity,
    unitCost: '4',
  });
  return variantId;
}

async function order(variantId: string, quantity: string) {
  const r = await h.run(ops.reserveStock, { variantId, quantity });
  return h.run(ops.fulfillReservation, { reservationId: r.reservationId });
}

describe('low stock (A34)', () => {
  it('opens one alert as orders drain stock, emails once, and clears when stock recovers', async () => {
    const variantId = await stocked('12');
    const rule = await h.run(ops.setReorderRule, {
      variantId,
      warehouseId: shop.warehouseId,
      reorderPoint: '5',
      reorderQuantity: '20',
    });
    expect(rule.rule).toMatchObject({ available: '12', onOrder: '0', low: false, alertId: null });

    // Orders of 2: 10, 8, 6 stay above the point; 4, then 2 and 0 are at or below it.
    for (let i = 0; i < 6; i++) await order(variantId, '2');
    const alerts = await alertsFor(variantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'low_stock', status: 'open' });
    expect(alerts[0]!.details).toMatchObject({ available: '4.000000', reorderPoint: '5.000000' });
    const opened = (await outbox('alert.opened')).filter(
      (o) => o.payload.alertId === alerts[0]!.id,
    );
    expect(opened).toHaveLength(1);
    expect((await h.run(ops.alertSummary, {})).byKind.low_stock).toBeGreaterThanOrEqual(1);

    // The email job: the owner gets it by default, exactly once per opening.
    const sent: OutgoingEmail[] = [];
    const email: EmailSender = {
      async send(message) {
        sent.push(message);
        return { id: `m-${sent.length}` };
      },
    };
    const deps = { db, email, publicUrl: 'https://airstock.test' };
    expect(await notifyAlertOpened(deps, shop.shopId, alerts[0]!.id)).toEqual({
      sent: 1,
      skipped: false,
    });
    expect(await notifyAlertOpened(deps, shop.shopId, alerts[0]!.id)).toEqual({
      sent: 0,
      skipped: false,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain('Low stock');
    expect(sent[0]!.idempotencyKey).toBe(`alert/${alerts[0]!.id}/${await ownerMembership()}`);
    expect(sent[0]!.text).toContain('Available: 4.000000');

    // Stock comes back above the point: the alert resolves by itself.
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '10' });
    const after = await alertsFor(variantId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: 'resolved' });
    expect((await outbox('alert.resolved')).map((o) => o.payload.alertId)).toContain(alerts[0]!.id);
    // Falling again is a new opening.
    await order(variantId, '6');
    expect((await alertsFor(variantId, 'active')).map((a) => a.status)).toEqual(['open']);
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('counts on order: sending a purchase order clears the alert, closing it brings it back', async () => {
    const variantId = await stocked('3');
    const supplier = (await h.run(ops.createSupplier, { name: `S ${uuidv7().slice(-6)}` }))
      .supplier;
    await h.run(ops.setReorderRule, {
      variantId,
      warehouseId: shop.warehouseId,
      reorderPoint: '5',
      maximumLevel: '20',
      preferredSupplierId: supplier.id,
    });
    expect((await alertsFor(variantId, 'active')).map((a) => a.kind)).toEqual(['low_stock']);
    const po = await h.run(ops.draftPurchaseOrder, {
      supplierId: supplier.id,
      warehouseId: shop.warehouseId,
      lines: [{ variantId, quantity: '10' }],
    });
    // A draft is not on order.
    expect(await alertsFor(variantId, 'active')).toHaveLength(1);
    await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id, email: false });
    expect(await alertsFor(variantId, 'active')).toEqual([]);
    await h.run(ops.closePurchaseOrder, { purchaseOrderId: po.id });
    expect((await alertsFor(variantId, 'active')).map((a) => a.kind)).toEqual(['low_stock']);
  });

  it('never fires for a change that rolled back (A11)', async () => {
    const variantId = await stocked('6');
    await h.run(ops.setReorderRule, {
      variantId,
      warehouseId: shop.warehouseId,
      reorderPoint: '5',
      reorderQuantity: '10',
    });
    // The reservation takes available to 4, at or below the point, then fails before commit.
    const faulty = appDatabase(
      {
        beforeCommit: () => {
          throw new Error('simulated failure before commit');
        },
      },
      1,
    );
    const owner = await boundCaller(shop);
    await expect(
      execute({ db: faulty, audit: sink }, ops.reserveStock, {
        caller: owner,
        shopId: shop.shopId,
        input: { variantId, quantity: '2' },
        idempotencyKey: uuidv7(),
      }),
    ).rejects.toBeDefined();
    await faulty.close();
    const rows = await ownerQuery('select 1 from alerts where shop_id = $1 and variant_id = $2', [
      shop.shopId,
      variantId,
    ]);
    expect(rows).toEqual([]);
    expect(await alertsFor(variantId)).toEqual([]);
    // The same reservation, committed, opens it.
    await h.run(ops.reserveStock, { variantId, quantity: '2' });
    const [alert] = await alertsFor(variantId);
    expect(alert).toMatchObject({ kind: 'low_stock', status: 'open' });
    expect(
      (await outbox('alert.opened')).filter((o) => o.payload.alertId === alert!.id),
    ).toHaveLength(1);
  });

  it('is acknowledged by a manager, stays one alert, and resolves when the rule goes', async () => {
    const variantId = await stocked('1');
    const { rule } = await h.run(ops.setReorderRule, {
      variantId,
      warehouseId: shop.warehouseId,
      reorderPoint: '2',
      reorderQuantity: '5',
    });
    const [alert] = await alertsFor(variantId);
    const operator = await addMember(shop.shopId, 'inventory_operator');
    await expect(
      h.run(ops.acknowledgeAlert, { alertId: alert!.id }, { caller: operator.caller }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const acked = await h.run(ops.acknowledgeAlert, {
      alertId: alert!.id,
      note: 'Ordered by phone',
    });
    expect(acked.alert).toMatchObject({ status: 'acknowledged' });
    await order(variantId, '1');
    expect((await alertsFor(variantId, 'active')).map((a) => a.status)).toEqual(['acknowledged']);
    await h.run(ops.removeReorderRule, { ruleId: rule.id });
    expect((await alertsFor(variantId)).map((a) => [a.status])).toEqual([['resolved']]);
    const [row] = await ownerQuery<{ resolution: string }>(
      'select resolution from alerts where id = $1',
      [alert!.id],
    );
    expect(row!.resolution).toBe('rule_removed');
  });
});

describe('drafting from low stock (A35)', () => {
  it('drafts one order per supplier, receives half a line, and closes it', async () => {
    const a = (await h.run(ops.createSupplier, { name: `A ${uuidv7().slice(-6)}` })).supplier;
    const b = (await h.run(ops.createSupplier, { name: `B ${uuidv7().slice(-6)}` })).supplier;
    const cups = await stocked('2');
    const plates = await stocked('1');
    const bowls = await stocked('3');
    for (const [variantId, supplierId] of [
      [cups, a.id],
      [plates, a.id],
      [bowls, b.id],
    ] as const) {
      await h.run(ops.saveSupplierItem, { supplierId, variantId, lastCost: '6', preferred: true });
      await h.run(ops.setReorderRule, {
        variantId,
        warehouseId: shop.warehouseId,
        reorderPoint: '5',
        reorderQuantity: '20',
      });
    }
    const suggested = await h.run(ops.suggestFromLowStock, { warehouseId: shop.warehouseId });
    const mine = suggested.drafts.filter((d: { supplierId: string }) =>
      [a.id, b.id].includes(d.supplierId),
    );
    expect(mine).toHaveLength(2);
    const draftA = mine.find((d: { supplierId: string }) => d.supplierId === a.id);
    expect(draftA.lines.map((l: { variantId: string }) => l.variantId).sort()).toEqual(
      [cups, plates].sort(),
    );
    expect(draftA.lines[0]).toMatchObject({ need: '20', quantity: '20', unitCost: '6.000000' });

    // The person reviews and saves each draft.
    const pos = [];
    for (const d of mine) {
      pos.push(
        await h.run(ops.draftPurchaseOrder, {
          supplierId: d.supplierId,
          warehouseId: d.warehouseId,
          locationId: shop.locationId,
          lines: d.lines.map((l: { variantId: string; quantity: string }) => ({
            variantId: l.variantId,
            quantity: l.quantity,
          })),
        }),
      );
    }
    const poA = pos.find((p) => p.supplier.id === a.id);
    await h.run(ops.sendPurchaseOrder, { purchaseOrderId: poA.id, email: false });
    // Sent: on order now covers cups and plates, so nothing more is suggested for them.
    const again = await h.run(ops.suggestFromLowStock, { supplierId: a.id });
    expect(again.drafts).toEqual([]);

    const cupLine = poA.lines.find((l: { variantId: string }) => l.variantId === cups);
    await h.run(ops.receivePurchaseOrderLine, {
      purchaseOrderId: poA.id,
      lineId: cupLine.id,
      quantity: '10',
    });
    let stock = await h.run(ops.getAvailability, { variantId: cups });
    expect(stock.totals.onOrder).toBe('10');
    // 2 at 4.00 and 10 at 6.00: (8 + 60) / 12 = 5.666667.
    expect(stock.cost.averageCost).toBe('5.666667');
    await h.run(ops.closePurchaseOrder, { purchaseOrderId: poA.id });
    stock = await h.run(ops.getAvailability, { variantId: cups });
    expect(stock.totals.onOrder).toBe('0');
  });

  it('rounds up to the supplier’s pack and minimum order quantity, minus what is on order', async () => {
    const supplier = (await h.run(ops.createSupplier, { name: `P ${uuidv7().slice(-6)}` }))
      .supplier;
    const variantId = await stocked('4');
    const packs = await h.run(ops.setPacks, {
      variantId,
      packsVersion: 0,
      packs: [{ name: 'Case', quantity: '12' }],
    });
    const caseId = packs.packaging.packs[0].id;
    await h.run(ops.saveSupplierItem, {
      supplierId: supplier.id,
      variantId,
      packId: caseId,
      lastCost: '24',
      minimumOrderQuantity: '2',
      preferred: true,
    });
    // Up to 30: 30 − 4 = 26 units, 3 cases (36) by the pack; the minimum of 2 cases is met.
    const { rule } = await h.run(ops.setReorderRule, {
      variantId,
      warehouseId: shop.warehouseId,
      reorderPoint: '10',
      maximumLevel: '30',
    });
    let s = await h.run(ops.suggestFromLowStock, { ruleIds: [rule.id] });
    expect(s.drafts[0].lines[0]).toMatchObject({
      need: '26',
      packId: caseId,
      packFactor: '12',
      minimumOrderQuantity: '2',
      quantity: '3',
      ordered: '36',
    });
    // 20 already on order: 26 − 20 = 6 units is half a case, but the minimum is 2 cases.
    const po = await h.run(ops.draftPurchaseOrder, {
      supplierId: supplier.id,
      warehouseId: shop.warehouseId,
      lines: [{ variantId, packId: null, quantity: '20' }],
    });
    await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id, email: false });
    // On order (20) plus available (4) is above the point (10), so the rule is no longer low.
    s = await h.run(ops.suggestFromLowStock, { ruleIds: [rule.id] });
    expect(s.drafts).toEqual([]);
    await h.run(ops.setReorderRule, {
      ruleId: rule.id,
      expectedVersion: rule.version,
      reorderPoint: '25',
    });
    s = await h.run(ops.suggestFromLowStock, { ruleIds: [rule.id] });
    expect(s.drafts[0].lines[0]).toMatchObject({ need: '6', quantity: '2', ordered: '24' });
  });

  it('lists rules without a supplier separately', async () => {
    const variantId = await stocked('1');
    const { rule } = await h.run(ops.setReorderRule, {
      variantId,
      warehouseId: shop.warehouseId,
      reorderPoint: '3',
      reorderQuantity: '7',
    });
    const s = await h.run(ops.suggestFromLowStock, { ruleIds: [rule.id] });
    expect(s.drafts).toEqual([]);
    expect(s.withoutSupplier).toEqual([
      expect.objectContaining({ ruleId: rule.id, variantId, need: '7' }),
    ]);
  });

  it('refuses a second rule for the same place and a maximum not above the point', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setReorderRule, {
      variantId,
      warehouseId: shop.warehouseId,
      reorderPoint: '1',
      reorderQuantity: '2',
    });
    await expect(
      h.run(ops.setReorderRule, {
        variantId,
        warehouseId: shop.warehouseId,
        reorderPoint: '1',
        reorderQuantity: '2',
      }),
    ).rejects.toMatchObject({ code: 'reorder_rule_exists' });
    await expect(
      h.run(ops.setReorderRule, {
        variantId,
        warehouseId: shop.warehouseId,
        locationId: shop.locationId,
        reorderPoint: '5',
        maximumLevel: '5',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('other alert kinds', () => {
  it('opens a lot alert in the daily check within the shop’s window, and resolves it when sold out', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'lot_expiry' });
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '3',
      lotCode: 'SOON',
      expiresOn: soon,
    });
    await h.run(ops.receiveStock, {
      variantId,
      locationId: shop.locationId,
      quantity: '3',
      lotCode: 'LATER',
      expiresOn: later,
    });
    await checkShopAlerts(db, shop.shopId);
    let alerts = await alertsFor(variantId);
    expect(alerts.map((a) => [a.kind, a.details.lotCode, a.status])).toEqual([
      ['lot_expiring', 'SOON', 'open'],
    ]);
    // Running again does not open a second one.
    await checkShopAlerts(db, shop.shopId);
    expect(await alertsFor(variantId)).toHaveLength(1);
    // Earliest expiry first: an order of 3 takes the SOON lot, and the next check resolves it.
    await order(variantId, '3');
    await checkShopAlerts(db, shop.shopId);
    alerts = await alertsFor(variantId);
    expect(alerts.map((a) => a.status)).toEqual(['resolved']);
    // A wider window takes in the later lot.
    await h.run(ops.setAlertSettings, { lotExpiryAlertDays: 120 });
    await checkShopAlerts(db, shop.shopId);
    expect((await alertsFor(variantId, 'active')).map((a) => a.details.lotCode)).toEqual(['LATER']);
    await h.run(ops.setAlertSettings, { lotExpiryAlertDays: 30 });
  });

  it('opens one shortage alert per variant for connector orders and resolves it when filled', async () => {
    const variantId = await createVariant(h);
    const [m] = await ownerQuery<{ id: string }>(
      'select id from memberships where shop_id = $1 and user_id = $2',
      [shop.shopId, shop.userId],
    );
    const connector = {
      kind: 'connector' as const,
      id: uuidv7(),
      userId: null,
      boundShopId: shop.shopId,
      membership: {
        id: m!.id,
        role: 'inventory_operator' as const,
        allLocations: true,
        locationScopeIds: [],
        permissions: new Set(['inventory.read', 'inventory.reserve', 'inventory.fulfill'] as const),
      },
      scopes: new Set(['inventory:read', 'inventory:write'] as const),
      clientId: 'shopify',
      source: 'shopify' as const,
    };
    for (const ref of ['order/1', 'order/2']) {
      await h.run(
        ops.reserveStock,
        { variantId, quantity: '2', externalRef: ref, allowShortage: true },
        { caller: connector },
      );
    }
    let alerts = await alertsFor(variantId);
    expect(alerts.map((a) => [a.kind, a.status])).toEqual([['shortage', 'open']]);
    expect(alerts[0]!.details).toMatchObject({ shortage: '2.000000' });
    // Shop-wide: a member limited to a location does not see it.
    const scoped = await addMember(shop.shopId, 'manager', [shop.locationId]);
    const seen = await h.run(ops.listAlerts, { variantId }, { caller: scoped.caller });
    expect(seen.alerts).toEqual([]);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '4' });
    alerts = await alertsFor(variantId);
    expect(alerts.map((a) => a.status)).toEqual(['resolved']);
  });
});

describe('scope, preferences, and isolation', () => {
  it('shows a location’s alerts only to members whose scope covers it (A42), and emails them', async () => {
    const created = await h.run(ops.createWarehouse, { name: `Store ${uuidv7().slice(-4)}` });
    const storeBin = await createLeafLocation(h, created.warehouseId, 'Shelf');
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: storeBin, quantity: '1' });
    await h.run(ops.setReorderRule, {
      variantId,
      warehouseId: created.warehouseId,
      locationId: storeBin,
      reorderPoint: '2',
      reorderQuantity: '4',
    });
    const inStore = await addMember(shop.shopId, 'manager', [created.warehouseId]);
    const elsewhere = await addMember(shop.shopId, 'manager', [shop.locationId]);
    const viewer = await addMember(shop.shopId, 'viewer');
    const seenIn = await h.run(ops.listAlerts, { variantId }, { caller: inStore.caller });
    const seenOut = await h.run(ops.listAlerts, { variantId }, { caller: elsewhere.caller });
    expect(seenIn.alerts).toHaveLength(1);
    expect(seenOut.alerts).toEqual([]);
    await expect(
      h.run(ops.acknowledgeAlert, { alertId: seenIn.alerts[0].id }, { caller: elsewhere.caller }),
    ).rejects.toMatchObject({ code: 'not_found' });

    // The viewer opts in to low-stock email; the out-of-scope manager opts in too, but is not sent.
    await h.run(
      ops.setAlertPreferences,
      { preferences: [{ kind: 'low_stock', email: true }] },
      { caller: viewer.caller },
    );
    await h.run(
      ops.setAlertPreferences,
      { preferences: [{ kind: 'low_stock', email: false, inApp: false }] },
      { caller: inStore.caller },
    );
    const prefs = await h.run(ops.getAlertPreferences, {}, { caller: inStore.caller });
    expect(prefs.preferences.find((p: { kind: string }) => p.kind === 'low_stock')).toMatchObject({
      inApp: false,
      email: false,
      isDefault: false,
    });
    expect((await h.run(ops.alertSummary, {}, { caller: inStore.caller })).open).toBe(0);
    const sent: OutgoingEmail[] = [];
    await notifyAlertOpened(
      {
        db,
        email: {
          async send(m) {
            sent.push(m);
            return { id: uuidv7() };
          },
        },
        publicUrl: 'https://airstock.test',
      },
      shop.shopId,
      seenIn.alerts[0].id,
    );
    const [viewerEmail, inStoreEmail, elsewhereEmail] = await Promise.all(
      [viewer, inStore, elsewhere].map(
        async (m) =>
          (
            await ownerQuery<{ email: string }>('select email from users where id = $1', [m.userId])
          )[0]!.email,
      ),
    );
    const to = sent.map((s) => s.to);
    // The owner (default, every location) and the opted-in viewer; not the opted-out manager in
    // scope, and not the manager limited to another warehouse.
    expect(to).toContain(viewerEmail);
    expect(to).not.toContain(inStoreEmail);
    expect(to).not.toContain(elsewhereEmail);
  });

  it('keeps rules, alerts, and notifications apart between shops (A13)', async () => {
    const other = await seedShop(db, sink, 'Other alerts shop');
    const o = harness(db, sink, other);
    const variantId = await createVariant(o);
    await o.run(ops.setReorderRule, {
      variantId,
      warehouseId: other.warehouseId,
      reorderPoint: '1',
      reorderQuantity: '1',
    });
    const [foreign] = (await o.run(ops.listAlerts, {})).alerts;
    expect(foreign).toBeDefined();
    await expect(h.run(ops.acknowledgeAlert, { alertId: foreign.id })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      h.run(ops.setReorderRule, {
        variantId,
        warehouseId: shop.warehouseId,
        reorderPoint: '1',
        reorderQuantity: '1',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await h.run(ops.listAlerts, { variantId })).alerts).toEqual([]);
    for (const table of ['reorder_rules', 'alerts', 'alert_subscriptions', 'notifications']) {
      const rows = await db.transaction(
        { shopId: shop.shopId, userId: null, readOnly: true },
        (tx) => tx.query<{ shop_id: string }>(`select shop_id from ${table}`),
      );
      expect(
        rows.filter((r) => r.shop_id !== shop.shopId),
        table,
      ).toEqual([]);
    }
  });
});

async function ownerMembership(): Promise<string> {
  const [m] = await ownerQuery<{ id: string }>(
    'select id from memberships where shop_id = $1 and user_id = $2',
    [shop.shopId, shop.userId],
  );
  return m!.id;
}
