import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { compare, isDecimal, normalize, subtract } from '../catalog/decimal.ts';
import { errors } from '../errors.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id, iso } from '../schemas.ts';
import { actorColumns, applyStockCost } from '../stock/engine.ts';
import {
  MAX_STORED_PROBLEMS,
  readStockProblems,
  type StockProblem,
} from '../stock/reconciliation.ts';

// The stock check (D18): the result of the scheduled reconciliation, and the reviewed repair of a
// reported problem. A repair is never automatic. A person previews the compensating operation,
// then commits it with an explicit confirmation and a reason; it records new history and never
// edits an earlier movement (PRD 6.1, rule 10). Milestone I2's adjustments can take over the
// ledger repair later.

export const ProblemKind = z.enum([
  'on_hand_mismatch',
  'allocated_mismatch',
  'over_allocated',
  'reservation_total_mismatch',
  'reservation_status_mismatch',
  'bundle_component_mismatch',
  'serial_mismatch',
  'cost_quantity_mismatch',
]);
type ProblemKind = z.infer<typeof ProblemKind>;

/** What each problem means, in a sentence for people. */
const PROBLEM_TITLES: Record<ProblemKind, string> = {
  on_hand_mismatch: 'On hand differs from the stock history',
  allocated_mismatch: 'Reserved at a position differs from its open allocations',
  over_allocated: 'More units are allocated than are on hand',
  reservation_total_mismatch: 'A reservation’s quantity differs from what it holds',
  reservation_status_mismatch: 'A reservation’s status differs from what is still open',
  bundle_component_mismatch: 'A bundle component reservation has the wrong quantity',
  serial_mismatch: 'A serial’s status differs from the stock that holds it',
  cost_quantity_mismatch: 'The quantity behind the average cost differs from stock',
};

/** Problems with a compensating repair; the rest need a person to look at the records. */
const REPAIRABLE: ReadonlySet<ProblemKind> = new Set([
  'on_hand_mismatch',
  'allocated_mismatch',
  'cost_quantity_mismatch',
]);

const Problem = z.object({
  problem: ProblemKind,
  title: z.string(),
  targetType: z.enum(['position', 'reservation', 'serial_unit', 'variant']),
  targetId: Id,
  expected: z.string().describe('What the history (or the source records) says.'),
  actual: z.string().describe('What the stored figure says.'),
  variantId: Id.nullable(),
  sku: z.string().nullable(),
  locationPath: z.string().nullable(),
  repairable: z.boolean().describe('Whether a reviewed repair is offered for this problem.'),
});
type ProblemOut = z.infer<typeof Problem>;

/** Quantities without trailing zeros; a status (for reservation problems) as it is. */
function figure(value: string): string {
  return isDecimal(value) ? normalize(value) : value;
}

/** Adds the SKU and location a person needs to find each problem. */
async function describeProblems(tx: Tx, problems: StockProblem[]): Promise<ProblemOut[]> {
  if (problems.length === 0) return [];
  const rows = await tx.query<{
    target_id: string;
    variant_id: string | null;
    sku: string | null;
    location_path: string | null;
  }>(
    `with t as (select * from jsonb_to_recordset($1::jsonb) as x("targetType" text, "targetId" uuid))
     select t."targetId" as target_id, v.id as variant_id, v.sku, l.path as location_path
     from t
     left join inventory_positions p on t."targetType" = 'position' and p.id = t."targetId"
     left join reservations r on t."targetType" = 'reservation' and r.id = t."targetId"
     left join serial_units s on t."targetType" = 'serial_unit' and s.id = t."targetId"
     left join variants v on v.id = coalesce(p.variant_id, r.variant_id, s.variant_id,
       case when t."targetType" = 'variant' then t."targetId" end)
     left join locations l on l.id = p.location_id`,
    [JSON.stringify(problems.map((p) => ({ targetType: p.targetType, targetId: p.targetId })))],
  );
  const byTarget = new Map(rows.map((r) => [r.target_id, r]));
  return problems.map((p) => {
    const kind = p.problem as ProblemKind;
    const label = byTarget.get(p.targetId);
    return {
      problem: kind,
      title: PROBLEM_TITLES[kind] ?? p.problem,
      targetType: p.targetType as ProblemOut['targetType'],
      targetId: p.targetId,
      expected: figure(p.expected),
      actual: figure(p.actual),
      variantId: label?.variant_id ?? null,
      sku: label?.sku ?? null,
      locationPath: label?.location_path ?? null,
      repairable: REPAIRABLE.has(kind),
    };
  });
}

const CheckSummary = z.object({
  id: Id,
  trigger: z.enum(['scheduled', 'daily']),
  checkedAt: z.string(),
  problemCount: z.number(),
});

export const getStockCheck = defineOperation({
  id: 'inventory.reconciliation.get',
  summary: 'Get the stock check result',
  description:
    'Use this for "does my stock add up" questions. Airstock checks every 30 minutes after stock changes, and daily, that history, balances, reservations, serials, and the quantity behind the average cost agree. Returns the latest scheduled checks, the reconciliation alert, and the problems found right now. Repairs are made by a person in the dashboard or over REST.',
  kind: 'read',
  scope: 'shop',
  input: z.object({}),
  output: z.object({
    lastCheck: CheckSummary.nullable(),
    recent: z.array(CheckSummary).describe('The last 10 scheduled checks, newest first.'),
    alert: z
      .object({
        id: Id,
        status: z.enum(['open', 'acknowledged', 'resolved']),
        openedAt: z.string(),
        lastSeenAt: z.string(),
        occurrences: z.number().describe('Checks that found problems while the alert was open.'),
        resolvedAt: z.string().nullable(),
      })
      .nullable()
      .describe('The open reconciliation alert, else the last resolved one.'),
    current: z.object({
      problemCount: z.number(),
      problems: z.array(Problem).describe(`At most ${MAX_STORED_PROBLEMS}.`),
    }),
  }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'inventory.reconciliation.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/stock-check' },
  mcp: { tool: 'get_stock', action: 'stock_check', readOnly: true, destructive: false },
  async handler(ctx) {
    const recent = await ctx.tx.query<{
      id: string;
      trigger: 'scheduled' | 'daily';
      checked_at: Date;
      problems: number;
    }>(
      `select id, trigger, checked_at, problems from stock_reconciliations
       order by checked_at desc, id desc limit 10`,
    );
    const [alert] = await ctx.tx.query<{
      id: string;
      status: 'open' | 'acknowledged' | 'resolved';
      opened_at: Date;
      last_seen_at: Date;
      occurrences: number;
      resolved_at: Date | null;
    }>(
      `select id, status, opened_at, last_seen_at, occurrences, resolved_at from alerts
       where dedupe_key = 'reconciliation'
       order by (status <> 'resolved') desc, opened_at desc, id desc limit 1`,
    );
    const problems = await readStockProblems(ctx.tx);
    const summaries = recent.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      checkedAt: iso(r.checked_at)!,
      problemCount: r.problems,
    }));
    return {
      result: {
        lastCheck: summaries[0] ?? null,
        recent: summaries,
        alert: alert
          ? {
              id: alert.id,
              status: alert.status,
              openedAt: iso(alert.opened_at)!,
              lastSeenAt: iso(alert.last_seen_at)!,
              occurrences: alert.occurrences,
              resolvedAt: iso(alert.resolved_at),
            }
          : null,
        current: {
          problemCount: problems.length,
          problems: await describeProblems(ctx.tx, problems.slice(0, MAX_STORED_PROBLEMS)),
        },
      },
      audit: { targetType: 'shop', targetId: ctx.shopId, context: { problems: problems.length } },
    };
  },
});

// Repairs ------------------------------------------------------------------------------------

const RepairTarget = z.object({
  problem: ProblemKind,
  targetId: Id.describe('The position or variant the problem names.'),
});

const RepairPlan = z.object({
  summary: z.string().describe('What the repair records, in a sentence.'),
  field: z
    .enum(['history', 'allocated', 'owned_quantity'])
    .describe(
      'history: a ledger entry so history explains the balance; allocated: the reserved total set from the open allocations; owned_quantity: a cost-history entry so the quantity behind the average matches stock.',
    ),
  from: z.string(),
  to: z.string(),
  delta: z.string(),
});

/** The reported figures and the repair for one problem, read under the locks the repair takes. */
interface Plan {
  problem: ProblemOut;
  repair: z.infer<typeof RepairPlan>;
  position: {
    id: string;
    variant_id: string;
    location_id: string;
    lot_id: string | null;
    serial_id: string | null;
  } | null;
}

/** Locations a repair touches: the position's, so location scopes apply. */
async function repairLocations(input: z.infer<typeof RepairTarget>, tx: Tx): Promise<string[]> {
  if (input.problem === 'cost_quantity_mismatch') return [];
  const [row] = await tx.query<{ location_id: string }>(
    'select location_id from inventory_positions where id = $1',
    [input.targetId],
  );
  return row ? [row.location_id] : [];
}

/**
 * Reads the problem as it stands now and works out its repair. With `lock`, it takes the locks
 * the repair needs first, in the engine's order: the position (or every position of the variant),
 * then the variant's cost row.
 */
async function planRepair(
  ctx: HandlerContext,
  input: z.infer<typeof RepairTarget>,
  lock: boolean,
): Promise<Plan | null> {
  const { tx } = ctx;
  if (!REPAIRABLE.has(input.problem)) return null;
  if (input.problem === 'cost_quantity_mismatch') {
    if (ctx.locationScope !== null) {
      throw errors.forbidden(
        'This repair covers the variant in every location; your access is limited to locations.',
      );
    }
    const [variant] = await tx.query('select 1 from variants where id = $1', [input.targetId]);
    if (!variant) throw errors.notFound('Variant');
    if (lock) {
      await tx.query(
        'select id from inventory_positions where variant_id = $1 order by id for share',
        [input.targetId],
      );
      // The cost row exists before it is locked, so a receipt that creates it cannot slip past.
      await tx.query(
        `insert into variant_costs (shop_id, variant_id) values (app_shop_id(), $1)
         on conflict do nothing`,
        [input.targetId],
      );
      await tx.query('select 1 from variant_costs where variant_id = $1 for update', [
        input.targetId,
      ]);
    }
    const [row] = await tx.query<{ expected: string; actual: string }>(
      `select coalesce((select sum(on_hand) from inventory_positions where variant_id = $1), 0)::text
           as expected,
         coalesce((select quantity from variant_costs where variant_id = $1), 0)::text as actual`,
      [input.targetId],
    );
    const expected = normalize(row!.expected);
    const actual = normalize(row!.actual);
    if (compare(expected, actual) === 0) return null;
    const [problem] = await describeProblems(tx, [
      {
        problem: input.problem,
        targetType: 'variant',
        targetId: input.targetId,
        expected,
        actual,
      },
    ]);
    const delta = normalize(subtract(expected, actual));
    return {
      problem: problem!,
      position: null,
      repair: {
        summary: `Record ${signed(delta)} in the cost history of ${problem!.sku ?? 'this variant'}, so the quantity behind its average cost is ${expected}, the units in stock. Stock does not change.`,
        field: 'owned_quantity',
        from: actual,
        to: expected,
        delta,
      },
    };
  }

  const [position] = await tx.query<{
    id: string;
    variant_id: string;
    location_id: string;
    lot_id: string | null;
    serial_id: string | null;
  }>(
    `select id, variant_id, location_id, lot_id, serial_id from inventory_positions
     where id = $1${lock ? ' for update' : ''}`,
    [input.targetId],
  );
  if (!position) throw errors.notFound('Stock position');
  const [row] = await tx.query<{ expected: string; actual: string }>(
    input.problem === 'on_hand_mismatch'
      ? `select coalesce((select sum(delta) from inventory_entries where position_id = $1), 0)::text
           as expected, (select on_hand from inventory_positions where id = $1)::text as actual`
      : `select coalesce((select sum(outstanding) from reservation_allocations
             where position_id = $1), 0)::text as expected,
           (select allocated from inventory_positions where id = $1)::text as actual`,
    [input.targetId],
  );
  const expected = normalize(row!.expected);
  const actual = normalize(row!.actual);
  if (compare(expected, actual) === 0) return null;
  const [problem] = await describeProblems(tx, [
    { problem: input.problem, targetType: 'position', targetId: input.targetId, expected, actual },
  ]);
  const where = `${problem!.sku ?? 'this variant'} at ${problem!.locationPath ?? 'this location'}`;
  if (input.problem === 'on_hand_mismatch') {
    // The balance is what availability, reservations, and Shopify have used. The history gets an
    // adjustment that explains it; a count corrects the balance if the shelf disagrees.
    const delta = normalize(subtract(actual, expected));
    return {
      problem: problem!,
      position,
      repair: {
        summary: `Record an adjustment of ${signed(delta)} for ${where}, so the history adds up to the balance of ${actual}. On hand does not change; count the shelf afterwards if ${actual} is wrong.`,
        field: 'history',
        from: expected,
        to: actual,
        delta,
      },
    };
  }
  const delta = normalize(subtract(expected, actual));
  return {
    problem: problem!,
    position,
    repair: {
      summary: `Set reserved for ${where} from ${actual} to ${expected}, the total of its open allocations. On hand and the reservations do not change.`,
      field: 'allocated',
      from: actual,
      to: expected,
      delta,
    },
  };
}

function signed(delta: string): string {
  return delta.startsWith('-') ? delta : `+${delta}`;
}

export const previewStockRepair = defineOperation({
  id: 'inventory.reconciliation.preview_repair',
  summary: 'Preview the repair of a stock check problem',
  description:
    'Shows the compensating operation that would fix one problem the stock check reports, without changing anything. Commit it with the repair operation, a reason, and confirm: true.',
  kind: 'read',
  scope: 'shop',
  input: RepairTarget,
  output: z.object({
    reported: z.boolean().describe('False when the problem is no longer there.'),
    problem: Problem.nullable(),
    repair: RepairPlan.nullable().describe('Null when no repair is offered for this problem.'),
    guidance: z.string().nullable().describe('What to do when no repair is offered.'),
  }),
  permission: 'inventory.adjust',
  connectionScope: 'inventory:read',
  audit: { action: 'inventory.reconciliation.repair_previewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/stock-check/repair-preview' },
  mcp: {
    exception:
      'A stock repair is reviewed by a person: previewed and committed in the dashboard or over REST. get_stock (stock_check) reports the problems.',
  },
  locations: repairLocations,
  async handler(ctx, input) {
    if (!REPAIRABLE.has(input.problem)) {
      const [current] = await readStockProblems(ctx.tx, input);
      return {
        result: {
          reported: current !== undefined,
          problem: current ? ((await describeProblems(ctx.tx, [current]))[0] ?? null) : null,
          repair: null,
          guidance: current
            ? 'No automatic repair is offered for this problem. Open the reservation, serial, or position in the dashboard and check its history; contact support if it does not add up.'
            : null,
        },
        audit: {
          targetType: current?.targetType ?? 'shop',
          targetId: input.targetId,
          context: { input },
        },
      };
    }
    const plan = await planRepair(ctx, input, false);
    return {
      result: {
        reported: plan !== null,
        problem: plan?.problem ?? null,
        repair: plan?.repair ?? null,
        guidance: null,
      },
      audit: {
        targetType: plan?.problem.targetType ?? 'shop',
        targetId: input.targetId,
        context: { input },
      },
    };
  },
});

export const repairStockProblem = defineOperation({
  id: 'inventory.reconciliation.repair',
  summary: 'Repair a stock check problem',
  description:
    'Commits the compensating operation the preview showed for one problem, with a reason. Fails with problem_changed when the figures differ from the preview (preview again) and problem_resolved when the problem is gone. Never edits earlier history.',
  kind: 'command',
  scope: 'shop',
  input: RepairTarget.extend({
    expected: z.string().max(100).describe('The expected figure from the preview.'),
    actual: z.string().max(100).describe('The actual figure from the preview.'),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe('Why the repair is right, such as what a count or the records showed.'),
    confirm: z.literal(true).describe('Must be true: the person reviewed the preview.'),
  }),
  output: z.object({
    operationId: Id,
    problem: Problem,
    repair: RepairPlan,
  }),
  permission: 'inventory.adjust',
  connectionScope: 'inventory:write',
  audit: { action: 'inventory.reconciliation.repaired' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/stock-check/repairs', status: 201 },
  mcp: {
    exception:
      'A stock repair is reviewed by a person: previewed and committed in the dashboard or over REST. Milestone I2’s adjust_stock can take it later.',
  },
  locations: repairLocations,
  async handler(ctx, input) {
    if (!REPAIRABLE.has(input.problem)) {
      throw errors.unprocessable(
        'repair_not_available',
        'No automatic repair is offered for this problem. Check the records it names by hand.',
      );
    }
    const plan = await planRepair(ctx, input, true);
    if (!plan) {
      throw errors.conflict(
        'problem_resolved',
        'The stock check no longer reports this problem; there is nothing to repair.',
      );
    }
    if (
      figure(input.expected) !== plan.problem.expected ||
      figure(input.actual) !== plan.problem.actual
    ) {
      throw errors.conflict(
        'problem_changed',
        'The figures changed since the preview. Preview the repair again and review it.',
        { expected: plan.problem.expected, actual: plan.problem.actual },
      );
    }

    const operationId = ctx.newId();
    await ctx.tx.query(
      `insert into inventory_operations (shop_id, id, kind, actor_type, actor_id, source,
         attempt_id, reason)
       values (app_shop_id(), $1, 'adjustment', $2, $3, $4, $5, 'reconciliation')`,
      [operationId, ...actorColumns(ctx)],
    );
    const { repair, position } = plan;
    let cost: Awaited<ReturnType<typeof applyStockCost>> | null = null;
    if (repair.field === 'history' && position) {
      // A ledger entry only: the balance already holds these units (or lacks them).
      await ctx.tx.query(
        `insert into inventory_entries (shop_id, id, operation_id, position_id, variant_id,
           location_id, delta, lot_id, serial_id, cost_basis)
         values (app_shop_id(), $1, $2, $3, $4, $5, $6::numeric, $7, $8, 'none')`,
        [
          ctx.newId(),
          operationId,
          position.id,
          position.variant_id,
          position.location_id,
          repair.delta,
          position.lot_id,
          position.serial_id,
        ],
      );
    } else if (repair.field === 'allocated' && position) {
      // Allocations change only while their position is locked (ADR 0006), so the sum is stable.
      const [updated] = await ctx.tx.query(
        `update inventory_positions set allocated = $2::numeric, version = version + 1,
           updated_at = now()
         where id = $1 and $2::numeric <= on_hand returning id`,
        [position.id, repair.to],
      );
      if (!updated) {
        throw errors.conflict(
          'allocation_exceeds_stock',
          'The open allocations exceed the units on hand. Release or reallocate a reservation first.',
        );
      }
    } else {
      cost = await applyStockCost(
        ctx,
        input.targetId,
        operationId,
        'adjustment',
        repair.delta,
        null,
      );
    }

    const changes = {
      problem: input.problem,
      field: repair.field,
      from: repair.from,
      to: repair.to,
      delta: repair.delta,
      ...(position ? { positionId: position.id } : {}),
      ...(cost
        ? {
            restricted: {
              permission: 'costs.read',
              fields: { unitCost: cost.unitCost, averageAfter: cost.averageAfter },
            },
          }
        : {}),
    };
    return {
      result: { operationId, problem: plan.problem, repair },
      audit: {
        targetType: plan.problem.targetType,
        targetId: input.targetId,
        operationId,
        locationIds: position ? [position.location_id] : [],
        reason: input.reason,
        changes,
        context: { source: 'reconciliation' },
      },
      // Reserved changed, so availability did too.
      outbox:
        repair.field === 'allocated' && position
          ? [
              {
                topic: 'inventory.availability_changed',
                payload: { reason: 'reconciliation', positionIds: [position.id] },
              },
            ]
          : [],
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const inventoryReconciliationOperations = [
  getStockCheck,
  previewStockRepair,
  repairStockProblem,
] as const;
