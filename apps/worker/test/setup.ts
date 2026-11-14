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
import type { WebConfig } from '../src/web.ts';
import {
  type ConsentOption,
  type WorkosClient,
  WorkosError,
  type WorkosUser,
} from '../src/workos.ts';

// biome-ignore lint/suspicious/noExplicitAny: tests read many different JSON shapes
type Json = Record<string, any>;
export const json = (res: Response): Promise<Json> => res.json() as Promise<Json>;

export const ISSUER = 'https://auth.test.example';
export const AUDIENCE = 'https://api.test.example/mcp';
export const PUBLIC_URL = 'https://airstock.test';
export const GRANT_CLAIM = 'urn:airstock:grant';

/** Records what Airstock asked WorkOS for; codes map to users the test registered. */
export class FakeWorkos implements WorkosClient {
  readonly users = new Map<string, WorkosUser>();
  readonly sentCodes: string[] = [];
  readonly completed: Array<{
    externalAuthId: string;
    user: WorkosUser;
    consent: ConsentOption[];
  }> = [];
  failComplete = false;

  /** Registers a user who signs in with `code` (OAuth) or with `123456` (Magic Auth). */
  addUser(code: string, user: WorkosUser): void {
    this.users.set(code, user);
  }
  authorizeUrl(provider: string, state: string): string {
    return `https://workos.test/authorize?provider=${provider}&state=${state}`;
  }
  async authenticateWithCode(code: string): Promise<WorkosUser> {
    const user = this.users.get(code);
    if (!user) throw new WorkosError(400, 'invalid_grant');
    return user;
  }
  async sendMagicCode(email: string): Promise<void> {
    this.sentCodes.push(email);
  }
  async authenticateWithMagicCode(email: string, code: string): Promise<WorkosUser> {
    const user = [...this.users.values()].find((u) => u.email === email);
    if (!user || code !== '123456') throw new WorkosError(400, 'invalid_one_time_code');
    return user;
  }
  async completeConnect(input: {
    externalAuthId: string;
    user: WorkosUser;
    consent: ConsentOption[];
  }): Promise<{ redirectUri: string }> {
    if (this.failComplete) throw new WorkosError(400, 'invalid_external_auth_id');
    this.completed.push(input);
    return { redirectUri: `${ISSUER}/oauth2/consent?ext=${input.externalAuthId}` };
  }
}

export interface TestApp {
  app: ReturnType<typeof createApp>;
  db: Database;
  sink: MemoryAuditSink;
  workos: FakeWorkos;
  web: WebConfig;
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
    grantClaim: GRANT_CLAIM,
    resource: AUDIENCE,
    authorizationServer: ISSUER,
    keys,
  };
  const workos = new FakeWorkos();
  const web: WebConfig = {
    publicUrl: PUBLIC_URL,
    sessionSecret: 'test-session-secret-0123456789abcdef',
    workos,
    authkitOrigin: ISSUER,
    grantClaim: GRANT_CLAIM,
  };
  const app = createApp({
    // The shared pool outlives requests in tests; the Worker closes its per-request handle.
    database: () => ({ transaction: db.transaction.bind(db), close: async () => {} }),
    audit: sink,
    mcp,
    web,
    logger: { error: () => {} },
  });
  return {
    app,
    db,
    sink,
    workos,
    web,
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

/** Inserts an MCP connection grant already bound to its client and token subject. */
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
    `insert into connection_grants
       (shop_id, id, membership_id, client_id, client_name, scopes, token_subject, bound_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())`,
    [shop.shopId, grantId, member!.id, clientId, 'ChatGPT', scopes, user!.workos_user_id],
  );
  return { grantId, sub: user!.workos_user_id, clientId };
}
