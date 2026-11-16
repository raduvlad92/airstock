import { z } from 'zod';
import type { AuditEvent } from '../audit.ts';
import { NonNegativeDecimal } from '../decimal.ts';
import { errors } from '../errors.ts';
import { effectivePermissions } from '../permissions.ts';
import { defineOperation, type HandlerContext, type HandlerResult } from '../registry.ts';
import { Id } from '../schemas.ts';
import { createItem } from './catalog-items.ts';
import { receiveStock, StockCondition } from './inventory.ts';

// Quick add (plan 5.7, D5): one command that creates a one-of-a-kind item and receives it, or
// adds one serialized unit to a shared variant. The phone flow (I4) and MCP use it.

/** A sub-operation's audit details, recorded as its own event in the same transaction. */
function subEvent(
  ctx: HandlerContext,
  action: string,
  handled: HandlerResult<unknown>,
): AuditEvent {
  const a = handled.audit;
  return ctx.event({
    action,
    outcome: 'succeeded',
    target_type: a.targetType,
    target_id: a.targetId,
    operation_id: a.operationId ?? null,
    location_ids: a.locationIds ?? null,
    external_ref: a.externalRef ?? null,
    reason: a.reason ?? null,
    changes: a.changes ?? null,
    context: { via: 'inventory.quick_add' },
  });
}

export const quickAdd = defineOperation({
  id: 'inventory.quick_add',
  summary: 'Add a single item and receive it in one step',
  description:
    'Use this for one-of-a-kind items such as a graded card or a used set: creates the product as one of a kind, with its barcode (for example the grading certificate number), its family fields, and its price, and receives the single unit at a location, all in one command. With variantId and serial instead, adds one unit with that serial to an existing serial-tracked variant (units that share a price). Pictures are added afterwards with manage_media.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    locationId: Id,
    name: z.string().trim().min(1).max(500).optional().describe('Required for a new item.'),
    sku: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Defaults to the barcode, or a generated code.'),
    barcode: z.string().trim().min(1).max(200).optional(),
    price: z.string().max(30).optional(),
    description: z.string().max(50_000).optional(),
    family: z.string().max(200).optional().describe('Family ID or name, such as Trading cards.'),
    fields: z.record(z.string(), z.unknown()).optional().describe('Custom field values by key.'),
    status: z.enum(['draft', 'active']).default('active'),
    acknowledgeSimilar: z.boolean().default(false),
    variantId: Id.optional().describe('An existing serial-tracked variant to add one unit to.'),
    serial: z.string().trim().min(1).max(100).optional(),
    condition: StockCondition.default('sellable'),
    unitCost: NonNegativeDecimal.optional().describe('Needs costs.read.'),
    reference: z.string().trim().min(1).max(200).optional(),
  }),
  output: z.object({
    productId: Id,
    variantId: Id,
    sku: z.string(),
    created: z.boolean().describe('False when a unit was added to an existing variant.'),
    receipt: z.object({
      operationId: Id,
      positionId: Id,
      serialId: Id.nullable(),
    }),
  }),
  permission: 'catalog.write',
  connectionScope: 'catalog:write',
  audit: { action: 'inventory.quick_add.created' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/quick-add', status: 201 },
  mcp: { tool: 'receive_stock', action: 'quick_add', readOnly: false, destructive: false },
  locations: (input) => [input.locationId],
  async handler(ctx, input) {
    // Receiving needs its own permission and scope as well.
    if (!ctx.membership || !effectivePermissions(ctx.membership).has('inventory.receive')) {
      throw errors.forbidden('Requires the inventory.receive permission.');
    }
    if (ctx.caller.scopes !== 'all' && !ctx.caller.scopes.has('inventory:write')) {
      throw errors.forbidden('This connection was not granted the inventory:write scope.');
    }
    const events: AuditEvent[] = [];
    let productId: string;
    let variantId: string;
    let sku: string;
    let created: boolean;
    if (input.variantId) {
      if (!input.serial) {
        throw errors.validation([
          { path: 'serial', message: 'Give the serial of the unit to add to this variant.' },
        ]);
      }
      const [v] = await ctx.tx.query<{ product_id: string; sku: string; tracking_mode: string }>(
        'select product_id, sku, tracking_mode from variants where id = $1',
        [input.variantId],
      );
      if (!v) throw errors.notFound('Variant');
      if (v.tracking_mode !== 'serial') {
        throw errors.unprocessable(
          'not_serial_tracked',
          'Units are added to a variant tracked by serial; this one is not.',
        );
      }
      productId = v.product_id;
      variantId = input.variantId;
      sku = v.sku;
      created = false;
    } else {
      if (!input.name) {
        throw errors.validation([{ path: 'name', message: 'A new item needs a name.' }]);
      }
      if (input.serial) {
        throw errors.validation([
          { path: 'serial', message: 'A serial goes with variantId; a new item is one of a kind.' },
        ]);
      }
      const item = createItem.input.parse({
        name: input.name,
        sku: input.sku ?? input.barcode ?? `QA-${ctx.newId().slice(-8).toUpperCase()}`,
        ...(input.price !== undefined ? { price: input.price } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.family !== undefined ? { family: input.family } : {}),
        ...(input.fields !== undefined ? { fields: input.fields } : {}),
        ...(input.barcode !== undefined ? { barcode: input.barcode } : {}),
        status: input.status,
        acknowledgeSimilar: input.acknowledgeSimilar,
      });
      const made = await createItem.handler(ctx, item);
      events.push(subEvent(ctx, createItem.audit.action, made));
      productId = made.result.productId;
      variantId = made.result.variantId;
      sku = made.result.sku;
      created = true;
      // A fresh variant has no stock, so it can become one of a kind at once (D5).
      await ctx.tx.query(
        'update variants set one_of_a_kind = true, version = version + 1 where id = $1',
        [variantId],
      );
    }
    const receipt = await receiveStock.handler(
      ctx,
      receiveStock.input.parse({
        variantId,
        locationId: input.locationId,
        quantity: '1',
        condition: input.condition,
        ...(input.serial ? { serials: [input.serial] } : {}),
        ...(input.unitCost !== undefined ? { unitCost: input.unitCost } : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        reason: created ? 'quick add' : 'quick add of a serialized unit',
      }),
    );
    events.push(subEvent(ctx, receiveStock.audit.action, receipt), ...(receipt.events ?? []));
    return {
      result: {
        productId,
        variantId,
        sku,
        created,
        receipt: {
          operationId: receipt.result.operationId,
          positionId: receipt.result.position.positionId,
          serialId: receipt.result.serials[0]?.serialId ?? null,
        },
      },
      audit: {
        targetType: 'variant',
        targetId: variantId,
        operationId: receipt.result.operationId,
        locationIds: [input.locationId],
        externalRef: input.reference ?? null,
        changes: { productId, sku, created, serial: input.serial ?? null },
      },
      outbox: receipt.outbox ?? [],
      events,
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const inventoryQuickAddOperations = [quickAdd] as const;
