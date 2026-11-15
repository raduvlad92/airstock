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
  /** Allows WebAssembly compilation (the barcode decoder on the scan test page). */
  wasm?: boolean;
}

export function contentSecurityPolicy(options: PageOptions = {}): string {
  return [
    "default-src 'none'",
    `script-src 'self'${options.wasm ? " 'wasm-unsafe-eval'" : ''}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
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
<meta name="referrer" content="same-origin">
<title>${title} · Airstock</title>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#1f5f4a">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/icon-180.png">
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
      // Not `no-referrer`: under it browsers send `Origin: null` even on same-origin form posts,
      // and every form here requires this site's Origin. `same-origin` still sends nothing to
      // other sites (WorkOS, Google, ChatGPT).
      'referrer-policy': 'same-origin',
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

/**
 * The dashboard shell (ADR 0010): the React app at /app, built by apps/web into the Worker's
 * static assets. The page carries no shop data, only who is signed in; everything else comes
 * from /api/v1. Same CSP as every other page: no inline scripts or styles.
 */
export function appShellPage(input: { email: string; mcpUrl: string }): Response {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>Airstock</title>
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#1f5f4a">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/icon-180.png">
<link rel="stylesheet" href="${APP_ASSETS}/app.css">
<script type="module" src="${APP_ASSETS}/app.js"></script>
</head>
<body>
<div id="root" data-email="${input.email}" data-mcp-url="${input.mcpUrl}"></div>
<noscript><p>Airstock needs JavaScript. <a href="/auth/login">Sign in again</a> after enabling it.</p></noscript>
</body>
</html>`;
  return new Response(doc.value, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': contentSecurityPolicy(),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'cache-control': 'no-store',
    },
  });
}

/** Where apps/web puts its build (vite.config.ts). */
export const APP_ASSETS = '/app/assets';

export function invitationPage(input: {
  invitationId: string;
  shopName: string;
  role: string;
  email: string;
  csrf: string;
}): Response {
  return page(
    'Invitation',
    html`<section class="card narrow">
  <h1>Join ${input.shopName}</h1>
  <p>You were invited to join <strong>${input.shopName}</strong> on Airstock as ${input.role.replaceAll('_', ' ')}. You are signed in as ${input.email}.</p>
  <form method="post" action="/invitations/${input.invitationId}/accept">
    <input type="hidden" name="csrf" value="${input.csrf}">
    <button type="submit">Accept invitation</button>
  </form>
</section>`,
  );
}

/** The camera decode spike (plan M7, E8). The script does the work; results go to /scan-test/results. */
export function scanTestPage(input: { email: string }): Response {
  return page(
    'Scan test',
    html`<section class="card">
  <div class="row"><h1>Scan test</h1><a href="/app">Dashboard</a></div>
  <p class="fine">Signed in as ${input.email}. Point the camera at a barcode from <a href="/assets/scan-targets/index.html" target="_blank" rel="noopener">the test targets</a>, shown on another screen or printed. Each attempt is saved for the Phase 0 report.</p>
  <div id="scan" data-wasm="/assets/vendor/zxing-wasm-3.1.6/">
    <div class="scan-controls">
      <label>Barcode
        <select name="target">
          <option value="ean-13">EAN-13 · 4006381333931</option>
          <option value="upc-a">UPC-A · 036000291452</option>
          <option value="code-128">Code 128 · AIRSTOCK-0042</option>
          <option value="qr">QR code</option>
        </select>
      </label>
      <label>Decoder
        <select name="decoder">
          <option value="both">Both, side by side</option>
          <option value="native">Built-in BarcodeDetector</option>
          <option value="zxing">zxing-wasm</option>
        </select>
      </label>
      <label>Distance
        <select name="distance">
          <option value="close">Close (about 10 cm)</option>
          <option value="arm" selected>Arm's length (about 30 cm)</option>
          <option value="far">Far (about 60 cm)</option>
        </select>
      </label>
      <label>Light
        <select name="light">
          <option value="good">Good light</option>
          <option value="dim">Dim light</option>
        </select>
      </label>
    </div>
    <button type="button" data-action="scan">Start a scan (10 s)</button>
    <video playsinline muted></video>
    <p class="fine" data-status>Camera off.</p>
    <label>Hardware scanner (keyboard wedge): focus here and scan
      <input name="wedge" autocomplete="off" inputmode="none">
    </label>
    <h2>This device</h2>
    <pre data-device></pre>
    <h2>Attempts</h2>
    <div class="table-wrap"><table><thead><tr><th>Barcode</th><th>Decoder</th><th>Conditions</th><th>Result</th><th>Time</th></tr></thead><tbody data-results></tbody></table></div>
  </div>
</section>`,
    { scripts: ['/assets/vendor/zxing-wasm-3.1.6/zxing-reader.js', '/assets/scan.js'], wasm: true },
  );
}
