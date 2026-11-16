import type { EmailSender, OutgoingEmail } from '@airstock/core';

// Resend over HTTP (ADR 0009). The Idempotency-Key header makes a retried send deliver once.

export class EmailError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmailError';
  }
}

export function resendSender(config: {
  apiKey: string;
  /** For example: Airstock <invites@mail.airstock.example>. */
  from: string;
  fetch?: typeof fetch;
}): EmailSender {
  const doFetch = config.fetch ?? fetch;
  return {
    async send(email: OutgoingEmail) {
      const res = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': email.idempotencyKey,
        },
        body: JSON.stringify({
          from: config.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          html: email.html,
          ...(email.replyTo ? { reply_to: email.replyTo } : {}),
          ...(email.attachments?.length
            ? {
                attachments: email.attachments.map((a) => ({
                  filename: a.filename,
                  content: base64(a.content),
                  content_type: a.contentType,
                })),
              }
            : {}),
          tags: Object.entries(email.tags ?? {}).map(([name, value]) => ({ name, value })),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok || !body.id) {
        throw new EmailError(
          `Resend returned ${res.status}: ${body.message ?? 'no message'}`,
          res.status,
          res.status === 429 || res.status >= 500,
        );
      }
      return { id: body.id };
    },
  };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
