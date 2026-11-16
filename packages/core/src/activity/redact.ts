import type { Membership } from '../caller.ts';
import { effectivePermissions, type Permission } from '../permissions.ts';

/**
 * Values in event `changes` that only some members may read, such as warehouse contract terms
 * (PRD 2.3). The event keeps them; activity reads replace them with "hidden" for everyone else.
 */
const RESTRICTED_CHANGES: Array<{ targetType: string; key: string; permission: Permission }> = [
  { targetType: 'warehouse', key: 'contract', permission: 'storage.commercial.read' },
];

function redactChanges(
  targetType: string | null,
  changes: unknown,
  allowed: ReadonlySet<Permission>,
): unknown {
  if (!changes || typeof changes !== 'object') return changes;
  let out = changes as Record<string, unknown>;
  for (const rule of RESTRICTED_CHANGES) {
    if (rule.targetType === targetType && rule.key in out && !allowed.has(rule.permission)) {
      out = { ...out, [rule.key]: 'hidden' };
    }
  }
  return out;
}

/**
 * Some changes carry values only members with a permission may read, such as supplier costs
 * (`changes.restricted`, ADR 0019). Others see that something restricted changed, not the values.
 */
function redactRestricted(changes: unknown, allowed: ReadonlySet<Permission>): unknown {
  if (!changes || typeof changes !== 'object' || !('restricted' in changes)) return changes;
  const permission = (changes as { restricted?: { permission?: string } }).restricted?.permission;
  if (!permission) return changes;
  if (allowed.has(permission as Permission)) return changes;
  return { ...changes, restricted: { permission, hidden: true } };
}

/** An event's `changes` as this reader may see them (the activity list and its export). */
export function redactEventChanges(
  targetType: string | null,
  changes: unknown,
  membership: Membership | null,
): unknown {
  const allowed = membership ? effectivePermissions(membership) : new Set<Permission>();
  return redactRestricted(redactChanges(targetType, changes, allowed), allowed);
}
