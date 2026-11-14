import type { AnyOperation } from '../registry.ts';
import {
  createApiCredential,
  listApiCredentials,
  listConnections,
  revokeApiCredential,
  revokeConnection,
} from './access.ts';
import { getOperationOutcome, listActivity } from './activity.ts';
import { createItem, searchVariants } from './catalog.ts';
import { getAvailability, receiveStock, releaseReservation, reserveStock } from './inventory.ts';
import { createShop, getShopContext } from './shops.ts';
import { createLocation, createWarehouse, listLocations } from './storage.ts';

/** The operation registry: the single source for REST, OpenAPI, MCP tools, and audit names. */
export const operations: readonly AnyOperation[] = [
  createShop,
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
  listConnections,
  revokeConnection,
];

export const operationsById: ReadonlyMap<string, AnyOperation> = new Map(
  operations.map((op) => [op.id, op]),
);

export {
  createApiCredential,
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
  receiveStock,
  releaseReservation,
  reserveStock,
  revokeApiCredential,
  revokeConnection,
  searchVariants,
};
