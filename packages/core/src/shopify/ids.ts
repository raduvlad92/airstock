import { z } from 'zod';

/** A Shopify resource ID, as a GID (gid://shopify/Location/123) or the bare number. */
export const ShopifyId = z
  .string()
  .regex(/^(gid:\/\/shopify\/[A-Za-z]+\/)?[0-9]{1,20}$/, 'A Shopify ID or GID.');

export function shopifyNumericId(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

/** Mapping decides what Shopify sells; it needs a person comparing both catalogs. */
export const MAPPING_IN_DASHBOARD =
  'Mapping decides what a Shopify store sells, so a person does it in the dashboard, where both catalogs are side by side.';
