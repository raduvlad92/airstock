// Webhook signing secrets: generated, stored encrypted, and used to sign each delivery (D14).
// Web Crypto only, so the same code runs in Workers and in Node tests.

const encoder = new TextEncoder();

type CryptoKeyLike = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

function buffer(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A new signing secret: `whsec_` and 32 random bytes, Base64url. Shown once, then encrypted. */
export function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** The last four characters, shown in the dashboard so a person can tell secrets apart. */
export function secretHint(secret: string): string {
  return secret.slice(-4);
}

/**
 * The hex HMAC-SHA256 of `<t>.<body>`, keyed with the secret's UTF-8 bytes (the whole string,
 * `whsec_` included).
 */
export async function signWebhookBody(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
  return toHex(new Uint8Array(mac));
}

/**
 * `Airstock-Signature: t=<unix>,v1=<hex>`. During a secret rotation there is one `v1` per active
 * secret, newest first, so a consumer holding either secret accepts the delivery.
 */
export async function webhookSignatureHeader(
  secrets: readonly string[],
  timestamp: number,
  body: string,
): Promise<string> {
  const signatures = await Promise.all(secrets.map((s) => signWebhookBody(s, timestamp, body)));
  return [`t=${timestamp}`, ...signatures.map((s) => `v1=${s}`)].join(',');
}

export type SignatureCheck =
  | { ok: true; timestamp: number }
  | { ok: false; reason: 'malformed' | 'too_old' | 'too_new' | 'no_match' };

/**
 * The consumer's check (the reference for docs/webhooks.md): the timestamp within `toleranceSeconds`
 * of now, and some `v1` matching some secret the consumer holds.
 */
export async function verifyWebhookSignature(
  header: string | null | undefined,
  body: string,
  secrets: readonly string[],
  { toleranceSeconds = 300, now = Date.now() }: { toleranceSeconds?: number; now?: number } = {},
): Promise<SignatureCheck> {
  if (!header) return { ok: false, reason: 'malformed' };
  let timestamp: number | null = null;
  const presented: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && value && /^[0-9a-f]{64}$/.test(value)) presented.push(value);
  }
  if (timestamp === null || presented.length === 0) return { ok: false, reason: 'malformed' };
  const age = Math.floor(now / 1000) - timestamp;
  if (age > toleranceSeconds) return { ok: false, reason: 'too_old' };
  if (age < -toleranceSeconds) return { ok: false, reason: 'too_new' };
  for (const secret of secrets) {
    const expected = await signWebhookBody(secret, timestamp, body);
    if (presented.some((p) => constantTimeEqualText(p, expected))) return { ok: true, timestamp };
  }
  return { ok: false, reason: 'no_match' };
}

function constantTimeEqualText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Encrypts stored signing secrets with AES-256-GCM, like the Shopify tokens (ADR 0008). The
 * associated data names the shop and subscription, so a ciphertext copied to another row does
 * not decrypt.
 */
export class WebhookSecretCipher {
  private constructor(
    readonly keyId: string,
    private readonly key: CryptoKeyLike,
  ) {}

  /** `keyBase64` is 32 random bytes, Base64 encoded (the Worker secret WEBHOOK_SECRET_KEY). */
  static async fromBase64(keyId: string, keyBase64: string): Promise<WebhookSecretCipher> {
    const raw = fromBase64(keyBase64.trim());
    if (raw?.length !== 32) throw new Error('The webhook secret key must be 32 bytes, Base64.');
    const key = await crypto.subtle.importKey('raw', buffer(raw), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
    return new WebhookSecretCipher(keyId, key);
  }

  async encrypt(plaintext: string, context: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
      this.key,
      encoder.encode(plaintext),
    );
    const out = new Uint8Array(iv.length + sealed.byteLength);
    out.set(iv);
    out.set(new Uint8Array(sealed), iv.length);
    return toBase64(out);
  }

  async decrypt(ciphertext: string, context: string): Promise<string> {
    const bytes = fromBase64(ciphertext);
    if (!bytes || bytes.length < 29) throw new Error('Malformed webhook secret ciphertext.');
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(context) },
      this.key,
      bytes.slice(12),
    );
    return new TextDecoder().decode(plain);
  }
}

export function webhookSecretContext(shopId: string, subscriptionId: string): string {
  return `airstock:webhook-secret:v1:${shopId}:${subscriptionId}`;
}
