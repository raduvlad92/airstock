/**
 * Sealed cookies (AES-256-GCM) for the dashboard session and the short sign-in flow state.
 *
 * Airstock shares `deletecookies.dev` with apps that set their own cookies on the parent domain
 * (Clerk's `__session` and `__client_uat`, for example). Airstock only sets host-only `__Host-`
 * cookies, so nothing it sets leaves this host, and it reads only the names below.
 */

export const SESSION_COOKIE = '__Host-airstock_session';
export const FLOW_COOKIE = '__Host-airstock_flow';

/** Seven days, then the user signs in again. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Long enough to finish a provider sign-in or type an emailed code. */
export const FLOW_TTL_SECONDS = 15 * 60;

export interface Session {
  /** Platform user ID. */
  uid: string;
  /** WorkOS user ID. */
  wid: string;
  email: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

export interface FlowState {
  /** OAuth `state`, for provider sign-in. */
  state?: string;
  /** Which provider the sign-in started with (google, microsoft), for the activity history. */
  provider?: string;
  /** The email a Magic Auth code was sent to. */
  email?: string;
  /** A provider sign-in WorkOS holds until the user types the code it emailed. */
  verify?: { token: string; email: string };
  returnTo: string;
  exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keys = new Map<string, Promise<CryptoKey>>();

function deriveKey(secret: string, purpose: string, usage: 'aes' | 'hmac'): Promise<CryptoKey> {
  const id = `${usage}:${purpose}:${secret}`;
  let key = keys.get(id);
  if (!key) {
    key = crypto.subtle
      .importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
      .then((base) =>
        crypto.subtle.deriveKey(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: encoder.encode('airstock'),
            info: encoder.encode(purpose),
          },
          base,
          usage === 'aes'
            ? { name: 'AES-GCM', length: 256 }
            : { name: 'HMAC', hash: 'SHA-256', length: 256 },
          false,
          usage === 'aes' ? ['encrypt', 'decrypt'] : ['sign'],
        ),
      );
    keys.set(id, key);
  }
  return key;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Encrypts and authenticates `payload`; `purpose` keeps one cookie from passing as another. */
export async function seal(secret: string, purpose: string, payload: object): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret, purpose, 'aes');
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(JSON.stringify(payload)),
    ),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64Url(out);
}

/** Returns the payload, or null if the value was tampered with, sealed for another purpose, or expired. */
export async function unseal<T extends { exp: number }>(
  secret: string,
  purpose: string,
  value: string | undefined,
): Promise<T | null> {
  if (!value || value.length > 4096) return null;
  const bytes = fromBase64Url(value);
  if (!bytes || bytes.length < 13) return null;
  try {
    const key = await deriveKey(secret, purpose, 'aes');
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      key,
      bytes.slice(12),
    );
    const payload = JSON.parse(decoder.decode(plain)) as T;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** A keyed MAC, used for form tokens that bind a POST to the signed-in user and the flow. */
export async function mac(secret: string, purpose: string, message: string): Promise<string> {
  const key = await deriveKey(secret, purpose, 'hmac');
  return toBase64Url(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))),
  );
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Host-only, Secure, HttpOnly: required by the `__Host-` prefix and kept off other subdomains. */
export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
