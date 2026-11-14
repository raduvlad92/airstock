import type { AnyOperation } from '../registry.ts';
import {
  createApiCredential,
  createConnection,
  listApiCredentials,
  listConnections,
  revokeApiCredential,
  revokeConnection,
} from './access.ts';
import { getOperationOutcome, listActivity } from './activity.ts';
import { createItem, searchVariants } from './catalog.ts';
import { getAvailability, receiveStock, releaseReservation, reserveStock } from './inventory.ts';
import {
  connectShopifyStore,
  listShopifyConnections,
  markShopifyUninstalled,
  recordShopifyWebhook,
  setShopifyMappings,
  updateShopifyConnectionDetails,
} from './shopify.ts';
import { createShop, getShopContext, listShops } from './shops.ts';
import { createLocation, createWarehouse, listLocations } from './storage.ts';

/** The operation registry: the single source for REST, OpenAPI, MCP tools, and audit names. */
export const operations: readonly AnyOperation[] = [
  createShop,
  listShops,
  getShopContext,
  createItem,
  searchVariants,
  createWarehouse,
  createLocation,
  listLocations,
  receiveStock,
  reserveStock,
  releaseReservation,
  getAvailability,
  listActivity,
  getOperationOutcome,
  createApiCredential,
  listApiCredentials,
  revokeApiCredential,
  createConnection,
  listConnections,
  revokeConnection,
  listShopifyConnections,
  setShopifyMappings,
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
  connectShopifyStore,
  createApiCredential,
  createConnection,
  createItem,
  createLocation,
  createShop,
  createWarehouse,
  getAvailability,
  getOperationOutcome,
  getShopContext,
  listActivity,
  listApiCredentials,
  listConnections,
  listLocations,
  listShopifyConnections,
  listShops,
  markShopifyUninstalled,
  receiveStock,
  recordShopifyWebhook,
  releaseReservation,
  reserveStock,
  revokeApiCredential,
  revokeConnection,
  searchVariants,
  setShopifyMappings,
  updateShopifyConnectionDetails,
};
