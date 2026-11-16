import type { Tx } from '@airstock/db';
import { z } from 'zod';
import { ALERT_KINDS, type AlertKind } from '../alerts/check.ts';
import { errors } from '../errors.ts';
import { effectivePermissions } from '../permissions.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id, iso } from '../schemas.ts';

// Alerts (plan Section 5.9, D12, PRD 6.9): low stock, lots nearing expiry, shortages, the stock
// check, and (I6) Shopify sync. Members see alerts within their location scope; shop-wide alerts
// only with every location. Each member chooses which kinds count in the app and come by email.

const TOOL = 'stock_alerts';

const Kind = z.enum(ALERT_KINDS);

const AlertOut = z.object({
  id: Id,
  kind: Kind,
  status: z.enum(['open', 'acknowledged', 'resolved']),
  title: z.string().describe('One line for a person, such as "Low stock: MUG-01 at Main".'),
  variantId: Id.nullable(),
  warehouseId: Id.nullable(),
  ruleId: Id.nullable(),
  lotId: Id.nullable(),
  details: z.record(z.string(), z.unknown()),
  openedAt: z.string(),
  lastSeenAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  acknowledgedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolution: z.string().nullable(),
  version: z.number(),
});
type AlertView = z.infer<typeof AlertOut>;

interface AlertRow {
  id: string;
  kind: AlertKind;
  status: 'open' | 'acknowledged' | 'resolved';
  variant_id: string | null;
  warehouse_id: string | null;
  rule_id: string | null;
  lot_id: string | null;
  details: Record<string, unknown>;
  opened_at: Date;
  last_seen_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  resolved_at: Date | null;
  resolution: string | null;
  version: number;
}

function title(r: AlertRow): string {
  const d = r.details as Record<string, string | number | null | undefined>;
  switch (r.kind) {
    case 'low_stock':
      return `Low stock: ${d.sku ?? 'a variant'} at ${d.locationPath ?? d.warehouseName ?? 'a warehouse'}`;
    case 'lot_expiring':
      return `Lot ${d.lotCode ?? ''} of ${d.sku ?? 'a variant'} ${d.expired ? 'expired' : 'expires'} ${d.expiresOn ?? ''}`.trim();
    case 'shortage':
      return `Shortage: ${d.sku ?? 'a variant'} is short ${d.shortage ?? ''} for accepted orders`.trim();
    case 'reconciliation_mismatch':
      return `The stock check found ${d.count ?? 'some'} ${d.count === 1 ? 'problem' : 'problems'}`;
    case 'shopify_sync':
      return 'Shopify sync needs attention';
  }
}

function view(r: AlertRow): AlertView {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    title: title(r),
    variantId: r.variant_id,
    warehouseId: r.warehouse_id,
    ruleId: r.rule_id,
    lotId: r.lot_id,
    details: r.details,
    openedAt: iso(r.opened_at)!,
    lastSeenAt: iso(r.last_seen_at)!,
    acknowledgedAt: iso(r.acknowledged_at),
    acknowledgedBy: r.acknowledged_by,
    resolvedAt: iso(r.resolved_at),
    resolution: r.resolution,
    version: r.version,
  };
}

const ALERT_SELECT = `select a.id, a.kind, a.status, a.variant_id, a.warehouse_id, a.rule_id, a.lot_id,
    a.details, a.opened_at, a.last_seen_at, a.acknowledged_at, a.acknowledged_by, a.resolved_at,
    a.resolution, a.version
  from alerts a`;

/**
 * Who sees an alert: everyone with every location; a member limited to some locations when the
 * alert's scope path overlaps theirs. $n is the scope. Shop-wide alerts (no path) need every
 * location.
 */
const visible = (n: number) =>
  `($${n}::uuid[] is null or (a.location_ids is not null and a.location_ids && $${n}::uuid[]))`;

/** Kinds this member counts in the app and receives by email (defaults without a row). */
async function preferences(ctx: HandlerContext) {
  const rows = ctx.membership
    ? await ctx.tx.query<{ kind: AlertKind; in_app: boolean; email: boolean }>(
        'select kind, in_app, email from alert_subscriptions where membership_id = $1',
        [ctx.membership.id],
      )
    : [];
  const emailDefault = ctx.membership
    ? effectivePermissions(ctx.membership).has('alerts.manage')
    : false;
  return ALERT_KINDS.map((kind) => {
    const row = rows.find((r) => r.kind === kind);
    return {
      kind,
      inApp: row?.in_app ?? true,
      email: row?.email ?? emailDefault,
      isDefault: !row,
    };
  });
}

export const listAlerts = defineOperation({
  id: 'alerts.list',
  summary: 'List stock alerts',
  description:
    'Use this when someone asks what needs attention or what is running low: open and acknowledged alerts (low stock, lots nearing expiry, shortages, stock check problems), newest first, within your locations. Filter by kind, status, warehouse, or variant. Not for stock levels (use get_stock) or drafting orders (use manage_purchasing).',
  kind: 'read',
  scope: 'shop',
  input: z.object({
    status: z
      .enum(['active', 'open', 'acknowledged', 'resolved', 'all'])
      .default('active')
      .describe('active (the default) is open and acknowledged.'),
    kind: Kind.optional(),
    warehouseId: Id.optional(),
    variantId: Id.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: Id.optional().describe('Cursor from the previous page.'),
  }),
  output: z.object({ alerts: z.array(AlertOut), nextCursor: z.string().nullable() }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'alerts.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/alerts' },
  mcp: { tool: TOOL, action: 'list', readOnly: true, destructive: false },
  async handler(ctx, input) {
    const rows = await ctx.tx.query<AlertRow>(
      `${ALERT_SELECT}
       where (case $1::text when 'active' then a.status <> 'resolved' when 'all' then true
         else a.status = $1 end)
         and ($2::text is null or a.kind = $2)
         and ($3::uuid is null or a.warehouse_id = $3)
         and ($4::uuid is null or a.variant_id = $4)
         and ${visible(5)}
         and ($6::uuid is null or (a.opened_at, a.id) < (select c.opened_at, c.id from alerts c where c.id = $6))
       order by a.opened_at desc, a.id desc
       limit $7`,
      [
        input.status,
        input.kind ?? null,
        input.warehouseId ?? null,
        input.variantId ?? null,
        ctx.locationScope,
        input.after ?? null,
        input.limit + 1,
      ],
    );
    const page = rows.slice(0, input.limit);
    return {
      result: {
        alerts: page.map(view),
        nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
      },
      audit: { targetType: 'alert', targetId: 'list', context: { input } },
    };
  },
});

export const alertSummary = defineOperation({
  id: 'alerts.summary',
  summary: 'Count open stock alerts',
  description:
    'Use this for a quick count of what needs attention: open (not yet acknowledged) alerts within your locations, by kind, counting the kinds you follow in the app.',
  kind: 'read',
  scope: 'shop',
  input: z.object({}),
  output: z.object({
    open: z.number().describe('Open alerts of the kinds you follow in the app.'),
    byKind: z.record(z.string(), z.number()).describe('Open alerts per kind, followed or not.'),
  }),
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'alerts.summary.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/alerts/summary' },
  mcp: { tool: TOOL, action: 'summary', readOnly: true, destructive: false },
  async handler(ctx) {
    const rows = await ctx.tx.query<{ kind: string; n: number }>(
      `select a.kind, count(*)::int as n from alerts a
       where a.status = 'open' and ${visible(1)}
       group by a.kind`,
      [ctx.locationScope],
    );
    const followed = new Set((await preferences(ctx)).filter((p) => p.inApp).map((p) => p.kind));
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
    return {
      result: {
        open: rows.filter((r) => followed.has(r.kind as AlertKind)).reduce((n, r) => n + r.n, 0),
        byKind,
      },
      audit: { targetType: 'alert', targetId: 'summary' },
    };
  },
});

async function loadVisible(tx: Tx, id: string, scope: string[] | null): Promise<AlertRow> {
  const [row] = await tx.query<AlertRow>(
    `${ALERT_SELECT} where a.id = $1 and ${visible(2)} for update of a`,
    [id, scope],
  );
  if (!row) throw errors.notFound('Alert');
  return row;
}

export const acknowledgeAlert = defineOperation({
  id: 'alerts.acknowledge',
  summary: 'Acknowledge an alert',
  description:
    'Use this when someone has seen an alert and is handling it: it stops counting as open and in the badge, and stays listed until the condition clears (for example, stock recovers), when it resolves by itself.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    alertId: Id.describe('The alert.'),
    note: z.string().trim().min(1).max(500).optional().describe('What is being done about it.'),
  }),
  output: z.object({ alert: AlertOut }),
  permission: 'alerts.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'alerts.acknowledged' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/alerts/{alertId}/acknowledge' },
  mcp: { tool: TOOL, action: 'acknowledge', readOnly: false, destructive: false },
  async handler(ctx, input) {
    const row = await loadVisible(ctx.tx, input.alertId, ctx.locationScope);
    if (row.status === 'resolved') {
      throw errors.conflict('alert_resolved', 'The alert already resolved.');
    }
    if (row.status === 'acknowledged') {
      return {
        result: { alert: view(row) },
        audit: { targetType: 'alert', targetId: row.id, outcome: 'no_change' },
      };
    }
    const by = ctx.caller.userId ?? `${ctx.caller.kind}:${ctx.caller.id}`;
    const [updated] = await ctx.tx.query<AlertRow>(
      `update alerts a set status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2,
         version = version + 1
       where a.id = $1
       returning a.id, a.kind, a.status, a.variant_id, a.warehouse_id, a.rule_id, a.lot_id,
         a.details, a.opened_at, a.last_seen_at, a.acknowledged_at, a.acknowledged_by,
         a.resolved_at, a.resolution, a.version`,
      [row.id, by],
    );
    return {
      result: { alert: view(updated!) },
      audit: {
        targetType: 'alert',
        targetId: row.id,
        reason: input.note ?? null,
        changes: { status: { from: 'open', to: 'acknowledged' }, kind: row.kind },
      },
    };
  },
});

const PreferencesOut = z.object({
  preferences: z.array(
    z.object({
      kind: Kind,
      inApp: z.boolean().describe('Counts in the badge.'),
      email: z.boolean().describe('Email when such an alert opens, within your locations.'),
      isDefault: z.boolean(),
    }),
  ),
  lotExpiryAlertDays: z.number().describe('Shop setting: lots expiring within this many days alert.'),
});

export const getAlertPreferences = defineOperation({
  id: 'alerts.preferences.get',
  summary: 'Get my alert preferences',
  description:
    'Use this to see which alert kinds you follow in the app and receive by email. Owners and managers get email by default.',
  kind: 'read',
  scope: 'shop',
  input: z.object({}),
  output: PreferencesOut,
  permission: 'inventory.read',
  connectionScope: 'inventory:read',
  audit: { action: 'alerts.preferences.viewed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/alert-preferences' },
  mcp: { tool: TOOL, action: 'get_preferences', readOnly: true, destructive: false },
  async handler(ctx) {
    const [shop] = await ctx.tx.query<{ days: number }>(
      'select lot_expiry_alert_days as days from shops where id = app_shop_id()',
    );
    return {
      result: { preferences: await preferences(ctx), lotExpiryAlertDays: shop?.days ?? 30 },
      audit: { targetType: 'membership', targetId: ctx.membership?.id ?? 'none' },
    };
  },
});

export const setAlertPreferences = defineOperation({
  id: 'alerts.preferences.set',
  summary: 'Choose which alerts I receive',
  description:
    'Use this when someone wants more or fewer alerts: per kind, whether it counts in the app and whether it comes by email. Applies to the person you act for, within their locations.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    preferences: z
      .array(
        z.object({
          kind: Kind,
          inApp: z.boolean().optional(),
          email: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(ALERT_KINDS.length),
  }),
  output: PreferencesOut,
  permission: 'inventory.read',
  connectionScope: 'inventory:write',
  audit: { action: 'alerts.preferences.set' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/alert-preferences' },
  mcp: { tool: TOOL, action: 'set_preferences', readOnly: false, destructive: false },
  async handler(ctx, input) {
    if (!ctx.membership) throw errors.forbidden('Only a member has alert preferences.');
    const current = await preferences(ctx);
    const rows = input.preferences.map((p) => {
      const now = current.find((c) => c.kind === p.kind)!;
      return { kind: p.kind, inApp: p.inApp ?? now.inApp, email: p.email ?? now.email };
    });
    await ctx.tx.query(
      `insert into alert_subscriptions (shop_id, membership_id, kind, in_app, email)
       select app_shop_id(), $1, x.kind, x."inApp", x.email
       from jsonb_to_recordset($2::jsonb) as x(kind text, "inApp" boolean, email boolean)
       on conflict (shop_id, membership_id, kind)
       do update set in_app = excluded.in_app, email = excluded.email, updated_at = now()`,
      [ctx.membership.id, JSON.stringify(rows)],
    );
    const [shop] = await ctx.tx.query<{ days: number }>(
      'select lot_expiry_alert_days as days from shops where id = app_shop_id()',
    );
    return {
      result: { preferences: await preferences(ctx), lotExpiryAlertDays: shop?.days ?? 30 },
      audit: {
        targetType: 'membership',
        targetId: ctx.membership.id,
        changes: { preferences: rows },
      },
    };
  },
});

export const setAlertSettings = defineOperation({
  id: 'alerts.settings.set',
  summary: 'Set the shop’s alert settings',
  description:
    'How many days before a lot expires the daily check opens an alert for it (0 to 3650; 30 by default).',
  kind: 'command',
  scope: 'shop',
  input: z.object({ lotExpiryAlertDays: z.number().int().min(0).max(3650) }),
  output: z.object({ lotExpiryAlertDays: z.number() }),
  permission: 'alerts.manage',
  connectionScope: 'inventory:write',
  audit: { action: 'alerts.settings.set' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/alert-settings' },
  mcp: { exception: 'Shop settings are changed in the dashboard (ADR 0005, Phase 1 exceptions).' },
  async handler(ctx, input) {
    const [before] = await ctx.tx.query<{ days: number }>(
      'select lot_expiry_alert_days as days from shops where id = app_shop_id() for update',
    );
    await ctx.tx.query('update shops set lot_expiry_alert_days = $1 where id = app_shop_id()', [
      input.lotExpiryAlertDays,
    ]);
    return {
      result: { lotExpiryAlertDays: input.lotExpiryAlertDays },
      audit: {
        targetType: 'shop',
        targetId: ctx.shopId,
        outcome: before?.days === input.lotExpiryAlertDays ? 'no_change' : 'succeeded',
        changes: { lotExpiryAlertDays: { from: before?.days ?? null, to: input.lotExpiryAlertDays } },
      },
    };
  },
});

/** This module's operations, in registry order: MCP lists a tool's actions in this order. */
export const alertsOperations = [
  listAlerts,
  alertSummary,
  acknowledgeAlert,
  getAlertPreferences,
  setAlertPreferences,
  setAlertSettings,
] as const;
