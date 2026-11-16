/**
 * Granular permissions. Checks always name a permission, never a role, so roles can change
 * without touching the UI, API, or MCP (PRD 2.3). The starter roles are a proposal.
 */
export const PERMISSIONS = [
  'shop.read',
  'shop.manage',
  'catalog.read',
  'catalog.write',
  /** Create, change, and archive fields, options, and families; see restricted fields. */
  'catalog.schema.manage',
  /** See supplier costs and other cost values. */
  'costs.read',
  'storage.read',
  'storage.manage',
  /** See and change warehouse contracts, fees, and rates. */
  'storage.commercial.read',
  'inventory.read',
  'inventory.receive',
  'inventory.reserve',
  /** Ship reserved units: lowers on hand and reserved together (PRD 6.3). */
  'inventory.fulfill',
  'activity.read',
  'credentials.manage',
  'connections.manage',
  'members.manage',
  /** Records what a connected sales channel reports, such as a Shopify order. */
  'integrations.sync',
  'imports.run',
  'exports.run',
  /** Create and change outgoing webhook subscriptions, and see their deliveries (D14). */
  'webhooks.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  'owner',
  'manager',
  'catalog_editor',
  'inventory_operator',
  'viewer',
] as const;
export type Role = (typeof ROLES)[number];

const READ: Permission[] = [
  'shop.read',
  'catalog.read',
  'storage.read',
  'inventory.read',
  'activity.read',
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  // Managers hold every new Phase 1 permission too (schema, costs, commercial terms, imports).
  manager: new Set(PERMISSIONS.filter((p) => p !== 'shop.manage')),
  catalog_editor: new Set([...READ, 'catalog.write', 'imports.run', 'exports.run']),
  inventory_operator: new Set([
    ...READ,
    'inventory.receive',
    'inventory.reserve',
    'inventory.fulfill',
  ]),
  viewer: new Set(READ),
};

/**
 * What a non-interactive credential (API credential or MCP connection) was granted. The
 * effective access is the intersection with the member's permissions (PRD 9.4).
 * `session` is never grantable: operations that need it are interactive-only.
 */
export const CONNECTION_SCOPES = [
  'shop:read',
  'catalog:read',
  'catalog:write',
  'storage:read',
  'storage:write',
  'inventory:read',
  'inventory:write',
  'activity:read',
  'webhooks:manage',
] as const;
export type ConnectionScope = (typeof CONNECTION_SCOPES)[number];

/**
 * Scopes an MCP connection can be granted. Webhook subscriptions are managed in the dashboard
 * and the API only, so a connected AI client cannot open a channel that sends shop data out (D14).
 */
export type McpConnectionScope = Exclude<ConnectionScope, 'webhooks:manage'>;
export const MCP_CONNECTION_SCOPES: readonly McpConnectionScope[] = CONNECTION_SCOPES.filter(
  (s): s is McpConnectionScope => s !== 'webhooks:manage',
);
export type RequiredScope = ConnectionScope | 'session';

/** The permissions a member actually has: an explicit set for connectors, else the role's. */
export function effectivePermissions(membership: {
  role: Role;
  permissions?: ReadonlySet<Permission>;
}): ReadonlySet<Permission> {
  return membership.permissions ?? ROLE_PERMISSIONS[membership.role];
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
