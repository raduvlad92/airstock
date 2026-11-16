# 0007. MCP authorization and shop binding with WorkOS standalone Connect

**Status:** Accepted, 14 November 2026. Resolves plan Section 7.2 and finding P9 (option A).

**Summary:** MCP shop binding through WorkOS standalone Connect: Airstock consent creates the grant, the first token binds its client

## Context

An MCP connection must act in exactly one shop, with the access its user chose, and stop on the next call after revocation (PRD 9.4). WorkOS authenticates users but does not know about shops. Plan Section 7.2 proposed two options: a platform consent step (A) or one WorkOS organization per shop (B).

WorkOS AuthKit acts as the OAuth authorization server for MCP clients. It supports Dynamic Client Registration and Client ID Metadata Documents, issues RS256 JWTs whose `aud` is the requested resource, and offers **standalone Connect**: AuthKit sends the user to an application's external sign-in URI with an `external_auth_id`. The application authenticates the user and calls `POST /authkit/oauth2/complete`, optionally with `user_consent_options`. The value the user confirms is written into a claim of the issued tokens.

## Decision

- **Option A, built on standalone Connect.** The external sign-in URI is `/connect/login`. Airstock signs the user in, shows its own consent page with the user's shops and the access to grant, and creates a `connection_grants` row through the `connections.create` operation (audited like any command). It then completes the authorization with one consent option. That option's claim is `urn:airstock:grant` and its single choice is the new grant ID. WorkOS shows its consent screen and issues tokens carrying the claim.
- **Binding on first use.** At the consent step neither the OAuth client ID nor the token subject is known yet. The first MCP request whose verified token carries the grant binds both (`bind_connection_grant`, first writer wins). Every later request must present the same client and subject, or it gets 401. Only Airstock decides which grant ID WorkOS puts in a token, and only for the signed-in user who approved it, so binding on first use cannot attach a grant to anyone else.
- **Unbound grants expire after 10 minutes** (report P15, added 14 November 2026). If the person abandons WorkOS's consent screen, no client receives a code and the grant would stay active and unbound. A grant that no token has bound within 10 minutes of consent can no longer be bound or used, the dashboard lists it as expired, and the 30-minute sweep records it as `expired` with a `connection.expired` audit event. ChatGPT bound its grants 31 and 38 seconds after consent on staging; the slowest binding seen was 251 seconds, by a scripted client.
- **Access lives in the grant, not in OAuth scopes.** WorkOS issues only `openid`, `profile`, `email`, and `offline_access`, so the protected-resource metadata advertises those. What the connection may do is the set of connection scopes stored in the grant, intersected with the member's permissions, and read on every request. Read scopes are ticked by default; write scopes must be ticked explicitly (PRD 9.5).
- **Sign-in without hosted AuthKit.** Setting an external sign-in URI redirects every hosted AuthKit sign-in page in the environment to Airstock. Airstock's sign-in page therefore calls the WorkOS API directly: provider sign-in (`provider=GoogleOAuth` or `MicrosoftOAuth`, which go straight to the provider) and Magic Auth (a code by email). Email and password is off, so no passwords are stored. When WorkOS will not take a provider's word for the email address, it answers `email_verification_required` and emails a code; Airstock's sign-in asks for that code and finishes with the email-verification grant (seen on staging with a Microsoft account on a Gmail address).
- **Sessions.** An AES-256-GCM sealed, host-only `__Host-airstock_session` cookie (`Secure`, `HttpOnly`, `SameSite=Lax`, seven days). Sign-in state uses a separate sealed 15-minute cookie. Other apps on `deletecookies.dev` use Clerk cookies on the parent domain; Airstock neither reads nor sets them.
- **Request forgery.** Every form POST must carry this site's `Origin`. The consent form also carries a MAC bound to the user and the `external_auth_id`. The dashboard calls `/api/v1` with the session cookie and an `x-airstock-request` header, which another site cannot add without a CORS preflight that Airstock never approves.
- Tokens with `sub_profile` `ai_agent` are rejected: a connection always acts for the person who approved it.

## Pass criteria (plan Section 7.2)

`apps/worker/test/web.test.ts` runs the whole flow against a fake WorkOS with locally signed tokens:

1. A refreshed token with the same claims keeps working on the same shop.
2. A token for shop A cannot reach shop B, whatever the tool arguments say. Another client or another subject cannot use the grant.
3. Revoking the connection in the dashboard returns 401 on the next call.
4. Creating or switching shops leaves an existing connection's shop unchanged.
5. The stored scopes are exactly the ones ticked at consent.

The ChatGPT run on staging on 14 November 2026 confirmed the same with real WorkOS tokens (plan Section 7.3, E6; [status Section 5](../phase-0-status.md#5-chatgpt-run-on-staging-plan-73-e6)). ChatGPT registers with a Client ID Metadata Document, so the bound client ID is `https://chatgpt.com/oauth/client.json`. The subject is the member's WorkOS user ID, and the grant claim survives refresh.

## Consequences

- WorkOS does not appear in shop data: deleting a WorkOS user does not delete grants, and revocation is Airstock's alone.
- Ending an Airstock session does not revoke existing connections; only revoking the grant does. The dashboard lists connections with a revoke button.
- WorkOS access tokens last five minutes by default. Refresh tokens rotate for public clients and have no fixed maximum lifetime, which is why the per-request grant check matters.

## Revisit when

WorkOS stops carrying consent-option claims through token refresh, an MCP client needs OAuth scopes that mirror connection scopes, or enterprise customers need organization-level SSO (option B could then sit alongside A).
