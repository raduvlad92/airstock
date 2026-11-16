# 0009. Transactional email: Resend for now

**Status:** Accepted for Phase 0 and the pilot, 14 November 2026. Implements plan M7 (E9). The owner chose Resend ("for now") instead of the plan's five-provider evaluation.

**Summary:** Resend for invitations, links without secrets, idempotent sends; account data in the US until revisited

## Decision

- **Provider:** Resend, over its HTTP API from the Worker (`apps/worker/src/email.ts`). Every send carries an `Idempotency-Key` (`invitation/{id}` for invitations), so a retried job delivers once.
- **What sends:** member invitations. Inviting writes the invitation and an `email.member_invitation` outbox event in one transaction; the jobs consumer sends it, records the provider's message ID and the sent time, and writes `member.invitation.email_sent` to the activity history.
- **No secrets in email.** The invitation link names the invitation only. Accepting requires signing in with the invited address, which Google, Microsoft, or a Magic Auth code has verified, so an intercepted or forwarded email cannot be used by someone else.
- **Sending domain:** a dedicated subdomain per environment, sending region `eu-west-1` (Ireland). The owner asked for a new subdomain, `mail.airstock.deletecookies.dev`. The Resend team is at its free plan's 3-domain limit, so until the owner upgrades or frees a slot, staging sends from the already verified `mail.tracker.deletecookies.dev` (`EMAIL_FROM`); switching is a DNS change and one setting.
- **Configuration:** `RESEND_API_KEY` (Worker secret, sending access to one domain only) and `EMAIL_FROM` (Worker variable). Without them the consumer retries the message later rather than dropping it.

## Against the plan's criteria (M7)

| Criterion | Resend | Notes |
| --- | --- | --- |
| EU processing and a DPA | Partly | Sends from Ireland with `eu-west-1`, but account data, email metadata, and logs are stored in the US for every region. A GDPR Article 28 DPA with the EU SCCs is pre-signed for every account; transfers also rely on the EU-U.S. Data Privacy Framework. This does not meet C20 (EU) as written. |
| Price at pilot volume | Fits | Free: 3,000 emails a month, 100 a day, 3 domains. |
| Price at 1,000 shops | Fits | Pro: $20 a month for 50,000 emails and 10 domains, then $0.90 per 1,000. At 20 emails per shop per month that is 20,000 emails, about $0.02 per shop, against the $0.49 budget (PRD 14.4). |
| HTTP API from Workers | Yes | Plain `fetch`, idempotency keys, tags. |
| Deliverability tooling | Yes | DKIM, SPF, and DMARC guidance per domain; bounce and complaint webhooks; automatic suppression of hard bounces and complaints. Webhooks are not wired yet (Phase 2, with alert and report emails). |

## Update, 16 November 2026 (Phase 2, milestone I3)

- **What sends:** also purchase orders to suppliers, with the PDF attached and the sending member as reply-to ([ADR 0027](0027-purchase-orders.md)), and alert emails to subscribed members.
- **Staging recipients.** `EMAIL_RECIPIENTS=members` (a Worker variable, set on staging) limits email to addresses of the shop's own members, so suppliers with made-up addresses in test shops never receive anything; such a send is logged as `suppressed`. Unset or `any` sends to any address, as production will.

## Revisit when

- Before production: a customer or the owner requires EU-stored email data (C20). Candidates that store in the EU: Scaleway Transactional Email, Brevo, Mailjet, or Amazon SES in `eu-central-1`. Cloudflare Email Service fits the stack but needs the same data-location check.
- Email volume or domain count passes the free plan, or bounce and complaint handling becomes necessary (Phase 2).

## Sources

- [Resend pricing](https://resend.com/pricing) and [three domains on the free tier](https://resend.com/changelog/three-domains-on-the-free-tier)
- [Choosing a region](https://resend.com/docs/dashboard/domains/regions) and [GDPR at Resend](https://resend.com/security/gdpr)
