import {
  AppError,
  acceptInvitation,
  auditEvent,
  ensureUser,
  errors,
  execute,
  MCP_CONNECTION_SCOPES,
  type McpConnectionScope,
  ops,
  sessionCaller,
  viewInvitation,
} from '@airstock/core';
import type { Context, Hono } from 'hono';
import { type AppDeps, type AppEnv, problem } from './app.ts';
import {
  APP_ASSETS,
  appShellPage,
  connectPage,
  emailVerificationPage,
  invitationPage,
  landingPage,
  magicCodePage,
  messagePage,
  type ScopeChoice,
  signInPage,
} from './html.ts';
import {
  clearCookie,
  constantTimeEqual,
  cookie,
  FLOW_COOKIE,
  FLOW_TTL_SECONDS,
  type FlowState,
  mac,
  nowSeconds,
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  type Session,
  seal,
  unseal,
} from './session.ts';
import { type OAuthProvider, type WorkosClient, WorkosError, type WorkosUser } from './workos.ts';

export interface WebConfig {
  /** Public origin, such as https://airstock.deletecookies.dev. */
  publicUrl: string;
  sessionSecret: string;
  workos: WorkosClient;
  /** AuthKit origin: the connect form redirects there after consent. */
  authkitOrigin: string;
  /** Access-token claim that carries the connection grant ID. */
  grantClaim: string;
}

const PROVIDERS: Record<string, OAuthProvider> = {
  google: 'GoogleOAuth',
  microsoft: 'MicrosoftOAuth',
};

const SCOPE_LABELS: Record<McpConnectionScope, string> = {
  'shop:read': 'See the shop and your role',
  'catalog:read': 'Read items and variants',
  'catalog:write': 'Create and change items',
  'storage:read': 'Read warehouses and locations',
  'storage:write': 'Create warehouses and locations',
  'inventory:read': 'Read stock and availability',
  'inventory:write': 'Receive and reserve stock',
  'activity:read': 'Read the activity history',
};

const EXTERNAL_AUTH_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Only local paths, so a crafted link cannot send a signed-in user to another site. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) return '/app';
  if (!/^\/(?![/\\])[A-Za-z0-9\-._~/?=&%]*$/.test(value)) return '/app';
  return value;
}

function requestMeta(c: Context<AppEnv>) {
  return {
    ipAddress: c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
}

export async function readSession(c: Context<AppEnv>, config: WebConfig): Promise<Session | null> {
  return unseal<Session>(
    config.sessionSecret,
    'session',
    readCookie(c.req.header('cookie'), SESSION_COOKIE),
  );
}

/**
 * Browsers send Origin with every POST. Form posts and API calls that change state must come
 * from Airstock's own pages (plan M4).
 */
export function sameOrigin(c: Context<AppEnv>, config: WebConfig): boolean {
  const origin = c.req.header('origin');
  if (origin !== undefined) return origin === new URL(config.publicUrl).origin;
  const site = c.req.header('sec-fetch-site');
  return site === undefined || site === 'same-origin' || site === 'none';
}

function redirect(location: string, cookies: string[] = [], status = 303): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status, headers });
}

/**
 * Sign-ins and sign-outs are platform events (no shop) in the activity history (PRD 7.3).
 * Failed sign-ins are not: unauthenticated traffic never reaches the audit queue (plan P3), and
 * WorkOS keeps its own record of them.
 */
async function recordSessionEvent(
  c: Context<AppEnv>,
  userId: string,
  action: 'user.signed_in' | 'user.signed_out',
  method?: string,
): Promise<void> {
  await c.get('audit').send([
    auditEvent(
      {
        shopId: null,
        caller: sessionCaller(userId),
        requestId: c.get('requestId'),
        attemptId: null,
        idempotencyKey: null,
      },
      {
        action,
        phase: 'outcome',
        outcome: 'succeeded',
        target_type: 'user',
        target_id: userId,
        context: {
          ...(method ? { method } : {}),
          ipAddress: c.req.header('cf-connecting-ip') ?? null,
          userAgent: c.req.header('user-agent')?.slice(0, 200) ?? null,
        },
      },
    ),
  ]);
}

async function startSession(
  c: Context<AppEnv>,
  config: WebConfig,
  user: WorkosUser,
  returnTo: string,
  method: string,
): Promise<Response> {
  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || null;
  const uid = await ensureUser(c.get('db'), {
    providerUserId: user.id,
    email: user.email,
    displayName,
  });
  const session: Session = {
    uid,
    wid: user.id,
    email: user.email,
    exp: nowSeconds() + SESSION_TTL_SECONDS,
  };
  const value = await seal(config.sessionSecret, 'session', session);
  await recordSessionEvent(c, uid, 'user.signed_in', method);
  return redirect(safeReturnTo(returnTo), [
    cookie(SESSION_COOKIE, value, SESSION_TTL_SECONDS),
    clearCookie(FLOW_COOKIE),
  ]);
}

async function readFlow(c: Context<AppEnv>, config: WebConfig): Promise<FlowState | null> {
  return unseal<FlowState>(
    config.sessionSecret,
    'flow',
    readCookie(c.req.header('cookie'), FLOW_COOKIE),
  );
}

async function flowCookie(config: WebConfig, flow: Omit<FlowState, 'exp'>): Promise<string> {
  const value = await seal(config.sessionSecret, 'flow', {
    ...flow,
    exp: nowSeconds() + FLOW_TTL_SECONDS,
  });
  return cookie(FLOW_COOKIE, value, FLOW_TTL_SECONDS);
}

function connectCsrf(config: WebConfig, session: Session, externalAuthId: string) {
  return mac(config.sessionSecret, 'connect-form', `${session.uid}:${externalAuthId}`);
}

function formString(form: Record<string, unknown>, key: string): string {
  const value = form[key];
  return typeof value === 'string' ? value : '';
}

function formList(form: Record<string, unknown>, key: string): string[] {
  const value = form[key];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return typeof value === 'string' ? [value] : [];
}

export function mountWeb(app: Hono<AppEnv>, deps: AppDeps): void {
  if (!deps.web) return;
  const config: WebConfig = deps.web;
  const pipeline = (c: Context<AppEnv>) => ({
    db: c.get('db'),
    audit: c.get('audit'),
    logger: deps.logger,
  });

  app.get('/', async (c) => ((await readSession(c, config)) ? c.redirect('/app') : landingPage()));

  app.get('/auth/login', (c) => signInPage(safeReturnTo(c.req.query('return_to'))));

  app.get('/auth/oauth/:provider', async (c) => {
    const provider = PROVIDERS[c.req.param('provider')];
    if (!provider) return messagePage('Unknown sign-in method', 'Choose Google or Microsoft.');
    const state = crypto.randomUUID();
    return redirect(
      config.workos.authorizeUrl(provider, state),
      [
        await flowCookie(config, {
          state,
          provider: c.req.param('provider'),
          returnTo: safeReturnTo(c.req.query('return_to')),
        }),
      ],
      302,
    );
  });

  app.get('/auth/callback', async (c) => {
    const flow = await readFlow(c, config);
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!flow?.state || !state || !constantTimeEqual(flow.state, state)) {
      return messagePage(
        'Sign-in expired',
        'This sign-in link is no longer valid. Please start again.',
      );
    }
    if (!code) return signInPage(flow.returnTo, 'Sign-in was cancelled.');
    try {
      const user = await config.workos.authenticateWithCode(code, requestMeta(c));
      return await startSession(c, config, user, flow.returnTo, flow.provider ?? 'oauth');
    } catch (error) {
      if (error instanceof WorkosError) {
        if (error.pendingVerification) {
          const res = emailVerificationPage(error.pendingVerification.email);
          res.headers.append(
            'set-cookie',
            await flowCookie(config, {
              provider: flow.provider,
              returnTo: flow.returnTo,
              verify: error.pendingVerification,
            }),
          );
          return res;
        }
        deps.logger.error('sign_in_failed', {
          method: flow.provider ?? 'oauth',
          status: error.status,
          code: error.code,
        });
        return signInPage(flow.returnTo, 'That sign-in did not work. Please try again.');
      }
      throw error;
    }
  });

  app.post('/auth/verify-email', async (c) => {
    if (!sameOrigin(c, config)) return messagePage('Request blocked', 'Please try again.', 403);
    const flow = await readFlow(c, config);
    if (!flow?.verify) return signInPage('/app', 'Your code expired. Please sign in again.');
    const { email, token } = flow.verify;
    const code = formString(await c.req.parseBody(), 'code').trim();
    if (!/^\d{6}$/.test(code)) return emailVerificationPage(email, 'Enter the six-digit code.');
    try {
      const user = await config.workos.authenticateWithEmailVerification(
        token,
        code,
        requestMeta(c),
      );
      return await startSession(c, config, user, flow.returnTo, flow.provider ?? 'oauth');
    } catch (error) {
      if (error instanceof WorkosError) {
        deps.logger.info?.('email_verification_failed', {
          method: flow.provider ?? 'oauth',
          status: error.status,
          code: error.code,
        });
        return emailVerificationPage(email, 'That code did not work. Check it and try again.');
      }
      throw error;
    }
  });

  app.post('/auth/magic/send', async (c) => {
    if (!sameOrigin(c, config)) return messagePage('Request blocked', 'Please try again.', 403);
    const form = await c.req.parseBody();
    const email = formString(form, 'email').trim().toLowerCase();
    const returnTo = safeReturnTo(formString(form, 'return_to'));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
      return signInPage(returnTo, 'Enter a valid email address.');
    }
    try {
      await config.workos.sendMagicCode(email, requestMeta(c));
    } catch (error) {
      if (error instanceof WorkosError) {
        return signInPage(returnTo, 'We could not send a code to that address. Please try again.');
      }
      throw error;
    }
    const res = magicCodePage(email);
    res.headers.append('set-cookie', await flowCookie(config, { email, returnTo }));
    return res;
  });

  app.post('/auth/magic/verify', async (c) => {
    if (!sameOrigin(c, config)) return messagePage('Request blocked', 'Please try again.', 403);
    const flow = await readFlow(c, config);
    if (!flow?.email) return signInPage('/app', 'Your code expired. Please request a new one.');
    const code = formString(await c.req.parseBody(), 'code').trim();
    if (!/^\d{6}$/.test(code)) return magicCodePage(flow.email, 'Enter the six-digit code.');
    try {
      const user = await config.workos.authenticateWithMagicCode(flow.email, code, requestMeta(c));
      return await startSession(c, config, user, flow.returnTo, 'email_code');
    } catch (error) {
      if (error instanceof WorkosError) {
        return magicCodePage(flow.email, 'That code did not work. Check it and try again.');
      }
      throw error;
    }
  });

  app.post('/auth/logout', async (c) => {
    if (!sameOrigin(c, config)) return messagePage('Request blocked', 'Please try again.', 403);
    const session = await readSession(c, config);
    if (session) await recordSessionEvent(c, session.uid, 'user.signed_out');
    return redirect('/', [clearCookie(SESSION_COOKIE)]);
  });

  // The React dashboard (ADR 0010). Built files under /app/assets are served by the static asset
  // handler before the Worker runs; a missing one is a 404, never the shell. Every other path
  // under /app is a client-side route and gets the shell.
  const shell = async (c: Context<AppEnv>) => {
    const session = await readSession(c, config);
    if (!session) {
      const url = new URL(c.req.url);
      const back = safeReturnTo(`${url.pathname}${url.search}`);
      return redirect(`/auth/login?return_to=${encodeURIComponent(back)}`, [], 302);
    }
    return appShellPage({ email: session.email, mcpUrl: new URL('/mcp', config.publicUrl).href });
  };
  app.get(`${APP_ASSETS}/*`, (c) => problem(errors.notFound('File'), c.get('requestId')));
  app.get('/app', shell);
  app.get('/app/*', shell);

  // Member invitations (plan M4). The link carries no secret: the invitation is accepted only by
  // a user signed in with the invited, provider-verified email address.
  app.get('/invitations/:id', async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id))
      return messagePage('Invitation not found', 'Check the link in your email.', 404);
    const session = await readSession(c, config);
    if (!session) {
      return redirect(`/auth/login?return_to=${encodeURIComponent(`/invitations/${id}`)}`, [], 302);
    }
    const view = await viewInvitation(c.get('db'), id, {
      userId: session.uid,
      email: session.email,
    });
    if (!view) return messagePage('Invitation not found', 'Check the link in your email.', 404);
    if (!view.forThisUser) {
      return messagePage(
        'Different email address',
        `This invitation was sent to another address. You are signed in as ${session.email}; sign out and sign in with the invited address.`,
        403,
      );
    }
    if (view.state !== 'pending') {
      return messagePage(
        'Invitation closed',
        view.state === 'accepted'
          ? 'This invitation was already accepted. Open the dashboard to see the shop.'
          : 'This invitation is no longer open. Ask the shop for a new one.',
        409,
      );
    }
    return invitationPage({
      invitationId: id,
      shopName: view.shopName,
      role: view.role,
      email: session.email,
      csrf: await mac(config.sessionSecret, 'invitation', `${session.uid}:${id}`),
    });
  });

  app.post('/invitations/:id/accept', async (c) => {
    const id = c.req.param('id');
    const session = await readSession(c, config);
    if (!UUID.test(id) || !session || !sameOrigin(c, config)) {
      return messagePage('Request blocked', 'Open the invitation link again.', 403);
    }
    const expected = await mac(config.sessionSecret, 'invitation', `${session.uid}:${id}`);
    if (!constantTimeEqual(expected, formString(await c.req.parseBody(), 'csrf'))) {
      return messagePage('Request blocked', 'Open the invitation link again.', 403);
    }
    try {
      await acceptInvitation(c.get('db'), {
        invitationId: id,
        userId: session.uid,
        email: session.email,
        requestId: c.get('requestId'),
      });
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        return messagePage('Invitation not accepted', error.message, error.status);
      }
      throw error;
    }
    return redirect('/app?joined=1');
  });

  // Standalone Connect (plan Section 7.2, option A): AuthKit sends the MCP client's
  // authorization here. Airstock signs the user in, the user picks one shop and the access, and
  // Airstock creates the grant whose ID WorkOS then puts in every token for this connection.
  app.get('/connect/login', async (c) => {
    const externalAuthId = c.req.query('external_auth_id') ?? '';
    if (!EXTERNAL_AUTH_ID.test(externalAuthId)) {
      return messagePage(
        'Invalid connection request',
        'Start the connection again from your AI assistant.',
      );
    }
    const session = await readSession(c, config);
    const self = `/connect/login?external_auth_id=${encodeURIComponent(externalAuthId)}`;
    if (!session) {
      return redirect(`/auth/login?return_to=${encodeURIComponent(self)}`, [], 302);
    }
    return renderConnect(c, session, externalAuthId);
  });

  async function renderConnect(
    c: Context<AppEnv>,
    session: Session,
    externalAuthId: string,
    error?: string,
  ): Promise<Response> {
    const listed = await execute(pipeline(c), ops.listShops, {
      caller: sessionCaller(session.uid),
      shopId: null,
      input: {},
      requestId: c.get('requestId'),
    });
    const { shops } = listed.result as { shops: Array<{ id: string; name: string; role: string }> };
    const scopes: ScopeChoice[] = MCP_CONNECTION_SCOPES.map((scope) => ({
      scope,
      label: SCOPE_LABELS[scope],
      checked: scope.endsWith(':read'),
    }));
    return connectPage({
      email: session.email,
      externalAuthId,
      csrf: await connectCsrf(config, session, externalAuthId),
      shops,
      scopes,
      authkitOrigin: config.authkitOrigin,
      ...(error ? { error } : {}),
    });
  }

  async function connectForm(c: Context<AppEnv>) {
    if (!sameOrigin(c, config)) return null;
    const session = await readSession(c, config);
    if (!session) return null;
    const form = await c.req.parseBody({ all: true });
    const externalAuthId = formString(form, 'external_auth_id');
    if (!EXTERNAL_AUTH_ID.test(externalAuthId)) return null;
    const expected = await connectCsrf(config, session, externalAuthId);
    if (!constantTimeEqual(expected, formString(form, 'csrf'))) return null;
    return { session, form, externalAuthId };
  }

  app.post('/connect/shop', async (c) => {
    const ctx = await connectForm(c);
    if (!ctx) return messagePage('Request blocked', 'Start the connection again.', 403);
    try {
      await execute(pipeline(c), ops.createShop, {
        caller: sessionCaller(ctx.session.uid),
        shopId: null,
        input: {
          name: formString(ctx.form, 'name'),
          currency: formString(ctx.form, 'currency').trim().toUpperCase(),
          timezone: formString(ctx.form, 'timezone').trim(),
        },
        requestId: c.get('requestId'),
      });
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        return renderConnect(
          c,
          ctx.session,
          ctx.externalAuthId,
          'Check the shop name, currency, and time zone.',
        );
      }
      throw error;
    }
    return redirect(`/connect/login?external_auth_id=${encodeURIComponent(ctx.externalAuthId)}`);
  });

  app.post('/connect/approve', async (c) => {
    const ctx = await connectForm(c);
    if (!ctx) return messagePage('Request blocked', 'Start the connection again.', 403);
    const { session, form, externalAuthId } = ctx;
    const shopId = formString(form, 'shop_id');
    const scopes = formList(form, 'scope').filter((s): s is McpConnectionScope =>
      (MCP_CONNECTION_SCOPES as readonly string[]).includes(s),
    );
    if (!UUID.test(shopId) || scopes.length === 0) {
      return renderConnect(c, session, externalAuthId, 'Choose a shop and at least one access.');
    }
    const caller = sessionCaller(session.uid);
    let grantId: string;
    try {
      const created = await execute(pipeline(c), ops.createConnection, {
        caller,
        shopId,
        input: { scopes },
        // A double submit of the same consent returns the same grant.
        idempotencyKey: `connect:${externalAuthId}`,
        requestId: c.get('requestId'),
      });
      grantId = (created.result as { grantId: string }).grantId;
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        return renderConnect(c, session, externalAuthId, error.message);
      }
      throw error;
    }
    const listed = await execute(pipeline(c), ops.listShops, {
      caller,
      shopId: null,
      input: {},
      requestId: c.get('requestId'),
    });
    const shopName =
      (listed.result as { shops: Array<{ id: string; name: string }> }).shops.find(
        (s) => s.id === shopId,
      )?.name ?? 'your shop';
    const writes = scopes.filter((s) => s.endsWith(':write')).length;
    try {
      const { redirectUri } = await config.workos.completeConnect({
        externalAuthId,
        user: { id: session.wid, email: session.email, firstName: null, lastName: null },
        consent: [
          {
            claim: config.grantClaim,
            label: 'Airstock shop',
            choices: [
              {
                value: grantId,
                label: `${shopName} (${writes > 0 ? 'read and write' : 'read only'})`,
              },
            ],
          },
        ],
      });
      return redirect(redirectUri);
    } catch (error) {
      if (error instanceof WorkosError) {
        deps.logger.error('connect_complete_failed', { status: error.status, code: error.code });
        // No token can carry this grant now; revoke it so it does not linger as unused.
        await execute(pipeline(c), ops.revokeConnection, {
          caller,
          shopId,
          input: { grantId },
          requestId: c.get('requestId'),
        }).catch(() => {});
        return messagePage(
          'Connection expired',
          'This connection request is no longer valid. Start it again from your AI assistant.',
        );
      }
      throw error;
    }
  });
}
