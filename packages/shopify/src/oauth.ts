// Authorization-code install for a standalone (non-embedded) app (plan Section 8.2, step 1).

/** Pinned Admin API version. The inventory fields used by the push changed in 2026 releases. */
export const SHOPIFY_API_VERSION = '2026-10';

/**
 * What the connector uses (plan Section 5.14), checked against Shopify's 2026-10 reference:
 * orders, edits, cancellations, and refunds need `read_orders`; the fulfillments topics
 * `read_fulfillments`; where an order's lines are committed (fulfillment orders) for a
 * merchant's own locations `read_merchant_managed_fulfillment_orders`; returns and their
 * dispositions `read_returns`; listing Airstock's products in Shopify (D21) `write_products`,
 * requested now so a store approves the connector's scopes once.
 */
export const SHOPIFY_SCOPES = [
  'read_products',
  'read_inventory',
  'write_inventory',
  'read_locations',
  'read_orders',
  'read_fulfillments',
  'read_merchant_managed_fulfillment_orders',
  'read_returns',
  'write_products',
] as const;

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Accepts `name`, `name.myshopify.com`, or an admin URL; returns the store domain or null. */
export function normalizeShopDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  const admin = /admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/.exec(value);
  if (admin) value = `${admin[1]}.myshopify.com`;
  value = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!value.includes('.')) value = `${value}.myshopify.com`;
  return SHOP_DOMAIN.test(value) && value.length <= 100 ? value : null;
}

export function isShopDomain(value: string): boolean {
  return SHOP_DOMAIN.test(value);
}

export function authorizeUrl(input: {
  shopDomain: string;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  // No grant_options: an offline token, not tied to the staff member who approved.
  const url = new URL(`https://${input.shopDomain}/admin/oauth/authorize`);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('scope', SHOPIFY_SCOPES.join(','));
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  return url.href;
}

export interface TokenSet {
  accessToken: string;
  scopes: string[];
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

export class ShopifyAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ShopifyAuthError';
  }
}

/** Token endpoint calls; tests replace it. */
export interface ShopifyAuth {
  exchangeCode(shopDomain: string, code: string): Promise<TokenSet>;
  refresh(shopDomain: string, refreshToken: string): Promise<TokenSet>;
}

interface TokenResponse {
  access_token?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

function toTokenSet(body: TokenResponse, now: number): TokenSet {
  if (!body.access_token) throw new ShopifyAuthError(502, 'Shopify returned no access token.');
  return {
    accessToken: body.access_token,
    scopes: (body.scope ?? '').split(',').filter(Boolean),
    accessTokenExpiresAt: body.expires_in ? new Date(now + body.expires_in * 1000) : null,
    refreshToken: body.refresh_token ?? null,
    refreshTokenExpiresAt: body.refresh_token_expires_in
      ? new Date(now + body.refresh_token_expires_in * 1000)
      : null,
  };
}

export function httpShopifyAuth(config: {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}): ShopifyAuth {
  const doFetch = config.fetch ?? fetch;
  async function post(shopDomain: string, form: Record<string, string>): Promise<TokenSet> {
    if (!isShopDomain(shopDomain)) throw new ShopifyAuthError(400, 'Invalid shop domain.');
    const res = await doFetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...form,
      }),
    });
    if (!res.ok) throw new ShopifyAuthError(res.status, `Token request failed (${res.status}).`);
    return toTokenSet((await res.json()) as TokenResponse, Date.now());
  }
  return {
    // Expiring offline tokens: Shopify requires them for public apps (1 h access, 90 d refresh).
    exchangeCode: (shopDomain, code) => post(shopDomain, { code, expiring: '1' }),
    refresh: (shopDomain, refreshToken) =>
      post(shopDomain, { grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}
