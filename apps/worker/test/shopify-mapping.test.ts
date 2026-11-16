import { runImportJob, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../../test/helpers.ts';
import { json } from './setup.ts';
import { type Merchant, type ShopifyHarness, shopifyHarness } from './shopify-harness.ts';

// I6, part 1: location and variant maps (packs and bundles) and the onboarding import.

let h: ShopifyHarness;
beforeAll(async () => {
  h = await shopifyHarness();
});
afterAll(() => h.t.close());

async function packs(
  m: Merchant,
  variantId: string,
  list: Array<{ name: string; quantity: string }>,
) {
  const res = await h.command(m.cookie, `/shops/${m.shopId}/variants/${variantId}/packs`, {
    variantId,
    packsVersion: 0,
    packs: list,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = await json(res);
  return Object.fromEntries(
    (body.packaging.packs as Array<{ id: string; name: string }>).map((p) => [p.name, p.id]),
  );
}

async function connections(m: Merchant) {
  return (await json(await h.dashboard(m.cookie, `/shops/${m.shopId}/shopify/connections`)))
    .connections;
}

describe('location maps', () => {
  it('maps Shopify locations to a warehouse or a location, lists the rest, refuses overlaps', async () => {
    const m = await h.merchant('Two locations');
    const store = h.newStore('locs');
    store.locationList = [
      { id: '2001', name: 'Shop', active: true },
      { id: '2002', name: 'Back room', active: true },
      { id: '2003', name: 'Pop-up', active: true },
    ];
    const connectionId = await h.install(m, store);
    // A second warehouse with a shelf inside.
    const warehouse = await json(
      await h.command(m.cookie, `/shops/${m.shopId}/warehouses`, { name: 'Rented' }),
    );
    const shelf = await json(
      await h.command(m.cookie, `/shops/${m.shopId}/locations`, {
        warehouseId: warehouse.warehouseId,
        name: 'Shelf A',
      }),
    );
    const overlap = await h.command(
      m.cookie,
      `/shops/${m.shopId}/shopify/connections/${connectionId}/locations`,
      {
        connectionId,
        locations: [
          { shopifyLocationId: '2001', warehouseId: warehouse.warehouseId },
          { shopifyLocationId: '2002', locationId: shelf.locationId },
        ],
      },
    );
    expect(overlap.status).toBe(422);
    expect((await json(overlap)).code).toBe('scopes_overlap');

    const res = await h.command(
      m.cookie,
      `/shops/${m.shopId}/shopify/connections/${connectionId}/locations`,
      {
        connectionId,
        locations: [
          { shopifyLocationId: '2001', locationId: m.locationId },
          { shopifyLocationId: 'gid://shopify/Location/2002', warehouseId: warehouse.warehouseId },
        ],
      },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const [c] = await connections(m);
    expect(
      c.locationMaps.map((l: { shopifyLocationId: string; receiveLocationId: string }) => [
        l.shopifyLocationId,
        l.receiveLocationId,
      ]),
    ).toEqual([
      ['2001', m.locationId],
      ['2002', shelf.locationId],
    ]);
    expect(c.unmappedLocations.map((l: { id: string }) => l.id)).toEqual(['2003']);
    // Orders of this connection are allocated from the mapped scopes, in this order (D3).
    const rule = await ownerQuery<{ scope_id: string }>(
      `select l.scope_id from allocation_rules r join allocation_rule_locations l
         on l.shop_id = r.shop_id and l.rule_id = r.id
       where r.shop_id = $1 and r.channel = $2 order by l.position`,
      [m.shopId, `shopify:${connectionId}`],
    );
    expect(rule.map((r) => r.scope_id)).toEqual([m.locationId, warehouse.warehouseId]);
  });
});

describe('packs and bundles in Shopify', () => {
  it('A28: 3 cases of 24, then Shopify sells 5 singles and a 6-pack: 61 left, the 6-pack shows 10', async () => {
    const m = await h.merchant('A28');
    const sku = `CAN-${uuidv7().slice(-6)}`;
    const can = await h.item(m, 'Sparkling water', sku);
    const ids = await packs(m, can.variantId, [
      { name: 'Case', quantity: '24' },
      { name: '6-pack', quantity: '6' },
    ]);
    await h.receive(m, can.variantId, 3, { packId: ids.Case });
    expect(await h.available(m, can.variantId)).toBe('72.000000');

    const store = h.newStore('a28');
    const [single] = store.addProduct({
      title: 'Sparkling water',
      variants: [{ sku, quantities: { '1001': 0 } }],
    });
    const [sixPack] = store.addProduct({
      title: 'Sparkling water 6-pack',
      variants: [{ sku: `${sku}-6`, quantities: { '1001': 0 } }],
    });
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
    const mapped = await h.command(m.cookie, `${base}/variants`, {
      connectionId,
      variants: [
        {
          shopifyVariantId: single!.variantId,
          shopifyInventoryItemId: single!.inventoryItemId,
          variantId: can.variantId,
        },
        {
          shopifyVariantId: sixPack!.variantId,
          shopifyInventoryItemId: sixPack!.inventoryItemId,
          variantId: can.variantId,
          packId: ids['6-pack'],
        },
      ],
    });
    expect(mapped.status, await mapped.clone().text()).toBe(200);
    await h.flush(m.shopId);
    expect(store.available(single!)).toBe(72);
    expect(store.available(sixPack!)).toBe(12);

    // Two Shopify variants may not sell the same pack.
    const twice = await h.command(m.cookie, `${base}/variants`, {
      connectionId,
      variants: [
        {
          shopifyVariantId: '999999',
          shopifyInventoryItemId: '999998',
          variantId: can.variantId,
          packId: ids['6-pack'],
        },
      ],
    });
    expect(twice.status).toBe(409);

    const order = store.placeOrder([
      { variant: single!, quantity: 5 },
      { variant: sixPack!, quantity: 1 },
    ]);
    expect((await h.deliver(store.domain, 'orders/create', store.webhookBody(order))).status).toBe(
      200,
    );
    expect(await h.runJobs(m.shopId)).toEqual([{ status: 'done' }]);
    expect(await h.available(m, can.variantId)).toBe('61.000000');
    await h.flush(m.shopId);
    expect(store.available(single!)).toBe(61);
    expect(store.available(sixPack!)).toBe(10);
    expect(store.refused).toHaveLength(0);
    const reserved = await ownerQuery<{ quantity: string }>(
      `select quantity::text from reservations where shop_id = $1 order by quantity`,
      [m.shopId],
    );
    expect(reserved.map((r) => r.quantity)).toEqual(['5.000000', '6.000000']);
  });

  it('A36: a bundle shows its computed availability, and a component change pushes it', async () => {
    const m = await h.merchant('A36');
    const suffix = uuidv7().slice(-6);
    const soap = await h.item(m, 'Soap', `SOAP-${suffix}`);
    const candle = await h.item(m, 'Candle', `CANDLE-${suffix}`);
    const gift = await h.item(m, 'Gift set', `GIFT-${suffix}`);
    const bundle = await h.command(
      m.cookie,
      `/shops/${m.shopId}/variants/${gift.variantId}/bundle`,
      {
        variantId: gift.variantId,
        bundleVersion: 0,
        components: [
          { variantId: soap.variantId, quantity: '2' },
          { variantId: candle.variantId, quantity: '1' },
        ],
      },
    );
    expect(bundle.status, await bundle.clone().text()).toBe(200);
    await h.receive(m, soap.variantId, 5);
    await h.receive(m, candle.variantId, 10);

    const store = h.newStore('a36');
    const [giftSet] = store.addProduct({
      title: 'Gift set',
      variants: [{ sku: `GIFT-${suffix}`, quantities: { '1001': 0 } }],
    });
    const [soapItem] = store.addProduct({
      title: 'Soap',
      variants: [{ sku: `SOAP-${suffix}`, quantities: { '1001': 0 } }],
    });
    const connectionId = await h.install(m, store);
    const base = `/shops/${m.shopId}/shopify/connections/${connectionId}`;
    await h.command(m.cookie, `${base}/locations`, {
      connectionId,
      locations: [{ shopifyLocationId: '1001', warehouseId: m.warehouseId }],
    });
    await h.command(m.cookie, `${base}/variants`, {
      connectionId,
      variants: [
        {
          shopifyVariantId: giftSet!.variantId,
          shopifyInventoryItemId: giftSet!.inventoryItemId,
          variantId: gift.variantId,
        },
        {
          shopifyVariantId: soapItem!.variantId,
          shopifyInventoryItemId: soapItem!.inventoryItemId,
          variantId: soap.variantId,
        },
      ],
    });
    await h.flush(m.shopId);
    // 5 soaps at 2 per set: 2 sets.
    expect(store.available(giftSet!)).toBe(2);
    expect(store.available(soapItem!)).toBe(5);

    // Shopify sells 1 gift set: its components are reserved; both items follow.
    const order = store.placeOrder([{ variant: giftSet!, quantity: 1 }]);
    await h.deliver(store.domain, 'orders/create', store.webhookBody(order));
    await h.runJobs(m.shopId);
    await h.flush(m.shopId);
    expect(store.available(giftSet!)).toBe(1);
    expect(store.available(soapItem!)).toBe(3);

    // A soap receipt is a change of the bundle's component: the bundle is pushed too.
    await h.receive(m, soap.variantId, 4);
    const outcomes = await h.flush(m.shopId);
    expect(outcomes.map((o) => o.inventoryItemId).sort()).toEqual(
      [giftSet!.inventoryItemId, soapItem!.inventoryItemId].sort(),
    );
    expect(store.available(giftSet!)).toBe(3);
    expect(store.available(soapItem!)).toBe(7);
    expect(store.refused).toHaveLength(0);
  });
});

describe('onboarding import', () => {
  it('reads with a bulk operation, previews matches, commits, maps, receives, and references pictures', async () => {
    const m = await h.merchant('Onboarding');
    const suffix = uuidv7().slice(-6);
    // Already in Airstock: one by SKU, one whose 6-pack carries the barcode Shopify uses.
    const mug = await h.item(m, 'Mug', `MUG-${suffix}`);
    const tea = await h.item(m, 'Tea', `TEA-${suffix}`);
    await h.receive(m, mug.variantId, 4);
    const teaPacks = await packs(m, tea.variantId, [{ name: '6-pack', quantity: '6' }]);
    const gtin = `40${String(Date.now()).slice(-10)}`;
    const check = (() => {
      const digits = gtin.split('').map(Number);
      const sum = digits.reduce((s, d, i) => s + d * (i % 2 === 0 ? 1 : 3), 0);
      return (10 - (sum % 10)) % 10;
    })();
    const teaBarcode = `${gtin}${check}`;
    const barcodes = await h.command(
      m.cookie,
      `/shops/${m.shopId}/variants/${tea.variantId}/barcodes`,
      {
        variantId: tea.variantId,
        barcodesVersion: 0,
        barcodes: [{ code: teaBarcode, symbology: 'ean13', packId: teaPacks['6-pack'] }],
      },
    );
    expect(barcodes.status, await barcodes.clone().text()).toBe(200);

    const store = h.newStore('onboard');
    store.bulkPolls = 2;
    const [shopifyMug] = store.addProduct({
      title: 'Mug',
      variants: [{ sku: `mug-${suffix}`, quantities: { '1001': 9 } }],
    });
    const [shopifyTea] = store.addProduct({
      title: 'Tea 6-pack',
      variants: [{ sku: null, barcode: teaBarcode, quantities: { '1001': 2 } }],
    });
    const shirts = store.addProduct({
      title: 'Shirt',
      description: 'Soft cotton.',
      options: ['Size', 'Color'],
      images: ['https://cdn.shopify.com/s/files/shirt-front.jpg'],
      variants: [
        {
          sku: `SHIRT-S-${suffix}`,
          price: '19.90',
          options: ['S', 'Red'],
          quantities: { '1001': 3, '1002': 5 },
        },
        {
          sku: `SHIRT-M-${suffix}`,
          price: '19.90',
          options: ['M', 'Red'],
          quantities: { '1001': -2, '1002': 1 },
          image: 'https://cdn.shopify.com/s/files/shirt-m.png',
        },
      ],
    });
    store.addProduct({
      title: 'Old poster',
      status: 'ARCHIVED',
      variants: [{ sku: `POSTER-${suffix}`, quantities: { '1001': 1 } }],
    });
    const connectionId = await h.install(m, store);
    const base = `/shops/${m.shopId}/shopify/connections/${connectionId}`;
    // Only the shop location is mapped: the warehouse's quantities are listed, not imported.
    await h.command(m.cookie, `${base}/locations`, {
      connectionId,
      locations: [{ shopifyLocationId: '1001', locationId: m.locationId }],
    });

    const started = await h.command(m.cookie, `${base}/onboardings`, { connectionId });
    expect(started.status, await started.clone().text()).toBe(201);
    const onboardingId = (await json(started)).onboarding.onboardingId as string;
    expect((await h.command(m.cookie, `${base}/onboardings`, { connectionId })).status).toBe(409);

    // The first run starts the bulk read; a crash before the next run loses nothing: the same
    // operation is polled again.
    expect(await h.runOnboardingSteps(m.shopId, onboardingId, 1)).toEqual([
      { status: 'again', delaySeconds: 5 },
    ]);
    await h.runOnboardingSteps(m.shopId, onboardingId);
    expect(store.bulkReads).toHaveLength(1);

    const viewed = await json(
      await h.dashboard(m.cookie, `/shops/${m.shopId}/shopify/onboardings/${onboardingId}`),
    );
    expect(viewed.onboarding.status).toBe('previewed');
    expect(viewed.onboarding.counts).toMatchObject({ sku: 1, barcode: 1, new: 2, skipped: 1 });
    expect(viewed.onboarding.unmappedLocations).toEqual([{ id: '1002', name: 'Warehouse' }]);
    const byVariant = new Map(
      (
        viewed.rows as Array<{ shopifyVariantId: string; match: string; packId: string | null }>
      ).map((r) => [r.shopifyVariantId, r]),
    );
    expect(byVariant.get(shopifyMug!.variantId)?.match).toBe('sku');
    expect(byVariant.get(shopifyTea!.variantId)).toMatchObject({
      match: 'barcode',
      packId: teaPacks['6-pack'],
    });
    // The import preview the person reviews: two new shirts, no errors.
    const preview = await json(
      await h.dashboard(m.cookie, `/shops/${m.shopId}/imports/${viewed.onboarding.importId}`),
    );
    expect(preview.import.counts).toMatchObject({ creates: 2, errors: 0 });

    const committed = await h.command(
      m.cookie,
      `/shops/${m.shopId}/shopify/onboardings/${onboardingId}/commit`,
      {},
    );
    expect(committed.status, await committed.clone().text()).toBe(200);
    // Waits for the import job, which then writes the records and opening stock.
    expect(await h.runOnboardingSteps(m.shopId, onboardingId, 1)).toEqual([
      { status: 'again', delaySeconds: 15 },
    ]);
    expect(
      await runImportJob(
        { db: h.t.db, audit: h.t.sink, files: h.deps().files! },
        m.shopId,
        viewed.onboarding.importId,
      ),
    ).toBe('done');
    await h.runOnboardingSteps(m.shopId, onboardingId);
    const done = await json(
      await h.dashboard(m.cookie, `/shops/${m.shopId}/shopify/onboardings/${onboardingId}`),
    );
    expect(done.onboarding.status).toBe('completed');
    expect(done.onboarding.counts).toMatchObject({ mapped: 4, pictures: 2 });

    // Every matched and new variant is mapped; the tea sells the 6-pack.
    const maps = await ownerQuery<{
      shopify_variant_id: string;
      pack_id: string | null;
      source: string;
    }>(
      `select shopify_variant_id, pack_id, source from shopify_variant_maps
       where shop_id = $1 order by shopify_variant_id`,
      [m.shopId],
    );
    expect(maps).toHaveLength(4);
    expect(maps.find((x) => x.shopify_variant_id === shopifyTea!.variantId)).toMatchObject({
      pack_id: teaPacks['6-pack'],
      source: 'barcode',
    });
    // Opening stock: Shopify's available at the mapped location, never below zero. The matched
    // mug keeps Airstock's 4.
    const stock = await ownerQuery<{ sku: string; on_hand: string; reason: string | null }>(
      `select v.sku, sum(p.on_hand)::text as on_hand,
         (select o.reason from inventory_operations o join inventory_entries e
            on e.shop_id = o.shop_id and e.operation_id = o.id
          where e.variant_id = v.id order by o.occurred_at limit 1) as reason
       from variants v join inventory_positions p on p.shop_id = v.shop_id and p.variant_id = v.id
       where v.shop_id = $1 group by v.id, v.sku order by v.sku`,
      [m.shopId],
    );
    expect(stock.map((s) => [s.sku, s.on_hand])).toEqual([
      [`MUG-${suffix}`, '4.000000'],
      [`SHIRT-S-${suffix}`, '3.000000'],
    ]);
    expect(stock.find((s) => s.sku.startsWith('SHIRT'))?.reason).toBe('opening stock');
    // Pictures are referenced by their Shopify URL, not copied (D17).
    const pictures = await ownerQuery<{
      external_url: string;
      variant: boolean;
      is_primary: boolean;
    }>(
      `select a.external_url, l.variant_id is not null as variant, l.is_primary
       from media_links l join media_assets a on a.shop_id = l.shop_id and a.id = l.media_id
       where l.shop_id = $1 order by a.external_url`,
      [m.shopId],
    );
    expect(pictures).toEqual([
      {
        external_url: 'https://cdn.shopify.com/s/files/shirt-front.jpg',
        variant: false,
        is_primary: true,
      },
      {
        external_url: 'https://cdn.shopify.com/s/files/shirt-m.png',
        variant: true,
        is_primary: true,
      },
    ]);
    const shirt = await ownerQuery<{ product_id: string }>(
      'select product_id from variants where shop_id = $1 and sku = $2',
      [m.shopId, `SHIRT-S-${suffix}`],
    );
    const detail = await json(
      await h.dashboard(m.cookie, `/shops/${m.shopId}/products/${shirt[0]!.product_id}/media`),
    );
    expect(detail.media.map((x: { thumbnail: { url: string } }) => x.thumbnail.url).sort()).toEqual(
      [
        'https://cdn.shopify.com/s/files/shirt-front.jpg?width=320',
        'https://cdn.shopify.com/s/files/shirt-m.png?width=320',
      ],
    );

    // The mapped levels are pushed: Shopify now shows Airstock's numbers.
    await h.flush(m.shopId);
    expect(store.available(shirts[0]!)).toBe(3);
    expect(store.available(shirts[1]!)).toBe(0);
    expect(store.available(shopifyMug!)).toBe(4);
  });
});
