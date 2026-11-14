import {
  AppError,
  buildMcpTools,
  type Caller,
  errors,
  execute,
  operations,
  resolveConnectionGrant,
  resolveToolCall,
} from '@airstock/core';
import type { Database } from '@airstock/db';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { type AppDeps, type AppEnv, problem } from './app.ts';

/**
 * OAuth settings for /mcp. Which claim carries the connection grant depends on the WorkOS
 * shop-binding spike (plan Section 7.2); it is configuration, not code.
 */
export interface McpAuthConfig {
  issuer: string;
  audience: string;
  /** Claim holding the platform connection grant ID. */
  grantClaim: string;
  /** Public URL of /mcp, the protected resource. */
  resource: string;
  authorizationServer: string;
  keys: JWTVerifyGetKey;
}

export function mcpConfigFromEnv(env: {
  MCP_ISSUER?: string;
  MCP_AUDIENCE?: string;
  MCP_JWKS_URL?: string;
  MCP_GRANT_CLAIM?: string;
  MCP_RESOURCE_URL?: string;
  MCP_AUTHORIZATION_SERVER?: string;
}): McpAuthConfig | null {
  if (!env.MCP_ISSUER || !env.MCP_AUDIENCE || !env.MCP_JWKS_URL || !env.MCP_RESOURCE_URL)
    return null;
  return {
    issuer: env.MCP_ISSUER,
    audience: env.MCP_AUDIENCE,
    grantClaim: env.MCP_GRANT_CLAIM ?? 'grant_id',
    resource: env.MCP_RESOURCE_URL,
    authorizationServer: env.MCP_AUTHORIZATION_SERVER ?? env.MCP_ISSUER,
    keys: createRemoteJWKSet(new URL(env.MCP_JWKS_URL)),
  };
}

const TOOLS = buildMcpTools(operations);
const SCOPES = [
  ...new Set(operations.map((o) => o.connectionScope).filter((s) => s !== 'session')),
];

/**
 * Verifies the bearer token (signature, issuer, audience, expiry) and then loads the
 * connection grant from the database on every request, so a revoked connection stops at
 * the next call even while its token is unexpired (PRD 9.4).
 */
async function authenticate(
  db: Database,
  config: McpAuthConfig,
  header: string | undefined,
): Promise<Caller | null> {
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const { payload } = await jwtVerify(header.slice(7).trim(), config.keys, {
      issuer: config.issuer,
      audience: config.audience,
    });
    const grantId = payload[config.grantClaim];
    const clientId = (payload.client_id ?? payload.azp) as unknown;
    if (
      typeof grantId !== 'string' ||
      typeof payload.sub !== 'string' ||
      typeof clientId !== 'string'
    )
      return null;
    if (!/^[0-9a-f-]{36}$/.test(grantId)) return null;
    return await resolveConnectionGrant(db, grantId, { providerUserId: payload.sub, clientId });
  } catch {
    return null;
  }
}

function buildServer(deps: AppDeps, db: Database, caller: Caller, requestId: string): McpServer {
  const server = new McpServer({ name: 'airstock', version: '0.1.0' });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.destructive,
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const call = resolveToolCall(tool, args);
          const res = await execute(
            { db, audit: deps.audit, logger: deps.logger },
            call.operation,
            {
              caller,
              shopId: caller.boundShopId,
              input: call.input,
              idempotencyKey:
                call.idempotencyKey ??
                (call.operation.idempotency === 'required' ? crypto.randomUUID() : null),
              requestId,
            },
          );
          const structured = {
            ...(res.result as object),
            ...(res.replayed ? { replayed: true } : {}),
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
            structuredContent: structured,
          };
        } catch (error) {
          const appError = error instanceof AppError ? error : errors.internal();
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: JSON.stringify(appError.toProblem(requestId)) },
            ],
          };
        }
      },
    );
  }
  return server;
}

export function mountMcp(app: Hono<AppEnv>, deps: AppDeps): void {
  app.get('/.well-known/oauth-protected-resource', (c) => {
    if (!deps.mcp) return problem(errors.notFound('Route'), c.get('requestId'));
    // Public metadata (RFC 9728): contains no shop data.
    return c.json({
      resource: deps.mcp.resource,
      authorization_servers: [deps.mcp.authorizationServer],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header'],
    });
  });

  app.all('/mcp', async (c) => {
    const config = deps.mcp;
    if (!config) {
      return problem(
        new AppError(
          503,
          'mcp_not_configured',
          'The MCP endpoint is not configured yet.',
          'failed',
        ),
        c.get('requestId'),
      );
    }
    const caller = await authenticate(c.get('db'), config, c.req.header('authorization'));
    if (!caller) {
      const metadata = new URL('/.well-known/oauth-protected-resource', config.resource).toString();
      return new Response(JSON.stringify(errors.unauthenticated().toProblem(c.get('requestId'))), {
        status: 401,
        headers: {
          'content-type': 'application/problem+json',
          'www-authenticate': `Bearer resource_metadata="${metadata}"`,
        },
      });
    }
    const handler = createMcpHandler(
      () => buildServer(deps, c.get('db'), caller, c.get('requestId')),
      {
        // Complete JSON responses: the request's database handle closes when the response returns.
        responseMode: 'json',
        onerror: (error) => deps.logger.error('mcp_error', { error: String(error) }),
      },
    );
    try {
      return await handler.fetch(c.req.raw);
    } finally {
      await handler.close();
    }
  });
}
