// HMAC checks for Shopify requests and AES-GCM encryption for stored tokens. Web Crypto only,
// so the same code runs in Workers and in Node tests.

const encoder = new TextEncoder();

type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** A copy backed by a plain ArrayBuffer, as Web Crypto's types require. */
function buffer(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data);
}

async function hmacSha256(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer(data)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]*$/i.test(value) || value.length % 2 !== 0) return null;
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Webhook check: X-Shopify-Hmac-Sha256 is the Base64 HMAC-SHA256 of the raw body. */
export async function verifyWebhookHmac(
  rawBody: Uint8Array,
  header: string | null | undefined,
  secret: string,
): Promise<boolean> {
  const presented = header ? fromBase64(header.trim()) : null;
  const expected = await hmacSha256(secret, rawBody);
  return presented !== null && constantTimeEqual(presented, expected);
}

/**
 * OAuth redirect check: `hmac` is the hex HMAC-SHA256 of the other query parameters, sorted by
 * name and joined as name=value pairs with `&`. Shopify's own libraries encode the pairs as a
 * form query string; the raw join is accepted too, since both come from Shopify's signature.
 */
export async function verifyQueryHmac(params: URLSearchParams, secret: string): Promise<boolean> {
  const presented = fromHex(params.get('hmac') ?? '');
  if (presented?.length !== 32) return false;
  const entries = [...params.entries()]
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const encoded = new URLSearchParams(entries).toString();
  const raw = entries.map(([k, v]) => `${k}=${v}`).join('&');
  const [a, b] = await Promise.all([
    hmacSha256(secret, encoder.encode(encoded)),
    hmacSha256(secret, encoder.encode(raw)),
  ]);
  return constantTimeEqual(presented, a) || constantTimeEqual(presented, b);
}

export async function signQuery(params: URLSearchParams, secret: string): Promise<string> {
  const entries = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const mac = await hmacSha256(secret, encoder.encode(new URLSearchParams(entries).toString()));
  return Array.from(mac, (x) => x.toString(16).padStart(2, '0')).join('');
}

export async function signWebhook(body: Uint8Array, secret: string): Promise<string> {
  return toBase64(await hmacSha256(secret, body));
}

/**
 * Encrypts stored Shopify tokens with AES-256-GCM. The associated data names the shop, store,
 * and token kind, so a ciphertext cannot be moved to another row and still decrypt.
 */
export class TokenCipher {
  private constructor(
    readonly keyId: string,
    private readonly key: AesKey,
  ) {}

  /** `keyBase64` is 32 random bytes, Base64 encoded (a Worker secret). */
  static async fromBase64(keyId: string, keyBase64: string): Promise<TokenCipher> {
    const raw = fromBase64(keyBase64.trim());
    if (raw?.length !== 32) throw new Error('The token key must be 32 bytes, Base64.');
    const key = await crypto.subtle.importKey('raw', buffer(raw), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
    return new TokenCipher(keyId, key);
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
    if (!bytes || bytes.length < 29) throw new Error('Malformed token ciphertext.');
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(context) },
      this.key,
      bytes.slice(12),
    );
    return new TextDecoder().decode(plain);
  }
}

export function tokenContext(shopId: string, shopDomain: string, kind: 'access' | 'refresh') {
  return `airstock:shopify-token:v1:${shopId}:${shopDomain}:${kind}`;
}
