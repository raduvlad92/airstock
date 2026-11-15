import type { AnyOperation } from '../registry.ts';
import {
  createApiCredential,
  createConnection,
  listApiCredentials,
  listConnections,
  revokeApiCredential,
  revokeConnection,
} from './access.ts';
import { getOperationOutcome, listActivity, recordClientEvents } from './activity.ts';
import { searchVariants } from './catalog.ts';
import {
  archiveProduct,
  archiveVariant,
  createItem,
  getItem,
  restoreProduct,
  restoreVariant,
  updateItem,
} from './catalog-items.ts';
import {
  checkDuplicates,
  deleteView,
  listSavedViews,
  queryItems,
  saveView,
} from './catalog-query.ts';
import {
  addTemplate,
  convertField,
  createFamily,
  createField,
  describeCatalog,
  updateFamily,
  updateField,
  updateFieldOptions,
} from './catalog-schema.ts';
import { generateVariants, setProductOptions } from './catalog-variants.ts';
import { getAvailability, receiveStock, releaseReservation, reserveStock } from './inventory.ts';
import { inviteMember, listMembers } from './members.ts';
import {
  connectShopifyStore,
  listShopifyConnections,
  markShopifyUninstalled,
  recordShopifyWebhook,
  setShopifyMappings,
  updateShopifyConnectionDetails,
} from './shopify.ts';
import { createShop, getShopContext, listShops, updateShopSettings } from './shops.ts';
import { createLocation, createWarehouse, listLocations } from './storage.ts';

/** The operation registry: the single source for REST, OpenAPI, MCP tools, and audit names. */
export const operations: readonly AnyOperation[] = [
  createShop,
  listShops,
  getShopContext,
  updateShopSettings,
  describeCatalog,
  createField,
  updateField,
  updateFieldOptions,
  convertField,
  createFamily,
  updateFamily,
  addTemplate,
  createItem,
  getItem,
  queryItems,
  checkDuplicates,
  listSavedViews,
  saveView,
  deleteView,
  updateItem,
  setProductOptions,
  generateVariants,
  archiveProduct,
  restoreProduct,
  archiveVariant,
  restoreVariant,
  searchVariants,
  createWarehouse,
  createLocation,
  listLocations,
  receiveStock,
  reserveStock,
  releaseReservation,
  getAvailability,
  listActivity,
  recordClientEvents,
  getOperationOutcome,
  createApiCredential,
  listApiCredentials,
  revokeApiCredential,
  createConnection,
  listConnections,
  revokeConnection,
  listShopifyConnections,
  setShopifyMappings,
  inviteMember,
  listMembers,
];

export const operationsById: ReadonlyMap<string, AnyOperation> = new Map(
  operations.map((op) => [op.id, op]),
);

/**
 * Integration callbacks: run through the pipeline like any operation, but only from the
 * Shopify install flow and verified webhooks. No REST route or MCP tool (plan Section 5.4).
 */
export const integrationCallbacks: readonly AnyOperation[] = [
  connectShopifyStore,
  updateShopifyConnectionDetails,
  recordShopifyWebhook,
  markShopifyUninstalled,
];

export {
  addTemplate,
  archiveProduct,
  archiveVariant,
  checkDuplicates,
  connectShopifyStore,
  convertField,
  createApiCredential,
  createConnection,
  createFamily,
  createField,
  createItem,
  createLocation,
  createShop,
  createWarehouse,
  deleteView,
  describeCatalog,
  generateVariants,
  getAvailability,
  getItem,
  getOperationOutcome,
  getShopContext,
  inviteMember,
  listActivity,
  listApiCredentials,
  listConnections,
  listLocations,
  listMembers,
  listSavedViews,
  listShopifyConnections,
  listShops,
  markShopifyUninstalled,
  queryItems,
  receiveStock,
  recordClientEvents,
  recordShopifyWebhook,
  releaseReservation,
  reserveStock,
  restoreProduct,
  restoreVariant,
  revokeApiCredential,
  revokeConnection,
  saveView,
  searchVariants,
  setProductOptions,
  setShopifyMappings,
  updateFamily,
  updateField,
  updateFieldOptions,
  updateItem,
  updateShopifyConnectionDetails,
  updateShopSettings,
};
