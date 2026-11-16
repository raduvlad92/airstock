import { ops } from '@airstock/core';
import { afterAll, expect } from 'vitest';
import {
  appDatabase,
  boundCaller,
  createVariant,
  harness,
  MemoryAuditSink,
  ownerQuery,
  reconcile,
  seedShop,
} from '../../../test/helpers.ts';
import {
  type ContractCase,
  type ContractShop,
  describeFailureContract,
  subscribeAll,
} from './failure-contract.ts';

// The failure contract (PRD 7.3, G17) for the stock-check repair (D18, ADR 0020 update): each of
// the three repairs (history, reserved, owned quantity) is committed through the preview's
// figures. A rolled-back repair leaves its problem in place, so each case gets its own shop.

const db = appDatabase({}, 8);
const sink = new MemoryAuditSink();
let current: ContractShop;
afterAll(() => db.close());

/** A fresh shop with 10 units of one variant, its position, and its harness. */
async function stockedShop() {
  const shop = await seedShop(db, sink, 'Stock check failures shop');
  const h = harness(db, sink, shop);
  await subscribeAll(shop.shopId);
  const variantId = await createVariant(h);
  await h.run(ops.receiveStock, {
    variantId,
    locationId: shop.locationId,
    quantity: '10',
    unitCost: '2',
  });
  const [position] = await ownerQuery<{ id: string }>(
    'select id from inventory_positions where shop_id = $1 and variant_id = $2',
    [shop.shopId, variantId],
  );
  current = { db, sink, shopId: shop.shopId, caller: shop.caller, owner: await boundCaller(shop) };
  return { shop, h, variantId, positionId: position!.id };
}

/** The commit input for a problem, from its preview, as a person would send it. */
async function commitFor(
  h: ReturnType<typeof harness>,
  problem: string,
  targetId: string,
  reason: string,
) {
  const preview = await h.run(ops.previewStockRepair, { problem, targetId });
  expect(preview.repair).not.toBeNull();
  return {
    problem,
    targetId,
    expected: preview.problem.expected,
    actual: preview.problem.actual,
    reason,
    confirm: true,
  };
}

const cases: ContractCase[] = [
  {
    label: 'repairing the history of a balance',
    setup: async () => {
      const { h, positionId, shop } = await stockedShop();
      await ownerQuery('update inventory_positions set on_hand = on_hand + 3 where id = $1', [
        positionId,
      ]);
      return {
        op: ops.repairStockProblem,
        input: await commitFor(h, 'on_hand_mismatch', positionId, 'Counted 13 on the shelf.'),
        // The owned quantity behind the average is a second problem, with its own repair.
        verify: async () => {
          const left = await reconcile(shop.shopId);
          expect(left).toHaveLength(1);
          expect(left[0]).toMatch(/^cost_quantity_mismatch/);
        },
      };
    },
  },
  {
    label: 'repairing reserved from the open allocations',
    setup: async () => {
      const { h, positionId, variantId, shop } = await stockedShop();
      await h.run(ops.reserveStock, { variantId, quantity: '4' });
      await ownerQuery('update inventory_positions set allocated = 1 where id = $1', [positionId]);
      return {
        op: ops.repairStockProblem,
        input: await commitFor(
          h,
          'allocated_mismatch',
          positionId,
          'Reserved follows the reservations.',
        ),
        verify: async () => expect(await reconcile(shop.shopId)).toEqual([]),
      };
    },
  },
  {
    label: 'repairing the owned quantity behind the average cost',
    setup: async () => {
      const { h, positionId, variantId, shop } = await stockedShop();
      await ownerQuery('update inventory_positions set on_hand = on_hand + 3 where id = $1', [
        positionId,
      ]);
      await h.run(
        ops.repairStockProblem,
        await commitFor(h, 'on_hand_mismatch', positionId, 'Counted 13 on the shelf.'),
      );
      return {
        op: ops.repairStockProblem,
        input: await commitFor(
          h,
          'cost_quantity_mismatch',
          variantId,
          'The cost row follows the counted stock.',
        ),
        verify: async () => expect(await reconcile(shop.shopId)).toEqual([]),
      };
    },
  },
];

describeFailureContract(cases, () => current, { clean: false });
