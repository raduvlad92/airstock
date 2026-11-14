/**
 * Granular permissions. Checks always name a permission, never a role, so roles can change
 * without touching the UI, API, or MCP (PRD 2.3). The starter roles are a proposal.
 */
export const PERMISSIONS = [
  'shop.read',
  'shop.manage',
  'catalog.read',
  'catalog.write',
  'storage.read',
  'storage.manage',
  'inventory.read',
  'inventory.receive',
  'inventory.reserve',
  'activity.read',
  'credentials.manage',
  'connections.manage',
  /** Records what a connected sales channel reports, such as a Shopify order. */
  'integrations.sync',
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
  manager: new Set(PERMISSIONS.filter((p) => p !== 'shop.manage')),
  catalog_editor: new Set([...READ, 'catalog.write']),
  inventory_operator: new Set([...READ, 'inventory.receive', 'inventory.reserve']),
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
] as const;
export type ConnectionScope = (typeof CONNECTION_SCOPES)[number];
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
