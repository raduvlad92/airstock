import { type OutgoingEmail, sendInvitationEmail, uuidv7 } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerQuery } from '../../../test/helpers.ts';
import type { WorkosUser } from '../src/workos.ts';
import { json, PUBLIC_URL, signInAs, type TestApp, testApp } from './setup.ts';

const DASHBOARD = { origin: PUBLIC_URL, 'x-airstock-request': '1' };

let t: TestApp;
const sent: OutgoingEmail[] = [];
const sender = {
  async send(email: OutgoingEmail) {
    sent.push(email);
    return { id: `msg_${sent.length}` };
  },
};

beforeAll(async () => {
  t = await testApp();
});
afterAll(() => t.close());

function user(email = `${uuidv7()}@example.com`): WorkosUser {
  return { id: `user_${uuidv7().replace(/-/g, '')}`, email, firstName: 'Mara', lastName: null };
}

async function api(cookie: string, path: string, init: RequestInit = {}) {
  return t.app.request(`/api/v1${path}`, {
    ...init,
    headers: { cookie, ...DASHBOARD, 'content-type': 'application/json', ...init.headers },
  });
}

async function ownerWithShop(name: string) {
  const owner = await signInAs(t, user());
  const shop = await json(
    await api(owner.cookie, '/shops', {
      method: 'POST',
      body: JSON.stringify({ name, currency: 'EUR', timezone: 'Europe/Berlin' }),
    }),
  );
  return { ...owner, shopId: shop.shopId as string };
}

async function invite(cookie: string, shopId: string, email: string, role = 'viewer') {
  return api(cookie, `/shops/${shopId}/invitations`, {
    method: 'POST',
    headers: { 'idempotency-key': uuidv7() },
    body: JSON.stringify({ email, role }),
  });
}

async function emailJob(shopId: string, invitationId: string) {
  return sendInvitationEmail(
    { db: t.db, audit: t.sink, email: sender, publicUrl: PUBLIC_URL },
    shopId,
    invitationId,
  );
}

describe('member invitations', () => {
  it('emails an invitation once, and the invited person joins by signing in', async () => {
    const owner = await ownerWithShop('Invite shop');
    const email = `Invitee.${uuidv7().slice(-6)}@Example.com`;
    const res = await invite(owner.cookie, owner.shopId, email, 'inventory_operator');
    expect(res.status).toBe(201);
    const { invitationId } = await json(res);
    const [outbox] = await ownerQuery<{ topic: string; payload: { invitationId: string } }>(
      'select topic, payload from outbox_events where shop_id = $1 and topic like $2',
      [owner.shopId, 'email.%'],
    );
    expect(outbox).toEqual({ topic: 'email.member_invitation', payload: { invitationId } });

    expect(await emailJob(owner.shopId, invitationId)).toBe('sent');
    expect(await emailJob(owner.shopId, invitationId)).toBe('skipped');
    const message = sent.at(-1)!;
    expect(message.to).toBe(email);
    expect(message.idempotencyKey).toBe(`invitation/${invitationId}`);
    expect(message.subject).toContain('Invite shop');
    expect(message.text).toContain(`${PUBLIC_URL}/invitations/${invitationId}`);
    expect(message.text).toContain('an inventory operator');

    // Someone else signed in cannot use the link.
    const stranger = await signInAs(t, user());
    const denied = await t.app.request(`/invitations/${invitationId}`, {
      headers: { cookie: stranger.cookie },
    });
    expect(denied.status).toBe(403);

    // The invited address, with different capitalization, as the identity provider reports it.
    const invitee = await signInAs(t, user(email.toLowerCase()));
    const page = await t.app.request(`/invitations/${invitationId}`, {
      headers: { cookie: invitee.cookie },
    });
    expect(page.status).toBe(200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
    const forged = await t.app.request(`/invitations/${invitationId}/accept`, {
      method: 'POST',
      headers: {
        cookie: invitee.cookie,
        origin: PUBLIC_URL,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'csrf=wrong',
    });
    expect(forged.status).toBe(403);
    const accepted = await t.app.request(`/invitations/${invitationId}/accept`, {
      method: 'POST',
      headers: {
        cookie: invitee.cookie,
        origin: PUBLIC_URL,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf }),
    });
    expect(accepted.status).toBe(303);
    const shops = await json(await api(invitee.cookie, '/shops'));
    expect(shops.shops).toEqual([
      expect.objectContaining({ id: owner.shopId, role: 'inventory_operator' }),
    ]);
    const members = await json(await api(owner.cookie, `/shops/${owner.shopId}/members`));
    expect(members.members.map((m: { role: string }) => m.role).sort()).toEqual([
      'inventory_operator',
      'owner',
    ]);
    expect(members.invitations).toEqual([]);
    const [event] = await ownerQuery<{ actor_id: string }>(
      `select actor_id from audit_events where shop_id = $1 and action = 'member.invitation.accepted'`,
      [owner.shopId],
    );
    expect(event?.actor_id).toBeTruthy();
    // A second acceptance finds the invitation closed.
    const again = await t.app.request(`/invitations/${invitationId}`, {
      headers: { cookie: invitee.cookie },
    });
    expect(again.status).toBe(409);
  });

  it('lets one user belong to two shops with different owners (E3)', async () => {
    const a = await ownerWithShop('Owner A shop');
    const b = await ownerWithShop('Owner B shop');
    const both = user();
    const invites = [
      await json(await invite(a.cookie, a.shopId, both.email, 'manager')),
      await json(await invite(b.cookie, b.shopId, both.email, 'viewer')),
    ];
    const session = await signInAs(t, both);
    for (const { invitationId } of invites) {
      const page = await t.app.request(`/invitations/${invitationId}`, {
        headers: { cookie: session.cookie },
      });
      const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
      const res = await t.app.request(`/invitations/${invitationId}/accept`, {
        method: 'POST',
        headers: {
          cookie: session.cookie,
          origin: PUBLIC_URL,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ csrf }),
      });
      expect(res.status).toBe(303);
    }
    const shops = await json(await api(session.cookie, '/shops'));
    expect(
      shops.shops.map((s: { name: string; role: string }) => `${s.name}:${s.role}`).sort(),
    ).toEqual(['Owner A shop:manager', 'Owner B shop:viewer']);
  });

  it('refuses duplicate invitations, existing members, and members without the permission', async () => {
    const owner = await ownerWithShop('Strict shop');
    const email = `${uuidv7()}@example.com`;
    expect((await invite(owner.cookie, owner.shopId, email)).status).toBe(201);
    const duplicate = await invite(owner.cookie, owner.shopId, email.toUpperCase());
    expect(duplicate.status).toBe(409);
    expect((await json(duplicate)).code).toBe('already_invited');
    const self = await ownerQuery<{ email: string }>(
      `select u.email from memberships m join users u on u.id = m.user_id where m.shop_id = $1`,
      [owner.shopId],
    );
    const member = await invite(owner.cookie, owner.shopId, self[0]!.email);
    expect((await json(member)).code).toBe('already_member');

    const viewerEmail = `${uuidv7()}@example.com`;
    const { invitationId } = await json(await invite(owner.cookie, owner.shopId, viewerEmail));
    const viewer = await signInAs(t, user(viewerEmail));
    const page = await t.app.request(`/invitations/${invitationId}`, {
      headers: { cookie: viewer.cookie },
    });
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
    await t.app.request(`/invitations/${invitationId}/accept`, {
      method: 'POST',
      headers: {
        cookie: viewer.cookie,
        origin: PUBLIC_URL,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf }),
    });
    const res = await invite(viewer.cookie, owner.shopId, `${uuidv7()}@example.com`);
    expect(res.status).toBe(403);
  });
});

describe('sign-in history', () => {
  it('records sign-ins with the method, and sign-outs, as platform events', async () => {
    const before = t.sink.events.length;
    const someone = user();
    const { cookie } = await signInAs(t, someone);
    const signedIn = t.sink.events.slice(before).find((e) => e.action === 'user.signed_in');
    expect(signedIn).toMatchObject({
      shop_id: null,
      actor_type: 'user',
      outcome: 'succeeded',
      context: expect.objectContaining({ method: 'google' }),
    });
    const out = await t.app.request('/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: PUBLIC_URL },
    });
    expect(out.status).toBe(303);
    const signedOut = t.sink.events.slice(before).find((e) => e.action === 'user.signed_out');
    expect(signedOut?.actor_id).toBe(signedIn?.actor_id);
  });
});
