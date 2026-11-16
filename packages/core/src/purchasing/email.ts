import type { Database } from '@airstock/db';
import { systemCaller } from '../accounts.ts';
import { type AuditSink, auditEvent, INSERT_AUDIT_EVENTS_SQL } from '../audit.ts';
import { uuidv7 } from '../ids.ts';
import { type EmailSender, escapeHtml } from '../operations/members.ts';
import { loadPurchaseOrder, type PurchaseOrderView } from './orders.ts';

/**
 * Who may receive email in this environment (ADR 0009 update): `any` in production; `members` on
 * staging, where only addresses of the shop's own members get real mail, so test suppliers with
 * made-up addresses never receive anything.
 */
export type EmailRecipients = 'any' | 'members';

export interface PurchaseOrderEmailDeps {
  db: Database;
  audit: AuditSink;
  email: EmailSender;
  /** Renders the order as the supplier sees it (with costs). */
  renderPdf(order: PurchaseOrderView): Promise<Uint8Array>;
  recipients: EmailRecipients;
}

export type PurchaseOrderEmailOutcome = 'sent' | 'skipped' | 'suppressed' | 'failed';

/**
 * Emails a queued purchase order send, from the jobs consumer (D11). The PDF is rendered from the
 * order as it is now; the send records the version it was queued for. The provider's idempotency
 * key covers a retry after a send whose result was lost. A provider error that will not pass on a
 * retry marks the send failed; anything else is thrown so the job retries.
 */
export async function sendPurchaseOrderEmail(
  deps: PurchaseOrderEmailDeps,
  shopId: string,
  sendId: string,
): Promise<PurchaseOrderEmailOutcome> {
  const loaded = await deps.db.transaction({ shopId, userId: null, readOnly: true }, async (tx) => {
    const [send] = await tx.query<{
      purchase_order_id: string;
      status: string;
      recipient: string | null;
      message: string | null;
      actor_type: string;
      actor_id: string;
      allowed: boolean;
      reply_to: string | null;
    }>(
      `select d.purchase_order_id, d.status, d.recipient, d.message, d.actor_type, d.actor_id,
         exists (select 1 from users u join memberships m on m.user_id = u.id
           where m.shop_id = d.shop_id and m.status = 'active'
             and lower(u.email) = lower(d.recipient)) as allowed,
         (select u.email from users u where d.actor_type = 'user' and u.id::text = d.actor_id) as reply_to
       from po_sends d where d.id = $1`,
      [sendId],
    );
    if (send?.status !== 'queued' || !send.recipient) return null;
    const order = await loadPurchaseOrder(tx, send.purchase_order_id, true);
    return { send, order };
  });
  if (!loaded) return 'skipped';
  const { send, order } = loaded;
  const recipient = send.recipient!;

  if (deps.recipients === 'members' && !send.allowed) {
    await finish(deps, shopId, sendId, order, {
      status: 'suppressed',
      error: 'This environment emails only members of the shop; the order was not emailed.',
    });
    return 'suppressed';
  }

  const pdf = await deps.renderPdf(order);
  const subject = `Purchase order ${order.number} from ${order.shop.name}`;
  const lines = order.lines.map(
    (l) =>
      `- ${l.quantity}${l.packName ? ` × ${l.packName}` : ''} ${l.productName}${l.variantName ? ` (${l.variantName})` : ''}, ${l.supplierSku ? `your SKU ${l.supplierSku}` : `SKU ${l.sku}`}`,
  );
  const text = [
    ...(send.message ? [send.message, ''] : []),
    `${order.shop.name} sends you purchase order ${order.number}.`,
    order.expectedOn ? `Expected delivery: ${order.expectedOn}.` : null,
    `Deliver to: ${order.warehouse.name}${order.warehouse.address ? `, ${order.warehouse.address}` : ''}.`,
    '',
    ...lines,
    '',
    `The order is attached as a PDF (${order.number}.pdf).`,
  ]
    .filter((l) => l !== null)
    .join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1d1c1a;line-height:1.5">
${send.message ? `<p>${escapeHtml(send.message).replaceAll('\n', '<br>')}</p>` : ''}
<p>${escapeHtml(order.shop.name)} sends you purchase order <strong>${escapeHtml(order.number)}</strong>.</p>
${order.expectedOn ? `<p>Expected delivery: ${escapeHtml(order.expectedOn)}.</p>` : ''}
<p>Deliver to: ${escapeHtml(order.warehouse.name)}${order.warehouse.address ? `, ${escapeHtml(order.warehouse.address)}` : ''}.</p>
<ul>${lines.map((l) => `<li>${escapeHtml(l.slice(2))}</li>`).join('')}</ul>
<p style="color:#6b6862;font-size:14px">The order is attached as a PDF (${escapeHtml(order.number)}.pdf).</p>
</body></html>`;
  let sent: { id: string };
  try {
    sent = await deps.email.send({
      to: recipient,
      subject,
      text,
      html,
      idempotencyKey: `purchase-order-send/${sendId}`,
      tags: { kind: 'purchase_order' },
      ...(send.reply_to ? { replyTo: send.reply_to } : {}),
      attachments: [
        { filename: `${order.number}.pdf`, content: pdf, contentType: 'application/pdf' },
      ],
    });
  } catch (error) {
    if ((error as { retryable?: unknown }).retryable === false) {
      await finish(deps, shopId, sendId, order, {
        status: 'failed',
        error: String((error as Error).message ?? error).slice(0, 1000),
      });
      return 'failed';
    }
    throw error;
  }
  await finish(deps, shopId, sendId, order, { status: 'sent', messageId: sent.id });
  return 'sent';
}

async function finish(
  deps: PurchaseOrderEmailDeps,
  shopId: string,
  sendId: string,
  order: PurchaseOrderView,
  outcome: { status: 'sent' | 'failed' | 'suppressed'; messageId?: string; error?: string },
): Promise<void> {
  await deps.db.transaction({ shopId, userId: null }, async (tx) => {
    const updated = await tx.query(
      `update po_sends set status = $2, provider_message_id = $3, error = $4, completed_at = now()
       where id = $1 and status = 'queued' returning 1`,
      [sendId, outcome.status, outcome.messageId ?? null, outcome.error ?? null],
    );
    if (updated.length === 0) return;
    const event = auditEvent(
      {
        shopId,
        caller: systemCaller('email', shopId),
        requestId: uuidv7(),
        attemptId: null,
        idempotencyKey: null,
      },
      {
        action: `purchasing.order.email_${outcome.status}`,
        phase: 'outcome',
        outcome: outcome.status === 'sent' ? 'succeeded' : 'failed',
        target_type: 'purchase_order',
        target_id: order.id,
        external_ref: outcome.messageId ? `email:${outcome.messageId}` : order.number,
        reason: outcome.error ?? null,
        context: { sendId },
      },
    );
    await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify([event])]);
  });
}
