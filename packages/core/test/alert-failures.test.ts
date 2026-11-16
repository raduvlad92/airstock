import { type Caller, ops } from '@airstock/core';
import { afterAll, beforeAll } from 'vitest';
import {
  appDatabase,
  boundCaller,
  createVariant,
  type Harness,
  harness,
  MemoryAuditSink,
  ownerQuery,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';
import { type ContractCase, describeFailureContract, subscribeAll } from './failure-contract.ts';

// The failure contract (PRD 7.3, G17) for alerts and reorder rules (ADR 0030): acknowledging an
// alert, adding a rule that opens an alert (webhook and email), changing a rule so its alert
// resolves, removing a rule, and the alert preferences and shop setting.

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
let owner: Caller;
let days = 30;

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Alert failures shop');
  h = harness(db, sink, shop);
  owner = await boundCaller(shop);
  await subscribeAll(shop.shopId);
  // The owner gets low-stock alerts by email too, so an opening queues a notification.
  await h.run(ops.setAlertPreferences, { preferences: [{ kind: 'low_stock', email: true }] });
});
afterAll(() => db.close());

/** A variant with 4 on hand. */
async function stocked(): Promise<string> {
  const variantId = await createVariant(h);
  await h.run(ops.receiveStock, { variantId, locationId: shop.locationId, quantity: '4' });
  return variantId;
}

/** A rule at 10 for a variant with 4 on hand: its low-stock alert is open. */
async function lowRule(): Promise<{ ruleId: string; version: number; alertId: string }> {
  const variantId = await stocked();
  const res = await h.run(ops.setReorderRule, {
    variantId,
    warehouseId: shop.warehouseId,
    reorderPoint: '10',
    reorderQuantity: '12',
  });
  const [alert] = await ownerQuery<{ id: string }>(
    `select id from alerts where shop_id = $1 and rule_id = $2 and status = 'open'`,
    [shop.shopId, res.rule.id],
  );
  return { ruleId: res.rule.id, version: res.rule.version, alertId: alert!.id };
}

const cases: ContractCase[] = [
  {
    label: 'acknowledging an alert',
    setup: async () => {
      const { alertId } = await lowRule();
      return {
        op: ops.acknowledgeAlert,
        input: { alertId, note: 'Ordering more on Monday.' },
      };
    },
  },
  {
    label: 'adding a rule that opens an alert',
    setup: async () => {
      const variantId = await stocked();
      return {
        op: ops.setReorderRule,
        input: {
          variantId,
          warehouseId: shop.warehouseId,
          reorderPoint: '6',
          maximumLevel: '20',
        },
      };
    },
  },
  {
    label: 'lowering a rule’s point so its alert resolves',
    setup: async () => {
      const rule = await lowRule();
      return {
        op: ops.setReorderRule,
        input: { ruleId: rule.ruleId, expectedVersion: rule.version, reorderPoint: '2' },
      };
    },
  },
  {
    label: 'removing a rule',
    setup: async () => {
      const rule = await lowRule();
      return {
        op: ops.removeReorderRule,
        input: { ruleId: rule.ruleId, expectedVersion: rule.version },
      };
    },
  },
  {
    label: 'choosing alert preferences',
    setup: async () => ({
      op: ops.setAlertPreferences,
      input: {
        preferences: [
          { kind: 'lot_expiring', email: true },
          { kind: 'shortage', inApp: false },
        ],
      },
    }),
  },
  {
    label: 'the shop’s alert setting',
    setup: async () => {
      days += 1;
      return { op: ops.setAlertSettings, input: { lotExpiryAlertDays: days } };
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
