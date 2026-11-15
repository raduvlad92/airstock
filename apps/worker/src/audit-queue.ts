import type { AuditEvent } from '@airstock/core';
import type { AuditMessage } from './env.ts';

/** Queue messages are limited to 128 KB; stay well under it. */
const AUDIT_MESSAGE_BYTES = 100_000;

export function packAuditEvents(events: AuditEvent[]): AuditMessage[] {
  const out: AuditMessage[] = [];
  let current: AuditEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = JSON.stringify(event).length;
    if (current.length > 0 && bytes + size > AUDIT_MESSAGE_BYTES) {
      out.push({ events: current });
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length > 0) out.push({ events: current });
  return out;
}

/** Accepts both message shapes, so events queued before a deploy are still ingested. */
export function unpackAuditMessages(bodies: unknown[]): AuditEvent[] {
  return bodies.flatMap((body) =>
    body && typeof body === 'object' && 'events' in body && Array.isArray(body.events)
      ? (body.events as AuditEvent[])
      : [body as AuditEvent],
  );
}
