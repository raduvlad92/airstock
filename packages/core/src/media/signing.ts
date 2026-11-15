import type { UploadPart } from './files.ts';

/**
 * Short-lived signed links to media, served by the Worker from R2 (D6, ADR 0015). The request that
 * issues them is the audited access (Q1); fetching a link records nothing more. A link names its
 * shop, media, and part, and the signature covers all three, so it opens nothing else.
 */
export interface MediaDelivery {
  /** A signed link valid for at least `ttlSeconds`. */
  sign(input: {
    shopId: string;
    mediaId: string;
    part: UploadPart;
    ttlSeconds: number;
    now?: number;
  }): Promise<{ url: string; expiresAt: string }>;
  /** An absolute URL for a path on this Worker, such as an upload URL. */
  url(path: string): string;
}

/**
 * Expiry is rounded up to the next 5-minute step, so the links one gallery page receives stay the
 * same for a few minutes and the browser's private cache can answer repeat views.
 */
const STEP_SECONDS = 300;

type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const encoder = new TextEncoder();
const keys = new Map<string, Promise<HmacKey>>();

function hmacKey(secret: string): Promise<HmacKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    keys.set(secret, key);
  }
  return key;
}

const payload = (shopId: string, mediaId: string, part: string, exp: number) =>
  encoder.encode(`media.v1:${shopId}:${mediaId}:${part}:${exp}`);

function base64url(bytes: ArrayBuffer): string {
  let text = '';
  for (const b of new Uint8Array(bytes)) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return null;
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The path the Worker serves a signed link on (apps/worker/src/media.ts). */
export function mediaPath(shopId: string, mediaId: string, part: UploadPart): string {
  return `/media/${shopId}/${mediaId}/${part}`;
}

export function hmacMediaDelivery(secret: string, publicUrl = ''): MediaDelivery {
  const base = publicUrl.replace(/\/+$/, '');
  return {
    async sign({ shopId, mediaId, part, ttlSeconds, now = Date.now() }) {
      const exp = Math.ceil((now / 1000 + ttlSeconds) / STEP_SECONDS) * STEP_SECONDS;
      const sig = await crypto.subtle.sign(
        'HMAC',
        await hmacKey(secret),
        payload(shopId, mediaId, part, exp),
      );
      return {
        url: `${base}${mediaPath(shopId, mediaId, part)}?exp=${exp}&sig=${base64url(sig)}`,
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    },
    url: (path) => `${base}${path}`,
  };
}

/** Checks a signed link; the HMAC comparison is constant-time. */
export async function verifyMediaLink(
  secret: string,
  input: { shopId: string; mediaId: string; part: string; exp: string; sig: string },
  now = Date.now(),
): Promise<'ok' | 'expired' | 'invalid'> {
  const exp = Number(input.exp);
  const sig = fromBase64url(input.sig);
  if (!Number.isSafeInteger(exp) || !/^\d{1,12}$/.test(input.exp) || !sig) return 'invalid';
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    sig,
    payload(input.shopId, input.mediaId, input.part, exp),
  );
  if (!valid) return 'invalid';
  return exp * 1000 <= now ? 'expired' : 'ok';
}
