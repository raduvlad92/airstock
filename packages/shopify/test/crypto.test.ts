import { describe, expect, it } from 'vitest';
import {
  missingScopes,
  normalizeShopDomain,
  parseOrderWebhook,
  signQuery,
  signWebhook,
  TokenCipher,
  tokenContext,
  verifyQueryHmac,
  verifyWebhookHmac,
} from '../src/index.ts';

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe('Shopify request checks', () => {
  it('verifies the OAuth redirect signature and rejects any changed parameter', async () => {
    const params = new URLSearchParams({
      code: 'abc',
      host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvdGVzdA==',
      shop: 'test.myshopify.com',
      state: 's1',
      timestamp: '1700000000',
    });
    params.set('hmac', await signQuery(params, 'secret'));
    expect(await verifyQueryHmac(params, 'secret')).toBe(true);
    expect(await verifyQueryHmac(params, 'other')).toBe(false);
    params.set('shop', 'evil.myshopify.com');
    expect(await verifyQueryHmac(params, 'secret')).toBe(false);
    expect(await verifyQueryHmac(new URLSearchParams({ shop: 'x' }), 'secret')).toBe(false);
  });

  it('verifies a webhook against its exact raw bytes', async () => {
    const body = new TextEncoder().encode('{"id":1}');
    const header = await signWebhook(body, 'secret');
    expect(await verifyWebhookHmac(body, header, 'secret')).toBe(true);
    expect(await verifyWebhookHmac(new TextEncoder().encode('{"id": 1}'), header, 'secret')).toBe(
      false,
    );
    expect(await verifyWebhookHmac(body, undefined, 'secret')).toBe(false);
    expect(await verifyWebhookHmac(body, 'not base64!', 'secret')).toBe(false);
  });

  it('accepts only myshopify.com stores', () => {
    expect(normalizeShopDomain('My-Store')).toBe('my-store.myshopify.com');
    expect(normalizeShopDomain('https://my-store.myshopify.com/admin')).toBe(
      'my-store.myshopify.com',
    );
    expect(normalizeShopDomain('admin.shopify.com/store/my-store')).toBe('my-store.myshopify.com');
    expect(normalizeShopDomain('evil.com')).toBeNull();
    expect(normalizeShopDomain('a.myshopify.com.evil.com')).toBeNull();
  });

  it('treats a write scope as covering its read scope', () => {
    const rest = [
      'read_fulfillments',
      'read_merchant_managed_fulfillment_orders',
      'read_returns',
      'write_products',
    ];
    expect(
      missingScopes(['read_products', 'write_inventory', 'read_locations', 'read_orders', ...rest]),
    ).toEqual([]);
    expect(missingScopes(['read_products'])).toEqual([
      'read_inventory',
      'write_inventory',
      'read_locations',
      'read_orders',
      ...rest,
    ]);
  });

  it('reads only ids and quantities from an order webhook', () => {
    const order = parseOrderWebhook(
      JSON.stringify({
        id: 5001,
        admin_graphql_api_id: 'gid://shopify/Order/5001',
        created_at: '2026-11-14T10:00:00Z',
        email: 'buyer@example.com',
        line_items: [
          { id: 7001, variant_id: 9001, quantity: 2, title: 'Mug' },
          { id: 7002, variant_id: null, quantity: 1 },
        ],
      }),
    );
    expect(order).toEqual({
      orderId: '5001',
      createdAt: '2026-11-14T10:00:00Z',
      lines: [
        { lineId: '7001', variantId: '9001', quantity: 2 },
        { lineId: '7002', variantId: null, quantity: 1 },
      ],
    });
  });
});

describe('TokenCipher', () => {
  it('round-trips and binds the ciphertext to its shop, store, and kind', async () => {
    const cipher = await TokenCipher.fromBase64('k1', key);
    const context = tokenContext('shop-1', 'a.myshopify.com', 'access');
    const sealed = await cipher.encrypt('shpat_secret', context);
    expect(sealed).not.toContain('shpat');
    expect(await cipher.decrypt(sealed, context)).toBe('shpat_secret');
    await expect(
      cipher.decrypt(sealed, tokenContext('shop-2', 'a.myshopify.com', 'access')),
    ).rejects.toThrow();
    await expect(
      cipher.decrypt(sealed, tokenContext('shop-1', 'a.myshopify.com', 'refresh')),
    ).rejects.toThrow();
  });

  it('refuses a key that is not 32 bytes', async () => {
    await expect(TokenCipher.fromBase64('k1', btoa('short'))).rejects.toThrow();
  });
});
