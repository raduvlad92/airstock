import { type Caller, ops, uuidv7 } from '@airstock/core';
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
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';

// Phase 1, milestone N6: warehouse records, location hierarchy rules, location scopes (F14).

const db = appDatabase();
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Storage shop');
  h = harness(db, sink, shop);
});
afterAll(() => db.close());

async function rejects(
  promise: Promise<unknown>,
): Promise<{ status: number; code: string; extra: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { status: number; code: string; extra: Record<string, unknown> };
    return { status: e.status, code: e.code, extra: e.extra };
  }
  throw new Error('Expected the call to fail.');
}

const CONTRACT = {
  startDate: '2026-01-01',
  endDate: '2027-12-31',
  feeDescription: 'Monthly storage and per-order handling',
  rates: [
    { description: 'Storage per pallet', amount: '12.50', unit: 'pallet per week' },
    { description: 'Pick and pack', amount: '1.10', unit: 'order' },
  ],
  notes: 'Notice period three months.',
};

async function location(id: string) {
  const { locations } = await h.run(ops.listLocations, {});
  return locations.find((l: { locationId: string }) => l.locationId === id);
}

async function warehouse(name: string, extra: Record<string, unknown> = {}) {
  return (await h.run(ops.createWarehouse, { name, ...extra })).warehouse;
}

describe('F14: warehouse records and commercial terms', () => {
  it('records the operator and contract of rented and third-party warehouses', async () => {
    const rented = await warehouse('Rented hall', {
      ownership: 'rented',
      operatorName: 'Hall Logistics GmbH',
      timezone: 'Europe/Berlin',
      address: { line1: 'Lagerstraße 4', city: 'Leipzig', postalCode: '04103', country: 'de' },
      contact: { name: 'Jonas', email: 'jonas@hall.example', phone: '' },
      providerRefs: [{ provider: 'hall', externalId: 'LEJ-04' }],
      contract: CONTRACT,
    });
    expect(rented).toMatchObject({
      ownership: 'rented',
      operatorName: 'Hall Logistics GmbH',
      address: { country: 'DE', city: 'Leipzig' },
      contact: { name: 'Jonas', email: 'jonas@hall.example' },
      providerRefs: [{ provider: 'hall', externalId: 'LEJ-04' }],
      operatingStatus: 'operating',
      fulfillmentEligible: true,
      status: 'active',
      version: 1,
      contract: { ...CONTRACT, currency: 'EUR', attachmentMediaIds: [] },
    });
    expect(rented.contact).not.toHaveProperty('phone');
    const partner = await warehouse('Partner 3PL', {
      ownership: 'third_party',
      operatorName: 'Ship Partner BV',
      contract: { feeDescription: 'Per order', currency: 'USD', rates: [] },
    });
    const view = await h.run(ops.getWarehouse, { warehouseId: partner.warehouseId });
    expect(view.commercialVisible).toBe(true);
    expect(view.warehouse.contract).toMatchObject({ currency: 'USD', startDate: null });
  });

  it('validates contract dates, rates, and provider IDs', async () => {
    const bad = await rejects(
      h.run(ops.createWarehouse, {
        name: 'Bad dates',
        contract: { startDate: '2026-05-01', endDate: '2026-04-01' },
      }),
    );
    expect(bad).toMatchObject({ status: 400, code: 'validation_failed' });
    const float = await rejects(
      h.run(ops.createWarehouse, {
        name: 'Bad rate',
        contract: { rates: [{ description: 'x', amount: '1.1234567', unit: 'order' }] },
      }),
    );
    expect(float.code).toBe('validation_failed');
    const day = await rejects(
      h.run(ops.createWarehouse, { name: 'Bad day', contract: { startDate: '2026-02-30' } }),
    );
    expect(day.code).toBe('validation_failed');
    const dupe = await rejects(
      h.run(ops.createWarehouse, {
        name: 'Dupe refs',
        providerRefs: [
          { provider: 'x', externalId: '1' },
          { provider: 'X', externalId: '1' },
        ],
      }),
    );
    expect(dupe.code).toBe('validation_failed');
  });

  it('hides fees and contracts from roles without storage.commercial.read', async () => {
    const created = await warehouse('Secret terms', {
      ownership: 'rented',
      operatorName: 'Landlord',
      contract: CONTRACT,
    });
    for (const role of ['viewer', 'inventory_operator', 'catalog_editor']) {
      const member = await addMember(shop.shopId, role);
      const list = await h.run(ops.listWarehouses, {}, { caller: member.caller });
      expect(list.commercialVisible).toBe(false);
      const row = list.warehouses.find(
        (w: { warehouseId: string }) => w.warehouseId === created.warehouseId,
      );
      expect(row.operatorName).toBe('Landlord');
      expect(row).not.toHaveProperty('contract');
      const one = await h.run(
        ops.getWarehouse,
        { warehouseId: created.warehouseId },
        { caller: member.caller },
      );
      expect(one.warehouse).not.toHaveProperty('contract');
    }
    const manager = await addMember(shop.shopId, 'manager');
    const seen = await h.run(
      ops.getWarehouse,
      { warehouseId: created.warehouseId },
      { caller: manager.caller },
    );
    expect(seen.warehouse.contract.rates).toHaveLength(2);
  });

  it('refuses contract changes without the permission, but allows the rest of the record', async () => {
    const created = await warehouse('Terms guarded', { contract: CONTRACT });
    // A connector-like member that manages storage without commercial access.
    const owner = await boundCaller(shop);
    const limited: Caller = {
      ...owner,
      membership: {
        ...owner.membership!,
        permissions: new Set(['storage.read', 'storage.manage']),
      },
    };
    const denied = await rejects(
      h.run(
        ops.updateWarehouse,
        { warehouseId: created.warehouseId, expectedVersion: 1, contract: null },
        { caller: limited },
      ),
    );
    expect(denied).toMatchObject({ status: 403, code: 'forbidden' });
    expect(
      (await rejects(h.run(ops.createWarehouse, { name: 'X', contract: {} }, { caller: limited })))
        .status,
    ).toBe(403);
    const renamed = await h.run(
      ops.updateWarehouse,
      { warehouseId: created.warehouseId, expectedVersion: 1, operatingStatus: 'paused' },
      { caller: limited },
    );
    expect(renamed.warehouse).toMatchObject({ operatingStatus: 'paused', version: 2 });
    expect(renamed.warehouse).not.toHaveProperty('contract');
  });

  it('keeps contract changes in history, hidden from members who may not see them', async () => {
    const created = await warehouse('Audited terms', { contract: CONTRACT });
    await h.run(ops.updateWarehouse, {
      warehouseId: created.warehouseId,
      expectedVersion: 1,
      contract: { ...CONTRACT, notes: 'Renewed' },
    });
    await sink.drain(db);
    sink.events.length = 0;
    const filter = { targetType: 'warehouse', targetId: created.warehouseId };
    const owner = await h.run(ops.listActivity, filter);
    const update = owner.events.find(
      (e: { action: string; phase: string }) =>
        e.action === 'storage.warehouse.updated' && e.phase === 'outcome',
    );
    expect(update.changes.contract.to.notes).toBe('Renewed');
    const viewer = await addMember(shop.shopId, 'viewer');
    const hidden = await h.run(ops.listActivity, filter, { caller: viewer.caller });
    const events = hidden.events.filter((e: { phase: string }) => e.phase === 'outcome');
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const e of events) {
      if (e.changes?.contract !== undefined) expect(e.changes.contract).toBe('hidden');
    }
    expect(JSON.stringify(hidden)).not.toContain('pallet');
  });

  it('updates with compare-and-set on the version and records each field change', async () => {
    const created = await warehouse('Versioned');
    const first = await h.run(ops.updateWarehouse, {
      warehouseId: created.warehouseId,
      expectedVersion: 1,
      name: 'Versioned site',
      fulfillmentEligible: false,
    });
    expect(first.warehouse).toMatchObject({ name: 'Versioned site', version: 2 });
    const stale = await rejects(
      h.run(ops.updateWarehouse, {
        warehouseId: created.warehouseId,
        expectedVersion: 1,
        name: 'Lost update',
      }),
    );
    expect(stale).toMatchObject({
      status: 409,
      code: 'version_conflict',
      extra: { currentVersion: 2 },
    });
    const same = await h.run(ops.updateWarehouse, {
      warehouseId: created.warehouseId,
      expectedVersion: 2,
      name: 'Versioned site',
      address: null,
    });
    expect(same.warehouse.version).toBe(2);
    const events = await ownerQuery<{ outcome: string; changes: unknown }>(
      `select outcome, changes from audit_events
       where shop_id = $1 and target_id = $2 and action = 'storage.warehouse.updated'
         and phase = 'outcome' order by occurred_at`,
      [shop.shopId, created.warehouseId],
    );
    expect(events.map((e) => e.outcome)).toEqual(['succeeded', 'no_change']);
    expect(events[0]!.changes).toMatchObject({
      fields: {
        name: { from: 'Versioned', to: 'Versioned site' },
        fulfillmentEligible: { from: true, to: false },
      },
    });
  });
});

describe('F14: archived locations and warehouses with stock', () => {
  it('accepts no receipts into an archived location or one in an archived warehouse', async () => {
    const variantId = await createVariant(h);
    const wh = await warehouse('Closing site');
    const bin = await createLeafLocation(h, wh.warehouseId, 'Bin 1');
    const archived = await h.run(ops.archiveLocation, { locationId: bin });
    expect(archived).toMatchObject({ status: 'archived', locationsChanged: 0 });
    const refused = await rejects(
      h.run(ops.receiveStock, { variantId, locationId: bin, quantity: '1' }),
    );
    expect(refused).toMatchObject({ status: 409, code: 'location_archived' });

    const other = await createLeafLocation(h, wh.warehouseId, 'Bin 2');
    await h.run(ops.archiveWarehouse, { warehouseId: wh.warehouseId });
    expect(
      (await rejects(h.run(ops.receiveStock, { variantId, locationId: other, quantity: '1' })))
        .code,
    ).toBe('location_archived');
    expect(
      (await rejects(h.run(ops.createLocation, { warehouseId: wh.warehouseId, name: 'New' }))).code,
    ).toBe('warehouse_archived');
  });

  it('refuses to archive a location or warehouse that holds stock or reservations', async () => {
    const variantId = await createVariant(h);
    const wh = await warehouse('Stocked site');
    const aisle = await createLeafLocation(h, wh.warehouseId, 'Aisle');
    const shelf = (
      await h.run(ops.createLocation, { warehouseId: wh.warehouseId, parentId: aisle, name: 'S1' })
    ).locationId;
    await h.run(ops.receiveStock, { variantId, locationId: shelf, quantity: '4' });
    await h.run(ops.reserveStock, { variantId, quantity: '1', locationId: shelf });

    const loc = await rejects(h.run(ops.archiveLocation, { locationId: shelf }));
    expect(loc).toMatchObject({
      status: 409,
      code: 'location_holds_stock',
      extra: { onHand: '4.000000', reserved: '1.000000' },
    });
    // A parent is refused for stock anywhere inside it.
    expect((await rejects(h.run(ops.archiveLocation, { locationId: aisle }))).code).toBe(
      'location_holds_stock',
    );
    const whRefused = await rejects(h.run(ops.archiveWarehouse, { warehouseId: wh.warehouseId }));
    expect(whRefused).toMatchObject({ code: 'location_holds_stock' });
    expect(whRefused.extra.locations).toEqual(['Stocked site/Aisle/S1']);
    expect((await location(shelf)).status).toBe('active');
  });

  it('keeps at least one active warehouse in the shop', async () => {
    const solo = await seedShop(db, sink, 'Solo shop');
    const hs = harness(db, sink, solo);
    const res = await rejects(hs.run(ops.archiveWarehouse, { warehouseId: solo.warehouseId }));
    expect(res.code).toBe('last_warehouse');
  });

  it('refuses to archive a location a Shopify store sells from', async () => {
    const wh = await warehouse('Mapped site');
    const bin = await createLeafLocation(h, wh.warehouseId, 'Mapped bin');
    const [member] = await ownerQuery<{ id: string }>(
      'select id from memberships where shop_id = $1 and user_id = $2',
      [shop.shopId, shop.userId],
    );
    const connectionId = uuidv7();
    await ownerQuery(
      `insert into shopify_connections (shop_id, id, shop_domain, scopes, token_key_id, installed_by_membership_id)
       values ($1, $2, $3, '{}', 'k1', $4)`,
      [shop.shopId, connectionId, `n6-${connectionId.slice(-8)}.myshopify.com`, member!.id],
    );
    await ownerQuery(
      `insert into shopify_location_maps (shop_id, connection_id, shopify_location_id, location_id)
       values ($1, $2, '1001', $3)`,
      [shop.shopId, connectionId, bin],
    );
    expect((await rejects(h.run(ops.archiveLocation, { locationId: bin }))).code).toBe(
      'location_mapped',
    );
    expect((await rejects(h.run(ops.archiveWarehouse, { warehouseId: wh.warehouseId }))).code).toBe(
      'location_mapped',
    );
  });
});

describe('archive and restore cascade to the locations inside', () => {
  it('archives children with their parent and restores exactly those', async () => {
    const wh = await warehouse('Cascade');
    const zone = await createLeafLocation(h, wh.warehouseId, 'Zone');
    const a = (
      await h.run(ops.createLocation, { warehouseId: wh.warehouseId, parentId: zone, name: 'A' })
    ).locationId;
    const b = (
      await h.run(ops.createLocation, { warehouseId: wh.warehouseId, parentId: zone, name: 'B' })
    ).locationId;
    await h.run(ops.archiveLocation, { locationId: b });
    const archived = await h.run(ops.archiveLocation, { locationId: zone });
    expect(archived.locationsChanged).toBe(1);
    expect((await location(a)).status).toBe('archived');

    expect((await rejects(h.run(ops.restoreLocation, { locationId: a }))).code).toBe(
      'parent_archived',
    );
    const restored = await h.run(ops.restoreLocation, { locationId: zone });
    expect(restored).toMatchObject({ status: 'active', locationsChanged: 1 });
    expect((await location(a)).status).toBe('active');
    expect((await location(b)).status).toBe('archived');
    expect((await h.run(ops.restoreLocation, { locationId: b })).locationsChanged).toBe(0);
    expect((await location(b)).status).toBe('active');
  });

  it('archives a warehouse with its locations and restores them together', async () => {
    const wh = await warehouse('Seasonal');
    const one = await createLeafLocation(h, wh.warehouseId, 'One');
    const two = await createLeafLocation(h, wh.warehouseId, 'Two');
    await h.run(ops.archiveLocation, { locationId: two });
    const archived = await h.run(ops.archiveWarehouse, { warehouseId: wh.warehouseId });
    expect(archived).toMatchObject({ status: 'archived', locationsChanged: 1 });
    const listed = await h.run(ops.listWarehouses, {});
    expect(listed.warehouses.map((w: { name: string }) => w.name)).not.toContain('Seasonal');
    const all = await h.run(ops.listWarehouses, { includeArchived: 'true' });
    expect(all.warehouses.find((w: { name: string }) => w.name === 'Seasonal').status).toBe(
      'archived',
    );
    expect((await rejects(h.run(ops.restoreLocation, { locationId: one }))).code).toBe(
      'warehouse_archived',
    );
    expect(
      (
        await rejects(
          h.run(ops.updateWarehouse, {
            warehouseId: wh.warehouseId,
            expectedVersion: archived.version,
            name: 'X',
          }),
        )
      ).code,
    ).toBe('warehouse_archived');
    const restored = await h.run(ops.restoreWarehouse, { warehouseId: wh.warehouseId });
    expect(restored.locationsChanged).toBe(1);
    expect((await location(one)).status).toBe('active');
    expect((await location(two)).status).toBe('archived');
  });
});

describe('location names, codes, and paths', () => {
  it('keeps the path of the whole subtree in step with names and codes', async () => {
    const wh = await warehouse('Paths');
    const aisle = await createLeafLocation(h, wh.warehouseId, 'Aisle 1');
    const shelf = (
      await h.run(ops.createLocation, {
        warehouseId: wh.warehouseId,
        parentId: aisle,
        name: 'Shelf',
        code: 'S-01',
      })
    ).locationId;
    expect((await location(shelf)).path).toBe('Paths/Aisle 1/S-01');
    const current = await location(aisle);
    const renamed = await h.run(ops.updateLocation, {
      locationId: aisle,
      expectedVersion: current.version,
      code: 'A1',
    });
    expect(renamed.location.path).toBe('Paths/A1');
    expect(renamed.locationsRenamed).toBe(2);
    expect((await location(shelf)).path).toBe('Paths/A1/S-01');
    const cleared = await h.run(ops.updateLocation, {
      locationId: aisle,
      expectedVersion: renamed.location.version,
      code: null,
      name: 'Aisle One',
    });
    expect(cleared.location).toMatchObject({ code: null, path: 'Paths/Aisle One' });
    // The shelf's own version does not change when only its path does.
    expect((await location(shelf)).version).toBe(1);

    const wh2 = await h.run(ops.updateWarehouse, {
      warehouseId: wh.warehouseId,
      expectedVersion: 1,
      name: 'Paths B',
    });
    expect(wh2.locationsRenamed).toBe(2);
    expect((await location(shelf)).path).toBe('Paths B/Aisle One/S-01');
  });

  it('does not repeat the warehouse name for a top-level location named like it', async () => {
    const res = await h.run(ops.listLocations, { warehouseId: shop.warehouseId });
    expect(res.locations[0].path).toBe('Main stock');
    const renamed = await h.run(ops.updateWarehouse, {
      warehouseId: shop.warehouseId,
      expectedVersion: 1,
      name: 'Berlin',
    });
    expect(renamed.locationsRenamed).toBe(1);
    expect((await location(shop.locationId)).path).toBe('Berlin/Main stock');
    await h.run(ops.updateWarehouse, {
      warehouseId: shop.warehouseId,
      expectedVersion: 2,
      name: 'Main stock',
    });
    expect((await location(shop.locationId)).path).toBe('Main stock');
  });

  it('keeps codes unique among active locations of a warehouse', async () => {
    const wh = await warehouse('Codes');
    await h.run(ops.createLocation, { warehouseId: wh.warehouseId, name: 'One', code: 'C-1' });
    const taken = await rejects(
      h.run(ops.createLocation, { warehouseId: wh.warehouseId, name: 'Two', code: 'c-1' }),
    );
    expect(taken).toMatchObject({ status: 409, code: 'code_taken' });
    const other = await warehouse('Codes elsewhere');
    await h.run(ops.createLocation, { warehouseId: other.warehouseId, name: 'Two', code: 'C-1' });
    const two = await createLeafLocation(h, wh.warehouseId, 'Two');
    const update = await rejects(
      h.run(ops.updateLocation, { locationId: two, expectedVersion: 1, code: 'C-1' }),
    );
    expect(update.code).toBe('code_taken');
    const stale = await rejects(
      h.run(ops.updateLocation, { locationId: two, expectedVersion: 7, name: 'Late' }),
    );
    expect(stale.code).toBe('version_conflict');
  });
});

describe('moving locations', () => {
  it('moves an empty subtree, recomputing paths and path IDs, and keeps scopes in step', async () => {
    const wh = await warehouse('Moves');
    const left = await createLeafLocation(h, wh.warehouseId, 'Left');
    const right = await createLeafLocation(h, wh.warehouseId, 'Right');
    const box = (
      await h.run(ops.createLocation, { warehouseId: wh.warehouseId, parentId: left, name: 'Box' })
    ).locationId;
    const inner = (
      await h.run(ops.createLocation, { warehouseId: wh.warehouseId, parentId: box, name: 'In' })
    ).locationId;
    const rightScoped = await addMember(shop.shopId, 'inventory_operator', [right]);

    const moved = await h.run(ops.moveLocation, {
      locationId: box,
      expectedVersion: 1,
      parentId: right,
    });
    expect(moved).toMatchObject({ locationsMoved: 2, location: { path: 'Moves/Right/Box' } });
    expect((await location(inner)).path).toBe('Moves/Right/Box/In');
    const [row] = await ownerQuery<{ path_ids: string[] }>(
      'select path_ids from locations where id = $1',
      [inner],
    );
    expect(row!.path_ids).toEqual([wh.warehouseId, right, box, inner]);
    // A member scoped to Right now sees the moved locations.
    const seen = await h.run(ops.listLocations, {}, { caller: rightScoped.caller });
    expect(seen.locations.map((l: { locationId: string }) => l.locationId).sort()).toEqual(
      [right, box, inner].sort(),
    );

    const top = await h.run(ops.moveLocation, {
      locationId: box,
      expectedVersion: 2,
      parentId: null,
    });
    expect(top.location).toMatchObject({ parentId: null, path: 'Moves/Box' });
  });

  it('rejects cycles, other warehouses, archived parents, and stale versions', async () => {
    const wh = await warehouse('Move rules');
    const outer = await createLeafLocation(h, wh.warehouseId, 'Outer');
    const child = (
      await h.run(ops.createLocation, { warehouseId: wh.warehouseId, parentId: outer, name: 'C' })
    ).locationId;
    const self = await rejects(
      h.run(ops.moveLocation, { locationId: outer, expectedVersion: 1, parentId: outer }),
    );
    expect(self).toMatchObject({ status: 422, code: 'move_cycle' });
    const below = await rejects(
      h.run(ops.moveLocation, { locationId: outer, expectedVersion: 1, parentId: child }),
    );
    expect(below.code).toBe('move_cycle');
    const elsewhere = await warehouse('Move target');
    const foreign = await createLeafLocation(h, elsewhere.warehouseId, 'There');
    expect(
      (
        await rejects(
          h.run(ops.moveLocation, { locationId: child, expectedVersion: 1, parentId: foreign }),
        )
      ).code,
    ).toBe('parent_in_other_warehouse');
    const shut = await createLeafLocation(h, wh.warehouseId, 'Shut');
    await h.run(ops.archiveLocation, { locationId: shut });
    expect(
      (
        await rejects(
          h.run(ops.moveLocation, { locationId: child, expectedVersion: 1, parentId: shut }),
        )
      ).code,
    ).toBe('location_archived');
    expect(
      (
        await rejects(
          h.run(ops.moveLocation, { locationId: child, expectedVersion: 9, parentId: null }),
        )
      ).code,
    ).toBe('version_conflict');
    const same = await h.run(ops.moveLocation, {
      locationId: child,
      expectedVersion: 1,
      parentId: outer,
    });
    expect(same.locationsMoved).toBe(0);
  });

  it('refuses while the location, anything inside it, or the new parent holds stock', async () => {
    const variantId = await createVariant(h);
    const wh = await warehouse('Stock moves');
    const rack = await createLeafLocation(h, wh.warehouseId, 'Rack');
    const bin = (
      await h.run(ops.createLocation, { warehouseId: wh.warehouseId, parentId: rack, name: 'Bin' })
    ).locationId;
    const full = await createLeafLocation(h, wh.warehouseId, 'Full');
    const empty = await createLeafLocation(h, wh.warehouseId, 'Empty');
    await h.run(ops.receiveStock, { variantId, locationId: bin, quantity: '2' });
    await h.run(ops.receiveStock, { variantId, locationId: full, quantity: '1' });
    const subtree = await rejects(
      h.run(ops.moveLocation, { locationId: rack, expectedVersion: 1, parentId: empty }),
    );
    expect(subtree).toMatchObject({ code: 'location_holds_stock', extra: { onHand: '2.000000' } });
    const parent = await rejects(
      h.run(ops.moveLocation, { locationId: empty, expectedVersion: 1, parentId: full }),
    );
    expect(parent.code).toBe('location_holds_stock');
  });
});

describe('fulfillment eligibility of warehouses and parent locations', () => {
  it('allocates only from locations whose warehouse and parents are eligible', async () => {
    const solo = await seedShop(db, sink, 'Eligibility shop');
    const hs = harness(db, sink, solo);
    const variantId = await createVariant(hs);
    const wh = (await hs.run(ops.createWarehouse, { name: 'Ineligible site' })).warehouse;
    const area = await createLeafLocation(hs, wh.warehouseId, 'Area');
    const bin = (
      await hs.run(ops.createLocation, { warehouseId: wh.warehouseId, parentId: area, name: 'Bin' })
    ).locationId;
    await hs.run(ops.receiveStock, { variantId, locationId: bin, quantity: '5' });
    await hs.run(ops.receiveStock, { variantId, locationId: solo.locationId, quantity: '1' });
    expect((await hs.run(ops.getAvailability, { variantId })).totals.available).toBe('6.000000');

    await hs.run(ops.updateWarehouse, {
      warehouseId: wh.warehouseId,
      expectedVersion: 1,
      fulfillmentEligible: false,
    });
    expect((await hs.run(ops.getAvailability, { variantId })).totals.available).toBe('1.000000');
    expect((await rejects(hs.run(ops.reserveStock, { variantId, quantity: '2' }))).code).toBe(
      'insufficient_stock',
    );
    const listed = await hs.run(ops.listLocations, { warehouseId: wh.warehouseId });
    expect(
      listed.locations.map(
        (l: { fulfillmentEligible: boolean; effectiveFulfillmentEligible: boolean }) => [
          l.fulfillmentEligible,
          l.effectiveFulfillmentEligible,
        ],
      ),
    ).toEqual([
      [true, false],
      [true, false],
    ]);

    await hs.run(ops.updateWarehouse, {
      warehouseId: wh.warehouseId,
      expectedVersion: 2,
      fulfillmentEligible: true,
    });
    await hs.run(ops.updateLocation, {
      locationId: area,
      expectedVersion: 1,
      fulfillmentEligible: false,
    });
    expect((await hs.run(ops.getAvailability, { variantId })).totals.available).toBe('1.000000');
    await hs.run(ops.updateLocation, {
      locationId: area,
      expectedVersion: 2,
      fulfillmentEligible: true,
    });
    expect((await hs.run(ops.reserveStock, { variantId, quantity: '6' })).allocations).toHaveLength(
      2,
    );
  });
});

describe('location scopes (C31)', () => {
  it('sets a member to some warehouses or locations, lists them, and enforces them', async () => {
    const north = await warehouse('North');
    const south = await warehouse('South');
    const n1 = await createLeafLocation(h, north.warehouseId, 'N1');
    const s1 = await createLeafLocation(h, south.warehouseId, 'S1');
    const member = await addMember(shop.shopId, 'manager');

    const set = await h.run(ops.setLocationScope, {
      membershipId: member.membershipId,
      allLocations: false,
      scopeIds: [north.warehouseId],
    });
    expect(set).toMatchObject({ allLocations: false, locationScopeIds: [north.warehouseId] });
    const members = await h.run(ops.listMembers, {});
    expect(
      members.members.find((m: { membershipId: string }) => m.membershipId === member.membershipId),
    ).toMatchObject({ allLocations: false, locationScopeIds: [north.warehouseId] });

    const as = { caller: member.caller };
    const seen = await h.run(ops.listWarehouses, {}, as);
    expect(seen.partial).toBe(true);
    expect(seen.warehouses.map((w: { name: string }) => w.name)).toEqual(['North']);
    expect(
      (await h.run(ops.updateLocation, { locationId: n1, expectedVersion: 1, name: 'N-1' }, as))
        .location.name,
    ).toBe('N-1');
    const out = await rejects(
      h.run(ops.updateLocation, { locationId: s1, expectedVersion: 1, name: 'x' }, as),
    );
    expect(out).toMatchObject({ status: 403, code: 'location_out_of_scope' });
    expect(
      (await rejects(h.run(ops.archiveWarehouse, { warehouseId: south.warehouseId }, as))).code,
    ).toBe('location_out_of_scope');
    expect(
      (await rejects(h.run(ops.getWarehouse, { warehouseId: south.warehouseId }, as))).status,
    ).toBe(404);
    // A scoped member cannot change anyone's scope, including their own.
    expect(
      (
        await rejects(
          h.run(
            ops.setLocationScope,
            { membershipId: member.membershipId, allLocations: true },
            as,
          ),
        )
      ).code,
    ).toBe('location_out_of_scope');

    // Limited to one location inside a warehouse: that location, not the warehouse record.
    await h.run(ops.setLocationScope, {
      membershipId: member.membershipId,
      allLocations: false,
      scopeIds: [s1],
    });
    expect(
      (
        await rejects(
          h.run(
            ops.updateWarehouse,
            { warehouseId: south.warehouseId, expectedVersion: 1, name: 'S' },
            as,
          ),
        )
      ).code,
    ).toBe('location_out_of_scope');
    expect(
      (await rejects(h.run(ops.createLocation, { warehouseId: south.warehouseId, name: 'x' }, as)))
        .code,
    ).toBe('location_out_of_scope');
    const inside = await h.run(
      ops.createLocation,
      { warehouseId: south.warehouseId, parentId: s1, name: 'S1a' },
      as,
    );
    expect(
      (
        await rejects(
          h.run(
            ops.moveLocation,
            { locationId: inside.locationId, expectedVersion: 1, parentId: null },
            as,
          ),
        )
      ).code,
    ).toBe('location_out_of_scope');

    const back = await h.run(ops.setLocationScope, {
      membershipId: member.membershipId,
      allLocations: true,
    });
    expect(back).toMatchObject({ allLocations: true, locationScopeIds: [] });
    expect((await h.run(ops.listWarehouses, {}, as)).partial).toBe(false);
  });

  it('keeps owners on all locations and validates the scope', async () => {
    const [owner] = await ownerQuery<{ id: string }>(
      'select id from memberships where shop_id = $1 and user_id = $2',
      [shop.shopId, shop.userId],
    );
    const res = await rejects(
      h.run(ops.setLocationScope, {
        membershipId: owner!.id,
        allLocations: false,
        scopeIds: [shop.warehouseId],
      }),
    );
    expect(res).toMatchObject({ status: 422, code: 'owner_all_locations' });
    const member = await addMember(shop.shopId, 'viewer');
    expect(
      (
        await rejects(
          h.run(ops.setLocationScope, { membershipId: member.membershipId, allLocations: false }),
        )
      ).code,
    ).toBe('validation_failed');
    const other = await seedShop(db, sink, 'Other storage shop');
    expect(
      (
        await rejects(
          h.run(ops.setLocationScope, {
            membershipId: member.membershipId,
            allLocations: false,
            scopeIds: [other.warehouseId],
          }),
        )
      ).status,
    ).toBe(404);
    const credential = await boundCaller(shop);
    const viaToken = await rejects(
      h.run(
        ops.setLocationScope,
        { membershipId: member.membershipId, allLocations: true },
        { caller: { ...credential, kind: 'api_credential', scopes: new Set(['storage:write']) } },
      ),
    );
    expect(viaToken.status).toBe(403);
  });
});

describe('structural changes racing with receipts', () => {
  it('never leaves stock in an archived location, whichever commits first', async () => {
    const variantId = await createVariant(h);
    const wh = await warehouse('Race site');
    const bins = await Promise.all(
      Array.from({ length: 8 }, (_, i) => createLeafLocation(h, wh.warehouseId, `R${i}`)),
    );
    await Promise.allSettled(
      bins.flatMap((locationId) => [
        h.run(ops.receiveStock, { variantId, locationId, quantity: '1' }),
        h.run(ops.archiveLocation, { locationId }),
      ]),
    );
    const broken = await ownerQuery(
      `select l.id from locations l join inventory_positions p on p.location_id = l.id
       where l.warehouse_id = $1 and l.status = 'archived' and p.on_hand > 0`,
      [wh.warehouseId],
    );
    expect(broken).toEqual([]);
  });
});
