// Webhook delivery (plan Section 5.13): fan-out, signed POSTs, retries, auto-disable, and the log.
//
// A committed outbox row (`webhook.event`, or `inventory.availability_changed` for stock.changed)
// is turned into one stored event and one delivery per matching subscription. Each delivery is
// POSTed right away; a failure comes back through the jobs queue with a delay. The event ID is the
// outbox row's ID, the same on every retry and replay, so consumers deduplicate by it (A19).

import type { Database, Tx } from '@airstock/db';
import { type AuditEvent, auditEvent, INSERT_AUDIT_EVENTS_SQL } from '../audit.ts';
import type { Caller } from '../caller.ts';
import { UUID_PATTERN, uuidv7 } from '../ids.ts';
import type { EmailSender } from '../operations/members.ts';
import type { Logger } from '../pipeline.ts';
import {
  WEBHOOK_API_VERSION,
  WEBHOOK_DELIVER_TOPIC,
  WEBHOOK_EVENT_TOPIC,
  webhookEventTypes,
} from './events.ts';
import {
  type WebhookSecretCipher,
  webhookSecretContext,
  webhookSignatureHeader,
} from './signing.ts';
import { checkWebhookUrl } from './urls.ts';

/** Seconds to wait after each failed attempt: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h. */
export const WEBHOOK_RETRY_SCHEDULE_SECONDS = [60, 300, 1800, 7200, 21600, 43200, 86400] as const;
/** The first attempt and one per retry; after the last failure the delivery is failed. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_SCHEDULE_SECONDS.length + 1;
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Response bodies are kept to their first 1 KB. */
export const WEBHOOK_RESPONSE_LIMIT = 1024;
/** A subscription failing this long without a success is disabled and its owners emailed. */
export const WEBHOOK_AUTO_DISABLE_MS = 3 * 24 * 60 * 60 * 1000;
export const WEBHOOK_RETENTION_DAYS = 30;
/** Cloudflare Queues delays a message by at most 12 hours; a longer wait is sent in parts. */
export const QUEUE_MAX_DELAY_SECONDS = 43_200;
/** How long one sender holds a delivery; an expired hold is recovered by the sweep. */
const LEASE_MS = 60_000;

/** A jobs-queue message that attempts one delivery. */
export interface WebhookDeliveryMessage {
  webhookDelivery: { shopId: string; deliveryId: string };
}

export interface WebhookDeps {
  db: Database;
  /** Decrypts signing secrets; without it deliveries wait and retry (not configured). */
  cipher: WebhookSecretCipher | null;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Queues one delivery attempt after a delay (the jobs queue). */
  schedule(message: WebhookDeliveryMessage, delaySeconds: number): Promise<void>;
  logger?: Logger;
  /** Test clock. */
  now?: () => number;
}

export type DeliveryResult =
  | 'delivered'
  | 'retrying'
  | 'failed'
  | 'cancelled'
  | 'not_due'
  | 'busy'
  | 'done'
  | 'missing';

/** The system actor for delivery outcomes: source `webhooks` (plan Section 5.13). */
export function webhooksCaller(shopId: string): Caller {
  return {
    kind: 'system',
    id: 'webhooks',
    userId: null,
    boundShopId: shopId,
    membership: null,
    scopes: 'all',
    source: 'webhooks',
  };
}

function base(shopId: string) {
  return {
    shopId,
    caller: webhooksCaller(shopId),
    requestId: uuidv7(),
    attemptId: null,
    idempotencyKey: null,
  };
}

// Fan-out ---------------------------------------------------------------------------------------

export interface WebhookEventMessage {
  shopId: string;
  /** The outbox row's ID: the envelope `id`. */
  eventId: string;
  type: string;
  input: unknown;
  /** The outbox row's time: when the change committed. */
  createdAt: string;
}

/**
 * Stores the event and one delivery per active subscription whose types and filters match, then
 * returns the deliveries to send. Runs again harmlessly for a redelivered outbox message.
 */
export async function fanOutWebhookEvent(
  deps: Pick<WebhookDeps, 'db' | 'logger'>,
  msg: WebhookEventMessage,
): Promise<string[]> {
  const type = webhookEventTypes.get(msg.type);
  if (!type || !UUID_PATTERN.test(msg.eventId)) {
    deps.logger?.error('webhook_event_unknown', { type: msg.type, eventId: msg.eventId });
    return [];
  }
  return deps.db.transaction({ shopId: msg.shopId, userId: null }, async (tx) => {
    const stored = await tx.query<{ id: string }>('select id from webhook_events where id = $1', [
      msg.eventId,
    ]);
    if (stored.length > 0) return openDeliveries(tx, msg.eventId);
    // Most shops have no subscriber for most types: one index probe, no snapshot.
    const any = await tx.query(
      `select 1 from webhook_subscriptions where status = 'active' and $1 = any(event_types) limit 1`,
      [type.id],
    );
    if (any.length === 0) return [];
    const built = await type.build(tx, msg.input);
    if (!built) return [];
    const locationIds = (built.locationIds ?? []).filter((id) => UUID_PATTERN.test(id));
    const matched = await tx.query<{ id: string }>(
      `select s.id from webhook_subscriptions s
       where s.status = 'active' and $1 = any(s.event_types)
         and (not $2::boolean or cardinality(s.location_ids) = 0 or exists (
           select 1 from locations l where l.id = any($3::uuid[]) and l.path_ids && s.location_ids))
         and (not $4::boolean or cardinality(s.alert_kinds) = 0 or $5::text = any(s.alert_kinds))
       order by s.id`,
      [
        type.id,
        type.filters.includes('locations'),
        locationIds,
        type.filters.includes('alertKinds'),
        built.alertKind ?? null,
      ],
    );
    if (matched.length === 0) return [];
    const inserted = await tx.query(
      `insert into webhook_events (shop_id, id, type, data, location_ids, alert_kind, created_at)
       values (app_shop_id(), $1, $2, $3, $4, $5, $6)
       on conflict do nothing returning id`,
      [
        msg.eventId,
        type.id,
        JSON.stringify(built.data),
        locationIds,
        built.alertKind ?? null,
        msg.createdAt,
      ],
    );
    // A concurrent run of the same message stored it first and sends its deliveries.
    if (inserted.length === 0) return [];
    const ids = matched.map(() => uuidv7());
    await tx.query(
      `insert into webhook_deliveries (shop_id, id, subscription_id, event_id, next_attempt_at)
       select app_shop_id(), d.id, d.subscription_id, $3, now()
       from unnest($1::uuid[], $2::uuid[]) as d(id, subscription_id)
       on conflict do nothing`,
      [ids, matched.map((m) => m.id), msg.eventId],
    );
    return ids;
  });
}

async function openDeliveries(tx: Tx, eventId: string): Promise<string[]> {
  const rows = await tx.query<{ id: string }>(
    `select id from webhook_deliveries
     where event_id = $1 and replay_of is null and status in ('pending', 'retrying')`,
    [eventId],
  );
  return rows.map((r) => r.id);
}

/**
 * Handles the webhook outbox topics: `webhook.event` (fan out, then send) and `webhook.deliver`
 * (send one stored delivery: Send test, replay). Returns false for any other topic.
 */
export async function handleWebhookOutbox(
  deps: WebhookDeps,
  message: { shopId: string; id: string; topic: string; payload: unknown; createdAt: string },
): Promise<boolean> {
  if (message.topic === WEBHOOK_DELIVER_TOPIC) {
    const deliveryId = (message.payload as { deliveryId?: string } | null)?.deliveryId;
    if (deliveryId && UUID_PATTERN.test(deliveryId)) {
      await attemptWebhookDelivery(deps, message.shopId, deliveryId);
    }
    return true;
  }
  if (message.topic !== WEBHOOK_EVENT_TOPIC) return false;
  const p = (message.payload ?? {}) as { type?: string; input?: unknown };
  await publishWebhookEvent(deps, {
    shopId: message.shopId,
    eventId: message.id,
    type: String(p.type ?? ''),
    input: p.input,
    createdAt: message.createdAt,
  });
  return true;
}

/**
 * `stock.changed` from an `inventory.availability_changed` outbox row, built at dispatch, so stock
 * commands write nothing extra for webhooks. The caller still runs the Shopify push for that row.
 */
export function announceStockChanged(
  deps: WebhookDeps,
  message: { shopId: string; id: string; payload: unknown; createdAt: string },
): Promise<DeliveryResult[]> {
  return publishWebhookEvent(deps, {
    shopId: message.shopId,
    eventId: message.id,
    type: 'stock.changed',
    input: message.payload,
    createdAt: message.createdAt,
  });
}

/** Fans one event out and sends its deliveries in parallel. */
export async function publishWebhookEvent(
  deps: WebhookDeps,
  event: WebhookEventMessage,
): Promise<DeliveryResult[]> {
  const ids = await fanOutWebhookEvent(deps, event);
  return Promise.all(ids.map((id) => attemptWebhookDelivery(deps, event.shopId, id)));
}

// One attempt ------------------------------------------------------------------------------------

interface ClaimedDelivery {
  id: string;
  attempts: number;
  replay_of: string | null;
  subscription_id: string;
  event_id: string;
  url: string;
  secret_ciphertext: string;
  previous_secret_ciphertext: string | null;
  previous_secret_expires_at: Date | null;
  type: string;
  data: unknown;
  event_created_at: Date;
  test: boolean;
}

interface SendOutcome {
  ok: boolean;
  /** No retry can help: the URL is no longer allowed. */
  permanent: boolean;
  statusCode: number | null;
  error: string | null;
  response: string | null;
  durationMs: number;
}

/**
 * Sends one delivery if it is due, records the outcome (the delivery row, the subscription's
 * health, one audit event), and queues the next retry. Safe to call twice: only one caller holds
 * the delivery at a time.
 */
export async function attemptWebhookDelivery(
  deps: WebhookDeps,
  shopId: string,
  deliveryId: string,
): Promise<DeliveryResult> {
  const now = deps.now?.() ?? Date.now();
  const claim = await deps.db.transaction({ shopId, userId: null }, async (tx) => {
    const [row] = await tx.query<
      ClaimedDelivery & {
        status: string;
        next_attempt_at: Date | null;
        subscription_status: string;
      }
    >(
      `select d.id, d.status, d.attempts, d.next_attempt_at, d.replay_of, d.subscription_id,
         d.event_id, s.url, s.status as subscription_status, s.secret_ciphertext,
         s.previous_secret_ciphertext, s.previous_secret_expires_at,
         e.type, e.data, e.created_at as event_created_at, e.test
       from webhook_deliveries d
       join webhook_subscriptions s on s.shop_id = d.shop_id and s.id = d.subscription_id
       join webhook_events e on e.shop_id = d.shop_id and e.id = d.event_id
       where d.id = $1
       for update of d`,
      [deliveryId],
    );
    if (!row) return { kind: 'missing' as const };
    if (row.status === 'sending') return { kind: 'busy' as const };
    if (row.status !== 'pending' && row.status !== 'retrying') return { kind: 'done' as const };
    const due = row.next_attempt_at ? new Date(row.next_attempt_at).getTime() : now;
    // A few seconds early is fine: queue delays are approximate, and clocks differ slightly.
    if (due > now + 5000) return { kind: 'not_due' as const, dueAt: due };
    if (row.subscription_status !== 'active' && !row.test) {
      await tx.query(
        `update webhook_deliveries set status = 'cancelled', next_attempt_at = null, last_error = $2
         where id = $1`,
        [deliveryId, `The subscription is ${row.subscription_status}.`],
      );
      await tx.query(INSERT_AUDIT_EVENTS_SQL, [
        JSON.stringify([
          deliveryEvent(shopId, row, 'cancelled', {
            reason: `Not sent: the subscription is ${row.subscription_status}.`,
          }),
        ]),
      ]);
      return { kind: 'cancelled' as const };
    }
    await tx.query(
      `update webhook_deliveries
       set status = 'sending', attempts = attempts + 1, lease_until = $2, last_attempt_at = $3
       where id = $1`,
      [deliveryId, new Date(now + LEASE_MS), new Date(now)],
    );
    return { kind: 'claimed' as const, row: { ...row, attempts: row.attempts + 1 } };
  });

  if (claim.kind === 'not_due') {
    await schedule(deps, shopId, deliveryId, Math.ceil((claim.dueAt - now) / 1000));
    return 'not_due';
  }
  if (claim.kind !== 'claimed') return claim.kind;

  const row = claim.row;
  const outcome = await send(deps, shopId, row, now);
  const final = outcome.ok || outcome.permanent || row.test || row.attempts >= WEBHOOK_MAX_ATTEMPTS;
  const status = outcome.ok ? 'delivered' : final ? 'failed' : 'retrying';
  const delay = status === 'retrying' ? WEBHOOK_RETRY_SCHEDULE_SECONDS[row.attempts - 1]! : null;
  const nextAt = delay !== null ? new Date(now + delay * 1000) : null;

  await deps.db.transaction({ shopId, userId: null }, async (tx) => {
    await tx.query(
      `update webhook_deliveries
       set status = $2, lease_until = null, next_attempt_at = $3, last_status_code = $4,
         last_error = $5, last_response = $6, last_duration_ms = $7,
         delivered_at = case when $2 = 'delivered' then $8::timestamptz else delivered_at end
       where id = $1`,
      [
        deliveryId,
        status,
        nextAt,
        outcome.statusCode,
        outcome.error,
        outcome.response,
        outcome.durationMs,
        new Date(now),
      ],
    );
    const events: AuditEvent[] = [
      deliveryEvent(shopId, row, outcome.ok ? 'succeeded' : 'failed', {
        reason: outcome.error,
        context: {
          subscriptionId: row.subscription_id,
          eventId: row.event_id,
          eventType: row.type,
          attempt: row.attempts,
          statusCode: outcome.statusCode,
          durationMs: outcome.durationMs,
          final,
          nextAttemptAt: nextAt?.toISOString() ?? null,
          test: row.test,
          replayOf: row.replay_of,
        },
      }),
    ];
    // Test sends never count toward a subscription's health.
    if (!row.test) events.push(...(await recordHealth(tx, shopId, row, outcome.ok, now)));
    await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify(events)]);
  });

  if (delay !== null) await schedule(deps, shopId, deliveryId, delay);
  return status;
}

function deliveryEvent(
  shopId: string,
  row: Pick<ClaimedDelivery, 'id' | 'subscription_id' | 'event_id' | 'type'>,
  outcome: 'succeeded' | 'failed' | 'cancelled',
  extra: { reason?: string | null; context?: unknown },
): AuditEvent {
  return auditEvent(base(shopId), {
    action: 'webhook.delivery',
    phase: 'outcome',
    outcome,
    target_type: 'webhook_delivery',
    target_id: row.id,
    reason: extra.reason ?? null,
    context: extra.context ?? {
      subscriptionId: row.subscription_id,
      eventId: row.event_id,
      eventType: row.type,
    },
  });
}

/** A success clears the failing streak; 3 days of failures disable the subscription. */
async function recordHealth(
  tx: Tx,
  shopId: string,
  row: ClaimedDelivery,
  ok: boolean,
  now: number,
): Promise<AuditEvent[]> {
  if (ok) {
    await tx.query(
      `update webhook_subscriptions set failing_since = null, last_success_at = $2 where id = $1`,
      [row.subscription_id, new Date(now)],
    );
    return [];
  }
  const [s] = await tx.query<{ failing_since: Date; status: string; name: string }>(
    `update webhook_subscriptions
     set failing_since = coalesce(failing_since, $2), last_failure_at = $2
     where id = $1 returning failing_since, status, name`,
    [row.subscription_id, new Date(now)],
  );
  if (s?.status !== 'active') return [];
  if (now - new Date(s.failing_since).getTime() < WEBHOOK_AUTO_DISABLE_MS) return [];
  await tx.query(
    `update webhook_subscriptions
     set status = 'disabled', disabled_reason = 'failing', updated_at = $2, version = version + 1
     where id = $1`,
    [row.subscription_id, new Date(now)],
  );
  await tx.query(
    `insert into outbox_events (shop_id, id, topic, payload)
     values (app_shop_id(), $1, 'email.webhook_disabled', $2)`,
    [uuidv7(), JSON.stringify({ subscriptionId: row.subscription_id })],
  );
  return [
    auditEvent(base(shopId), {
      action: 'webhook.subscription.disabled',
      phase: 'outcome',
      outcome: 'succeeded',
      target_type: 'webhook_subscription',
      target_id: row.subscription_id,
      reason: 'Every delivery failed for 3 days.',
      changes: { status: 'disabled', disabledReason: 'failing' },
      context: { failingSince: new Date(s.failing_since).toISOString() },
    }),
  ];
}

async function schedule(
  deps: WebhookDeps,
  shopId: string,
  deliveryId: string,
  delaySeconds: number,
): Promise<void> {
  try {
    await deps.schedule(
      { webhookDelivery: { shopId, deliveryId } },
      Math.max(1, Math.min(delaySeconds, QUEUE_MAX_DELAY_SECONDS)),
    );
  } catch (error) {
    // The 30-minute sweep queues deliveries whose retry message was lost.
    deps.logger?.error('webhook_retry_not_queued', { deliveryId, error: String(error) });
  }
}

/** The envelope as sent: the same `id` and `data` on every attempt and replay. */
export function webhookEnvelope(
  shopId: string,
  event: { id: string; type: string; createdAt: Date | string; data: unknown; test: boolean },
): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    created_at: new Date(event.createdAt).toISOString(),
    shop_id: shopId,
    api_version: WEBHOOK_API_VERSION,
    ...(event.test ? { test: true } : {}),
    data: event.data,
  });
}

async function send(
  deps: WebhookDeps,
  shopId: string,
  row: ClaimedDelivery,
  now: number,
): Promise<SendOutcome> {
  const started = Date.now();
  const fail = (error: string, permanent = false): SendOutcome => ({
    ok: false,
    permanent,
    statusCode: null,
    error,
    response: null,
    durationMs: Date.now() - started,
  });
  const checked = checkWebhookUrl(row.url);
  if (!checked.ok) return fail(`Not sent: ${checked.reason}`, true);
  if (!deps.cipher) return fail('Webhook signing is not configured on this server yet.');
  const context = webhookSecretContext(shopId, row.subscription_id);
  let secrets: string[];
  try {
    secrets = [await deps.cipher.decrypt(row.secret_ciphertext, context)];
    if (
      row.previous_secret_ciphertext &&
      row.previous_secret_expires_at &&
      new Date(row.previous_secret_expires_at).getTime() > now
    ) {
      secrets.push(await deps.cipher.decrypt(row.previous_secret_ciphertext, context));
    }
  } catch (error) {
    deps.logger?.error('webhook_secret_unreadable', { deliveryId: row.id, error: String(error) });
    return fail('The signing secret could not be read. Rotate the secret.', true);
  }
  const body = webhookEnvelope(shopId, {
    id: row.event_id,
    type: row.type,
    createdAt: row.event_created_at,
    data: row.data,
    test: row.test,
  });
  const timestamp = Math.floor(now / 1000);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'Airstock-Webhooks/1',
    'airstock-event-id': row.event_id,
    'airstock-event-type': row.type,
    'airstock-delivery-id': row.id,
    'airstock-signature': await webhookSignatureHeader(secrets, timestamp, body),
    ...(row.test ? { 'airstock-test': '1' } : {}),
  };
  let res: Response;
  try {
    res = await deps.fetch(checked.url.href, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    return fail(
      name === 'TimeoutError' || name === 'AbortError'
        ? `No response within ${WEBHOOK_TIMEOUT_MS / 1000} seconds.`
        : `Could not connect: ${String((error as Error)?.message ?? error).slice(0, 200)}`,
    );
  }
  const response = await readLimited(res, WEBHOOK_RESPONSE_LIMIT);
  const ok = res.status >= 200 && res.status < 300;
  let error: string | null = null;
  if (!ok) {
    error =
      res.status >= 300 && res.status < 400
        ? `Redirects are not followed (HTTP ${res.status}).`
        : `HTTP ${res.status}.`;
  }
  return {
    ok,
    permanent: false,
    statusCode: res.status,
    error,
    response,
    durationMs: Date.now() - started,
  };
}

/** Reads at most `limit` bytes of a response body, then stops reading. */
async function readLimited(res: Response, limit: number): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
    }
  } catch {
    // A body cut off mid-way still gives what arrived.
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, bytes.length - offset);
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= bytes.length) break;
  }
  const text = new TextDecoder().decode(bytes);
  return text.length > limit ? text.slice(0, limit) : text;
}

// Sweeps ----------------------------------------------------------------------------------------

/**
 * The 30-minute sweep: deliveries whose retry message was lost or whose sender stopped. Returns
 * the queue messages to send.
 */
export async function recoverWebhookDeliveries(
  db: Database,
  limit = 200,
): Promise<WebhookDeliveryMessage[]> {
  const rows = await db.transaction({ shopId: null, userId: null }, (tx) =>
    tx.query<{ shop_id: string; id: string }>(
      'select shop_id, id from recover_webhook_deliveries($1)',
      [limit],
    ),
  );
  return rows.map((r) => ({ webhookDelivery: { shopId: r.shop_id, deliveryId: r.id } }));
}

/** The daily sweep: deliveries and events older than 30 days. */
export async function sweepWebhookHistory(
  db: Database,
  days = WEBHOOK_RETENTION_DAYS,
): Promise<number> {
  const [row] = await db.transaction({ shopId: null, userId: null }, (tx) =>
    tx.query<{ deleted: number }>('select delete_old_webhook_history($1) as deleted', [days]),
  );
  return row?.deleted ?? 0;
}

// Owner email after an automatic disable --------------------------------------------------------

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Emails the shop's owners that a failing subscription was disabled (ADR 0009's Resend path). The
 * provider's idempotency key makes a retried job send once per owner.
 */
export async function sendWebhookDisabledEmail(
  deps: { db: Database; email: EmailSender; publicUrl: string },
  shopId: string,
  subscriptionId: string,
): Promise<number> {
  const data = await deps.db.transaction({ shopId, userId: null, readOnly: true }, async (tx) => {
    const [sub] = await tx.query<{
      name: string;
      url: string;
      status: string;
      updated_at: Date;
      shop_name: string;
    }>(
      `select w.name, w.url, w.status, w.updated_at, s.name as shop_name
       from webhook_subscriptions w join shops s on s.id = w.shop_id
       where w.id = $1`,
      [subscriptionId],
    );
    const owners = await tx.query<{ user_id: string; email: string }>(
      `select u.id as user_id, u.email from memberships m join users u on u.id = m.user_id
       where m.role = 'owner' and m.status = 'active'`,
    );
    return { sub, owners };
  });
  if (data.sub?.status !== 'disabled') return 0;
  const { sub } = data;
  const host = (() => {
    try {
      return new URL(sub.url).host;
    } catch {
      return 'its endpoint';
    }
  })();
  const link = new URL(`/app/shops/${shopId}/integrations/webhooks`, deps.publicUrl).href;
  const subject = `Webhook "${sub.name}" was turned off in ${sub.shop_name}`;
  const text = [
    `Every delivery from the webhook "${sub.name}" to ${host} failed for 3 days, so Airstock turned it off.`,
    '',
    `Check the endpoint, then turn the webhook back on and replay what it missed: ${link}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1d1c1a;line-height:1.5">
<p>Every delivery from the webhook <strong>${escapeHtml(sub.name)}</strong> to ${escapeHtml(host)} failed for 3 days, so Airstock turned it off.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#1f5f4a;color:#fff;border-radius:8px;text-decoration:none">Open webhook settings</a></p>
<p style="color:#6b6862;font-size:14px">Check the endpoint, then turn the webhook back on and replay the deliveries it missed from the delivery log.</p>
</body></html>`;
  const disabledAt = new Date(sub.updated_at).toISOString();
  let sent = 0;
  for (const owner of data.owners) {
    const result = await deps.email.send({
      to: owner.email,
      subject,
      text,
      html,
      idempotencyKey: `webhook-disabled/${subscriptionId}/${disabledAt}/${owner.user_id}`,
      tags: { kind: 'webhook_disabled' },
    });
    sent++;
    await deps.db.transaction({ shopId, userId: null }, (tx) =>
      tx.query(INSERT_AUDIT_EVENTS_SQL, [
        JSON.stringify([
          auditEvent(base(shopId), {
            action: 'webhook.subscription.disabled_email_sent',
            phase: 'outcome',
            outcome: 'succeeded',
            target_type: 'webhook_subscription',
            target_id: subscriptionId,
            external_ref: `email:${result.id}`,
            context: { recipientUserId: owner.user_id },
          }),
        ]),
      ]),
    );
  }
  return sent;
}
