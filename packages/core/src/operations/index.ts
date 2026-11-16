/**
 * The operation registry: the single source for REST, OpenAPI, MCP tools, and audit names.
 *
 * Each module lists its own operations at its end (`<module>Operations`). To add an operation,
 * define and export it in its module and append it to that list; this file does not change.
 * A new module adds one line in each of the three sorted groups below. `registry.test.ts`
 * fails when an exported operation is in no list, or in more than one (ADR 0005).
 */
import type { AnyOperation } from '../registry.ts';
import { accessOperations } from './access.ts';
import { activityOperations } from './activity.ts';
import { catalogOperations } from './catalog.ts';
import { catalogBulkOperations } from './catalog-bulk.ts';
import { catalogBundlesOperations } from './catalog-bundles.ts';
import { catalogItemsOperations } from './catalog-items.ts';
import { catalogPackagingOperations } from './catalog-packaging.ts';
import { catalogQueryOperations } from './catalog-query.ts';
import { catalogSchemaOperations } from './catalog-schema.ts';
import { catalogVariantsOperations } from './catalog-variants.ts';
import { importsOperations } from './imports.ts';
import { inventoryOperations } from './inventory.ts';
import { inventoryLotsOperations } from './inventory-lots.ts';
import { inventoryReservationsOperations } from './inventory-reservations.ts';
import { inventorySettingsOperations } from './inventory-settings.ts';
import { inventoryValuationOperations } from './inventory-valuation.ts';
import { labelsOperations } from './labels.ts';
import { mediaOperations } from './media.ts';
import { membersOperations } from './members.ts';
import { shopifyIntegrationCallbacks, shopifyOperations } from './shopify.ts';
import { shopsOperations } from './shops.ts';
import { storageOperations } from './storage.ts';
import { suppliersOperations } from './suppliers.ts';
import { webhooksOperations } from './webhooks.ts';

/** Every routed operation, module by module in file-name order. */
export const operations: readonly AnyOperation[] = [
  ...accessOperations,
  ...activityOperations,
  ...catalogOperations,
  ...catalogBulkOperations,
  ...catalogBundlesOperations,
  ...catalogItemsOperations,
  ...catalogPackagingOperations,
  ...catalogQueryOperations,
  ...catalogSchemaOperations,
  ...catalogVariantsOperations,
  ...importsOperations,
  ...inventoryOperations,
  ...inventoryLotsOperations,
  ...inventoryReservationsOperations,
  ...inventorySettingsOperations,
  ...inventoryValuationOperations,
  ...labelsOperations,
  ...mediaOperations,
  ...membersOperations,
  ...shopifyOperations,
  ...shopsOperations,
  ...storageOperations,
  ...suppliersOperations,
  ...webhooksOperations,
];

export const operationsById: ReadonlyMap<string, AnyOperation> = new Map(
  operations.map((op) => [op.id, op]),
);

/**
 * Integration callbacks: run through the pipeline like any operation, but only from the
 * Shopify install flow and verified webhooks. No REST route or MCP tool (plan Section 5.4).
 */
export const integrationCallbacks: readonly AnyOperation[] = [...shopifyIntegrationCallbacks];

export * from './access.ts';
export * from './activity.ts';
export * from './catalog.ts';
export * from './catalog-bulk.ts';
export * from './catalog-bundles.ts';
export * from './catalog-items.ts';
export * from './catalog-packaging.ts';
export * from './catalog-query.ts';
export * from './catalog-schema.ts';
export * from './catalog-variants.ts';
export * from './imports.ts';
export * from './inventory.ts';
export * from './inventory-lots.ts';
export * from './inventory-reservations.ts';
export * from './inventory-settings.ts';
export * from './inventory-valuation.ts';
export * from './labels.ts';
export * from './media.ts';
export * from './members.ts';
export * from './shopify.ts';
export * from './shops.ts';
export * from './storage.ts';
export * from './suppliers.ts';
export * from './webhooks.ts';
