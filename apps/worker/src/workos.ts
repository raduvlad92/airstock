/**
 * The few WorkOS calls Airstock makes. Sign-in uses the WorkOS API directly (provider sign-in
 * and Magic Auth), because the staging environment sends hosted AuthKit sign-in to Airstock's
 * standalone Connect page (docs/staging.md).
 */

export type OAuthProvider = 'GoogleOAuth' | 'MicrosoftOAuth';

export interface WorkosUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ConsentChoice {
  value: string;
  label: string;
}

export interface ConsentOption {
  /** Access-token claim that receives the chosen value. */
  claim: string;
  label: string;
  choices: ConsentChoice[];
}

export interface WorkosClient {
  authorizeUrl(provider: OAuthProvider, state: string): string;
  authenticateWithCode(code: string, meta: RequestMeta): Promise<WorkosUser>;
  /** WorkOS emails the code. The response also contains it; Airstock never reads or logs it. */
  sendMagicCode(email: string, meta: RequestMeta): Promise<void>;
  authenticateWithMagicCode(email: string, code: string, meta: RequestMeta): Promise<WorkosUser>;
  /**
   * Finishes a provider sign-in that WorkOS held back with `email_verification_required`: the
   * code WorkOS emailed proves the user owns the address, and WorkOS then links the sign-in.
   */
  authenticateWithEmailVerification(
    pendingToken: string,
    code: string,
    meta: RequestMeta,
  ): Promise<WorkosUser>;
  /** Standalone Connect: hands the authenticated user and the consent choice back to AuthKit. */
  completeConnect(input: {
    externalAuthId: string;
    user: WorkosUser;
    consent: ConsentOption[];
  }): Promise<{ redirectUri: string }>;
}

/**
 * WorkOS answers `email_verification_required` when it will not take the provider's word for the
 * email address (seen on staging: a Microsoft account on a Gmail address, whose WorkOS user
 * already signed in with Google). WorkOS emails the user a code; the sign-in finishes once the
 * user types it.
 */
export interface PendingEmailVerification {
  /** Short-lived WorkOS token that stands for the held-back sign-in. Never logged. */
  token: string;
  /** The address WorkOS sent the code to. */
  email: string;
}

export class WorkosError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    /** Set when `code` is `email_verification_required`. */
    readonly pendingVerification: PendingEmailVerification | null = null,
  ) {
    super(`WorkOS request failed with ${status}${code ? ` (${code})` : ''}.`);
    this.name = 'WorkosError';
  }
}

export interface WorkosConfig {
  apiKey: string;
  clientId: string;
  redirectUri: string;
  apiBase?: string;
  fetch?: typeof fetch;
}

interface UserPayload {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
}

function toUser(user: UserPayload): WorkosUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name ?? null,
    lastName: user.last_name ?? null,
  };
}

export function createWorkosClient(config: WorkosConfig): WorkosClient {
  const base = config.apiBase ?? 'https://api.workos.com';
  const doFetch = config.fetch ?? fetch;

  async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let code: string | null = null;
      let pending: PendingEmailVerification | null = null;
      try {
        const data = (await res.json()) as {
          code?: string;
          error?: string;
          pending_authentication_token?: unknown;
          email?: unknown;
        };
        code = data.code ?? data.error ?? null;
        if (
          code === 'email_verification_required' &&
          typeof data.pending_authentication_token === 'string' &&
          typeof data.email === 'string'
        ) {
          pending = { token: data.pending_authentication_token, email: data.email };
        }
      } catch {
        // The status alone is enough to report.
      }
      throw new WorkosError(res.status, code, pending);
    }
    return (await res.json()) as T;
  }

  const meta = (m: RequestMeta) => ({
    ...(m.ipAddress ? { ip_address: m.ipAddress } : {}),
    ...(m.userAgent ? { user_agent: m.userAgent.slice(0, 500) } : {}),
  });

  return {
    authorizeUrl(provider, state) {
      const url = new URL(`${base}/user_management/authorize`);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('provider', provider);
      url.searchParams.set('state', state);
      return url.toString();
    },

    async authenticateWithCode(code, m) {
      const data = await post<{ user: UserPayload }>('/user_management/authenticate', {
        client_id: config.clientId,
        client_secret: config.apiKey,
        grant_type: 'authorization_code',
        code,
        ...meta(m),
      });
      return toUser(data.user);
    },

    async sendMagicCode(email, m) {
      await post('/user_management/magic_auth', { email, ...meta(m) });
    },

    async authenticateWithMagicCode(email, code, m) {
      const data = await post<{ user: UserPayload }>('/user_management/authenticate', {
        client_id: config.clientId,
        client_secret: config.apiKey,
        grant_type: 'urn:workos:oauth:grant-type:magic-auth:code',
        email,
        code,
        ...meta(m),
      });
      return toUser(data.user);
    },

    async authenticateWithEmailVerification(pendingToken, code, m) {
      const data = await post<{ user: UserPayload }>('/user_management/authenticate', {
        client_id: config.clientId,
        client_secret: config.apiKey,
        grant_type: 'urn:workos:oauth:grant-type:email-verification:code',
        code,
        pending_authentication_token: pendingToken,
        ...meta(m),
      });
      return toUser(data.user);
    },

    async completeConnect({ externalAuthId, user, consent }) {
      const data = await post<{ redirect_uri: string }>('/authkit/oauth2/complete', {
        external_auth_id: externalAuthId,
        user: {
          id: user.id,
          email: user.email,
          ...(user.firstName ? { first_name: user.firstName } : {}),
          ...(user.lastName ? { last_name: user.lastName } : {}),
        },
        user_consent_options: consent.map((o) => ({
          claim: o.claim,
          type: 'enum',
          label: o.label,
          choices: o.choices,
        })),
      });
      return { redirectUri: data.redirect_uri };
    },
  };
}
