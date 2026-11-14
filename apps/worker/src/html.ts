/** Server-rendered pages for sign-in, the connect consent step, and the dashboard shell. */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/** A fragment that is already safe HTML. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Tagged template: interpolated values are escaped unless they are SafeHtml (or arrays of it). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0]!;
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1]!;
  });
  return new SafeHtml(out);
}

function render(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

export interface PageOptions {
  /** Extra origins a form on this page may submit to or be redirected to. */
  formActions?: string[];
  scripts?: string[];
  status?: number;
}

export function contentSecurityPolicy(options: PageOptions = {}): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    `form-action 'self'${options.formActions?.length ? ` ${options.formActions.join(' ')}` : ''}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

export function page(title: string, body: SafeHtml, options: PageOptions = {}): Response {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title} · Airstock</title>
<link rel="stylesheet" href="/assets/app.css">
${(options.scripts ?? []).map((src) => html`<script src="${src}" defer></script>`)}
</head>
<body>
<header class="top"><a class="brand" href="/">Airstock</a><span class="env">staging</span></header>
<main>${body}</main>
</body>
</html>`;
  return new Response(doc.value, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': contentSecurityPolicy(options),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  });
}

export function messagePage(title: string, message: string, status = 400): Response {
  return page(
    title,
    html`<section class="card"><h1>${title}</h1><p>${message}</p><p><a href="/">Back to Airstock</a></p></section>`,
    { status },
  );
}

export function signInPage(returnTo: string, notice?: string): Response {
  const q = encodeURIComponent(returnTo);
  return page(
    'Sign in',
    html`<section class="card narrow">
  <h1>Sign in to Airstock</h1>
  ${notice ? html`<p class="notice">${notice}</p>` : ''}
  <a class="button provider" href="/auth/oauth/google?return_to=${q}">Continue with Google</a>
  <a class="button provider" href="/auth/oauth/microsoft?return_to=${q}">Continue with Microsoft</a>
  <div class="or"><span>or get a code by email</span></div>
  <form method="post" action="/auth/magic/send">
    <input type="hidden" name="return_to" value="${returnTo}">
    <label>Email <input type="email" name="email" autocomplete="email" required maxlength="320"></label>
    <button type="submit">Email me a sign-in code</button>
  </form>
  <p class="fine">No passwords: Airstock signs you in with Google, Microsoft, or a one-time code.</p>
</section>`,
  );
}

export function magicCodePage(email: string, error?: string): Response {
  return page(
    'Enter your code',
    html`<section class="card narrow">
  <h1>Check your email</h1>
  <p>We sent a six-digit code to <strong>${email}</strong>.</p>
  ${error ? html`<p class="error">${error}</p>` : ''}
  <form method="post" action="/auth/magic/verify">
    <label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
    <button type="submit">Sign in</button>
  </form>
  <p class="fine"><a href="/auth/login">Use another email or method</a></p>
</section>`,
    { status: error ? 400 : 200 },
  );
}

export interface ConsentShop {
  id: string;
  name: string;
  role: string;
}

export interface ScopeChoice {
  scope: string;
  label: string;
  checked: boolean;
}

export function connectPage(input: {
  email: string;
  externalAuthId: string;
  csrf: string;
  shops: ConsentShop[];
  scopes: ScopeChoice[];
  authkitOrigin: string;
  error?: string;
}): Response {
  const { shops } = input;
  const body =
    shops.length === 0
      ? html`<section class="card narrow">
  <h1>Create your first shop</h1>
  <p>An AI connection works inside one shop. You are signed in as ${input.email} and have no shop yet.</p>
  ${input.error ? html`<p class="error">${input.error}</p>` : ''}
  <form method="post" action="/connect/shop">
    <input type="hidden" name="external_auth_id" value="${input.externalAuthId}">
    <input type="hidden" name="csrf" value="${input.csrf}">
    <label>Shop name <input name="name" required maxlength="200"></label>
    <label>Currency <input name="currency" value="EUR" pattern="[A-Z]{3}" maxlength="3" required></label>
    <label>Time zone <input name="timezone" value="Europe/Bucharest" required maxlength="64"></label>
    <button type="submit">Create shop</button>
  </form>
</section>`
      : html`<section class="card narrow">
  <h1>Connect an AI assistant</h1>
  <p>Signed in as <strong>${input.email}</strong>. The assistant will work in the one shop you choose, with the access you tick, and never beyond your own permissions. You can revoke it at any time from the dashboard.</p>
  ${input.error ? html`<p class="error">${input.error}</p>` : ''}
  <form method="post" action="/connect/approve">
    <input type="hidden" name="external_auth_id" value="${input.externalAuthId}">
    <input type="hidden" name="csrf" value="${input.csrf}">
    <fieldset><legend>Shop</legend>
      ${shops.map(
        (s, i) =>
          html`<label class="choice"><input type="radio" name="shop_id" value="${s.id}" ${i === 0 ? new SafeHtml('checked') : ''} required> ${s.name} <span class="muted">${s.role}</span></label>`,
      )}
    </fieldset>
    <fieldset><legend>Access</legend>
      ${input.scopes.map(
        (s) =>
          html`<label class="choice"><input type="checkbox" name="scope" value="${s.scope}" ${s.checked ? new SafeHtml('checked') : ''}> ${s.label}</label>`,
      )}
      <p class="fine">Read access is ticked by default. Tick write access only if the assistant should change stock or the catalog.</p>
    </fieldset>
    <button type="submit">Connect</button>
  </form>
</section>`;
  return page('Connect', body, {
    formActions: [input.authkitOrigin],
    status: input.error ? 400 : 200,
  });
}

export function landingPage(): Response {
  return page(
    'Inventory you can trust',
    html`<section class="card narrow">
  <h1>Airstock</h1>
  <p>Stock across shops, warehouses, and partners, with every change recorded. This is the staging environment.</p>
  <a class="button" href="/auth/login">Sign in</a>
</section>`,
  );
}

export function dashboardPage(input: { email: string; mcpUrl: string }): Response {
  return page(
    'Dashboard',
    html`<section class="card">
  <div class="row"><h1>Dashboard</h1>
    <form method="post" action="/auth/logout"><button class="link" type="submit">Sign out ${input.email}</button></form>
  </div>
  <p class="fine">To use Airstock from ChatGPT, add a custom connector with the URL <code>${input.mcpUrl}</code>.</p>
  <div id="app" data-mcp-url="${input.mcpUrl}"><p class="muted">Loading…</p></div>
</section>`,
    { scripts: ['/assets/app.js'] },
  );
}
