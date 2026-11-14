import { type Caller, execute, ops, uuidv7 } from '@airstock/core';
import type { Database } from '@airstock/db';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from 'jose';
import {
  appDatabase,
  MemoryAuditSink,
  ownerQuery,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';
import { createApp } from '../src/app.ts';
import type { McpAuthConfig } from '../src/mcp.ts';

// biome-ignore lint/suspicious/noExplicitAny: tests read many different JSON shapes
type Json = Record<string, any>;
export const json = (res: Response): Promise<Json> => res.json() as Promise<Json>;

export const ISSUER = 'https://auth.test.example';
export const AUDIENCE = 'https://api.test.example/mcp';

export interface TestApp {
  app: ReturnType<typeof createApp>;
  db: Database;
  sink: MemoryAuditSink;
  sign(claims: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export async function testApp(): Promise<TestApp> {
  const db = appDatabase();
  const sink = new MemoryAuditSink();
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  const keys: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });
  const mcp: McpAuthConfig = {
    issuer: ISSUER,
    audience: AUDIENCE,
    grantClaim: 'grant_id',
    resource: AUDIENCE,
    authorizationServer: ISSUER,
    keys,
  };
  const app = createApp({
    // The shared pool outlives requests in tests; the Worker closes its per-request handle.
    database: () => ({ transaction: db.transaction.bind(db), close: async () => {} }),
    audit: sink,
    mcp,
    logger: { error: () => {} },
  });
  return {
    app,
    db,
    sink,
    sign: (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey),
    close: () => db.close(),
  };
}

export async function shopWithStock(t: TestApp, name: string) {
  const shop = await seedShop(t.db, t.sink, name);
  const created = await execute({ db: t.db, audit: t.sink }, ops.createItem, {
    caller: shop.caller,
    shopId: shop.shopId,
    input: { name: 'Lamp', sku: `LAMP-${uuidv7().slice(-6)}` },
    idempotencyKey: uuidv7(),
  });
  const variantId = (created.result as { variantId: string }).variantId;
  await execute({ db: t.db, audit: t.sink }, ops.receiveStock, {
    caller: shop.caller,
    shopId: shop.shopId,
    input: { variantId, locationId: shop.locationId, quantity: '10' },
    idempotencyKey: uuidv7(),
  });
  return { shop, variantId };
}

export async function apiToken(
  t: TestApp,
  shop: SeededShop,
  scopes: string[],
  caller: Caller = shop.caller,
): Promise<{ token: string; credentialId: string }> {
  const res = await execute({ db: t.db, audit: t.sink }, ops.createApiCredential, {
    caller,
    shopId: shop.shopId,
    input: { name: 'test', scopes },
  });
  return res.result as { token: string; credentialId: string };
}

/** Inserts an approved MCP connection grant, as the consent step will (plan Section 7.2). */
export async function connectionGrant(
  shop: SeededShop,
  scopes: string[],
  clientId = 'chatgpt-test',
) {
  const [user] = await ownerQuery<{ workos_user_id: string }>(
    'select workos_user_id from users where id = $1',
    [shop.userId],
  );
  const [member] = await ownerQuery<{ id: string }>(
    'select id from memberships where shop_id = $1 and user_id = $2',
    [shop.shopId, shop.userId],
  );
  const grantId = uuidv7();
  await ownerQuery(
    'insert into connection_grants (shop_id, id, membership_id, client_id, client_name, scopes) values ($1, $2, $3, $4, $5, $6)',
    [shop.shopId, grantId, member!.id, clientId, 'ChatGPT', scopes],
  );
  return { grantId, sub: user!.workos_user_id, clientId };
}
