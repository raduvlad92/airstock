// The activity history's filter values (PRD 7.4), shared by the search and the dashboard's
// dropdowns. No dependencies, so the web app can import it.

import type { AuditOutcome } from '../audit.ts';
import type { CallerKind, Source } from '../caller.ts';

export const ACTOR_TYPES = [
  'user',
  'api_credential',
  'connection',
  'connector',
  'system',
] as const satisfies readonly CallerKind[];

export const ACTOR_TYPE_LABELS: Record<(typeof ACTOR_TYPES)[number], string> = {
  user: 'A person',
  api_credential: 'An API key',
  connection: 'An AI connection',
  connector: 'A connector (Shopify)',
  system: 'Airstock itself (scheduled work)',
};

export const SOURCES = [
  'dashboard',
  'api',
  'mcp',
  'import',
  'scheduled',
  'admin',
  'shopify',
  'webhooks',
] as const satisfies readonly Source[];

export const SOURCE_LABELS: Record<(typeof SOURCES)[number], string> = {
  dashboard: 'Dashboard',
  api: 'API',
  mcp: 'AI assistant (MCP)',
  import: 'Imports and exports',
  scheduled: 'Scheduled work',
  admin: 'Airstock support',
  shopify: 'Shopify',
  webhooks: 'Webhook deliveries',
};

export const OUTCOMES = [
  'received',
  'succeeded',
  'failed',
  'denied',
  'cancelled',
  'conflict',
  'no_change',
  'replayed',
  'unknown',
] as const satisfies readonly AuditOutcome[];

export const OUTCOME_LABELS: Record<(typeof OUTCOMES)[number], string> = {
  received: 'Received (an attempt, before it ran)',
  succeeded: 'Succeeded',
  failed: 'Failed',
  denied: 'Denied',
  cancelled: 'Cancelled',
  conflict: 'Conflict',
  no_change: 'No change',
  replayed: 'Replayed',
  unknown: 'Unknown, until reconciled',
};

/**
 * Groups of actions for the action filter: each is a comma-separated list of prefixes, which the
 * search turns into the actions the shop actually has.
 */
export const ACTION_GROUPS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'catalog.*', label: 'Catalog: products, fields, imports, exports' },
  { value: 'inventory.*', label: 'Stock: receipts, reservations, counts, transfers' },
  { value: 'return.*,returns.*', label: 'Returns and inspection' },
  { value: 'purchasing.*', label: 'Purchase orders and reorder rules' },
  { value: 'alert.*,alerts.*', label: 'Alerts' },
  { value: 'picking.*,warehouse.*', label: 'Picking and scanning' },
  { value: 'storage.*', label: 'Warehouses and locations' },
  { value: 'supplier.*,suppliers.*,supplier_item.*,supplier_items.*', label: 'Suppliers' },
  { value: 'labels.*', label: 'Labels' },
  {
    value: 'member.*,members.*,credential.*,credentials.*,connection.*,connections.*',
    label: 'Members, API keys, and AI connections',
  },
  { value: 'shop.*,shops.*,operation.*', label: 'Shop settings' },
  { value: 'shopify.*', label: 'Shopify' },
  { value: 'webhook.*,webhooks.*', label: 'Webhooks' },
  { value: 'activity.*', label: 'Activity history: views and exports' },
  { value: 'reports.*', label: 'Reports: runs, saved reports, and exports' },
  { value: 'client.*', label: 'Interface events reported by the dashboard' },
];
