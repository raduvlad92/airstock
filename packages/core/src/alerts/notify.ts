import type { Database } from '@airstock/db';
import { systemCaller } from '../accounts.ts';
import { type AuditEvent, type AuditSink, auditEvent, INSERT_AUDIT_EVENTS_SQL } from '../audit.ts';
import { uuidv7 } from '../ids.ts';
import { type EmailSender, escapeHtml } from '../operations/members.ts';

/**
 * Emails an opened alert to the members who receive its kind by email, within their location
 * scope (D12): one email per alert opening and member, never one per order. A notification row
 * per member is written before sending, so a retried job sends only what is still pending, and the
 * provider's idempotency key covers a send whose result was lost.
 */
export async function notifyAlertOpened(
  deps: { db: Database; audit?: AuditSink; email: EmailSender; publicUrl: string },
  shopId: string,
  alertId: string,
): Promise<{ sent: number; skipped: boolean }> {
  const pending = await deps.db.transaction({ shopId, userId: null }, async (tx) => {
    const [alert] = await tx.query<{
      id: string;
      kind: string;
      status: string;
      details: Record<string, unknown>;
      opened_at: Date;
      shop_name: string;
    }>(
      `select a.id, a.kind, a.status, a.details, a.opened_at, s.name as shop_name
       from alerts a join shops s on s.id = a.shop_id where a.id = $1`,
      [alertId],
    );
    // Resolved before the email went out: nothing left to say.
    if (!alert || alert.status === 'resolved') return null;
    // Members who receive this kind by email (a row, or by default owners and managers) and whose
    // scope covers the alert; shop-wide alerts go only to members with every location.
    await tx.query(
      `insert into notifications (shop_id, id, alert_id, membership_id, channel, recipient)
       select app_shop_id(), gen_random_uuid(), a.id, m.id, 'email', u.email
       from alerts a
       join memberships m on m.shop_id = a.shop_id and m.status = 'active'
       join users u on u.id = m.user_id
       left join alert_subscriptions s on s.shop_id = m.shop_id and s.membership_id = m.id
         and s.kind = a.kind
       where a.id = $1
         and coalesce(s.email, m.role in ('owner', 'manager'))
         and (m.all_locations or (a.location_ids is not null and exists (
           select 1 from membership_location_scopes ms
           where ms.shop_id = m.shop_id and ms.membership_id = m.id
             and ms.scope_id = any(a.location_ids))))
       on conflict (shop_id, alert_id, membership_id, channel) do nothing`,
      [alertId],
    );
    const rows = await tx.query<{ id: string; membership_id: string; recipient: string }>(
      `select id, membership_id, recipient from notifications
       where alert_id = $1 and status = 'pending' order by id`,
      [alertId],
    );
    return { alert, rows };
  });
  if (!pending) return { sent: 0, skipped: true };
  const { alert, rows } = pending;
  const d = alert.details as Record<string, string | number | null | undefined>;
  const link = new URL(`/app/shops/${shopId}/alerts`, deps.publicUrl).href;
  const { subject, lines } = describe(alert.kind, d);
  let sent = 0;
  for (const row of rows) {
    const text = [
      ...lines,
      '',
      `See your alerts in Airstock: ${link}`,
      '',
      'You receive this because you follow these alerts by email. Change that on the Alerts page.',
    ].join('\n');
    const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1d1c1a;line-height:1.5">
${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n')}
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#1f5f4a;color:#fff;border-radius:8px;text-decoration:none">See your alerts</a></p>
<p style="color:#6b6862;font-size:14px">You receive this because you follow these alerts by email. Change that on the Alerts page.</p>
</body></html>`;
    let outcome: { status: 'sent' | 'failed'; messageId?: string; error?: string };
    try {
      const res = await deps.email.send({
        to: row.recipient,
        subject: `${subject} · ${alert.shop_name}`,
        text,
        html,
        idempotencyKey: `alert/${alertId}/${row.membership_id}`,
        tags: { kind: `alert_${alert.kind}` },
      });
      outcome = { status: 'sent', messageId: res.id };
      sent++;
    } catch (error) {
      if ((error as { retryable?: unknown }).retryable !== false) throw error;
      outcome = {
        status: 'failed',
        error: String((error as Error).message ?? error).slice(0, 1000),
      };
    }
    await deps.db.transaction({ shopId, userId: null }, async (tx) => {
      const updated = await tx.query(
        `update notifications set status = $2, provider_message_id = $3, error = $4,
           sent_at = case when $2 = 'sent' then now() end
         where id = $1 and status = 'pending' returning 1`,
        [row.id, outcome.status, outcome.messageId ?? null, outcome.error ?? null],
      );
      if (updated.length === 0) return;
      const event: AuditEvent = auditEvent(
        {
          shopId,
          caller: systemCaller('email', shopId),
          requestId: uuidv7(),
          attemptId: null,
          idempotencyKey: null,
        },
        {
          action: `alert.email_${outcome.status}`,
          phase: 'outcome',
          outcome: outcome.status === 'sent' ? 'succeeded' : 'failed',
          target_type: 'alert',
          target_id: alertId,
          external_ref: outcome.messageId ? `email:${outcome.messageId}` : null,
          reason: outcome.error ?? null,
          context: { membershipId: row.membership_id, notificationId: row.id },
        },
      );
      await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify([event])]);
    });
  }
  return { sent, skipped: false };
}

function describe(
  kind: string,
  d: Record<string, string | number | null | undefined>,
): { subject: string; lines: string[] } {
  const where = d.locationPath ?? d.warehouseName ?? 'a warehouse';
  switch (kind) {
    case 'low_stock':
      return {
        subject: `Low stock: ${d.sku}`,
        lines: [
          `${d.productName} (${d.sku}) is low at ${where}.`,
          `Available: ${d.available}. On order: ${d.onOrder}. Reorder point: ${d.reorderPoint}.`,
          'Draft a purchase order from low stock on the Purchasing page.',
        ],
      };
    case 'lot_expiring':
      return {
        subject: `Lot ${d.lotCode} ${d.expired ? 'expired' : 'expires soon'}`,
        lines: [
          `Lot ${d.lotCode} of ${d.productName} (${d.sku}) ${d.expired ? 'expired on' : 'expires on'} ${d.expiresOn}.`,
          `${d.onHand} units are still in stock.`,
        ],
      };
    case 'shortage':
      return {
        subject: `Shortage: ${d.sku}`,
        lines: [
          `Accepted orders wait for ${d.shortage} units of ${d.productName} (${d.sku}) that no stock covers.`,
          'Receiving stock fills them, oldest order first.',
        ],
      };
    case 'reconciliation_mismatch':
      return {
        subject: 'The stock check found problems',
        lines: [
          `The scheduled stock check found ${d.count} ${d.count === 1 ? 'problem' : 'problems'}. Nothing was changed.`,
          'Review and repair them on the Inventory page, under Stock check.',
        ],
      };
    default:
      return { subject: 'An alert opened', lines: ['An alert opened in Airstock.'] };
  }
}
