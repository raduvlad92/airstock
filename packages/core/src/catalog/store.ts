import type { Tx } from '@airstock/db';
import type { Membership } from '../caller.ts';
import { effectivePermissions } from '../permissions.ts';
import type { FieldConfig, FieldDefinition, FieldLevel, FieldOption, FieldType } from './fields.ts';

interface FieldRow {
  id: string;
  key: string;
  label: string;
  description: string | null;
  type: FieldType;
  level: FieldLevel;
  config: FieldConfig;
  default_value: unknown;
  visibility: 'everyone' | 'restricted';
  status: 'active' | 'archived';
  is_system: boolean;
  version: number;
  options: FieldOption[];
}

export interface StoredField extends FieldDefinition {
  description: string | null;
}

/** Field definitions of the current shop with their options, in key order. */
export async function loadFields(
  tx: Tx,
  opts: { ids?: string[]; includeArchived?: boolean } = {},
): Promise<StoredField[]> {
  const rows = await tx.query<FieldRow>(
    `select f.id, f.key, f.label, f.description, f.type, f.level, f.config, f.default_value,
       f.visibility, f.status, f.is_system, f.version,
       coalesce((select json_agg(json_build_object('id', o.id, 'label', o.label,
           'position', o.position, 'archived', o.archived) order by o.position, o.id)
         from field_options o where o.shop_id = f.shop_id and o.field_id = f.id), '[]') as options
     from field_definitions f
     where ($1::uuid[] is null or f.id = any($1::uuid[]))
       and ($2 or f.status = 'active')
     order by f.key`,
    [opts.ids ?? null, opts.includeArchived ?? false],
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    description: r.description,
    type: r.type,
    level: r.level,
    config: r.config,
    defaultValue: r.default_value,
    visibility: r.visibility,
    status: r.status,
    isSystem: r.is_system,
    version: r.version,
    options: r.options,
  }));
}

/** Restricted fields are visible only to members who manage the catalog schema. */
export function canSeeRestricted(membership: Membership | null): boolean {
  return membership ? effectivePermissions(membership).has('catalog.schema.manage') : false;
}

export function visible<T extends { visibility: string }>(
  fields: T[],
  membership: Membership | null,
): T[] {
  const all = canSeeRestricted(membership);
  return fields.filter((f) => all || f.visibility === 'everyone');
}

export async function shopSettings(
  tx: Tx,
): Promise<{ currency: string; displayUnits: 'metric' | 'imperial' }> {
  const [row] = await tx.query<{ currency: string; display_units: 'metric' | 'imperial' }>(
    'select currency, display_units from shops where id = app_shop_id()',
  );
  if (!row) throw new Error('Shop context is not set.');
  return { currency: row.currency, displayUnits: row.display_units };
}

/** Resolves a field by key or ID. */
export function findField<T extends { id: string; key: string }>(
  fields: T[],
  ref: string,
): T | undefined {
  return fields.find((f) => f.key === ref || f.id === ref);
}
