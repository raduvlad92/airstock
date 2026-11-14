import { describe, expect, it } from 'vitest';
import { EmailError, resendSender } from '../src/email.ts';

describe('Resend sender', () => {
  it('sends with the idempotency key and returns the message ID', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const sender = resendSender({
      apiKey: 're_test',
      from: 'Airstock <a@mail.example.com>',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ id: 'msg_1' });
      }) as typeof fetch,
    });
    const sent = await sender.send({
      to: 'x@example.com',
      subject: 'Hi',
      text: 'Hello',
      html: '<p>Hello</p>',
      idempotencyKey: 'invitation/1',
      tags: { kind: 'member_invitation' },
    });
    expect(sent).toEqual({ id: 'msg_1' });
    const headers = new Headers(calls[0]!.init.headers);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(headers.get('idempotency-key')).toBe('invitation/1');
    expect(headers.get('authorization')).toBe('Bearer re_test');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      from: 'Airstock <a@mail.example.com>',
      to: ['x@example.com'],
      tags: [{ name: 'kind', value: 'member_invitation' }],
    });
  });

  it('marks rate limits and server errors as retryable, and others not', async () => {
    const failing = (status: number) =>
      resendSender({
        apiKey: 're_test',
        from: 'a@example.com',
        fetch: (async () => Response.json({ message: 'nope' }, { status })) as typeof fetch,
      });
    const email = { to: 'x@example.com', subject: 's', text: 't', html: 'h', idempotencyKey: 'k' };
    await expect(failing(429).send(email)).rejects.toMatchObject({ retryable: true });
    await expect(failing(503).send(email)).rejects.toMatchObject({ retryable: true });
    await expect(failing(422).send(email)).rejects.toBeInstanceOf(EmailError);
    await expect(failing(422).send(email)).rejects.toMatchObject({ retryable: false });
  });
});
