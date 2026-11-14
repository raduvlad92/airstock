import type { Database } from '@airstock/db';
import { z } from 'zod';
import { sessionCaller, systemCaller } from '../accounts.ts';
import { type AuditSink, auditEvent, INSERT_AUDIT_EVENTS_SQL } from '../audit.ts';
import { AppError, errors } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import { defineOperation } from '../registry.ts';
import { Id, iso } from '../schemas.ts';

const INTERACTIVE =
  'Account-level: people invite people from the dashboard; a connection is bound to one shop and never manages members.';

/** Roles an invitation may grant. Ownership is not transferable in Phase 0. */
const InvitableRole = z.enum(['manager', 'catalog_editor', 'inventory_operator', 'viewer']);
const INVITATION_DAYS = 7;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const inviteMember = defineOperation({
  id: 'members.invite',
  summary: 'Invite someone to the shop',
  description:
    'Emails an invitation to join the shop with a role. The person accepts by signing in with that email address within seven days.',
  kind: 'command',
  scope: 'shop',
  input: z.object({
    email: z
      .string()
      .trim()
      .max(320)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'An email address.'),
    role: InvitableRole,
  }),
  output: z.object({
    invitationId: Id,
    email: z.string(),
    role: z.string(),
    expiresAt: z.string(),
  }),
  permission: 'members.manage',
  connectionScope: 'session',
  audit: { action: 'member.invited' },
  idempotency: 'required',
  http: { method: 'POST', path: '/shops/{shopId}/invitations', status: 201 },
  mcp: { exception: INTERACTIVE },
  async handler(ctx, input) {
    if (!ctx.membership) throw errors.forbidden('A shop membership is required.');
    const email = normalizeEmail(input.email);
    const [member] = await ctx.tx.query(
      `select 1 from memberships m join users u on u.id = m.user_id
       where m.status = 'active' and lower(u.email) = $1`,
      [email],
    );
    if (member) {
      throw errors.conflict('already_member', 'This person is already a member of the shop.');
    }
    const invitationId = ctx.newId();
    let row: { expires_at: Date } | undefined;
    try {
      [row] = await ctx.tx.query<{ expires_at: Date }>(
        `insert into member_invitations (shop_id, id, email, email_normalized, role,
           invited_by_membership_id, expires_at)
         values (app_shop_id(), $1, $2, $3, $4, $5, now() + make_interval(days => $6))
         returning expires_at`,
        [invitationId, input.email.trim(), email, input.role, ctx.membership.id, INVITATION_DAYS],
      );
    } catch (error) {
      if (
        (error as { constraint?: string }).constraint === 'member_invitations_pending_email_idx'
      ) {
        throw errors.conflict('already_invited', 'This person already has a pending invitation.');
      }
      throw error;
    }
    const expiresAt = iso(row?.expires_at ?? null) as string;
    return {
      result: { invitationId, email: input.email.trim(), role: input.role, expiresAt },
      audit: {
        targetType: 'invitation',
        targetId: invitationId,
        changes: { email: input.email.trim(), role: input.role, expiresAt },
      },
      // The email is sent after commit by the jobs consumer (PRD 14.2).
      outbox: [{ topic: 'email.member_invitation', payload: { invitationId } }],
    };
  },
});

export const listMembers = defineOperation({
  id: 'members.list',
  summary: 'List members and pending invitations',
  kind: 'read',
  scope: 'shop',
  input: z.object({}),
  output: z.object({
    members: z.array(
      z.object({
        membershipId: Id,
        userId: Id,
        email: z.string(),
        displayName: z.string().nullable(),
        role: z.string(),
        allLocations: z.boolean(),
        status: z.string(),
      }),
    ),
    invitations: z.array(
      z.object({
        invitationId: Id,
        email: z.string(),
        role: z.string(),
        status: z.string(),
        expiresAt: z.string(),
        emailSentAt: z.string().nullable(),
      }),
    ),
  }),
  permission: 'shop.read',
  connectionScope: 'session',
  audit: { action: 'members.listed' },
  idempotency: 'none',
  http: { method: 'GET', path: '/shops/{shopId}/members' },
  mcp: { exception: INTERACTIVE },
  async handler(ctx) {
    const members = await ctx.tx.query<{
      id: string;
      user_id: string;
      email: string;
      display_name: string | null;
      role: string;
      all_locations: boolean;
      status: string;
    }>(
      `select m.id, m.user_id, u.email, u.display_name, m.role, m.all_locations, m.status
       from memberships m join users u on u.id = m.user_id
       where m.shop_id = app_shop_id() order by m.created_at`,
    );
    const invitations = await ctx.tx.query<{
      id: string;
      email: string;
      role: string;
      status: string;
      expires_at: Date;
      email_sent_at: Date | null;
    }>(
      `select id, email, role, status, expires_at, email_sent_at from member_invitations
       where status = 'pending' order by created_at desc limit 200`,
    );
    return {
      result: {
        members: members.map((m) => ({
          membershipId: m.id,
          userId: m.user_id,
          email: m.email,
          displayName: m.display_name,
          role: m.role,
          allLocations: m.all_locations,
          status: m.status,
        })),
        invitations: invitations.map((i) => ({
          invitationId: i.id,
          email: i.email,
          role: i.role,
          status: i.expires_at < new Date() ? 'expired' : i.status,
          expiresAt: iso(i.expires_at) as string,
          emailSentAt: iso(i.email_sent_at),
        })),
      },
      audit: { targetType: 'membership', targetId: 'list' },
    };
  },
});

// Accepting and sending ---------------------------------------------------------------------

export interface InvitationView {
  shopId: string;
  shopName: string;
  role: string;
  /** Whether the signed-in user's verified email is the invited one. */
  forThisUser: boolean;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
}

/** What a signed-in user may see of an invitation they opened. Null if it does not exist. */
export async function viewInvitation(
  db: Database,
  invitationId: string,
  user: { userId: string; email: string },
): Promise<InvitationView | null> {
  const shopId = await invitationShop(db, invitationId);
  if (!shopId) return null;
  const [row] = await db.transaction({ shopId, userId: user.userId, readOnly: true }, (tx) =>
    tx.query<{ name: string; role: string; status: string; expired: boolean; email: string }>(
      `select s.name, i.role, i.status, i.expires_at <= now() as expired, i.email_normalized as email
       from member_invitations i join shops s on s.id = i.shop_id where i.id = $1`,
      [invitationId],
    ),
  );
  if (!row) return null;
  return {
    shopId,
    shopName: row.name,
    role: row.role,
    forThisUser: row.email === normalizeEmail(user.email),
    state:
      row.status === 'pending' && row.expired ? 'expired' : (row.status as InvitationView['state']),
  };
}

async function invitationShop(db: Database, invitationId: string): Promise<string | null> {
  const [row] = await db.transaction({ shopId: null, userId: null, readOnly: true }, (tx) =>
    tx.query<{ shop_id: string | null }>('select invitation_shop($1) as shop_id', [invitationId]),
  );
  return row?.shop_id ?? null;
}

/**
 * Accepts an invitation for the signed-in user, whose email the identity provider verified.
 * Runs inside the invitation's shop: the membership, the invitation update, and the audit event
 * commit together.
 */
export async function acceptInvitation(
  db: Database,
  input: { invitationId: string; userId: string; email: string; requestId: string },
): Promise<{ shopId: string; membershipId: string }> {
  const shopId = await invitationShop(db, input.invitationId);
  if (!shopId) throw errors.notFound('Invitation');
  const caller = sessionCaller(input.userId);
  return db.transaction({ shopId, userId: input.userId }, async (tx) => {
    const [invitation] = await tx.query<{
      email_normalized: string;
      role: string;
      status: string;
      expired: boolean;
    }>(
      `select email_normalized, role, status, expires_at <= now() as expired
       from member_invitations where id = $1 for update`,
      [input.invitationId],
    );
    if (!invitation) throw errors.notFound('Invitation');
    if (invitation.email_normalized !== normalizeEmail(input.email)) {
      throw new AppError(
        403,
        'invitation_email_mismatch',
        'This invitation was sent to a different email address.',
        'denied',
      );
    }
    if (invitation.status !== 'pending' || invitation.expired) {
      throw errors.conflict('invitation_not_open', 'This invitation is no longer open.');
    }
    const [existing] = await tx.query<{ id: string; status: string }>(
      'select id, status from memberships where shop_id = app_shop_id() and user_id = $1',
      [input.userId],
    );
    let membershipId = existing?.id ?? uuidv7();
    if (!existing) {
      await tx.query(
        `insert into memberships (shop_id, id, user_id, role) values (app_shop_id(), $1, $2, $3)`,
        [membershipId, input.userId, invitation.role],
      );
    } else if (existing.status !== 'active') {
      await tx.query(
        `update memberships set status = 'active', role = $2, version = version + 1 where id = $1`,
        [existing.id, invitation.role],
      );
    } else {
      membershipId = existing.id;
    }
    await tx.query(
      `update member_invitations set status = 'accepted', accepted_by_user_id = $2, accepted_at = now()
       where id = $1`,
      [input.invitationId, input.userId],
    );
    const event = auditEvent(
      { shopId, caller, requestId: input.requestId, attemptId: null, idempotencyKey: null },
      {
        action: 'member.invitation.accepted',
        phase: 'outcome',
        outcome: 'succeeded',
        target_type: 'invitation',
        target_id: input.invitationId,
        changes: { membershipId, role: invitation.role },
      },
    );
    await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify([event])]);
    return { shopId, membershipId };
  });
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The provider sends at most once per key (24 hours at Resend). */
  idempotencyKey: string;
  tags?: Record<string, string>;
}

/** Transactional email provider (ADR 0009). */
export interface EmailSender {
  send(email: OutgoingEmail): Promise<{ id: string }>;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const ROLE_NAMES: Record<string, string> = {
  manager: 'a manager',
  catalog_editor: 'a catalog editor',
  inventory_operator: 'an inventory operator',
  viewer: 'a viewer',
};

/**
 * Sends a pending invitation's email once, from the jobs consumer. The provider's idempotency
 * key covers a retry after a send whose result was lost; the sent time and message ID are
 * recorded with an audit event.
 */
export async function sendInvitationEmail(
  deps: { db: Database; audit: AuditSink; email: EmailSender; publicUrl: string },
  shopId: string,
  invitationId: string,
): Promise<'sent' | 'skipped'> {
  const [row] = await deps.db.transaction({ shopId, userId: null, readOnly: true }, (tx) =>
    tx.query<{
      email: string;
      role: string;
      status: string;
      email_sent_at: Date | null;
      expires_at: Date;
      shop_name: string;
      inviter: string;
    }>(
      `select i.email, i.role, i.status, i.email_sent_at, i.expires_at, s.name as shop_name,
         coalesce(u.display_name, u.email) as inviter
       from member_invitations i
       join shops s on s.id = i.shop_id
       join memberships m on m.shop_id = i.shop_id and m.id = i.invited_by_membership_id
       join users u on u.id = m.user_id
       where i.id = $1`,
      [invitationId],
    ),
  );
  if (row?.status !== 'pending' || row.email_sent_at) return 'skipped';
  const link = new URL(`/invitations/${invitationId}`, deps.publicUrl).href;
  const role = ROLE_NAMES[row.role] ?? row.role;
  const expires = new Date(row.expires_at).toUTCString().replace(/:\d\d GMT$/, ' UTC');
  const subject = `${row.inviter} invited you to ${row.shop_name} on Airstock`;
  const text = [
    `${row.inviter} invited you to join ${row.shop_name} on Airstock as ${role}.`,
    '',
    `Accept the invitation: ${link}`,
    '',
    `Sign in with this email address (${row.email}). The invitation expires ${expires}.`,
    'If you did not expect this, you can ignore this email.',
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1d1c1a;line-height:1.5">
<p>${escapeHtml(row.inviter)} invited you to join <strong>${escapeHtml(row.shop_name)}</strong> on Airstock as ${escapeHtml(role)}.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#1f5f4a;color:#fff;border-radius:8px;text-decoration:none">Accept the invitation</a></p>
<p style="color:#6b6862;font-size:14px">Sign in with this email address (${escapeHtml(row.email)}). The invitation expires ${escapeHtml(expires)}. If you did not expect this, you can ignore this email.</p>
</body></html>`;
  const sent = await deps.email.send({
    to: row.email,
    subject,
    text,
    html,
    idempotencyKey: `invitation/${invitationId}`,
    tags: { kind: 'member_invitation' },
  });
  await deps.db.transaction({ shopId, userId: null }, async (tx) => {
    const updated = await tx.query(
      `update member_invitations set email_sent_at = now(), email_message_id = $2
       where id = $1 and email_sent_at is null returning 1`,
      [invitationId, sent.id],
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
        action: 'member.invitation.email_sent',
        phase: 'outcome',
        outcome: 'succeeded',
        target_type: 'invitation',
        target_id: invitationId,
        external_ref: `email:${sent.id}`,
      },
    );
    await tx.query(INSERT_AUDIT_EVENTS_SQL, [JSON.stringify([event])]);
  });
  return 'sent';
}
