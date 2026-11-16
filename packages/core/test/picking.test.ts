import { type Caller, ops, uuidv7 } from '@airstock/core';
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

// Pick lists (plan 5.11, PRD 6.10), A41 pick half: a list for 20 orders in location-path order;
// picks never change stock; another lot reallocates; a short pick is flagged with the position to
// count; completing fulfills manual and API reservations and only records Shopify orders' picks.
// Also shop isolation (A13) and location scope (A42).

// biome-ignore lint/suspicious/noExplicitAny: tests read many result shapes
type Row = Record<string, any>;

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
const loc: Record<string, string> = {};

async function location(code: string): Promise<string> {
  const res = await h.run(ops.createLocation, {
    warehouseId: shop.warehouseId,
    name: `Shelf ${code}`,
    code,
  });
  return res.locationId as string;
}

function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

async function onHand(shopId: string): Promise<string> {
  const [row] = await ownerQuery<{ total: string }>(
    'select coalesce(sum(on_hand), 0)::text as total from inventory_positions where shop_id = $1',
    [shopId],
  );
  return row!.total;
}

async function entries(shopId: string): Promise<number> {
  const [row] = await ownerQuery<{ n: number }>(
    'select count(*)::int as n from inventory_entries where shop_id = $1',
    [shopId],
  );
  return row!.n;
}

async function connector(s: SeededShop): Promise<Caller> {
  const [m] = await ownerQuery<{ id: string }>(
    'select id from memberships where shop_id = $1 and user_id = $2',
    [s.shopId, s.userId],
  );
  return {
    kind: 'connector',
    id: uuidv7(),
    userId: null,
    boundShopId: s.shopId,
    membership: {
      id: m!.id,
      role: 'inventory_operator',
      allLocations: true,
      locationScopeIds: [],
      permissions: new Set(['inventory.read', 'inventory.reserve', 'inventory.fulfill']),
    },
    scopes: new Set(['inventory:read', 'inventory:write']),
    clientId: 'shopify',
    source: 'shopify',
  };
}

let boxes: string; // plain, sold in cases of 6, at C-01 and A-02
let cards: string; // plain, at A-01
let food: string; // lot-tracked with expiry, two lots at B-01
const orders: string[] = [];

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Picking shop');
  h = harness(db, sink, shop);
  // Created out of path order, so sorting is the list's doing.
  for (const code of ['C-01', 'A-02', 'B-01', 'A-01']) loc[code] = await location(code);
  boxes = await createVariant(h, 'BOX-PICK');
  await h.run(ops.setPacks, {
    variantId: boxes,
    packsVersion: 0,
    packs: [{ name: 'Case', quantity: '6' }],
  });
  cards = await createVariant(h, 'CARD-PICK');
  food = await createVariant(h, 'FOOD-PICK');
  await h.run(ops.setStockSettings, { variantId: food, trackingMode: 'lot_expiry' });
  await h.run(ops.receiveStock, { variantId: boxes, locationId: loc['C-01'], quantity: '40' });
  await h.run(ops.receiveStock, { variantId: boxes, locationId: loc['A-02'], quantity: '10' });
  await h.run(ops.receiveStock, { variantId: cards, locationId: loc['A-01'], quantity: '30' });
  await h.run(ops.receiveStock, {
    variantId: food,
    locationId: loc['B-01'],
    quantity: '10',
    lotCode: 'LATE',
    expiresOn: day(90),
  });
  await h.run(ops.receiveStock, {
    variantId: food,
    locationId: loc['B-01'],
    quantity: '10',
    lotCode: 'SOON',
    expiresOn: day(30),
  });
  // 20 orders: boxes in sevens (one case and a single, from two shelves), cards, and food.
  for (let i = 1; i <= 20; i++) {
    const variantId = i % 3 === 0 ? food : i % 3 === 1 ? cards : boxes;
    const quantity = variantId === boxes ? '7' : '1';
    const r = await h.run(ops.reserveStock, {
      variantId,
      quantity,
      purpose: 'external_order',
      externalRef: `api:order/${1000 + i}`,
    });
    orders.push(r.reservationId);
  }
});
afterAll(() => db.close());

describe('pick lists (A41, pick half)', () => {
  let list: {
    pickListId: string;
    number: number;
    pickLines: Row[];
    orders: number;
  };

  it('builds one list for 20 orders, walked in location-path order', async () => {
    list = await h.run(ops.createPickList, {
      orders: orders.map((_, i) => `api:order/${1001 + i}`),
    });
    expect(list.orders).toBe(20);
    expect(list.number).toBe(1);
    const paths = list.pickLines.map((l) => l.locationPath);
    expect(paths).toEqual([...paths].sort());
    expect(new Set(paths)).toEqual(
      new Set(['Main stock/A-01', 'Main stock/A-02', 'Main stock/B-01', 'Main stock/C-01']),
    );
    expect(list.pickLines.map((l) => l.sequence)).toEqual(list.pickLines.map((_, i) => i + 1));
    // Each line names its order, its lot, and its quantity in packs.
    const food1 = list.pickLines.find((l) => l.externalRef === 'api:order/1003')!;
    expect(food1).toMatchObject({ sku: 'FOOD-PICK', lotCode: 'SOON', quantity: '1' });
    const box = list.pickLines.find((l) => l.sku === 'BOX-PICK' && l.quantity === '7');
    expect(box?.inPacks).toEqual({
      packs: [expect.objectContaining({ name: 'Case', count: '1' })],
      looseUnits: '1',
    });
    // One order of 7 spans two shelves, so it has two lines.
    const split = list.pickLines.filter((l) => l.sku === 'BOX-PICK' && l.quantity !== '7');
    expect(split.map((l) => l.quantity).sort()).toEqual(['2', '5']);
    for (const line of list.pickLines) {
      expect(line).toMatchObject({ status: 'open', picked: '0', fulfillOnComplete: true });
      expect(line.externalRef).toMatch(/^api:order\/10\d\d$/);
    }
  });

  it('leaves allocations already on an open list out of the next one', async () => {
    await expect(h.run(ops.createPickList, { orders: ['api:order/1001'] })).rejects.toMatchObject({
      code: 'nothing_to_pick',
    });
  });

  it('records picks without changing stock', async () => {
    const stockBefore = await onHand(shop.shopId);
    const ledgerBefore = await entries(shop.shopId);
    const cardLines = list.pickLines.filter((l) => l.sku === 'CARD-PICK');
    for (const line of cardLines) {
      const res = await h.run(ops.recordPick, { pickListId: list.pickListId, lineId: line.lineId });
      expect(res.line).toMatchObject({ status: 'picked', picked: '1', remaining: '0' });
      expect(res.reallocated).toBeNull();
    }
    await expect(
      h.run(ops.recordPick, { pickListId: list.pickListId, lineId: cardLines[0]!.lineId }),
    ).rejects.toMatchObject({ code: 'line_complete' });
    expect(await onHand(shop.shopId)).toBe(stockBefore);
    expect(await entries(shop.shopId)).toBe(ledgerBefore);
  });

  it('reallocates when the picker takes another lot', async () => {
    const line = list.pickLines.find((l) => l.externalRef === 'api:order/1003')!;
    const res = await h.run(ops.recordPick, {
      pickListId: list.pickListId,
      lineId: line.lineId,
      lotCode: 'late',
    });
    expect(res.reallocated).toMatchObject({ quantity: '1' });
    expect(res.line).toMatchObject({ status: 'moved', moved: '1', remaining: '0' });
    expect(res.newLines).toEqual([
      expect.objectContaining({ status: 'picked', picked: '1', lotCode: 'LATE', sku: 'FOOD-PICK' }),
    ]);
    // The reservation itself now holds the LATE lot.
    const [alloc] = await ownerQuery<{ code: string }>(
      `select lt.code from reservation_allocations a
       join inventory_positions p on p.shop_id = a.shop_id and p.id = a.position_id
       join lots lt on lt.shop_id = p.shop_id and lt.id = p.lot_id
       where a.reservation_id = $1 and a.outstanding > 0`,
      [orders[2]],
    );
    expect(alloc?.code).toBe('LATE');
    // The reallocation is its own audit event, written with the pick.
    const events = await ownerQuery<{ action: string }>(
      `select action from audit_events where shop_id = $1 and target_id = $2
         and action = 'inventory.reservation.reallocated'`,
      [shop.shopId, orders[2]],
    );
    expect(events).toHaveLength(1);
  });

  it('flags a short pick and names the position to count', async () => {
    const box = list.pickLines.find((l) => l.sku === 'BOX-PICK' && l.quantity === '7')!;
    const res = await h.run(ops.recordShortPick, {
      pickListId: list.pickListId,
      lineId: box.lineId,
      found: '5',
      reason: 'Only five on the shelf',
    });
    expect(res.line).toMatchObject({ status: 'short', picked: '5', short: '2', remaining: '0' });
    expect(res.count).toMatchObject({
      positionId: box.positionId,
      locationId: box.locationId,
      variantId: boxes,
      missing: '2',
    });
    await expect(
      h.run(ops.recordShortPick, {
        pickListId: list.pickListId,
        lineId: list.pickLines.find(
          (l) => l.sku === 'BOX-PICK' && l.status === 'open' && l.lineId !== box.lineId,
        )!.lineId,
        found: '99',
      }),
    ).rejects.toMatchObject({ code: 'not_short' });
  });

  it('refuses to complete with open lines, then fulfills what was picked', async () => {
    await expect(
      h.run(ops.completePickList, { pickListId: list.pickListId }),
    ).rejects.toMatchObject({ code: 'lines_open' });
    const current = await h.run(ops.getPickList, { pickListId: list.pickListId });
    for (const line of current.pickLines.filter((l: { status: string }) => l.status === 'open')) {
      await h.run(ops.recordPick, { pickListId: list.pickListId, lineId: line.lineId });
    }
    const before = await onHand(shop.shopId);
    const picked = (await h.run(ops.getPickList, { pickListId: list.pickListId })).pickLines.reduce(
      (sum: number, l: { picked: string }) => sum + Number(l.picked),
      0,
    );
    const done = await h.run(ops.completePickList, { pickListId: list.pickListId });
    expect(done.status).toBe('completed');
    expect(done.recordedOnly).toEqual([]);
    expect(Number(await onHand(shop.shopId))).toBe(Number(before) - picked);
    // The short box order keeps its 2 missing units reserved; the rest are fulfilled.
    const statuses = await ownerQuery<{ status: string; n: number }>(
      `select status, count(*)::int as n from reservations where id = any($1::uuid[]) group by status`,
      [orders],
    );
    expect(statuses).toEqual(
      expect.arrayContaining([
        { status: 'fulfilled', n: 19 },
        { status: 'partially_fulfilled', n: 1 },
      ]),
    );
    expect(await reconcile(shop.shopId)).toEqual([]);
    const finished = await h.run(ops.getPickList, { pickListId: list.pickListId });
    expect(new Set(finished.pickLines.map((l: { status: string }) => l.status))).toEqual(
      new Set(['done', 'moved']),
    );
  });

  it('records a Shopify order’s picks without fulfilling it', async () => {
    const shopify = await connector(shop);
    const order = await h.run(
      ops.reserveStock,
      {
        variantId: cards,
        quantity: '2',
        purpose: 'external_order',
        externalRef: 'shopify:order/77/line/1',
      },
      { caller: shopify },
    );
    const manual = await h.run(ops.reserveStock, { variantId: cards, quantity: '1' });
    const created = await h.run(ops.createPickList, {
      reservationIds: [order.reservationId, manual.reservationId],
    });
    expect(
      created.pickLines.map((l: { fulfillOnComplete: boolean; externalRef: string | null }) => [
        l.externalRef,
        l.fulfillOnComplete,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['shopify:order/77/line/1', false],
        [null, true],
      ]),
    );
    for (const line of created.pickLines) {
      await h.run(ops.recordPick, { pickListId: created.pickListId, lineId: line.lineId });
    }
    const done = await h.run(ops.completePickList, { pickListId: created.pickListId });
    expect(done.fulfilled.map((f: { reservationId: string }) => f.reservationId)).toEqual([
      manual.reservationId,
    ]);
    expect(done.recordedOnly).toEqual([
      { reservationId: order.reservationId, externalRef: 'shopify:order/77/line/1' },
    ]);
    const [still] = await ownerQuery<{ status: string }>(
      'select status from reservations where id = $1',
      [order.reservationId],
    );
    expect(still?.status).toBe('active');
  });

  it('filters by order prefix and cancels a list, freeing its allocations', async () => {
    const r = await h.run(ops.reserveStock, {
      variantId: cards,
      quantity: '1',
      purpose: 'external_order',
      externalRef: 'api:order/2001/line/1',
    });
    const first = await h.run(ops.createPickList, { orders: ['api:order/2001'] });
    expect(first.pickLines.map((l: { reservationId: string }) => l.reservationId)).toEqual([
      r.reservationId,
    ]);
    await h.run(ops.cancelPickList, { pickListId: first.pickListId });
    const again = await h.run(ops.createPickList, { orders: ['api:order/2001'], note: 'Retry' });
    expect(again.pickLines).toHaveLength(1);
    const open = await h.run(ops.listPickLists, {});
    expect(open.pickLists.map((l: { pickListId: string }) => l.pickListId)).toContain(
      again.pickListId,
    );
    expect(open.pickLists.map((l: { pickListId: string }) => l.pickListId)).not.toContain(
      first.pickListId,
    );
  });
});

describe('pick lists across shops and location scopes', () => {
  let scopedList: string;
  let ownerList: { pickListId: string; pickLines: Row[] };

  beforeAll(async () => {
    await h.run(ops.receiveStock, { variantId: boxes, locationId: loc['C-01'], quantity: '5' });
    await h.run(ops.receiveStock, { variantId: cards, locationId: loc['A-01'], quantity: '5' });
    for (const [variantId, locationId] of [
      [cards, loc['A-01']],
      [boxes, loc['C-01']],
    ] as const) {
      await h.run(ops.reserveStock, {
        variantId,
        quantity: '1',
        locationId,
        purpose: 'external_order',
        externalRef: `scope:order/${variantId}`,
      });
    }
    ownerList = await h.run(ops.createPickList, {
      orders: ['scope:order'].map(() => `scope:order/${cards}`).concat(`scope:order/${boxes}`),
    });
    scopedList = ownerList.pickListId;
  });

  it('keeps another shop out (A13)', async () => {
    const other = await seedShop(db, sink, 'Other picking shop');
    const o = harness(db, sink, other);
    await expect(o.run(ops.getPickList, { pickListId: scopedList })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      o.run(ops.recordPick, { pickListId: scopedList, lineId: ownerList.pickLines[0]!.lineId }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await o.run(ops.listPickLists, { status: 'all' })).pickLists).toEqual([]);
    await expect(o.run(ops.createPickList, {})).rejects.toMatchObject({ code: 'nothing_to_pick' });
  });

  it('shows and works only the lines in a scoped member’s locations (A42)', async () => {
    const member = await addMember(shop.shopId, 'inventory_operator', [loc['A-01']!]);
    const seen = await h.run(
      ops.getPickList,
      { pickListId: scopedList },
      { caller: member.caller },
    );
    expect(seen.partial).toBe(true);
    expect(seen.pickLines.map((l: { locationPath: string }) => l.locationPath)).toEqual([
      'Main stock/A-01',
    ]);
    const outside = ownerList.pickLines.find((l) => l.locationPath === 'Main stock/C-01')!;
    await expect(
      h.run(
        ops.recordPick,
        { pickListId: scopedList, lineId: outside.lineId },
        { caller: member.caller },
      ),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
    const inside = ownerList.pickLines.find((l) => l.locationPath === 'Main stock/A-01')!;
    const picked = await h.run(
      ops.recordPick,
      { pickListId: scopedList, lineId: inside.lineId },
      { caller: member.caller },
    );
    expect(picked.line.status).toBe('picked');
    // Completing touches every line's location, so it is refused.
    await expect(
      h.run(
        ops.completePickList,
        { pickListId: scopedList, leaveOpen: true },
        {
          caller: member.caller,
        },
      ),
    ).rejects.toMatchObject({ code: 'location_out_of_scope' });
    // A list the member builds holds only their locations.
    await h.run(ops.reserveStock, {
      variantId: boxes,
      quantity: '1',
      locationId: loc['C-01'],
      purpose: 'external_order',
      externalRef: 'scope2:order/1',
    });
    await expect(
      h.run(ops.createPickList, { orders: ['scope2:order'] }, { caller: member.caller }),
    ).rejects.toMatchObject({ code: 'nothing_to_pick' });
    // A viewer cannot pick at all.
    const viewer = await addMember(shop.shopId, 'viewer');
    await expect(
      h.run(ops.createPickList, { orders: ['scope2:order'] }, { caller: viewer.caller }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
