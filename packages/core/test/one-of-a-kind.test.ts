import { ops } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  appDatabase,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
  ownerQuery,
  reconcile,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';

// One-of-a-kind items both ways (D5): a one-of-a-kind variant (quick add, the one-unit limit,
// "sold" after fulfillment, back in stock when it returns) and a serialized shared variant.

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;

beforeAll(async () => {
  shop = await seedShop(db, sink);
  h = harness(db, sink, shop);
  await h.run(ops.addTemplate, { template: 'trading_cards' });
  await h.run(ops.addTemplate, { template: 'building_sets' });
});
afterAll(() => db.close());

describe('a one-of-a-kind item', () => {
  it('is created and received in one command, found by its certificate, sold, and back when it returns', async () => {
    const added = await h.run(ops.quickAdd, {
      locationId: shop.locationId,
      name: 'Charizard Base Set PSA 10',
      barcode: 'PSA-12345678',
      price: '450',
      family: 'Trading cards',
      fields: {
        game: 'Pokémon',
        card_condition: 'NM',
        grading_company: 'PSA',
        grade: '10',
        certificate_number: '12345678',
      },
      unitCost: '300',
    });
    expect(added).toMatchObject({ created: true, sku: 'PSA-12345678' });
    const { item } = await h.run(ops.getItem, { productId: added.productId });
    expect(item.product).toMatchObject({ status: 'active', family: { name: 'Trading cards' } });
    expect(item.variants[0]).toMatchObject({ oneOfAKind: true, price: '450.000000' });
    expect(item.variants[0].fields.grade.value).toBe('10');
    const scanned = await h.run(ops.lookupBarcode, { code: 'psa-12345678' });
    expect(scanned.match).toMatchObject({ variantId: added.variantId });
    // Product creation and the receipt each have their own event, plus the quick add itself.
    const actions = (
      await ownerQuery<{ action: string }>(
        `select action from audit_events where shop_id = $1 and outcome = 'succeeded'
           and (target_id = $2 or target_id = $3)`,
        [shop.shopId, added.variantId, added.productId],
      )
    ).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'catalog.item.created',
        'inventory.receipt.created',
        'inventory.quick_add.created',
      ]),
    );

    await expect(
      h.run(ops.receiveStock, {
        variantId: added.variantId,
        locationId: shop.locationId,
        quantity: '1',
      }),
    ).rejects.toMatchObject({ code: 'one_of_a_kind' });

    const order = await h.run(ops.reserveStock, { variantId: added.variantId, quantity: '1' });
    const shipped = await h.run(ops.fulfillReservation, { reservationId: order.reservationId });
    expect(shipped.costOfGoods).toBe('300.000000');
    expect((await h.run(ops.getItem, { productId: added.productId })).item.product.status).toBe(
      'sold',
    );
    const visible = await h.run(ops.queryItems, { search: 'Charizard Base Set PSA 10' });
    expect(visible.rows).toHaveLength(0);
    const sold = await h.run(ops.queryItems, { search: 'Charizard Base Set PSA 10', sold: 'only' });
    expect(sold.rows).toHaveLength(1);

    // Bought back (or returned): in stock and active again, history kept.
    await h.run(ops.receiveStock, {
      variantId: added.variantId,
      locationId: shop.locationId,
      quantity: '1',
    });
    expect((await h.run(ops.getItem, { productId: added.productId })).item.product.status).toBe(
      'active',
    );
    expect(await reconcile(shop.shopId)).toEqual([]);
  });

  it('refuses the setting while more than one unit is in stock, and with lot or serial tracking', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '2' });
    await expect(
      h.run(ops.setStockSettings, { variantId, oneOfAKind: true }),
    ).rejects.toMatchObject({
      code: 'one_of_a_kind',
    });
    const fresh = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId: fresh, trackingMode: 'lot' });
    await expect(
      h.run(ops.setStockSettings, { variantId: fresh, oneOfAKind: true }),
    ).rejects.toMatchObject({ code: 'one_of_a_kind_untracked' });
  });

  it('needs inventory.receive as well as catalog.write', async () => {
    const editor = await addMember(shop.shopId, 'catalog_editor');
    await expect(
      h.run(
        ops.quickAdd,
        { locationId: shop.locationId, name: 'Used set 10179' },
        { caller: editor.caller },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('a serialized shared variant', () => {
  it('adds units that share a price, each with its serial, and refuses a duplicate', async () => {
    const variantId = await createVariant(h);
    await h.run(ops.setStockSettings, { variantId, trackingMode: 'serial' });
    const first = await h.run(ops.quickAdd, {
      locationId: shop.locationId,
      variantId,
      serial: 'CERT-001',
    });
    expect(first).toMatchObject({ created: false, receipt: { serialId: expect.any(String) } });
    await h.run(ops.quickAdd, { locationId: shop.locationId, variantId, serial: 'CERT-002' });
    await expect(
      h.run(ops.quickAdd, { locationId: shop.locationId, variantId, serial: 'cert-001' }),
    ).rejects.toMatchObject({ code: 'serial_exists' });
    const view = await h.run(ops.getAvailability, { variantId });
    expect(view.totals.available).toBe('2.000000');
    expect(view.positions.map((p: { serial: string }) => p.serial).sort()).toEqual([
      'CERT-001',
      'CERT-002',
    ]);
    // A unit without its serial cannot be added to a serialized variant.
    await expect(
      h.run(ops.quickAdd, { locationId: shop.locationId, variantId }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
