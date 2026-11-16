import { type Caller, ops, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll } from 'vitest';
import {
  appDatabase,
  boundCaller,
  createLeafLocation,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';
import { type ContractCase, describeFailureContract, subscribeAll } from './failure-contract.ts';

// The failure contract (PRD 7.3, G17) for picking (ADR 0026): building a list, a pick, a pick from
// another lot (which reallocates), a short pick, completing a list (which fulfills), and
// cancelling one. Each case reserves its own orders, so lists never share an allocation.

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let owner: Caller;
let shelfA: string;
let shelfB: string;

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Picking failures shop');
  h = harness(db, sink, shop);
  owner = await boundCaller(shop);
  shelfA = await createLeafLocation(h, shop.warehouseId, 'Pick failures A');
  shelfB = await createLeafLocation(h, shop.warehouseId, 'Pick failures B');
  await subscribeAll(shop.shopId);
});
afterAll(() => db.close());

interface Line {
  lineId: string;
  quantity: string;
  status: string;
}

/** Two orders of a fresh variant, reserved, and a list built for them. */
async function list(): Promise<{ pickListId: string; lines: Line[]; orders: string[] }> {
  const variantId = await createVariant(h);
  await h.run(ops.receiveStock, { variantId, locationId: shelfA, quantity: '10', unitCost: '3' });
  const tag = uuidv7().slice(-8);
  const orders = [`api:order/${tag}-1`, `api:order/${tag}-2`];
  await h.run(ops.reserveStock, { variantId, quantity: '3', externalRef: orders[0] });
  await h.run(ops.reserveStock, { variantId, quantity: '2', externalRef: orders[1] });
  const created = await h.run(ops.createPickList, { orders });
  return { pickListId: created.pickListId, lines: created.pickLines, orders };
}

const cases: ContractCase[] = [
  {
    label: 'building a pick list',
    setup: async () => {
      const variantId = await createVariant(h);
      await h.run(ops.receiveStock, { variantId, locationId: shelfB, quantity: '6' });
      const ref = `api:order/${uuidv7().slice(-8)}`;
      await h.run(ops.reserveStock, { variantId, quantity: '4', externalRef: ref });
      return { op: ops.createPickList, input: { orders: [ref], note: 'Morning run' } };
    },
  },
  {
    label: 'a pick',
    setup: async () => {
      const l = await list();
      return {
        op: ops.recordPick,
        input: { pickListId: l.pickListId, lineId: l.lines[0]!.lineId, quantity: '1' },
      };
    },
  },
  {
    label: 'a pick from another lot, which reallocates',
    setup: async () => {
      const variantId = await createVariant(h);
      await h.run(ops.setStockSettings, { variantId, trackingMode: 'lot_expiry' });
      const late = `LATE-${uuidv7().slice(-6)}`;
      await h.run(ops.receiveStock, {
        variantId,
        locationId: shelfA,
        quantity: '5',
        lotCode: `SOON-${uuidv7().slice(-6)}`,
        expiresOn: '2030-03-31',
      });
      await h.run(ops.receiveStock, {
        variantId,
        locationId: shelfA,
        quantity: '5',
        lotCode: late,
        expiresOn: '2031-03-31',
      });
      const ref = `api:order/${uuidv7().slice(-8)}`;
      await h.run(ops.reserveStock, { variantId, quantity: '2', externalRef: ref });
      const created = await h.run(ops.createPickList, { orders: [ref] });
      return {
        op: ops.recordPick,
        input: {
          pickListId: created.pickListId,
          lineId: created.pickLines[0].lineId,
          lotCode: late,
        },
      };
    },
  },
  {
    label: 'a short pick',
    setup: async () => {
      const l = await list();
      const line = l.lines.find((x) => x.quantity === '3')!;
      return {
        op: ops.recordShortPick,
        input: { pickListId: l.pickListId, lineId: line.lineId, found: '1' },
      };
    },
  },
  {
    label: 'completing a list, which fulfills the picks',
    setup: async () => {
      const l = await list();
      for (const line of l.lines) {
        await h.run(ops.recordPick, { pickListId: l.pickListId, lineId: line.lineId });
      }
      return {
        op: ops.completePickList,
        input: { pickListId: l.pickListId, reference: `ship-${uuidv7().slice(-6)}` },
      };
    },
  },
  {
    label: 'completing a list with a short line left reserved',
    setup: async () => {
      const l = await list();
      const [first, second] = l.lines;
      await h.run(ops.recordShortPick, {
        pickListId: l.pickListId,
        lineId: first!.lineId,
        found: '1',
      });
      await h.run(ops.recordPick, { pickListId: l.pickListId, lineId: second!.lineId });
      return { op: ops.completePickList, input: { pickListId: l.pickListId } };
    },
  },
  {
    label: 'cancelling a list',
    setup: async () => {
      const l = await list();
      await h.run(ops.recordPick, {
        pickListId: l.pickListId,
        lineId: l.lines[0]!.lineId,
        quantity: '1',
      });
      return { op: ops.cancelPickList, input: { pickListId: l.pickListId } };
    },
  },
];

describeFailureContract(cases, () => ({
  db,
  sink,
  shopId: shop.shopId,
  caller: shop.caller,
  owner,
}));
