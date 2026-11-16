// Outgoing webhook subscriptions and their delivery log (plan Section 5.13, D14).
//
// REST and the dashboard only: subscriptions send shop data out of Airstock, so a connected AI
// client cannot create or change them (a documented MCP exception). Owners and managers hold
// `webhooks.manage`; a member limited to some locations sees and manages only subscriptions
// filtered to those locations.

import { z } from 'zod';
import { AppError, errors } from '../errors.ts';
import { effectivePermissions } from '../permissions.ts';
import { defineOperation, type HandlerContext } from '../registry.ts';
import { Id, iso } from '../schemas.ts';
import {
  sampleEnvelope,
  WEBHOOK_ALERT_KINDS,
  WEBHOOK_API_VERSION,
  WEBHOOK_DELIVER_TOPIC,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
  webhookEventTypes,
} from '../webhooks/events.ts';
import { generateWebhookSecret, secretHint, webhookSecretContext } from '../webhooks/signing.ts';
import { checkWebhookUrl } from '../webhooks/urls.ts';

const MCP_EXCEPTION = {
  exception:
    'Webhook subscriptions send shop data out of Airstock, so they are managed in the dashboard and the API only, never by a connected AI client (D14).',
};

const COMMON = {
  scope: 'shop',
  permission: 'webhooks.manage',
  connectionScope: 'webhooks:manage',
  idempotency: 'none',
  mcp: MCP_EXCEPTION,
} as const;

const Filters = z.object({
  locationIds: z
    .array(Id)
    .max(50)
    .default([])
    .describe(
      'Warehouse or location IDs. Event types that carry locations are sent only when the event touches one of them, or a location inside one. Empty means every location.',
    ),
  alertKinds: z
    .array(z.enum(WEBHOOK_ALERT_KINDS))
    .max(WEBHOOK_ALERT_KINDS.length)
    .default([])
    .describe('Alert kinds for alert event types. Empty means every kind.'),
});

const SubscriptionOut = z.object({
  subscriptionId: Id,
  name: z.string(),
  url: z.string(),
  eventTypes: z.array(z.string()),
  filters: z.object({ locationIds: z.array(Id), alertKinds: z.array(z.string()) }),
  status: z.enum(['active', 'disabled']),
  disabledReason: z.enum(['manual', 'failing']).nullable(),
  secretHint: z.string().describe('The last four characters of the current signing secret.'),
  previousSecretExpiresAt: z
    .string()
    .nullable()
    .describe('During a rotation, deliveries carry a signature from the previous secret too.'),
  failingSince: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});

const DeliveryOut = z.object({
  deliveryId: Id,
  subscriptionId: Id,
  subscriptionName: z.string(),
  eventId: Id.describe('The envelope `id`: the same on every retry and replay.'),
  eventType: z.string(),
  test: z.boolean(),
  replayOf: Id.nullable(),
  status: z.enum(['pending', 'sending', 'retrying', 'delivered', 'failed', 'cancelled']),
  attempts: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  lastResponse: z.string().nullable().describe('At most the first 1 KB of the last response.'),
  lastDurationMs: z.number().int().nullable(),
  deliveredAt: z.string().nullable(),
  createdAt: z.string(),
});

interface SubscriptionRow {
  id: string;
  name: string;
  url: string;
  event_types: string[];
  location_ids: string[];
  alert_kinds: string[];
  status: 'active' | 'disabled' | 'deleted';
  disabled_reason: 'manual' | 'failing' | null;
  secret_hint: string;
  previous_secret_expires_at: Date | null;
  failing_since: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

const SUBSCRIPTION_COLUMNS = `s.id, s.name, s.url, s.event_types, s.location_ids, s.alert_kinds,
  s.status, s.disabled_reason, s.secret_hint, s.previous_secret_expires_at, s.failing_since,
  s.last_success_at, s.last_failure_at, s.created_at, s.updated_at, s.version`;

/**
 * A member limited to some locations sees a subscription only when it is filtered to locations
 * all inside their scope (PRD 2.4): an unfiltered one sends every location's stock. `$scope` is
 * the caller's scope, or null for every location.
 */
const VISIBLE = (scope: string) => `(${scope}::uuid[] is null or (cardinality(s.location_ids) > 0
  and not exists (select 1 from unnest(s.location_ids) f(id) where not (f.id = any(${scope}::uuid[])
    or exists (select 1 from locations l where l.id = f.id and l.path_ids && ${scope}::uuid[])))))`;

function subscriptionOut(r: SubscriptionRow): z.infer<typeof SubscriptionOut> {
  const now = Date.now();
  return {
    subscriptionId: r.id,
    name: r.name,
    url: r.url,
    eventTypes: r.event_types,
    filters: { locationIds: r.location_ids, alertKinds: r.alert_kinds },
    status: r.status === 'active' ? 'active' : 'disabled',
    disabledReason: r.status === 'active' ? null : r.disabled_reason,
    secretHint: r.secret_hint,
    previousSecretExpiresAt:
      r.previous_secret_expires_at && new Date(r.previous_secret_expires_at).getTime() > now
        ? iso(r.previous_secret_expires_at)
        : null,
    failingSince: iso(r.failing_since),
    lastSuccessAt: iso(r.last_success_at),
    lastFailureAt: iso(r.last_failure_at),
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
    version: r.version,
  };
}

async function loadSubscription(
  ctx: HandlerContext,
  subscriptionId: string,
  lock = false,
): Promise<SubscriptionRow> {
  const [row] = await ctx.tx.query<SubscriptionRow>(
    `select ${SUBSCRIPTION_COLUMNS} from webhook_subscriptions s
     where s.id = $1 and s.status <> 'deleted' and ${VISIBLE('$2')}
     ${lock ? 'for update' : ''}`,
    [subscriptionId, ctx.locationScope],
  );
  if (!row) throw errors.notFound('Webhook subscription');
  return row;
}

/** The URL as history shows it: the host and first path segment, never a token in the path. */
export function maskWebhookUrl(value: string): string {
  try {
    const url = new URL(value);
    const [first, ...rest] = url.pathname.split('/').filter(Boolean);
    return `${url.origin}${first ? `/${first}` : ''}${rest.length > 0 || url.search ? '/…' : ''}`;
  } catch {
    return '…';
  }
}

function validUrl(value: string): string {
  const checked = checkWebhookUrl(value);
  if (!checked.ok) throw errors.validation([{ path: 'url', message: checked.reason }]);
  return checked.url.href;
}

/** Each chosen type exists, can be chosen, and its fields are ones the person may see. */
function validEventTypes(ctx: HandlerContext, types: string[]): string[] {
  const unique = [...new Set(types)];
  const held = ctx.membership ? effectivePermissions(ctx.membership) : new Set();
  const issues: Array<{ path: string; message: string }> = [];
  unique.forEach((id, i) => {
    const type = webhookEventTypes.get(id);
    if (!type) issues.push({ path: `eventTypes.${i}`, message: `Unknown event type ${id}.` });
    else if (type.status !== 'available') {
      issues.push({ path: `eventTypes.${i}`, message: `${id} is not available yet.` });
    } else if (!held.has(type.permission)) {
      issues.push({
        path: `eventTypes.${i}`,
        message: `${id} needs the ${type.permission} permission.`,
      });
    }
  });
  if (issues.length > 0) throw errors.validation(issues);
  // Registry order, so the list reads the same way everywhere.
  return WEBHOOK_EVENT_TYPES.map((t) => t.id).filter((id) => unique.includes(id));
}

/**
 * Filter locations are warehouses or locations of this shop. A member limited to some locations
 * must filter to them, and only to them: a warehouse counts only when their scope names it.
 */
async function validFilterLocations(ctx: HandlerContext, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    if (ctx.locationScope) {
      throw new AppError(
        403,
        'location_out_of_scope',
        'Choose the warehouses or locations this webhook covers: you can only send stock from your own locations.',
        'denied',
        { errors: [{ path: 'filters.locationIds', message: 'Choose at least one location.' }] },
      );
    }
    return unique;
  }
  const rows = await ctx.tx.query<{ id: string; in_scope: boolean }>(
    `select l.id, ($2::uuid[] is null or l.path_ids && $2::uuid[]) as in_scope
     from locations l where l.id = any($1::uuid[])
     union all
     select w.id, ($2::uuid[] is null or w.id = any($2::uuid[])) as in_scope
     from warehouses w where w.id = any($1::uuid[])`,
    [unique, ctx.locationScope],
  );
  if (rows.length !== unique.length) {
    throw errors.validation([
      { path: 'filters.locationIds', message: 'Choose warehouses or locations of this shop.' },
    ]);
  }
  if (rows.some((r) => !r.in_scope)) {
    throw new AppError(
      403,
      'location_out_of_scope',
      'You do not have access to one or more of these locations.',
      'denied',
    );
  }
  return unique;
}

function cipher(ctx: HandlerContext) {
  if (!ctx.webhookSecrets) {
    throw new AppError(
      503,
      'webhooks_not_configured',
      'Webhooks are not configured on this server yet.',
      'failed',
    );
  }
  return ctx.webhookSecrets;
}

// Event types ----------------------------------------------------------------------------------

const EventTypeOut = z.object({
  type: z.string(),
  description: z.string(),
  status: z
    .enum(['available', 'coming'])
    .describe('`coming` types are registered but not emitted yet; they cannot be chosen.'),
  permission: z.string().describe('What the person who subscribes must hold.'),
  filters: z.array(z.enum(['locations', 'alertKinds'])),
  sample: z.unknown().describe('A sample envelope as delivered.'),
});

export const listWebhookEventTypes = defineOperation({
  ...COMMON,
  id: 'webhooks.event_types.list',
  summary: 'List the webhook event types',
  description:
    'Every event type a subscription can choose, with a description, the filters that apply, and a sample envelope. New types appear here without client changes.',
  kind: 'read',
  input: z.object({}),
  output: z.object({
    apiVersion: z.string(),
    eventTypes: z.array(EventTypeOut),
    alertKinds: z.array(z.string()),
  }),
  audit: { action: 'webhooks.event_types.viewed' },
  http: { method: 'GET', path: '/shops/{shopId}/webhook-event-types' },
  async handler() {
    return {
      result: {
        apiVersion: WEBHOOK_API_VERSION,
        eventTypes: WEBHOOK_EVENT_TYPES.map((t: WebhookEventType) => ({
          type: t.id,
          description: t.description,
          status: t.status,
          permission: t.permission,
          filters: [...t.filters],
          sample: sampleEnvelope(t),
        })),
        alertKinds: [...WEBHOOK_ALERT_KINDS],
      },
      audit: { targetType: 'webhook_event_types', targetId: 'list' },
    };
  },
});

// Subscriptions --------------------------------------------------------------------------------

export const listWebhookSubscriptions = defineOperation({
  ...COMMON,
  id: 'webhooks.subscriptions.list',
  summary: 'List webhook subscriptions',
  kind: 'read',
  input: z.object({}),
  output: z.object({ subscriptions: z.array(SubscriptionOut) }),
  audit: { action: 'webhooks.subscriptions.listed' },
  http: { method: 'GET', path: '/shops/{shopId}/webhook-subscriptions' },
  async handler(ctx) {
    const rows = await ctx.tx.query<SubscriptionRow>(
      `select ${SUBSCRIPTION_COLUMNS} from webhook_subscriptions s
       where s.status <> 'deleted' and ${VISIBLE('$1')}
       order by s.created_at, s.id`,
      [ctx.locationScope],
    );
    return {
      result: { subscriptions: rows.map(subscriptionOut) },
      audit: { targetType: 'webhook_subscription', targetId: 'list' },
    };
  },
});

export const createWebhookSubscription = defineOperation({
  ...COMMON,
  id: 'webhooks.subscriptions.create',
  summary: 'Create a webhook subscription',
  description:
    'Sends the chosen event types to an HTTPS URL, signed with a new secret. The secret is returned once, here; store it in the receiving system to check the `Airstock-Signature` header.',
  kind: 'command',
  input: z.object({
    name: z.string().trim().min(1).max(100),
    url: z.string().trim().min(1).max(2000).describe('An HTTPS URL on a public host.'),
    eventTypes: z.array(z.string().max(100)).min(1).max(50),
    filters: Filters.optional(),
  }),
  output: z.object({
    subscription: SubscriptionOut,
    secret: z.string().describe('Shown only now. Rotate it to get a new one.'),
  }),
  audit: { action: 'webhook.subscription.created' },
  http: { method: 'POST', path: '/shops/{shopId}/webhook-subscriptions', status: 201 },
  async handler(ctx, input) {
    const url = validUrl(input.url);
    const eventTypes = validEventTypes(ctx, input.eventTypes);
    const filters = {
      locationIds: await validFilterLocations(ctx, input.filters?.locationIds ?? []),
      alertKinds: [...new Set(input.filters?.alertKinds ?? [])],
    };
    const id = ctx.newId();
    const secret = generateWebhookSecret();
    const sealed = await cipher(ctx).encrypt(secret, webhookSecretContext(ctx.shopId, id));
    const [row] = await ctx.tx.query<SubscriptionRow>(
      `insert into webhook_subscriptions as s (shop_id, id, name, url, event_types, location_ids,
         alert_kinds, secret_key_id, secret_ciphertext, secret_hint, created_by_membership_id)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning ${SUBSCRIPTION_COLUMNS}`,
      [
        id,
        input.name,
        url,
        eventTypes,
        filters.locationIds,
        filters.alertKinds,
        cipher(ctx).keyId,
        sealed,
        secretHint(secret),
        ctx.membership?.id ?? null,
      ],
    );
    return {
      result: { subscription: subscriptionOut(row!), secret },
      audit: {
        targetType: 'webhook_subscription',
        targetId: id,
        changes: { name: input.name, url: maskWebhookUrl(url), eventTypes, filters },
      },
    };
  },
});

export const updateWebhookSubscription = defineOperation({
  ...COMMON,
  id: 'webhooks.subscriptions.update',
  summary: 'Change a webhook subscription',
  description:
    'Changes the name, URL, event types, or filters. Fields left out keep their values. Send `expectedVersion` to refuse the change if someone else changed the subscription first.',
  kind: 'command',
  input: z.object({
    subscriptionId: Id,
    expectedVersion: z.number().int().optional(),
    name: z.string().trim().min(1).max(100).optional(),
    url: z.string().trim().min(1).max(2000).optional(),
    eventTypes: z.array(z.string().max(100)).min(1).max(50).optional(),
    filters: Filters.optional(),
  }),
  output: z.object({ subscription: SubscriptionOut }),
  audit: { action: 'webhook.subscription.updated' },
  http: { method: 'POST', path: '/shops/{shopId}/webhook-subscriptions/{subscriptionId}' },
  async handler(ctx, input) {
    const before = await loadSubscription(ctx, input.subscriptionId, true);
    if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) {
      throw errors.conflict(
        'version_conflict',
        'Someone changed this webhook since you opened it. Reload and try again.',
        { currentVersion: before.version },
      );
    }
    const name = input.name ?? before.name;
    const url = input.url !== undefined ? validUrl(input.url) : before.url;
    const eventTypes =
      input.eventTypes !== undefined ? validEventTypes(ctx, input.eventTypes) : before.event_types;
    const locationIds = input.filters
      ? await validFilterLocations(ctx, input.filters.locationIds)
      : before.location_ids;
    const alertKinds = input.filters ? [...new Set(input.filters.alertKinds)] : before.alert_kinds;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (name !== before.name) changes.name = { from: before.name, to: name };
    if (url !== before.url) {
      changes.url = { from: maskWebhookUrl(before.url), to: maskWebhookUrl(url) };
    }
    if (!same(eventTypes, before.event_types)) {
      changes.eventTypes = { from: before.event_types, to: eventTypes };
    }
    if (!same(locationIds, before.location_ids)) {
      changes.locationIds = { from: before.location_ids, to: locationIds };
    }
    if (!same(alertKinds, before.alert_kinds)) {
      changes.alertKinds = { from: before.alert_kinds, to: alertKinds };
    }
    if (Object.keys(changes).length === 0) {
      return {
        result: { subscription: subscriptionOut(before) },
        audit: {
          targetType: 'webhook_subscription',
          targetId: before.id,
          outcome: 'no_change' as const,
        },
      };
    }
    const [row] = await ctx.tx.query<SubscriptionRow>(
      `update webhook_subscriptions s
       set name = $2, url = $3, event_types = $4, location_ids = $5, alert_kinds = $6,
         updated_at = now(), version = version + 1
       where s.id = $1 returning ${SUBSCRIPTION_COLUMNS}`,
      [before.id, name, url, eventTypes, locationIds, alertKinds],
    );
    return {
      result: { subscription: subscriptionOut(row!) },
      audit: { targetType: 'webhook_subscription', targetId: before.id, changes },
    };
  },
});

export const rotateWebhookSecret = defineOperation({
  ...COMMON,
  id: 'webhooks.subscriptions.secret.rotate',
  summary: 'Rotate a webhook signing secret',
  description:
    'Makes a new secret and returns it once. For `overlapHours` (24 by default, 0 to 168), deliveries carry signatures from both the new and the previous secret, so the receiver can switch without missing an event.',
  kind: 'command',
  input: z.object({
    subscriptionId: Id,
    overlapHours: z.number().int().min(0).max(168).default(24),
  }),
  output: z.object({
    subscription: SubscriptionOut,
    secret: z.string().describe('Shown only now.'),
  }),
  audit: { action: 'webhook.subscription.secret_rotated' },
  http: {
    method: 'POST',
    path: '/shops/{shopId}/webhook-subscriptions/{subscriptionId}/rotate-secret',
  },
  async handler(ctx, input) {
    const before = await loadSubscription(ctx, input.subscriptionId, true);
    const secret = generateWebhookSecret();
    const sealed = await cipher(ctx).encrypt(secret, webhookSecretContext(ctx.shopId, before.id));
    const [row] = await ctx.tx.query<SubscriptionRow>(
      `update webhook_subscriptions s
       set previous_secret_ciphertext = case when $5 > 0 then secret_ciphertext end,
         previous_secret_expires_at = case when $5 > 0 then now() + make_interval(hours => $5) end,
         secret_ciphertext = $2, secret_key_id = $3, secret_hint = $4,
         updated_at = now(), version = version + 1
       where s.id = $1 returning ${SUBSCRIPTION_COLUMNS}`,
      [before.id, sealed, cipher(ctx).keyId, secretHint(secret), input.overlapHours],
    );
    return {
      result: { subscription: subscriptionOut(row!), secret },
      audit: {
        targetType: 'webhook_subscription',
        targetId: before.id,
        changes: {
          secret: 'rotated',
          overlapHours: input.overlapHours,
          previousSecretExpiresAt: iso(row!.previous_secret_expires_at),
        },
      },
    };
  },
});

export const setWebhookSubscriptionStatus = defineOperation({
  ...COMMON,
  id: 'webhooks.subscriptions.status.set',
  summary: 'Turn a webhook subscription on or off',
  description:
    'A disabled subscription receives nothing; its pending retries are cancelled when they come due. Turning it on clears the failure streak. Replay missed deliveries from the log.',
  kind: 'command',
  input: z.object({ subscriptionId: Id, status: z.enum(['active', 'disabled']) }),
  output: z.object({ subscription: SubscriptionOut }),
  audit: { action: 'webhook.subscription.status_set' },
  http: { method: 'POST', path: '/shops/{shopId}/webhook-subscriptions/{subscriptionId}/status' },
  async handler(ctx, input) {
    const before = await loadSubscription(ctx, input.subscriptionId, true);
    if (before.status === input.status) {
      return {
        result: { subscription: subscriptionOut(before) },
        audit: {
          targetType: 'webhook_subscription',
          targetId: before.id,
          outcome: 'no_change' as const,
        },
      };
    }
    const [row] = await ctx.tx.query<SubscriptionRow>(
      `update webhook_subscriptions s
       set status = $2,
         disabled_reason = case when $2 = 'disabled' then 'manual' end,
         failing_since = case when $2 = 'active' then null else failing_since end,
         updated_at = now(), version = version + 1
       where s.id = $1 returning ${SUBSCRIPTION_COLUMNS}`,
      [before.id, input.status],
    );
    return {
      result: { subscription: subscriptionOut(row!) },
      audit: {
        targetType: 'webhook_subscription',
        targetId: before.id,
        changes: { status: { from: before.status, to: input.status } },
      },
    };
  },
});

export const deleteWebhookSubscription = defineOperation({
  ...COMMON,
  id: 'webhooks.subscriptions.delete',
  summary: 'Delete a webhook subscription',
  description:
    'Stops all deliveries and cancels pending retries. The delivery log and history are kept.',
  kind: 'command',
  input: z.object({ subscriptionId: Id }),
  output: z.object({ subscriptionId: Id, deleted: z.literal(true) }),
  audit: { action: 'webhook.subscription.deleted' },
  http: { method: 'POST', path: '/shops/{shopId}/webhook-subscriptions/{subscriptionId}/delete' },
  async handler(ctx, input) {
    const before = await loadSubscription(ctx, input.subscriptionId, true);
    await ctx.tx.query(
      `update webhook_subscriptions
       set status = 'deleted', deleted_at = now(), updated_at = now(), version = version + 1
       where id = $1`,
      [before.id],
    );
    const cancelled = await ctx.tx.query(
      `update webhook_deliveries
       set status = 'cancelled', next_attempt_at = null, last_error = 'The subscription was deleted.'
       where subscription_id = $1 and status in ('pending', 'retrying') returning 1`,
      [before.id],
    );
    return {
      result: { subscriptionId: before.id, deleted: true as const },
      audit: {
        targetType: 'webhook_subscription',
        targetId: before.id,
        changes: { status: { from: before.status, to: 'deleted' } },
        context: { cancelledDeliveries: cancelled.length },
      },
    };
  },
});

// Test, deliveries, replay ---------------------------------------------------------------------

interface DeliveryRow {
  id: string;
  subscription_id: string;
  subscription_name: string;
  event_id: string;
  event_type: string;
  test: boolean;
  replay_of: string | null;
  status: z.infer<typeof DeliveryOut>['status'];
  attempts: number;
  next_attempt_at: Date | null;
  last_attempt_at: Date | null;
  last_status_code: number | null;
  last_error: string | null;
  last_response: string | null;
  last_duration_ms: number | null;
  delivered_at: Date | null;
  created_at: Date;
}

const DELIVERY_COLUMNS = `d.id, d.subscription_id, s.name as subscription_name, d.event_id,
  e.type as event_type, e.test, d.replay_of, d.status, d.attempts, d.next_attempt_at,
  d.last_attempt_at, d.last_status_code, d.last_error, d.last_response, d.last_duration_ms,
  d.delivered_at, d.created_at`;

const DELIVERY_FROM = `from webhook_deliveries d
  join webhook_subscriptions s on s.shop_id = d.shop_id and s.id = d.subscription_id
  join webhook_events e on e.shop_id = d.shop_id and e.id = d.event_id`;

function deliveryOut(r: DeliveryRow): z.infer<typeof DeliveryOut> {
  return {
    deliveryId: r.id,
    subscriptionId: r.subscription_id,
    subscriptionName: r.subscription_name,
    eventId: r.event_id,
    eventType: r.event_type,
    test: r.test,
    replayOf: r.replay_of,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: iso(r.next_attempt_at),
    lastAttemptAt: iso(r.last_attempt_at),
    lastStatusCode: r.last_status_code,
    lastError: r.last_error,
    lastResponse: r.last_response,
    lastDurationMs: r.last_duration_ms,
    deliveredAt: iso(r.delivered_at),
    createdAt: iso(r.created_at) as string,
  };
}

async function loadDelivery(ctx: HandlerContext, deliveryId: string): Promise<DeliveryRow> {
  const [row] = await ctx.tx.query<DeliveryRow>(
    `select ${DELIVERY_COLUMNS} ${DELIVERY_FROM}
     where d.id = $1 and ${VISIBLE('$2')}`,
    [deliveryId, ctx.locationScope],
  );
  if (!row) throw errors.notFound('Webhook delivery');
  return row;
}

async function insertDelivery(
  ctx: HandlerContext,
  subscriptionId: string,
  eventId: string,
  replayOf: string | null,
): Promise<DeliveryRow> {
  const id = ctx.newId();
  await ctx.tx.query(
    `insert into webhook_deliveries (shop_id, id, subscription_id, event_id, replay_of, next_attempt_at)
     values (app_shop_id(), $1, $2, $3, $4, now())`,
    [id, subscriptionId, eventId, replayOf],
  );
  return loadDelivery(ctx, id);
}

export const testWebhookSubscription = defineOperation({
  ...COMMON,
  id: 'webhooks.subscriptions.test',
  summary: 'Send a test event to a webhook',
  description:
    'Sends `webhook.test`, or the sample of any available event type, right after the request. The envelope has `"test": true` and the `Airstock-Test: 1` header; it is tried once and never counts toward failures. Works on a disabled subscription too.',
  kind: 'command',
  input: z.object({
    subscriptionId: Id,
    eventType: z
      .string()
      .max(100)
      .default('webhook.test')
      .describe('Send this type’s sample payload instead of webhook.test.'),
  }),
  output: z.object({ eventId: Id, delivery: DeliveryOut }),
  audit: { action: 'webhook.subscription.test_sent' },
  http: { method: 'POST', path: '/shops/{shopId}/webhook-subscriptions/{subscriptionId}/test' },
  async handler(ctx, input) {
    const sub = await loadSubscription(ctx, input.subscriptionId);
    const type = webhookEventTypes.get(input.eventType);
    if (type?.status !== 'available') {
      throw errors.validation([{ path: 'eventType', message: 'Choose an available event type.' }]);
    }
    const data =
      type.id === 'webhook.test'
        ? { message: 'Test event from Airstock.', subscription: { id: sub.id, name: sub.name } }
        : type.sample;
    const eventId = ctx.newId();
    await ctx.tx.query(
      `insert into webhook_events (shop_id, id, type, data, test, created_at)
       values (app_shop_id(), $1, $2, $3, true, now())`,
      [eventId, type.id, JSON.stringify(data)],
    );
    const delivery = await insertDelivery(ctx, sub.id, eventId, null);
    return {
      result: { eventId, delivery: deliveryOut(delivery) },
      audit: {
        targetType: 'webhook_subscription',
        targetId: sub.id,
        context: { eventType: type.id, eventId, deliveryId: delivery.id },
      },
      outbox: [{ topic: WEBHOOK_DELIVER_TOPIC, payload: { deliveryId: delivery.id } }],
    };
  },
});

export const listWebhookDeliveries = defineOperation({
  ...COMMON,
  id: 'webhooks.deliveries.list',
  summary: 'List webhook deliveries',
  description:
    'The delivery log, newest first, kept for 30 days: status, attempts, the last response code and up to 1 KB of its body. Page with `before`.',
  kind: 'read',
  input: z.object({
    subscriptionId: Id.optional(),
    status: z
      .enum(['pending', 'sending', 'retrying', 'delivered', 'failed', 'cancelled'])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().max(100).optional().describe('Cursor from the previous page.'),
  }),
  output: z.object({ deliveries: z.array(DeliveryOut), nextCursor: z.string().nullable() }),
  audit: { action: 'webhooks.deliveries.listed' },
  http: { method: 'GET', path: '/shops/{shopId}/webhook-deliveries' },
  async handler(ctx, input) {
    let cursor: [string, string] | null = null;
    if (input.before) {
      const [time, id] = input.before.split('|');
      if (!time || !id || Number.isNaN(Date.parse(time))) {
        throw errors.validation([{ path: 'before', message: 'Invalid cursor.' }]);
      }
      cursor = [time, id];
    }
    const rows = await ctx.tx.query<DeliveryRow>(
      `select ${DELIVERY_COLUMNS} ${DELIVERY_FROM}
       where ${VISIBLE('$1')}
         and ($2::uuid is null or d.subscription_id = $2)
         and ($3::text is null or d.status = $3)
         and ($4::timestamptz is null or (d.created_at, d.id) < ($4::timestamptz, $5::uuid))
       order by d.created_at desc, d.id desc
       limit $6`,
      [
        ctx.locationScope,
        input.subscriptionId ?? null,
        input.status ?? null,
        cursor?.[0] ?? null,
        cursor?.[1] ?? null,
        input.limit + 1,
      ],
    );
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      result: {
        deliveries: page.map(deliveryOut),
        nextCursor: rows.length > input.limit && last ? `${iso(last.created_at)}|${last.id}` : null,
      },
      audit: {
        targetType: input.subscriptionId ? 'webhook_subscription' : 'webhook_delivery',
        targetId: input.subscriptionId ?? 'list',
      },
    };
  },
});

export const getWebhookDelivery = defineOperation({
  ...COMMON,
  id: 'webhooks.deliveries.get',
  summary: 'Get a webhook delivery and its payload',
  description: 'The delivery and the envelope it sends (without the signature header).',
  kind: 'read',
  input: z.object({ deliveryId: Id }),
  output: z.object({ delivery: DeliveryOut, payload: z.unknown() }),
  audit: { action: 'webhook.delivery.viewed' },
  http: { method: 'GET', path: '/shops/{shopId}/webhook-deliveries/{deliveryId}' },
  async handler(ctx, input) {
    const delivery = await loadDelivery(ctx, input.deliveryId);
    const [event] = await ctx.tx.query<{ data: unknown; created_at: Date }>(
      'select data, created_at from webhook_events where id = $1',
      [delivery.event_id],
    );
    return {
      result: {
        delivery: deliveryOut(delivery),
        payload: {
          id: delivery.event_id,
          type: delivery.event_type,
          created_at: iso(event?.created_at ?? null),
          shop_id: ctx.shopId,
          api_version: WEBHOOK_API_VERSION,
          ...(delivery.test ? { test: true } : {}),
          data: event?.data ?? null,
        },
      },
      audit: { targetType: 'webhook_delivery', targetId: delivery.id },
    };
  },
});

export const replayWebhookDelivery = defineOperation({
  ...COMMON,
  id: 'webhooks.deliveries.replay',
  summary: 'Replay a webhook delivery',
  description:
    'Sends the same event again, with the same event ID, as a new delivery with its own retries. The receiver deduplicates by the event ID.',
  kind: 'command',
  input: z.object({ deliveryId: Id }),
  output: z.object({ delivery: DeliveryOut }),
  audit: { action: 'webhook.delivery.replayed' },
  http: { method: 'POST', path: '/shops/{shopId}/webhook-deliveries/{deliveryId}/replay' },
  async handler(ctx, input) {
    const original = await loadDelivery(ctx, input.deliveryId);
    const sub = await loadSubscription(ctx, original.subscription_id);
    if (sub.status !== 'active' && !original.test) {
      throw errors.conflict(
        'webhook_disabled',
        'Turn the webhook on before replaying its deliveries.',
      );
    }
    const delivery = await insertDelivery(ctx, sub.id, original.event_id, original.id);
    return {
      result: { delivery: deliveryOut(delivery) },
      audit: {
        targetType: 'webhook_delivery',
        targetId: delivery.id,
        context: { replayOf: original.id, eventId: original.event_id, subscriptionId: sub.id },
      },
      outbox: [{ topic: WEBHOOK_DELIVER_TOPIC, payload: { deliveryId: delivery.id } }],
    };
  },
});

/** This module's operations, in registry order. */
export const webhooksOperations = [
  listWebhookEventTypes,
  listWebhookSubscriptions,
  createWebhookSubscription,
  updateWebhookSubscription,
  rotateWebhookSecret,
  setWebhookSubscriptionStatus,
  deleteWebhookSubscription,
  testWebhookSubscription,
  listWebhookDeliveries,
  getWebhookDelivery,
  replayWebhookDelivery,
] as const;
