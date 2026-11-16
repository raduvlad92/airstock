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

// The failure contract (PRD 7.3, G17) for purchase orders (ADR 0027): drafting, changing, sending
// (with its email and webhook), receiving against a line (A05 names the PO receipt replay), closing,
// and cancelling. Each case starts from its own order.

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let owner: Caller;
let shelf: string;
let supplierId: string;

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Purchasing failures shop');
  h = harness(db, sink, shop);
  owner = await boundCaller(shop);
  shelf = await createLeafLocation(h, shop.warehouseId, 'PO failures shelf');
  const res = await h.run(ops.createSupplier, {
    name: `Supplier ${uuidv7().slice(-6)}`,
    email: 'orders@supplier.example.test',
  });
  supplierId = res.supplier.id as string;
  await subscribeAll(shop.shopId);
});
afterAll(() => db.close());

/** A variant sold in cases of 12 at 24.00 a case, with a reorder rule above its stock. */
async function casedVariant(): Promise<string> {
  const variantId = await createVariant(h);
  const packs = await h.run(ops.setPacks, {
    variantId,
    packsVersion: 0,
    packs: [{ name: 'Case', quantity: '12' }],
  });
  await h.run(ops.saveSupplierItem, {
    supplierId,
    variantId,
    packId: packs.packaging.packs[0].id,
    lastCost: '24',
    preferred: true,
  });
  // On order matters to this rule: sending, receiving, closing, and cancelling all re-check it.
  await h.run(ops.setReorderRule, {
    variantId,
    warehouseId: shop.warehouseId,
    reorderPoint: '30',
    reorderQuantity: '24',
  });
  return variantId;
}

async function draft(lines = 2): Promise<{ id: string; lineIds: string[]; version: number }> {
  const items = [];
  for (let i = 0; i < lines; i++) items.push({ variantId: await casedVariant(), quantity: '2' });
  const po = await h.run(ops.draftPurchaseOrder, {
    supplierId,
    warehouseId: shop.warehouseId,
    locationId: shelf,
    lines: items,
  });
  return {
    id: po.id,
    lineIds: po.lines.map((l: { id: string }) => l.id),
    version: po.version,
  };
}

async function sent(lines = 2) {
  const po = await draft(lines);
  const res = await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id, email: false });
  return { ...po, version: res.purchaseOrder.version as number };
}

const cases: ContractCase[] = [
  {
    label: 'drafting an order',
    setup: async () => {
      const variantId = await casedVariant();
      return {
        op: ops.draftPurchaseOrder,
        input: {
          supplierId,
          warehouseId: shop.warehouseId,
          lines: [{ variantId, quantity: '3' }],
          notes: 'weekly order',
        },
      };
    },
  },
  {
    label: 'changing a draft’s lines',
    setup: async () => {
      const po = await draft(1);
      const variantId = await casedVariant();
      return {
        op: ops.updatePurchaseOrder,
        input: {
          purchaseOrderId: po.id,
          expectedVersion: po.version,
          lines: [{ variantId, quantity: '4' }],
        },
      };
    },
  },
  {
    label: 'sending an order by email',
    setup: async () => {
      const po = await draft();
      return {
        op: ops.sendPurchaseOrder,
        input: { purchaseOrderId: po.id, message: 'Please confirm the delivery date.' },
      };
    },
  },
  {
    label: 'receiving part of a line in cases',
    setup: async () => {
      const po = await sent();
      return {
        op: ops.receivePurchaseOrderLine,
        input: { purchaseOrderId: po.id, lineId: po.lineIds[0], quantity: '1' },
      };
    },
  },
  {
    label: 'receiving the last line with a lot, completing the order',
    setup: async () => {
      const variantId = await casedVariant();
      await h.run(ops.setStockSettings, { variantId, trackingMode: 'lot_expiry' });
      const po = await h.run(ops.draftPurchaseOrder, {
        supplierId,
        warehouseId: shop.warehouseId,
        locationId: shelf,
        lines: [{ variantId, quantity: '1' }],
      });
      await h.run(ops.sendPurchaseOrder, { purchaseOrderId: po.id, email: false });
      return {
        op: ops.receivePurchaseOrderLine,
        input: {
          purchaseOrderId: po.id,
          lineId: po.lines[0].id,
          quantity: '12',
          inBaseUnits: true,
          lotCode: `PO-${uuidv7().slice(-6)}`,
          expiresOn: '2031-06-30',
        },
      };
    },
  },
  {
    label: 'closing a partly received order',
    setup: async () => {
      const po = await sent();
      await h.run(ops.receivePurchaseOrderLine, {
        purchaseOrderId: po.id,
        lineId: po.lineIds[0],
        quantity: '1',
      });
      return {
        op: ops.closePurchaseOrder,
        input: { purchaseOrderId: po.id, reason: 'The supplier is out of the rest.' },
      };
    },
  },
  {
    label: 'cancelling a sent order',
    setup: async () => {
      const po = await sent();
      return {
        op: ops.cancelPurchaseOrder,
        input: {
          purchaseOrderId: po.id,
          expectedVersion: po.version,
          reason: 'Ordered elsewhere.',
        },
      };
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
